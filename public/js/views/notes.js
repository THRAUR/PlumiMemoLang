/* ============================================================
   notes.js — the pipeline that starts everything:
   raw class notes (typed, pasted or photographed) → an AI lesson
   draft the learner reviews → an imported lesson + words.

   Two screens in one module, because they are one flow:
     #/notes      compose + history
     #/notes/:id  the note, rendered by its status

   Nothing the model wrote is trusted: it stays plain text built with
   h() until the learner presses Import. Photos are downscaled in the
   browser BEFORE upload — a 4 MB phone shot becomes ~300 KB, which is
   what keeps `POST /api/notes` inside the 40 MB body limit and the
   vision bill small.
   ============================================================ */
import { api } from '../api.js';
import { settings, refreshStats } from '../state.js';
import { navigate } from '../router.js';
import { createBird } from '../bird.js';
import {
  h, toast, openWindow, confirmWindow, progress, emptyState, busy, celebrate,
  pixelIcon, fmt, markdownish, setTitle, readingEl,
} from '../ui.js';

/* ---------- tuning ---------- */
const MAX_SIDE = 1600;            // longest side of an uploaded photo, in px
const JPEG_QUALITY = 0.85;        // whiteboard text survives this comfortably
const RAW_PREVIEW_LINES = 6;      // how much of the raw notes shows collapsed

const STATUS = {
  new:        { label: 'new',        cls: '' },
  processing: { label: 'processing', cls: 'due' },
  draft:      { label: 'draft',      cls: 'on' },
  imported:   { label: 'imported',   cls: 'good' },
  error:      { label: 'error',      cls: 'bad' },
};
const POS = [['', '—'], ['n', 'noun'], ['v', 'verb'], ['adj', 'adjective'], ['adv', 'adverb'],
  ['mw', 'measure word'], ['conj', 'conjunction'], ['prep', 'preposition'], ['part', 'particle'],
  ['interj', 'interjection'], ['pron', 'pronoun'], ['num', 'number'], ['expr', 'expression']];
const TYPES = [['character', 'character'], ['word', 'word'], ['phrase', 'phrase'],
  ['sentence', 'sentence'], ['grammar', 'grammar']];

/* ---------- module state ----------
   `gen` is the render generation. Every async continuation checks it, so a
   reply that lands after the learner navigated away paints nothing. */
let gen = 0;
let modelsCache = null;
/* The compose box survives a trip into a note and back inside one session:
   losing a wall of pasted notes to a mistap would be unforgivable. */
const compose = { title: '', classDate: '', text: '', images: [] };

/* ---------- small helpers ---------- */
function todayYmd() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function bytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${Math.round(v / 1024)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}
function dataUrlBytes(dataUrl) {
  const b64 = String(dataUrl).split(',')[1] || '';
  const pad = (b64.match(/=+$/) || [''])[0].length;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}
function statusTag(status) {
  const s = STATUS[status] || STATUS.new;
  return h('span', { class: `pl-tag ${s.cls}`.trim() }, s.label);
}
function icon(name, cell = 2) { return pixelIcon(name, cell); }
function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }
/* h() drops null children; the raw DOM methods stringify them into the word
   "null". Anywhere a child is conditional, it goes through these two. */
function setKids(el, ...kids) {
  el.replaceChildren();
  return addKids(el, ...kids);
}
function addKids(el, ...kids) {
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k);
  return el;
}
/* openWindow() mounts into #windows, outside the view, so a hash change (the
   Back button, a tap on the tab bar) would leave a modal floating over the
   next screen. Every window this view opens goes through here. */
let liveWin = null;
function win(opts) {
  liveWin?.close();
  liveWin = openWindow({ ...opts, onClose: (r) => { liveWin = null; opts.onClose?.(r); } });
  return liveWin;
}
function closeWin() { liveWin?.close(); liveWin = null; }
function imgUrl(noteId, name) {
  return `/api/notes/${encodeURIComponent(noteId)}/images/${encodeURIComponent(name)}`;
}
function resolvedExtractModel() {
  const m = settings?.ai?.models || {};
  return m.extract || m.default || '';
}
function hasImageInput(model) {
  return !model || (model.inputModalities || []).includes('image');
}
async function loadModels() {
  if (modelsCache) return modelsCache;
  const raw = await api.get('/api/models');
  modelsCache = Array.isArray(raw) ? raw : (raw?.models || []);
  return modelsCache;
}

