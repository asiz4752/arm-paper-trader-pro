// Generic UI helpers: modals, toasts, alert sound.

import { $, $$, esc } from './utils.js';

export function openModal(id) {
  const el = typeof id === 'string' ? $('#' + id) : id;
  el.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  el.dispatchEvent(new CustomEvent('modal-opened'));
}

export function closeModal(target) {
  const el = typeof target === 'string' ? $('#' + target) : target;
  if (!el) return;
  el.classList.add('hidden');
  el.dispatchEvent(new CustomEvent('modal-closed'));
  if (!$$('.modal:not(.hidden)').length) document.body.style.overflow = '';
}

export function initModals() {
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-close]');
    if (c) closeModal(c.closest('.modal'));
  });
  document.addEventListener('mousedown', (e) => {
    if (e.target.classList?.contains('modal')) closeModal(e.target);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const open = $$('.modal:not(.hidden)').at(-1);
      if (open) closeModal(open);
    }
  });
}

export function toast(type, title, msg = '', ms = 4500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<b>${esc(title)}</b>${msg ? `<span>${esc(msg)}</span>` : ''}`;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

let audioCtx;
export function beep(kind = 'up') {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const notes = kind === 'up' ? [660, 880] : [440, 330];
    notes.forEach((f, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      const t0 = audioCtx.currentTime + i * 0.16;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.16);
    });
  } catch { /* audio blocked until first user gesture */ }
}
