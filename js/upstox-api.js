// Upstox integration: REST quotes, instrument lookup, token exchange and the price feed loop.
//
// Live prices are pulled with the REST market-quote endpoints on a short interval. This keeps the app
// a pure static site (no protobuf decoding needed). A WebSocket v3 feed can replace LiveFeed later.

import { INDEX_META, TICKER_ITEMS, POPULAR_STOCKS } from './constants.js';
import { Simulator, simExpiries, simStrikes, optionKey, eqKey } from './simulator.js';
import { istYMD } from './utils.js';

const API = 'https://api.upstox.com';
const ASSETS = 'https://assets.upstox.com/market-quote/instruments/exchange';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/* ---------- tiny IndexedDB cache for the big instrument files ---------- */
const idb = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('ptp-cache', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async get(key) {
    try {
      const db = await this.open();
      return await new Promise((res) => {
        const q = db.transaction('kv').objectStore('kv').get(key);
        q.onsuccess = () => res(q.result);
        q.onerror = () => res(undefined);
      });
    } catch { return undefined; }
  },
  async set(key, val) {
    try {
      const db = await this.open();
      await new Promise((res) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(val, key);
        tx.oncomplete = res;
        tx.onerror = res;
      });
    } catch { /* cache is optional */ }
  },
};

async function gunzipToJson(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0x1f && u8[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }
  return JSON.parse(new TextDecoder().decode(u8));
}

export class UpstoxClient {
  /** @param {() => object} getSettings  @param {Simulator} sim */
  constructor(getSettings, sim) {
    this.getSettings = getSettings;
    this.sim = sim;
    this.fallback = false;          // runtime fallback after an auth failure
    this.instruments = { NSE: null, BSE: null };
    this.loading = {};
  }

  get isSim() {
    return this.getSettings().prefs.simMode || this.fallback;
  }

  /* ---------- low level ---------- */
  async _fetch(url, { binary = false, auth = true, method = 'GET', body, headers = {} } = {}) {
    const s = this.getSettings();
    const proxy = s.prefs.proxyUrl?.trim();
    const target = proxy ? `${proxy.replace(/\/$/, '')}?url=${encodeURIComponent(url)}` : url;
    const h = { Accept: binary ? '*/*' : 'application/json', ...headers };
    if (auth) {
      if (!s.upstox.accessToken) throw new ApiError('No Upstox access token set', 401);
      h.Authorization = `Bearer ${s.upstox.accessToken.trim()}`;
    }
    let res;
    try {
      res = await fetch(target, { method, headers: h, body });
    } catch (e) {
      throw new ApiError(
        'Network/CORS error talking to Upstox. Deploy the included proxy (api/upstox.js) and set its URL in Settings.',
        0,
      );
    }
    if (res.status === 401) throw new ApiError('Upstox token is invalid or expired', 401);
    if (!res.ok) {
      let msg = `Upstox HTTP ${res.status}`;
      try { msg += ': ' + ((await res.json())?.errors?.[0]?.message || ''); } catch { /* ignore */ }
      throw new ApiError(msg, res.status);
    }
    return binary ? res.arrayBuffer() : res.json();
  }

  async profile() {
    return (await this._fetch(`${API}/v2/user/profile`)).data;
  }

  /** key -> last price for any set of instrument keys. */
  async ltp(keys) {
    const out = new Map();
    for (const part of chunk(keys, 100)) {
      const j = await this._fetch(`${API}/v2/market-quote/ltp?instrument_key=${encodeURIComponent(part.join(','))}`);
      for (const v of Object.values(j.data || {})) if (v?.instrument_token) out.set(v.instrument_token, Number(v.last_price));
    }
    return out;
  }

  /** key -> {ltp, change, pct} used by the header ticker. */
  async quotes(keys) {
    const out = new Map();
    const j = await this._fetch(`${API}/v2/market-quote/quotes?instrument_key=${encodeURIComponent(keys.join(','))}`);
    for (const v of Object.values(j.data || {})) {
      if (!v?.instrument_token) continue;
      const ltp = Number(v.last_price);
      const change = Number(v.net_change ?? 0);
      const prev = ltp - change;
      out.set(v.instrument_token, { ltp, change, pct: prev ? (change / prev) * 100 : 0 });
    }
    return out;
  }

