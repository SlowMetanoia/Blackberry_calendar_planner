import { FormEvent, PointerEvent, useEffect, useRef, useState } from "react";
import { getHistory, getMessage, getPlan, request } from "./api";
import { browserTimeZone, formatDateTime, formatDuration, formatMessageTimestamp, formatSchedule } from "./format";
import type { Action, AgentMessage, Plan } from "./types";

const terminal = new Set(["needs_confirmation", "needs_clarification", "completed", "failed"]);
const delay = (ms:number) => new Promise(resolve => setTimeout(resolve, ms));

export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem("planner-token"));
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [text, setText] = useState(""); const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [plans, setPlans] = useState<Record<string, Plan>>({});
  const [conversation, setConversation] = useState(() => sessionStorage.getItem("planner-conversation"));
  const restoredConversation = useRef(conversation);
  const [error, setError] = useState(""); const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder|null>(null); const chunks = useRef<Blob[]>([]);

  useEffect(() => { const saved=restoredConversation.current; if (token && saved) getHistory(saved).then(p => setMessages(p.items)).catch(e => setError(e.message)); }, [token]);
  useEffect(() => {
    if (!token) return;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    request<{timezone:string}>("/users/me/timezone", {
      method:"PUT",
      body:JSON.stringify({timezone}),
    }).catch(e => setError((e as Error).message));
  }, [token]);

  async function authenticate(event:FormEvent) {
    event.preventDefault(); setError("");
    try {
      const data = await request<{access_token:string}>(register ? "/auth/register" : "/auth/login", {method:"POST", body:JSON.stringify({email,password})});
      sessionStorage.setItem("planner-token", data.access_token); setToken(data.access_token);
    } catch (e) { setError((e as Error).message); }
  }
  function mergeMessage(message:AgentMessage) { setMessages(old => [...old.filter(m => m.id !== message.id), message].sort((a,b) => a.sequence-b.sequence)); }
  async function pollMessage(id:string) {
    for (;;) { const message = await getMessage(id); mergeMessage(message); if (message.plan_id) await refreshPlan(message.plan_id); if (terminal.has(message.status)) return; await delay(700); }
  }
  async function acceptMessage(message:AgentMessage) {
    mergeMessage(message); setConversation(message.conversation_id); sessionStorage.setItem("planner-conversation", message.conversation_id); await pollMessage(message.id);
  }
  async function sendText(event:FormEvent) {
    event.preventDefault(); if (!text.trim()) return; const body = {text:text.trim(), conversation_id:conversation}; setText("");
    try { await acceptMessage(await request<AgentMessage>("/agent/messages", {method:"POST", body:JSON.stringify(body)})); } catch(e) { setError((e as Error).message); }
  }
  async function sendAudio(blob:Blob) {
    if (!blob.size) return; const body = new FormData(); body.append("audio", blob, "message.webm"); if (conversation) body.append("conversation_id", conversation);
    try { await acceptMessage(await request<AgentMessage>(`/agent/messages/audio${conversation ? `?conversation_id=${conversation}` : ""}`, {method:"POST", body})); } catch(e) { setError((e as Error).message); }
  }
  async function startRecording(event:PointerEvent) {
    event.currentTarget.setPointerCapture(event.pointerId); setError("");
    try { const stream = await navigator.mediaDevices.getUserMedia({audio:true}); chunks.current=[]; const media = new MediaRecorder(stream); recorder.current=media; media.ondataavailable=e => { if(e.data.size) chunks.current.push(e.data); }; media.onstop=() => { stream.getTracks().forEach(t=>t.stop()); setRecording(false); void sendAudio(new Blob(chunks.current,{type:media.mimeType||"audio/webm"})); }; media.start(); setRecording(true); } catch(e) { setError("Не удалось получить доступ к микрофону"); }
  }
  function stopRecording() { if (recorder.current?.state === "recording") recorder.current.stop(); }
  async function refreshPlan(id:string) { const plan=await getPlan(id); setPlans(old=>({...old,[id]:plan})); }
  async function planCommand(planId:string, path:string, method="POST") { try { await request(path,{method}); await refreshPlan(planId); for(let i=0;i<8;i++){ await delay(500); const p=await getPlan(planId); setPlans(old=>({...old,[planId]:p})); if(!p.actions.some(a=>["approved","executing"].includes(a.status))) break; } } catch(e){setError((e as Error).message);} }
  function logout(){ sessionStorage.clear(); setToken(null); setMessages([]); setPlans({}); setConversation(null); }
  function startNewConversation(){ sessionStorage.removeItem("planner-conversation"); restoredConversation.current=null; setConversation(null); setMessages([]); setPlans({}); setError(""); }

  if (!token) return <main className="auth-shell"><section className="auth-card"><div className="brand">День за днём</div><h1>{register ? "Создать аккаунт" : "Войти в ежедневник"}</h1><p>Задачи и встречи — просто скажите, что нужно.</p><form onSubmit={authenticate}><label>Email<input type="email" value={email} onChange={e=>setEmail(e.target.value)} required /></label><label>Пароль<input type="password" minLength={8} value={password} onChange={e=>setPassword(e.target.value)} required /></label><button className="primary">{register?"Зарегистрироваться":"Войти"}</button></form><button className="link" onClick={()=>setRegister(!register)}>{register?"Уже есть аккаунт":"Нет аккаунта? Создать"}</button>{error&&<div className="error">{error}</div>}</section></main>;

  return <main className="app-shell"><header><div><div className="eyebrow">Умный ежедневник</div><h1>Что запланируем?</h1></div><button className="quiet" onClick={logout}>Выйти</button></header><section className="chat" aria-live="polite">{messages.length===0&&<div className="empty"><span>✦</span><h2>Начните с простой просьбы</h2><p>«Покажи задачи на сегодня» или «Напомни подготовить отчёт»</p></div>}{messages.map(message=><article className="exchange" key={message.id}>{message.input_text&&<div className="bubble user"><div>{message.input_text}</div><MessageTime value={message.created_at}/></div>}<div className="bubble bot"><div className="bot-mark">✦</div><div>{message.reply ? <p>{message.reply}</p> : <p className="muted">{message.status === "transcribing" ? "Распознаю…" : "Думаю…"}</p>}{message.reads.map(read=><div className="read-card" key={read.id}><b>{read.resource==="task"?"Задача":"Событие"}</b><span>{String(read.data.title||read.id)}</span></div>)}{message.requires_new_conversation&&<button className="primary new-conversation" onClick={startNewConversation}>Начать новый диалог</button>}{message.error&&<p className="error">{message.error}</p>}{message.plan_id&&plans[message.plan_id]&&<PlanCard plan={plans[message.plan_id]} command={planCommand}/>}<MessageTime value={message.created_at}/></div></div></article>)}</section>{error&&<div className="toast">{error}<button onClick={()=>setError("")}>×</button></div>}<footer><form className="composer" onSubmit={sendText}><input aria-label="Сообщение" placeholder="Напишите задачу или вопрос…" value={text} onChange={e=>setText(e.target.value)}/><button className="send" aria-label="Отправить">↑</button><button type="button" className={`mic ${recording?"recording":""}`} aria-label="Удерживайте для записи" onPointerDown={startRecording} onPointerUp={stopRecording} onPointerCancel={stopRecording}>{recording?"■":"●"}</button></form><small>{recording?"Отпустите, чтобы отправить":"Удерживайте красную кнопку для записи"}</small></footer></main>;
}

