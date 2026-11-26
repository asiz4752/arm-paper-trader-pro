// Small helpers shared across modules.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const nf = (d) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const nfCache = {};
export const fmtNum = (n, d = 2) => {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '–';
  return (nfCache[d] ||= nf(d)).format(Number(n));
};
export const fmtINR = (n, d = 2) => {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '–';
  const v = Number(n);
  return (v < 0 ? '-' : '') + fmtNum(Math.abs(v), d);
};
export const fmtSignedINR = (n, d = 2) => {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '–';
  const v = Number(n);
  if (v === 0) return fmtNum(0, d);
  return (v < 0 ? '-' : '+') + fmtNum(Math.abs(v), d);
};
export const pnlClass = (n) => (n > 0.004 ? 'pos' : n < -0.004 ? 'neg' : 'flat');

export const uid = () =>
  (globalThis.crypto?.randomUUID?.() ?? 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

export const debounce = (fn, ms = 300) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

const pad = (n) => String(n).padStart(2, '0');
export const toLocalInput = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const todayISO = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const fmtDateTime = (iso) => {
  if (!iso) return '–';
  const d = new Date(iso);
  if (isNaN(d)) return '–';
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
};
export const fmtDate = (iso) => {
  if (!iso) return '–';
  const d = new Date(iso);
  if (isNaN(d)) return '–';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
};

export const calendarDaysBetween = (start, end) => {
  if (!start || !end) return null;
  const from = new Date(start), to = new Date(end);
  if (isNaN(from) || isNaN(to)) return null;
  const fromDay = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const toDay = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.max(0, Math.floor((toDay - fromDay) / 86400000));
};

// "2026-12-02" -> "02DEC26"
export const shortExpiry = (ymd) => {
  const [y, m, d] = String(ymd).split('-').map(Number);
  if (!y) return ymd;
  const mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][m - 1];
  return `${pad(d)}${mon}${String(y).slice(2)}`;
};

// Date / time parts in IST regardless of the user's timezone.
export const istParts = (date = new Date()) => {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (t) => f.find((p) => p.type === t)?.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { dow: wd, mins: Number(get('hour')) % 24 * 60 + Number(get('minute')) };
};
export const istYMD = (date = new Date()) => date.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

// NSE/BSE cash & F&O session: Mon-Fri 09:15-15:30 IST (exchange holidays are not modelled).
export const isMarketOpen = (date = new Date()) => {
  const { dow, mins } = istParts(date);
  return dow >= 1 && dow <= 5 && mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
};

export const download = (filename, text, mime = 'text/csv;charset=utf-8') => {
  const blob = new Blob(['﻿' + text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

export const deepMerge = (base, extra) => {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object') out[k] = deepMerge(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
};

export const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
export const setPath = (obj, path, value) => {
  const keys = path.split('.');
  let o = obj;
  keys.slice(0, -1).forEach((k) => (o = o[k] ??= {}));
  o[keys.at(-1)] = value;
};