  /** Exchange the OAuth auth-code for an access token (needs a proxy in most browsers). */
  async exchangeCode() {
    const { upstox } = this.getSettings();
    const body = new URLSearchParams({
      code: upstox.authCode.trim(),
      client_id: upstox.apiKey.trim(),
      client_secret: upstox.apiSecret.trim(),
      redirect_uri: upstox.redirectUri.trim(),
      grant_type: 'authorization_code',
    });
    const j = await this._fetch(`${API}/v2/login/authorization/token`, {
      auth: false,
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return j.access_token;
  }

  loginUrl() {
    const { upstox } = this.getSettings();
    const q = new URLSearchParams({ client_id: upstox.apiKey.trim(), redirect_uri: upstox.redirectUri.trim(), response_type: 'code' });
    return `${API}/v2/login/authorization/dialog?${q}`;
  }

  /* ---------- instruments (live mode) ---------- */
  async loadInstruments(exch) {
    if (this.instruments[exch]) return this.instruments[exch];
    if (this.loading[exch]) return this.loading[exch];
    this.loading[exch] = (async () => {
      const cacheKey = `inst-${exch}-${istYMD()}`;
      let reduced = await idb.get(cacheKey);
      if (!reduced) {
        const buf = await this._fetch(`${ASSETS}/${exch}.json.gz`, { binary: true, auth: false });
        const raw = await gunzipToJson(buf);
        const now = Date.now() - 864e5;
        const horizon = Date.now() + 130 * 864e5;
        const underlyings = new Set(Object.keys(INDEX_META).filter((n) => INDEX_META[n].exchange === exch));
        reduced = { eq: [], opt: [] };
        for (const i of raw) {
          if (exch === 'NSE' && i.segment === 'NSE_EQ' && i.instrument_type === 'EQ') {
            reduced.eq.push({ k: i.instrument_key, s: i.trading_symbol, n: i.name });
          } else if (
            (i.segment === 'NSE_FO' || i.segment === 'BSE_FO') &&
            (i.instrument_type === 'CE' || i.instrument_type === 'PE') &&
            underlyings.has(i.underlying_symbol) &&
            i.expiry >= now && i.expiry <= horizon
          ) {
            reduced.opt.push({
              k: i.instrument_key, u: i.underlying_symbol, e: istYMD(new Date(i.expiry)),
              st: Number(i.strike_price), t: i.instrument_type, l: Number(i.lot_size), ts: i.trading_symbol,
            });
          }
        }
        await idb.set(cacheKey, reduced);
      }
      this.instruments[exch] = reduced;
      return reduced;
    })();
    try { return await this.loading[exch]; } finally { delete this.loading[exch]; }
  }

  /* ---------- symbol / contract lookups (work in both modes) ---------- */
  async searchEquity(q) {
    q = q.trim().toUpperCase();
    if (!q) return [];
    if (this.isSim) {
      return Object.keys(POPULAR_STOCKS).filter((s) => s.includes(q)).slice(0, 8).map((s) => ({ key: eqKey(s), symbol: s, name: s }));
    }
    const { eq } = await this.loadInstruments('NSE');
    const starts = [], has = [];
    for (const i of eq) {
      const s = i.s.toUpperCase();
      if (s.startsWith(q)) starts.push(i); else if (s.includes(q) || (i.n || '').toUpperCase().includes(q)) has.push(i);
      if (starts.length >= 8) break;
    }
    return [...starts, ...has].slice(0, 8).map((i) => ({ key: i.k, symbol: i.s, name: i.n }));
  }

  /** Accepts "RELIANCE", "NSE_EQ|INE002A01018" or a SIM key. */
  async resolveEquity(input) {
    const v = input.trim();
    if (!v) return null;
    if (v.includes('|')) return { key: v, symbol: v.split('|')[1] };
    if (this.isSim) return { key: eqKey(v), symbol: v.toUpperCase() };
    const { eq } = await this.loadInstruments('NSE');
    const hit = eq.find((i) => i.s.toUpperCase() === v.toUpperCase());
    return hit ? { key: hit.k, symbol: hit.s } : null;
  }

  async expiries(name) {
    if (this.isSim) return simExpiries(name);
    const { opt } = await this.loadInstruments(INDEX_META[name].exchange);
    return [...new Set(opt.filter((o) => o.u === name).map((o) => o.e))].sort();
  }

  async strikes(name, expiry, spot) {
    if (this.isSim) return simStrikes(name, spot || INDEX_META[name].base);
    const { opt } = await this.loadInstruments(INDEX_META[name].exchange);
    return [...new Set(opt.filter((o) => o.u === name && o.e === expiry).map((o) => o.st))].sort((a, b) => a - b);
  }

  /** -> {key, symbol, lotSize} or null */
  async findOption(name, expiry, strike, type) {
    if (this.isSim) return { key: optionKey(name, expiry, strike, type), lotSize: null };
    const { opt } = await this.loadInstruments(INDEX_META[name].exchange);
    const hit = opt.find((o) => o.u === name && o.e === expiry && o.st === Number(strike) && o.t === type);
    return hit ? { key: hit.k, tradingSymbol: hit.ts, lotSize: hit.l } : null;
  }
}

/* ---------- price feed loop ---------- */
export class LiveFeed {
  /**
   * @param {UpstoxClient} client
   * @param {{getKeys:()=>Map<string,number>, onPrices:(m:Map)=>void, onQuotes:(m:Map)=>void, onStatus:(s:object)=>void}} h
   */
  constructor(client, sim, h) {
    this.client = client;
    this.sim = sim;
    this.h = h;
    this.timer = null;
    this.busy = false;
    this.lastError = '';
  }

  start() {
    this.stop();
    const loop = async () => {
      await this.poll();
      const ms = Math.max(1000, Number(this.client.getSettings().prefs.pollMs) || 2000);
      this.timer = setTimeout(loop, ms);
    };
    loop();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const wanted = this.h.getKeys(); // Map key -> seed price
      const prices = new Map();
      const quotes = new Map();
      const tickerKeys = TICKER_ITEMS.map((t) => t.key);
      const simulated = [];
      const live = [];
      for (const [k, seed] of wanted) {
        if (this.client.isSim || k.startsWith('SIM_')) simulated.push([k, seed]); else live.push(k);
      }

      const needSim = this.client.isSim || simulated.length;
      if (needSim) this.sim.tick();
      for (const [k, seed] of simulated) {
        const p = this.sim.ltp(k, seed);
        if (Number.isFinite(p)) prices.set(k, p);
      }

      if (this.client.isSim) {
        tickerKeys.forEach((k) => quotes.set(k, this.sim.quote(k)));
        this.status('sim', this.client.fallback ? 'Simulation (fallback)' : 'Simulation');
      } else {
        try {
          const liveQuotes = await this.client.quotes(tickerKeys);
          liveQuotes.forEach((v, k) => { quotes.set(k, v); prices.set(k, v.ltp); });
          const rest = live.filter((k) => !liveQuotes.has(k));
          if (rest.length) (await this.client.ltp(rest)).forEach((v, k) => prices.set(k, v));
          this.lastError = '';
          this.status('live', 'Live');
        } catch (e) {
          this.lastError = e.message;
          const s = this.client.getSettings();
          if (e.status === 401 && s.prefs.autoFallback) {
            this.client.fallback = true;
            this.h.onNotice?.('warn', `${e.message}. Switched to simulation mode.`);
            this.status('sim', 'Simulation (fallback)');
          } else {
            this.status('error', e.message);
          }
        }
      }
      if (prices.size) this.h.onPrices(prices);
      if (quotes.size) this.h.onQuotes(quotes);
    } finally {
      this.busy = false;
    }
  }

  status(mode, text) {
    this.h.onStatus({ mode, text, error: this.lastError });
  }
}

export { Simulator };
