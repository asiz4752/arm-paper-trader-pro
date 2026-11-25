// Central state: settings + trades, persisted to localStorage and mirrored to Firestore when connected.

import { DEFAULT_SETTINGS } from './constants.js';
import { CloudDB, isFirebaseConfigured } from './firebase-config.js';
import { deepMerge, setPath, debounce } from './utils.js';

const LS_SETTINGS = 'ptp.settings.v1';
const LS_TRADES = 'ptp.trades.v1';

/* ---------- tiny event bus ---------- */
const listeners = {};
export const on = (evt, fn) => ((listeners[evt] ||= []).push(fn), fn);
export const emit = (evt, detail) => (listeners[evt] || []).forEach((fn) => fn(detail));

const readLS = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
};
const writeLS = (key, val) => {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* quota / private mode */ }
};

export const cloud = new CloudDB();

export const store = {
  settings: deepMerge(DEFAULT_SETTINGS, readLS(LS_SETTINGS, {})),
  trades: readLS(LS_TRADES, []),
  prices: new Map(),          // instrument key -> last price
  cloud: { status: 'off', text: 'Local only' },
};

// Persist the first-run defaults so the generated workspace ID stays stable across reloads.
try {
  if (!localStorage.getItem(LS_SETTINGS)) writeLS(LS_SETTINGS, store.settings);
} catch { /* storage unavailable */ }

/* ---------- settings ---------- */
const syncSettingsToCloud = debounce(async () => {
  if (!cloud.ready) return;
  try {
    const { firebase, ...rest } = store.settings; // Firebase config itself can't live in the DB it unlocks
    const payload = structuredClone(rest);
    if (!store.settings.prefs.syncSecrets) payload.upstox = { clientId: payload.upstox.clientId };
    await cloud.saveSettings(payload);
  } catch (e) { console.warn('Settings sync failed', e); }
}, 800);

export function setSetting(path, value) {
  setPath(store.settings, path, value);
  store.settings.updatedAt = Date.now();
  writeLS(LS_SETTINGS, store.settings);
  syncSettingsToCloud();
  emit('settings:saved', { path, value });
}

/* ---------- trades ---------- */
const saveTradesLocal = () => writeLS(LS_TRADES, store.trades);

export async function upsertTrade(trade) {
  const i = store.trades.findIndex((t) => t.id === trade.id);
  if (i >= 0) store.trades[i] = trade; else store.trades.push(trade);
  saveTradesLocal();
  emit('trades');
  if (cloud.ready) {
    try { await cloud.saveTrade(trade); } catch (e) { setCloudStatus('error', 'Sync error: ' + e.message); }
  }
}

export async function removeTrade(id) {
  store.trades = store.trades.filter((t) => t.id !== id);
  saveTradesLocal();
  emit('trades');
  if (cloud.ready) {
    try { await cloud.deleteTrade(id); } catch (e) { setCloudStatus('error', 'Sync error: ' + e.message); }
  }
}

export function clearLocalData() {
  store.trades = [];
  saveTradesLocal();
  emit('trades');
}

/* ---------- cloud ---------- */
function setCloudStatus(status, text) {
  store.cloud = { status, text };
  emit('cloud:status', store.cloud);
}

let firstSnapshot = true;

export async function connectCloud() {
  const { firebase, prefs } = store.settings;
  if (!isFirebaseConfigured(firebase)) {
    cloud.teardown();
    setCloudStatus('off', 'Local only');
    return { ok: false, error: 'not configured' };
  }
  setCloudStatus('connecting', 'Connecting…');
  const res = await cloud.init(firebase, prefs.workspaceId);
  if (!res.ok) {
    setCloudStatus('error', res.error);
    return res;
  }
  firstSnapshot = true;

  // Settings: newest copy wins (Firebase config stays local).
  try {
    const remote = await cloud.loadSettings();
    if (remote && (remote.updatedAt || 0) > (store.settings.updatedAt || 0)) {
      store.settings = deepMerge(store.settings, { ...remote, firebase: store.settings.firebase });
      writeLS(LS_SETTINGS, store.settings);
      emit('settings:loaded');
    } else if (!remote) {
      syncSettingsToCloud();
    }
  } catch (e) { console.warn('Could not load cloud settings', e); }

  cloud.subscribeTrades(
    async (remoteTrades, meta) => {
      if (firstSnapshot && remoteTrades.length === 0 && store.trades.length && !meta.fromCache) {
        // Brand-new workspace: upload what we already have locally.
        try { await cloud.bulkSaveTrades(store.trades); } catch (e) { setCloudStatus('error', e.message); }
      } else if (!(firstSnapshot && meta.fromCache && remoteTrades.length === 0)) {
        store.trades = remoteTrades;
        saveTradesLocal();
        emit('trades');
      }
      if (!meta.fromCache) firstSnapshot = false;
      setCloudStatus('on', meta.fromCache ? 'Firestore (offline cache)' : 'Firestore synced');
    },
    (err) => setCloudStatus('error', err.code === 'permission-denied' ? 'Permission denied – check Firestore rules' : err.message),
  );
  return { ok: true };
}

export const saveSnapshot = (dateKey, data) => {
  if (cloud.ready) cloud.saveSnapshot(dateKey, data).catch(() => {});
};
