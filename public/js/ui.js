/* Shared UI helpers. Everything builds DOM with h(): text children are set
   as text nodes, so nothing a learner (or a model) typed can become markup. */
import { settings, on } from './state.js';
import { learnerProfile } from '/shared/goals.js';

/* ---------- DOM ---------- */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class' || k === 'className') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'html') el.innerHTML = v;                 // literal markup only
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'readOnly') el[k] = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}
function append(el, kids) {
  for (const c of kids) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}
export function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
export function clear(el) { el.replaceChildren(); return el; }

/* Light markdown → DOM: paragraphs, "- " bullets, **bold**. Nothing else. */
export function markdownish(text) {
  const root = h('div', { class: 'markdownish' });
  const lines = String(text || '').split(/\r?\n/);
  let para = [], list = null;
  const flushPara = () => { if (para.length) { root.append(h('p', null, ...inline(para.join(' ')))); para = []; } };
  const flushList = () => { if (list) { root.append(list); list = null; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushPara(); flushList(); continue; }
    const m = line.match(/^[-*•]\s+(.*)$/);
    if (m) { flushPara(); if (!list) list = h('ul'); list.append(h('li', null, ...inline(m[1]))); continue; }
    flushList(); para.push(line);
  }
  flushPara(); flushList();
  return root;
}
function inline(s) {
  const out = []; const re = /\*\*(.+?)\*\*/g; let last = 0, m;
  while ((m = re.exec(s))) { if (m.index > last) out.push(s.slice(last, m.index)); out.push(h('strong', null, m[1])); last = m.index + m[0].length; }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/* ---------- toasts ---------- */
export function toast(text, kind = '', ms = 2600) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const t = h('div', { class: `toast${kind ? ' toast--' + kind : ''}`, role: 'status' }, text);
  box.append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 200ms'; setTimeout(() => t.remove(), 220); }, ms);
  return t;
}