/* ---------- photo downscaling ----------
   <img> (not createImageBitmap) because Chrome applies the EXIF orientation
   to an <img>, so a portrait phone photo does not land sideways on canvas. */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`${file.name} is not an image this browser can read.`)); };
    img.src = url;
  });
}
async function shrink(file) {
  const img = await loadImage(file);
  const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
  if (!w0 || !h0) throw new Error(`${file.name} has no size this browser can read.`);
  const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale)), ht = Math.max(1, Math.round(h0 * scale));
  const canvas = h('canvas', { width: w, height: ht });
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot resize images.');
  /* JPEG has no alpha: paint white first or a transparent PNG turns black. */
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, ht);
  ctx.drawImage(img, 0, 0, w, ht);
  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  const name = String(file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg';
  return { name, type: 'image/jpeg', dataUrl, size: dataUrlBytes(dataUrl), w, h: ht, from: file.size || 0 };
}

/* ---------- the processing state ----------
   Used twice: straight after a save on #/notes, and when a note is opened
   while its job is still running. */
function processingCard({ model = '', text = '' } = {}) {
  const bird = createBird({ size: 4, mood: 'think' });
  const bubble = h('div', { class: 'bubble' }, text || 'Reading your notes…');
  const bar = progress(1, 1, 'is-busy');
  const pill = h('span', { class: 'pill nt-model', hidden: !model }, model || '');
  const el = h('div', { class: 'card nt-processing' },
    h('div', { class: 'coach' }, bird.el, bubble),
    bar,
    h('div', { class: 'row row--wrap nt-processing-foot' },
      pill,
      h('span', { class: 'help' }, 'This takes 10–60 seconds. You can leave this screen.')));
  return {
    el,
    setProgress(t) { if (t) bubble.textContent = t; },
    setModel(m) { pill.textContent = m || ''; pill.hidden = !m; },
  };
}

/* Runs a process job and repaints when it settles. `host` is replaced by the
   processing card while it runs. */
async function runJob({ host, jobId, model, my, onDone }) {
  const card = processingCard({ model });
  host.replaceChildren(card.el);
  try {
    await api.job(jobId, { onProgress: (t) => { if (my === gen) card.setProgress(t); } });
    if (my !== gen) return;
    onDone();
  } catch (e) {
    if (my !== gen) return;
    toast(e.message, 'bad');
    onDone();
  }
}

/* ============================================================
   #/notes — compose + history
   ============================================================ */
