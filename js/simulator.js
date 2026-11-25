// Market simulator: lets the whole app run when the market is closed or the Upstox token is missing/expired.
// Prices follow a random walk; option premiums are Black-Scholes values off the simulated index.

import { INDEX_META, INDEX_KEYS, POPULAR_STOCKS } from './constants.js';
import { istYMD } from './utils.js';

const gauss = () => {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// Abramowitz-Stegun normal CDF
const ncdf = (x) => {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
};

export function blackScholes(S, K, T, iv, type, r = 0.065) {
  if (T <= 0) return Math.max(0, type === 'CE' ? S - K : K - S);
  const d1 = (Math.log(S / K) + (r + (iv * iv) / 2) * T) / (iv * Math.sqrt(T));
  const d2 = d1 - iv * Math.sqrt(T);
  return type === 'CE'
    ? S * ncdf(d1) - K * Math.exp(-r * T) * ncdf(d2)
    : K * Math.exp(-r * T) * ncdf(-d2) - S * ncdf(-d1);
}

const roundTick = (p) => Math.max(0.05, Math.round(p / 0.05) * 0.05);

/** Upcoming expiry dates (YYYY-MM-DD, IST) for an index in simulation. */
export function simExpiries(name, from = new Date(), count = 5) {
  const meta = INDEX_META[name];
  const [y, m, d] = istYMD(from).split('-').map(Number);
  const out = [];
  if (meta.weekly) {
    const start = Date.UTC(y, m - 1, d);
    for (let i = 0; out.length < count && i < 80; i++) {
      const dt = new Date(start + i * 864e5);
      if (dt.getUTCDay() === meta.expiryDow) out.push(dt.toISOString().slice(0, 10));
    }
  } else {
    for (let mo = 0; out.length < count && mo < 12; mo++) {
      const last = new Date(Date.UTC(y, m - 1 + mo + 1, 0)); // last day of month
      while (last.getUTCDay() !== meta.expiryDow) last.setUTCDate(last.getUTCDate() - 1);
      const s = last.toISOString().slice(0, 10);
      if (s >= istYMD(from)) out.push(s);
    }
  }
  return out;
}

export function simStrikes(name, spot, span = 25) {
  const step = INDEX_META[name].step;
  const atm = Math.round(spot / step) * step;
  return Array.from({ length: span * 2 + 1 }, (_, i) => atm + (i - span) * step);
}

export class Simulator {
  constructor() {
    this.spot = Object.fromEntries(Object.entries(INDEX_META).map(([k, m]) => [k, m.base]));
    this.close = { ...this.spot };
    this.vix = 13.5;
    this.vixClose = 13.5;
    this.eq = new Map();       // symbol -> {price, close}
    this.generic = new Map();  // unknown keys (e.g. real Upstox keys used while in fallback) -> price
  }

  static eqBase(sym) {
    if (POPULAR_STOCKS[sym]) return POPULAR_STOCKS[sym];
    let h = 0;
    for (const c of sym) h = (h * 31 + c.charCodeAt(0)) % 100000;
    return 150 + (h % 2850);
  }

  tick() {
    for (const k of Object.keys(this.spot)) this.spot[k] *= 1 + gauss() * 0.00015;
    this.vix = Math.min(28, Math.max(9, this.vix + gauss() * 0.02));
    for (const e of this.eq.values()) e.price *= 1 + gauss() * 0.0003;
    for (const [k, p] of this.generic) this.generic.set(k, Math.max(0.05, p * (1 + gauss() * 0.0015)));
  }

  /** Make sure a key has a price series. `seed` is used for keys the simulator cannot derive itself. */
  seed(key, seed) {
    if (key.startsWith('SIM_EQ|')) {
      const sym = key.split('|')[1];
      if (!this.eq.has(sym)) {
        const b = Simulator.eqBase(sym);
        this.eq.set(sym, { price: b, close: b });
      }
    } else if (!this.isKnown(key) && !this.generic.has(key) && Number.isFinite(seed)) {
      this.generic.set(key, seed);
    }
  }

  isKnown(key) {
    return key.startsWith('SIM_') || Object.values(INDEX_KEYS).includes(key);
  }

  ltp(key, seed) {
    for (const [name, m] of Object.entries(INDEX_META)) if (m.key === key) return this.spot[name];
    if (key === INDEX_KEYS.VIX) return this.vix;
    if (key.startsWith('SIM_EQ|')) {
      this.seed(key);
      return this.eq.get(key.split('|')[1]).price;
    }
    if (key.startsWith('SIM_OPT|')) {
      const [, name, expiry, strike, type] = key.split('|');
      const S = this.spot[name];
      if (!S) return undefined;
      const T = Math.max((Date.parse(`${expiry}T15:30:00+05:30`) - Date.now()) / (365 * 864e5), 1 / (365 * 24));
      const iv = Math.max(0.08, this.vix / 100) * (name === 'SENSEX' ? 0.95 : 1);
      return roundTick(blackScholes(S, Number(strike), T, iv, type));
    }
    this.seed(key, seed);
    return this.generic.get(key);
  }

  /** Header ticker quote for an index key. */
  quote(key) {
    const ltp = this.ltp(key);
    let close = null;
    for (const [name, m] of Object.entries(INDEX_META)) if (m.key === key) close = this.close[name];
    if (key === INDEX_KEYS.VIX) close = this.vixClose;
    const change = ltp - close;
    return { ltp, change, pct: (change / close) * 100 };
  }
}

export const optionKey = (name, expiry, strike, type) => `SIM_OPT|${name}|${expiry}|${strike}|${type}`;
export const eqKey = (symbol) => `SIM_EQ|${symbol.toUpperCase()}`;
