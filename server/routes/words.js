/* The dictionary. Words are the centre of the app: lessons point at them,
   review schedules them, challenges quiz them — so this router only ever
   touches one word at a time and leaves the scoring to server/srs.js. */
import { Router } from 'express';
import { coll } from '../store.js';
import * as srs from '../srs.js';
import { runTask, aiReady, NO_AI_MESSAGE } from '../ai/tasks.js';
import { createJob, setProgress } from '../jobs.js';
import { readSettings } from '../stats.js';
import {
  decorate, decorateAll, upsertWord, cleanWordInput, fillEmpty, filterWords, sortWords,
  allTags, toCsv, lessonTitleMap, newStats, WRITABLE, fileWordInLesson } from '../lib/words.js';

const r = Router();

function bad(msg, status = 400) { return Object.assign(new Error(msg), { status }); }

function wordOr404(id) {
  const word = coll('words').get(id);
  if (!word) throw bad('No such word.', 404);
  return word;
}

r.get('/words', (req, res) => {
  const { q = '', lessonId = '', tag = '', type = '', band = '', sort = 'score', dir = '' } = req.query;
  const all = coll('words').all();
  const filtered = filterWords(all, { q, lessonId, tag, type, band });
  const words = sortWords(decorateAll(filtered), String(sort), String(dir));
  res.json({ words, total: words.length, tags: allTags(all) });
});

/* Before /words/:id: "export" is a word id as far as Express is concerned. */
r.get('/words/export', (req, res) => {
  const format = String(req.query.format || 'json').toLowerCase();
  const words = sortWords(decorateAll(coll('words').all()), 'alpha', 'asc');
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="plumimemolang-words.csv"');
    return res.send(toCsv(words, lessonTitleMap()));
  }
  if (format !== 'json') throw bad('format must be json or csv.');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="plumimemolang-words.json"');
  res.send(JSON.stringify({ exportedAt: new Date().toISOString(), count: words.length, words }, null, 2));
});

r.post('/words', (req, res) => {
  const lessonId = String(req.body?.lessonId || '');
  if (lessonId && !coll('lessons').get(lessonId)) throw bad('No such lesson.', 404);
  const { word, merged } = upsertWord(req.body, { strict: true });
  // A merge is not a creation: 200 + merged:true so the client can say so.
  if (merged) return res.status(200).json({ word, merged: true });
  res.status(201).json(word);
});

r.get('/words/:id', (req, res) => {
  const word = wordOr404(req.params.id);
  const lesson = word.lessonId ? coll('lessons').get(word.lessonId) : null;
  res.json({ ...decorate(word), lesson: lesson ? { id: lesson.id, title: lesson.title || '' } : null });
});

r.put('/words/:id', (req, res) => {
  const word = wordOr404(req.params.id);
  const patch = cleanWordInput(req.body, { strict: true });
  if (patch.hanzi !== undefined && !patch.hanzi) throw bad('A word needs its hanzi.');
  if (patch.hanzi && patch.hanzi !== word.hanzi) {
    const clash = coll('words').find((w) => w.id !== word.id && String(w.hanzi || '').trim() === patch.hanzi);
    if (clash) throw bad(`${patch.hanzi} is already in your dictionary.`, 409);
  }
  if (patch.lessonId && !coll('lessons').get(patch.lessonId)) throw bad('No such lesson.', 404);
  const clean = {};
  for (const f of WRITABLE) if (patch[f] !== undefined) clean[f] = patch[f];
  // srs/stats/id/createdAt are never in WRITABLE: a PUT must not erase the
  // learner's memory of a word.
  const updated = coll('words').update(word.id, clean);
  if (clean.lessonId !== undefined) fileWordInLesson(updated.id, updated.lessonId || null, word.lessonId || null);
  res.json(decorate(updated));
});

r.delete('/words/:id', (req, res) => {
  const word = wordOr404(req.params.id);
  coll('words').remove(word.id);
  for (const lesson of coll('lessons').all()) {
    if (!(lesson.wordIds || []).includes(word.id)) continue;
    coll('lessons').update(lesson.id, { wordIds: lesson.wordIds.filter((id) => id !== word.id) });
  }
  res.json({ ok: true });
});

/* Enrich runs as a job: filling in a word is a model call and a phone should
   not hold the request open for it. */
r.post('/words/:id/enrich', (req, res) => {
  const word = wordOr404(req.params.id);
  const s = readSettings();
  if (!aiReady(s)) throw bad(NO_AI_MESSAGE);
  const job = createJob('enrich', async (j) => {
    setProgress(j, `Completing ${word.hanzi}…`);
    const out = await runTask('enrich', { word, nativeLanguage: s.nativeLanguage }, { settings: s, onProgress: (t) => setProgress(j, t) });
    const current = coll('words').get(word.id);
    if (!current) throw new Error('That word was deleted while the model was working.');
    const patch = fillEmpty(current, out.result);
    const next = Object.keys(patch).length ? coll('words').update(current.id, patch) : current;
    return decorate(next);
  });
  res.json({ jobId: job.id });
});

/* Explain is short enough to answer inline — the learner is staring at the word. */
r.post('/words/:id/explain', async (req, res) => {
  const word = wordOr404(req.params.id);
  const question = String(req.body?.question ?? '').trim();
  if (!question) throw bad('Ask a question about this word.');
  if (question.length > 500) throw bad('That question is too long (500 characters max).');
  const s = readSettings();
  if (!aiReady(s)) throw bad(NO_AI_MESSAGE);
  const out = await runTask('explain', { word, question, nativeLanguage: s.nativeLanguage }, { settings: s });
  res.json({ answer: out.result?.answer ?? '', usage: out.usage, model: out.model });
});

r.post('/words/:id/reset', (req, res) => {
  const word = wordOr404(req.params.id);
  res.json(decorate(coll('words').update(word.id, { srs: srs.newSrs(), stats: newStats() })));
});

export default r;