function composeWindow(my) {
  const title = h('input', { class: 'input', type: 'text', value: compose.title, placeholder: 'Class 12 — food', maxlength: 140 });
  const date = h('input', { class: 'input', type: 'date', value: compose.classDate || todayYmd() });
  const text = h('textarea', { class: 'textarea zh', rows: 7, placeholder: 'Paste everything: 生詞, the teacher\'s example sentences, your English scribbles…' });
  text.value = compose.text;
  const file = h('input', { class: 'nt-file', type: 'file', accept: 'image/*', multiple: true });
  const strip = h('div', { class: 'nt-strip', hidden: true });
  const sizeHelp = h('span', { class: 'help nt-size' });
  const addBtn = h('button', { class: 'btn btn--sm', type: 'button' }, icon('camera'), 'Add photos');
  const save = h('button', { class: 'btn btn--primary btn--block' }, icon('bolt'), 'Save notes');
  const jobHost = h('div', { class: 'nt-jobhost' });

  title.addEventListener('input', () => { compose.title = title.value; });
  date.addEventListener('change', () => { compose.classDate = date.value; });
  text.addEventListener('input', () => { compose.text = text.value; });
  compose.classDate = date.value;

  function paintStrip() {
    strip.replaceChildren();
    strip.hidden = compose.images.length === 0;
    let total = 0;
    for (const im of compose.images) {
      total += im.size;
      const cell = h('div', { class: 'nt-thumb' });
      cell.append(
        h('img', { src: im.dataUrl, alt: im.name }),
        h('button', {
          class: 'nt-thumb-x', type: 'button', 'aria-label': `Remove ${im.name}`, title: 'Remove',
          onClick: () => { compose.images = compose.images.filter((x) => x !== im); paintStrip(); },
        }, icon('x')),
        h('span', { class: 'nt-thumb-meta' }, bytes(im.size)));
      strip.append(cell);
    }
    sizeHelp.textContent = compose.images.length
      ? `${plural(compose.images.length, 'photo', 'photos')} · ${bytes(total)} after resizing to ${MAX_SIDE}px`
      : 'Photos are resized in your browser before they are sent.';
  }

  addBtn.addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const picked = [...(file.files || [])];
    file.value = '';
    if (!picked.length) return;
    busy(addBtn, true);
    for (const f of picked) {
      try { compose.images.push(await shrink(f)); } catch (e) { toast(e.message, 'bad'); }
    }
    busy(addBtn, false);
    if (my === gen) paintStrip();
  });

  save.addEventListener('click', async () => {
    const body = {
      title: title.value.trim(),
      classDate: date.value || null,
      text: text.value.trim(),
      images: compose.images.map((im) => ({ name: im.name, type: im.type, dataUrl: im.dataUrl })),
    };
    if (!body.text && !body.images.length) {
      toast('Paste some notes or add a photo first.', 'bad');
      text.focus();
      return;
    }
    busy(save, true);
    let note;
    try {
      note = await api.post('/api/notes', body);
    } catch (e) {
      busy(save, false);
      toast(e.message, 'bad');
      return;
    }
    if (my !== gen) return;
    compose.title = ''; compose.text = ''; compose.images = [];
    title.value = ''; text.value = ''; paintStrip();
    busy(save, false);

    if (!settings?.ai?.hasApiKey) {
      toast('Saved. Add your OpenRouter key in Settings to turn notes into a lesson.', '', 5200);
      navigate('/notes/' + note.id);
      return;
    }
    let jobId = null;
    try {
      ({ jobId } = await api.post(`/api/notes/${note.id}/process`, {}));
    } catch (e) {
      if (my !== gen) return;
      toast(e.message, 'bad');
      navigate('/notes/' + note.id);
      return;
    }
    if (my !== gen) return;
    await runJob({
      host: jobHost, jobId, my,
      model: resolvedExtractModel(),
      onDone: () => navigate('/notes/' + note.id),
    });
  });

  paintStrip();

  return h('section', { class: 'pl-win nt-compose' },
    h('div', { class: 'pl-titlebar' }, h('span', { class: 'pl-title' }, 'Add class notes'), h('span', { class: 'spacer' })),
    h('div', { class: 'win-body' },
      h('div', { class: 'grid-2' },
        h('label', { class: 'field' }, h('span', { class: 'label' }, 'Title'), title),
        h('label', { class: 'field' }, h('span', { class: 'label' }, 'Class date'), date)),
      h('label', { class: 'field' },
        h('span', { class: 'label' }, 'Raw notes'), text,
        h('span', { class: 'help' }, 'Chinese, English, arrows, your own shorthand — Plumi sorts it out.')),
      h('div', { class: 'field' },
        h('span', { class: 'label' }, 'Photos'),
        h('div', { class: 'row row--wrap' }, addBtn, file, sizeHelp),
        strip),
      save,
      jobHost));
}

function historyRow(note) {
  const excerpt = String(note.excerpt || note.text || '').replace(/\s+/g, ' ').trim();
  return h('a', { class: 'list-row nt-row', href: `#/notes/${encodeURIComponent(note.id)}` },
    h('span', { class: 'grow' },
      h('span', { class: 'nt-row-top' },
        h('b', { class: 'nt-row-title ellipsis' }, note.title || 'Untitled'),
        statusTag(note.status)),
      h('span', { class: 'nt-row-meta' },
        note.classDate ? h('span', null, fmt.date(note.classDate)) : null,
        note.imageCount || note.images?.length
          ? h('span', { class: 'nt-row-shots' }, icon('camera'), String(note.imageCount ?? note.images.length))
          : null,
        h('span', null, fmt.rel(note.createdAt))),
      excerpt ? h('span', { class: 'nt-row-excerpt ellipsis' }, excerpt) : null));
}

async function renderIndex(root) {
  const my = ++gen;
  const listHost = h('div', { class: 'nt-history' },
    h('p', { class: 'pl-eyebrow' }, 'Your notes'),
    h('div', { class: 'card card--sunk card--flat nt-loading' }, h('p', { class: 'help' }, 'Loading your notes…')));
  root.replaceChildren(composeWindow(my), listHost);
  setTitle('Notes');

  let notes = [];
  try {
    const res = await api.get('/api/notes');
    notes = Array.isArray(res) ? res : (res?.notes || []);
  } catch (e) {
    if (my !== gen) return;
    toast(e.message, 'bad');
    listHost.replaceChildren(
      h('p', { class: 'pl-eyebrow' }, 'Your notes'),
      h('div', { class: 'card card--sunk card--flat' },
        h('p', { class: 'help' }, 'Your notes could not load.'),
        h('p', { class: 'help' }, e.message)));
    return;
  }
  if (my !== gen) return;
  listHost.replaceChildren(
    h('p', { class: 'pl-eyebrow' }, 'Your notes'),
    notes.length
      ? h('div', { class: 'list' }, notes.map(historyRow))
      : h('div', { class: 'card' }, emptyState({
        bird: createBird({ size: 4, mood: 'sleep' }).el,
        title: 'No notes yet',
        text: 'Paste your first class notes above. Plumi turns them into a lesson and your first cards.',
      })));
}

