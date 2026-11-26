// Indian brokerage & statutory charge calculator (Upstox pricing model).
//
// Rates below were checked against Upstox's published charge list and the Union Budget 2026
// STT revision (effective 1 April 2026). Regulators and exchanges revise these from time to
// time, so every rate lives in RATES and can be changed in one place.

export const RATES = {
  gstPct: 0.18,            // on brokerage + exchange charges + SEBI fee
  sebiPct: 0.000001,       // Rs 10 per crore
  delivery: {
    brokerageFlat: 20,       // Rs 20 or 2.5% of turnover, whichever is lower
    brokeragePctCap: 0.025,
    sttBuyPct: 0.001,        // 0.1% on buy and on sell
    sttSellPct: 0.001,
    exch: { NSE: 0.0000297, BSE: 0.0000375 }, // 0.00297% NSE, ~0.00375% BSE
    stampBuyPct: 0.00015,    // 0.015% on buy
    dpPerSellOrder: 0,       // demat debit charge per sell order incl. GST; set if you want it modelled
  },
  options: {
    brokerageFlat: 20,       // flat Rs 20 per executed order
    sttSellPct: 0.0015,      // 0.15% of premium on sell (post 1 Apr 2026; was 0.10%)
    exch: { NSE: 0.0003503, BSE: 0.000325 }, // % of premium turnover
    stampBuyPct: 0.00003,    // 0.003% on buy
  },
};

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const EMPTY = () => ({ turnover: 0, brokerage: 0, stt: 0, exchange: 0, sebi: 0, stamp: 0, gst: 0, dp: 0, total: 0 });

/**
 * Charges for ONE executed order (leg).
 * @param {{segment:'delivery'|'intraday', exchange?:'NSE'|'BSE', side:'BUY'|'SELL', price:number, qty:number}} o
 */
export function legCharges({ segment, exchange = 'NSE', side, price, qty }) {
  const out = EMPTY();
  const turnover = Number(price) * Number(qty);
  if (!(turnover > 0)) return out;
  const isDelivery = segment === 'delivery';
  const R = isDelivery ? RATES.delivery : RATES.options;

  const brokerage = isDelivery ? Math.min(R.brokerageFlat, turnover * R.brokeragePctCap) : R.brokerageFlat;
  const stt = side === 'SELL' ? turnover * R.sttSellPct : isDelivery ? turnover * R.sttBuyPct : 0;
  const exchange$ = turnover * (R.exch[exchange] ?? R.exch.NSE);
  const sebi = turnover * RATES.sebiPct;
  const stamp = side === 'BUY' ? turnover * R.stampBuyPct : 0;
  const dp = isDelivery && side === 'SELL' ? R.dpPerSellOrder : 0;
  const gst = (brokerage + exchange$ + sebi + dp) * RATES.gstPct;

  out.turnover = r2(turnover);
  out.brokerage = r2(brokerage);
  out.stt = r2(stt);
  out.exchange = r2(exchange$);
  out.sebi = r2(sebi);
  out.stamp = r2(stamp);
  out.dp = r2(dp);
  out.gst = r2(gst);
  out.total = r2(out.brokerage + out.stt + out.exchange + out.sebi + out.stamp + out.dp + out.gst);
  return out;
}

const opposite = (side) => (side === 'BUY' ? 'SELL' : 'BUY');
const KEYS = ['turnover', 'brokerage', 'stt', 'exchange', 'sebi', 'stamp', 'gst', 'dp', 'total'];
const addUp = (a, b) => {
  const o = EMPTY();
  KEYS.forEach((k) => (o[k] = r2(a[k] + b[k])));
  return o;
};

/**
 * Round-trip charges for a trade: actual entry leg + exit leg.
 * For open trades the exit leg is an estimate at `markPrice`.
 */
export function tradeCharges(trade, markPrice) {
  const exchange = trade.exchange || 'NSE';
  const entry = legCharges({ segment: trade.segment, exchange, side: trade.side, price: trade.entryPrice, qty: trade.qty });
  const exitPrice = trade.status === 'CLOSED' ? trade.exitPrice : markPrice;
  const exit = legCharges({ segment: trade.segment, exchange, side: opposite(trade.side), price: exitPrice ?? trade.entryPrice, qty: trade.qty });
  return { entry, exit, total: addUp(entry, exit) };
}

export const grossPnl = (trade, price) => {
  const p = Number(price);
  if (!Number.isFinite(p)) return 0;
  const diff = trade.side === 'SELL' ? trade.entryPrice - p : p - trade.entryPrice;
  return r2(diff * trade.qty);
};

export const intradayReferenceLevels = (trade) => {
  const targetOffset = trade.side === 'SELL' ? -32 : 32;
  const stopOffset = trade.side === 'SELL' ? 22 : -22;
  return {
    target: r2(Math.max(0, trade.entryPrice + targetOffset)),
    sl: r2(Math.max(0, trade.entryPrice + stopOffset)),
  };
};

/** Full P&L picture for a trade at `price` (ignored when the trade is closed). */
export function tradePnl(trade, price) {
  const mark = trade.status === 'CLOSED' ? trade.exitPrice : price ?? trade.entryPrice;
  const gross = grossPnl(trade, mark);
  const charges = tradeCharges(trade, mark);
  return { mark, gross, charges, net: r2(gross - charges.total.total) };
}

/** Approximate funds blocked while a trade is open. */
export function marginRequired(trade, shortMarginPct = 11) {
  if (trade.segment === 'delivery') return r2(trade.entryPrice * trade.qty);
  if (trade.side === 'BUY') return r2(trade.entryPrice * trade.qty); // premium paid
  // Short option: rough SPAN+exposure proxy = % of notional (strike x qty), plus premium is received.
  const notional = (trade.strike || trade.entryPrice) * trade.qty;
  return r2(notional * (shortMarginPct / 100));
}

/** Entry-leg charges + estimated round trip, for the order-ticket preview. */
export function previewCharges(order) {
  const entry = legCharges(order);
  const exit = legCharges({ ...order, side: opposite(order.side) });
  return { entry, exit, roundTrip: addUp(entry, exit) };
}
