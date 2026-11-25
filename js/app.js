// ARM Paper Trader Pro – application entry point.

import { $, $$, esc, fmtINR, fmtNum, fmtSignedINR, fmtDate, fmtDateTime, pnlClass, round2,
  istParts, isMarketOpen, todayISO, toLocalInput, download, csvCell, debounce, calendarDaysBetween } from './utils.js';
import { TICKER_ITEMS, INDEX_META } from './constants.js';
import { store, on, emit, setSetting, upsertTrade, removeTrade, connectCloud, saveSnapshot, cloud } from './store.js';
import { Simulator, UpstoxClient, LiveFeed } from './upstox-api.js';
import { tradePnl, marginRequired } from './brokerage-calc.js';
import { initModals, openModal, closeModal, toast, beep } from './ui.js';
import { initSettingsUI } from './settings-ui.js';
import { initOrderUI, modalKeys } from './order-ui.js';

const sim = new Simulator();
const client = new UpstoxClient(() => store.settings, sim);

const MAIN_TABS = ['intraday', 'delivery', 'analytics'];
const LAST_TAB_KEY = 'ptp.lastTab.v1';
function readLastTab() {
  try {
    const tab = localStorage.getItem(LAST_TAB_KEY);
    return MAIN_TABS.includes(tab) ? tab : 'intraday';
  } catch {
    return 'intraday';
  }
}

const view = { tab: readLastTab(), sub: { intraday: 'open', delivery: 'open' }, filter: 'all' };

/* =====================================================================
 * Derived values
 * ===================================================================== */
const livePrice = (t) => (t.status === 'CLOSED' ? t.exitPrice : store.prices.get(t.instrumentKey) ?? t.entryPrice);
const pnlOf = (t) => tradePnl(t, livePrice(t));
const openTrades = (seg) => store.trades.filter((t) => t.segment === seg && t.status === 'OPEN');
const closedTrades = (seg) => store.trades.filter((t) => (!seg || t.segment === seg) && t.status === 'CLOSED');
const byEntryDesc = (a, b) => new Date(b.entryTime) - new Date(a.entryTime);
const byExitDesc = (a, b) => new Date(b.exitTime) - new Date(a.exitTime);

function computeTotals() {
  const pct = store.settings.prefs.shortMarginPct;
  const mk = () => ({ real: 0, unreal: 0, blocked: 0, invested: 0, current: 0 });
  const T = { intraday: mk(), delivery: mk() };
  for (const t of store.trades) {
    const seg = T[t.segment];
    if (!seg) continue;
    const p = pnlOf(t);
    if (t.status === 'CLOSED') {
      seg.real += p.net;
    } else {
      seg.unreal += p.net;
      seg.blocked += marginRequired(t, pct);
      seg.invested += t.entryPrice * t.qty;
      seg.current += p.mark * t.qty;
    }
  }
  const cap = store.settings.capital;
  T.intraday.available = cap.intraday - T.intraday.blocked + T.intraday.real;
  T.delivery.available = cap.delivery - T.delivery.blocked + T.delivery.real;
  return T;
}

const getAvailable = (seg) => computeTotals()[seg].available;

/* =====================================================================
 * Summary cards + header
 * ===================================================================== */
function setPnl(id, value) {
  const el = $('#' + id);
  el.textContent = fmtSignedINR(value);
  el.className = el.className.replace(/\b(pos|neg|flat)\b/g, '').trim() + ' ' + pnlClass(value);
}

function updateSummary() {
  const T = computeTotals();
  const i = T.intraday, d = T.delivery;
  setPnl('sum-total', i.real + i.unreal + d.real + d.unreal);
  $('#sum-total-real').textContent = fmtSignedINR(i.real + d.real);
  $('#sum-total-unreal').textContent = fmtSignedINR(i.unreal + d.unreal);
  setPnl('sum-intra', i.real + i.unreal);
  $('#sum-intra-margin').textContent = fmtINR(i.available, 0);
  $('#sum-intra-blocked').textContent = fmtINR(i.blocked, 0);
  setPnl('sum-deliv', d.real + d.unreal);
  $('#sum-deliv-inv').textContent = fmtINR(d.invested, 0);
  $('#sum-deliv-cur').textContent = fmtINR(d.current, 0);
  return T;
}