/* ---------- windows (modals) ---------- */
export function openWindow({ title = '', body = null, actions = [], wide = false, onClose = null, closable = true } = {}) {
  const host = document.getElementById('windows') || document.body;
  const win = h('div', { class: `pl-win window${wide ? ' window--wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const bar = h('div', { class: 'pl-titlebar' }, h('span', { class: 'pl-title' }, title), h('span', { class: 'spacer' }));
  const bodyEl = h('div', { class: 'win-body' });
  if (body) append(bodyEl, [body]);
  const actEl = h('div', { class: 'win-actions' });
  const scrim = h('div', { class: 'scrim' }, win);
  let closed = false;
  const close = (result) => {
    if (closed) return; closed = true;
    scrim.remove();
    document.removeEventListener('keydown', onKey);
    onClose && onClose(result);
  };
  const onKey = (e) => { if (e.key === 'Escape' && closable) { e.preventDefault(); close(); } };
  if (closable) {
    bar.append(h('button', { class: 'pl-close', type: 'button', 'aria-label': 'Close', onClick: () => close() }));
    scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  }
  document.addEventListener('keydown', onKey);
  win.append(bar, bodyEl);
  for (const a of actions) {
    if (a instanceof Node) { actEl.append(a); continue; }
    const b = h('button', { class: `btn ${a.class || (a.primary ? 'btn--primary' : '')}`, type: 'button', disabled: !!a.disabled }, a.label);
    b.addEventListener('click', async () => {
      if (a.onClick) { b.classList.add('is-busy'); try { const r = await a.onClick({ close, button: b, body: bodyEl }); if (r !== false && a.closes !== false) close(r); } catch (e) { toast(e.message, 'bad'); } finally { b.classList.remove('is-busy'); } }
      else close(a.value);
    });
    actEl.append(b);
  }
  if (actions.length) win.append(actEl);
  host.append(scrim);
  const first = win.querySelector('input, textarea, select, button.btn--primary, button:not(.pl-close)');
  (first || win).focus?.();
  return { el: win, body: bodyEl, close, setActions: (arr) => { actEl.replaceChildren(); for (const n of arr) actEl.append(n); if (!actEl.isConnected) win.append(actEl); } };
}
export function confirmWindow({ title = 'Are you sure?', text = '', okLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    openWindow({
      title, body: h('p', null, text),
      actions: [
        { label: cancelLabel, onClick: () => { done = true; resolve(false); } },
        { label: okLabel, class: danger ? 'btn--danger' : 'btn--primary', onClick: () => { done = true; resolve(true); } },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

/* ---------- small components ---------- */
export function progress(value, max = 1, cls = '') {
  const p = h('div', { class: `progress ${cls}`, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-valuenow': value });
  const f = h('div', { class: 'progress-fill' });
  f.style.width = `${Math.max(0, Math.min(100, (value / (max || 1)) * 100))}%`;
  p.append(f);
  p.set = (v, m = max) => { f.style.width = `${Math.max(0, Math.min(100, (v / (m || 1)) * 100))}%`; p.setAttribute('aria-valuenow', v); };
  return p;
}
export function meter(score) {
  const s = Math.max(0, Math.min(100, Math.round(score || 0)));
  const m = h('div', { class: `meter${s >= 75 ? ' is-mastered' : s < 25 ? ' is-new' : ''}`, title: `${s} / 100`, role: 'img', 'aria-label': `Memorization ${s} of 100` });
  m.append(h('div', { class: 'meter-fill', style: { width: s + '%' } }));
  return m;
}
export function bandChip(band) {
  if (!band) return null;
  return h('span', { class: `band band--${band.key}` }, h('span', { class: 'zh', lang: 'zh-Hant' }, band.zh), band.label);
}
export function ring(value, goal, { label = 'XP' } = {}) {
  const r = 32, c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, goal ? value / goal : 0));
  const el = h('div', { class: `ring${pct >= 1 ? ' is-done' : ''}`, role: 'img', 'aria-label': `${value} of ${goal} ${label} today` });
  el.innerHTML = `<svg viewBox="0 0 72 72"><circle class="ring-track" cx="36" cy="36" r="${r}"></circle><circle class="ring-fill" cx="36" cy="36" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}"></circle></svg>`;
  // Only the number and the unit fit inside the disc; the goal is shown beside the ring.
  el.append(h('div', { class: `ring-label${String(value).length >= 4 ? ' is-long' : ''}` }, `${value}`, h('small', null, label)));
  return el;
}
export function emptyState({ title, text, action, bird = null }) {
  const e = h('div', { class: 'empty' });
  if (bird) e.append(bird);
  if (title) e.append(h('p', { class: 'h3' }, title));
  if (text) e.append(h('p', null, text));
  if (action) e.append(action);
  return e;
}
export function busy(button, on = true) { button.classList.toggle('is-busy', on); button.disabled = on; }

/* ---------- celebration ---------- */
/* Confetti lives in its own fixed layer on <body>. Screens repaint right after a
   success (an import, the end of a session), and confetti inside the screen would
   be taken down with it. `root` is still accepted so existing callers need no change. */
export function celebrate(_root, n = 42) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = h('div', { class: 'confetti', 'aria-hidden': 'true' });
  for (let i = 0; i < n; i++) {
    box.append(h('i', { style: { '--x': `${Math.random() * 100}%`, '--d': `${1.4 + Math.random() * 1.4}s`, '--delay': `${Math.random() * 0.5}s`, '--r': `${(Math.random() > .5 ? 1 : -1) * (180 + Math.random() * 540)}deg` } }));
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 3200);
}

