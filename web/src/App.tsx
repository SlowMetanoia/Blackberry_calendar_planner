import { FormEvent, Fragment, PointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AUTH_EXPIRED_EVENT, clearStoredToken, getCalendarHistory, getConversationHistory, getConversations, getMessage, getStoredToken, logoutSession, request, storeToken, undoOperation } from "./api";
import { browserTimeZone, formatDateTime, formatDuration, formatHistoryDate, formatHistoryTime, formatMessageTimestamp, formatSchedule, formatSessionTimestamp, historyDateKey } from "./format";
import type { AgentMessage, CalendarOperation, ConversationSummary } from "./types";
import { PlannerSidebar } from "./PlannerSidebar";

const terminal = new Set(["needs_clarification", "completed", "failed"]);
const pending = new Set(["queued", "transcribing", "processing"]);
const delay = (ms:number) => new Promise(resolve => setTimeout(resolve, ms));

export default function App() {
  const [token,setToken]=useState(getStoredToken);
  const [register,setRegister]=useState(false),[email,setEmail]=useState(""),[password,setPassword]=useState("");
  const [text,setText]=useState(""),[messages,setMessages]=useState<AgentMessage[]>([]);
  const [sessions,setSessions]=useState<ConversationSummary[]>([]),[history,setHistory]=useState<CalendarOperation[]>([]);
  const [conversation,setConversation]=useState<string|null>(null),[error,setError]=useState("");
  const [recording,setRecording]=useState(false),[sidebarOpen,setSidebarOpen]=useState(false),[plannerOpen,setPlannerOpen]=useState(false),[sessionsOpen,setSessionsOpen]=useState(false),[calendarRevision,setCalendarRevision]=useState(0);
  const recorder=useRef<MediaRecorder|null>(null),chunks=useRef<Blob[]>([]),selectionVersion=useRef(0),chat=useRef<HTMLElement|null>(null);

  function clearAuthentication(message=""){clearStoredToken();selectionVersion.current++;setToken(null);setSessions([]);setHistory([]);setConversation(null);setMessages([]);setSessionsOpen(false);setSidebarOpen(false);setPlannerOpen(false);setError(message);}
  useEffect(()=>{const expired=()=>clearAuthentication("Сессия истекла или недействительна. Войдите снова.");window.addEventListener(AUTH_EXPIRED_EVENT,expired);return()=>window.removeEventListener(AUTH_EXPIRED_EVENT,expired);},[]);

  async function collectPages<T>(load:(offset:number)=>Promise<{items:T[];total:number}>){const all:T[]=[];let offset=0;for(;;){const page=await load(offset);all.push(...page.items);offset+=page.items.length;if(offset>=page.total||!page.items.length)return all;}}
  async function refreshSessions(){setSessions(await collectPages(offset=>getConversations(100,offset)));}
  async function refreshHistory(){setHistory(await collectPages(offset=>getCalendarHistory(100,offset)));}
  useEffect(()=>{if(!token)return;void Promise.all([refreshSessions(),refreshHistory()]).catch(e=>setError((e as Error).message));request<{timezone:string}>("/users/me/timezone",{method:"PUT",body:JSON.stringify({timezone:browserTimeZone()})}).catch(e=>setError((e as Error).message));},[token]);
  useEffect(()=>{if(messages.length)requestAnimationFrame(()=>chat.current?.scrollTo({top:chat.current.scrollHeight,behavior:"smooth"}));},[messages]);

  async function authenticate(event:FormEvent){event.preventDefault();setError("");try{const data=await request<{access_token:string}>(register?"/auth/register":"/auth/login",{method:"POST",body:JSON.stringify({email,password})});storeToken(data.access_token);setToken(data.access_token);}catch(e){setError((e as Error).message);}}
  function mergeMessage(message:AgentMessage){setMessages(old=>[...old.filter(item=>item.id!==message.id),message].sort((a,b)=>a.sequence-b.sequence));}
  async function pollMessage(id:string,version:number){for(;;){const message=await getMessage(id);if(version!==selectionVersion.current)return;mergeMessage(message);if(terminal.has(message.status)){await refreshHistory();setCalendarRevision(value=>value+1);return;}await delay(700);}}
  async function acceptMessage(message:AgentMessage,version:number){if(version!==selectionVersion.current)return;mergeMessage(message);setConversation(message.conversation_id);void refreshSessions();await pollMessage(message.id,version);if(version===selectionVersion.current)await refreshSessions();}
  async function sendText(event:FormEvent){event.preventDefault();if(!text.trim())return;const body={text:text.trim(),conversation_id:conversation},version=selectionVersion.current;setText("");try{await acceptMessage(await request<AgentMessage>("/agent/messages",{method:"POST",body:JSON.stringify(body)}),version);}catch(e){setError((e as Error).message);}}
  async function sendAudio(blob:Blob){if(!blob.size)return;const body=new FormData(),version=selectionVersion.current;body.append("audio",blob,"message.webm");try{await acceptMessage(await request<AgentMessage>(`/agent/messages/audio${conversation?`?conversation_id=${conversation}`:""}`,{method:"POST",body}),version);}catch(e){setError((e as Error).message);}}
  async function startRecording(event:PointerEvent){event.currentTarget.setPointerCapture(event.pointerId);setError("");try{const stream=await navigator.mediaDevices.getUserMedia({audio:true});chunks.current=[];const media=new MediaRecorder(stream);recorder.current=media;media.ondataavailable=e=>{if(e.data.size)chunks.current.push(e.data);};media.onstop=()=>{stream.getTracks().forEach(track=>track.stop());setRecording(false);void sendAudio(new Blob(chunks.current,{type:media.mimeType||"audio/webm"}));};media.start();setRecording(true);}catch{setError("Не удалось получить доступ к микрофону");}}
  function stopRecording(){if(recorder.current?.state==="recording")recorder.current.stop();}
  async function openConversation(id:string){const version=++selectionVersion.current;setConversation(id);setMessages([]);setSessionsOpen(false);setError("");try{const all:AgentMessage[]=[];let offset=0;for(;;){const page=await getConversationHistory(id,100,offset);all.push(...page.items);offset+=page.items.length;if(offset>=page.total||!page.items.length)break;}if(version===selectionVersion.current)setMessages(all);}catch(e){if(version===selectionVersion.current)setError((e as Error).message);}}
  function startNewConversation(){selectionVersion.current++;setConversation(null);setMessages([]);setSessionsOpen(false);setSidebarOpen(false);setPlannerOpen(false);setError("");}
  async function undo(id:string){try{await undoOperation(id);await refreshHistory();setCalendarRevision(value=>value+1);}catch(e){setError((e as Error).message);}}
  async function logout(){try{await logoutSession();}catch{}finally{clearAuthentication();}}

  if(!token)return <main className="auth-shell"><section className="auth-card"><div className="brand">День за днём</div><h1>{register?"Создать аккаунт":"Войти в ежедневник"}</h1><p>Задачи и встречи — просто скажите, что нужно.</p><form onSubmit={authenticate}><label>Email<input type="email" value={email} onChange={e=>setEmail(e.target.value)} required/></label><label>Пароль<input type="password" minLength={8} value={password} onChange={e=>setPassword(e.target.value)} required/></label><button className="primary">{register?"Зарегистрироваться":"Войти"}</button></form><button className="link" onClick={()=>setRegister(!register)}>{register?"Уже есть аккаунт":"Нет аккаунта? Создать"}</button>{error&&<div className="error">{error}</div>}</section></main>;

  return <main className="app-shell">
    <div className={`sidebar-scrim ${sidebarOpen?"visible":""}`} onClick={()=>setSidebarOpen(false)}/>
    <div className={`planner-scrim ${plannerOpen?"visible":""}`} onClick={()=>setPlannerOpen(false)}/>
    <aside className={`session-sidebar operation-sidebar ${sidebarOpen?"open":""}`}><div className="sidebar-head"><div><div className="eyebrow">Календарь</div><b>История изменений</b></div><button className="sidebar-close" aria-label="Закрыть историю" onClick={()=>setSidebarOpen(false)}>×</button></div><nav className="operation-list" aria-label="История изменений календаря">{history.map((item,index)=>{const showDate=index===0||historyDateKey(item.created_at)!==historyDateKey(history[index-1].created_at);return <Fragment key={item.id}>{showDate&&<div className="history-date"><span>{formatHistoryDate(item.created_at)}</span></div>}<HistoryItem item={item} undo={undo}/></Fragment>;})}{!history.length&&<p className="sessions-empty">Изменения календаря появятся здесь.</p>}</nav></aside>
    <section className="workspace"><header><button className="sessions-toggle" aria-label="Открыть историю изменений" onClick={()=>setSidebarOpen(true)}>☰</button><div><div className="eyebrow">Умный ежедневник</div><h1>Что запланируем?</h1></div><div className="header-actions"><button className="quiet planner-toggle" onClick={()=>setPlannerOpen(true)}>Планы</button><button className="quiet" onClick={startNewConversation}>Новый диалог</button><button className="quiet" onClick={()=>setSessionsOpen(true)}>История сессий</button><button className="quiet" onClick={()=>void logout()}>Выйти</button></div></header>
      <section className="chat" ref={chat} aria-live="polite">{!messages.length&&<div className="empty"><span>✦</span><h2>Начните с простой просьбы</h2><p>«Покажи задачи на сегодня» или «Напомни подготовить отчёт»</p></div>}{messages.map(message=><MessageExchange key={message.id} message={message} startNewConversation={startNewConversation}/>)}</section>
      {error&&<div className="toast">{error}<button onClick={()=>setError("")}>×</button></div>}
      <footer><form className="composer" onSubmit={sendText}><input aria-label="Сообщение" placeholder="Напишите задачу или вопрос…" value={text} onChange={e=>setText(e.target.value)}/><button className="send" aria-label="Отправить">↑</button><button type="button" className={`mic ${recording?"recording":""}`} aria-label="Удерживайте для записи" onPointerDown={startRecording} onPointerUp={stopRecording} onPointerCancel={stopRecording}>{recording?"■":"●"}</button></form><small>{recording?"Отпустите, чтобы отправить":"Удерживайте красную кнопку для записи"}</small></footer>
    </section>
    <PlannerSidebar open={plannerOpen} onClose={()=>setPlannerOpen(false)} revision={calendarRevision} onHistoryChanged={async()=>{await refreshHistory();setCalendarRevision(value=>value+1);}} onError={setError}/>
    {sessionsOpen&&<div className="modal-scrim" role="presentation" onMouseDown={()=>setSessionsOpen(false)}><section className="sessions-modal" role="dialog" aria-modal="true" aria-label="История сессий" onMouseDown={e=>e.stopPropagation()}><div className="sidebar-head"><div><div className="eyebrow">Диалоги</div><h2>История сессий</h2></div><button className="sidebar-close" aria-label="Закрыть историю сессий" onClick={()=>setSessionsOpen(false)}>×</button></div><nav className="session-list">{sessions.map(session=><button key={session.id} className={`session-item ${conversation===session.id?"active":""}`} onClick={()=>void openConversation(session.id)}><span>{session.preview}</span><time>{formatSessionTimestamp(session.last_activity_at)}</time></button>)}{!sessions.length&&<p className="sessions-empty">Здесь появятся прошлые диалоги.</p>}</nav></section></div>}
  </main>;
}

