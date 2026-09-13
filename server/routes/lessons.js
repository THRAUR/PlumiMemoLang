/* Lessons: the path on the Today screen and the cards the learner reads after
   class. A lesson owns a list of word ids; the words themselves point back with
   lessonId, and this router keeps the two sides in agreement. */
import { Router } from 'express';
import { coll } from '../store.js';
import { decorate, decorateAll } from '../lib/words.js';
import { isPlain } from '../defaults.js';

const r = Router();

const SECTION_KINDS = ['vocab', 'grammar', 'dialogue', 'culture', 'tip', 'text'];
const STATUSES = ['new', 'started', 'done'];
const LEARNED = 25;
const MASTERED = 75;

function bad(msg, status = 400) { return Object.assign(new Error(msg), { status }); }
function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }

function lessonOr404(id) {
  const lesson = coll('lessons').get(id);
  if (!lesson) throw bad('No such lesson.', 404);
  return lesson;
}

function checkDate(v, field = 'classDate') {
  if (v === null || v === undefined || v === '') return null;
  const d = str(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw bad(`${field} must look like 2026-09-11.`);
  return d;
}

function cleanSections(v) {
  if (!Array.isArray(v)) throw bad('sections must be an array.');
  return v.filter(isPlain).map((s, i) => {
    const kind = str(s.kind) || 'text';
    if (!SECTION_KINDS.includes(kind)) throw bad(`Section ${i + 1}: "${kind}" is not a section kind (${SECTION_KINDS.join(', ')}).`);
    return { kind, title: str(s.title), titleZh: str(s.titleZh), body: String(s.body ?? '') };
  });
}

function cleanExamples(v) {
  if (!Array.isArray(v)) return [];
  return v.filter(isPlain).map((e) => ({ zh: str(e.zh), pinyin: str(e.pinyin), zhuyin: str(e.zhuyin), translation: str(e.translation) })).filter((e) => e.zh);
}

function cleanGrammar(v) {
  if (!Array.isArray(v)) throw bad('grammar must be an array.');
  return v.filter(isPlain).map((g) => ({ pattern: str(g.pattern), explanation: String(g.explanation ?? ''), examples: cleanExamples(g.examples) }));
}

function cleanDialogue(v) {
  if (!Array.isArray(v)) throw bad('dialogue must be an array.');
  return v.filter(isPlain).map((l) => ({ speaker: str(l.speaker), zh: str(l.zh), pinyin: str(l.pinyin), zhuyin: str(l.zhuyin), translation: str(l.translation) }));
}

function cleanWordIds(v) {
  if (!Array.isArray(v)) throw bad('wordIds must be an array of word ids.');
  const out = [];
  for (const raw of v) {
    const id = str(raw);
    if (!id || out.includes(id)) continue;
    if (!coll('words').get(id)) throw bad('No such word.', 404);
    out.push(id);
  }
  return out;
}

/* learned / mastered are score thresholds, so progress is recomputed on every
   read — the same reason score itself is never stored. */
export function progressFor(lesson) {
  const words = (lesson.wordIds || []).map((id) => coll('words').get(id)).filter(Boolean).map(decorate);
  const total = words.length;
  const learned = words.filter((w) => w.score >= LEARNED).length;
  const mastered = words.filter((w) => w.score >= MASTERED).length;
  const avgScore = total ? Math.round(words.reduce((n, w) => n + w.score, 0) / total) : 0;
  return { total, learned, mastered, avgScore };
}

function withProgress(lesson) {
  return { ...lesson, progress: progressFor(lesson) };
}

function byOrder(a, b) {
  return (a.order || 0) - (b.order || 0) || String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
}

export function nextOrder() {
  return coll('lessons').all().reduce((max, l) => Math.max(max, Number(l.order) || 0), 0) + 1;
}

/* Words and lessons point at each other; move the pointers together. */
function syncWordLinks(lessonId, before = [], after = []) {
  for (const id of after) {
    if (before.includes(id)) continue;
    const w = coll('words').get(id);
    // Never steal a word that already belongs to another lesson.
    if (w && !w.lessonId) coll('words').update(id, { lessonId });
  }
  for (const id of before) {
    if (after.includes(id)) continue;
    const w = coll('words').get(id);
    if (w && w.lessonId === lessonId) coll('words').update(id, { lessonId: null });
  }
}

r.get('/lessons', (req, res) => {
  res.json({ lessons: [...coll('lessons').all()].sort(byOrder).map(withProgress) });
});

/* Before /lessons/:id so "reorder" is not read as an id. */
r.post('/lessons/reorder', (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids)) throw bad('Send { ids: [lessonId, …] } in the new order.');
  const seen = new Set();
  let order = 1;
  for (const raw of ids) {
    const id = str(raw);
    if (!id || seen.has(id)) continue;
    if (!coll('lessons').get(id)) throw bad('No such lesson.', 404);
    seen.add(id);
    coll('lessons').update(id, { order: order++ });
  }
  // Anything the client did not mention keeps its relative position, behind.
  for (const lesson of [...coll('lessons').all()].sort(byOrder)) {
    if (seen.has(lesson.id)) continue;
    coll('lessons').update(lesson.id, { order: order++ });
  }
  res.json({ ok: true, lessons: [...coll('lessons').all()].sort(byOrder).map((l) => ({ id: l.id, order: l.order })) });
});

