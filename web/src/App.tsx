import { FormEvent, PointerEvent, useEffect, useRef, useState } from "react";
import { getConversations, getHistory, getMessage, getPlan, request } from "./api";
import { browserTimeZone, formatDateTime, formatDuration, formatMessageTimestamp, formatSchedule, formatSessionTimestamp } from "./format";
import type { Action, AgentMessage, ConversationSummary, Plan } from "./types";

const terminal = new Set(["needs_confirmation", "needs_clarification", "completed", "failed"]);
const pending = new Set(["queued", "transcribing", "processing"]);
const delay = (ms:number) => new Promise(resolve => setTimeout(resolve, ms));
type PlanCommand = (id:string,path:string,method?:string)=>void;

export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem("planner-token"));
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [plans, setPlans] = useState<Record<string, Plan>>({});
  const [sessions, setSessions] = useState<ConversationSummary[]>([]);
  const [conversation, setConversation] = useState<string|null>(null);
  const [error, setError] = useState("");
  const [recording, setRecording] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const recorder = useRef<MediaRecorder|null>(null);
  const chunks = useRef<Blob[]>([]);
  const selectionVersion = useRef(0);
  const chat = useRef<HTMLElement|null>(null);

  async function refreshSessions() {
    const collected:ConversationSummary[] = [];
    let offset = 0;
    for (;;) {
      const page = await getConversations(100,offset);
      collected.push(...page.items);
      offset += page.items.length;
      if (offset >= page.total || page.items.length === 0) break;
    }
    setSessions(collected);
  }

  useEffect(() => {
    if (!token) return;
    void refreshSessions().catch(e => setError((e as Error).message));
    request<{timezone:string}>("/users/me/timezone", {
      method:"PUT",
      body:JSON.stringify({timezone:browserTimeZone()}),
    }).catch(e => setError((e as Error).message));
  }, [token]);

  useEffect(() => {
    if (!messages.length) return;
    requestAnimationFrame(() => chat.current?.scrollTo({top:chat.current.scrollHeight,behavior:"smooth"}));
  }, [messages,plans]);

  async function authenticate(event:FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const data=await request<{access_token:string}>(register?"/auth/register":"/auth/login",{method:"POST",body:JSON.stringify({email,password})});
      sessionStorage.setItem("planner-token",data.access_token);
      sessionStorage.removeItem("planner-conversation");
      setToken(data.access_token);
    } catch(e) { setError((e as Error).message); }
  }

  function mergeMessage(message:AgentMessage) {
    setMessages(old=>[...old.filter(item=>item.id!==message.id),message].sort((left,right)=>left.sequence-right.sequence));
  }

  async function refreshPlan(id:string) {
    const plan=await getPlan(id);
    setPlans(old=>({...old,[id]:plan}));
  }

  async function pollMessage(id:string,version:number) {
    for (;;) {
      const message=await getMessage(id);
      if(version!==selectionVersion.current) return;
      mergeMessage(message);
      if(message.plan_id) await refreshPlan(message.plan_id);
      if(terminal.has(message.status)) return;
      await delay(700);
    }
  }

  async function acceptMessage(message:AgentMessage,version:number) {
    if(version!==selectionVersion.current) return;
    mergeMessage(message);
    setConversation(message.conversation_id);
    void refreshSessions().catch(e=>setError((e as Error).message));
    await pollMessage(message.id,version);
    if(version===selectionVersion.current) await refreshSessions();
  }

  async function sendText(event:FormEvent) {
    event.preventDefault();
    if(!text.trim()) return;
    const body={text:text.trim(),conversation_id:conversation};
    const version=selectionVersion.current;
    setText("");
    try { await acceptMessage(await request<AgentMessage>("/agent/messages",{method:"POST",body:JSON.stringify(body)}),version); }
    catch(e) { setError((e as Error).message); }
  }

  async function sendAudio(blob:Blob) {
    if(!blob.size) return;
    const body=new FormData();
    const version=selectionVersion.current;
    body.append("audio",blob,"message.webm");
    try {
      const suffix=conversation?`?conversation_id=${conversation}`:"";
      await acceptMessage(await request<AgentMessage>(`/agent/messages/audio${suffix}`,{method:"POST",body}),version);
    } catch(e) { setError((e as Error).message); }
  }

  async function startRecording(event:PointerEvent) {
    event.currentTarget.setPointerCapture(event.pointerId);
    setError("");
    try {
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      chunks.current=[];
      const media=new MediaRecorder(stream);
      recorder.current=media;
      media.ondataavailable=event=>{if(event.data.size) chunks.current.push(event.data);};
      media.onstop=()=>{stream.getTracks().forEach(track=>track.stop());setRecording(false);void sendAudio(new Blob(chunks.current,{type:media.mimeType||"audio/webm"}));};
      media.start();
      setRecording(true);
    } catch { setError("Не удалось получить доступ к микрофону"); }
  }

  function stopRecording() { if(recorder.current?.state==="recording") recorder.current.stop(); }

  async function planCommand(planId:string,path:string,method="POST") {
    try {
      await request(path,{method});
      await refreshPlan(planId);
      for(let attempt=0;attempt<8;attempt++) {
        await delay(500);
        const plan=await getPlan(planId);
        setPlans(old=>({...old,[planId]:plan}));
        if(!plan.actions.some(action=>["approved","executing"].includes(action.status))) break;
      }
    } catch(e) { setError((e as Error).message); }
  }

  async function openConversation(id:string) {
    const version=++selectionVersion.current;
    setConversation(id);setMessages([]);setPlans({});setSidebarOpen(false);setError("");
    try {
      const history:AgentMessage[]=[];
      let offset=0;
      for (;;) {
        const page=await getHistory(id,100,offset);
        history.push(...page.items);
        offset+=page.items.length;
        if(offset>=page.total||page.items.length===0) break;
      }
      if(version!==selectionVersion.current) return;
      setMessages(history);
      const planIds=[...new Set(history.flatMap(message=>message.plan_id?[message.plan_id]:[]))];
      const loadedPlans=await Promise.all(planIds.map(id=>getPlan(id)));
      if(version!==selectionVersion.current) return;
      setPlans(Object.fromEntries(loadedPlans.map(plan=>[plan.id,plan])));
    } catch(e) { if(version===selectionVersion.current) setError((e as Error).message); }
  }

  function startNewConversation() {
    selectionVersion.current+=1;
    sessionStorage.removeItem("planner-conversation");
    setConversation(null);setMessages([]);setPlans({});setSidebarOpen(false);setError("");
  }

  function logout() {
    sessionStorage.clear();selectionVersion.current+=1;setToken(null);setSessions([]);startNewConversation();
  }

  if(!token) return <main className="auth-shell"><section className="auth-card"><div className="brand">День за днём</div><h1>{register?"Создать аккаунт":"Войти в ежедневник"}</h1><p>Задачи и встречи — просто скажите, что нужно.</p><form onSubmit={authenticate}><label>Email<input type="email" value={email} onChange={event=>setEmail(event.target.value)} required/></label><label>Пароль<input type="password" minLength={8} value={password} onChange={event=>setPassword(event.target.value)} required/></label><button className="primary">{register?"Зарегистрироваться":"Войти"}</button></form><button className="link" onClick={()=>setRegister(!register)}>{register?"Уже есть аккаунт":"Нет аккаунта? Создать"}</button>{error&&<div className="error">{error}</div>}</section></main>;

  return <main className="app-shell">
    <div className={`sidebar-scrim ${sidebarOpen?"visible":""}`} onClick={()=>setSidebarOpen(false)}/>
    <aside className={`session-sidebar ${sidebarOpen?"open":""}`}>
      <div className="sidebar-head"><div><div className="eyebrow">Диалоги</div><b>История сессий</b></div><button className="sidebar-close" aria-label="Закрыть список сессий" onClick={()=>setSidebarOpen(false)}>×</button></div>
      <button className="primary new-chat" onClick={startNewConversation}>＋ Новый диалог</button>
      <nav className="session-list" aria-label="Сохранённые диалоги">{sessions.map(session=><button key={session.id} className={`session-item ${conversation===session.id?"active":""}`} onClick={()=>void openConversation(session.id)}><span>{session.preview}</span><time dateTime={session.last_activity_at}>{formatSessionTimestamp(session.last_activity_at)}</time></button>)}{sessions.length===0&&<p className="sessions-empty">Здесь появятся ваши прошлые диалоги.</p>}</nav>
    </aside>
    <section className="workspace">
      <header><button className="sessions-toggle" aria-label="Открыть список сессий" onClick={()=>setSidebarOpen(true)}>☰</button><div><div className="eyebrow">Умный ежедневник</div><h1>Что запланируем?</h1></div><button className="quiet" onClick={logout}>Выйти</button></header>
      <section className="chat" ref={chat} aria-live="polite">{messages.length===0&&<div className="empty"><span>✦</span><h2>Начните с простой просьбы</h2><p>«Покажи задачи на сегодня» или «Напомни подготовить отчёт»</p></div>}{messages.map(message=><MessageExchange key={message.id} message={message} plans={plans} command={planCommand} startNewConversation={startNewConversation}/>) }</section>
      {error&&<div className="toast">{error}<button onClick={()=>setError("")}>×</button></div>}
      <footer><form className="composer" onSubmit={sendText}><input aria-label="Сообщение" placeholder="Напишите задачу или вопрос…" value={text} onChange={event=>setText(event.target.value)}/><button className="send" aria-label="Отправить">↑</button><button type="button" className={`mic ${recording?"recording":""}`} aria-label="Удерживайте для записи" onPointerDown={startRecording} onPointerUp={stopRecording} onPointerCancel={stopRecording}>{recording?"■":"●"}</button></form><small>{recording?"Отпустите, чтобы отправить":"Удерживайте красную кнопку для записи"}</small></footer>
    </section>
  </main>;
}

