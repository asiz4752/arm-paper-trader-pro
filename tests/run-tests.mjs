// Run with:  node tests/run-tests.mjs   (or: npm test)
import assert from 'node:assert/strict';
import { legCharges, tradePnl, grossPnl, marginRequired, previewCharges } from '../js/brokerage-calc.js';
import { Simulator, simExpiries, simStrikes, blackScholes } from '../js/simulator.js';
import { parseFirebaseSnippet, isFirebaseConfigured } from '../js/firebase-config.js';
import { UpstoxClient, LiveFeed } from '../js/upstox-api.js';
import { DEFAULT_SETTINGS, TICKER_ITEMS } from '../js/constants.js';
import { shortExpiry, fmtINR, fmtSignedINR, round2, calendarDaysBetween } from '../js/utils.js';

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('  ok  ', name); }
  catch (e) { console.error('  FAIL', name, '\n      ', e.message); process.exitCode = 1; }
};
const near = (a, b, eps = 0.011) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

await test('delivery buy-leg charges', () => {
  const c = legCharges({ segment: 'delivery', exchange: 'NSE', side: 'BUY', price: 1000, qty: 10 });
  assert.equal(c.turnover, 10000);
  assert.equal(c.brokerage, 20);
  assert.equal(c.stt, 10);
  near(c.exchange, 0.3);
  assert.equal(c.stamp, 1.5);
  near(c.gst, 3.66);
  near(c.total, 35.47, 0.02);
});

await test('delivery brokerage capped at 2.5% for tiny orders', () => {
  const c = legCharges({ segment: 'delivery', side: 'BUY', price: 10, qty: 10 }); // Rs 100 -> 2.5% = 2.5
  assert.equal(c.brokerage, 2.5);
});

await test('delivery sell leg has STT but no stamp duty', () => {
  const c = legCharges({ segment: 'delivery', side: 'SELL', price: 1000, qty: 10 });
  assert.equal(c.stt, 10);
  assert.equal(c.stamp, 0);
});

await test('options sell-leg charges (STT 0.15% of premium)', () => {
  const c = legCharges({ segment: 'intraday', exchange: 'NSE', side: 'SELL', price: 100, qty: 65 });
  assert.equal(c.turnover, 6500);
  assert.equal(c.brokerage, 20);
  near(c.stt, 9.75);
  near(c.exchange, 2.28);
  assert.equal(c.stamp, 0);
  near(c.total, 36.05, 0.03);
});

await test('options buy leg: no STT, stamp duty applies', () => {
  const c = legCharges({ segment: 'intraday', exchange: 'BSE', side: 'BUY', price: 200, qty: 20 });
  assert.equal(c.stt, 0);
  near(c.stamp, 0.12);
  near(c.exchange, 1.3);
});

await test('long option P&L and net', () => {
  const t = { segment: 'intraday', side: 'BUY', entryPrice: 100, qty: 65, exchange: 'NSE', status: 'OPEN' };
  const p = tradePnl(t, 120);
  assert.equal(p.gross, 1300);
  near(p.net, 1300 - p.charges.total.total, 0.011);
  assert.ok(p.charges.exit.stt > 0 && p.charges.entry.stt === 0);
});

await test('short option P&L sign', () => {
  const t = { segment: 'intraday', side: 'SELL', entryPrice: 100, qty: 65, exchange: 'NSE', status: 'OPEN' };
  assert.equal(grossPnl(t, 80), 1300);
  assert.equal(grossPnl(t, 120), -1300);
  const p = tradePnl(t, 80);
  assert.ok(p.charges.entry.stt > 0 && p.charges.exit.stt === 0);
});

await test('closed trade ignores the live price', () => {
  const t = { segment: 'delivery', side: 'BUY', entryPrice: 100, qty: 10, status: 'CLOSED', exitPrice: 110 };
  assert.equal(tradePnl(t, 9999).gross, 100);
});

await test('margin requirement', () => {
  assert.equal(marginRequired({ segment: 'delivery', side: 'BUY', entryPrice: 50, qty: 10 }), 500);
  assert.equal(marginRequired({ segment: 'intraday', side: 'BUY', entryPrice: 100, qty: 65 }), 6500);
  assert.equal(marginRequired({ segment: 'intraday', side: 'SELL', entryPrice: 100, qty: 65, strike: 26000 }, 10), 169000);
});

