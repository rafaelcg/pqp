/*
 * Imported into the generated service worker (see `workbox.importScripts` in
 * vite.config.ts). Two jobs, one file:
 *
 * 1. `push` — Web Push arriving with no page open anywhere. The payload is
 *    built by the server (server/src/services/push.ts): a title, a body, an
 *    app path, and a per-channel tag. It never contains message text. A
 *    notification is shown for EVERY push, even a malformed one — the
 *    subscription was created `userVisibleOnly`, and iOS in particular
 *    penalises a worker that swallows a push silently by revoking the
 *    subscription.
 *
 * 2. `notificationclick` — originally here because Android Chrome refuses
 *    `new Notification()` and only raises notifications through a service
 *    worker, so `deliverViaServiceWorker` in src/lib/notifications.ts calls
 *    `showNotification` and the click lands here, not in the page. Push
 *    notifications ride the exact same handler: both put the target route in
 *    `data.path`.
 */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Not JSON — fall through to the generic notification below.
  }
  const title = typeof data.title === "string" ? data.title : "pqp";
  const options = {
    body: typeof data.body === "string" ? data.body : "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { path: typeof data.path === "string" ? data.path : "/app" },
  };
  if (typeof data.tag === "string") {
    // One live notification per channel — a later push replaces the earlier
    // one instead of stacking, matching the in-app burst behaviour.
    options.tag = data.tag;
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const path = event.notification.data?.path || "/app";

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      // Prefer an open window: focusing the tab someone already has is far less
      // disruptive than opening a second copy of a chat app, and it keeps the
      // live WebSocket rather than reconnecting one.
      for (const client of clientList) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if ("navigate" in client) {
            await client.navigate(path).catch(() => {
              // Navigation can be refused mid-unload; the focus already
              // succeeded, which is the important half.
            });
          }
          return;
        }
      }

      await self.clients.openWindow(path);
    })(),
  );
});