function MessageTime({value,className=""}:{value:string;className?:string}) {
  const label=formatMessageTimestamp(value);
  return label?<time className={`message-time ${className}`} dateTime={value}>{label}</time>:null;
}

export function MessageExchange({message,plans,command,startNewConversation}:{message:AgentMessage;plans:Record<string,Plan>;command:PlanCommand;startNewConversation:()=>void}) {
  const isTranscribing=!message.input_text&&["queued","transcribing","processing"].includes(message.status);
  const showBot=Boolean(message.input_text||message.reply||message.reads.length||message.plan_id||message.error||message.requires_new_conversation);
  return <article className="exchange">{message.input_text&&<div className="bubble user"><div>{message.input_text}</div><MessageTime value={message.created_at}/></div>}{isTranscribing&&<div className="transcription-status"><span>●</span> Распознаю…</div>}{showBot&&<div className="bubble bot"><div className="bot-mark">✦</div><div className="bot-content">{message.reply?<p>{message.reply}</p>:message.input_text&&pending.has(message.status)?<p className="muted">Думаю…</p>:null}{message.reads.map(read=><ReadCard read={read} key={`${read.resource}-${read.id}`}/>)}{message.requires_new_conversation&&<button className="primary new-conversation" onClick={startNewConversation}>Начать новый диалог</button>}{message.error&&<p className="error">{message.error}</p>}{message.plan_id&&plans[message.plan_id]&&<PlanCard plan={plans[message.plan_id]} command={command}/>}<MessageTime value={message.created_at} className="bot-time"/></div></div>}</article>;
}