await test('previewCharges round trip = entry + exit', () => {
  const p = previewCharges({ segment: 'intraday', exchange: 'NSE', side: 'BUY', price: 100, qty: 65 });
  near(p.roundTrip.total, p.entry.total + p.exit.total, 0.011);
});

await test('black-scholes sanity', () => {
  const call = blackScholes(26000, 26000, 7 / 365, 0.14, 'CE');
  const put = blackScholes(26000, 26000, 7 / 365, 0.14, 'PE');
  assert.ok(call > 100 && call < 400, `ATM call ${call}`);
  assert.ok(blackScholes(26000, 25000, 7 / 365, 0.14, 'CE') > call);
  assert.ok(Math.abs(call - put) < 200);
});

await test('simulator expiries & strikes', () => {
  const nifty = simExpiries('NIFTY', new Date('2026-11-25T05:00:00Z'));
  assert.equal(nifty[0], '2026-12-01'); // Tuesday
  assert.equal(nifty.length, 5);
  const sensex = simExpiries('SENSEX', new Date('2026-11-25T05:00:00Z'));
  assert.equal(sensex[0], '2026-11-26'); // Thursday
  const bn = simExpiries('BANKNIFTY', new Date('2026-11-25T05:00:00Z'));
  assert.equal(bn[0], '2026-11-24' >= '2026-11-25' ? '2026-11-24' : '2026-12-29'); // last Tuesday of Nov has passed
  const k = simStrikes('NIFTY', 26012);
  assert.equal(k.length, 51);
  assert.ok(k.includes(26000));
});

await test('simulator prices: index, equity, option, unknown key', () => {
  const sim = new Simulator();
  sim.tick();
  assert.ok(sim.ltp('NSE_INDEX|Nifty 50') > 20000);
  assert.ok(sim.ltp('SIM_EQ|RELIANCE') > 0);
  const exp = simExpiries('NIFTY')[0];
  const ce = sim.ltp(`SIM_OPT|NIFTY|${exp}|26000|CE`);
  const pe = sim.ltp(`SIM_OPT|NIFTY|${exp}|26000|PE`);
  assert.ok(ce >= 0.05 && pe >= 0.05);
  assert.equal(sim.ltp('NSE_FO|12345', 88), 88);
  sim.tick();
  assert.ok(sim.ltp('NSE_FO|12345', 88) > 0);
  const q = sim.quote('NSE_INDEX|India VIX');
  assert.ok(Number.isFinite(q.pct));
});

await test('firebase snippet parser', () => {
  const cfg = parseFirebaseSnippet(`const firebaseConfig = {
    apiKey: "AIzaXYZ", authDomain: "demo.firebaseapp.com", "projectId": 'demo',
    storageBucket: "demo.appspot.com", messagingSenderId: "123", appId: "1:123:web:abc" };`);
  assert.equal(cfg.apiKey, 'AIzaXYZ');
  assert.equal(cfg.projectId, 'demo');
  assert.equal(cfg.appId, '1:123:web:abc');
  assert.ok(isFirebaseConfigured(cfg));
  assert.ok(!isFirebaseConfigured({ apiKey: 'x' }));
});

await test('utils formatting', () => {
  assert.equal(shortExpiry('2026-12-01'), '01DEC26');
  assert.equal(fmtINR(-1234567.5), '-₹12,34,567.50');
  assert.equal(fmtSignedINR(250), '+₹250.00');
  assert.equal(round2(1.005 + 1e-9), 1.01);
});

await test('calendar holding days count calendar dates and handle invalid dates', () => {
  assert.equal(calendarDaysBetween('2026-11-25T10:00:00', '2026-11-25T23:00:00'), 0);
  assert.equal(calendarDaysBetween('2026-11-25T15:00:00', '2026-11-27T09:00:00'), 2);
  assert.equal(calendarDaysBetween('2026-11-27', '2026-11-25'), 0);
  assert.equal(calendarDaysBetween('invalid', '2026-11-25'), null);
});

await test('UpstoxClient (sim mode) lookups', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS); // simMode defaults to true
  const sim = new Simulator();
  const client = new UpstoxClient(() => settings, sim);
  assert.ok(client.isSim);
  const ex = await client.expiries('NIFTY');
  assert.ok(ex.length >= 4);
  const opt = await client.findOption('NIFTY', ex[0], 26000, 'CE');
  assert.equal(opt.key, `SIM_OPT|NIFTY|${ex[0]}|26000|CE`);
  assert.deepEqual(await client.resolveEquity('tcs'), { key: 'SIM_EQ|TCS', symbol: 'TCS' });
  assert.deepEqual(await client.resolveEquity('NSE_EQ|INE002A01018'), { key: 'NSE_EQ|INE002A01018', symbol: 'INE002A01018' });
  assert.ok((await client.searchEquity('rel')).some((m) => m.symbol === 'RELIANCE'));
  assert.ok((await client.strikes('BANKNIFTY', ex[0], 59000)).includes(59000));
});

