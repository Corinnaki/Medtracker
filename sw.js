/* sw.js — Service Worker for MG MedTracker */
const CACHE = "mg-medtracker-v1";
const ASSETS = ["/", "/index.html", "/app.js", "/style.css", "/manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  // Network-first for API calls, cache-first for static assets
  if (e.request.url.includes("/api/")) {
    e.respondWith(fetch(e.request));
  } else {
    e.respondWith(
      caches.match(e.request).then((cached) => cached || fetch(e.request))
    );
  }
});

// ── Notification actions ────────────────────────────────────────────────────
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  if (e.action === "done") {
    // Post message to client to mark dose complete
    self.clients.matchAll({ type: "window" }).then((clients) => {
      clients.forEach((c) =>
        c.postMessage({ type: "MARK_DONE", payload: e.notification.data })
      );
    });
  } else if (e.action === "snooze") {
    const data = e.notification.data;
    setTimeout(() => {
      self.registration.showNotification(`⏰ Reminder: ${data.name}`, {
        body: data.dose,
        icon: "/manifest.json",
        data,
        actions: [
          { action: "done", title: "✅ Taken" },
          { action: "snooze", title: "⏰ +10 min" },
        ],
      });
    }, 10 * 60 * 1000);
  } else {
    // Open/focus the app
    e.waitUntil(
      self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((clients) => {
          if (clients.length) return clients[0].focus();
          return self.clients.openWindow("/");
        })
    );
  }
});
