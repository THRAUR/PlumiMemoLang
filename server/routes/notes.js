/* Notes: what the learner pastes or photographs after class, and the AI pass
   that turns it into a lesson draft. Photos arrive as data URLs (a phone camera
   roll, no upload widget), are written under <dataDir>/uploads/<noteId>/ and are
   only ever served back by name from that folder. */
import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { coll, newId } from '../store.js';
import { config } from '../config.js';
import { runTask, hasApiKey } from '../ai/tasks.js';
import { createJob, setProgress } from '../jobs.js';
import { addXp, bumpDay, getStats, readSettings } from '../stats.js';
import { deepMerge, isPlain } from '../defaults.js';
import { upsertWord } from '../lib/words.js';
import { nextOrder } from './lessons.js';

const r = Router();

const MAX_IMAGES = 12;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const EXCERPT = 200;
const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const STATUSES = ['new', 'processing', 'draft', 'imported', 'error'];

function bad(msg, status = 400) { return Object.assign(new Error(msg), { status }); }
function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }

function noteOr404(id) {
  const note = coll('notes').get(id);
  if (!note) throw bad('No such note.', 404);
  return note;
}

function checkDate(v) {
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
  return {
    ...rest,
    excerpt: String(text || '').trim().slice(0, EXCERPT),
    imageCount: (note.images || []).length,
    hasDraft: Boolean(draft),
    draftWords: draft?.words?.length || 0,
  };
}

function byNewest(a, b) {
  return String(b.classDate || b.createdAt || '').localeCompare(String(a.classDate || a.createdAt || ''))
    || String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
}

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
  res.status(201).json(note);
});

r.get('/notes/:id', (req, res) => {
  res.json(noteOr404(req.params.id));
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
  res.json(coll('notes').update(note.id, patch));
});

r.delete('/notes/:id', async (req, res) => {
  const note = noteOr404(req.params.id);
  await fs.rm(uploadDir(note.id), { recursive: true, force: true });
  coll('notes').remove(note.id);
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
  if (!hasApiKey(s)) throw bad('Add your OpenRouter API key first.');
  if (!str(note.text) && !(note.images || []).length) throw bad('This note is empty.');
  const model = str(req.body?.model);
  const settings = model ? deepMerge(s, { ai: { models: { extract: model } } }) : s;

  const job = createJob('extract', async (j) => {
    setProgress(j, 'Reading your notes…');
    const images = [];
    for (const img of note.images || []) {
      const buf = await fs.readFile(path.join(config.dataDir, img.file));
      images.push({ name: img.name, type: img.type, dataUrl: `data:${img.type};base64,${buf.toString('base64')}` });
    }
    // Known hanzi let the model mark words the learner already has instead of
    // inventing duplicates.
    const knownHanzi = [...new Set(coll('words').all().map((w) => str(w.hanzi)).filter(Boolean))];
    try {
      const out = await runTask('extract', {
        title: note.title,
        classDate: note.classDate,
        text: note.text || '',
        images,
        learner: { nativeLanguage: s.nativeLanguage, level: s.level, script: s.script },
        knownHanzi,
      }, { settings, onProgress: (t) => setProgress(j, t) });
      const next = coll('notes').update(note.id, {
        draft: out.result, model: out.model, usage: out.usage, status: 'draft', error: null,
      });
      return next;
    } catch (e) {
      coll('notes').update(note.id, { status: 'error', error: e?.message || String(e) });
      throw e;      // the job must fail too, or the client waits for nothing
    }
  });

  coll('notes').update(note.id, { status: 'processing', jobId: job.id, error: null });
  res.json({ jobId: job.id });
});

r.put('/notes/:id/draft', (req, res) => {
  const note = noteOr404(req.params.id);
  if (note.status !== 'draft') throw bad('This note has no draft to edit.');
  const draft = req.body?.draft;
  if (!isPlain(draft)) throw bad('Send { draft: { lesson, words } }.');
  if (!isPlain(draft.lesson)) throw bad('The draft needs a lesson object.');
  if (!Array.isArray(draft.words)) throw bad('The draft needs a words array.');
  if (draft.words.length > 200) throw bad('That is too many words for one lesson (200 max).');
  res.json(coll('notes').update(note.id, { draft: { ...draft, words: draft.words.filter(isPlain) } }));
});

/* Import: the draft becomes a real lesson and real words. Every word goes
   through the same dedupe as POST /words, so importing the same note twice
   merges instead of doubling the dictionary. */
r.post('/notes/:id/import', (req, res) => {
  const note = noteOr404(req.params.id);
  const draft = note.draft;
  if (!isPlain(draft) || !Array.isArray(draft.words)) throw bad('Process this note before importing it.');
  const b = isPlain(req.body) ? req.body : {};
  const wantLesson = b.lesson === undefined ? true : Boolean(b.lesson);

  let picks;
  if (b.words === undefined || b.words === 'all') picks = draft.words.map((_, i) => i);
  else if (Array.isArray(b.words)) {
    picks = [];
    for (const raw of b.words) {
      const i = Number(raw);
      if (!Number.isInteger(i) || i < 0 || i >= draft.words.length) throw bad('That word is not in the draft.');
      if (!picks.includes(i)) picks.push(i);
    }
  } else throw bad('words must be "all" or a list of draft indexes.');
  if (!picks.length && !wantLesson) throw bad('Pick at least one word to import.');

  let lesson = null;
  if (wantLesson && isPlain(draft.lesson)) {
    const l = draft.lesson;
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
    });
  }

  const wordIds = [];
  const mergedHanzi = [];
  let created = 0;
  for (const i of picks) {
    const d = draft.words[i];
    if (!isPlain(d) || !str(d.hanzi)) continue;
    const { word, merged } = upsertWord(d, { lessonId: lesson?.id || null, noteId: note.id });
    if (!wordIds.includes(word.id)) wordIds.push(word.id);
    if (merged) mergedHanzi.push(word.hanzi);
    else created += 1;
  }
  // The lesson lists every word the learner imported, merged ones included.
  if (lesson) lesson = coll('lessons').update(lesson.id, { wordIds });

  coll('notes').update(note.id, {
    status: 'imported',
    imported: { lessonId: lesson?.id || null, wordIds, mergedHanzi },
  });

  const xp = 10;
  addXp(xp, { kind: 'import' });
  bumpDay({ newWords: created });
  res.json({ lessonId: lesson?.id || null, wordIds, mergedHanzi, created, xp, stats: getStats() });
});

export default r;