function setPill(id, state, text, title) {
  const el = $('#' + id);
  el.dataset.state = state;
  el.querySelector('span').textContent = text;
  if (title) el.title = title;
}

function updateMarketPill() {
  const open = isMarketOpen();
  setPill('pill-market', open ? 'ok' : 'warn', open ? 'Market open' : 'Market closed');
}

/* ---------- ticker ---------- */
function buildTicker() {
  $('#ticker').innerHTML = TICKER_ITEMS.map((t) => `
    <div class="tick" data-id="${t.id}">
      <span class="tick-name">${t.label}</span>
      <span class="tick-val num" data-f="v">–</span>
      <span class="tick-chg num" data-f="c">–</span>
    </div>`).join('');
}

function flash(el, up) {
  el.classList.remove('flash-up', 'flash-down');
  void el.offsetWidth; // restart the animation
  el.classList.add(up ? 'flash-up' : 'flash-down');
}

function updateTicker(quotes) {
  for (const t of TICKER_ITEMS) {
    const q = quotes.get(t.key);
    if (!q) continue;
    const row = $(`.tick[data-id="${t.id}"]`);
    const v = row.querySelector('[data-f="v"]');
    const c = row.querySelector('[data-f="c"]');
    const prev = Number(v.dataset.v);
    v.textContent = fmtNum(q.ltp);
    if (prev && prev !== q.ltp) flash(v, q.ltp > prev);
    v.dataset.v = q.ltp;
    const sign = q.change >= 0 ? '+' : '';
    c.textContent = `${sign}${fmtNum(q.change)} (${sign}${q.pct.toFixed(2)}%)`;
    c.className = 'tick-chg num ' + pnlClass(q.change);
  }
}

/* =====================================================================
 * Tables
 * ===================================================================== */
const HEAD = (closed, includeHoldingDays = false) => `
  <thead><tr>
    <th>Symbol / Contract</th><th>Trade date</th><th>Qty</th><th>Buy / Entry price</th>
    <th>${closed ? 'Exit price' : 'Current price (LTP)'}</th><th>Gross P&amp;L</th><th>Brokerage &amp; taxes</th>
    <th>Net P&amp;L</th>${includeHoldingDays ? '<th>Days Held</th>' : ''}<th class="act">Actions</th>
  </tr></thead>`;

function chargesTitle(c) {
  const f = (n) => '₹' + fmtNum(n);
  const t = c.total;
  return [
    `Entry leg: ${f(c.entry.total)}   Exit leg: ${f(c.exit.total)}`,
    `Brokerage: ${f(t.brokerage)}`, `STT: ${f(t.stt)}`, `Exchange txn: ${f(t.exchange)}`,
    `SEBI fee: ${f(t.sebi)}`, `Stamp duty: ${f(t.stamp)}`, `GST (18%): ${f(t.gst)}`,
  ].join('\n');
}

function symbolCell(t, journal) {
  if (t.segment === 'intraday') {
    return `<span class="sym">${esc(t.index)} ${t.strike}</span>
      <span class="badge ${t.optType.toLowerCase()}">${t.optType}</span><span class="badge ${t.side.toLowerCase()}">${t.side}</span>
      <span class="sym-sub">${esc(t.symbol)}${journal ? ' · Intraday' : ''}${t.status === 'CLOSED' && t.exitReason ? ` <span class="badge reason ${esc(t.exitReason)}">${esc(t.exitReason)}</span>` : ''}</span>`;
  }
  return `<span class="sym">${esc(t.symbol)}</span><span class="badge buy">BUY</span>
    <span class="sym-sub">${journal ? 'Delivery · ' : ''}${esc(t.instrumentKey)}${t.status === 'CLOSED' && t.exitReason ? ` <span class="badge reason ${esc(t.exitReason)}">${esc(t.exitReason)}</span>` : ''}</span>`;
}