/* ============================================================
   #/notes/:id — one note, rendered by its status
   ============================================================ */
function noteHeader(note, my, reload) {
  const cost = Number(note.usage?.cost || 0);
  return h('section', { class: 'card nt-head' },
    h('div', { class: 'row nt-head-top' },
      h('h1', { class: 'h2 grow nt-title' }, note.title || 'Untitled'),
      h('button', {
        class: 'btn btn--sm btn--quiet', type: 'button', title: 'Rename',
        onClick: () => renameWindow(note, (updated) => { if (my === gen) reload(updated); }),
      }, icon('notes'), 'Rename')),
    h('div', { class: 'row row--wrap nt-head-meta' },
      statusTag(note.status),
      note.classDate ? h('span', { class: 'muted small' }, fmt.date(note.classDate)) : null,
      h('span', { class: 'muted small' }, fmt.rel(note.createdAt)),
      note.model ? h('span', { class: 'pill nt-model' }, note.model) : null,
      cost ? h('span', { class: 'pill' }, fmt.usd(cost)) : null));
}

function renameWindow(note, onSaved) {
  const title = h('input', { class: 'input', type: 'text', value: note.title || '', placeholder: 'Class 12 — food', maxlength: 140 });
  const date = h('input', { class: 'input', type: 'date', value: note.classDate || '' });
  win({
    title: 'Rename notes',
    body: h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Title'), title),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Class date'), date)),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save', primary: true, onClick: async () => {
          const updated = await api.put(`/api/notes/${encodeURIComponent(note.id)}`, {
            title: title.value.trim(), classDate: date.value || null,
          });
          toast('Renamed');
          onSaved(updated);
        },
      },
    ],
  });
}

function rawBlock(note) {
  const text = String(note.text || '');
  if (!text.trim()) return null;
  const lines = text.split(/\r?\n/);
  const short = lines.slice(0, RAW_PREVIEW_LINES).join('\n');
  const pre = h('pre', { class: 'nt-raw zh', lang: 'zh-Hant' }, lines.length > RAW_PREVIEW_LINES ? short : text);
  const more = lines.length > RAW_PREVIEW_LINES
    ? h('button', { class: 'btn btn--sm btn--ghost', type: 'button' }, `Show all ${lines.length} lines`)
    : null;
  if (more) {
    let open = false;
    more.addEventListener('click', () => {
      open = !open;
      pre.textContent = open ? text : short;
      more.textContent = open ? 'Show less' : `Show all ${lines.length} lines`;
    });
  }
  return h('section', { class: 'card card--sunk nt-rawbox' },
    h('p', { class: 'pl-eyebrow' }, 'Raw notes'), pre, more);
}

function galleryBlock(note) {
  if (!note.images?.length) return null;
  const strip = h('div', { class: 'nt-gallery' });
  for (const im of note.images) {
    const src = imgUrl(note.id, im.name);
    const cell = h('button', {
      class: 'nt-shot', type: 'button', title: im.name,
      onClick: () => win({ title: im.name, wide: true, body: h('img', { class: 'nt-shot-full', src, alt: im.name }) }),
    });
    const img = h('img', { src, alt: im.name, loading: 'lazy' });
    /* A missing upload must not leave a broken-image glyph on the page. */
    img.addEventListener('error', () => cell.replaceChildren(h('span', { class: 'nt-shot-gone' }, 'missing')));
    cell.append(img);
    strip.append(cell);
  }
  return h('section', { class: 'nt-gallerybox' },
    h('p', { class: 'pl-eyebrow' }, plural(note.images.length, 'Photo', 'Photos')), strip);
}

