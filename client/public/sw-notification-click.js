/*
 * Imported into the generated service worker (see `workbox.importScripts` in
 * vite.config.ts).
 *
 * Exists for one reason: Android Chrome refuses `new Notification()` and only
 * raises notifications through a service worker, so `deliverViaServiceWorker`
 * in src/lib/notifications.ts calls `showNotification` — and a notification
 * raised that way delivers its click here, not to the page. Without this the
 * notification appears and tapping it does nothing, which on a phone is most
 * of the feature missing.
 */

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
