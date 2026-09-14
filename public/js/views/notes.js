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

   Documents (§8.6) joined the flow as a second tab: a textbook PDF
   uploaded once, and after each class a page pick that becomes one to
   four lessons (§8.5). Those screens are parts of this view:
     #/notes?tab=documents            the library     (notes-docs.js)
     #/notes?tab=documents&doc=<id>   a document and its page picker
   The draft review lives in notes-draft.js; notes-kit.js holds what
   the three share.
   ============================================================ */
import { api } from '../api.js';
import { settings, refreshStats } from '../state.js';
import { navigate } from '../router.js';
import { createBird } from '../bird.js';
import { h, toast, confirmWindow, emptyState, busy, fmt, setTitle } from '../ui.js';
import {
  nextGen, endGen, isLive, enc, bytes, todayYmd, statusTag, icon, plural, setKids, win, closeWin, tabsEl,
  resolvedExtractModel, hasImageInput, loadModels, cachedModels, processingCard, runJob, jobFailed, forgetJob,
  sourcePagesText,
} from './notes-kit.js';
import { renderDocuments } from './notes-docs.js';
import { draftBlock, importedBlock, sourceBlock } from './notes-draft.js';

/* ---------- tuning ---------- */
const MAX_SIDE = 1600;            // longest side of an uploaded photo, in px
const JPEG_QUALITY = 0.85;        // whiteboard text survives this comfortably
const RAW_PREVIEW_LINES = 6;      // how much of the raw notes shows collapsed

/* The compose box survives a trip into a note and back inside one session:
   losing a wall of pasted notes to a mistap would be unforgivable. */
const compose = { title: '', classDate: '', text: '', images: [] };

/* ---------- small helpers ---------- */
function dataUrlBytes(dataUrl) {
  const b64 = String(dataUrl).split(',')[1] || '';
  const pad = (b64.match(/=+$/) || [''])[0].length;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}
function imgUrl(noteId, name) {
  return `/api/notes/${enc(noteId)}/images/${enc(name)}`;
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
    if (isLive(my)) paintStrip();
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
    if (!isLive(my)) return;
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
      if (!isLive(my)) return;
      toast(e.message, 'bad');
      navigate('/notes/' + note.id);
      return;
    }
    if (!isLive(my)) return;
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
  const pages = sourcePagesText(note.source);
  return h('a', { class: 'list-row nt-row', href: `#/notes/${enc(note.id)}` },
    h('span', { class: 'grow' },
      h('span', { class: 'nt-row-top' },
        h('b', { class: 'nt-row-title ellipsis' }, note.title || 'Untitled'),
        statusTag(note.status)),
      h('span', { class: 'nt-row-meta' },
        /* A page pick from a document is marked as one, with its pages. */
        note.source ? h('span', { class: 'nt-row-doc' }, icon('doc'), pages || 'document') : null,
        note.classDate ? h('span', null, fmt.date(note.classDate)) : null,
        note.imageCount || note.images?.length
          ? h('span', { class: 'nt-row-shots' }, icon('camera'), String(note.imageCount ?? note.images.length))
          : null,
        note.draftLessons > 1 ? h('span', null, plural(note.draftLessons, 'lesson', 'lessons')) : null,
        h('span', null, fmt.rel(note.createdAt))),
      excerpt ? h('span', { class: 'nt-row-excerpt ellipsis' }, excerpt) : null));
}