function MessageTime({value,className=""}:{value:string;className?:string}){const label=formatMessageTimestamp(value);return label?<time className={`message-time ${className}`} dateTime={value}>{label}</time>:null;}
export function MessageExchange({message,startNewConversation}:{message:AgentMessage;startNewConversation:()=>void}){const transcribing=!message.input_text&&pending.has(message.status);const showBot=Boolean(message.input_text||message.reply||message.reads.length||message.operations.length||message.error||message.requires_new_conversation);return <article className="exchange">{message.input_text&&<div className="bubble user"><div>{message.input_text}</div><MessageTime value={message.created_at}/></div>}{transcribing&&<div className="transcription-status"><span>●</span> Распознаю…</div>}{showBot&&<div className="bubble bot"><div className="bot-mark">✦</div><div className="bot-content">{message.reply?<p>{message.reply}</p>:message.input_text&&pending.has(message.status)?<p className="muted">Думаю…</p>:null}{message.reads.map(read=><ReadCard read={read} key={`${read.resource}-${read.id}`}/>)}{message.operations.map(item=><OperationReceipt item={item} key={item.id}/>)}{message.requires_new_conversation&&<button className="primary new-conversation" onClick={startNewConversation}>Начать новый диалог</button>}{message.error&&<p className="error">{message.error}</p>}<MessageTime value={message.created_at} className="bot-time"/></div></div>}</article>;}

