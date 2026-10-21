import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function worker(){
  const handlers:Record<string,(event:any)=>void>={},showNotification=vi.fn(async()=>{}),postMessage=vi.fn(),focus=vi.fn(async()=>{}),openWindow=vi.fn(async()=>{});
  const self={location:{origin:"https://planner.example.com"},addEventListener:(name:string,handler:(event:any)=>void)=>{handlers[name]=handler;},registration:{showNotification},clients:{matchAll:vi.fn(async()=>[{url:"https://planner.example.com/",focus,postMessage}]),openWindow}};
  runInNewContext(readFileSync("public/sw.js","utf8"),{self,URL,encodeURIComponent});
  return {handlers,showNotification,postMessage,focus,openWindow,self};
}

describe("reminder service worker",()=>{
  it("uses the stable tag and refreshes open pages",async()=>{
    const state=worker();let work:Promise<unknown>=Promise.resolve();
    state.handlers.push({data:{json:()=>({reminder_id:"r1",title:"Lesson",tag:"reminder:r1"})},waitUntil:(promise:Promise<unknown>)=>{work=promise;}});await work;
    expect(state.showNotification).toHaveBeenCalledWith("Lesson",expect.objectContaining({tag:"reminder:r1",renotify:false}));
    expect(state.postMessage).toHaveBeenCalledWith({type:"notifications-changed"});
  });
  it("opens the requested reminder in an existing window",async()=>{
    const state=worker();let work:Promise<unknown>=Promise.resolve();const close=vi.fn();
    state.handlers.notificationclick({notification:{data:{reminderId:"r1"},close},waitUntil:(promise:Promise<unknown>)=>{work=promise;}});await work;
    expect(state.focus).toHaveBeenCalledOnce();expect(state.postMessage).toHaveBeenCalledWith({type:"open-reminder",reminderId:"r1"});expect(close).toHaveBeenCalledOnce();
  });
});
