/* Notes: what the learner pastes or photographs after class, or a page selection
   from one of their documents, and the AI pass that turns it into lesson drafts.
   Photos arrive as data URLs (a phone camera roll, no upload widget), are written
   under <dataDir>/uploads/<noteId>/ and are only ever served back by name from
   that folder. Document pages are rendered from the material's PDF when the job
   runs and are never stored. */
import { Router } from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { coll, newId } from '../store.js';
import { config } from '../config.js';
import { runTask, aiReady, NO_AI_MESSAGE } from '../ai/tasks.js';
import { isAllowedModel } from '../ai/models.js';
import { createJob, setProgress } from '../jobs.js';
import { addXp, bumpDay, getStats, readSettings } from '../stats.js';
import { isPlain } from '../defaults.js';
import { upsertWord } from '../lib/words.js';
import { draftLessons, normaliseDraft, draftWordCount, LESSONS_MAX } from '../lib/drafts.js';
import { renderPage, pageText } from '../lib/documents.js';
import { sourcePdf, releaseIfUnkept, recordCoverage } from '../lib/materials.js';
import { nextOrder } from './lessons.js';

const r = Router();

const MAX_IMAGES = 12;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const EXCERPT = 200;
const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const STATUSES = ['new', 'processing', 'draft', 'imported', 'error'];
/* A rendered page at 1400 px is about 120 KB of JPEG: 20 of them keep the request
   to OpenRouter near 3 MB, and a textbook scan stays readable at that size. */
const PAGE_LONG_SIDE = 1400;
const PAGE_TEXT_CHARS = 2500;

function bad(msg, status = 400) { return Object.assign(new Error(msg), { status }); }
function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }

function noteOr404(id) {
  const note = coll('notes').get(id);
  if (!note) throw bad('No such note.', 404);
  return note;
}

/* Every note leaves the server with its draft in the lessons shape (§8.5). */
function publicNote(note) {
  return note ? { ...note, draft: normaliseDraft(note.draft) } : note;
}

export function checkDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = str(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw bad('classDate must look like 2026-09-11.');
  return d;
}

function uploadDir(noteId) { return path.join(config.dataDir, 'uploads', noteId); }

/* Keep only characters that are safe in a path and in a URL segment; a name the
   learner's phone invented must never be able to point outside the folder. */
function safeName(raw, type, taken) {
  let name = str(raw).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '');
  if (!name) name = 'photo';
  let ext = path.extname(name).toLowerCase();
  if (!ext || ext.length > 6) {
    ext = IMAGE_TYPES[type] || '';
    name += ext;
  }
  const base = ext ? name.slice(0, -ext.length) : name;
  let out = `${base.slice(0, 60)}${ext}`;
  let n = 2;
  while (taken.has(out)) out = `${base.slice(0, 60)}-${n++}${ext}`;
  taken.add(out);
  return out;
}

function parseDataUrl(dataUrl) {
  const m = /^data:([a-zA-Z0-9.+/-]+);base64,([\s\S]*)$/.exec(str(dataUrl));
  if (!m) throw bad('An image must be a base64 data URL (data:image/jpeg;base64,…).');
  const type = m[1].toLowerCase();
  if (!IMAGE_TYPES[type]) throw bad(`${type} is not a supported image type (${Object.keys(IMAGE_TYPES).join(', ')}).`);
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw bad('That image is empty.');
  if (buf.length > MAX_IMAGE_BYTES) throw bad('Each photo must be under 8 MB.');
  return { type, buf };
}

