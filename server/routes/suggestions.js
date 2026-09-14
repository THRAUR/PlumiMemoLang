/* Today's AI-suggested new words. One generation per calendar day, cached in
   doc('suggestions') under that date, so opening the Today screen ten times
   costs one model call. */
import { Router } from 'express';
import { coll, doc } from '../store.js';
import { runTask, aiReady, NO_AI_MESSAGE } from '../ai/tasks.js';
import { createJob, getJob, setProgress } from '../jobs.js';
import { isPlain } from '../defaults.js';
import { addXp, bumpDay, getStats, readSettings, today } from '../stats.js';
import { upsertWord, decorate } from '../lib/words.js';

const r = Router();

/* date -> jobId, so two tabs polling Today do not start two generations. */
const running = new Map();

function bad(msg, status = 404) { return Object.assign(new Error(msg), { status }); }
function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }

function entryFor(date) {
  const all = doc('suggestions').get() || {};
  const e = all[date];
  return isPlain(e) && Array.isArray(e.items) ? e : null;
}

function writeEntry(date, entry) {
  doc('suggestions').set((cur) => ({ ...(cur || {}), [date]: entry }));
}

function patchItem(date, index, patch) {
  let updated = null;
  doc('suggestions').set((cur) => {
    const all = { ...(cur || {}) };
    const e = all[date];
    if (!isPlain(e) || !Array.isArray(e.items)) return all;
    const items = e.items.map((it, i) => (i === index ? (updated = { ...it, ...patch }) : it));
    all[date] = { ...e, items };
    return all;
  });
  return updated;
}

function activeJob(date) {
  const id = running.get(date);
  const job = id ? getJob(id) : null;
  return job && (job.status === 'queued' || job.status === 'running') ? job : null;
}

function startGeneration(settings, date) {
  const job = createJob('suggest', async (j) => {
    setProgress(j, 'Choosing words for today…');
    const words = coll('words').all();
    const known = [...new Set(words.map((w) => str(w.hanzi)).filter(Boolean))];
    // What the learner has been studying lately, so suggestions stay on topic.
    const recentTopics = [...coll('lessons').all()]
      .sort((a, b) => String(b.classDate || b.createdAt || '').localeCompare(String(a.classDate || a.createdAt || '')))
      .slice(0, 3).map((l) => str(l.title)).filter(Boolean);
    const out = await runTask('suggest', {
      known,
      level: settings.level,
      recentTopics,
      count: Number(settings.newWordsPerDay) || 5,
      nativeLanguage: settings.nativeLanguage,
    }, { settings, onProgress: (t) => setProgress(j, t) });
    const items = (out.result?.items || []).filter(isPlain).map((it) => ({ ...it, status: 'open', wordId: null }));
    writeEntry(date, { model: out.model, generatedAt: new Date().toISOString(), usage: out.usage, items });
    return { date, items };
  });
  running.set(date, job.id);
  return job;
}

r.get('/suggestions/today', (req, res) => {
  const date = today();
  const entry = entryFor(date);
  if (entry) return res.json({ date, status: 'ready', items: entry.items, model: entry.model || '', generatedAt: entry.generatedAt || null });
  const s = readSettings();
  // No AI connected is a normal state, not an error: Today just shows the invitation.
  // The status keeps its old name, "no-key".
  if (!aiReady(s)) return res.json({ date, status: 'no-key', items: [] });
  const already = activeJob(date);
  if (already) return res.json({ date, status: 'generating', items: [], jobId: already.id });
  const job = startGeneration(s, date);
  res.json({ date, status: 'generating', items: [], jobId: job.id });
});

r.post('/suggestions/refresh', (req, res) => {
  const date = today();
  const s = readSettings();
  if (!aiReady(s)) throw bad(NO_AI_MESSAGE, 400);
  const already = activeJob(date);
  if (already) return res.json({ jobId: already.id });
  // Replaces today's list: the learner asked for different words.
  doc('suggestions').set((cur) => {
    const all = { ...(cur || {}) };
    delete all[date];
    return all;
  });
  res.json({ jobId: startGeneration(s, date).id });
});

function itemOr404(date, index) {
  const entry = entryFor(date);
  if (!entry) throw bad('No suggestions for today yet.');
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= entry.items.length) throw bad('No such suggestion.');
  return { entry, i, item: entry.items[i] };
}

r.post('/suggestions/:index/accept', (req, res) => {
  const date = today();
  const { i, item } = itemOr404(date, req.params.index);
  if (item.status === 'added' && item.wordId) {
    const existing = coll('words').get(item.wordId);
    // Double-tap on a phone must not pay XP twice.
    if (existing) return res.json({ word: decorate(existing), xp: 0, already: true, stats: getStats() });
  }
  const { word } = upsertWord({
    hanzi: item.hanzi,
    pinyin: item.pinyin,
    zhuyin: item.zhuyin,
    meaning: item.meaning,
    meaningNative: item.meaningNative,
    pos: item.pos,
    type: item.type,
    examples: isPlain(item.example) ? [item.example] : item.examples,
    tags: item.tags,
  }, { extraTags: ['suggested'] });
  patchItem(date, i, { status: 'added', wordId: word.id });
  const xp = 1;
  addXp(xp, { kind: 'suggestion' });
  bumpDay({ newWords: 1 });
  res.json({ word, xp, stats: getStats() });
});

r.post('/suggestions/:index/dismiss', (req, res) => {
  const date = today();
  const { i } = itemOr404(date, req.params.index);
  patchItem(date, i, { status: 'dismissed' });
  res.json({ ok: true });
});

export default r;