function rowHtml(t, journal = false, includeHoldingDays = false) {
  const p = pnlOf(t);
  const closed = t.status === 'CLOSED';
  const cls = pnlClass(p.net);
  const when = t.segment === 'delivery' ? fmtDate(t.entryTime) : fmtDateTime(t.entryTime);
  const heldDays = includeHoldingDays ? calendarDaysBetween(t.entryTime, closed ? t.exitTime : new Date()) : null;
  const hasMark = closed || store.prices.has(t.instrumentKey);
  const lots = t.lots ? `<span class="sym-sub">${t.lots} lot${t.lots > 1 ? 's' : ''} × ${t.lotSize || '?'}</span>` : '';
  const exitSub = closed ? `<span class="sym-sub">${fmtDateTime(t.exitTime)}</span>` : '';
  return `<tr data-id="${t.id}">
    <td>${symbolCell(t, journal)}</td>
    <td class="num">${when}</td>
    <td class="num">${fmtNum(t.qty, 0)}${lots}</td>
    <td class="num"><span class="editable" data-edit="entry" title="Double-click to edit">${fmtNum(t.entryPrice)}</span></td>
    <td class="num" data-f="ltp">${hasMark ? fmtNum(p.mark) : '–'}${exitSub}</td>
    <td class="num ${pnlClass(p.gross)}" data-f="gross">${fmtSignedINR(p.gross)}</td>
    <td class="num"><span class="charges" data-f="charges" title="${esc(chargesTitle(p.charges))}">${fmtINR(p.charges.total.total)}</span></td>
    <td class="num ${cls}" data-f="net"><b>${fmtSignedINR(p.net)}</b></td>
    ${includeHoldingDays ? `<td class="num" data-f="held-days">${heldDays ?? '–'}</td>` : ''}
    <td class="act"><span class="act-group">
      ${closed ? '' : '<button class="act-btn exit" data-act="exit">Exit</button>'}
      <button class="act-btn" data-act="edit">Edit</button>
      <button class="act-btn del" data-act="del">Delete</button>
    </span></td>
  </tr>`;
}

function footHtml(seg) {
  return `<tfoot><tr>
    <td colspan="3">Total (${seg === 'intraday' ? 'open positions' : 'holdings'})</td>
    <td class="num" data-f="t-entry-value">–</td><td class="num" data-f="t-current-value">–</td>
    <td class="num" data-f="t-gross">–</td><td class="num" data-f="t-charges">–</td><td class="num" data-f="t-net">–</td>
    ${seg === 'delivery' ? '<td class="num" data-f="t-held-days">–</td>' : ''}<td></td>
  </tr></tfoot>`;
}

function renderSegmentTable(seg) {
  const table = $(`#table-${seg}`);
  const closed = view.sub[seg] === 'closed';
  const list = (closed ? closedTrades(seg).sort(byExitDesc) : openTrades(seg).sort(byEntryDesc));
  const emptyMsg = closed ? 'No closed trades yet.' : seg === 'intraday' ? 'No open positions. Tap “+ New Trade” to place a paper options trade.' : 'No holdings. Tap “+ New Trade” and choose Delivery to buy shares.';
  table.dataset.mode = closed ? 'closed' : 'open';
  const includeHoldingDays = seg === 'delivery';
  const colCount = includeHoldingDays ? 10 : 9;
  table.innerHTML = HEAD(closed, includeHoldingDays) +
    `<tbody>${list.length ? list.map((t) => rowHtml(t, false, includeHoldingDays)).join('') : `<tr><td colspan="${colCount}" class="empty">${emptyMsg}</td></tr>`}</tbody>` +
    (closed || !list.length ? '' : footHtml(seg));
  $$(`[data-count="${seg}-open"]`).forEach((e) => (e.textContent = openTrades(seg).length));
  $$(`[data-count="${seg}-closed"]`).forEach((e) => (e.textContent = closedTrades(seg).length));
  updateFooter(seg);
}

