// Firebase Firestore persistence (modular SDK v10, loaded lazily from the CDN).
//
// Data layout (one "workspace" per Workspace ID, so several devices can share the same data):
//   workspaces/{workspaceId}/trades/{tradeId}
//   workspaces/{workspaceId}/settings/main
//   workspaces/{workspaceId}/snapshots/{YYYY-MM-DD}

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';

export const REQUIRED = ['apiKey', 'projectId', 'appId'];

export const isFirebaseConfigured = (cfg) => REQUIRED.every((k) => cfg?.[k]?.trim?.());

/** Accepts JSON or the JS snippet Firebase shows ("const firebaseConfig = { apiKey: '...' }"). */
export function parseFirebaseSnippet(text) {
  const out = {};
  const re = /["']?(apiKey|authDomain|projectId|storageBucket|messagingSenderId|appId|measurementId)["']?\s*:\s*["']([^"']*)["']/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[2];
  return out;
}

const clean = (o) => JSON.parse(JSON.stringify(o));

export class CloudDB {
  constructor() {
    this.ready = false;
    this.fs = null;
    this.db = null;
    this.ws = 'default';
    this.unsubTrades = null;
    this.configKey = '';
  }

  /** Initialise (or re-initialise) the connection. Returns {ok, error?} */
  async init(config, workspaceId = 'default') {
    this.teardown();
    if (!isFirebaseConfigured(config)) return { ok: false, error: 'Firebase config incomplete (need apiKey, projectId, appId)' };
    try {
      const [{ initializeApp, getApps, deleteApp }, fs] = await Promise.all([
        import(`${SDK}/firebase-app.js`),
        import(`${SDK}/firebase-firestore.js`),
      ]);
      // Re-use / replace a previously created app so config edits take effect.
      for (const a of getApps()) await deleteApp(a).catch(() => {});
      const app = initializeApp({ ...config });
      this.fs = fs;
      this.db = fs.initializeFirestore(app, { ignoreUndefinedProperties: true });
      this.ws = (workspaceId || 'default').trim() || 'default';
      this.ready = true;
      return { ok: true };
    } catch (e) {
      this.ready = false;
      return { ok: false, error: e.message };
    }
  }

  teardown() {
    this.unsubTrades?.();
    this.unsubTrades = null;
    this.ready = false;
  }

  _col(name) { return this.fs.collection(this.db, 'workspaces', this.ws, name); }
  _doc(name, id) { return this.fs.doc(this.db, 'workspaces', this.ws, name, id); }

  /** Round-trip check used by the "Test Firebase" button. */
  async verify() {
    if (!this.ready) throw new Error('Not connected');
    await this.fs.setDoc(this._doc('settings', 'ping'), { at: Date.now() });
    const snap = await this.fs.getDoc(this._doc('settings', 'ping'));
    if (!snap.exists()) throw new Error('Write succeeded but read-back failed');
    return true;
  }

  /** Live subscription to all trades. cb(tradesArray, {fromCache}) */
  subscribeTrades(cb, onError) {
    this.unsubTrades?.();
    this.unsubTrades = this.fs.onSnapshot(
      this._col('trades'),
      (snap) => cb(snap.docs.map((d) => d.data()), { fromCache: snap.metadata.fromCache }),
      (err) => onError?.(err),
    );
    return this.unsubTrades;
  }

  saveTrade(trade) { return this.fs.setDoc(this._doc('trades', trade.id), clean(trade)); }
  deleteTrade(id) { return this.fs.deleteDoc(this._doc('trades', id)); }

  saveSettings(obj) { return this.fs.setDoc(this._doc('settings', 'main'), clean(obj)); }
  async loadSettings() {
    const snap = await this.fs.getDoc(this._doc('settings', 'main'));
    return snap.exists() ? snap.data() : null;
  }

  saveSnapshot(dateKey, data) {
    return this.fs.setDoc(this._doc('snapshots', dateKey), clean({ ...data, at: Date.now() }), { merge: true });
  }

  async bulkSaveTrades(trades) {
    for (let i = 0; i < trades.length; i += 400) {
      const batch = this.fs.writeBatch(this.db);
      trades.slice(i, i + 400).forEach((t) => batch.set(this._doc('trades', t.id), clean(t)));
      await batch.commit();
    }
  }
}
