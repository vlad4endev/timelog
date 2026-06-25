const CACHE_NAME = 'timelog-v15';
const IS_IOS = /iPad|iPhone|iPod/.test(self.navigator?.userAgent || '');
const TIMER_DB = 'timelog-timer';
const TIMER_STORE = 'timer';
const TIMER_NOTIF_TAG = 'timelog-active-timer';

const OFFLINE_ASSETS = [
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png'
];

const SHELL_PATHS = new Set([
  '/',
  '/index.html',
  '/manifest.json',
  '/config.js',
  '/sw.js'
]);

const ICON_PATHS = new Set([
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png'
]);

function requestPath(request) {
  try {
    return new URL(request.url).pathname;
  } catch {
    return '';
  }
}

function isShellRequest(request) {
  if (request.mode === 'navigate') return true;
  return SHELL_PATHS.has(requestPath(request));
}

function isIconRequest(request) {
  return ICON_PATHS.has(requestPath(request));
}

function cachePut(request, response) {
  if (!response || response.status !== 200) return;
  const path = requestPath(request);
  if (SHELL_PATHS.has(path) || path.endsWith('.html') || path.endsWith('.js')) return;
  const clone = response.clone();
  caches.open(CACHE_NAME).then(cache => cache.put(request, clone)).catch(() => {});
}

function networkFirst(request) {
  return fetch(request)
    .then(response => {
      cachePut(request, response);
      return response;
    })
    .catch(() => caches.match(request).then(cached => cached || caches.match('/index.html')));
}

function staleWhileRevalidate(request) {
  return caches.match(request).then(cached => {
    const network = fetch(request)
      .then(response => {
        cachePut(request, response);
        return response;
      })
      .catch(() => null);
    return cached || network.then(response => response || caches.match('/index.html'));
  });
}

function openTimerDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(TIMER_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(TIMER_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readTimer() {
  try {
    const db = await openTimerDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(TIMER_STORE, 'readonly');
      const req = tx.objectStore(TIMER_STORE).get('current');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function writeTimer(timer) {
  try {
    const db = await openTimerDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(TIMER_STORE, 'readwrite');
      const req = tx.objectStore(TIMER_STORE).put({ ...timer, id: 'current' });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // ignore IDB errors
  }
}

async function clearTimer() {
  try {
    const db = await openTimerDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(TIMER_STORE, 'readwrite');
      const req = tx.objectStore(TIMER_STORE).delete('current');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // ignore
  }
}

function calcElapsedMs(timer, now = Date.now()) {
  if (!timer?.running || !timer.startTime) return 0;
  const paused = timer.pausedMs || 0;
  const extra = (timer.paused && timer.pauseStart) ? (now - timer.pauseStart) : 0;
  return Math.max(0, now - timer.startTime - paused - extra);
}

function fmtDuration(ms) {
  const secs = Math.floor(ms / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function calcEarned(timer, now = Date.now()) {
  const rate = timer?.rate || 0;
  if (!rate) return 0;
  return rate * (calcElapsedMs(timer, now) / 3600000);
}

function fmtMoneyLive(amount, currency = 'RUB') {
  try {
    return new Intl.NumberFormat('ru-RU', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  } catch {
    return `${Math.round(amount * 100) / 100} ${currency}`;
  }
}

function buildTimerNotifContent(timer, now = Date.now()) {
  const elapsed = fmtDuration(calcElapsedMs(timer, now));
  const title = timer.paused ? `⏸ ${elapsed}` : elapsed;
  const parts = [];
  if (timer.task) parts.push(timer.task);
  else if (timer.projectName) parts.push(timer.projectName);
  const earned = calcEarned(timer, now);
  if (earned > 0) parts.push(`+ ${fmtMoneyLive(earned, timer.currency || 'RUB')}`);
  const body = parts.length ? parts.join(' · ') : 'TimeLog';
  return { title, body };
}

let lastNotifSignature = null;

async function updateTimerNotification(timer, force = false) {
  if (!self.registration?.showNotification) return;
  if (!timer?.running) {
    lastNotifSignature = null;
    const notifs = await self.registration.getNotifications({ tag: TIMER_NOTIF_TAG });
    notifs.forEach(n => n.close());
    return;
  }
  const { title, body } = buildTimerNotifContent(timer);
  const signature = `${timer.paused}|${timer.task}|${timer.projectName}`;
  if (IS_IOS) {
    if (!force && signature === lastNotifSignature) return;
    lastNotifSignature = signature;
    const existing = await self.registration.getNotifications({ tag: TIMER_NOTIF_TAG });
    existing.forEach(n => n.close());
  }
  await self.registration.showNotification(title, {
    body,
    tag: TIMER_NOTIF_TAG,
    renotify: false,
    silent: true,
    ongoing: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: '/' },
    actions: timer.paused
      ? [{ action: 'resume', title: 'Продолжить' }, { action: 'stop', title: 'Стоп' }]
      : [{ action: 'pause', title: 'Пауза' }, { action: 'stop', title: 'Стоп' }]
  });
}

let notifInterval = null;
function scheduleNotificationUpdates() {
  if (IS_IOS || notifInterval) return;
  notifInterval = setInterval(() => {
    readTimer()
      .then(timer => {
        if (timer?.running) return updateTimerNotification(timer);
        clearInterval(notifInterval);
        notifInterval = null;
        return updateTimerNotification(null);
      })
      .catch(() => {});
  }, 1000);
}
function stopNotificationUpdates() {
  clearInterval(notifInterval);
  notifInterval = null;
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(OFFLINE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => readTimer()).then(timer => {
      if (timer?.running) {
        if (!IS_IOS) scheduleNotificationUpdates();
        return updateTimerNotification(timer, false);
      }
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (isShellRequest(event.request) || isIconRequest(event.request)) {
    event.respondWith(networkFirst(event.request));
    return;
  }
  event.respondWith(staleWhileRevalidate(event.request));
});

self.addEventListener('message', event => {
  const { type, timer } = event.data || {};
  if (type === 'TIMER_CLOSE_NOTIF') {
    event.waitUntil(updateTimerNotification(null));
    return;
  }
  if (type === 'TIMER_SYNC') {
    const notify = event.data?.notify !== false;
    event.waitUntil(
      (async () => {
        if (timer?.running) {
          await writeTimer(timer);
          if (!IS_IOS) {
            scheduleNotificationUpdates();
            await updateTimerNotification(timer, false);
          } else if (notify) {
            await updateTimerNotification(timer, true);
          }
        } else {
          await clearTimer();
          stopNotificationUpdates();
          await updateTimerNotification(null);
        }
      })()
    );
  }
  if (type === 'TIMER_GET') {
    event.waitUntil(
      readTimer().then(stored => {
        event.source?.postMessage({ type: 'TIMER_STATE', timer: stored });
      })
    );
  }
});

self.addEventListener('notificationclick', event => {
  const action = event.action;
  const url = event.notification.data?.url || '/';

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const sameOrigin = clients.find(client => {
        try { return new URL(client.url).origin === self.location.origin; } catch { return false; }
      });
      if (sameOrigin && 'focus' in sameOrigin) {
        if (action) sameOrigin.postMessage({ type: 'NOTIF_ACTION', action });
        return sameOrigin.focus();
      }
      if (self.clients.openWindow) {
        const win = await self.clients.openWindow(url + (action ? `?timerAction=${action}` : ''));
        if (win && action) {
          setTimeout(() => win.postMessage({ type: 'NOTIF_ACTION', action }), 500);
        }
      }
    })()
  );
});