function updateFooter(seg) {
  const table = $(`#table-${seg}`);
  if (table.dataset.mode !== 'open') return;
  let entryValue = 0, currentValue = 0, g = 0, c = 0, n = 0;
  let hasAllCurrentPrices = true;
  let heldDays = 0;
  openTrades(seg).forEach((t) => {
    const p = pnlOf(t);
    g += p.gross; c += p.charges.total.total; n += p.net;
    entryValue += t.entryPrice * t.qty;
    const mark = store.prices.get(t.instrumentKey);
    if (Number.isFinite(mark)) currentValue += mark * t.qty;
    else hasAllCurrentPrices = false;
    if (seg === 'delivery') heldDays += calendarDaysBetween(t.entryTime, new Date()) ?? 0;
  });
  const set = (f, v, signed) => {
    const el = table.querySelector(`[data-f="${f}"]`);
    if (!el) return;
    el.textContent = signed ? fmtSignedINR(v) : fmtINR(v);
    if (signed) el.className = 'num ' + pnlClass(v);
  };
  set('t-entry-value', entryValue, false);
  const currentValueCell = table.querySelector('[data-f="t-current-value"]');
  if (currentValueCell) currentValueCell.textContent = hasAllCurrentPrices ? fmtINR(currentValue) : '–';
  set('t-gross', g, true); set('t-charges', c, false); set('t-net', n, true);
  const daysCell = table.querySelector('[data-f="t-held-days"]');
  if (daysCell) daysCell.textContent = fmtNum(heldDays, 0);
}

/** Cheap in-place refresh of live cells (keeps flash animations and open inputs intact). */
function updateLiveCells() {
  for (const seg of ['intraday', 'delivery']) {
    const table = $(`#table-${seg}`);
    if (table.dataset.mode !== 'open') continue;
    $$('tbody tr[data-id]', table).forEach((tr) => {
      const t = store.trades.find((x) => x.id === tr.dataset.id);
      if (!t) return;
      const p = pnlOf(t);
      const ltpEl = tr.querySelector('[data-f="ltp"]');
      const prev = Number(ltpEl.dataset.v);
      const hasMark = t.status === 'CLOSED' || store.prices.has(t.instrumentKey);
      ltpEl.textContent = hasMark ? fmtNum(p.mark) : '–';
      if (hasMark && prev && prev !== p.mark) flash(ltpEl, p.mark > prev);
      if (hasMark) ltpEl.dataset.v = p.mark;
      else delete ltpEl.dataset.v;
      const gross = tr.querySelector('[data-f="gross"]');
      gross.textContent = fmtSignedINR(p.gross);
      gross.className = 'num ' + pnlClass(p.gross);
      const ch = tr.querySelector('[data-f="charges"]');
      ch.textContent = fmtINR(p.charges.total.total);
      ch.title = chargesTitle(p.charges);
      const net = tr.querySelector('[data-f="net"]');
      net.innerHTML = `<b>${fmtSignedINR(p.net)}</b>`;
      net.className = 'num ' + pnlClass(p.net);
      if (seg === 'delivery') {
        const heldDays = calendarDaysBetween(t.entryTime, t.status === 'CLOSED' ? t.exitTime : new Date());
        const days = tr.querySelector('[data-f="held-days"]');
        if (days) days.textContent = heldDays ?? '–';
      }
    });
    updateFooter(seg);
  }
}

let renderPending = false;
function renderAll() {
  if (document.activeElement?.classList?.contains('inline-input')) {
    if (!renderPending) {
      renderPending = true;
      setTimeout(() => ((renderPending = false), renderAll()), 600);
    }
    return;
  }
  renderSegmentTable('intraday');
  renderSegmentTable('delivery');
  if (view.tab === 'analytics') renderAnalytics();
  updateSummary();
}

/* =====================================================================
 * Table actions: exit / edit / delete / inline edit
 * ===================================================================== */
async function exitTrade(t, price, reason = 'MANUAL') {
  const closed = {
    ...t, status: 'CLOSED', exitPrice: round2(price), exitTime: new Date().toISOString(), exitReason: reason,
  };
  await upsertTrade(closed);
  const p = tradePnl(closed);
  return { closed, p };
}

