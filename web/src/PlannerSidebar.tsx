import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import FullCalendar, { type DatesSetInfo } from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/react/daygrid";
import interactionPlugin from "@fullcalendar/react/interaction";
import classicThemePlugin from "@fullcalendar/react/themes/classic";
import ruLocale from "@fullcalendar/react/locales/ru";
import "temporal-polyfill/global";
import "@fullcalendar/react/skeleton.css";
import "@fullcalendar/react/themes/classic/theme.css";
import "@fullcalendar/react/themes/classic/palette.css";
import {
  createEvent,
  createTask,
  deleteEvent,
  deleteTask,
  getEvents,
  getTasks,
  getUserPreferences,
  updateEvent,
  updateTask,
  updateUserPreferences,
} from "./api";
import { partitionUpcoming, toCalendarEntries } from "./planner-data";
import { formatDuration, formatSchedule } from "./format";
import type { CalendarEntry, Event, Task } from "./types";

const horizonOptions=[1,3,7,14,30];
type Resource="task"|"event";
type EditorState={resource:Resource;entry?:CalendarEntry;date?:string};
type DayHover={date:string;x:number;y:number};

function localDateKey(value:Date|string):string {
  const date=typeof value==="string"?new Date(value):value;
  if(Number.isNaN(date.getTime()))return "";
  const part=(number:number)=>String(number).padStart(2,"0");
  return `${date.getFullYear()}-${part(date.getMonth()+1)}-${part(date.getDate())}`;
}

