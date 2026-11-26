// Floating "+ New Trade" order ticket (Intraday options / Delivery equity).

import { $, $$, fmtINR, fmtNum, round2, uid, toLocalInput, todayISO, shortExpiry, debounce, esc } from './utils.js';
import { store, upsertTrade, on, emit } from './store.js';
import { INDEX_META } from './constants.js';
import { previewCharges, marginRequired, intradayReferenceLevels } from './brokerage-calc.js';
import { openModal, closeModal, toast } from './ui.js';

/** Keys the order ticket wants live prices for (merged into the feed's subscription list). */
export const modalKeys = new Map();

export function initOrderUI({ client, getAvailable, onPlaced }) {
  const modal = $('#order-modal');
  const form = $('#order-form');
  const err = $('#order-error');

  const o = {
    seg: 'intraday',
    d: { otype: 'MARKET', inst: null },
    i: { index: 'NIFTY', opt: 'CE', side: 'BUY', otype: 'MARKET', inst: null, token: 0 },
  };
  let autoIntradayTarget = true;
  let autoIntradayStop = true;

  const num = (sel) => {
    const v = $(sel).value;
    return v === '' ? NaN : Number(v);
  };
  const setActive = (container, attr, val) =>
    $$('button', container).forEach((b) => b.classList.toggle('active', b.dataset[attr] === val));

  /* ---------- live price helpers ---------- */
  const curInst = () => (o.seg === 'delivery' ? o.d.inst : o.i.inst);
  const curLtp = () => (curInst() ? store.prices.get(curInst().key) : undefined);

  function syncModalKeys() {
    modalKeys.clear();
    const inst = curInst();
    if (inst?.key && !modal.classList.contains('hidden')) modalKeys.set(inst.key, undefined);
    emit('poll-now');
  }

  function refreshPrices() {
    const ltp = curLtp();
    const txt = Number.isFinite(ltp) ? fmtNum(ltp) : '–';
    if (o.seg === 'delivery') {
      $('#d-ltp').textContent = txt;
      if (o.d.otype === 'MARKET') $('#d-price').value = Number.isFinite(ltp) ? ltp.toFixed(2) : '';
    } else {
      $('#i-ltp').textContent = txt;
      if (o.i.otype === 'MARKET') $('#i-price').value = Number.isFinite(ltp) ? ltp.toFixed(2) : '';
      refreshIntradayLevels();
    }
    renderPreview();
  }
  on('prices', () => {
    if (!modal.classList.contains('hidden')) refreshPrices();
  });

  /* ---------- charges preview ---------- */
  function currentDraft() {
    if (o.seg === 'delivery') {
      return { segment: 'delivery', exchange: 'NSE', side: 'BUY', price: num('#d-price'), qty: num('#d-qty') };
    }
    return {
      segment: 'intraday', exchange: INDEX_META[o.i.index].exchange, side: o.i.side,
      price: num('#i-price'), qty: num('#i-qty'),
    };
  }

  function renderPreview() {
    const d = currentDraft();
    const box = $('#charges-preview');
    if (!(d.price > 0) || !(d.qty > 0)) {
      box.innerHTML = '<div class="head">Estimated charges</div><div style="color:var(--muted)">Enter price and quantity to see brokerage, STT, exchange fees, SEBI, stamp duty and GST.</div>';
      return;
    }
    const { entry, roundTrip } = previewCharges(d);
    const need = marginRequired(
      { segment: d.segment, side: d.side, entryPrice: d.price, qty: d.qty, strike: Number($('#i-strike').value) || undefined },
      store.settings.prefs.shortMarginPct,
    );
    const avail = getAvailable(d.segment);
    const row = (k, v) => `<tr><td>${k}</td><td>${fmtINR(v)}</td></tr>`;
    box.innerHTML = `
      <div class="head">Estimated charges – entry order</div>
      <table>
        ${row('Order value', entry.turnover)}
        ${row('Brokerage', entry.brokerage)}
        ${row('STT', entry.stt)}
        ${row('Exchange transaction charges', entry.exchange)}
        ${row('SEBI turnover fee', entry.sebi)}
        ${row('Stamp duty', entry.stamp)}
        ${row('GST (18%)', entry.gst)}
        <tr class="total"><td>Entry charges</td><td>${fmtINR(entry.total)}</td></tr>
        <tr><td>Est. round-trip charges (exit at same price)</td><td>${fmtINR(roundTrip.total)}</td></tr>
        <tr><td>Funds required ${d.side === 'SELL' ? '(approx. margin)' : ''}</td><td style="color:${need > avail ? 'var(--red)' : 'inherit'}">${fmtINR(need)}</td></tr>
        <tr><td>Available ${d.segment}</td><td>${fmtINR(avail)}</td></tr>
      </table>`;
  }

  function refreshIntradayLevels() {
    const entryPrice = num('#i-price');
    const validEntry = Number.isFinite(entryPrice) && entryPrice > 0;
    const levels = validEntry ? intradayReferenceLevels({ side: o.i.side, entryPrice }) : null;
    if (autoIntradayTarget) $('#i-target').value = levels ? levels.target.toFixed(2) : '';
    if (autoIntradayStop) $('#i-sl').value = levels ? levels.sl.toFixed(2) : '';
    $('#i-target-offset').textContent = o.i.side === 'SELL' ? '(entry −32 pts)' : '(entry +32 pts)';
    $('#i-sl-offset').textContent = o.i.side === 'SELL' ? '(entry +22 pts)' : '(entry −22 pts)';
  }

  /* ---------- segment switching ---------- */
  function setSegment(seg) {
    o.seg = seg;
    setActive($('#o-seg'), 'seg', seg);
    $('#f-delivery').classList.toggle('hidden', seg !== 'delivery');
    $('#f-intraday').classList.toggle('hidden', seg !== 'intraday');
    err.textContent = '';
    updateSubmitButton();
    syncModalKeys();
    refreshPrices();
  }

  function updateSubmitButton() {
    const btn = $('#order-submit');
    const sell = o.seg === 'intraday' && o.i.side === 'SELL';
    btn.classList.toggle('sell', sell);
    btn.textContent = o.seg === 'delivery' ? 'Buy (Delivery)' : sell ? 'Sell (Short)' : 'Buy (Long)';
  }

  $('#o-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-seg]');
    if (b) setSegment(b.dataset.seg);
  });

  /* ---------- DELIVERY ---------- */
  const resolveDelivery = debounce(async () => {
    const v = $('#d-symbol').value.trim();
    if (!v) {
      o.d.inst = null;
      $('#d-key').value = '';
      return syncModalKeys(), refreshPrices();
    }
    try {
      const [matches, inst] = await Promise.all([client.searchEquity(v), client.resolveEquity(v)]);
      $('#d-suggest').innerHTML = matches.map((m) => `<option value="${esc(m.symbol)}">${esc(m.name || '')}</option>`).join('');
      o.d.inst = inst;
      $('#d-key').value = inst?.key || '';
    } catch (e) {
      o.d.inst = null;
      err.textContent = e.message;
    }
    syncModalKeys();
    refreshPrices();
  }, 350);

  $('#d-symbol').addEventListener('input', resolveDelivery);
  $('#d-key').addEventListener('input', (e) => {
    const k = e.target.value.trim();
    o.d.inst = k ? { key: k, symbol: k.includes('|') ? k.split('|')[1] : k } : null;
    syncModalKeys();
    refreshPrices();
  });
  $('#d-otype').addEventListener('click', (e) => {
    const b = e.target.closest('[data-otype]');
    if (!b) return;
    o.d.otype = b.dataset.otype;
    setActive($('#d-otype'), 'otype', o.d.otype);
    $('#d-price').readOnly = o.d.otype === 'MARKET';
    if (o.d.otype === 'MARKET') refreshPrices();
    else $('#d-price').focus();
  });
  ['#d-price', '#d-qty'].forEach((s) => $(s).addEventListener('input', renderPreview));

  /* ---------- INTRADAY ---------- */
  const lotSizeFor = (index) => store.settings.lotSizes[index] || INDEX_META[index].lot;

  function syncQty() {
    const lots = num('#i-lots');
    const ls = num('#i-lotsize');
    if (lots > 0 && ls > 0) $('#i-qty').value = Math.round(lots * ls);
    renderPreview();
  }

  const resolveContract = debounce(async () => {
    const { index, opt } = o.i;
    const expiry = $('#i-expiry').value;
    const strike = num('#i-strike');
    $('#i-contract').textContent = expiry && strike ? `${index} ${shortExpiry(expiry)} ${strike} ${opt}` : 'Contract';
    if (!expiry || !(strike > 0)) {
      o.i.inst = null;
      $('#i-key').value = '';
      return syncModalKeys(), refreshPrices();
    }
    try {
      const inst = await client.findOption(index, expiry, strike, opt);
      o.i.inst = inst;
      $('#i-key').value = inst?.key || '';
      if (inst?.lotSize) {
        $('#i-lotsize').value = inst.lotSize;
        syncQty();
      }
      err.textContent = inst ? '' : 'No such contract in the Upstox instrument list. Check expiry / strike.';
    } catch (e) {
      o.i.inst = null;
      err.textContent = e.message;
    }
    syncModalKeys();
    refreshPrices();
  }, 200);

  async function loadExpiries() {
    const token = ++o.i.token;
    const sel = $('#i-expiry');
    sel.innerHTML = '<option>Loading…</option>';
    try {
      const list = await client.expiries(o.i.index);
      if (token !== o.i.token) return;
      sel.innerHTML = list.length
        ? list.map((d) => `<option value="${d}">${shortExpiry(d)}</option>`).join('')
        : '<option value="">No expiries found</option>';
      await loadStrikes();
    } catch (e) {
      sel.innerHTML = '<option value="">Unavailable</option>';
      err.textContent = e.message + ' – you can still paste an instrument key manually.';
    }
    resolveContract();
  }

  async function loadStrikes() {
    const expiry = $('#i-expiry').value;
    const spot = store.prices.get(INDEX_META[o.i.index].key);
    try {
      const strikes = await client.strikes(o.i.index, expiry, spot);
      $('#i-strikes').innerHTML = strikes.slice(0, 600).map((s) => `<option value="${s}"></option>`).join('');
    } catch { /* datalist is only a convenience */ }
  }

  function setAtm() {
    const meta = INDEX_META[o.i.index];
    const spot = store.prices.get(meta.key);
    if (!Number.isFinite(spot)) return toast('warn', 'Index price not available yet');
    $('#i-strike').value = Math.round(spot / meta.step) * meta.step;
    resolveContract();
  }

  $('#i-index').addEventListener('click', (e) => {
    const b = e.target.closest('[data-index]');
    if (!b) return;
    o.i.index = b.dataset.index;
    setActive($('#i-index'), 'index', o.i.index);
    $('#i-strike').step = INDEX_META[o.i.index].step;
    $('#i-lotsize').value = lotSizeFor(o.i.index);
    $('#i-strike').value = '';
    syncQty();
    loadExpiries().then(() => {
      if (!$('#i-strike').value) setAtm();
    });
  });
  $('#i-expiry').addEventListener('change', async () => {
    await loadStrikes();
    resolveContract();
  });
  $('#i-strike').addEventListener('input', resolveContract);
  $('#i-atm').addEventListener('click', setAtm);
  $('#i-opt').addEventListener('click', (e) => {
    const b = e.target.closest('[data-opt]');
    if (!b) return;
    o.i.opt = b.dataset.opt;
    setActive($('#i-opt'), 'opt', o.i.opt);
    resolveContract();
  });
  $('#i-side').addEventListener('click', (e) => {
    const b = e.target.closest('[data-side]');
    if (!b) return;
    o.i.side = b.dataset.side;
    setActive($('#i-side'), 'side', o.i.side);
    updateSubmitButton();
    refreshIntradayLevels();
    renderPreview();
  });
  $('#i-otype').addEventListener('click', (e) => {
    const b = e.target.closest('[data-otype]');
    if (!b) return;
    o.i.otype = b.dataset.otype;
    setActive($('#i-otype'), 'otype', o.i.otype);
    $('#i-price').readOnly = o.i.otype === 'MARKET';
    if (o.i.otype === 'MARKET') refreshPrices();
    else $('#i-price').focus();
  });
  $('#i-key').addEventListener('input', (e) => {
    const k = e.target.value.trim();
    o.i.inst = k ? { key: k } : null;
    syncModalKeys();
    refreshPrices();
  });
  ['#i-lots', '#i-lotsize'].forEach((s) => $(s).addEventListener('input', syncQty));
  $('#i-price').addEventListener('input', () => {
    refreshIntradayLevels();
    renderPreview();
  });
  $('#i-qty').addEventListener('input', renderPreview);
  $('#i-target').addEventListener('input', () => { autoIntradayTarget = false; });
  $('#i-sl').addEventListener('input', () => { autoIntradayStop = false; });

  /* ---------- open / close ---------- */
  function open(seg = 'intraday') {
    err.textContent = '';
    form.reset();
    autoIntradayTarget = true;
    autoIntradayStop = true;
    o.d = { otype: 'MARKET', inst: null };
    o.i = { ...o.i, otype: 'MARKET', side: 'BUY', opt: 'CE', inst: null };
    setActive($('#d-otype'), 'otype', 'MARKET');
    setActive($('#i-otype'), 'otype', 'MARKET');
    setActive($('#i-opt'), 'opt', 'CE');
    setActive($('#i-side'), 'side', 'BUY');
    setActive($('#i-index'), 'index', o.i.index);
    $('#d-price').readOnly = true;
    $('#i-price').readOnly = true;
    $('#d-date').value = todayISO();
    $('#d-qty').value = 1;
    $('#i-datetime').value = toLocalInput();
    $('#i-lots').value = 1;
    $('#i-lotsize').value = lotSizeFor(o.i.index);
    $('#i-strike').step = INDEX_META[o.i.index].step;
    $('#i-strike').value = '';
    $('#d-suggest').innerHTML = '';
    syncQty();
    openModal(modal);
    setSegment(seg);
    loadExpiries().then(() => {
      if (!$('#i-strike').value) setAtm();
    });
  }

  modal.addEventListener('modal-closed', () => {
    modalKeys.clear();
    err.textContent = '';
  });
  on('mode:changed', () => {
    // Expiries / instruments differ between live and simulation.
    if (!modal.classList.contains('hidden')) {
      o.d.inst = null;
      o.i.inst = null;
      loadExpiries();
      resolveDelivery();
    }
  });

  /* ---------- submit ---------- */
  const optNum = (sel) => {
    const v = num(sel);
    return Number.isFinite(v) && v > 0 ? v : null;
  };

  function entryTimeFromDate(dateStr) {
    const now = new Date();
    if (dateStr === todayISO(now)) return now.toISOString();
    return new Date(`${dateStr}T09:15:00`).toISOString();
  }

  function build() {
    if (o.seg === 'delivery') {
      const sym = $('#d-symbol').value.trim();
      const key = $('#d-key').value.trim() || o.d.inst?.key;
      const price = num('#d-price');
      const qty = num('#d-qty');
      const date = $('#d-date').value;
      if (!sym && !key) throw new Error('Enter a stock symbol.');
      if (!key) throw new Error('Could not resolve that symbol to an instrument key.');
      if (!(price > 0)) throw new Error(o.d.otype === 'MARKET' ? 'Waiting for a live price. Try again in a moment, or switch to a limit price.' : 'Enter a valid buy price.');
      if (!(qty >= 1) || !Number.isInteger(qty)) throw new Error('Quantity must be a whole number ≥ 1.');
      if (!date) throw new Error('Pick a buy date.');
      return {
        id: uid(), segment: 'delivery', symbol: (o.d.inst?.symbol || sym).toUpperCase(), instrumentKey: key,
        exchange: 'NSE', side: 'BUY', qty, entryPrice: round2(price), orderType: o.d.otype,
        entryTime: entryTimeFromDate(date), target: optNum('#d-target'), sl: optNum('#d-sl'),
        status: 'OPEN', createdAt: Date.now(),
      };
    }
    const { index, opt, side } = o.i;
    const expiry = $('#i-expiry').value;
    const strike = num('#i-strike');
    const key = $('#i-key').value.trim() || o.i.inst?.key;
    const price = num('#i-price');
    const qty = num('#i-qty');
    const lots = num('#i-lots');
    const lotSize = num('#i-lotsize');
    const when = $('#i-datetime').value;
    if (!expiry) throw new Error('Select an expiry.');
    if (!(strike > 0)) throw new Error('Enter a strike price.');
    if (!key) throw new Error('Contract not found. Check expiry/strike or paste an instrument key.');
    if (!(price > 0)) throw new Error(o.i.otype === 'MARKET' ? 'Waiting for a live premium. Try again in a moment, or switch to a limit price.' : 'Enter a valid entry price.');
    if (!(qty >= 1) || !Number.isInteger(qty)) throw new Error('Quantity must be a whole number ≥ 1.');
    return {
      id: uid(), segment: 'intraday', index, optType: opt, strike, expiry,
      symbol: `${index} ${shortExpiry(expiry)} ${strike} ${opt}`, instrumentKey: key,
      exchange: INDEX_META[index].exchange, side, lots: lots > 0 ? lots : null, lotSize: lotSize > 0 ? lotSize : null,
      qty, entryPrice: round2(price), orderType: o.i.otype,
      entryTime: when ? new Date(when).toISOString() : new Date().toISOString(),
      target: optNum('#i-target'), sl: optNum('#i-sl'), status: 'OPEN', createdAt: Date.now(),
    };
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      const t = build();
      // Target / SL sanity
      if (t.side === 'BUY') {
        if (t.target && t.target <= t.entryPrice) throw new Error('For a long position the target must be above the entry price.');
        if (t.sl && t.sl >= t.entryPrice) throw new Error('For a long position the stop-loss must be below the entry price.');
      } else {
        if (t.target && t.target >= t.entryPrice) throw new Error('For a short position the target must be below the entry price.');
        if (t.sl && t.sl <= t.entryPrice) throw new Error('For a short position the stop-loss must be above the entry price.');
      }
      const need = marginRequired(t, store.settings.prefs.shortMarginPct);
      const avail = getAvailable(t.segment);
      if (need > avail) throw new Error(`Insufficient virtual funds: need ${fmtINR(need)}, available ${fmtINR(avail)}. Adjust capital in Settings.`);
      await upsertTrade(t);
      closeModal(modal);
      toast('success', `${t.side} order filled`, `${t.symbol} × ${t.qty} @ ${fmtNum(t.entryPrice)}`);
      onPlaced?.(t);
    } catch (ex) {
      err.textContent = ex.message;
    }
  });

  return { open };
}