async function manualExit(t) {
  const has = store.prices.has(t.instrumentKey);
  const price = livePrice(t);
  const msg = `Square off ${t.symbol} × ${t.qty} at ₹${fmtNum(price)}?` + (has ? '' : '\n\nNo live price received yet – the entry price will be used.');
  if (!confirm(msg)) return;
  const { p } = await exitTrade(t, price, 'MANUAL');
  toast(p.net >= 0 ? 'success' : 'warn', 'Position closed', `${t.symbol}: net ${fmtSignedINR(p.net)}`);
}

function openEdit(t) {
  const m = $('#edit-modal');
  m.dataset.id = t.id;
  $('#edit-title').textContent = `Edit ${t.symbol}`;
  $('#e-entry').value = t.entryPrice;
  $('#e-qty').value = t.qty;
  $('#e-target').value = t.target ?? '';
  $('#e-sl').value = t.sl ?? '';
  $('#e-time').value = toLocalInput(new Date(t.entryTime));
  $('#e-notes').value = t.notes || '';
  $('#e-exit-wrap').classList.toggle('hidden', t.status !== 'CLOSED');
  $('#e-exit').value = t.exitPrice ?? '';
  openModal(m);
}

$('#edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const t = store.trades.find((x) => x.id === $('#edit-modal').dataset.id);
  if (!t) return closeModal('edit-modal');
  const n = (s) => (($(s).value ?? '') === '' ? null : Number(($(s).value)));
  const entry = n('#e-entry'), qty = n('#e-qty');
  if (!(entry > 0) || !(qty >= 1)) return toast('error', 'Invalid values', 'Entry price and quantity must be positive.');
  const upd = {
    ...t, entryPrice: round2(entry), qty: Math.round(qty), target: n('#e-target') || null, sl: n('#e-sl') || null,
    notes: $('#e-notes').value.trim(),
  };
  if ($('#e-time').value) upd.entryTime = new Date($('#e-time').value).toISOString();
  if (t.status === 'CLOSED' && n('#e-exit') > 0) upd.exitPrice = round2(n('#e-exit'));
  if (upd.lots && upd.lotSize) upd.lots = Math.max(1, Math.round(upd.qty / upd.lotSize));
  await upsertTrade(upd);
  closeModal('edit-modal');
  toast('success', 'Trade updated');
});