function toLocalInput(value:string|null|undefined):string {
  if(!value)return "";
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return "";
  const part=(number:number)=>String(number).padStart(2,"0");
  return `${date.getFullYear()}-${part(date.getMonth()+1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
}

function fromLocalInput(value:string):string|null {
  if(!value)return null;
  const date=new Date(value);
  return Number.isNaN(date.getTime())?null:date.toISOString();
}

async function collectPages<T>(load:(offset:number)=>Promise<{items:T[];total:number}>):Promise<T[]> {
  const result:T[]=[];
  for(let offset=0;;){const page=await load(offset);result.push(...page.items);offset+=page.items.length;if(offset>=page.total||!page.items.length)return result;}
}

function entryLabel(entry:CalendarEntry):string {
  return new Intl.DateTimeFormat("ru-RU",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}).format(new Date(entry.startsAt));
}

export function PlannerSidebar({open,onClose,revision,onHistoryChanged,onError}:{open:boolean;onClose:()=>void;revision:number;onHistoryChanged:()=>Promise<void>|void;onError:(message:string)=>void}) {
  const [upcomingDays,setUpcomingDays]=useState(7),[overviewTasks,setOverviewTasks]=useState<Task[]>([]),[overviewEvents,setOverviewEvents]=useState<Event[]>([]);
  const [calendarTasks,setCalendarTasks]=useState<Task[]>([]),[calendarEvents,setCalendarEvents]=useState<Event[]>([]);
  const [visibleRange,setVisibleRange]=useState<{from:string;to:string}|null>(null),[loading,setLoading]=useState(true),[fullOpen,setFullOpen]=useState(false);
  const [dayOpen,setDayOpen]=useState<string|null>(null),[dayHover,setDayHover]=useState<DayHover|null>(null),[editor,setEditor]=useState<EditorState|null>(null);

  const loadOverview=useCallback(async(days:number)=>{
    const now=new Date(),end=new Date(now.getTime()+days*86_400_000);
    const [dated,undated,events]=await Promise.all([
      collectPages(offset=>getTasks({offset,status:"open",deadlinePresence:"dated",deadlineTo:end.toISOString()})),
      collectPages(offset=>getTasks({offset,status:"open",deadlinePresence:"undated"})),
      collectPages(offset=>getEvents({offset,startsAtFrom:now.toISOString(),startsAtTo:end.toISOString()})),
    ]);
    setOverviewTasks([...dated,...undated]);setOverviewEvents(events);
  },[]);

  const loadCalendar=useCallback(async(range:{from:string;to:string})=>{
    const [tasks,events]=await Promise.all([
      collectPages(offset=>getTasks({offset,status:"open",deadlinePresence:"dated",deadlineFrom:range.from,deadlineTo:range.to})),
      collectPages(offset=>getEvents({offset,startsAtFrom:range.from,startsAtTo:range.to})),
    ]);
    setCalendarTasks(tasks);setCalendarEvents(events);
  },[]);

  const refresh=useCallback(async()=>{
    setLoading(true);
    try{await Promise.all([loadOverview(upcomingDays),...(visibleRange?[loadCalendar(visibleRange)]:[])]);}
    catch(error){onError((error as Error).message);}
    finally{setLoading(false);}
  },[loadCalendar,loadOverview,onError,upcomingDays,visibleRange]);

  useEffect(()=>{void getUserPreferences().then(preferences=>setUpcomingDays(preferences.upcoming_days)).catch(error=>onError((error as Error).message));},[onError]);
  useEffect(()=>{void refresh();},[refresh,revision]);

  const entries=useMemo(()=>toCalendarEntries(calendarTasks,calendarEvents),[calendarTasks,calendarEvents]);
  const occupied=useMemo(()=>new Set(entries.map(entry=>localDateKey(entry.startsAt))),[entries]);
  const entriesByDate=useMemo(()=>{const result=new Map<string,CalendarEntry[]>();entries.forEach(entry=>{const key=localDateKey(entry.startsAt);result.set(key,[...(result.get(key)||[]),entry]);});return result;},[entries]);
  const selectedEntries=dayOpen?entriesByDate.get(dayOpen)||[]:[];
  const overview=useMemo(()=>partitionUpcoming(overviewTasks,overviewEvents,new Date(),upcomingDays),[overviewTasks,overviewEvents,upcomingDays]);

  const datesSet=useCallback((info:DatesSetInfo)=>{
    const range={from:info.start.toISOString(),to:info.end.toISOString()};
    setVisibleRange(current=>current?.from===range.from&&current.to===range.to?current:range);
  },[]);
  const openDate=(date:string)=>{setDayHover(null);setDayOpen(date);};
  const changed=async()=>{setEditor(null);await Promise.all([refresh(),Promise.resolve(onHistoryChanged())]);};
  const changeHorizon=async(value:number)=>{setUpcomingDays(value);try{await updateUserPreferences({upcoming_days:value});await loadOverview(value);}catch(error){onError((error as Error).message);}};

  const calendar=(fullscreen:boolean)=><FullCalendar
    plugins={[classicThemePlugin,dayGridPlugin,interactionPlugin]}
    locale={ruLocale}
    initialView="dayGridMonth"
    headerToolbar={{left:"prev",center:"title",right:"next today"}}
    height={fullscreen?"100%":"auto"}
    fixedWeekCount={false}
    datesSet={datesSet}
    dayCellClass={info=>occupied.has(localDateKey(info.date))?"calendar-day-occupied":""}
    dayCellDidMount={info=>{const date=localDateKey(info.date);info.el.tabIndex=0;info.el.setAttribute("aria-label",`Открыть дела на ${date}`);info.el.onclick=()=>openDate(date);info.el.onkeydown=event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();openDate(date);}};info.el.onmouseenter=()=>{const rect=info.el.getBoundingClientRect();if(info.el.classList.contains("calendar-day-occupied"))setDayHover({date,x:Math.min(rect.left,window.innerWidth-292),y:rect.bottom+230<window.innerHeight?rect.bottom+5:Math.max(8,rect.top-225)});};info.el.onmouseleave=()=>setDayHover(current=>current?.date===date?null:current);}}
    dayCellWillUnmount={info=>{info.el.onclick=null;info.el.onkeydown=null;info.el.onmouseenter=null;info.el.onmouseleave=null;}}
  />;

  return <>
    <aside className={`planner-sidebar ${open?"open":""}`} aria-label="Календарь и ближайшие дела">
      <div className="sidebar-head"><div><div className="eyebrow">Планы</div><b>Календарь</b></div><button className="sidebar-close" aria-label="Закрыть календарь" onClick={onClose}>×</button></div>
      <div className="mini-calendar">{calendar(false)}</div>
      <button className="calendar-expand" onClick={()=>setFullOpen(true)}>Развернуть календарь</button>
      <div className="upcoming-head"><b>Ближайшие дела</b><label><span className="sr-only">Период ближайших дел</span><select aria-label="Период ближайших дел" value={upcomingDays} onChange={event=>void changeHorizon(Number(event.target.value))}>{horizonOptions.map(value=><option value={value} key={value}>{value} дн.</option>)}</select></label></div>
      <div className="upcoming-list">{loading&&<p className="sidebar-state">Загружаю…</p>}<ScheduleSection title="Просрочено" entries={overview.overdue} onOpen={entry=>setEditor({resource:entry.resource,entry})}/><ScheduleSection title="В ближайшие дни" entries={overview.upcoming} onOpen={entry=>setEditor({resource:entry.resource,entry})}/>{overview.undated.length>0&&<section className="schedule-section"><h3>Без срока</h3>{overview.undated.map(task=>{const entry:CalendarEntry={id:task.id,resource:"task",title:task.title,startsAt:"",durationMinutes:task.estimated_minutes,task};return <ScheduleItem entry={entry} key={task.id} onOpen={item=>setEditor({resource:item.resource,entry:item})}/>;})}</section>}{!loading&&!overview.overdue.length&&!overview.upcoming.length&&!overview.undated.length&&<p className="sidebar-state">На выбранный период ничего не запланировано.</p>}</div>
    </aside>
    {dayHover&&createPortal(<DayHoverPreview date={dayHover.date} entries={entriesByDate.get(dayHover.date)||[]} x={dayHover.x} y={dayHover.y}/>,document.body)}
    {fullOpen&&<div className="calendar-modal-scrim" role="presentation" onMouseDown={()=>setFullOpen(false)}><section className="calendar-modal" role="dialog" aria-modal="true" aria-label="Подробный календарь" onMouseDown={event=>event.stopPropagation()}><div className="calendar-modal-head"><div><div className="eyebrow">Планы</div><h2>Календарь</h2></div><button aria-label="Закрыть подробный календарь" onClick={()=>setFullOpen(false)}>×</button></div><div className="calendar-full">{calendar(true)}</div></section></div>}
    {dayOpen&&<DayDialog date={dayOpen} entries={selectedEntries} onClose={()=>setDayOpen(null)} onOpen={entry=>setEditor({resource:entry.resource,entry})} onCreate={resource=>setEditor({resource,date:dayOpen})}/>}
    {editor&&<CalendarItemDialog state={editor} onClose={()=>setEditor(null)} onChanged={changed} onError={onError}/>} 
  </>;
}

function ScheduleSection({title,entries,onOpen}:{title:string;entries:CalendarEntry[];onOpen:(entry:CalendarEntry)=>void}) {
  if(!entries.length)return null;
  const groups=new Map<string,CalendarEntry[]>();
  entries.forEach(entry=>{const key=localDateKey(entry.startsAt);groups.set(key,[...(groups.get(key)||[]),entry]);});
  return <section className="schedule-section"><h3>{title}</h3>{[...groups.entries()].map(([date,items])=><div className="schedule-day" key={date}><h4>{new Intl.DateTimeFormat("ru-RU",{weekday:"short",day:"numeric",month:"short"}).format(new Date(`${date}T12:00:00`))}</h4>{items.map(entry=><ScheduleItem entry={entry} key={`${entry.resource}:${entry.id}`} onOpen={onOpen}/>)}</div>)}</section>;
}

function DayDialog({date,entries,onClose,onOpen,onCreate}:{date:string;entries:CalendarEntry[];onClose:()=>void;onOpen:(entry:CalendarEntry)=>void;onCreate:(resource:Resource)=>void}) {
  const label=new Intl.DateTimeFormat("ru-RU",{dateStyle:"long"}).format(new Date(`${date}T12:00:00`));
  return <div className="day-dialog-scrim" role="presentation" onMouseDown={onClose}><section className="day-dialog" role="dialog" aria-modal="true" aria-label={`Дела на ${label}`} onMouseDown={event=>event.stopPropagation()}><div className="item-dialog-head"><div><div className="eyebrow">День</div><h2>{label}</h2></div><button aria-label="Закрыть дела на день" onClick={onClose}>×</button></div><div className="day-actions"><button onClick={()=>onCreate("event")}>+ Событие</button><button onClick={()=>onCreate("task")}>+ Задача</button></div><div className="day-entry-list">{entries.map(entry=><button className={`day-entry ${entry.resource}`} key={`${entry.resource}:${entry.id}`} onClick={()=>onOpen(entry)}><EntryDetails entry={entry}/></button>)}{!entries.length&&<p className="sidebar-state">На эту дату ничего нет. Добавьте событие или задачу.</p>}</div></section></div>;
}

function entryKind(entry:CalendarEntry):string{return entry.resource==="task"?"Задача":"Событие";}

function EntryDetails({entry,brief=false}:{entry:CalendarEntry;brief?:boolean}) {
  const source=entry.task||entry.event;
  return <div className="entry-details"><span className="entry-kind">{entryKind(entry)}</span><strong>{entry.title}</strong><span>{entry.startsAt?formatSchedule(entry.startsAt,entry.resource==="event"?entry.durationMinutes:null):"Без срока"}</span>{!brief&&entry.durationMinutes&&<span>{entry.resource==="event"?"Длительность":"Оценка"}: {formatDuration(entry.durationMinutes)}</span>}{!brief&&entry.event?.location&&<span>Место: {entry.event.location}</span>}{!brief&&entry.task?.status&&<span>Статус: {entry.task.status==="completed"?"Выполнена":"Открыта"}</span>}{!brief&&source?.description&&<span>Описание: {source.description}</span>}</div>;
}

function DayHoverPreview({date,entries,x,y}:{date:string;entries:CalendarEntry[];x:number;y:number}) {
  const label=new Intl.DateTimeFormat("ru-RU",{weekday:"long",day:"numeric",month:"long"}).format(new Date(`${date}T12:00:00`));
  return <div className="day-hover-preview" role="tooltip" style={{left:Math.max(8,x),top:y}}><b>{label}</b>{entries.slice(0,4).map(entry=><EntryDetails entry={entry} brief key={`${entry.resource}:${entry.id}`}/>)}{entries.length>4&&<small>Ещё {entries.length-4}</small>}</div>;
}

function ScheduleItem({entry,onOpen}:{entry:CalendarEntry;onOpen:(entry:CalendarEntry)=>void}) {
  const [preview,setPreview]=useState<{x:number;y:number}|null>(null),previewId=`schedule-preview-${entry.resource}-${entry.id}`;
  const show=(element:HTMLElement)=>{const rect=element.getBoundingClientRect(),width=310;setPreview({x:rect.left>width+16?rect.left-width-10:Math.min(rect.right+10,window.innerWidth-width-8),y:Math.max(8,Math.min(rect.top,window.innerHeight-260))});};
  return <><button className={`schedule-item ${entry.resource}`} aria-describedby={preview?previewId:undefined} onMouseEnter={event=>show(event.currentTarget)} onMouseLeave={()=>setPreview(null)} onFocus={event=>show(event.currentTarget)} onBlur={()=>setPreview(null)} onClick={()=>onOpen(entry)}><strong>{entry.title}</strong><small>{entry.startsAt?`${entryLabel(entry)} · ${entry.resource==="task"?"задача":"событие"}`:"Задача без срока"}</small></button>{preview&&createPortal(<div id={previewId} className="schedule-preview" role="tooltip" style={{left:preview.x,top:preview.y}}><EntryDetails entry={entry}/></div>,document.body)}</>;
}

function CalendarItemDialog({state,onClose,onChanged,onError}:{state:EditorState;onClose:()=>void;onChanged:()=>Promise<void>;onError:(message:string)=>void}) {
  const source=state.entry?.task||state.entry?.event;
  const [resource,setResource]=useState<Resource>(state.resource),[title,setTitle]=useState(source?.title||""),[description,setDescription]=useState(source?.description||"");
  const [when,setWhen]=useState(()=>state.entry?toLocalInput(state.entry.startsAt):`${state.date||localDateKey(new Date())}T09:00`);
  const [duration,setDuration]=useState(String(state.entry?.durationMinutes||"")),[location,setLocation]=useState(state.entry?.event?.location||""),[status,setStatus]=useState(state.entry?.task?.status||"open"),[saving,setSaving]=useState(false);
  const existing=Boolean(state.entry);
  const submit=async(event:FormEvent)=>{event.preventDefault();setSaving(true);try{const minutes=duration?Number(duration):null;if(resource==="event"){const starts_at=fromLocalInput(when);if(!starts_at)throw new Error("Укажите дату и время события");const data={title,description:description||null,starts_at,duration_minutes:minutes,location:location||null};if(existing)await updateEvent(state.entry!.id,data);else await createEvent(data);}else{const data={title,description:description||null,deadline:fromLocalInput(when),estimated_minutes:minutes,status:status as "open"|"completed"};if(existing)await updateTask(state.entry!.id,data);else await createTask(data);}await onChanged();}catch(error){onError((error as Error).message);}finally{setSaving(false);}};
  const remove=async()=>{if(!state.entry||!window.confirm(`Удалить «${state.entry.title}»?`))return;setSaving(true);try{if(resource==="event")await deleteEvent(state.entry.id);else await deleteTask(state.entry.id);await onChanged();}catch(error){onError((error as Error).message);}finally{setSaving(false);}};
  return <div className="item-dialog-scrim" role="presentation" onMouseDown={onClose}><form className="item-dialog" role="dialog" aria-modal="true" aria-label={existing?"Редактирование записи":"Новая запись"} onMouseDown={event=>event.stopPropagation()} onSubmit={submit}><div className="item-dialog-head"><h2>{existing?"Изменить запись":"Новая запись"}</h2><button type="button" aria-label="Закрыть форму" onClick={onClose}>×</button></div>{!existing&&<label>Тип<select value={resource} onChange={event=>setResource(event.target.value as Resource)}><option value="event">Событие</option><option value="task">Задача</option></select></label>}<label>Название<input required maxLength={500} value={title} onChange={event=>setTitle(event.target.value)}/></label><label>{resource==="event"?"Начало":"Дедлайн (необязательно)"}<input type="datetime-local" required={resource==="event"} value={when} onChange={event=>setWhen(event.target.value)}/></label><label>{resource==="event"?"Длительность, минут":"Оценка, минут"}<input type="number" min="1" value={duration} onChange={event=>setDuration(event.target.value)}/></label>{resource==="event"&&<label>Место<input maxLength={500} value={location} onChange={event=>setLocation(event.target.value)}/></label>}{resource==="task"&&<label>Статус<select value={status} onChange={event=>setStatus(event.target.value as "open"|"completed")}><option value="open">Открыта</option><option value="completed">Выполнена</option></select></label>}<label>Описание<textarea maxLength={10000} value={description} onChange={event=>setDescription(event.target.value)}/></label><div className="item-dialog-actions">{existing&&<button className="danger" type="button" disabled={saving} onClick={()=>void remove()}>Удалить</button>}<span/><button type="button" onClick={onClose}>Отмена</button><button className="primary" disabled={saving}>{saving?"Сохраняю…":"Сохранить"}</button></div></form></div>;
}
