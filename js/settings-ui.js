// Settings modal: every field auto-saves on input (localStorage + Firestore sync).

import { $, $$, getPath, debounce } from './utils.js';
import { store, setSetting, on, emit, connectCloud, cloud, clearLocalData } from './store.js';
import { parseFirebaseSnippet } from './firebase-config.js';
import { openModal, toast } from './ui.js';

export function initSettingsUI({ client }) {
  const modal = $('#settings-modal');
  const indicator = $('#saved-indicator');

  const populate = () => {
    $$('[data-setting]', modal).forEach((el) => {
      const v = getPath(store.settings, el.dataset.setting);
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v ?? '';
    });
  };

  let hideTimer;
  on('settings:saved', () => {
    indicator.classList.add('show');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => indicator.classList.remove('show'), 1300);
  });
  on('settings:loaded', populate);

  const reconnect = debounce(() => connectCloud(), 900);

  const onInput = (el) => {
    const path = el.dataset.setting;
    let value;
    if (el.type === 'checkbox') value = el.checked;
    else if (el.type === 'number') value = el.value === '' ? 0 : Number(el.value);
    else value = el.value.trim();
    setSetting(path, value);

    if (path.startsWith('firebase.') || path === 'prefs.workspaceId') reconnect();
    if (path === 'upstox.accessToken') {
      client.fallback = false;
      emit('mode:changed');
    }
    if (path === 'prefs.simMode') {
      client.fallback = false;
      emit('mode:changed');
    }
  };
  $$('[data-setting]', modal).forEach((el) => {
    el.addEventListener('input', () => onInput(el));
    el.addEventListener('change', () => onInput(el));
  });

  // Paste the whole firebaseConfig snippet
  $('#fb-paste').addEventListener('input', (e) => {
    const parsed = parseFirebaseSnippet(e.target.value);
    const keys = Object.keys(parsed);
    if (!keys.length) return;
    keys.forEach((k) => {
      if (k in store.settings.firebase) setSetting(`firebase.${k}`, parsed[k]);
    });
    populate();
    reconnect();
    toast('success', 'Firebase config detected', `${keys.length} fields filled in.`);
  });

  const result = (el, ok, text) => {
    el.className = 'test-result ' + (ok ? 'ok' : 'err');
    el.textContent = text;
  };

  $('#btn-test-upstox').addEventListener('click', async () => {
    const out = $('#test-upstox');
    out.className = 'test-result';
    out.textContent = 'Testing…';
    try {
      const p = await client.profile();
      result(out, true, `✓ Connected as ${p.user_name || p.user_id || 'user'}`);
    } catch (e) {
      result(out, false, '✗ ' + e.message);
    }
  });

  $('#btn-login-url').addEventListener('click', () => {
    const { apiKey, redirectUri } = store.settings.upstox;
    if (!apiKey || !redirectUri) return toast('warn', 'Missing details', 'Fill in API key and Redirect URI first.');
    window.open(client.loginUrl(), '_blank', 'noopener');
  });

  $('#btn-exchange').addEventListener('click', async () => {
    const u = store.settings.upstox;
    if (!u.authCode || !u.apiKey || !u.apiSecret || !u.redirectUri) {
      return toast('warn', 'Missing details', 'API key, secret, redirect URI and auth code are all required.');
    }
    try {
      const token = await client.exchangeCode();
      setSetting('upstox.accessToken', token);
      setSetting('upstox.authCode', '');
      populate();
      client.fallback = false;
      emit('mode:changed');
      toast('success', 'Access token saved', 'Valid until about 03:30 AM IST tomorrow.');
    } catch (e) {
      toast('error', 'Token exchange failed', e.message);
    }
  });

  $('#btn-test-firebase').addEventListener('click', async () => {
    const out = $('#test-firebase');
    out.className = 'test-result';
    out.textContent = 'Testing…';
    try {
      if (!cloud.ready) {
        const r = await connectCloud();
        if (!r.ok) throw new Error(r.error);
      }
      await cloud.verify();
      result(out, true, '✓ Firestore read/write OK');
    } catch (e) {
      result(out, false, '✗ ' + (e.code === 'permission-denied' ? 'Permission denied – check Firestore rules' : e.message));
    }
  });

  $('#btn-clear-local').addEventListener('click', () => {
    if (confirm('Clear the trades cached in this browser? (Trades stored in Firestore are NOT deleted, and will re-sync if connected.)')) {
      clearLocalData();
      toast('success', 'Local cache cleared');
    }
  });

  $('#btn-settings').addEventListener('click', () => {
    populate();
    openModal('settings-modal');
  });

  populate();
}