/* --- new / error: choose a model and run extract --- */
function processBlock(note, my, reload) {
  const box = h('section', { class: 'stack nt-run' });
  if (note.error) {
    box.append(h('div', { class: 'card nt-error' },
      h('div', { class: 'row' }, statusTag('error'), h('span', { class: 'pl-eyebrow no-rule' }, 'Last attempt')),
      h('p', null, note.error)));
  }
  if (!settings?.ai?.hasApiKey) {
    box.append(h('div', { class: 'card nt-nokey' },
      h('p', { class: 'h3' }, 'No OpenRouter key yet'),
      h('p', { class: 'muted' }, 'Plumi needs a key to read these notes and write the lesson. Your notes stay on this machine until you ask for one.'),
      h('a', { class: 'btn btn--primary', href: '#/settings' }, icon('settings'), 'Open Settings')));
    return box;
  }

  const sel = h('select', { class: 'select' }, h('option', { value: '' }, 'Loading models…'));
  sel.disabled = true;
  const warn = h('p', { class: 'help nt-warn' });
  warn.hidden = true;
  const go = h('button', { class: 'btn btn--primary btn--block' },
    icon('bolt'), note.status === 'error' ? 'Try again' : 'Turn into a lesson');

  function checkWarning() {
    const chosen = (modelsCache || []).find((m) => m.id === sel.value);
    const blind = chosen && !hasImageInput(chosen);
    warn.hidden = !(blind && note.images?.length);
    warn.textContent = 'This model cannot see images — only the typed notes would be sent. Pick one tagged for images.';
  }
  sel.addEventListener('change', checkWarning);

  loadModels().then((models) => {
    if (my !== gen) return;
    const want = resolvedExtractModel();
    const opts = models.map((m) => h('option', { value: m.id },
      `${m.name || m.id}${hasImageInput(m) ? '' : ' (text only)'}`));
    if (want && !models.some((m) => m.id === want)) opts.unshift(h('option', { value: want }, want));
    if (!opts.length) opts.push(h('option', { value: '' }, 'Server default'));
    sel.replaceChildren(...opts);
    sel.value = want && opts.some((o) => o.value === want) ? want : opts[0].value;
    sel.disabled = false;
    checkWarning();
  }).catch((e) => {
    if (my !== gen) return;
    toast(e.message, 'bad');
    const want = resolvedExtractModel();
    sel.replaceChildren(h('option', { value: want }, want || 'Server default'));
    sel.disabled = false;
  });

  go.addEventListener('click', async () => {
    busy(go, true);
    let jobId = null;
    try {
      ({ jobId } = await api.post(`/api/notes/${encodeURIComponent(note.id)}/process`, sel.value ? { model: sel.value } : {}));
    } catch (e) {
      busy(go, false);
      toast(e.message, 'bad');
      return;
    }
    if (my !== gen) return;
    await runJob({ host: box, jobId, my, model: sel.value || resolvedExtractModel(), onDone: () => reload() });
  });

  box.append(h('div', { class: 'card nt-runcard' },
    h('p', { class: 'pl-eyebrow' }, 'Turn these notes into a lesson'),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Model'), sel, warn),
    go));
  return box;
}

/* --- draft: the lesson preview --- */
function exampleEl(ex) {
  if (!ex) return null;
  const reading = readingEl({ pinyin: ex.pinyin, zhuyin: ex.zhuyin }, { both: true });
  return h('div', { class: 'example' },
    ex.zh ? h('div', { class: 'zh', lang: 'zh-Hant' }, ex.zh) : null,
    reading,
    ex.translation ? h('div', { class: 'tr' }, ex.translation) : null);
}
function lessonPreview(lesson) {
  const l = lesson || {};
  const sections = Array.isArray(l.sections) ? l.sections : [];
  const grammar = Array.isArray(l.grammar) ? l.grammar : [];
  const dialogue = Array.isArray(l.dialogue) ? l.dialogue : [];
  const body = h('div', { class: 'win-body nt-preview' });
  addKids(body,
    h('h2', { class: 'h2' }, l.title || 'Untitled lesson'),
    l.summary ? h('p', { class: 'muted' }, l.summary) : null);

  const sectionEl = (s) => h('div', { class: 'nt-section' },
    h('p', { class: 'pl-eyebrow' }, s.kind || 'text'),
    s.title ? h('h3', { class: 'h3' }, s.title) : null,
    s.titleZh ? h('div', { class: 'nt-section-zh zh', lang: 'zh-Hant' }, s.titleZh) : null,
    s.body ? markdownish(s.body) : null);

  if (sections[0]) body.append(sectionEl(sections[0]));

  const rest = h('div', { class: 'nt-more' });
  for (const s of sections.slice(1)) rest.append(sectionEl(s));
  if (grammar.length) {
    rest.append(h('p', { class: 'pl-eyebrow' }, 'Grammar'));
    for (const g of grammar) {
      rest.append(h('div', { class: 'nt-grammar' },
        h('div', { class: 'nt-pattern zh', lang: 'zh-Hant' }, g.pattern || ''),
        g.explanation ? h('p', null, g.explanation) : null,
        (Array.isArray(g.examples) ? g.examples : []).map(exampleEl)));
    }
  }
  if (dialogue.length) {
    rest.append(h('p', { class: 'pl-eyebrow' }, 'Dialogue'));
    const lines = h('div', { class: 'nt-dialogue' });
    for (const d of dialogue) {
      lines.append(h('div', { class: 'nt-line' },
        h('span', { class: 'nt-speaker' }, d.speaker || '·'),
        h('span', { class: 'grow' },
          h('span', { class: 'zh nt-line-zh', lang: 'zh-Hant' }, d.zh || ''),
          readingEl({ pinyin: d.pinyin, zhuyin: d.zhuyin }, { both: true }),
          d.translation ? h('span', { class: 'nt-line-tr' }, d.translation) : null)));
    }
    rest.append(lines);
  }
  const hasMore = rest.childElementCount > 0;
  if (hasMore) {
    rest.hidden = true;
    const more = h('button', { class: 'btn btn--sm btn--ghost', type: 'button' }, 'Show more');
    more.addEventListener('click', () => {
      rest.hidden = !rest.hidden;
      more.textContent = rest.hidden ? 'Show more' : 'Show less';
    });
    body.append(rest, more);
  }

  return h('section', { class: 'pl-win nt-lesson' },
    h('div', { class: 'pl-titlebar' },
      h('span', { class: 'pl-title zh', lang: 'zh-Hant' }, l.titleZh || l.title || 'Lesson'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'pl-tag on' }, 'draft')),
    body);
}