function startInlineEdit(span) {
  const tr = span.closest('tr');
  const t = store.trades.find((x) => x.id === tr.dataset.id);
  if (!t) return;
  const input = document.createElement('input');
  input.type = 'number';
  input.step = '0.05';
  input.className = 'inline-input';
  input.value = t.entryPrice;
  span.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const v = Number(input.value);
    if (save && v > 0 && v !== t.entryPrice) await upsertTrade({ ...t, entryPrice: round2(v) });
    else renderAll();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

document.addEventListener('dblclick', (e) => {
  const span = e.target.closest('[data-edit="entry"]');
  if (span) startInlineEdit(span);
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const t = store.trades.find((x) => x.id === tr?.dataset.id);
  if (!t) return;
  if (btn.dataset.act === 'exit') await manualExit(t);
  if (btn.dataset.act === 'edit') openEdit(t);
  if (btn.dataset.act === 'del' && confirm(`Delete ${t.symbol}? This removes it from your journal and cannot be undone.`)) {
    await removeTrade(t.id);
    toast('success', 'Trade deleted');
  }
});

/* =====================================================================
 * Target / stop-loss / auto square-off
 * ===================================================================== */
const firing = new Set();

function triggerFor(t, p) {
  if (t.side === 'BUY') {
    if (t.sl && p <= t.sl) return 'SL';
    if (t.target && p >= t.target) return 'TARGET';
  } else {
    if (t.sl && p >= t.sl) return 'SL';
    if (t.target && p <= t.target) return 'TARGET';
  }
  return null;
}

async function runAutomation() {
  const prefs = store.settings.prefs;
  const { dow, mins } = istParts();
  const [hh, mm] = (prefs.squareOffTime || '15:20').split(':').map(Number);
  const sqWindow = prefs.autoSquareOff && dow >= 1 && dow <= 5 && mins >= hh * 60 + mm && mins <= 15 * 60 + 30;

  for (const t of store.trades) {
    if (t.status !== 'OPEN' || firing.has(t.id) || !store.prices.has(t.instrumentKey)) continue;
    const price = store.prices.get(t.instrumentKey);
    let reason = triggerFor(t, price);
    if (!reason && sqWindow && t.segment === 'intraday') reason = 'AUTO-SQOFF';
    if (!reason) continue;
    firing.add(t.id);
    try {
      const { p } = await exitTrade(t, price, reason);
      const label = reason === 'TARGET' ? '🎯 Target hit' : reason === 'SL' ? '🛑 Stop-loss hit' : '⏰ Auto square-off';
      toast(p.net >= 0 ? 'success' : 'error', label, `${t.symbol} closed @ ₹${fmtNum(price)} · net ${fmtSignedINR(p.net)}`, 8000);
      if (prefs.sound) beep(p.net >= 0 ? 'up' : 'down');
    } finally {
      firing.delete(t.id);
    }
  }
}

/* =====================================================================
 * Analytics & journal
 * ===================================================================== */
function analyticsList() {
  return closedTrades(view.filter === 'all' ? null : view.filter).sort((a, b) => new Date(a.exitTime) - new Date(b.exitTime));
}

function renderAnalytics() {
  const list = analyticsList();
  const nets = list.map((t) => tradePnl(t).net);
  const wins = nets.filter((n) => n > 0);
  const losses = nets.filter((n) => n < 0);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const grossWin = sum(wins), grossLoss = Math.abs(sum(losses));
  const charges = sum(list.map((t) => tradePnl(t).charges.total.total));
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? -grossLoss / losses.length : 0;
  const winRate = list.length ? (wins.length / list.length) * 100 : 0;
  const pf = grossLoss ? grossWin / grossLoss : wins.length ? Infinity : 0;
  const expectancy = list.length ? sum(nets) / list.length : 0;

  const stat = (label, val, cls = '') => `<div class="stat"><span>${label}</span><b class="${cls}">${val}</b></div>`;
  $('#an-stats').innerHTML = [
    stat('Total trades', list.length),
    stat('Win rate', list.length ? winRate.toFixed(1) + '%' : '–', winRate >= 50 ? 'pos' : list.length ? 'neg' : ''),
    stat('Net P&L', fmtSignedINR(sum(nets)), pnlClass(sum(nets))),
    stat('Avg profit (winners)', wins.length ? fmtSignedINR(avgWin) : '–', 'pos'),
    stat('Avg loss (losers)', losses.length ? fmtSignedINR(avgLoss) : '–', 'neg'),
    stat('Profit factor', pf === Infinity ? '∞' : list.length ? pf.toFixed(2) : '–'),
    stat('Expectancy / trade', list.length ? fmtSignedINR(expectancy) : '–', pnlClass(expectancy)),
    stat('Best trade', nets.length ? fmtSignedINR(Math.max(...nets)) : '–', 'pos'),
    stat('Worst trade', nets.length ? fmtSignedINR(Math.min(...nets)) : '–', 'neg'),
    stat('Total charges paid', fmtINR(charges)),
  ].join('');

  let run = 0;
  drawCurve($('#an-chart'), nets.map((n) => (run += n)));

  const table = $('#table-journal');
  const rows = [...list].reverse();
  table.innerHTML = HEAD(true) +
    `<tbody>${rows.length ? rows.map((t) => rowHtml(t, true)).join('') : '<tr><td colspan="9" class="empty">Closed trades will show up here as your trade journal.</td></tr>'}</tbody>`;
}

function drawCurve(canvas, series) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600, h = canvas.clientHeight || 220;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const green = css.getPropertyValue('--green').trim(), red = css.getPropertyValue('--red').trim(), muted = css.getPropertyValue('--muted').trim(), line = css.getPropertyValue('--line').trim();
  if (!series.length) {
    ctx.fillStyle = muted;
    ctx.font = '13px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('No closed trades yet', w / 2, h / 2);
    return;
  }
  const pts = [0, ...series];
  const pad = { l: 64, r: 14, t: 14, b: 22 };
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = max - min || 1;
  const x = (i) => pad.l + (i / (pts.length - 1 || 1)) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - min) / span) * (h - pad.t - pad.b);

  ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.fillStyle = muted; ctx.font = '11px ui-monospace, monospace'; ctx.textAlign = 'right';
  for (let k = 0; k <= 4; k++) {
    const v = min + (span * k) / 4, yy = y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke();
    ctx.fillText(fmtNum(v, 0), pad.l - 8, yy + 4);
  }
  const zero = y(0);
  ctx.strokeStyle = muted; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(pad.l, zero); ctx.lineTo(w - pad.r, zero); ctx.stroke(); ctx.setLineDash([]);

  const col = pts.at(-1) >= 0 ? green : red;
  ctx.beginPath();
  pts.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
  ctx.lineTo(x(pts.length - 1), zero); ctx.lineTo(x(0), zero); ctx.closePath();
  ctx.globalAlpha = 0.12; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
}

