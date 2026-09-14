/* ============================================================
   notes-kit.js — what every Notes screen shares.

   Notes grew a second tab (Documents, §8.6) and drafts of several
   lessons (§8.5). One module of 1,600 lines stopped being readable, so
   the view is now notes.js with two parts, notes-docs.js and
   notes-draft.js, and this file holds what all three use: the render
   generation, the one live window, the processing card and job runner,
   and the way a page selection is named.
   ============================================================ */
import { api } from '../api.js';
import { settings } from '../state.js';
import { createBird } from '../bird.js';
import { h, toast, openWindow, progress, pixelIcon, celebrate } from '../ui.js';
import { formatPages } from '/shared/pages.js';

/* ---------- module state ----------
   `gen` is the render generation. Every async continuation checks it, so a
   reply that lands after the learner navigated away paints nothing. */
let gen = 0;
export function nextGen() { return ++gen; }
export function isLive(my) { return my === gen; }
export function endGen() { gen++; }

export const STATUS = {
  new:        { label: 'new',        cls: '' },
  processing: { label: 'processing', cls: 'due' },
  draft:      { label: 'draft',      cls: 'on' },
  imported:   { label: 'imported',   cls: 'good' },
  error:      { label: 'error',      cls: 'bad' },
};

/* ---------- small helpers ---------- */
export const enc = encodeURIComponent;
export function todayYmd() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function bytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${Math.round(v / 1024)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}
export function statusTag(status) {
  const s = STATUS[status] || STATUS.new;
  return h('span', { class: `pl-tag ${s.cls}`.trim() }, s.label);
}
export function icon(name, cell = 2) { return pixelIcon(name, cell); }
export function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }
/* h() drops null children; the raw DOM methods stringify them into the word
   "null". Anywhere a child is conditional, it goes through these two. */
export function setKids(el, ...kids) {
  el.replaceChildren();
  return addKids(el, ...kids);
}
export function addKids(el, ...kids) {
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k);
  return el;
}
/* openWindow() mounts into #windows, outside the view, so a hash change (the
   Back button, a tap on the tab bar) would leave a modal floating over the
   next screen. Every window this view opens goes through here. */
let liveWin = null;
export function win(opts) {
  liveWin?.close();
  liveWin = openWindow({ ...opts, onClose: (r) => { liveWin = null; opts.onClose?.(r); } });
  return liveWin;
}
export function closeWin() { liveWin?.close(); liveWin = null; }

/* The two tabs of the Notes screen. They are links, not buttons: the choice lives
   in the URL (#/notes?tab=documents), so Back returns to the tab the learner
   came from and a reload keeps it. */
export function tabsEl(active) {
  const tab = (id, label, href, art) => h('a', {
    class: id === active ? 'is-active' : '', href, 'aria-current': id === active ? 'page' : undefined,
  }, icon(art), label);
  return h('nav', { class: 'seg nt-tabs', 'aria-label': 'Notes' },
    tab('notes', 'Class notes', '#/notes', 'notes'),
    tab('documents', 'Documents', '#/notes?tab=documents', 'doc'));
}
export function docPath(id) { return `/notes?tab=documents&doc=${enc(id)}`; }
export function docHref(id) { return `#${docPath(id)}`; }

/* ---------- models ---------- */
let modelsCache = null;
export function cachedModels() { return modelsCache; }
/* The model a lesson starts with: the top of the learner's priority list, or for
   photo notes the first one that can read photos. The server walks the rest of
   the list if it fails, so this names the first try, not a guarantee. */
export function resolvedExtractModel(withPhotos = false) {
  const order = Array.isArray(settings?.ai?.priority) ? settings.ai.priority : [];
  if (!withPhotos || !modelsCache) return order[0] || '';
  const vision = modelsCache.filter((m) => hasImageInput(m)).map((m) => m.id);
  return order.find((id) => vision.includes(id)) || order[0] || '';
}
export function hasImageInput(model) {
  return !model || (model.inputModalities || []).includes('image');
}
export async function loadModels() {
  if (modelsCache) return modelsCache;
  const raw = await api.get('/api/models');
  modelsCache = Array.isArray(raw) ? raw : (raw?.models || []);
  return modelsCache;
}
/* A model as a pill names it: "Claude Sonnet", not "claude-code:sonnet". Before the
   list has loaded, and for an id nothing on the list matches, the id itself. A dated
   id OpenRouter answered with is matched by its prefix. */