async function writeImages(noteId, images) {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw bad('images must be an array.');
  if (images.length > MAX_IMAGES) throw bad(`Up to ${MAX_IMAGES} photos per note.`);
  const parsed = images.map((img, i) => {
    if (!isPlain(img)) throw bad(`Image ${i + 1} is not an object.`);
    return { name: img.name, declared: str(img.type).toLowerCase(), ...parseDataUrl(img.dataUrl) };
  });
  if (!parsed.length) return [];
  const dir = uploadDir(noteId);
  await fs.mkdir(dir, { recursive: true });
  const taken = new Set();
  const out = [];
  try {
    for (const [i, img] of parsed.entries()) {
      const name = safeName(img.name || `photo-${i + 1}`, img.type, taken);
      await fs.writeFile(path.join(dir, name), img.buf);
      out.push({ name, type: img.type, size: img.buf.length, file: `uploads/${noteId}/${name}` });
    }
  } catch (e) {
    // Half-written folders are worse than none: the note would list files that
    // are not there.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  return out;
}

/* The list view never needs the raw text or the whole draft — those are the two
   fields that make notes.json big. */
function listShape(note) {
  const { draft, text, ...rest } = note;
  const lessons = draftLessons(draft);
  return {
    ...rest,
    excerpt: String(text || '').trim().slice(0, EXCERPT),
    imageCount: (note.images || []).length,
    hasDraft: lessons.length > 0,
    draftLessons: lessons.length,
    draftWords: draftWordCount(draft),
  };
}

function byNewest(a, b) {
  return String(b.classDate || b.createdAt || '').localeCompare(String(a.classDate || a.createdAt || ''))
    || String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
}

/* ---------- the extract job, shared with POST /materials/:id/lessons ---------- */

async function notesInput(note) {
  const images = [];
  for (const img of note.images || []) {
    const buf = await fs.readFile(path.join(config.dataDir, img.file));
    images.push({ name: img.name, type: img.type, dataUrl: `data:${img.type};base64,${buf.toString('base64')}` });
  }
  return { title: note.title, text: note.text || '', images, split: 'one' };
}

async function documentInput(note, job) {
  const src = note.source;
  const material = coll('materials').get(src.materialId);
  if (!material) throw bad('The document these pages came from was deleted.');
  const file = sourcePdf(material.id);
  try { await fs.access(file); } catch { throw bad('The document file is missing from disk.'); }
  // The offset the learner used when they picked the pages, not today's, so the
  // labels always match what they typed.
  const offset = Number(src.offset ?? material.pageOffset) || 0;
  const label = (p) => (offset ? `page ${p - offset} (PDF page ${p})` : `page ${p}`);
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'pml-pages-'));
  try {
    const images = [];
    const texts = [];
    for (const [i, p] of src.pages.entries()) {
      setProgress(job, `Reading page ${i + 1} of ${src.pages.length}…`);
      const out = await renderPage(file, p, path.join(work, `p${p}.jpg`), { longSide: PAGE_LONG_SIDE, quality: 78 });
      const buf = await fs.readFile(out);
      images.push({ name: `page-${p}.jpg`, type: 'image/jpeg', dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}` });
      if (material.textLayer) {
        const t = await pageText(file, p, { maxChars: PAGE_TEXT_CHARS });
        if (t) texts.push(`[${label(p)}]\n${t}`);
      }
    }
    return {
      title: note.title,
      text: texts.join('\n\n'),
      instructions: note.text || '',
      images,
      pages: src.pages.map((p) => ({ pdf: p, printed: p - offset })),
      split: src.split || 'auto',
      source: { title: material.title },
    };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

export function startExtractJob(note, { settings, prefer = '' } = {}) {
  const s = settings || readSettings();
  const job = createJob('extract', async (j) => {
    setProgress(j, note.source ? 'Reading the pages…' : 'Reading your notes…');
    try {
      const input = note.source ? await documentInput(note, j) : await notesInput(note);
      // Known hanzi let the model mark words the learner already has instead of
      // inventing duplicates.
      const knownHanzi = [...new Set(coll('words').all().map((w) => str(w.hanzi)).filter(Boolean))];
      const out = await runTask('extract', {
        ...input,
        classDate: note.classDate,
        learner: { nativeLanguage: s.nativeLanguage, level: s.level, script: s.script },
        knownHanzi,
      }, { settings: s, prefer, onProgress: (t) => setProgress(j, t) });
      return publicNote(coll('notes').update(note.id, {
        draft: out.result, model: out.model, usage: out.usage, status: 'draft', error: null,
      }));
    } catch (e) {
      coll('notes').update(note.id, { status: 'error', error: e?.message || String(e) });
      throw e;      // the job must fail too, or the client waits for nothing
    }
  });
  // Written before the job's first await runs, so a poll never sees "new".
  coll('notes').update(note.id, { status: 'processing', jobId: job.id, error: null });
  return job;
}

/* Jobs live in memory, so a note that was "processing" when the server stopped has
   nobody working on it, and a phone polling its job would wait forever. Called
   once at boot, before any request is served. */
export function recoverInterruptedNotes() {
  let recovered = 0;
  for (const note of coll('notes').all()) {
    if (note.status !== 'processing') continue;
    coll('notes').update(note.id, { status: 'error', jobId: null, error: 'The server restarted while this was being processed. Try again.' });
    recovered += 1;
  }
  return recovered;
}

/* ---------- routes ---------- */

r.get('/notes', (req, res) => {
  res.json({ notes: [...coll('notes').all()].sort(byNewest).map(listShape) });
});

r.post('/notes', async (req, res) => {
  const b = req.body;
  if (!isPlain(b)) throw bad('Send a note object.');
  const text = String(b.text ?? '').trim();
  const images = b.images;
  if (!text && !(Array.isArray(images) && images.length)) throw bad('Paste your notes or add a photo.');
  // The id is minted here because the upload folder is named after it.
  const id = newId();
  const files = await writeImages(id, images);
  const note = coll('notes').insert({
    id,
    title: str(b.title) || 'Class notes',
    classDate: checkDate(b.classDate),
    text,
    images: files,
    status: 'new',
    jobId: null,
    draft: null,
    imported: null,
    model: '',
    usage: null,
    error: null,
  });
  res.status(201).json(publicNote(note));
});

r.get('/notes/:id', (req, res) => {
  res.json(publicNote(noteOr404(req.params.id)));
});

r.put('/notes/:id', (req, res) => {
  const note = noteOr404(req.params.id);
  const b = req.body;
  if (!isPlain(b)) throw bad('Send a note object.');
  const patch = {};
  if (b.title !== undefined) patch.title = str(b.title) || 'Class notes';
  if (b.classDate !== undefined) patch.classDate = checkDate(b.classDate);
  if (b.text !== undefined) patch.text = String(b.text ?? '').trim();
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) throw bad(`status must be one of ${STATUSES.join(', ')}.`);
    patch.status = b.status;
  }
  res.json(publicNote(coll('notes').update(note.id, patch)));
});

r.delete('/notes/:id', async (req, res) => {
  const note = noteOr404(req.params.id);
  await fs.rm(uploadDir(note.id), { recursive: true, force: true });
  coll('notes').remove(note.id);
  if (note.source?.materialId) await releaseIfUnkept(note.source.materialId, { exceptNoteId: note.id });
  res.json({ ok: true });
});

/* Only files this note actually lists are served, so the parameter cannot be
   used to walk the data folder. */
r.get('/notes/:id/images/:name', (req, res, next) => {
  const note = noteOr404(req.params.id);
  const wanted = str(req.params.name);
  const img = (note.images || []).find((i) => i.name === wanted);
  if (!img) return next(bad('No such image.', 404));
  res.sendFile(path.join(uploadDir(note.id), img.name), (err) => {
    if (err && !res.headersSent) next(bad('That image is missing from disk.', 404));
  });
});

r.post('/notes/:id/process', (req, res) => {
  const note = noteOr404(req.params.id);
  const s = readSettings();
  if (!aiReady(s)) throw bad(NO_AI_MESSAGE);
  if (!note.source && !str(note.text) && !(note.images || []).length) throw bad('This note is empty.');
  // An optional model to start with. It must be on the allow-list; the rest of
  // the learner's priority list stays behind it as the backup.
  const model = str(req.body?.model);
  if (model && !isAllowedModel(model)) throw bad('That model is not on the allowed list.');
  const job = startExtractJob(note, { settings: s, prefer: model });
  res.json({ jobId: job.id });
});

r.put('/notes/:id/draft', (req, res) => {
  const note = noteOr404(req.params.id);
  if (note.status !== 'draft') throw bad('This note has no draft to edit.');
  const draft = req.body?.draft;
  if (!isPlain(draft)) throw bad('Send { draft: { lessons: [ { lesson, words } ] } }.');
  // The legacy { lesson, words } body still means one lesson; a body with neither
  // shape is a mistake, not an empty draft.
  if (!Array.isArray(draft.lessons) && !isPlain(draft.lesson)) throw bad('The draft needs its lessons.');
  const lessons = draftLessons(draft);
  if (!lessons.length) throw bad('The draft needs at least one lesson.');
  if (lessons.length > LESSONS_MAX) throw bad(`A draft holds at most ${LESSONS_MAX} lessons.`);
  if (lessons.some((l) => l.words.length > 200)) throw bad('That is too many words for one lesson (200 max).');
  res.json(publicNote(coll('notes').update(note.id, { draft: { lessons } })));
});

/* Import: each draft lesson becomes a real lesson and real words. Every word goes
   through the same dedupe as POST /words, so importing the same note twice merges
   instead of doubling the dictionary. Everything is validated before anything is
   written, so a bad index in lesson 3 cannot leave lessons 1 and 2 half-imported. */
r.post('/notes/:id/import', async (req, res) => {
  const note = noteOr404(req.params.id);
  const lessons = draftLessons(note.draft);
  if (!lessons.length) throw bad('Process this note before importing it.');
  const b = isPlain(req.body) ? req.body : {};
  const modern = Array.isArray(b.lessons);
  if (modern && b.lessons.length > lessons.length) throw bad('That lesson is not in the draft.');

  const picks = lessons.map((l, i) => {
    // Legacy { words, lesson } applies to the first lesson and imports only that one.
    const item = modern ? (isPlain(b.lessons[i]) ? b.lessons[i] : {}) : i === 0 ? { words: b.words, lesson: b.lesson } : { skip: true };
    if (item.skip) return null;
    let idx;
    if (item.words === undefined || item.words === 'all') idx = l.words.map((_, k) => k);
    else if (Array.isArray(item.words)) {
      idx = [];
      for (const raw of item.words) {
        const k = Number(raw);
        if (!Number.isInteger(k) || k < 0 || k >= l.words.length) throw bad(lessons.length > 1 ? `That word is not in lesson ${i + 1} of the draft.` : 'That word is not in the draft.');
        if (!idx.includes(k)) idx.push(k);
      }
    } else throw bad('words must be "all" or a list of draft indexes.');
    return { idx, withLesson: item.lesson === undefined ? true : Boolean(item.lesson) };
  });
  if (!picks.some(Boolean)) throw bad('Pick at least one lesson to import.');
  if (picks.every((p) => !p || (!p.idx.length && !p.withLesson))) throw bad('Pick at least one word to import.');

  const lessonIds = [];
  const wordIds = [];
  const mergedHanzi = [];
  const createdHere = new Set();
  for (const [i, pick] of picks.entries()) {
    if (!pick) continue;
    const { lesson: l, words } = lessons[i];
    let lesson = null;
    if (pick.withLesson) {
      lesson = coll('lessons').insert({
        title: str(l.title) || note.title || 'Lesson',
        titleZh: str(l.titleZh),
        summary: String(l.summary ?? '').trim(),
        classDate: note.classDate || null,
        noteId: note.id,
        order: nextOrder(),
        sections: Array.isArray(l.sections) ? l.sections.filter(isPlain) : [],
        grammar: Array.isArray(l.grammar) ? l.grammar.filter(isPlain) : [],
        dialogue: Array.isArray(l.dialogue) ? l.dialogue.filter(isPlain) : [],
        wordIds: [],
        status: 'new',
        source: note.source ? { materialId: note.source.materialId, title: note.source.title, printed: note.source.printed } : null,
      });
    }
    const ids = [];
    for (const k of pick.idx) {
      const d = words[k];
      if (!isPlain(d) || !str(d.hanzi)) continue;
      const { word, merged } = upsertWord(d, { lessonId: lesson?.id || null, noteId: note.id });
      if (!ids.includes(word.id)) ids.push(word.id);
      if (!wordIds.includes(word.id)) wordIds.push(word.id);
      // A word two lessons of this import share is new, not "already known".
      if (!merged) createdHere.add(word.id);
      else if (!createdHere.has(word.id) && !mergedHanzi.includes(word.hanzi)) mergedHanzi.push(word.hanzi);
    }
    // The lesson lists every word the learner imported, merged ones included.
    if (lesson) {
      coll('lessons').update(lesson.id, { wordIds: ids });
      lessonIds.push(lesson.id);
    }
  }

  coll('notes').update(note.id, {
    status: 'imported',
    imported: { lessonId: lessonIds[0] || null, lessonIds, wordIds, mergedHanzi },
  });
  if (note.source?.materialId) {
    recordCoverage(note.source.materialId, { pages: note.source.pages, lessonIds, noteId: note.id });
    await releaseIfUnkept(note.source.materialId);
  }

  const created = createdHere.size;
  const xp = 10 * Math.max(1, lessonIds.length);
  addXp(xp, { kind: 'import' });
  bumpDay({ newWords: created });
  res.json({ lessonIds, lessonId: lessonIds[0] || null, wordIds, mergedHanzi, created, xp, stats: getStats() });
});

export default r;