const resourceHeadings:Record<string,string>={task:"Задача",event:"Событие"};
const operationWords:Record<string,string>={create:"Создано",update:"Изменено",delete:"Удалено"};
const undoWords:Record<string,string>={create:"создание",update:"изменение",delete:"удаление"};
const taskStatusLabels:Record<string,string>={open:"Открыта",completed:"Выполнена"};
function stringField(data:Record<string,unknown>,key:string){const value=data[key];return typeof value==="string"&&value.trim()?value:null;}
function numberField(data:Record<string,unknown>,key:string){const value=data[key];return typeof value==="number"&&Number.isFinite(value)?value:null;}
function resourceMetadata(resource:string,data:Record<string,unknown>,timeZone=browserTimeZone()){const items:Array<{label?:string;value:string}>=[],duration=numberField(data,resource==="event"?"duration_minutes":"estimated_minutes");if(resource==="event"){const start=stringField(data,"starts_at");if(start)items.push({value:formatSchedule(start,duration,timeZone)});if(duration)items.push({label:"Длительность",value:formatDuration(duration)});const location=stringField(data,"location");if(location)items.push({label:"Место",value:location});}else{const deadline=stringField(data,"deadline");if(deadline)items.push({label:"Срок",value:formatDateTime(deadline,timeZone)});if(duration)items.push({label:"Оценка",value:formatDuration(duration)});const status=stringField(data,"status");if(status)items.push({label:"Статус",value:taskStatusLabels[status]||status});}const description=stringField(data,"description");if(description)items.push({label:"Описание",value:description});return items;}
function Metadata({items}:{items:Array<{label?:string;value:string}>}){return items.length?<dl className="resource-metadata">{items.map((item,index)=><div key={index}>{item.label&&<dt>{item.label}:</dt>}<dd>{item.value}</dd></div>)}</dl>:null;}
export function ReadCard({read,timeZone=browserTimeZone()}:{read:{resource:string;id:string;data:Record<string,unknown>};timeZone?:string}){return <article className="read-card"><span className="read-kind">{resourceHeadings[read.resource]||read.resource}</span><strong>{stringField(read.data,"title")||read.id}</strong><Metadata items={resourceMetadata(read.resource,read.data,timeZone)}/></article>;}
function OperationReceipt({item}:{item:CalendarOperation}){const data=item.after||item.before||{};return <article className="read-card operation-receipt"><span className="read-kind">{operationWords[item.operation]} · {resourceHeadings[item.resource]}</span><strong>{stringField(data,"title")||item.target_id}</strong><Metadata items={resourceMetadata(item.resource,data)}/>{item.operation==="update"&&<Changes changes={item.changes}/>}</article>;}
function Changes({changes}:{changes:CalendarOperation["changes"]}){return <dl className="operation-changes">{Object.entries(changes).filter(([key])=>key!=="id").map(([key,value])=><div key={key}><dt>{key}</dt><dd>{String(value.before??"—")} → {String(value.after??"—")}</dd></div>)}</dl>;}
function operationSchedule(resource:CalendarOperation["resource"],data:Record<string,unknown>){const value=stringField(data,resource==="event"?"starts_at":"deadline");if(!value)return "";return `${resource==="event"?"запланировано на":"запланировано к"} ${formatDateTime(value)}`;}
type PreviewAnchor={x:number;y:number};

