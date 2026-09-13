/* Review: the memo-card session. All the scheduling lives in server/srs.js —
   this router only reads the queue, writes back the graded card, and pays XP. */
import { Router } from 'express';
import { coll } from '../store.js';
import * as srs from '../srs.js';
import { decorate } from '../lib/words.js';
import { addXp, bumpDay, getStats, readSettings } from '../stats.js';

const r = Router();

function bad(msg, status = 400) { return Object.assign(new Error(msg), { status }); }

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

r.get('/review/queue', (req, res) => {
  const s = readSettings();
  const now = Date.now();
  const lessonId = String(req.query.lessonId || '') || null;
  if (lessonId && !coll('lessons').get(lessonId)) throw bad('No such lesson.', 404);
  const limitTotal = num(req.query.limit) ?? 20;
  const limitNew = num(req.query.newLimit) ?? (Number(s.newWordsPerDay) || 0);
  const includeNew = !(req.query.includeNew === '0' || req.query.includeNew === 'false');
  const { cards, counts } = srs.buildQueue(coll('words').all(), { now, limitNew, limitTotal, lessonId, includeNew });
  res.json({
    // preview tells the client what each button will do before it is pressed.
    cards: (cards || []).map((c) => ({ ...decorate(c), preview: srs.preview(c.srs, now) })),
    counts,
    templates: (s.cardTemplates || []).filter((t) => t.enabled),
  });
});

r.post('/review/grade', (req, res) => {
  const b = req.body || {};
  const word = coll('words').get(String(b.wordId || ''));
  if (!word) throw bad('No such word.', 404);
  const grade = Number(b.grade);
  if (!Number.isInteger(grade) || grade < 0 || grade > 3) throw bad('grade must be 0 (again), 1 (hard), 2 (good) or 3 (easy).');
  const ms = Math.max(0, num(b.ms) ?? 0);
  const templateId = String(b.templateId || '');   // recorded by the client; the schedule does not depend on it

  const next = coll('words').update(word.id, (cur) => ({
    ...cur,
    srs: srs.schedule(cur.srs, grade),
    stats: srs.recordOutcome(cur.stats, grade > 0),
  }));

  // +2 for turning the card, +1 more for recalling it comfortably.
  const xp = 2 + (grade >= 2 ? 1 : 0);
  addXp(xp, { kind: 'review', extra: { templateId } });
  bumpDay({ reviews: 1, correct: grade > 0 ? 1 : 0, minutes: ms ? ms / 60000 : 0 });

  res.json({ word: { ...decorate(next), preview: srs.preview(next.srs) }, xp, stats: getStats() });
});

r.post('/review/finish', (req, res) => {
  const b = req.body || {};
  const reviewed = Math.max(0, num(b.reviewed) ?? 0);
  const correct = Math.max(0, num(b.correct) ?? 0);
  const ms = Math.max(0, num(b.ms) ?? 0);
  // The session bonus is for finishing something, not for opening the screen.
  const xp = reviewed > 0 ? 5 : 0;
  if (xp) addXp(xp, { kind: 'session', extra: { reviewed, correct } });
  if (ms) bumpDay({ minutes: ms / 60000 });
  res.json({ xp, stats: getStats() });
});

export default r;