/* ---------- CSV export ---------- */
function exportCsv(which) {
  const list = closedTrades(which === 'all' ? null : which).sort((a, b) => new Date(a.exitTime) - new Date(b.exitTime));
  if (!list.length) return toast('warn', 'Nothing to export', 'There are no closed trades in this view yet.');
  const head = ['Segment', 'Symbol', 'Side', 'Qty', 'Entry time', 'Entry price', 'Exit time', 'Exit price', 'Exit reason',
    'Gross P&L', 'Brokerage', 'STT', 'Exchange charges', 'SEBI fee', 'Stamp duty', 'GST', 'Total charges', 'Net P&L', 'Notes'];
  const rows = list.map((t) => {
    const p = tradePnl(t), c = p.charges.total;
    return [t.segment, t.symbol, t.side, t.qty, t.entryTime, t.entryPrice, t.exitTime, t.exitPrice, t.exitReason || '',
      p.gross, c.brokerage, c.stt, c.exchange, c.sebi, c.stamp, c.gst, c.total, p.net, t.notes || ''];
  });
  const csv = [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
  download(`paper-trades-${which}-${todayISO()}.csv`, csv);
  toast('success', 'CSV exported', `${list.length} closed trades`);
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-export]');
  if (b) exportCsv(b.dataset.export);
});

/* =====================================================================
 * Tabs
 * ===================================================================== */
function showTab(tab) {
  if (!MAIN_TABS.includes(tab)) return;
  view.tab = tab;
  try { localStorage.setItem(LAST_TAB_KEY, tab); } catch { /* storage unavailable */ }
  $$('#main-tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  MAIN_TABS.forEach((t) => $('#panel-' + t).classList.toggle('hidden', t !== tab));
  renderAll();
}

$('#main-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) showTab(b.dataset.tab);
});

$$('.subtabs').forEach((box) =>
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sub]');
    if (!b) return;
    view.sub[box.dataset.seg] = b.dataset.sub;
    $$('.subtab', box).forEach((x) => x.classList.toggle('active', x === b));
    renderSegmentTable(box.dataset.seg);
  }));

$('#an-filter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-f]');
  if (!b) return;
  view.filter = b.dataset.f;
  $$('#an-filter .subtab').forEach((x) => x.classList.toggle('active', x === b));
  renderAnalytics();
});

window.addEventListener('resize', debounce(() => view.tab === 'analytics' && renderAnalytics(), 200));

/* =====================================================================
 * Price feed
 * ===================================================================== */