function wordEditor(word, onSave) {
  const f = {};
  const field = (key, label, extra = {}) => {
    const input = h('input', { class: `input${extra.zh ? ' zh' : ''}`, type: 'text', value: word[key] || '', lang: extra.lang || undefined });
    f[key] = () => input.value.trim();
    return h('label', { class: 'field' }, h('span', { class: 'label' }, label), input);
  };
  const pick = (key, label, options) => {
    const sel = h('select', { class: 'select' }, options.map(([v, t]) => h('option', { value: v }, t)));
    sel.value = options.some(([v]) => v === (word[key] || '')) ? (word[key] || '') : options[0][0];
    f[key] = () => sel.value;
    return h('label', { class: 'field' }, h('span', { class: 'label' }, label), sel);
  };
  win({
    title: 'Edit word',
    wide: true,
    body: h('div', { class: 'stack' },
      field('hanzi', 'Hanzi (Traditional)', { zh: true, lang: 'zh-Hant' }),
      h('div', { class: 'grid-2' },
        field('pinyin', 'Pinyin (tone marks)'),
        field('zhuyin', '注音 Zhuyin', { zh: true, lang: 'zh-Hant' })),
      field('meaning', 'Meaning (English)'),
      field('meaningNative', 'Meaning (your language)'),
      h('div', { class: 'grid-2' }, pick('pos', 'Part of speech', POS), pick('type', 'Type', TYPES))),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save', primary: true, onClick: async () => {
          const patch = {};
          for (const [k, get] of Object.entries(f)) patch[k] = get();
          if (!patch.hanzi) { toast('A word needs its characters.', 'bad'); return false; }
          await onSave(patch);
        },
      },
    ],
  });
}

