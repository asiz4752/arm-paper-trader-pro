// Shared constants & default settings.

export const INDEX_KEYS = {
  NIFTY: 'NSE_INDEX|Nifty 50',
  BANKNIFTY: 'NSE_INDEX|Nifty Bank',
  SENSEX: 'BSE_INDEX|SENSEX',
  VIX: 'NSE_INDEX|India VIX',
};

export const TICKER_ITEMS = [
  { id: 'NIFTY', label: 'NIFTY 50', key: INDEX_KEYS.NIFTY },
  { id: 'BANKNIFTY', label: 'BANK NIFTY', key: INDEX_KEYS.BANKNIFTY },
  { id: 'SENSEX', label: 'SENSEX', key: INDEX_KEYS.SENSEX },
  { id: 'VIX', label: 'INDIA VIX', key: INDEX_KEYS.VIX },
];

// expiryDow: 0=Sun ... 6=Sat. weekly=false -> monthly (last <expiryDow> of the month).
// `lot` values are fallbacks; in live mode the lot size from the Upstox instrument file wins.
// They are editable in Settings because NSE/BSE revise lot sizes periodically.
export const INDEX_META = {
  NIFTY:     { key: INDEX_KEYS.NIFTY,     exchange: 'NSE', fo: 'NSE_FO', step: 50,  lot: 65, expiryDow: 2, weekly: true,  base: 26000 },
  BANKNIFTY: { key: INDEX_KEYS.BANKNIFTY, exchange: 'NSE', fo: 'NSE_FO', step: 100, lot: 30, expiryDow: 2, weekly: false, base: 59000 },
  SENSEX:    { key: INDEX_KEYS.SENSEX,    exchange: 'BSE', fo: 'BSE_FO', step: 100, lot: 20, expiryDow: 4, weekly: true,  base: 85000 },
};

// Simulation-mode reference prices (rough, for UI testing only).
export const POPULAR_STOCKS = {
  RELIANCE: 1450, TCS: 3200, HDFCBANK: 1000, INFY: 1550, ICICIBANK: 1400,
  SBIN: 950, ITC: 410, LT: 3700, BHARTIARTL: 2000, HINDUNILVR: 2400,
  AXISBANK: 1200, KOTAKBANK: 2100, WIPRO: 260, MARUTI: 15000, SUNPHARMA: 1700,
  TATAMOTORS: 700, TATASTEEL: 170, BAJFINANCE: 1000, ADANIENT: 2300, ASIANPAINT: 2400,
  ONGC: 250, NTPC: 340, POWERGRID: 290, COALINDIA: 400, TITAN: 3500,
};

// Random workspace ID generated once per browser (persisted on first load by store.js).
// Same ID on another device = same Firestore data. Also keeps the bundled Firestore rules satisfied (>= 12 chars).
const randomId = () =>
  'pt-' + (globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 20) ?? Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12));

export const DEFAULT_SETTINGS = {
  upstox: { accessToken: '', apiKey: '', apiSecret: '', clientId: '', redirectUri: '', authCode: '' },
  firebase: { apiKey: '', authDomain: '', projectId: '', storageBucket: '', messagingSenderId: '', appId: '' },
  capital: { intraday: 500000, delivery: 1000000 },
  prefs: {
    simMode: true,          // start in simulation so the app works out of the box
    autoFallback: true,     // switch to simulation automatically if Upstox rejects the token
    pollMs: 2000,           // live price refresh interval
    proxyUrl: '',           // optional CORS proxy (see /api/upstox.js)
    workspaceId: randomId(), // Firestore workspace (lets several devices share one data set)
    syncSecrets: true,      // also sync Upstox credentials to Firestore
    sound: true,
    autoSquareOff: false,
    squareOffTime: '15:20',
    shortMarginPct: 11,     // approx. margin for short options, % of strike x qty
  },
  lotSizes: { NIFTY: INDEX_META.NIFTY.lot, BANKNIFTY: INDEX_META.BANKNIFTY.lot, SENSEX: INDEX_META.SENSEX.lot },
  updatedAt: 0,
};