async function renderIndex(root) {
  const my = nextGen();
  const listHost = h('div', { class: 'nt-history' },
    h('p', { class: 'pl-eyebrow' }, 'Your notes'),
    h('div', { class: 'card card--sunk card--flat nt-loading' }, h('p', { class: 'help' }, 'Loading your notes…')));
  root.replaceChildren(tabsEl('notes'), composeWindow(my), listHost);
  setTitle('Notes');

  let notes = [];
  try {
    const res = await api.get('/api/notes');
    notes = Array.isArray(res) ? res : (res?.notes || []);
  } catch (e) {
    if (!isLive(my)) return;
    toast(e.message, 'bad');
    listHost.replaceChildren(
      h('p', { class: 'pl-eyebrow' }, 'Your notes'),
      h('div', { class: 'card card--sunk card--flat' },
        h('p', { class: 'help' }, 'Your notes could not load.'),
        h('p', { class: 'help' }, e.message)));
    return;
  }
  if (!isLive(my)) return;
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
        onClick: () => renameWindow(note, (updated) => { if (isLive(my)) reload(updated); }),
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
          const updated = await api.put(`/api/notes/${enc(note.id)}`, {
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
  /* A page pick keeps the learner's instructions where class notes keep the notes. */
  return h('section', { class: 'card card--sunk nt-rawbox' },
    h('p', { class: 'pl-eyebrow' }, note.source ? 'Your instructions' : 'Raw notes'), pre, more);
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
  /* Pages from a document reach the model as images, like photos do. */
  const withImages = Boolean(note.images?.length || note.source);
  if (note.error) {
    box.append(h('div', { class: 'card nt-error' },
      h('div', { class: 'row' }, statusTag('error'), h('span', { class: 'pl-eyebrow no-rule' }, 'Last attempt')),
      h('p', null, note.error)));
  }
  if (!settings?.ai?.hasApiKey) {
    box.append(h('div', { class: 'card nt-nokey' },
      h('p', { class: 'h3' }, 'No OpenRouter key yet'),
      h('p', { class: 'muted' }, note.source
        ? 'Plumi needs a key to read these pages and write the lessons. The document stays on this machine until you ask for one.'
        : 'Plumi needs a key to read these notes and write the lesson. Your notes stay on this machine until you ask for one.'),
      h('a', { class: 'btn btn--primary', href: '#/settings' }, icon('settings'), 'Open Settings')));
    return box;
  }

  const sel = h('select', { class: 'select' }, h('option', { value: '' }, 'Loading models…'));
  sel.disabled = true;
  const warn = h('p', { class: 'help nt-warn' });
  warn.hidden = true;
  const go = h('button', { class: 'btn btn--primary btn--block' },
    icon('bolt'), note.status === 'error' ? 'Try again' : note.source ? 'Make lessons' : 'Turn into a lesson');

  function checkWarning() {
    const chosen = (cachedModels() || []).find((m) => m.id === sel.value);
    const blind = chosen && !hasImageInput(chosen);
    warn.hidden = !(blind && withImages);
    warn.textContent = note.source
      ? 'This model cannot read page images, so Plumi starts with the next model on your list that can.'
      : 'This model cannot read photos, so Plumi starts with the next model on your list that can.';
  }
  sel.addEventListener('change', checkWarning);

  loadModels().then((models) => {
    if (!isLive(my)) return;
    const want = resolvedExtractModel(withImages);
    const opts = models.map((m) => h('option', { value: m.id },
      `${m.rank ? `${m.rank}. ` : ''}${m.name || m.id}${hasImageInput(m) ? '' : ' · text only'}`));
    if (want && !models.some((m) => m.id === want)) opts.unshift(h('option', { value: want }, want));
    if (!opts.length) opts.push(h('option', { value: '' }, 'Server default'));
    sel.replaceChildren(...opts);
    sel.value = want && opts.some((o) => o.value === want) ? want : opts[0].value;
    sel.disabled = false;
    checkWarning();
  }).catch((e) => {
    if (!isLive(my)) return;
    toast(e.message, 'bad');
    const want = resolvedExtractModel();
    sel.replaceChildren(h('option', { value: want }, want || 'Server default'));
    sel.disabled = false;
  });

  go.addEventListener('click', async () => {
    busy(go, true);
    let jobId = null;
    try {
      ({ jobId } = await api.post(`/api/notes/${enc(note.id)}/process`, sel.value ? { model: sel.value } : {}));
    } catch (e) {
      busy(go, false);
      toast(e.message, 'bad');
      return;
    }
    if (!isLive(my)) return;
    await runJob({ host: box, jobId, my, model: sel.value || resolvedExtractModel(withImages), onDone: () => reload() });
  });

  box.append(h('div', { class: 'card nt-runcard' },
    h('p', { class: 'pl-eyebrow' }, note.source ? 'Make lessons from these pages' : 'Turn these notes into a lesson'),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Start with'), sel, warn,
      h('span', { class: 'help' }, 'If it fails, Plumi moves down the model list in Settings.')),
    go));
  return box;
}

function processingBlock(note, my, reload) {
  const box = h('section', { class: 'stack nt-run' });
  const model = note.model || resolvedExtractModel(Boolean(note.images?.length || note.source));
  if (note.jobId && !jobFailed(note.jobId)) {
    runJob({ host: box, jobId: note.jobId, my, model, onDone: () => reload() });
    return box;
  }
  if (note.jobId) {
    box.append(stalledCard(note, my, reload, box, model));
    return box;
  }
  const card = processingCard({ model, text: note.source ? 'Working on the pages…' : 'Working on your notes…' });
  const again = h('button', { class: 'btn btn--sm btn--ghost', type: 'button', onClick: () => reload() }, icon('refresh'), 'Check again');
  box.append(card.el, again);
  return box;
}

/* The note says "processing" but its job is gone: the server restarted mid-run
   (jobs live in its memory) or the connection dropped while polling. Polling on
   its own would fail again and reload in a loop, so the learner decides. */
function stalledCard(note, my, reload, box, model) {
  const start = h('button', { class: 'btn btn--primary', type: 'button' }, icon('bolt'), 'Start again');
  const check = h('button', { class: 'btn', type: 'button' }, icon('refresh'), 'Check again');
  check.addEventListener('click', () => { forgetJob(note.jobId); reload(); });
  start.addEventListener('click', async () => {
    busy(start, true);
    let jobId = null;
    try {
      ({ jobId } = await api.post(`/api/notes/${enc(note.id)}/process`, {}));
    } catch (e) {
      busy(start, false);
      toast(e.message, 'bad');
      return;
    }
    if (!isLive(my)) return;
    await runJob({ host: box, jobId, my, model, onDone: () => reload() });
  });
  return h('div', { class: 'card nt-stalled' },
    h('div', { class: 'coach' }, createBird({ size: 4, mood: 'sad' }).el,
      h('div', { class: 'bubble' }, 'I lost track of this run.')),
    h('p', { class: 'muted' }, 'The app may have restarted while Plumi was working. Check again, or start the run over.'),
    h('div', { class: 'row row--wrap' }, start, check));
}

function footerBlock(note, my) {
  const del = h('button', { class: 'btn btn--danger btn--sm', type: 'button' }, icon('trash'), 'Delete notes');
  del.addEventListener('click', async () => {
    if (!(await confirmWindow({
      title: 'Delete these notes?',
      text: note.source
        ? 'This page pick and its draft go away. Words and lessons you already imported stay. A document you chose to use once goes with it.'
        : 'The notes and their photos go away. Words and lessons you already imported stay.',
      okLabel: 'Delete',
      danger: true,
    }))) return;
    busy(del, true);
    try {
      await api.del(`/api/notes/${enc(note.id)}`);
    } catch (e) {
      busy(del, false);
      toast(e.message, 'bad');
      return;
    }
    if (!isLive(my)) return;
    toast('Notes deleted');
    navigate('/notes');
  });
  return h('section', { class: 'nt-foot' }, del);
}

function paintNote(root, note, my, reload) {
  setKids(root,
    h('a', { class: 'btn btn--sm btn--quiet nt-back', href: '#/notes' }, icon('back'), 'All notes'),
    noteHeader(note, my, reload),
    sourceBlock(note, my),
    rawBlock(note),
    galleryBlock(note),
    note.status === 'draft' ? draftBlock(note, my, reload) : null,
    note.status === 'imported' ? importedBlock(note, my) : null,
    note.status === 'processing' ? processingBlock(note, my, reload) : null,
    note.status === 'new' || note.status === 'error' ? processBlock(note, my, reload) : null,
    footerBlock(note, my));
  setTitle(note.title || 'Notes');
}

async function renderDetail(root, id) {
  const my = nextGen();
  root.replaceChildren(
    h('a', { class: 'btn btn--sm btn--quiet nt-back', href: '#/notes' }, icon('back'), 'All notes'),
    h('div', { class: 'card card--sunk card--flat' }, h('p', { class: 'help' }, 'Loading…')));
  setTitle('Notes');

  const reload = async (given, { focusImported = false } = {}) => {
    if (!isLive(my)) return;
    let note = given;
    if (!note) {
      try {
        note = await api.get(`/api/notes/${enc(id)}`);
      } catch (e) {
        if (isLive(my)) toast(e.message, 'bad');
        return;
      }
      if (!isLive(my)) return;
    }
    paintNote(root, note, my, reload);
    /* After an import the page gets shorter and the lessons it made are the next step. */
    if (focusImported) root.querySelector('.nt-imported')?.scrollIntoView({ block: 'center' });
  };

  let note;
  try {
    note = await api.get(`/api/notes/${enc(id)}`);
  } catch (e) {
    if (!isLive(my)) return;
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
  if (!isLive(my)) return;
  paintNote(root, note, my, reload);
}

/* ---------- the view ---------- */
export default {
  id: 'notes',
  title: 'Notes',
  async render(root, params) {
    const query = params?.query || {};
    if (params?.id) await renderDetail(root, params.id);
    else if (query.tab === 'documents') await renderDocuments(root, { my: nextGen(), docId: query.doc || '' });
    else await renderIndex(root);
  },
  unmount() {
    /* Bumping the generation is most of the teardown: every pending job poll,
       fetch and image read checks it before touching the DOM. */
    endGen();
    closeWin();
  },
};