function draftBlock(note, my, reload) {
  const draft = note.draft || {};
  const words = Array.isArray(draft.words) ? draft.words : [];
  const box = h('section', { class: 'stack nt-draft' });
  box.append(h('p', { class: 'pl-eyebrow' }, 'Review the draft'), lessonPreview(draft.lesson));

  const boxes = [];
  const list = h('div', { class: 'list nt-words' });
  const rowFor = (w, i) => {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = !w.isKnown;
    boxes[i] = cb;
    const row = h('div', { class: 'list-row nt-word' });
    const paint = () => {
      const reading = readingEl(w, { both: true });
      row.replaceChildren(
        h('label', { class: 'check nt-check' }, cb, h('span', { class: 'sr-only' }, `Import ${w.hanzi || 'this word'}`)),
        h('div', { class: 'grow nt-word-main' },
          h('div', { class: 'row row--wrap nt-word-top' },
            h('span', { class: 'hz hz--md', lang: 'zh-Hant' }, w.hanzi || '—'),
            reading),
          /* The tags ride with the meaning, not with the readings: a long
             zhuyin string would otherwise push them onto a line of their own
             and every row would wrap differently. */
          h('div', { class: 'row row--wrap nt-word-meaning' },
            h('span', { class: 'grow' }, w.meaning || h('span', { class: 'faint' }, 'no meaning yet')),
            w.pos ? h('span', { class: 'pl-tag' }, w.pos) : null,
            w.isKnown ? h('span', { class: 'pl-tag' }, 'known') : null),
          w.meaningNative ? h('div', { class: 'nt-word-native muted small' }, w.meaningNative) : null),
        h('button', {
          class: 'btn btn--icon btn--sm', type: 'button', 'aria-label': `Edit ${w.hanzi || 'word'}`, title: 'Edit',
          onClick: () => wordEditor(w, async (patch) => {
            /* The whole draft goes back to the server, so the edit has to be
               applied first — and rolled back if the write fails, or the copy
               in memory would drift from the stored one. */
            const before = { ...w };
            Object.assign(w, patch);
            let saved;
            try {
              saved = await api.put(`/api/notes/${encodeURIComponent(note.id)}/draft`, { draft });
            } catch (e) {
              Object.assign(w, before);
              throw e;                      // openWindow toasts and keeps the window open
            }
            toast('Saved');
            if (my !== gen) return;
            if (saved?.draft?.words?.[i]) Object.assign(w, saved.draft.words[i]);
            paint();
          }),
        }, icon('notes')));
    };
    paint();
    cb.addEventListener('change', updateBar);
    return row;
  };
  list.append(...words.map(rowFor));

  /* --- the sticky import bar --- */
  const count = h('span', { class: 'nt-import-count' });
  const selectBtn = h('button', { class: 'btn btn--sm btn--quiet', type: 'button' }, 'Select all');
  const reBtn = h('button', { class: 'btn btn--sm btn--quiet', type: 'button' }, icon('refresh'), 'Reprocess');
  const importBtn = h('button', { class: 'btn btn--primary btn--block' }, icon('check'), 'Import');
  function chosen() { return boxes.map((cb, i) => (cb.checked ? i : -1)).filter((i) => i >= 0); }
  function updateBar() {
    const n = chosen().length;
    importBtn.replaceChildren(icon('check'), `Import ${plural(n, 'word', 'words')} + lesson`);
    importBtn.disabled = false;
    count.textContent = `${n} / ${words.length} selected`;
    selectBtn.textContent = n === words.length && words.length ? 'Select none' : 'Select all';
  }
  selectBtn.addEventListener('click', () => {
    const all = chosen().length === words.length && words.length > 0;
    for (const cb of boxes) cb.checked = !all;
    updateBar();
  });
  reBtn.addEventListener('click', async () => {
    if (!(await confirmWindow({
      title: 'Reprocess these notes?',
      text: 'Plumi reads the notes again and replaces this draft. Your edits to the draft are lost.',
      okLabel: 'Reprocess',
    }))) return;
    busy(reBtn, true);
    let jobId = null;
    try {
      ({ jobId } = await api.post(`/api/notes/${encodeURIComponent(note.id)}/process`, {}));
    } catch (e) {
      busy(reBtn, false);
      toast(e.message, 'bad');
      return;
    }
    if (my !== gen) return;
    await runJob({ host: box, jobId, my, model: note.model || resolvedExtractModel(), onDone: () => reload() });
  });
  importBtn.addEventListener('click', async () => {
    busy(importBtn, true);
    let res;
    try {
      res = await api.post(`/api/notes/${encodeURIComponent(note.id)}/import`, { words: chosen(), lesson: true });
    } catch (e) {
      busy(importBtn, false);
      toast(e.message, 'bad');
      return;
    }
    if (my !== gen) return;
    celebrate(document.getElementById('view') || document.body);
    toast('Lesson created · +10 XP', 'ok');
    await refreshStats();
    if (my !== gen) return;
    if (res?.lessonId) navigate('/lessons/' + res.lessonId);
    else reload();
  });

  updateBar();
  box.append(
    h('div', { class: 'section-head nt-words-head' },
      h('p', { class: 'pl-eyebrow' }, `Words (${words.length})`)),
    words.length ? list : h('div', { class: 'card card--sunk' }, h('p', { class: 'help' }, 'The model found no words in these notes. Try reprocessing with a stronger model.')),
    h('div', { class: 'nt-import' },
      h('div', { class: 'row row--wrap nt-import-top' }, selectBtn, reBtn, h('span', { class: 'grow' }), count),
      importBtn));
  return box;
}

