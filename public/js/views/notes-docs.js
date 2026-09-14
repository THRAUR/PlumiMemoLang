/* ============================================================
   notes-docs.js — the Documents tab of Notes (§8.6):
     #/notes?tab=documents            the library and the upload card
     #/notes?tab=documents&doc=<id>   one document and its page picker

   Built for a scanned textbook: hundreds of MB, hundreds of pages, and
   after each class the learner says "pages 9–11 and 25". The file goes
   up once, if they agree to keep it; every later class is a page pick,
   not another upload. Page numbers are the learner's: the book's printed
   numbers by default, with an offset that maps them onto the PDF.
   ============================================================ */
import { api } from '../api.js';
import { settings } from '../state.js';
import { navigate } from '../router.js';
import { createBird } from '../bird.js';
import { h, toast, confirmWindow, progress, busy, fmt, setTitle } from '../ui.js';
import { parsePages, formatPages, groupRanges, printedToPdf, pdfToPrinted } from '/shared/pages.js';
import {
  isLive, enc, icon, plural, bytes, todayYmd, win, setKids, tabsEl, docPath, docHref,
  runJob, resolvedExtractModel, loadModels, pagesWord,
} from './notes-kit.js';

/* ---------- tuning ---------- */
const MAX_UPLOAD = 500 * 1024 * 1024;   // the server's limit, checked first so a phone never sends 600 MB only to be refused
const PAGE_LIMIT = 20;                  // pages per run, the server's limit
const LESSONS_MAX = 4;                  // lessons one run can make (§8.5)
const THUMB_W = 160;                    // shown 92 px wide: sharp on a 2x phone, and on the server's 40 px cache steps
const PREVIEW_W = 800;
const OFFSET_SAVE_MS = 700;             // a burst of taps on − and + is one PUT
const TITLE_MAX = 120;
const OFFICE_EXTENSIONS = ['.docx', '.doc', '.pptx', '.ppt', '.odt', '.odp', '.rtf'];

/* ---------- what this machine can read ----------
   The server probes poppler and LibreOffice at boot, so the answer cannot change
   while the app is open. Only a success is cached: a failed check is asked again. */
let capsCache = null;
async function capabilities() {
  if (capsCache) return capsCache;
  const c = await api.get('/api/capabilities');
  capsCache = {
    documents: Boolean(c?.documents),
    officeTypes: Array.isArray(c?.officeTypes) ? c.officeTypes.map((x) => String(x).toLowerCase()) : [],
    reasons: c?.reasons && typeof c.reasons === 'object' ? c.reasons : {},
  };
  return capsCache;
}