export function modelLabel(id) {
  const s = String(id || '');
  const m = (modelsCache || []).find((x) => s === x.id || s.startsWith(`${x.id}-`) || s.startsWith(`${x.id}:`));
  return m?.name || s;
}

/* ---------- the processing state ----------
   Used twice: straight after a save on #/notes, and when a note is opened
   while its job is still running. Documents use it a third time, after
   "Make lessons". */
export function processingCard({ model = '', text = '', hint = '' } = {}) {
  const bird = createBird({ size: 4, mood: 'think' });
  const bubble = h('div', { class: 'bubble' }, text || 'Reading your notes…');
  const bar = progress(1, 1, 'is-busy');
  const pill = h('span', { class: 'pill nt-model', hidden: !model }, modelLabel(model));
  const el = h('div', { class: 'card nt-processing' },
    h('div', { class: 'coach' }, bird.el, bubble),
    bar,
    h('div', { class: 'row row--wrap nt-processing-foot' },
      pill,
      h('span', { class: 'help' }, hint || 'Usually under a minute; pages from a document take longer. You can leave this screen.')));
  return {
    el,
    setProgress(t) { if (t) bubble.textContent = t; },
    setModel(m) { pill.textContent = modelLabel(m); pill.hidden = !m; },
  };
}

/* Jobs this page already watched fail. A note still marked "processing" after its
   job failed has lost that job (jobs live in the server's memory, so a restart
   drops them): polling it again would fail again, reload the note, and loop. */
const failedJobs = new Set();
export function jobFailed(jobId) { return failedJobs.has(jobId); }
export function forgetJob(jobId) { failedJobs.delete(jobId); }

/* Runs a process job and repaints when it settles. `host` is replaced by the
   processing card while it runs. */
export async function runJob({ host, jobId, model, my, text, hint, onDone }) {
  const card = processingCard({ model, text, hint });
  host.replaceChildren(card.el);
  try {
    await api.job(jobId, { onProgress: (t) => { if (isLive(my)) card.setProgress(t); } });
    if (!isLive(my)) return;
    onDone();
  } catch (e) {
    failedJobs.add(jobId);
    if (!isLive(my)) return;
    toast(e.message, 'bad');
    onDone();
  }
}

/* celebrate() drops its confetti into an element, and the repaint that follows an
   import replaces the view's children a moment later. A fixed layer of its own
   keeps the confetti falling over whatever is painted next. */
export function celebrateScreen() {
  const layer = h('div', { class: 'nt-confetti-layer', 'aria-hidden': 'true' });
  document.body.append(layer);
  celebrate(layer);
  setTimeout(() => layer.remove(), 3400);
}

/* ---------- page selections ---------- */
/* "page 25" or "pages 9–11, 25": formatPages() output reads as a list as soon as
   it holds a range or a comma. */
export function pagesWord(text) {
  const t = String(text || '');
  return /[–,-]/.test(t) ? `pages ${t}` : `page ${t}`;
}
/* How a note made from a document names its pages: in the numbering the learner
   typed them in. note.source.printed is that text; note.source.numbering says
   whether it was the book's printed numbers or the PDF's. */
export function sourcePagesText(source) {
  if (!source || typeof source !== 'object') return '';
  const typed = typeof source.printed === 'string' && source.printed.trim()
    ? source.printed.trim()
    : formatPages(Array.isArray(source.pages) ? source.pages : []);
  if (!typed) return '';
  return `${source.numbering === 'pdf' ? 'PDF ' : ''}${pagesWord(typed)}`;
}