const operationLabels:Record<string,string>={create:"Создать",update:"Изменить",delete:"Удалить"};
const resourceLabels:Record<string,string>={task:"задачу",event:"событие"};
const resourceHeadings:Record<string,string>={task:"Задача",event:"Событие"};
const planStatusLabels:Record<string,string>={pending:"Ожидает подтверждения",partially_confirmed:"Частично подтверждён",executing:"Выполняется",completed:"Выполнен",cancelled:"Отменён",failed:"Ошибка"};
const actionStatusLabels:Record<string,string>={pending:"Ожидает подтверждения",approved:"Подтверждено",rejected:"Отклонено",executing:"Выполняется",completed:"Выполнено",failed:"Ошибка",cancelled:"Отменено"};
const taskStatusLabels:Record<string,string>={open:"Открыта",completed:"Выполнена"};

function stringField(payload:Record<string,unknown>,key:string):string|null { const value=payload[key];return typeof value==="string"&&value.trim()?value:null; }
function numberField(payload:Record<string,unknown>,key:string):number|null { const value=payload[key];return typeof value==="number"&&Number.isFinite(value)?value:null; }

function resourceMetadata(resource:string,payload:Record<string,unknown>,timeZone:string) {
  const metadata:Array<{label?:string;value:string}>=[];
  const duration=numberField(payload,resource==="event"?"duration_minutes":"estimated_minutes");
  if(resource==="event") {
    const startsAt=stringField(payload,"starts_at");const schedule=startsAt?formatSchedule(startsAt,duration,timeZone):"";
    if(schedule) metadata.push({value:schedule});if(duration) metadata.push({label:"Длительность",value:formatDuration(duration)});
    const location=stringField(payload,"location");if(location) metadata.push({label:"Место",value:location});
  } else {
    const deadline=stringField(payload,"deadline");const formatted=deadline?formatDateTime(deadline,timeZone):"";
    if(formatted) metadata.push({label:"Срок",value:formatted});if(duration) metadata.push({label:"Оценка",value:formatDuration(duration)});
    const status=stringField(payload,"status");if(status) metadata.push({label:"Статус задачи",value:taskStatusLabels[status]||status});
  }
  const description=stringField(payload,"description");if(description) metadata.push({label:"Описание",value:description});
  return metadata;
}