/* ---------- small helpers ---------- */
function extOf(name) { const m = /\.[^.]+$/.exec(String(name || '')); return m ? m[0].toLowerCase() : ''; }
function baseName(name) { return String(name || '').replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim(); }
function capitalise(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function listText(items, word = 'and') {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`;
}
function loadingCard(text) {
  return h('div', { class: 'card card--sunk card--flat nt-loading' }, h('p', { class: 'help' }, text));
}
function fileUrl(id) { return `/api/materials/${enc(id)}/file`; }
function thumbUrl(id, page, w) { return `/api/materials/${enc(id)}/pages/${page}/thumb?w=${w}`; }
function coveredPdf(m) {
  const all = (Array.isArray(m?.covered) ? m.covered : []).flatMap((c) => (Array.isArray(c?.pages) ? c.pages : []));
  return [...new Set(all.map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
}
/* material.covered is in PDF numbers; a learner who set the offset thinks in the book's. */
function inBookNumbers(pdfPages, m) {
  const offset = Number(m?.pageOffset) || 0;
  if (!offset) return formatPages(pdfPages);
  return formatPages(pdfToPrinted(pdfPages, offset)) || `PDF ${formatPages(pdfPages)}`;
}
function keepTag(m) { return h('span', { class: 'pl-tag' }, m.keep === false ? 'once' : 'kept'); }
function errorNote(message) {
  return h('div', { class: 'nt-note-error', role: 'alert' }, icon('x'), h('p', null, message));
}
function fileChip(file, action) {
  return h('div', { class: 'nt-filechip' },
    icon('doc', 2),
    h('span', { class: 'grow' },
      h('span', { class: 'nt-filechip-name' }, file.name),
      h('span', { class: 'nt-filechip-size' }, bytes(file.size))),
    action);
}
/* A segmented choice that fills its field: the kit's .seg, one button per option.
   `set()` moves the highlight without firing, for a change the learner took back. */
function choiceSeg(options, value, onPick, label) {
  const box = h('div', { class: `seg nt-seg nt-seg--${options.length}`, role: 'group', 'aria-label': label });
  const btns = options.map(([v, text]) => {
    const b = h('button', { type: 'button' }, text);
    b.addEventListener('click', () => { box.set(v); onPick(v); });
    return b;
  });
  box.set = (v) => btns.forEach((b, i) => {
    const on = options[i][0] === v;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  box.append(...btns);
  box.set(value);
  return box;
}

export async function renderDocuments(root, { my, docId }) {
  if (docId) return renderDocument(root, { my, docId });
  return renderLibrary(root, { my });
}

/* ============================================================
   #/notes?tab=documents — the library
   ============================================================ */
/* A "use it once" document is listed by the server only while a note waits on it,
   so one uploaded a minute ago and not used yet would vanish from the library.
   Uploads from this visit stay reachable here until they are used or deleted. */
const recent = new Map();
function withRecent(materials) {
  const listed = new Set(materials.map((m) => m.id));
  return [...[...recent.values()].filter((m) => !listed.has(m.id)), ...materials];
}

async function renderLibrary(root, { my }) {
  setTitle('Documents');
  root.replaceChildren(tabsEl('documents'), loadingCard('Loading your documents…'));
  let caps;
  try {
    caps = await capabilities();
  } catch (e) {
    if (!isLive(my)) return;
    root.replaceChildren(tabsEl('documents'), unavailableCard(null, e));
    return;
  }
  if (!isLive(my)) return;
  if (!caps.documents) {
    root.replaceChildren(tabsEl('documents'), unavailableCard(caps, null));
    return;
  }
  let materials = [];
  let listError = null;
  try {
    const res = await api.get('/api/materials');
    materials = Array.isArray(res) ? res : (res?.materials || []);
  } catch (e) {
    listError = e;
  }
  if (!isLive(my)) return;
  materials = withRecent(materials);
  /* A returning learner comes for the library; a first visit comes to upload. */
  setKids(root,
    tabsEl('documents'),
    materials.length || listError ? libraryBlock(materials, listError) : null,
    uploadCard({ my, caps, first: !materials.length && !listError }));
}

function unavailableCard(caps, error) {
  return h('section', { class: 'card nt-unavailable' },
    h('div', { class: 'coach' }, createBird({ size: 4, mood: 'sad' }).el,
      h('div', { class: 'bubble' }, 'I can’t open documents on this machine yet.')),
    h('p', { class: 'h3' }, 'Documents are not available'),
    h('p', { class: 'muted' }, caps?.reasons?.documents
      || (error
        ? 'The app server did not answer when asked what it can read. It may be an older version: update it, restart it, then reload this page.'
        : 'The app server is missing the programs that read PDFs.')),
    error ? h('p', { class: 'help' }, error.message) : null,
    h('p', { class: 'help' }, 'Class notes and photos work as before.'));
}

function libraryBlock(materials, error) {
  const head = h('p', { class: 'pl-eyebrow' }, 'Your documents');
  if (error) {
    return h('section', { class: 'nt-library' }, head,
      h('div', { class: 'card card--sunk card--flat' },
        h('p', { class: 'help' }, 'Your documents could not load.'),
        h('p', { class: 'help' }, error.message)));
  }
  return h('section', { class: 'nt-library' }, head, h('div', { class: 'list' }, materials.map(docRow)));
}

function docRow(m) {
  const covered = coveredPdf(m);
  return h('a', { class: 'list-row nt-doc-row', href: docHref(m.id) },
    h('span', { class: 'nt-doc-icon', 'aria-hidden': 'true' }, icon('doc', 2)),
    h('span', { class: 'grow' },
      h('span', { class: 'nt-row-top' }, h('b', { class: 'nt-row-title' }, m.title || m.fileName || 'Untitled'), keepTag(m)),
      h('span', { class: 'nt-row-meta' },
        h('span', null, plural(Number(m.pageCount) || 0, 'page', 'pages')),
        h('span', null, `added ${fmt.rel(m.createdAt)}`)),
      h('span', { class: 'nt-doc-covered' }, covered.length ? `Covered: ${inBookNumbers(covered, m)}` : 'No pages covered yet')),
    icon('arrow'));
}

/* ============================================================
   the upload
   ============================================================
   One upload at a time, kept outside the render: a 300 MB scan takes minutes on a
   phone, and a tap on "Class notes" or into a note must not throw it away. */
let upload = null;
/* The form survives a re-render the same way the compose box does. */
const pick = { file: null, title: '', titleDirty: false, keep: null, error: '' };
function resetPick() { Object.assign(pick, { file: null, title: '', titleDirty: false, keep: null, error: '' }); }

function fileProblem(file, caps) {
  const ext = extOf(file.name);
  if (!file.size) return `${file.name} is empty.`;
  if (file.size > MAX_UPLOAD) return `${file.name} is ${bytes(file.size)}. A document can be up to 500 MB.`;
  if (ext === '.pdf' || file.type === 'application/pdf' || caps.officeTypes.includes(ext)) return '';
  if (OFFICE_EXTENSIONS.includes(ext) && caps.reasons.office) return caps.reasons.office;
  return `${file.name} is not a PDF${caps.officeTypes.length ? ` or a ${listText(caps.officeTypes, 'or')} file` : ''}.`;
}
function uploadFailure(status) {
  if (status === 413) return 'That file is larger than 500 MB.';
  if (!status) return 'The upload stopped before it finished. Check the connection and try again.';
  if (status >= 500) return 'The server could not store that file. Try again.';
  return `The upload failed (${status}).`;
}
function sizeProgress(sent, total) {
  const MB = 1024 * 1024;
  if (total < MB) return `${bytes(sent)} of ${bytes(total)}`;
  return `${(sent / MB).toFixed(1)} of ${(total / MB).toFixed(1)} MB`;
}

/* XMLHttpRequest, not fetch: fetch cannot report upload progress, and a phone
   sending a 300 MB scan needs to see it move. The body is the raw File, which the
   browser streams from disk. */
function startUpload({ file, title, keep }) {
  const xhr = new XMLHttpRequest();
  const u = { file, xhr, loaded: 0, total: file.size || 0, phase: 'sending', material: null, watchers: new Set() };
  upload = u;
  const watching = () => [...u.watchers].some((w) => isLive(w.my));
  const notify = () => {
    for (const w of [...u.watchers]) {
      if (isLive(w.my)) w.fn(u);
      else u.watchers.delete(w);
    }
  };
  /* Closing the tab mid-upload loses the file, so the browser asks first. */
  const guard = (e) => { e.preventDefault(); e.returnValue = ''; };
  window.addEventListener('beforeunload', guard);
  const settle = () => { window.removeEventListener('beforeunload', guard); if (upload === u) upload = null; };
  const fail = (message) => {
    settle();
    pick.error = message;
    u.phase = 'error';
    if (watching()) notify();
    else toast(message, 'bad', 6000);
  };
  xhr.upload.addEventListener('progress', (e) => {
    u.loaded = e.loaded;
    if (e.lengthComputable && e.total) u.total = e.total;
    notify();
  });
  /* Every byte has left the phone; the server still counts the pages, or converts
     a slide deck, before it answers. */
  xhr.upload.addEventListener('load', () => { u.loaded = u.total; u.phase = 'reading'; notify(); });
  xhr.addEventListener('load', () => {
    let data = null;
    try { data = JSON.parse(xhr.responseText); } catch { data = null; }
    if (xhr.status < 200 || xhr.status >= 300 || !data?.id) { fail(data?.error || uploadFailure(xhr.status)); return; }
    settle();
    resetPick();
    u.phase = 'done';
    u.material = data;
    if (data.keep === false) recent.set(data.id, data);
    if (watching()) notify();
    else toast(`“${data.title}” is uploaded. It is under Notes, in Documents.`, 'ok', 5200);
  });
  xhr.addEventListener('error', () => fail(uploadFailure(0)));
  xhr.addEventListener('abort', () => { settle(); u.phase = 'aborted'; notify(); });
  const query = new URLSearchParams({ name: file.name, title, keep: keep ? '1' : '0' });
  xhr.open('POST', `/api/materials?${query}`);
  xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
  xhr.send(file);
}

/* Nothing is preselected: keeping a 300 MB book on this machine is the learner's
   call, so Upload waits until they make it. */
function consentField(onPick) {
  const labels = [];
  const opt = (value, title, text) => {
    const radio = h('input', { type: 'radio', name: 'nt-keep', value: value ? '1' : '0', checked: pick.keep === value });
    const label = h('label', { class: `option nt-choice${pick.keep === value ? ' is-selected' : ''}` }, radio,
      h('span', { class: 'grow' }, h('span', { class: 'nt-choice-title' }, title), h('span', { class: 'nt-choice-text' }, text)));
    radio.addEventListener('change', () => {
      pick.keep = value;
      for (const l of labels) l.classList.toggle('is-selected', l === label);
      onPick();
    });
    labels.push(label);
    return label;
  };
  return h('div', { class: 'nt-consent', role: 'radiogroup', 'aria-labelledby': 'nt-keep-q' },
    h('p', { class: 'nt-consent-q', id: 'nt-keep-q' }, 'Keep it in my library so I can pick more pages after a later class?'),
    h('div', { class: 'nt-choices' },
      opt(true, 'Keep it', 'It stays in Documents. Pick new pages after any class.'),
      opt(false, 'Use it once', 'It is deleted as soon as its lessons are imported.')));
}

function uploadCard({ my, caps, first }) {
  const input = h('input', {
    class: 'nt-file', type: 'file', tabindex: '-1', 'aria-hidden': 'true',
    accept: ['.pdf', 'application/pdf', ...caps.officeTypes].join(','),
  });
  const body = h('div', { class: 'win-body' });
  const officeHelp = caps.reasons.office ? h('p', { class: 'help nt-upload-office' }, caps.reasons.office) : null;
  const formats = `A PDF${caps.officeTypes.length ? ` or a ${listText(caps.officeTypes, 'or')} file` : ''}, up to 500 MB.`;
  const choose = () => input.click();
  let watcher = null;

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const problem = fileProblem(file, caps);
    pick.error = problem;
    if (problem) pick.file = null;
    else {
      pick.file = file;
      if (!pick.titleDirty) pick.title = baseName(file.name).slice(0, TITLE_MAX);
    }
    paint();
  });

  function uploadingView(u) {
    const bar = progress(0, 1);
    const pct = h('span', { class: 'nt-up-pct' });
    const amount = h('span', { class: 'nt-up-amount' });
    const status = h('p', { class: 'help nt-up-status', 'aria-live': 'polite' });
    const cancel = h('button', { class: 'btn btn--sm', type: 'button', onClick: () => u.xhr.abort() }, icon('x'), 'Cancel');
    const converting = extOf(u.file.name) !== '.pdf';
    const numbers = () => {
      const total = u.total || 1;
      const sent = Math.min(u.loaded, total);
      const reading = u.phase === 'reading';
      bar.set(sent / total, 1);
      bar.classList.toggle('is-busy', reading);
      pct.textContent = `${reading ? 100 : Math.floor((sent / total) * 100)}%`;
      amount.textContent = sizeProgress(sent, total);
      status.textContent = reading
        ? (converting ? 'Uploaded. Turning it into a PDF…' : 'Uploaded. Counting the pages…')
        : 'Uploading. Keep the app open until it finishes.';
      cancel.hidden = reading;
    };
    watcher = {
      my,
      fn: () => {
        if (u.phase === 'done') { toast('Uploaded', 'ok'); navigate(docPath(u.material.id)); return; }
        if (u.phase === 'error' || u.phase === 'aborted') { paint(); return; }
        numbers();
      },
    };
    u.watchers.add(watcher);
    numbers();
    return h('div', { class: 'nt-uploading' },
      fileChip(u.file, null),
      h('div', { class: 'nt-up-meter' }, bar),
      h('div', { class: 'nt-up-numbers' }, amount, pct),
      h('div', { class: 'nt-up-foot' }, status, cancel));
  }

  function paint() {
    if (!isLive(my)) return;
    if (watcher) upload?.watchers.delete(watcher);
    watcher = null;
    if (upload) {
      setKids(body, uploadingView(upload));
      return;
    }
    if (!pick.file) {
      setKids(body,
        first
          ? h('div', { class: 'coach' }, createBird({ size: 4, mood: 'happy' }).el,
            h('div', { class: 'bubble' }, 'Upload your textbook or a handout. After each class, tell me the pages you covered and I’ll make the lessons.'))
          : h('p', { class: 'muted' }, 'A textbook scan or a handout. You pick the pages after it uploads.'),
        pick.error ? errorNote(pick.error) : null,
        h('button', { class: 'btn btn--primary btn--block', type: 'button', onClick: choose },
          icon('up'), caps.officeTypes.length ? 'Choose a file' : 'Choose a PDF'),
        h('p', { class: 'help' }, formats),
        officeHelp);
      return;
    }
    const title = h('input', {
      class: 'input', type: 'text', id: 'nt-up-title', value: pick.title, maxlength: TITLE_MAX,
      placeholder: baseName(pick.file.name) || 'Title', autocomplete: 'off',
    });
    title.addEventListener('input', () => { pick.title = title.value; pick.titleDirty = title.value.trim() !== ''; });
    const go = h('button', { class: 'btn btn--primary btn--block', type: 'button' }, icon('up'), pick.error ? 'Try again' : 'Upload');
    const why = h('p', { class: 'help nt-upload-why' }, 'Choose “Keep it” or “Use it once” to upload.');
    const sync = () => { go.disabled = pick.keep === null; why.hidden = pick.keep !== null; };
    go.addEventListener('click', () => {
      if (pick.keep === null || !pick.file) return;
      pick.error = '';
      startUpload({ file: pick.file, title: pick.title.trim() || baseName(pick.file.name) || 'Document', keep: pick.keep });
      paint();
    });
    sync();
    setKids(body,
      fileChip(pick.file, h('button', { class: 'btn btn--sm btn--quiet', type: 'button', onClick: choose }, 'Change')),
      pick.error ? errorNote(pick.error) : null,
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'nt-up-title' }, 'Title'), title),
      consentField(sync),
      go, why, officeHelp);
  }

  paint();
  return h('section', { class: 'pl-win nt-upload' },
    h('div', { class: 'pl-titlebar' }, h('span', { class: 'pl-title' }, 'Add a document'), h('span', { class: 'spacer' })),
    body, input);
}

/* ============================================================
   #/notes?tab=documents&doc=<id> — one document
   ============================================================ */
function backLink() {
  return h('a', { class: 'btn btn--sm btn--quiet nt-back', href: '#/notes?tab=documents' }, icon('back'), 'All documents');
}

async function renderDocument(root, { my, docId }) {
  setTitle('Documents');
  root.replaceChildren(backLink(), loadingCard('Loading the document…'));
  let material;
  try {
    material = await api.get(`/api/materials/${enc(docId)}`);
  } catch (e) {
    if (!isLive(my)) return;
    recent.delete(docId);
    root.replaceChildren(backLink(), h('section', { class: 'card' },
      h('p', { class: 'h3' }, 'This document could not load.'),
      h('p', { class: 'muted' }, e.message),
      h('p', { class: 'help' }, 'A document you chose to use once is deleted after its lessons are imported. The lessons stay.'),
      h('a', { class: 'btn', href: '#/notes?tab=documents' }, 'Back to your documents')));
    return;
  }
  if (!isLive(my)) return;

  const doc = { m: material };
  const head = h('section', { class: 'card nt-dochead' });
  const history = h('section', { class: 'nt-history' });
  const picker = pagePicker(doc, { my, onSaved: paint });
  function paint() {
    if (!isLive(my)) return;
    setKids(head, ...docHead(doc, { my, repaint: () => { paint(); picker.refresh(); } }));
    const runs = historyKids(doc.m);
    setKids(history, ...runs);
    history.hidden = !runs.length;
    setTitle(doc.m.title || 'Document');
  }
  paint();
  setKids(root, backLink(), head, picker.el, history, docFooter(doc, my));
}

function docHead(doc, { my, repaint }) {
  const m = doc.m;
  const kept = m.keep !== false;
  const covered = coveredPdf(m);
  const keepSeg = choiceSeg([[true, 'Keep it'], [false, 'Use it once']], kept, async (value) => {
    if (value === kept) return;
    if (!value && !(await confirmWindow({
      title: 'Use this document once?',
      text: 'It will be deleted after its lessons are imported. Lessons and words made from it stay.',
      okLabel: 'Use it once',
    }))) { keepSeg.set(kept); return; }
    try {
      doc.m = await api.put(`/api/materials/${enc(m.id)}`, { keep: value });
      if (doc.m.keep === false) recent.set(doc.m.id, doc.m); else recent.delete(doc.m.id);
      toast(value ? 'Kept in your library' : 'It will be deleted after its lessons are imported');
    } catch (e) {
      toast(e.message, 'bad');
    }
    if (isLive(my)) repaint();
  }, 'Keep this document');
  return [
    h('div', { class: 'row nt-dochead-top' },
      h('span', { class: 'nt-doc-icon nt-doc-icon--lg', 'aria-hidden': 'true' }, icon('doc', 3)),
      h('h1', { class: 'h2 grow nt-title' }, m.title || 'Untitled'),
      h('button', { class: 'btn btn--sm btn--quiet', type: 'button', onClick: () => renameDocument(doc, my, repaint) }, icon('notes'), 'Rename')),
    h('div', { class: 'row row--wrap nt-head-meta' },
      keepTag(m),
      h('span', { class: 'muted small' }, plural(Number(m.pageCount) || 0, 'page', 'pages')),
      m.size ? h('span', { class: 'muted small' }, bytes(m.size)) : null,
      h('span', { class: 'muted small' }, `added ${fmt.rel(m.createdAt)}`)),
    h('p', { class: 'nt-doc-covered' }, covered.length ? `Covered: ${inBookNumbers(covered, m)}` : 'No pages covered yet'),
    h('div', { class: 'field nt-keep' },
      h('span', { class: 'label' }, 'In your library'),
      keepSeg,
      h('span', { class: 'help' }, kept
        ? 'It stays here, so you can pick more pages after a later class.'
        : 'It is deleted as soon as its lessons are imported.')),
    h('a', { class: 'btn btn--sm nt-open', href: fileUrl(m.id), target: '_blank', rel: 'noopener' }, icon('doc'), 'Open the PDF'),
  ];
}

function renameDocument(doc, my, repaint) {
  const title = h('input', { class: 'input', type: 'text', value: doc.m.title || '', maxlength: TITLE_MAX });
  win({
    title: 'Rename document',
    body: h('label', { class: 'field' }, h('span', { class: 'label' }, 'Title'), title),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save', primary: true, onClick: async () => {
          const t = title.value.trim();
          if (!t) { toast('A document needs a title.', 'bad'); return false; }
          doc.m = await api.put(`/api/materials/${enc(doc.m.id)}`, { title: t });
          toast('Renamed');
          if (isLive(my)) repaint();
        },
      },
    ],
  });
}

function historyKids(m) {
  const runs = (Array.isArray(m.covered) ? m.covered : []).filter((c) => Array.isArray(c?.pages) && c.pages.length).reverse();
  if (!runs.length) return [];
  return [
    h('p', { class: 'pl-eyebrow' }, 'Lessons made from it'),
    h('div', { class: 'list' }, runs.map((c) => {
      const n = Array.isArray(c.lessonIds) ? c.lessonIds.length : 0;
      const text = h('span', { class: 'grow' },
        h('b', { class: 'nt-row-title' }, capitalise(pagesWord(inBookNumbers(c.pages, m)))),
        h('span', { class: 'nt-row-meta' },
          n ? h('span', null, plural(n, 'lesson', 'lessons')) : null,
          c.at ? h('span', null, fmt.rel(c.at)) : null));
      return c.noteId
        ? h('a', { class: 'list-row nt-row nt-row--center', href: `#/notes/${enc(c.noteId)}` }, text, icon('arrow'))
        : h('div', { class: 'list-row nt-row nt-row--center' }, text);
    })),
  ];
}

