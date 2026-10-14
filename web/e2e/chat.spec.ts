import { expect, test } from "@playwright/test";

test("shows authentication entry point", async ({page}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", {name:"Войти в ежедневник"})).toBeVisible();
  await expect(page.getByRole("button", {name:"Войти"})).toBeVisible();
});

test("opens a saved session with rich reads and left-aligned assistant time", async ({page}) => {
  await page.addInitScript(() => sessionStorage.setItem("planner-token", "test-token"));
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === "PUT") {
      await route.fulfill({json:{timezone:"Europe/Moscow"}});
    } else if (url.pathname === "/api/agent/conversations") {
      await route.fulfill({json:{items:[{id:"c1",preview:"Что у меня на завтра?",created_at:"2026-10-14T09:59:00Z",last_activity_at:"2026-10-14T09:59:00Z"}],total:1,limit:100,offset:0}});
    } else if (url.pathname === "/api/agent/conversations/c1/messages") {
      await route.fulfill({json:{items:[{id:"m1",conversation_id:"c1",sequence:1,input_text:"Что у меня на завтра?",status:"completed",reply:"Вот ваше событие",reads:[{resource:"event",id:"e1",data:{title:"Лекция",starts_at:"2026-10-15T09:00:00Z",duration_minutes:90,location:"Политех",description:"Параллельное программирование"}}],operations:[],error:null,created_at:"2026-10-14T09:59:00Z"}],total:1,limit:100,offset:0}});
    } else if (url.pathname === "/api/calendar/history") {
      await route.fulfill({json:{items:[],total:0,limit:100,offset:0}});
    } else {
      await route.fulfill({status:404,json:{detail:"not mocked"}});
    }
  });

  await page.goto("/");
  await expect(page.getByText("Начните с простой просьбы")).toBeVisible();
  await page.getByRole("button", {name:"История сессий"}).click();
  await page.getByRole("button", {name:/Что у меня на завтра/}).click();
  await expect(page.getByText("15 октября 2026, 12:00–13:30")).toBeVisible();
  await expect(page.getByText("Параллельное программирование")).toBeVisible();
  const bubble = await page.locator(".bubble.bot").boundingBox();
  const timestamp = await page.locator(".bot-time").boundingBox();
  expect(bubble).not.toBeNull();
  expect(timestamp).not.toBeNull();
  expect(timestamp!.x - bubble!.x).toBeLessThan(40);
});

test("keeps the page fixed while sidebar and messages scroll independently", async ({page}) => {
  await page.addInitScript(() => sessionStorage.setItem("planner-token", "test-token"));
  const sessions = Array.from({length:30}, (_,index) => ({
    id:`c${index}`, preview:`Диалог ${index}`, created_at:"2026-10-14T09:00:00Z", last_activity_at:"2026-10-14T09:00:00Z",
  }));
  const messages = Array.from({length:30}, (_,index) => ({
    id:`m${index}`,conversation_id:"c0",sequence:index+1,input_text:`Сообщение ${index}`,status:"completed",
    reply:`Ответ ${index}`,reads:[],operations:[],error:null,created_at:"2026-10-14T09:00:00Z",
  }));
  const operations = Array.from({length:30}, (_,index) => ({
    id:`o${index}`,sequence:index+1,command_id:`cmd${index}`,ordinal:0,operation:"create",resource:"task",target_id:`t${index}`,before:null,after:{title:`Задача ${index}`},changes:{},origin:"rest",source_message_id:null,reverts_operation_id:null,created_at:"2026-10-14T09:00:00Z",
  }));
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === "PUT") await route.fulfill({json:{timezone:"Europe/Moscow"}});
    else if (url.pathname === "/api/agent/conversations") await route.fulfill({json:{items:sessions,total:sessions.length,limit:100,offset:0}});
    else if (url.pathname === "/api/agent/conversations/c0/messages") await route.fulfill({json:{items:messages,total:messages.length,limit:100,offset:0}});
    else if (url.pathname === "/api/calendar/history") await route.fulfill({json:{items:operations,total:operations.length,limit:100,offset:0}});
    else await route.fulfill({status:404,json:{detail:"not mocked"}});
  });
  await page.goto("/");
  const firstHistoryItem = page.locator(".history-item").first();
  await firstHistoryItem.hover();
  const historyDetail = await firstHistoryItem.locator(".history-detail").boundingBox();
  const historySidebar = await page.locator(".operation-sidebar").boundingBox();
  expect(historyDetail).not.toBeNull();
  expect(historySidebar).not.toBeNull();
  expect(historyDetail!.x).toBeGreaterThanOrEqual(historySidebar!.x);
  expect(historyDetail!.x + historyDetail!.width).toBeLessThanOrEqual(
    historySidebar!.x + historySidebar!.width,
  );
  await page.getByRole("button", {name:"История сессий"}).click();
  await page.getByRole("button", {name:/Диалог 0/}).click();
  await expect(page.getByText("Ответ 29")).toBeVisible();

  const layout = await page.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>(".operation-list")!;
    const chat = document.querySelector<HTMLElement>(".chat")!;
    const footer = document.querySelector<HTMLElement>(".workspace > footer")!;
    sidebar.scrollTop = 100;
    const sidebarBefore = sidebar.scrollTop;
    chat.scrollTop = 0;
    chat.scrollTop = 100;
    return {
      bodyFixed: document.body.scrollHeight === document.body.clientHeight,
      sidebarScrollable: sidebar.scrollHeight > sidebar.clientHeight,
      chatScrollable: chat.scrollHeight > chat.clientHeight,
      independent: sidebar.scrollTop === sidebarBefore,
      footerVisible: footer.getBoundingClientRect().bottom <= window.innerHeight,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
    };
  });
  expect(layout).toMatchObject({bodyFixed:true,sidebarScrollable:true,chatScrollable:true,independent:true,footerVisible:true});
  expect(layout.bodyBackground).not.toBe("rgba(0, 0, 0, 0)");
});