r.post('/lessons', (req, res) => {
  const b = req.body;
  if (!isPlain(b)) throw bad('Send a lesson object.');
  const title = str(b.title);
  if (!title) throw bad('A lesson needs a title.');
  const wordIds = b.wordIds === undefined ? [] : cleanWordIds(b.wordIds);
  const lesson = coll('lessons').insert({
    title,
    titleZh: str(b.titleZh),
    summary: String(b.summary ?? '').trim(),
    classDate: checkDate(b.classDate),
    noteId: b.noteId ? str(b.noteId) : null,
    order: b.order === undefined ? nextOrder() : Math.max(1, Math.round(Number(b.order) || 1)),
    sections: b.sections === undefined ? [] : cleanSections(b.sections),
    grammar: b.grammar === undefined ? [] : cleanGrammar(b.grammar),
    dialogue: b.dialogue === undefined ? [] : cleanDialogue(b.dialogue),
    wordIds,
    status: 'new',
  });
  syncWordLinks(lesson.id, [], wordIds);
  res.status(201).json(withProgress(lesson));
});

r.get('/lessons/:id', (req, res) => {
  const lesson = lessonOr404(req.params.id);
  const words = decorateAll((lesson.wordIds || []).map((id) => coll('words').get(id)).filter(Boolean));
  res.json({ ...withProgress(lesson), words });
});

r.put('/lessons/:id', (req, res) => {
  const lesson = lessonOr404(req.params.id);
  const b = req.body;
  if (!isPlain(b)) throw bad('Send a lesson object.');
  const patch = {};
  if (b.title !== undefined) {
    const title = str(b.title);
    if (!title) throw bad('A lesson needs a title.');
    patch.title = title;
  }
  if (b.titleZh !== undefined) patch.titleZh = str(b.titleZh);
  if (b.summary !== undefined) patch.summary = String(b.summary ?? '').trim();
  if (b.classDate !== undefined) patch.classDate = checkDate(b.classDate);
  if (b.sections !== undefined) patch.sections = cleanSections(b.sections);
  if (b.grammar !== undefined) patch.grammar = cleanGrammar(b.grammar);
  if (b.dialogue !== undefined) patch.dialogue = cleanDialogue(b.dialogue);
  if (b.order !== undefined) patch.order = Math.max(1, Math.round(Number(b.order) || 1));
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) throw bad(`status must be one of ${STATUSES.join(', ')}.`);
    patch.status = b.status;
  }
  if (b.wordIds !== undefined) patch.wordIds = cleanWordIds(b.wordIds);
  const next = coll('lessons').update(lesson.id, patch);
  if (patch.wordIds) syncWordLinks(lesson.id, lesson.wordIds || [], patch.wordIds);
  res.json(withProgress(next));
});

/* The words survive a deleted lesson — they are the dictionary, not the card. */
r.delete('/lessons/:id', (req, res) => {
  const lesson = lessonOr404(req.params.id);
  for (const w of coll('words').all()) {
    if (w.lessonId === lesson.id) coll('words').update(w.id, { lessonId: null });
  }
  coll('lessons').remove(lesson.id);
  res.json({ ok: true });
});

export default r;
