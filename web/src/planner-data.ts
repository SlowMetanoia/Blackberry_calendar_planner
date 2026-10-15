import type { CalendarEntry, Event, Task } from "./types";

function taskEntry(task:Task):CalendarEntry|null {
  if(task.status!=="open"||!task.deadline)return null;
  return {id:task.id,resource:"task",title:task.title,startsAt:task.deadline,durationMinutes:task.estimated_minutes,task};
}

function eventEntry(event:Event):CalendarEntry {
  return {id:event.id,resource:"event",title:event.title,startsAt:event.starts_at,durationMinutes:event.duration_minutes,event};
}

function timestamp(value:string):number {
  const parsed=Date.parse(value);
  return Number.isFinite(parsed)?parsed:Number.POSITIVE_INFINITY;
}

export function toCalendarEntries(tasks:Task[],events:Event[]):CalendarEntry[] {
  return [
    ...tasks.map(taskEntry).filter((item):item is CalendarEntry=>item!==null),
    ...events.map(eventEntry),
  ];
}

export function partitionUpcoming(tasks:Task[],events:Event[],now:Date,days:number):{
  overdue:CalendarEntry[];
  upcoming:CalendarEntry[];
  undated:Task[];
} {
  const nowTime=now.getTime(),endTime=nowTime+days*24*60*60*1000;
  const openTasks=tasks.filter(task=>task.status==="open");
  const datedTasks=openTasks.map(taskEntry).filter((item):item is CalendarEntry=>item!==null);
  const overdue=datedTasks.filter(item=>timestamp(item.startsAt)<nowTime);
  const upcoming=[
    ...datedTasks.filter(item=>timestamp(item.startsAt)>=nowTime&&timestamp(item.startsAt)<endTime),
    ...events.map(eventEntry).filter(item=>timestamp(item.startsAt)>=nowTime&&timestamp(item.startsAt)<endTime),
  ];
  const byTime=(left:CalendarEntry,right:CalendarEntry)=>timestamp(left.startsAt)-timestamp(right.startsAt)||left.title.localeCompare(right.title,"ru");
  return {
    overdue:overdue.sort(byTime),
    upcoming:upcoming.sort(byTime),
    undated:openTasks.filter(task=>!task.deadline).sort((left,right)=>left.title.localeCompare(right.title,"ru")),
  };
}
