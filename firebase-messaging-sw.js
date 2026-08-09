/* RentingRadar — Firebase Cloud Messaging service worker.
 *
 * Receives web-push messages when the PWA is closed/backgrounded and shows a
 * notification. Tapping it focuses (or opens) the app and deep-links to the
 * escalated conversation via ?chat=<convId>, which the in-app MobileAdmin
 * module reads on load.
 *
 * The escalationPush Cloud Function sends DATA-ONLY messages (no `notification`
 * key) so this worker controls exactly one visible notification per push —
 * which is also what iOS web push requires (every push must show UI).
 *
 * Served from the hosting root; Firebase Hosting returns the real file before
 * applying the SPA "** -> /index.html" rewrite, so its scope is "/".
 */
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyAiWI-bB-HxFmvgiFSIuYLtFnv7BniFlQk',
  authDomain: 'auth.rentingradar.com',
  projectId: 'rentingradar',
  storageBucket: 'rentingradar.firebasestorage.app',
  messagingSenderId: '622768449810',
  appId: '1:622768449810:web:fde8ec3ba25a70643d2bcb'
});

var messaging = firebase.messaging();

// Activate a new worker immediately so fixes/HTML refreshes don't wait a launch.
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });

// NETWORK-FIRST for page navigations. iOS standalone PWAs are notoriously sticky
// with the cached start page even with no-store headers, which is why deploys
// sometimes didn't show up without re-adding the icon. Routing navigations
// through the worker and always fetching fresh guarantees the latest index.html
// on every launch (the admin is online when working chats; offline just errors,
// same as no SW).
self.addEventListener('fetch', function(event){
  var req = event.request;
  if(req.mode === 'navigate'){
    event.respondWith(fetch(req).catch(function(){ return caches.match(req); }));
  }
});

function _swSetBadge(d){
  // Keep the home-screen icon badge in sync with open escalations even when the
  // app is closed (escalationPush sends data.badge = count).
  try {
    var n = d && d.badge != null ? parseInt(d.badge, 10) : NaN;
    if(isNaN(n) || !self.navigator || !self.navigator.setAppBadge) return;
    if(n > 0) self.navigator.setAppBadge(n); else self.navigator.clearAppBadge();
  } catch(e){}
}

// Keep the home-screen icon badge in sync for EVERY push, including pushes that
// carry a declared `notification` payload (which FCM renders itself, so
// onBackgroundMessage does not fire for them). This listener only touches the
// app badge — it never shows a notification — so it can't create a duplicate.
self.addEventListener('push', function(event){
  try {
    var p = event.data ? event.data.json() : null;
    if(p && p.notification){ _swSetBadge((p && p.data) || {}); }
  } catch(e){}
});

messaging.onBackgroundMessage(function(payload){
  var d = (payload && payload.data) || {};
  // If the push declared a notification, FCM already displayed it — just keep the
  // badge in sync and DO NOT show a second one.
  if(payload && payload.notification){ _swSetBadge(d); return; }
  var convId = d.conversationId || '';
  var title = d.title || 'Chat Assist';
  _swSetBadge(d);
  var options = {
    body: d.body || '',
    icon: '/apple-touch-icon.png',
    badge: '/favicon-32.png',
    tag: d.tag || (convId ? ('rr-' + convId) : 'rr-chat'),
    renotify: true,
    requireInteraction: false,
    data: { conversationId: convId, url: d.url || (convId ? ('/?chat=' + convId) : '/') }
  };
  return self.registration.showNotification(title, options);
});

self.addEventListener('notificationclick', function(event){
  event.notification.close();
  // Data shape differs by who rendered the notification: our own
  // onBackgroundMessage uses a flat {conversationId,url}; an FCM-rendered
  // `notification` payload nests it under data.FCM_MSG.data. Handle both.
  var raw = (event.notification && event.notification.data) || {};
  var data = raw.FCM_MSG && raw.FCM_MSG.data ? raw.FCM_MSG.data : raw;
  var convId = data.conversationId || '';
  var target = data.url || (convId ? ('/?chat=' + convId) : '/');
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list){
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        // Reuse an already-open app window if we can.
        if ('focus' in c) {
          if (data.conversationId && 'postMessage' in c) {
            try { c.postMessage({ type: 'rr-open-chat', conversationId: data.conversationId }); } catch (e) {}
          }
          return c.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});
