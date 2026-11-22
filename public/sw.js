'use strict';
/* Service worker notifikasi: menerima Web Push dari server dan menampilkannya sebagai notifikasi HP. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : '' }; }
  const opts = {
    body: d.body || '',
    icon: d.icon || '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { url: d.url || '/' },
    lang: 'id',
    vibrate: [120, 60, 120],
  };
  if (d.tag) { opts.tag = d.tag; opts.renotify = true; }
  event.waitUntil(self.registration.showNotification(d.title || 'Notifikasi baru', opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let target;
  try { target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin); } catch (e) { target = new URL('/', self.location.origin); }
  if (target.origin !== self.location.origin) target = new URL('/', self.location.origin);
  const wantAdmin = target.pathname === '/admin' || target.pathname.startsWith('/admin/');
  const sameArea = (u) => (wantAdmin ? (u.pathname === '/admin' || u.pathname.startsWith('/admin/')) : (u.pathname === '/' || u.pathname === '/account'));
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      let u; try { u = new URL(c.url); } catch (e) { continue; }
      if (u.origin !== target.origin || !sameArea(u)) continue;
      try { await c.focus(); c.postMessage({ type: 'push-open', url: target.href }); return; } catch (e) { /* coba klien lain / buka baru */ }
    }
    await self.clients.openWindow(target.href);
  })());
});

// Langganan kedaluwarsa/diganti browser: minta halaman yang terbuka untuk berlangganan ulang.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => list.forEach((c) => c.postMessage({ type: 'push-resubscribe' }))));
});
