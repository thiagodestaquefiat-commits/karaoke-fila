// Service worker mínimo: deixa o app "instalável" e permite notificações
// no Android. Não guarda nada em cache para a fila estar sempre atualizada.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Tocar na notificação abre (ou foca) o app.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => c.url.includes('index.html') || c.url.endsWith('/'));
      return open ? open.focus() : self.clients.openWindow('./index.html');
    }),
  );
});

// Necessário para o Chrome considerar o app instalável.
self.addEventListener('fetch', () => {});
