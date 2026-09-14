/* Challenge: a mixed quiz built locally from the dictionary (no model, no
   network), plus an optional AI-written short reading. Built challenges are kept
   in memory for a moment so finishing one can be checked against what was
   actually asked. */
import { Router } from 'express';
import { coll, doc, newId } from '../store.js';
import * as srs from '../srs.js';
import { runTask, hasApiKey } from '../ai/tasks.js';
import { createJob, setProgress } from '../jobs.js';
import { DEFAULT_PROGRESS, deepMerge, isPlain } from '../defaults.js';
import { addXp, bumpDay, getStats, readSettings } from '../stats.js';
import { buildQuestions, countAnswers, makeRng, shuffled, QUESTION_TYPES, OPTION_IDS, FOCI } from '../lib/challenge.js';
import { learnerProfile } from '../../shared/goals.js';

const r = Router();

const KEEP = 20;
const READING_WORDS = 10;
const TYPES = ['mixed', 'lesson', 'reading'];
/* id -> { questions, expected }. Only the last few matter: a challenge the
   learner abandoned yesterday is not worth XP today. */
const recent = new Map();

function bad(msg, status = 400) { return Object.assign(new Error(msg), { status }); }

function remember(id, questions) {
  recent.set(id, { id, questions, expected: countAnswers(questions), at: Date.now() });
  while (recent.size > KEEP) recent.delete(recent.keys().next().value);
  return id;
}

function poolFor(lessonId) {
  const all = coll('words').all();
  return lessonId ? all.filter((w) => w.lessonId === lessonId) : all;
}

r.post('/challenge/build', (req, res) => {
  const b = isPlain(req.body) ? req.body : {};
  const size = b.size === undefined ? 10 : Math.round(Number(b.size));
  if (!Number.isFinite(size) || size < 1 || size > 40) throw bad('size must be between 1 and 40.');
  const lessonId = String(b.lessonId || '') || null;
  if (lessonId && !coll('lessons').get(lessonId)) throw bad('No such lesson.', 404);
  let types = null;
  if (b.types !== undefined) {
    if (!Array.isArray(b.types)) throw bad('types must be an array.');
    types = b.types.map((t) => String(t || '').trim());
    const wrong = types.find((t) => !QUESTION_TYPES.includes(t));
    if (wrong) throw bad(`"${wrong}" is not a question type (${QUESTION_TYPES.join(', ')}).`);
  }
  const s = readSettings();
  // The client sends the focus it displays for; a caller that does not say gets the
  // learner's own goals, so a speaking learner is never handed a character drill
  // just because a request left the field out (§8.4).
  let focus;
  if (b.focus === undefined || b.focus === null || b.focus === '') focus = learnerProfile(s).focus;
  else {
    focus = String(b.focus);
    if (!FOCI.includes(focus)) throw bad(`focus must be one of ${FOCI.join(', ')}.`);
  }
  const seed = b.seed === undefined || b.seed === null ? null : String(b.seed);

  if (b.reading) {
    if (!hasApiKey(s)) throw bad('Add your OpenRouter API key to generate a reading.');
    const pool = poolFor(lessonId);
    if (pool.length < 4) throw bad('Add at least 4 words first.');
    const rng = makeRng(seed);
    // Prefer words the learner has actually seen, so the passage is readable.
    const seen = pool.filter((w) => (w.stats?.reviews || 0) > 0);
    const rest = pool.filter((w) => !((w.stats?.reviews || 0) > 0));
    const words = [...shuffled(seen, rng), ...shuffled(rest, rng)].slice(0, READING_WORDS);
    const job = createJob('reading', async (j) => {
      setProgress(j, 'Writing a short reading…');
      const out = await runTask('reading', { words, level: s.level, nativeLanguage: s.nativeLanguage }, { settings: s, onProgress: (t) => setProgress(j, t) });
      const result = out.result || {};
      const questions = [{
        type: 'reading',
        title: String(result.title || '').trim(),
        passage: result.passage || { zh: '', pinyin: '', zhuyin: '', translation: '' },
        // The task returns options as plain strings + an index; the client works
        // with ids everywhere else, so convert here.
        questions: (result.questions || []).map((q) => {
          const options = (q?.options || []).map((text, i) => ({ id: OPTION_IDS[i], text: String(text ?? '') }));
          const answerId = options[Number(q?.answerIndex)]?.id || options[0]?.id || 'a';
          return { q: String(q?.q || '').trim(), options, answerId };
        }).filter((q) => q.q && q.options.length),
      }];
      const id = remember(newId(), questions);
      return { id, questions, model: out.model, usage: out.usage };
    });
    return res.json({ jobId: job.id });
  }

  const questions = buildQuestions(coll('words').all(), { size, lessonId, types, focus, script: s.script, seed });
  if (!questions.length) {
    // A hand-picked list can fail where the full one would not (order-pinyin needs
    // example sentences with pinyin), so say which lever to pull.
    if (types?.length) throw bad('None of those question types fit your words yet. Pick a few more types.');
    throw bad('Your words need meanings (and an example or two) before a challenge can be built.');
  }
  const id = remember(newId(), questions);
  res.json({ id, questions });
});

r.post('/challenge/finish', (req, res) => {
  const b = isPlain(req.body) ? req.body : {};
  if (!Array.isArray(b.answers)) throw bad('Send the answers you gave.');
  const id = String(b.id || '') || newId();
  const lessonId = String(b.lessonId || '') || null;
  const type = b.type === undefined ? (lessonId ? 'lesson' : 'mixed') : String(b.type);
  if (!TYPES.includes(type)) throw bad(`type must be one of ${TYPES.join(', ')}.`);

  const built = recent.get(id);
  // A client cannot pad the answer list past what was actually asked.
  const cap = built ? built.expected : b.answers.length;
  const answers = b.answers.filter(isPlain).slice(0, Math.max(0, cap));
  const total = answers.length || cap;
  let score = 0;
  let ms = 0;
  for (const a of answers) {
    const ok = a.correct === true;
    if (ok) score += 1;
    ms += Math.max(0, Number(a.ms) || 0);
    const word = a.wordId ? coll('words').get(String(a.wordId)) : null;
    // A challenge answer counts towards accuracy but never reschedules the
    // card: only a graded review may move a due date.
    if (word) coll('words').update(word.id, (cur) => ({ ...cur, stats: srs.recordOutcome(cur.stats, ok) }));
  }

  const xp = 2 * score + 5;
  addXp(xp, { kind: 'challenge' });
  bumpDay({ challenges: 1, correct: score, minutes: ms ? ms / 60000 : 0 });
  doc('progress').set((cur) => {
    const p = deepMerge(DEFAULT_PROGRESS, cur || {});
    p.challenges = [...(p.challenges || []), { id, at: new Date().toISOString(), type, lessonId, score, total, xp }].slice(-100);
    return p;
  });
  recent.delete(id);

  res.json({ score, total, xp, stats: getStats() });
});

export default r;