/* ---------- text-to-speech (browser, offline, free) ---------- */
let voicesCache = [];
function loadVoices() { try { voicesCache = speechSynthesis.getVoices(); } catch { voicesCache = []; } }
if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.addEventListener?.('voiceschanged', loadVoices); }
export const tts = {
  available: 'speechSynthesis' in window,
  voices() { loadVoices(); return voicesCache.filter((v) => /^(zh|cmn|yue)/i.test(v.lang.replace('_', '-'))); },
  pick() {
    const all = this.voices();
    const want = settings?.tts?.voice;
    if (want) { const v = all.find((x) => x.name === want); if (v) return v; }
    const score = (v) => (/zh[-_]TW/i.test(v.lang) ? 3 : /zh[-_]HK|yue/i.test(v.lang) ? 1 : /zh/i.test(v.lang) ? 2 : 0) + (/natural|neural|premium|enhanced/i.test(v.name) ? .5 : 0);
    return all.sort((a, b) => score(b) - score(a))[0] || null;
  },
  speak(text, { rate } = {}) {
    if (!this.available || !text) return Promise.resolve(false);
    return new Promise((resolve) => {
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'zh-TW';
        const v = this.pick(); if (v) u.voice = v;
        u.rate = rate ?? settings?.tts?.rate ?? 0.9;
        u.onend = () => resolve(true); u.onerror = () => resolve(false);
        speechSynthesis.speak(u);
      } catch { resolve(false); }
    });
  },
  stop() { try { speechSynthesis.cancel(); } catch {} },
};
export function speakButton(text, { size = 'sm', label = 'Play' } = {}) {
  const b = h('button', { class: `btn btn--icon btn--${size}`, type: 'button', 'aria-label': label, title: label });
  b.append(pixelIcon('speaker', size === 'sm' ? 2 : 3));
  b.addEventListener('click', (e) => { e.stopPropagation(); tts.speak(text); });
  if (!tts.available) b.hidden = true;
  return b;
}
// pixel.js is loaded before ui.js by app.js; this stays a soft dependency.
function pixelIcon(name, cell) {
  const s = h('span', { class: 'px', dataset: { art: name, cell } });
  window.PlumiPixel?.render(s);
  return s;
}
export { pixelIcon };

/* The top bar title (mobile). Views call this after render. */
export function setTitle(t) { const el = document.getElementById('topbarTitle'); if (el) el.textContent = t || ''; }