function Metadata({items}:{items:Array<{label?:string;value:string}>}) { return items.length?<dl className="resource-metadata">{items.map((item,index)=><div key={`${item.label||"schedule"}-${index}`}>{item.label&&<dt>{item.label}:</dt>}<dd>{item.value}</dd></div>)}</dl>:null; }

export function ReadCard({read,timeZone=browserTimeZone()}:{read:{resource:string;id:string;data:Record<string,unknown>};timeZone?:string}) {
  const title=stringField(read.data,"title")||read.id;
  return <article className="read-card"><span className="read-kind">{resourceHeadings[read.resource]||read.resource}</span><strong>{title}</strong><Metadata items={resourceMetadata(read.resource,read.data,timeZone)}/></article>;
}

function ActionDetails({action,timeZone}:{action:Action;timeZone:string}) {
  const title=stringField(action.payload,"title");const identity=action.target_id||(typeof action.result?.id==="string"?action.result.id:null);
  return <div className="action-copy"><b>{operationLabels[action.operation]||action.operation} {resourceLabels[action.resource]||action.resource}</b>{action.operation==="update"&&<small className="action-caption">Изменяемые данные</small>}{title&&<strong className="action-title">{title}</strong>}{!title&&identity&&<small className="action-identity">ID: {identity}</small>}<Metadata items={resourceMetadata(action.resource,action.payload,timeZone)}/>{action.error&&<p className="action-error">{action.error}</p>}</div>;
}

export function PlanCard({plan,command,timeZone=browserTimeZone()}:{plan:Plan;command:PlanCommand;timeZone?:string}) {
  return <section className="plan"><div className="plan-head"><b>План действий</b><span>{planStatusLabels[plan.status]||plan.status}</span></div>{plan.actions.map(action=><div className="action" key={action.id}><ActionDetails action={action} timeZone={timeZone}/><span className={`status ${action.status}`}>{actionStatusLabels[action.status]||action.status}</span>{action.status==="pending"&&<div className="action-buttons"><button onClick={()=>command(plan.id,`/agent/plans/${plan.id}/actions/${action.id}/confirm`)}>Подтвердить</button><button onClick={()=>command(plan.id,`/agent/plans/${plan.id}/actions/${action.id}`,"DELETE")}>Убрать</button></div>}</div>)}{plan.actions.some(action=>action.status==="pending")&&<div className="plan-buttons"><button className="primary" onClick={()=>command(plan.id,`/agent/plans/${plan.id}/confirm`)}>Подтвердить всё</button><button className="quiet" onClick={()=>command(plan.id,`/agent/plans/${plan.id}/cancel`)}>Отменить</button></div>}</section>;
}