function docFooter(doc, my) {
  const del = h('button', { class: 'btn btn--danger btn--sm', type: 'button' }, icon('trash'), 'Delete document');
  del.addEventListener('click', async () => {
    if (!(await confirmWindow({
      title: 'Delete this document?',
      text: 'The PDF and its page previews go away. Lessons, words and notes made from it stay.',
      okLabel: 'Delete',
      danger: true,
    }))) return;
    busy(del, true);
    try {
      await api.del(`/api/materials/${enc(doc.m.id)}`);
    } catch (e) {
      busy(del, false);
      toast(e.message, 'bad');
      return;
    }
    recent.delete(doc.m.id);
    picks.delete(doc.m.id);
    if (!isLive(my)) return;
    toast('Document deleted');
    navigate('/notes?tab=documents');
  });
  return h('section', { class: 'nt-foot' }, del);
}

/* ============================================================
   the page picker
   ============================================================ */
/* The picker's answers per document survive a trip away and back, like the compose box. */
const picks = new Map();

function pagePicker(doc, { my, onSaved }) {
  const id = doc.m.id;
  const uid = `nt-pk-${id}`;
  const st = picks.get(id) || { text: '', numbering: 'printed', split: 'one', instructions: '', title: '', titleDirty: false, classDate: todayYmd() };
  picks.set(id, st);
  const count = () => Number(doc.m.pageCount) || 0;
  let offset = Number(doc.m.pageOffset) || 0;
  let saveTimer = null;
  let saving = null;
  let stripTimer = null;
  const imgs = new Map();   // PDF page → <img>, so "9-1" becoming "9-11" keeps the previews that already loaded
  // Names the model on the processing card; nothing waits for it.
  if (settings?.ai?.hasApiKey) loadModels().catch(() => {});

  /* --- pages --- */
  const pagesInput = h('input', {
    class: 'input nt-pages-input', type: 'text', id: `${uid}-pages`, value: st.text, placeholder: '9-11, 25',
    autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'done',
    'aria-describedby': `${uid}-pages-help`,
  });
  const pagesHelp = h('p', { class: 'help nt-pages-help', id: `${uid}-pages-help`, 'aria-live': 'polite' });
  const strip = h('div', { class: 'nt-pages' });
  pagesInput.addEventListener('input', () => { st.text = pagesInput.value; update(); });
  /* On a phone keyboard, Done closes the keyboard; it must not submit anything. */
  pagesInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); pagesInput.blur(); } });

  /* --- page numbers: the book's or the PDF's --- */
  const numberingSeg = choiceSeg([['printed', 'As printed in the book'], ['pdf', 'PDF pages']], st.numbering,
    (v) => { st.numbering = v; update(); }, 'Page numbers');
  const offsetInput = h('input', {
    class: 'input nt-offset-input', type: 'number', id: `${uid}-offset`, step: 1,
    min: 2 - count(), max: count(), value: String(offset + 1),
  });
  const minus = h('button', { class: 'btn btn--icon', type: 'button', 'aria-label': 'One PDF page earlier' },
    h('span', { class: 'nt-minus', 'aria-hidden': 'true' }));
  const plus = h('button', { class: 'btn btn--icon', type: 'button', 'aria-label': 'One PDF page later' }, icon('plus'));
  const offsetNote = h('p', { class: 'help' });
  const offsetBox = h('div', { class: 'field nt-offset' },
    h('div', { class: 'nt-offset-row' },
      h('label', { class: 'nt-offset-text', for: `${uid}-offset` }, 'Printed page 1 is PDF page'),
      h('span', { class: 'nt-stepper' }, minus, offsetInput, plus)),
    offsetNote);
  /* Printed page p is PDF page p + offset; the server keeps |offset| below the page count. */
  const clampOffset = (o) => Math.max(1 - count(), Math.min(count() - 1, Math.round(o)));
  function setOffset(next, { rewrite = true } = {}) {
    const o = clampOffset(next);
    if (rewrite) offsetInput.value = String(o + 1);
    if (o === offset) return;
    offset = o;
    update();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveOffset().catch(() => {}); }, OFFSET_SAVE_MS);
  }
  minus.addEventListener('click', () => setOffset(offset - 1));
  plus.addEventListener('click', () => setOffset(offset + 1));
  /* Typing "1" on the way to "12" must not rewrite the box under the learner's
     thumb: the number is clamped when the field is left, not on every key. */
  offsetInput.addEventListener('input', () => {
    const n = Number(offsetInput.value);
    if (offsetInput.value.trim() !== '' && Number.isInteger(n)) setOffset(n - 1, { rewrite: false });
  });
  offsetInput.addEventListener('change', () => {
    const n = Number(offsetInput.value);
    setOffset(offsetInput.value.trim() !== '' && Number.isFinite(n) ? n - 1 : offset);
  });
  /* The server turns printed pages into PDF pages with the SAVED offset, so "Make
     lessons" waits for this before it sends anything. */
  async function saveOffset() {
    clearTimeout(saveTimer);
    saveTimer = null;
    while (saving) await saving.catch(() => {});
    if (offset === (Number(doc.m.pageOffset) || 0)) return;
    saving = api.put(`/api/materials/${enc(id)}`, { pageOffset: offset });
    try {
      doc.m = await saving;
      if (isLive(my)) onSaved();
    } catch (e) {
      toast(e.message, 'bad');
      throw e;
    } finally {
      saving = null;
    }
  }

  /* --- lessons, instructions, title, date --- */
  const splitSeg = choiceSeg([['one', 'One lesson'], ['per-range', 'One per page range'], ['auto', 'Let Plumi decide']], st.split,
    (v) => { st.split = v; update(); }, 'Lessons');
  const splitHelp = h('p', { class: 'help' });
  const instructions = h('textarea', {
    class: 'textarea nt-instructions', id: `${uid}-instr`, rows: 3, maxlength: 2000,
    placeholder: 'Focus on the dialogue on page 10, skip the exercises',
  });
  instructions.value = st.instructions;
  instructions.addEventListener('input', () => { st.instructions = instructions.value; });
  const titleInput = h('input', { class: 'input', type: 'text', id: `${uid}-title`, maxlength: TITLE_MAX, value: st.title, autocomplete: 'off' });
  /* The title follows the pages until the learner writes one of their own. */
  titleInput.addEventListener('input', () => { st.title = titleInput.value; st.titleDirty = titleInput.value.trim() !== ''; });
  const dateInput = h('input', { class: 'input', type: 'date', id: `${uid}-date`, value: st.classDate });
  dateInput.addEventListener('change', () => { st.classDate = dateInput.value; });
  const go = h('button', { class: 'btn btn--primary btn--block', type: 'button' });
  const goError = h('div', { class: 'nt-note-error', role: 'alert', hidden: true });
  const body = h('div', { class: 'win-body' });

  function parsed() {
    const raw = st.text.trim();
    if (!raw) return { typed: null, pdf: null, error: '' };
    try {
      const printed = st.numbering === 'printed';
      const typed = parsePages(raw, { max: printed && offset ? Infinity : count(), limit: PAGE_LIMIT });
      const pdf = printed ? printedToPdf(typed, offset) : typed;
      const outside = typed.find((p, i) => pdf[i] < 1 || pdf[i] > count());
      if (outside !== undefined) {
        throw new Error(outside + offset < 1
          ? `Printed page ${outside} comes before the first page of this PDF. Check “Printed page 1 is PDF page” below.`
          : `Printed page ${outside} would be PDF page ${outside + offset}, past the end of this ${count()}-page PDF.`);
      }
      return { typed, pdf, error: '' };
    } catch (e) {
      return { typed: null, pdf: null, error: e.message };
    }
  }
  function defaultTitle(r) {
    return r.typed ? `${doc.m.title || 'Document'} · p. ${formatPages(r.typed)}`.slice(0, TITLE_MAX) : '';
  }
  function lessonCount(r) {
    if (!r.typed) return 0;
    if (st.split === 'one') return 1;
    if (st.split === 'per-range') return Math.min(LESSONS_MAX, groupRanges(r.typed).length);
    return 0;   // "Let Plumi decide": the model counts
  }
  function splitText(r) {
    if (st.split === 'one') {
      return r.typed?.length > 1 ? `All ${r.typed.length} pages become one lesson.` : 'The pages become one lesson.';
    }
    if (st.split === 'per-range') {
      const ranges = r.typed ? groupRanges(r.typed).map(([a, b]) => (a === b ? String(a) : `${a}–${b}`)) : [];
      if (!ranges.length) return 'Each run of pages, like 9–11, becomes a lesson of its own.';
      if (ranges.length === 1) return 'One run of pages, so this makes one lesson.';
      if (ranges.length > LESSONS_MAX) return `${ranges.length} runs of pages, but one go makes at most ${LESSONS_MAX} lessons.`;
      return `${ranges.length} lessons: ${listText(ranges)}.`;
    }
    return `Plumi splits the pages by topic, into at most ${LESSONS_MAX} lessons.`;
  }

  function pageThumb(pdf, label, done, showPdf) {
    let img = imgs.get(pdf);
    if (!img) {
      img = h('img', { src: thumbUrl(id, pdf, THUMB_W), alt: '', loading: 'lazy', decoding: 'async', width: 92, height: 130 });
      /* A page that cannot be drawn must not leave a broken-image glyph behind. */
      img.addEventListener('error', () => {
        const gone = h('span', { class: 'nt-page-gone' }, 'No preview');
        imgs.set(pdf, gone);
        img.replaceWith(gone);
      });
      imgs.set(pdf, img);
    }
    return h('button', {
      class: 'nt-page', type: 'button',
      'aria-label': `Page ${label}${showPdf ? ` (PDF page ${pdf})` : ''}${done ? ', already covered' : ''}. Show it larger.`,
      onClick: () => win({
        title: `Page ${label}${showPdf ? ` · PDF page ${pdf}` : ''}`,
        wide: true,
        body: previewEl(pdf, label),
      }),
    },
      h('span', { class: 'nt-page-img' }, img, done ? h('span', { class: 'nt-page-done' }, 'done') : null),
      h('span', { class: 'nt-page-n' }, `p. ${label}`),
      showPdf ? h('span', { class: 'nt-page-pdf' }, `PDF ${pdf}`) : null);
  }
  function previewEl(pdf, label) {
    const box = h('div', { class: 'nt-page-preview' });
    const img = h('img', { class: 'nt-page-full', src: thumbUrl(id, pdf, PREVIEW_W), alt: `Page ${label}` });
    img.addEventListener('error', () => box.replaceChildren(h('p', { class: 'help' }, 'This page could not be drawn.')));
    box.append(img);
    return box;
  }
  function paintStrip(r) {
    clearTimeout(stripTimer);
    if (!r.typed) {
      strip.replaceChildren(h('p', { class: 'nt-pages-empty' }, r.error ? 'Fix the pages above to see them here.' : 'The pages you pick appear here.'));
      return;
    }
    /* A burst of typing, or of taps on − and +, is one repaint, not a request per key. */
    stripTimer = setTimeout(() => {
      if (!isLive(my)) return;
      const done = new Set(coveredPdf(doc.m));
      const showPdf = st.numbering === 'printed' && offset !== 0;
      strip.replaceChildren(...r.pdf.map((p, i) => pageThumb(p, r.typed[i], done.has(p), showPdf)));
    }, 160);
  }

  function update() {
    const r = parsed();
    pagesInput.setAttribute('aria-invalid', r.error ? 'true' : 'false');
    pagesHelp.classList.toggle('is-error', Boolean(r.error));
    pagesHelp.textContent = r.error
      || (r.typed
        ? `${plural(r.typed.length, 'page', 'pages')}. Tap a page to see it larger.`
        : `Type the pages you covered, like 9-11, 25. Up to ${PAGE_LIMIT} at a time.`);
    offsetBox.hidden = st.numbering !== 'printed';
    const first = r.typed?.[0] ?? 1;
    offsetNote.textContent = offset
      ? `So printed page ${first} is PDF page ${first + offset}. If the pages above don’t match the book, change the number.`
      : 'If the pages above don’t match the numbers printed in the book, change this number until they do.';
    paintStrip(r);
    splitHelp.textContent = splitText(r);
    const auto = defaultTitle(r);
    if (!st.titleDirty) { st.title = auto; titleInput.value = auto; }
    titleInput.placeholder = auto || doc.m.title || 'Title';
    go.disabled = !r.typed;
    const n = lessonCount(r);
    go.replaceChildren(icon('bolt'), n === 1 ? 'Make the lesson' : n > 1 ? `Make ${n} lessons` : 'Make lessons');
  }

  function showGoError(message) {
    setKids(goError, icon('x'), h('p', null, message,
      settings?.ai?.hasApiKey ? null : [' ', h('a', { href: '#/settings' }, 'Open Settings')]));
    goError.hidden = false;
  }

  go.addEventListener('click', async () => {
    const r = parsed();
    if (!r.typed) { pagesInput.focus(); return; }
    busy(go, true);
    goError.hidden = true;
    try {
      await saveOffset();
    } catch (e) {
      busy(go, false);
      showGoError(e.message);
      return;
    }
    let res;
    try {
      res = await api.post(`/api/materials/${enc(id)}/lessons`, {
        pages: formatPages(r.typed),
        numbering: st.numbering,
        split: st.split,
        instructions: st.instructions.trim(),
        title: st.title.trim() || defaultTitle(r),
        classDate: st.classDate || null,
      });
    } catch (e) {
      busy(go, false);
      showGoError(e.message);
      return;
    }
    recent.delete(id);   // a note waits on it now, so the server lists it
    picks.delete(id);    // the next class starts from a clean form
    if (!isLive(my)) return;
    await runJob({
      host: body, jobId: res.jobId, my,
      model: resolvedExtractModel(true),
      text: `Reading ${pagesWord(formatPages(r.typed))}…`,
      hint: 'Pages take longer than typed notes, up to a few minutes. You can leave this screen.',
      onDone: () => navigate(`/notes/${enc(res.noteId)}`),
    });
  });

  setKids(body,
    h('div', { class: 'field' }, h('label', { class: 'label', for: `${uid}-pages` }, 'Pages'), pagesInput, pagesHelp),
    strip,
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Page numbers'), numberingSeg),
    offsetBox,
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Lessons'), splitSeg, splitHelp),
    h('div', { class: 'field' }, h('label', { class: 'label', for: `${uid}-instr` }, 'Instructions for Plumi · optional'), instructions),
    h('div', { class: 'grid-2' },
      h('div', { class: 'field' }, h('label', { class: 'label', for: `${uid}-title` }, 'Title'), titleInput),
      h('div', { class: 'field' }, h('label', { class: 'label', for: `${uid}-date` }, 'Class date'), dateInput)),
    settings?.ai?.hasApiKey
      ? null
      : h('p', { class: 'help' }, 'Plumi needs your OpenRouter key to read the pages. ', h('a', { href: '#/settings' }, 'Add it in Settings'), '.'),
    go,
    goError);
  update();
  return {
    el: h('section', { class: 'pl-win nt-picker' },
      h('div', { class: 'pl-titlebar' }, h('span', { class: 'pl-title' }, 'Make lessons from pages'), h('span', { class: 'spacer' })),
      body),
    refresh: update,
  };
}