/* ---------- formatting ---------- */
export const fmt = {
  rel(iso) {
    if (!iso) return '';
    const d = new Date(iso), diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 45) return 'just now';
    if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
    if (diff < 86400 * 2) return 'yesterday';
    if (diff < 86400 * 14) return `${Math.round(diff / 86400)}d ago`;
    return this.date(iso);
  },
  date(v) {
    if (!v) return '';
    const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T12:00:00') : new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    const opts = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
  },
  due(iso) {
    if (!iso) return 'new';
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return 'due now';
    const m = ms / 60000; if (m < 60) return `in ${Math.max(1, Math.round(m))}m`;
    const hrs = m / 60; if (hrs < 24) return `in ${Math.round(hrs)}h`;
    const d = hrs / 24; if (d < 14) return `in ${Math.round(d)}d`;
    if (d < 60) return `in ${Math.round(d / 7)}w`;
    return `in ${Math.round(d / 30)}mo`;
  },
  n(x) { return Number(x || 0).toLocaleString(); },
  usd(x) { const v = Number(x || 0); return v === 0 ? '$0' : v < 0.1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`; },
  pct(x) { return `${Math.round((x || 0) * 100)}%`; },
  ms(ms) { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; },
};

/* Which reading to show first, from settings.script. */
export function readingFor(word) {
  const script = settings?.script || 'zhuyin';
  const zy = word?.zhuyin ? { text: word.zhuyin, kind: 'zhuyin' } : null;
  const py = word?.pinyin ? { text: word.pinyin, kind: 'pinyin' } : null;
  if (script === 'pinyin') return { primary: py || zy, secondary: py && zy ? zy : null };
  if (script === 'both') return { primary: zy || py, secondary: zy && py ? py : null };
  // The secondary is only SHOWN when a caller asks for both readings (readingEl
  // with both: true) or the script is 'both'; returning it here costs nothing and
  // lets a 注音 learner's word page show the pinyin too.
  return { primary: zy || py, secondary: zy && py ? py : null };
}
/* The learner's goals as every screen needs them (shared/goals.js). Computed on each
   call, because the welcome questions and Settings change them at runtime. */
export function profile() { return learnerProfile(settings || {}); }
/* How prominent characters are: 'full' | 'small' | 'hidden' (§8.3). */
export function hanziMode() { return profile().hanzi; }

export function readingEl(word, { size = '', both = false } = {}) {
  const r = readingFor(word);
  if (!r.primary) return null;
  const wrap = h('div', { class: 'row row--wrap', style: { gap: '10px' } });
  const mk = (x) => h('span', { class: `reading reading--${x.kind} ${size ? 'reading--' + size : ''}`, lang: x.kind === 'zhuyin' ? 'zh-Hant' : undefined }, x.text);
  wrap.append(mk(r.primary));
  if (r.secondary && (both || settings?.script === 'both')) wrap.append(mk(r.secondary));
  return wrap;
}

/* ---------- full-screen session layer ---------- */
export function openSession({ title = '', onClose = null } = {}) {
  const host = document.getElementById('session');
  host.replaceChildren();
  const bar = progress(0, 1);
  const closeBtn = h('button', { class: 'btn btn--icon btn--quiet', type: 'button', 'aria-label': 'Leave session' }, pixelIcon('x', 2));
  const top = h('div', { class: 'session-top' }, closeBtn, bar, title ? h('span', { class: 'session-title' }, title) : null);
  const body = h('div', { class: 'session-body' });
  const footer = h('div', { class: 'session-footer' });
  const banner = h('div', { class: 'banner', hidden: true });
  const el = h('div', { class: 'session-view', style: { display: 'contents' } }, top, body, footer, banner);
  host.append(el);
  host.hidden = false;
  document.body.dataset.session = '1';
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    tts.stop();
    host.hidden = true; host.replaceChildren();
    delete document.body.dataset.session;
    document.removeEventListener('keydown', onKey);
    onClose && onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); closeBtn.click(); } };
  document.addEventListener('keydown', onKey);
  const session = {
    el, body, footer, banner, closeBtn,
    setProgress: (v, m = 1) => bar.set(v, m),
    setBusy: (b) => bar.classList.toggle('is-busy', !!b),
    setTitle: (t) => { const s = top.querySelector('.session-title'); if (s) s.textContent = t; },
    close,
  };
  closeBtn.addEventListener('click', () => session.onLeave ? session.onLeave() : close());
  return session;
}

/* The Duolingo banner. ok=true → sage "Correct", ok=false → brick with the answer. */
export function feedback(session, { ok, title, detail = null, actionLabel = 'Continue', onAction = null, extra = null }) {
  const b = session.banner;
  b.className = `banner ${ok ? 'banner--ok' : 'banner--bad'}`;
  b.replaceChildren(
    h('div', { class: 'banner-title' }, pixelIcon(ok ? 'check' : 'x', 3), title || (ok ? 'Correct!' : 'Not quite')),
    // replaceChildren() would print a null child as the word "null".
    ...(detail ? [h('div', { class: 'banner-detail' }, detail)] : []),
    h('div', { class: 'banner-actions' }, extra, h('button', { class: `btn btn--lg ${ok ? 'btn--ok' : 'btn--danger'}`, type: 'button', onClick: () => { hideFeedback(session); onAction && onAction(); } }, actionLabel)),
  );
  b.hidden = false;
  requestAnimationFrame(() => b.classList.add('is-open'));
  const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); document.removeEventListener('keydown', onKey, true); b.querySelector('.btn')?.click(); } };
  document.addEventListener('keydown', onKey, true);
  b._onKey = onKey;
  try { navigator.vibrate?.(ok ? 12 : [30, 40, 30]); } catch {}
  b.querySelector('.btn')?.focus();
}
export function hideFeedback(session) {
  const b = session.banner;
  if (b._onKey) document.removeEventListener('keydown', b._onKey, true);
  b.classList.remove('is-open');
  setTimeout(() => { b.hidden = true; }, 200);
}

/* Floating "+N XP" near the XP chip whenever stats grow. */
export function initXpPops() {
  on('xp', ({ amount }) => {
    const anchor = document.querySelector('.topbar-stats .xp, .rail .xp');
    const r = anchor?.getBoundingClientRect();
    const pop = h('div', { class: 'xp-pop' }, `+${amount} XP`);
    pop.style.left = r ? `${r.left}px` : '50%';
    pop.style.top = r ? `${r.top - 6}px` : '80px';
    document.body.append(pop);
    setTimeout(() => pop.remove(), 950);
  });
}