function importedBlock(note) {
  const imp = note.imported || {};
  const added = imp.wordIds?.length || 0;
  const merged = imp.mergedHanzi?.length || 0;
  return h('section', { class: 'card nt-imported' },
    h('div', { class: 'row' }, icon('check', 3), h('p', { class: 'h3 grow' }, 'Imported')),
    h('p', { class: 'muted' },
      `${plural(added, 'word', 'words')} added, ${merged} ${merged === 1 ? 'was' : 'were'} already known.`),
    imp.lessonId
      ? h('p', null, h('a', { href: `#/lessons/${encodeURIComponent(imp.lessonId)}` }, note.draft?.lesson?.title || 'The lesson'))
      : null,
    h('div', { class: 'row row--wrap' },
      imp.lessonId ? h('a', { class: 'btn btn--primary', href: `#/lessons/${encodeURIComponent(imp.lessonId)}` }, icon('lessons'), 'Open lesson') : null,
      imp.lessonId ? h('a', { class: 'btn', href: `#/review?lesson=${encodeURIComponent(imp.lessonId)}` }, icon('review'), 'Practice') : null));
}

function footerBlock(note, my) {
  const del = h('button', { class: 'btn btn--danger btn--sm', type: 'button' }, icon('trash'), 'Delete notes');
  del.addEventListener('click', async () => {
    if (!(await confirmWindow({
      title: 'Delete these notes?',
      text: 'The notes and their photos go away. Words and lessons you already imported stay.',
      okLabel: 'Delete',
      danger: true,
    }))) return;
    busy(del, true);
    try {
      await api.del(`/api/notes/${encodeURIComponent(note.id)}`);
    } catch (e) {
      busy(del, false);
      toast(e.message, 'bad');
      return;
    }
    if (my !== gen) return;
    toast('Notes deleted');
    navigate('/notes');
  });
  return h('section', { class: 'nt-foot' }, del);
}

function paintNote(root, note, my, reload) {
  setKids(root,
    h('a', { class: 'btn btn--sm btn--quiet nt-back', href: '#/notes' }, icon('back'), 'All notes'),
    noteHeader(note, my, reload),
    rawBlock(note),
    galleryBlock(note),
    note.status === 'draft' ? draftBlock(note, my, reload) : null,
    note.status === 'imported' ? importedBlock(note) : null,
    note.status === 'processing' ? processingBlock(note, my, reload) : null,
    note.status === 'new' || note.status === 'error' ? processBlock(note, my, reload) : null,
    footerBlock(note, my));
  setTitle(note.title || 'Notes');
}

function processingBlock(note, my, reload) {
  const box = h('section', { class: 'stack nt-run' });
  if (note.jobId) {
    runJob({ host: box, jobId: note.jobId, my, model: note.model || resolvedExtractModel(), onDone: () => reload() });
    return box;
  }
  const card = processingCard({ model: note.model || resolvedExtractModel(), text: 'Working on your notes…' });
  const again = h('button', { class: 'btn btn--sm btn--ghost', type: 'button', onClick: () => reload() }, icon('refresh'), 'Check again');
  box.append(card.el, again);
  return box;
}

async function renderDetail(root, id) {
  const my = ++gen;
  root.replaceChildren(
    h('a', { class: 'btn btn--sm btn--quiet nt-back', href: '#/notes' }, icon('back'), 'All notes'),
    h('div', { class: 'card card--sunk card--flat' }, h('p', { class: 'help' }, 'Loading…')));
  setTitle('Notes');

  const reload = async (given) => {
    if (my !== gen) return;
    if (given) { paintNote(root, given, my, reload); return; }
    try {
      const fresh = await api.get(`/api/notes/${encodeURIComponent(id)}`);
      if (my !== gen) return;
      paintNote(root, fresh, my, reload);
    } catch (e) {
      if (my !== gen) return;
      toast(e.message, 'bad');
    }
  };

  let note;
  try {
    note = await api.get(`/api/notes/${encodeURIComponent(id)}`);
  } catch (e) {
    if (my !== gen) return;
    toast(e.message, 'bad');
    root.replaceChildren(
      h('a', { class: 'btn btn--sm btn--quiet nt-back', href: '#/notes' }, icon('back'), 'All notes'),
      h('div', { class: 'card' },
        h('p', { class: 'h3' }, 'These notes could not load.'),
        h('p', { class: 'muted' }, e.message),
        h('a', { class: 'btn', href: '#/notes' }, 'Back to your notes')));
    setTitle('Notes');
    return;
  }
  if (my !== gen) return;
  paintNote(root, note, my, reload);
}

/* ---------- the view ---------- */
export default {
  id: 'notes',
  title: 'Notes',
  async render(root, params) {
    if (params?.id) await renderDetail(root, params.id);
    else await renderIndex(root);
  },
  unmount() {
    /* Bumping the generation is most of the teardown: every pending job poll,
       fetch and image read checks it before touching the DOM. */
    gen++;
    closeWin();
  },
};