function MessageTime({value}:{value:string}) {
  const label = formatMessageTimestamp(value);
  return label ? <time className="message-time" dateTime={value}>{label}</time> : null;
}

const operationLabels:Record<string,string> = {create:"Создать",update:"Изменить",delete:"Удалить"};
const resourceLabels:Record<string,string> = {task:"задачу",event:"событие"};
const planStatusLabels:Record<string,string> = {
  pending:"Ожидает подтверждения", partially_confirmed:"Частично подтверждён",
  executing:"Выполняется", completed:"Выполнен", cancelled:"Отменён", failed:"Ошибка",
};
const actionStatusLabels:Record<string,string> = {
  pending:"Ожидает подтверждения", approved:"Подтверждено", rejected:"Отклонено",
  executing:"Выполняется", completed:"Выполнено", failed:"Ошибка", cancelled:"Отменено",
};
const taskStatusLabels:Record<string,string> = {open:"Открыта",completed:"Выполнена"};

function stringField(payload:Record<string,unknown>, key:string):string|null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function numberField(payload:Record<string,unknown>, key:string):number|null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ActionDetails({action,timeZone}:{action:Action;timeZone:string}) {
  const {payload} = action;
  const title = stringField(payload,"title");
  const description = stringField(payload,"description");
  const duration = numberField(payload,action.resource === "event" ? "duration_minutes" : "estimated_minutes");
  const identity = action.target_id || (typeof action.result?.id === "string" ? action.result.id : null);
  const metadata:Array<{label?:string;value:string}> = [];

  if (action.resource === "event") {
    const startsAt = stringField(payload,"starts_at");
    const schedule = startsAt ? formatSchedule(startsAt,duration,timeZone) : "";
    if (schedule) metadata.push({value:schedule});
    if (duration) metadata.push({label:"Длительность",value:formatDuration(duration)});
    const location = stringField(payload,"location");
    if (location) metadata.push({label:"Место",value:location});
  } else {
    const deadline = stringField(payload,"deadline");
    const formattedDeadline = deadline ? formatDateTime(deadline,timeZone) : "";
    if (formattedDeadline) metadata.push({label:"Срок",value:formattedDeadline});
    if (duration) metadata.push({label:"Оценка",value:formatDuration(duration)});
    const taskStatus = stringField(payload,"status");
    if (taskStatus) metadata.push({label:"Статус задачи",value:taskStatusLabels[taskStatus] || taskStatus});
  }
  if (description) metadata.push({label:"Описание",value:description});

  return <div className="action-copy">
    <b>{operationLabels[action.operation] || action.operation} {resourceLabels[action.resource] || action.resource}</b>
    {action.operation === "update" && <small className="action-caption">Изменяемые данные</small>}
    {title && <strong className="action-title">{title}</strong>}
    {!title && identity && <small className="action-identity">ID: {identity}</small>}
    {metadata.length > 0 && <dl className="action-metadata">{metadata.map((item,index)=><div key={`${item.label || "schedule"}-${index}`}>{item.label&&<dt>{item.label}:</dt>}<dd>{item.value}</dd></div>)}</dl>}
    {action.error && <p className="action-error">{action.error}</p>}
  </div>;
}

export function PlanCard({plan,command,timeZone=browserTimeZone()}:{plan:Plan;command:(id:string,path:string,method?:string)=>void;timeZone?:string}) {
  return <section className="plan">
    <div className="plan-head"><b>План действий</b><span>{planStatusLabels[plan.status] || plan.status}</span></div>
    {plan.actions.map(action=><div className="action" key={action.id}>
      <ActionDetails action={action} timeZone={timeZone}/>
      <span className={`status ${action.status}`}>{actionStatusLabels[action.status] || action.status}</span>
      {action.status==="pending"&&<div className="action-buttons"><button onClick={()=>command(plan.id,`/agent/plans/${plan.id}/actions/${action.id}/confirm`)}>Подтвердить</button><button onClick={()=>command(plan.id,`/agent/plans/${plan.id}/actions/${action.id}`,"DELETE")}>Убрать</button></div>}
    </div>)}
    {plan.actions.some(a=>a.status==="pending")&&<div className="plan-buttons"><button className="primary" onClick={()=>command(plan.id,`/agent/plans/${plan.id}/confirm`)}>Подтвердить всё</button><button className="quiet" onClick={()=>command(plan.id,`/agent/plans/${plan.id}/cancel`)}>Отменить</button></div>}
  </section>;
}
