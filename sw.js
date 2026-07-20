// Version 6: retire définitivement les anciens caches qui servaient une version obsolète.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.map(key => caches.delete(key))))
    .then(() => self.clients.claim())
    .then(() => self.registration.unregister())
));
self.addEventListener('fetch', event => event.respondWith(fetch(event.request)));
