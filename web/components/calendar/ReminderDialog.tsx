import { FormEvent, useState } from "react";
import { BellIcon, Trash2Icon } from "lucide-react";
import { createReminder, deleteReminder, updateReminder } from "../../api";
import { localDateKey } from "../../libs/format";
import { toLocalInput } from "../../libs/item-form";
import type { Reminder } from "../../types";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

export type ReminderLink = {resource:"task"|"event";id:string;title:string;at:string};

export function ReminderDialog({reminder,date,link,onClose,onChanged,onError}:{
  reminder?:Reminder; date?:string; link?:ReminderLink;
  onClose:()=>void; onChanged:()=>Promise<void>; onError:(message:string)=>void;
}) {
  const [title,setTitle] = useState(reminder?.title || link?.title || "");
  const [description,setDescription] = useState(reminder?.description || "");
  const [when,setWhen] = useState(reminder ? toLocalInput(reminder.remind_at) : link ? toLocalInput(link.at) : `${date || localDateKey(new Date())}T09:00`);
  const [relative,setRelative] = useState(reminder?.relative_offset_minutes != null || Boolean(link));
  const [offset,setOffset] = useState(reminder?.relative_offset_minutes ?? -60);
  const [saving,setSaving] = useState(false);
  const disabled = Boolean(reminder && reminder.status !== "active");

  async function submit(event:FormEvent) {
    event.preventDefault(); setSaving(true);
    try {
      const remind_at = new Date(when).toISOString();
      if (reminder) await updateReminder(reminder.id,{title,description:description || null,remind_at,relative_offset_minutes:relative ? offset : null});
      else await createReminder({title,description:description || null,remind_at,linked_resource:link?.resource || null,linked_id:link?.id || null,relative_offset_minutes:relative ? offset : null});
      await onChanged();
    } catch(error) { onError((error as Error).message); }
    finally { setSaving(false); }
  }

  async function remove() {
    if (!reminder) return;
    setSaving(true);
    try { await deleteReminder(reminder.id); await onChanged(); }
    catch(error) { onError((error as Error).message); }
    finally { setSaving(false); }
  }

  return <Dialog open onOpenChange={open=>{if(!open)onClose();}}>
    <DialogContent closeLabel="Закрыть напоминание" aria-label="Напоминание" className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
      <form className="grid gap-4" onSubmit={submit}>
        <DialogHeader><DialogTitle className="flex items-center gap-2"><BellIcon className="size-5" aria-hidden="true"/>{reminder ? "Напоминание" : "Новое напоминание"}</DialogTitle></DialogHeader>
        <div className="grid gap-1.5"><Label htmlFor="reminder-title">Название</Label><Input id="reminder-title" required maxLength={500} disabled={disabled} value={title} onChange={event=>setTitle(event.target.value)}/></div>
        <div className="grid gap-1.5"><Label htmlFor="reminder-when">Напомнить в</Label><Input id="reminder-when" type="datetime-local" required disabled={disabled || relative} value={when} onChange={event=>setWhen(event.target.value)}/></div>
        {(link || reminder?.linked_id) && <div className="grid gap-3">
          <Label className="flex items-center gap-2"><input type="checkbox" className="size-4 accent-primary" disabled={disabled} checked={relative} onChange={event=>setRelative(event.target.checked)}/>Относительно {link?.resource === "task" || reminder?.linked_resource === "task" ? "дедлайна" : "начала события"}</Label>
          {relative && <div className="grid gap-1.5"><Label htmlFor="reminder-offset">Смещение в минутах (минус — заранее)</Label><Input id="reminder-offset" type="number" required disabled={disabled} value={offset} onChange={event=>setOffset(Number(event.target.value))}/></div>}
        </div>}
        <div className="grid gap-1.5"><Label htmlFor="reminder-description">Описание</Label><Textarea id="reminder-description" maxLength={10000} disabled={disabled} value={description} onChange={event=>setDescription(event.target.value)}/></div>
        {disabled && <p className="text-sm text-muted-foreground">{reminder?.status === "fired" ? "Напоминание сработало" : "Напоминание отменено"}. Для другого времени создайте новое.</p>}
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          {reminder && !disabled && <Button type="button" variant="destructive" disabled={saving} onClick={()=>void remove()}><Trash2Icon aria-hidden="true"/>Отменить напоминание</Button>}
          <span className="flex-1"/><Button type="button" variant="outline" onClick={onClose}>Закрыть</Button>
          {!disabled && <Button type="submit" disabled={saving}>{saving ? "Сохраняю…" : "Сохранить"}</Button>}
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
