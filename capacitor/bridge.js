import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { ForegroundService, Importance } from '@capawesome-team/capacitor-android-foreground-service';
import { LocalNotifications } from '@capacitor/local-notifications';

const TIMER_NOTIF_ID = 9001;
const CHANNEL_ID = 'timelog-timer';
const BTN_PAUSE = 1;
const BTN_RESUME = 2;
const BTN_STOP = 3;
// Android 14+ FOREGROUND_SERVICE_TYPE_SPECIAL_USE
const ANDROID_FGS_SPECIAL_USE = 1073741824;

let nativeActive = false;
let channelReady = false;
let listenersBound = false;
let currentTimer = null;
let iosAppActive = true;
let iosLastPaused = null;

export function isNativePlatform() {
  return Capacitor.isNativePlatform();
}

export function getPlatform() {
  return isNativePlatform() ? Capacitor.getPlatform() : 'web';
}

function calcElapsedMs(timer, now = Date.now()) {
  if (!timer?.running || !timer.startTime) return 0;
  const paused = timer.pausedMs || 0;
  const extra = timer.paused && timer.pauseStart ? now - timer.pauseStart : 0;
  return Math.max(0, now - timer.startTime - paused - extra);
}

function fmtDuration(ms) {
  const secs = Math.floor(ms / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtMoneyLive(amount, currency = 'RUB') {
  try {
    return new Intl.NumberFormat('ru-RU', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${Math.round(amount * 100) / 100} ${currency}`;
  }
}

function calcEarned(timer, now = Date.now()) {
  const rate = timer?.rate || 0;
  if (!rate) return 0;
  return rate * (calcElapsedMs(timer, now) / 3600000);
}

function buildContent(timer, now = Date.now()) {
  const elapsed = fmtDuration(calcElapsedMs(timer, now));
  const title = timer.paused ? `⏸ ${elapsed}` : elapsed;
  const parts = [];
  if (timer.task) parts.push(timer.task);
  else if (timer.projectName) parts.push(timer.projectName);
  const earned = calcEarned(timer, now);
  if (earned > 0) parts.push(`+ ${fmtMoneyLive(earned, timer.currency || 'RUB')}`);
  return { title, body: parts.length ? parts.join(' · ') : 'TimeLog' };
}

function actionButtons(paused) {
  return paused
    ? [
        { title: 'Продолжить', id: BTN_RESUME },
        { title: 'Стоп', id: BTN_STOP },
      ]
    : [
        { title: 'Пауза', id: BTN_PAUSE },
        { title: 'Стоп', id: BTN_STOP },
      ];
}

async function ensureAndroidChannel() {
  if (channelReady) return;
  await ForegroundService.createNotificationChannel({
    id: CHANNEL_ID,
    name: 'Таймер работы',
    description: 'Время и наработка во время записи',
    importance: Importance.Low,
  });
  await ForegroundService.requestPermissions();
  channelReady = true;
}

async function ensureIosPermissions() {
  const { display } = await LocalNotifications.checkPermissions();
  if (display !== 'granted') {
    await LocalNotifications.requestPermissions();
  }
}

async function hideIosTimerNotification() {
  await LocalNotifications.cancel({ notifications: [{ id: TIMER_NOTIF_ID }] });
  try {
    await LocalNotifications.removeDeliveredNotifications({
      notifications: [{ id: TIMER_NOTIF_ID }],
    });
  } catch {
    // Older plugin versions may not support this on all platforms.
  }
}

async function showIosTimerNotification(timer) {
  if (!timer?.running) return;
  await ensureIosPermissions();
  await hideIosTimerNotification();
  const { title, body } = buildContent(timer);
  await LocalNotifications.schedule({
    notifications: [
      {
        id: TIMER_NOTIF_ID,
        title,
        body,
      },
    ],
  });
}

async function syncIosTimerNotification(force = false) {
  if (!nativeActive || !currentTimer?.running || iosAppActive) return;
  if (!force && iosLastPaused === currentTimer.paused) return;
  iosLastPaused = currentTimer.paused;
  await showIosTimerNotification(currentTimer);
}

export async function startNativeTimer(timer) {
  if (!isNativePlatform() || !timer?.running) return;
  nativeActive = true;
  currentTimer = timer;
  const { title, body } = buildContent(timer);

  if (Capacitor.getPlatform() === 'android') {
    await ensureAndroidChannel();
    await ForegroundService.startForegroundService({
      id: TIMER_NOTIF_ID,
      title,
      body,
      smallIcon: 'ic_stat_timelog',
      silent: true,
      notificationChannelId: CHANNEL_ID,
      serviceType: ANDROID_FGS_SPECIAL_USE,
      buttons: actionButtons(timer.paused),
    });
    return;
  }

  if (Capacitor.getPlatform() === 'ios') {
    iosLastPaused = timer.paused;
    if (!iosAppActive) await showIosTimerNotification(timer);
  }
}

export async function updateNativeTimer(timer) {
  if (!isNativePlatform() || !nativeActive || !timer?.running) return;
  currentTimer = timer;
  const { title, body } = buildContent(timer);

  if (Capacitor.getPlatform() === 'android') {
    await ForegroundService.updateForegroundService({
      id: TIMER_NOTIF_ID,
      title,
      body,
      smallIcon: 'ic_stat_timelog',
      silent: true,
      notificationChannelId: CHANNEL_ID,
      serviceType: ANDROID_FGS_SPECIAL_USE,
      buttons: actionButtons(timer.paused),
    });
    return;
  }

  if (Capacitor.getPlatform() === 'ios') {
    // iOS creates a new notification on every schedule() — tick updates must not schedule.
    return;
  }
}

export async function refreshIosTimerNotification(timer) {
  if (!isNativePlatform() || Capacitor.getPlatform() !== 'ios' || !nativeActive || !timer?.running) {
    return;
  }
  currentTimer = timer;
  await syncIosTimerNotification();
}

export async function stopNativeTimer() {
  if (!isNativePlatform()) return;
  nativeActive = false;
  currentTimer = null;
  iosLastPaused = null;

  if (Capacitor.getPlatform() === 'android') {
    await ForegroundService.stopForegroundService();
    return;
  }

  if (Capacitor.getPlatform() === 'ios') {
    await hideIosTimerNotification();
  }
}

export function initNativeTimer(onAction) {
  if (!isNativePlatform() || listenersBound) return;
  listenersBound = true;

  if (Capacitor.getPlatform() === 'android') {
    ForegroundService.addListener('buttonClicked', ({ buttonId }) => {
      if (buttonId === BTN_PAUSE) onAction('pause');
      else if (buttonId === BTN_RESUME) onAction('resume');
      else if (buttonId === BTN_STOP) onAction('stop');
    });
    ForegroundService.addListener('notificationTapped', () => {
      App.getLaunchUrl().catch(() => {});
    });
  }

  App.getState()
    .then(({ isActive }) => {
      iosAppActive = isActive;
    })
    .catch(() => {});

  App.addListener('appStateChange', ({ isActive }) => {
    iosAppActive = isActive;
    if (Capacitor.getPlatform() === 'ios' && nativeActive) {
      if (isActive) hideIosTimerNotification().catch(() => {});
      else syncIosTimerNotification(true).catch(() => {});
    }
    if (isActive && typeof onAction === 'function') {
      onAction('sync');
    }
  });
}
