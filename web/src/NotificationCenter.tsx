import { useCallback, useEffect, useState } from "react";
import { deleteNotification, deletePushSubscription, getNotifications, getPushConfig, markAllNotificationsRead, markNotificationRead, request, upsertPushSubscription } from "./api";
import { ReminderDialog } from "./ReminderDialog";
import type { Notification as PlannerNotification, Reminder } from "./types";

function subscriptionData(subscription:PushSubscription){const value=subscription.toJSON();if(!value.endpoint||!value.keys?.p256dh||!value.keys.auth)throw new Error("Браузер вернул неполную подписку");return {endpoint:value.endpoint,p256dh:value.keys.p256dh,auth:value.keys.auth};}

export async function detachPushSubscription(){
  if(!("serviceWorker" in navigator))return;
  const registration=await navigator.serviceWorker.getRegistration();
  const subscription=await registration?.pushManager?.getSubscription();
  if(subscription){await deletePushSubscription(subscriptionData(subscription));await subscription.unsubscribe();}
}

export function NotificationCenter({onError}:{onError:(message:string)=>void}){
  const [open,setOpen]=useState(false),[items,setItems]=useState<PlannerNotification[]>([]),[unread,setUnread]=useState(0),[total,setTotal]=useState(0);
  const [push,setPush]=useState(false),[busy,setBusy]=useState(false),[reminder,setReminder]=useState<Reminder>();
  const refresh=useCallback(async()=>{const [page,count]=await Promise.all([getNotifications(),getNotifications(true,1)]);setItems(page.items);setTotal(page.total);setUnread(count.total);},[]);
  const showReminder=useCallback(async(id:string)=>{try{setReminder(await request<Reminder>(`/reminders/${encodeURIComponent(id)}`));}catch(error){onError((error as Error).message);}},[onError]);
  useEffect(()=>{
    let mounted=true;
    const update=()=>{if(mounted)void refresh().catch(()=>{});};
    update();const timer=window.setInterval(update,15000);window.addEventListener("focus",update);
    const message=(event:MessageEvent)=>{update();if(event.data?.type==="open-reminder"&&typeof event.data.reminderId==="string")void showReminder(event.data.reminderId);};
    if("serviceWorker" in navigator){navigator.serviceWorker.addEventListener("message",message);void navigator.serviceWorker.register("/sw.js").then(registration=>registration.pushManager?.getSubscription()).then(subscription=>{if(mounted)setPush(Boolean(subscription));}).catch(()=>{});}
    const id=new URLSearchParams(location.search).get("reminder");if(id)void showReminder(id);
    return()=>{mounted=false;clearInterval(timer);window.removeEventListener("focus",update);navigator.serviceWorker?.removeEventListener("message",message);};
  },[refresh,showReminder]);
  async function action(work:()=>Promise<unknown>){try{await work();await refresh();}catch(error){onError((error as Error).message);}}
  async function togglePush(){setBusy(true);try{
    if(!("serviceWorker" in navigator)||!("PushManager" in window)||!("Notification" in window))throw new Error("Этот браузер не поддерживает push-уведомления");
    const registration=await navigator.serviceWorker.ready,existing=await registration.pushManager.getSubscription();
    if(push&&existing){await deletePushSubscription(subscriptionData(existing));await existing.unsubscribe();setPush(false);return;}
    const config=await getPushConfig();if(!config.enabled||!config.public_key)throw new Error("Push-уведомления пока не настроены на сервере");
    if(await window.Notification.requestPermission()!=="granted")throw new Error("Разрешите уведомления в настройках браузера");
    const key=config.public_key.replace(/-/g,"+").replace(/_/g,"/"),bytes=Uint8Array.from(atob(key+"=".repeat((4-key.length%4)%4)),char=>char.charCodeAt(0));
    const subscription=existing||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});
    try{await upsertPushSubscription(subscriptionData(subscription));}catch(error){if(!existing)await subscription.unsubscribe();throw error;}
    setPush(true);
  }catch(error){onError((error as Error).message);}finally{setBusy(false);}}
  async function more(){try{const page=await getNotifications(false,100,items.length);setItems(current=>[...current,...page.items]);setTotal(page.total);}catch(error){onError((error as Error).message);}}
  return <div className="notification-center"><button className="quiet" aria-label={`Уведомления${unread?`: ${unread} непрочитанных`:""}`} aria-expanded={open} onClick={()=>setOpen(value=>!value)}>Уведомления{unread?` (${unread})`:""}</button>{open&&<section className="notifications-panel" aria-label="Центр уведомлений"><div className="notifications-head"><h2>Уведомления</h2><button aria-label="Закрыть уведомления" onClick={()=>setOpen(false)}>×</button></div><div className="notifications-actions"><button disabled={busy} onClick={()=>void togglePush()}>{push?"Выключить push":"Включить push"}</button><button onClick={()=>void action(markAllNotificationsRead)}>Прочитать все</button></div>{items.map(item=><article key={item.id} className={`notification-item ${item.read_at?"read":"unread"}`}><button className="notification-content" onClick={()=>void action(async()=>{await markNotificationRead(item.id);await showReminder(item.reminder_id);})}><strong>{item.title}</strong>{item.body&&<span>{item.body}</span>}<time>{new Date(item.created_at).toLocaleString("ru-RU")}</time></button><button aria-label={`Удалить уведомление ${item.title}`} onClick={()=>void action(()=>deleteNotification(item.id))}>×</button></article>)}{!items.length&&<p>Уведомлений пока нет.</p>}{items.length<total&&<button onClick={()=>void more()}>Показать ещё</button>}</section>}{reminder&&<ReminderDialog reminder={reminder} onClose={()=>setReminder(undefined)} onChanged={async()=>{setReminder(undefined);await refresh();}} onError={onError}/>}</div>;
}