await test('LiveFeed does not update dummy prices when live is off', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const sim = new Simulator();
  const client = new UpstoxClient(() => settings, sim);
  const got = { prices: null, quotes: null, status: null };
  const feed = new LiveFeed(client, {
    getKeys: () => new Map([['SIM_EQ|INFY', 1500], ['NSE_FO|999', 42.5]]),
    onPrices: (m) => (got.prices = m),
    onQuotes: (m) => (got.quotes = m),
    onStatus: (s) => (got.status = s),
  });
  await feed.poll();
  assert.equal(got.prices, null);
  assert.equal(got.quotes, null);
  assert.equal(got.status.mode, 'off');
});

await test('LiveFeed only publishes live prices when live is on', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.prefs.simMode = false;
  const sim = new Simulator();
  const client = new UpstoxClient(() => settings, sim);
  const tickerKey = TICKER_ITEMS[0].key;
  const equityKey = 'NSE_EQ|INE002A01018';
  client.quotes = async () => new Map([[tickerKey, { ltp: 26000, change: 0, pct: 0 }]]);
  client.ltp = async (keys) => {
    assert.deepEqual(keys, [equityKey]);
    return new Map([[equityKey, 1234]]);
  };
  const got = { prices: null, quotes: null, status: null };
  const feed = new LiveFeed(client, {
    getKeys: () => new Map([['SIM_EQ|INFY', 1500], [equityKey, 1200]]),
    onPrices: (m) => (got.prices = m),
    onQuotes: (m) => (got.quotes = m),
    onStatus: (s) => (got.status = s),
  });
  await feed.poll();
  assert.equal(got.prices.get(tickerKey), 26000);
  assert.equal(got.prices.get(equityKey), 1234);
  assert.equal(got.prices.has('SIM_EQ|INFY'), false);
  assert.equal(got.quotes.get(tickerKey).ltp, 26000);
  assert.equal(got.status.mode, 'live');
});

await test('LiveFeed stops price updates after 401 when auto-fallback is enabled', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.prefs.simMode = false;
  settings.upstox.accessToken = 'expired';
  const sim = new Simulator();
  const client = new UpstoxClient(() => settings, sim);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 401, ok: false, json: async () => ({}) });
  const notices = [];
  const got = { prices: null, quotes: null, status: null };
  const feed = new LiveFeed(client, {
    getKeys: () => new Map(),
    onPrices: (m) => (got.prices = m),
    onQuotes: (m) => (got.quotes = m),
    onStatus: (s) => (got.status = s),
    onNotice: (t, m) => notices.push(m),
  });
  try {
    await feed.poll();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(client.fallback, true);
  assert.ok(client.isSim);
  assert.ok(notices[0].includes('expired'));
  assert.equal(got.prices, null);
  assert.equal(got.quotes, null);
  assert.equal(got.status.mode, 'fallback');
});

await test('Upstox LTP response mapping', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.prefs.simMode = false;
  settings.upstox.accessToken = 'tok';
  const client = new UpstoxClient(() => settings, new Simulator());
  const realFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), auth: init.headers.Authorization };
    return { status: 200, ok: true, json: async () => ({ data: { 'NSE_EQ:RELIANCE': { last_price: 1234.5, instrument_token: 'NSE_EQ|INE002A01018' } } }) };
  };
  try {
    const m = await client.ltp(['NSE_EQ|INE002A01018']);
    assert.equal(m.get('NSE_EQ|INE002A01018'), 1234.5);
    assert.equal(seen.auth, 'Bearer tok');
    assert.ok(seen.url.startsWith('https://api.upstox.com/v2/market-quote/ltp?instrument_key='));
    settings.prefs.proxyUrl = 'https://x.vercel.app/api/upstox/';
    await client.ltp(['NSE_EQ|INE002A01018']);
    assert.ok(seen.url.startsWith('https://x.vercel.app/api/upstox?url=https%3A%2F%2Fapi.upstox.com'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
