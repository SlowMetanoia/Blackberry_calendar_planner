import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { NotificationCenter } from "../components/notifications/NotificationCenter";
import { ReminderDialog } from "../components/calendar/ReminderDialog";

vi.mock("../api",()=>({createReminder:vi.fn(),updateReminder:vi.fn(),deleteReminder:vi.fn(),getNotifications:vi.fn(),getPushConfig:vi.fn(),request:vi.fn(),markNotificationRead:vi.fn(),markAllNotificationsRead:vi.fn(),deleteNotification:vi.fn(),upsertPushSubscription:vi.fn(),deletePushSubscription:vi.fn()}));
beforeEach(()=>{vi.clearAllMocks();});
afterEach(cleanup);

describe("reminders",()=>{
  it("creates a reminder relative to the selected event",async()=>{
    const changed=vi.fn(async()=>{});
    render(<ReminderDialog link={{resource:"event",id:"event-1",title:"Lesson",at:"2030-01-01T10:00:00Z"}} onClose={vi.fn()} onChanged={changed} onError={vi.fn()}/>);
    expect(screen.getByLabelText("Название")).toHaveValue("Lesson");
    await userEvent.click(screen.getByRole("button",{name:"Сохранить"}));
    expect(api.createReminder).toHaveBeenCalledWith(expect.objectContaining({linked_resource:"event",linked_id:"event-1",relative_offset_minutes:-60}));
    expect(changed).toHaveBeenCalledOnce();
  });
  it("keeps fired reminders read-only",()=>{
    render(<ReminderDialog reminder={{id:"r1",owner_id:"u1",title:"Already fired",description:null,remind_at:"2020-01-01T10:00:00Z",status:"fired",linked_resource:null,linked_id:null,relative_offset_minutes:null,cancelled_reason:null,cancelled_at:null,fired_at:"2020-01-01T10:00:01Z",created_at:"2020-01-01T09:00:00Z"}} onClose={vi.fn()} onChanged={vi.fn(async()=>{})} onError={vi.fn()}/>);
    expect(screen.getByLabelText("Название")).toBeDisabled();
    expect(screen.queryByRole("button",{name:"Сохранить"})).not.toBeInTheDocument();
  });
  it("renders unread inbox, marks all read, and removes a notification",async()=>{
    const notice={id:"n1",reminder_id:"r1",title:"Lesson reminder",body:"Bring notes",read_at:null,created_at:"2030-01-01T09:00:00Z"};
    vi.mocked(api.getNotifications).mockImplementation(async(unread)=>({items:unread?[]:[notice],total:1,limit:100,offset:0}));
    render(<NotificationCenter onError={vi.fn()}/>);
    await userEvent.click(await screen.findByRole("button",{name:"Уведомления: 1 непрочитанных"}));
    expect(screen.getByText("Bring notes")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button",{name:"Прочитать все"}));
    expect(api.markAllNotificationsRead).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button",{name:"Удалить уведомление Lesson reminder"}));
    expect(api.deleteNotification).toHaveBeenCalledWith("n1");
  });
  it("refreshes the inbox when the window regains focus",async()=>{
    vi.mocked(api.getNotifications).mockResolvedValue({items:[],total:0,limit:100,offset:0});
    render(<NotificationCenter onError={vi.fn()}/>);
    await waitFor(()=>expect(api.getNotifications).toHaveBeenCalledTimes(2));
    window.dispatchEvent(new Event("focus"));
    await waitFor(()=>expect(api.getNotifications).toHaveBeenCalledTimes(4));
  });
});
