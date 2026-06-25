const CACHE_NAME = 'timelog-v7';
const TIMER_DB = 'timelog-timer';
const TIMER_STORE = 'timer';
const TIMER_NOTIF_TAG = 'timelog-active-timer';

const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/config.js',
  '/icon-192.png',
  '/icon-512.png'
];

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

async function updateTimerNotification(timer) {
  if (!self.registration?.showNotification) return;
  if (!timer?.running) {
    const notifs = await self.registration.getNotifications({ tag: TIMER_NOTIF_TAG });
    notifs.forEach(n => n.close());
    return;
  }
  const { title, body } = buildTimerNotifContent(timer);
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
  if (notifInterval) return;
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
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => readTimer()).then(timer => {
      if (timer?.running) {
        scheduleNotificationUpdates();
        return updateTimerNotification(timer);
      }
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (!response || response.status !== 200) return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      }).catch(() => caches.match('/index.html'));
    })
  );
});

self.addEventListener('message', event => {
  const { type, timer } = event.data || {};
  if (type === 'TIMER_SYNC') {
    event.waitUntil(
      (async () => {
        if (timer?.running) {
          await writeTimer(timer);
          scheduleNotificationUpdates();
          await updateTimerNotification(timer);
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
      for (const client of clients) {
        if ('focus' in client) {
          if (action) client.postMessage({ type: 'NOTIF_ACTION', action });
          return client.focus();
        }
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