export function HistoryItem({item,undo}:{item:CalendarOperation;undo:(id:string)=>void}){
  const data=item.after||item.before||{},title=stringField(data,"title")||item.target_id,scheduled=operationSchedule(item.resource,data);
  const [anchor,setAnchor]=useState<PreviewAnchor|null>(null),[position,setPosition]=useState<PreviewAnchor|null>(null);
  const itemRef=useRef<HTMLElement|null>(null),previewRef=useRef<HTMLDivElement|null>(null),lastPointerType=useRef("");
  const previewId=`history-preview-${item.id}`;
  const anchorToItem=()=>{const rect=itemRef.current?.getBoundingClientRect();if(rect)setAnchor({x:rect.right,y:rect.top});};

  useLayoutEffect(()=>{
    if(!anchor||!previewRef.current)return;
    const margin=8,offset=12,rect=previewRef.current.getBoundingClientRect();
    let x=anchor.x+offset,y=anchor.y+offset;
    if(x+rect.width>window.innerWidth-margin)x=anchor.x-rect.width-offset;
    if(y+rect.height>window.innerHeight-margin)y=anchor.y-rect.height-offset;
    setPosition({x:Math.max(margin,Math.min(x,window.innerWidth-rect.width-margin)),y:Math.max(margin,Math.min(y,window.innerHeight-rect.height-margin))});
  },[anchor]);

  useEffect(()=>{
    if(!anchor)return;
    const close=(event:globalThis.PointerEvent)=>{if(!itemRef.current?.contains(event.target as Node))setAnchor(null);};
    document.addEventListener("pointerdown",close);
    return()=>document.removeEventListener("pointerdown",close);
  },[anchor]);

  const preview=anchor&&createPortal(<div id={previewId} ref={previewRef} role="tooltip" className="history-preview" style={{left:position?.x??anchor.x+12,top:position?.y??anchor.y+12,visibility:position?"visible":"hidden"}}><b>{operationWords[item.operation]}: {title}</b><Metadata items={resourceMetadata(item.resource,data)}/>{item.operation==="update"&&<Changes changes={item.changes}/>}<small>Источник: {item.origin}{item.reverts_operation_id?" · компенсирующая операция":""}</small></div>,document.body);

  return <article ref={itemRef} className={`history-item ${item.operation}`} tabIndex={0} aria-label={`${operationWords[item.operation]}: ${title}${scheduled?`. ${scheduled}`:""}`} aria-describedby={anchor?previewId:undefined}
    onPointerDown={event=>{lastPointerType.current=event.pointerType;if(!(event.target as HTMLElement).closest("button"))event.preventDefault();}}
    onPointerEnter={event=>{if(event.pointerType==="mouse")setAnchor({x:event.clientX,y:event.clientY});}}
    onPointerMove={event=>{if(event.pointerType==="mouse"&&anchor)setAnchor({x:event.clientX,y:event.clientY});}}
    onPointerLeave={()=>{if(!itemRef.current?.contains(document.activeElement))setAnchor(null);}}
    onPointerUp={event=>{if(event.pointerType!=="mouse"&&!(event.target as HTMLElement).closest("button"))setAnchor(current=>current?null:{x:event.clientX,y:event.clientY});}}
    onFocus={()=>{if(lastPointerType.current!=="touch"&&lastPointerType.current!=="pen")anchorToItem();lastPointerType.current="";}}
    onBlur={event=>{if(!itemRef.current?.contains(event.relatedTarget as Node))setAnchor(null);}}
    onKeyDown={event=>{if(event.key==="Escape"){setAnchor(null);itemRef.current?.blur();}}}>
    <time dateTime={item.created_at}>{formatHistoryTime(item.created_at)}</time><span className="history-copy"><span className="history-title">{title}</span>{scheduled&&<small>{scheduled}</small>}</span><button className="history-undo" aria-label={`Отменить ${undoWords[item.operation]}`} onPointerDown={event=>event.stopPropagation()} onPointerUp={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();undo(item.id);}}><span aria-hidden="true">↶</span><span className="undo-label">Отменить {undoWords[item.operation]}</span></button>{preview}
  </article>;
}