const feed = new LiveFeed(client, {
  getKeys() {
    const keys = new Map();
    for (const t of store.trades) if (t.status === 'OPEN') keys.set(t.instrumentKey, t.entryPrice);
    for (const [k, seed] of modalKeys) if (!keys.has(k)) keys.set(k, seed);
    return keys;
  },
  onPrices(map) {
    map.forEach((v, k) => store.prices.set(k, v));
    emit('prices');
    updateLiveCells();
    updateSummary();
    runAutomation();
  },
  onQuotes(map) {
    map.forEach((q, k) => store.prices.set(k, q.ltp));
    updateTicker(map);
  },
  onStatus({ mode, text, error }) {
    if (mode === 'live') setPill('pill-feed', 'ok', 'LIVE · Upstox', 'Live prices from Upstox. Click to refresh now.');
    else if (mode === 'off') setPill('pill-feed', 'warn', 'LIVE OFF', 'Live price updates are off.');
    else if (mode === 'fallback') setPill('pill-feed', 'bad', 'LIVE ERROR', 'Upstox token was rejected. Click to retry live data.');
    else setPill('pill-feed', 'bad', 'Data error', error || text);
    syncLiveToggle();
  },
  onNotice(type, msg) {
    toast(type, 'Upstox', msg, 7000);
  },
});

on('poll-now', () => feed.poll());
on('mode:changed', () => {
  syncLiveToggle();
  if (store.settings.prefs.simMode) {
    feed.stop();
    feed.status('off', 'Live off');
  } else {
    feed.start();
  }
  renderAll();
});

function syncLiveToggle() {
  const live = !store.settings.prefs.simMode;
  $('#live-toggle').checked = live;
  $('#live-toggle-label').textContent = live ? 'LIVE ON' : 'LIVE OFF';
}

$('#live-toggle').addEventListener('change', (e) => {
  const live = e.target.checked;
  setSetting('prefs.simMode', !live);
  client.fallback = false;
  syncLiveToggle();
  emit('mode:changed');
  toast('info', live ? 'Live mode on' : 'Live mode off', live ? 'Using the Upstox access token from Settings.' : 'Live price updates are paused.');
});

$('#pill-feed').addEventListener('click', () => {
  if (client.fallback) {
    client.fallback = false;
    toast('info', 'Retrying live data…');
  }
  feed.poll();
});

/* =====================================================================
 * Cloud status, snapshots, boot
 * ===================================================================== */
function paintCloud({ status, text }) {
  const state = status === 'on' ? 'ok' : status === 'error' ? 'bad' : status === 'connecting' ? 'warn' : '';
  setPill('pill-cloud', state, status === 'on' ? 'Cloud synced' : status === 'error' ? 'Cloud error' : status === 'connecting' ? 'Connecting…' : 'Local only', text);
}
on('cloud:status', paintCloud);
on('trades', () => renderAll());
on('settings:saved', () => updateSummary());

let lastSnap = 0;
function maybeSnapshot() {
  if (!cloud.ready || Date.now() - lastSnap < 5 * 60 * 1000) return;
  lastSnap = Date.now();
  const T = computeTotals();
  saveSnapshot(todayISO(), {
    date: todayISO(),
    combinedNet: round2(T.intraday.real + T.intraday.unreal + T.delivery.real + T.delivery.unreal),
    intradayNet: round2(T.intraday.real + T.intraday.unreal),
    deliveryNet: round2(T.delivery.real + T.delivery.unreal),
    intradayAvailable: round2(T.intraday.available),
    deliveryInvested: round2(T.delivery.invested),
    deliveryValue: round2(T.delivery.current),
    mode: client.isSim ? 'sim' : 'live',
  });
}

function boot() {
  initModals();
  const order = initOrderUI({
    client,
    getAvailable,
    onPlaced: (t) => {
      view.sub[t.segment] = 'open';
      $$(`.subtabs[data-seg="${t.segment}"] .subtab`).forEach((b) => b.classList.toggle('active', b.dataset.sub === 'open'));
      showTab(t.segment);
    },
  });
  $('#fab').addEventListener('click', () => order.open(view.tab === 'delivery' ? 'delivery' : 'intraday'));
  initSettingsUI({ client });

  buildTicker();
  paintCloud(store.cloud);
  updateMarketPill();
  setInterval(updateMarketPill, 30_000);
  setInterval(maybeSnapshot, 30_000);
  syncLiveToggle();
  showTab(view.tab);
  if (store.settings.prefs.simMode) {
    feed.status('off', 'Live off');
  } else {
    feed.start();
  }
  connectCloud();
}

boot();
