self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* fallback */ }
  const id = typeof data.reminder_id === "string" ? data.reminder_id : "";
  event.waitUntil(Promise.all([
    self.registration.showNotification(data.title || "Напоминание", {
      body: data.body || "", tag: data.tag || `reminder:${id}`, renotify: false,
      data: { reminderId: id, notificationId: data.notification_id }
    }),
    self.clients.matchAll({type:"window",includeUncontrolled:true}).then(clients => {
      clients.forEach(client => client.postMessage({type:"notifications-changed"}));
    })
  ]));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const id = event.notification.data?.reminderId || "";
  const url = new URL(`/?reminder=${encodeURIComponent(id)}`, self.location.origin);
  event.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(async clients => {
    const existing = clients.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) { await existing.focus(); existing.postMessage({type:"open-reminder",reminderId:id}); }
    else await self.clients.openWindow(url.href);
  }));
});
