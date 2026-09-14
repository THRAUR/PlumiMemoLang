/* XP, the streak, and the numbers the Today screen shows.
   Every gain goes through addXp() so the streak is counted in exactly one
   place: a route that wrote progress.days itself would eventually disagree with
   another route about what "active today" means. Calendar days are LOCAL — the
   learner's evening study session must land on the day they think it is, not on
   UTC's. */
import { coll, doc } from './store.js';
import * as srs from './srs.js';
import { DEFAULT_SETTINGS, DEFAULT_PROGRESS, deepMerge } from './defaults.js';
import { normaliseTemplates, normaliseGoals } from '../shared/goals.js';

const EMPTY_DAY = { xp: 0, reviews: 0, correct: 0, newWords: 0, challenges: 0, minutes: 0 };

export function today(d = new Date()) {
  if (Number.isNaN(d?.getTime?.())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* Day arithmetic through the local Date constructor so month ends and DST
   shifts are the platform's problem, not ours. */
export function shiftDay(ymd, delta = 0) {
  const [y, m, d] = String(ymd || today()).split('-').map(Number);
  return today(new Date(y, (m || 1) - 1, (d || 1) + delta));
}

/* Settings as the rest of the server should see them: an old settings.json gains
   every field added to DEFAULT_SETTINGS since it was written. */
export function readSettings() {
  const s = deepMerge(DEFAULT_SETTINGS, doc('settings').get() || {});
  // Builtin card templates follow the code and goals are always complete, so an
  // older settings file needs no migration step (§8.1).
  s.cardTemplates = normaliseTemplates(s.cardTemplates);
  s.goals = normaliseGoals(s.goals);
  return s;
}

function readProgress() {
  return deepMerge(DEFAULT_PROGRESS, doc('progress').get() || {});
}

/* Mutate a complete progress document and store it back whole. */
function withProgress(fn) {
  const next = readProgress();
  const out = fn(next) || next;
  doc('progress').set(() => out);
  return out;
}

function dayOf(p, day) {
  p.days[day] = { ...EMPTY_DAY, ...(p.days[day] || {}) };
  return p.days[day];
}

function round(n, places = 3) {
  const f = 10 ** places;
  return Math.round((Number(n) || 0) * f) / f;
}

/* kind/extra are part of the §4.8 signature and are accepted for callers that
   want to label a gain; nothing is stored per kind yet. */
export function addXp(amount = 0, { kind = '', extra = null } = {}) {   // eslint-disable-line no-unused-vars
  const gain = Number(amount) || 0;
  const day = today();
  return withProgress((p) => {
    const d = dayOf(p, day);
    d.xp = round(d.xp + gain);
    p.xpTotal = round((p.xpTotal || 0) + gain);
    if (gain > 0) {
      const last = p.streak.lastActive;
      p.streak.current = last === day
        ? Math.max(1, p.streak.current || 0)
        : last === shiftDay(day, -1) ? (p.streak.current || 0) + 1 : 1;
      p.streak.best = Math.max(p.streak.best || 0, p.streak.current);
      p.streak.lastActive = day;
    }
    return p;
  });
}

export function bumpDay(fields = {}) {
  const day = today();
  return withProgress((p) => {
    const d = dayOf(p, day);
    for (const [k, v] of Object.entries(fields || {})) {
      const n = Number(v) || 0;
      if (!n || !(k in EMPTY_DAY)) continue;
      d[k] = round(d[k] + n);
    }
    return p;
  });
}

/* Totals over the append-only usage log. Exported because GET /api/usage wants
   the same arithmetic with one extra field. */
export function usageTotals() {
  const day = today();
  const month = day.slice(0, 7);
  let todayUsd = 0, monthUsd = 0, allUsd = 0, calls = 0;
  for (const e of coll('usage').all()) {
    const cost = Number(e?.cost) || 0;
    const d = e?.at ? today(new Date(e.at)) : '';
    calls += 1;
    allUsd += cost;
    if (d && d === day) todayUsd += cost;
    if (d && d.slice(0, 7) === month) monthUsd += cost;
  }
  return { todayUsd: round(todayUsd, 6), monthUsd: round(monthUsd, 6), allUsd: round(allUsd, 6), calls };
}

export function getStats() {
  const s = readSettings();
  const p = readProgress();
  const day = today();
  const now = Date.now();

  const counts = { words: 0, new: 0, seen: 0, familiar: 0, mastered: 0, dueNow: 0, learning: 0 };
  for (const w of coll('words').all()) {
    counts.words += 1;
    const key = srs.band(srs.score(w.srs, w.stats, now))?.key;
    if (key && key in counts) counts[key] += 1;
    if (srs.isDue(w.srs, now)) counts.dueNow += 1;
    if (w.srs?.state === 'learning' || w.srs?.state === 'relearning') counts.learning += 1;
  }

  const week = [];
  for (let i = 6; i >= 0; i -= 1) {
    const date = shiftDay(day, -i);
    const d = p.days[date] || EMPTY_DAY;
    week.push({ date, xp: d.xp || 0, reviews: d.reviews || 0 });
  }

  const { todayUsd, monthUsd } = usageTotals();
  return {
    today: day,
    xpToday: p.days[day]?.xp || 0,
    goal: Number(s.dailyGoalXp) || 0,
    xpTotal: p.xpTotal || 0,
    streak: {
      current: p.streak?.current || 0,
      best: p.streak?.best || 0,
      lastActive: p.streak?.lastActive || null,
      activeToday: (p.days[day]?.xp || 0) > 0,
    },
    counts,
    week,
    usage: { todayUsd, monthUsd, monthBudgetUsd: Number(s.ai?.monthlyBudgetUsd) || 0 },
  };
}
