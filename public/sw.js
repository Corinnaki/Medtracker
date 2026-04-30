/* MG MedTracker — Service Worker v3 */
const CACHE = "mg-v3";
const STATIC = ["/", "/index.html", "/manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.url.includes("/api/")) {
    e.respondWith(fetch(e.request));
    return;
  }
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});

// ── Scheduled alarm checks ────────────────────────────────────────────────────
self.addEventListener("message", (e) => {
  if (e.data?.type === "SCHEDULE_CHECK") {
    checkAlarms();
  }
});

function checkAlarms() {
  // Alarms are stored in localStorage by the app;
  // SW reads via client postMessage pattern
  self.clients.matchAll().then((clients) => {
    clients.forEach((client) => client.postMessage({ type: "CHECK_ALARMS" }));
  });
}

// ── Notification click ────────────────────────────────────────────────────────
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      if (clients.length) return clients[0].focus();
      return self.clients.openWindow("/");
    })
  );
});
