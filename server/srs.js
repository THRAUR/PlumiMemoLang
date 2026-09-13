/* Spaced repetition scheduler (Anki-flavoured SM-2). Pure: no I/O, no imports,
   every function takes `now` (ms epoch) so callers/tests are deterministic.
   Contract: docs/ARCHITECTURE.md §3.1 (Word shape) and §4.4. */

export const GRADE = { AGAIN: 0, HARD: 1, GOOD: 2, EASY: 3 };
export const DAY_MS = 86400000;
export const MIN_MS = 60000;

// Learning/relearning steps, in ms. Index 0 = "just missed / brand new",
// index 1 = "seen it once, wait a day". Not exported: it's an implementation
// detail, not part of the Word shape.
const LEARNING_STEPS = [10 * MIN_MS, 1 * DAY_MS];

const EASE_FLOOR = 1.3;
const EASE_CEILING = 3.0;
const INTERVAL_MAX_DAYS = 365;

function clampEase(ease) {
  return Math.min(EASE_CEILING, Math.max(EASE_FLOOR, ease));
}

// Whole-day rounding + [1, 365] clamp shared by every review-state outcome
// (including the lapse formula, whose own "min 1 day" is just this clamp).
function clampInterval(days) {
  return Math.min(INTERVAL_MAX_DAYS, Math.max(1, Math.round(days)));
}

export function newSrs() {
  return { state: 'new', ease: 2.5, interval: 0, step: 0, due: null, reps: 0, lapses: 0, lastReview: null };
}

/**
 * Grade a card and return its next state. Pure: `srs` is never mutated.
 *
 * State machine:
 * - new/learning: Again always drops to step 0. Hard repeats the current
 *   step. Good advances a step, graduating to `review` (interval 1d) once it
 *   runs past the last step. Easy graduates immediately (interval 4d).
 *   While stepping, `interval` mirrors the step's own delay in days (e.g.
 *   10 min = 0.00694…d) — there is no prior interval worth preserving yet.
 * - review: Again lapses to `relearning` (step 0, due 10 min, lapses+1,
 *   ease floored at 1.3, interval = max(1, round(interval * 0.3))). Hard/
 *   Good/Easy stay in `review` and scale the interval by 1.2 / ease /
 *   (ease * 1.3) respectively, rounded to whole days and clamped [1, 365].
 * - relearning: one 10-minute step (Again → step 0, Hard repeats the
 *   step) EXCEPT it deliberately does not touch `interval` while stepping —
 *   that field is left holding the reduced interval computed at the lapse,
 *   because the Word shape has no separate field to remember it elsewhere.
 *   Good (past the last step) or Easy return to `review` reusing that
 *   preserved interval, unmodified, per the contract ("back to review with
 *   the reduced interval").
 */
export function schedule(srs, grade, now = Date.now()) {
  const s = { ...srs };
  s.reps = srs.reps + 1;
  s.lastReview = new Date(now).toISOString();

  const dueIn = (ms) => new Date(now + ms).toISOString();

  if (srs.state === 'new' || srs.state === 'learning') {
    if (grade === GRADE.AGAIN) {
      const delay = LEARNING_STEPS[0];
      s.state = 'learning';
      s.step = 0;
      s.interval = delay / DAY_MS;
      s.due = dueIn(delay);
    } else if (grade === GRADE.HARD) {
      const delay = LEARNING_STEPS[srs.step] ?? LEARNING_STEPS[LEARNING_STEPS.length - 1];
      s.state = 'learning';
      s.interval = delay / DAY_MS;
      s.due = dueIn(delay);
    } else if (grade === GRADE.GOOD) {
      const delay = LEARNING_STEPS[srs.step];
      const nextStep = srs.step + 1;
      if (nextStep < LEARNING_STEPS.length) {
        s.state = 'learning';
        s.step = nextStep;
        s.interval = delay / DAY_MS;
        s.due = dueIn(delay);
      } else {
        s.state = 'review';
        s.step = 0;
        s.interval = 1;
        s.due = dueIn(1 * DAY_MS);
      }
    } else if (grade === GRADE.EASY) {
      s.state = 'review';
      s.step = 0;
      s.interval = 4;
      s.due = dueIn(4 * DAY_MS);
    }
    return s;
  }

  if (srs.state === 'review') {
    if (grade === GRADE.AGAIN) {
      s.state = 'relearning';
      s.step = 0;
      s.lapses = srs.lapses + 1;
      s.ease = clampEase(srs.ease - 0.20);
      s.interval = clampInterval(srs.interval * 0.3);
      s.due = dueIn(LEARNING_STEPS[0]);
    } else if (grade === GRADE.HARD) {
      s.ease = clampEase(srs.ease - 0.15);
      s.interval = clampInterval(srs.interval * 1.2);
      s.due = dueIn(s.interval * DAY_MS);
    } else if (grade === GRADE.GOOD) {
      s.interval = clampInterval(srs.interval * srs.ease);
      s.due = dueIn(s.interval * DAY_MS);
    } else if (grade === GRADE.EASY) {
      s.ease = clampEase(srs.ease + 0.15);
      s.interval = clampInterval(srs.interval * srs.ease * 1.3);
      s.due = dueIn(s.interval * DAY_MS);
    }
    return s;
  }

  if (srs.state === 'relearning') {
    if (grade === GRADE.AGAIN) {
      s.step = 0;
      s.due = dueIn(LEARNING_STEPS[0]);
    } else if (grade === GRADE.HARD) {
      const delay = LEARNING_STEPS[srs.step] ?? LEARNING_STEPS[LEARNING_STEPS.length - 1];
      s.due = dueIn(delay);
    } else if (grade === GRADE.GOOD || grade === GRADE.EASY) {
      // One relearning step, like Anki's default: a lapsed card that is
      // recalled ten minutes later goes straight back to review with the
      // interval the lapse already reduced. Walking it through both learning
      // steps again would show the same card twice in one session.
      s.state = 'review';
      s.step = 0;
      s.due = dueIn(srs.interval * DAY_MS);
    }
    return s;
  }

  return s;
}

/**
 * What each grade would do right now, without committing to it. Delegates to
 * `schedule()` for every grade so the labels are guaranteed to match what
 * grading would actually produce (no parallel formula to drift out of sync).
 */
export function preview(srs, now = Date.now()) {
  const forGrade = (grade) => {
    const next = schedule(srs, grade, now);
    const ms = new Date(next.due).getTime() - now;
    return { ms, label: formatInterval(ms) };
  };
  return {
    again: forGrade(GRADE.AGAIN),
    hard: forGrade(GRADE.HARD),
    good: forGrade(GRADE.GOOD),
    easy: forGrade(GRADE.EASY),
  };
}

// New cards are never "due" — they are "new"; that's a separate bucket in
// buildQueue()/counts, not part of the due pile.
export function isDue(srs, now = Date.now()) {
  if (srs.state === 'new' || !srs.due) return false;
  return new Date(srs.due).getTime() <= now;
}

/**
 * Memorization score 0..100. 0 with no reps yet. Otherwise a retrievability
 * estimate R (0.9^(elapsed/interval), interval floored at 0.25d so a
 * same-minute check-in doesn't divide by ~0) scaled down for young intervals
 * (S) and for a shaky recall history (acc), then capped at 35 while the card
 * is still learning/relearning (it hasn't proven itself over a real gap yet).
 */
export function score(srs, stats, now = Date.now()) {
  if (!srs.reps) return 0;
  const intervalDays = Math.max(srs.interval, 0.25);
  const elapsedDays = Math.max(0, (now - new Date(srs.lastReview).getTime()) / DAY_MS);
  const R = Math.pow(0.9, elapsedDays / intervalDays);
  const S = Math.min(1, intervalDays / 45);
  const history = stats && stats.history ? stats.history : [];
  const acc = history.length ? history.filter((x) => x === 1).length / history.length : 1;
  let result = Math.round(100 * R * (0.35 + 0.65 * S) * (0.6 + 0.4 * acc));
  if (srs.state === 'learning' || srs.state === 'relearning') result = Math.min(35, result);
  return Math.max(0, Math.min(100, result));
}

const BANDS = [
  { key: 'mastered', zh: '通', label: 'Mastered', min: 75, max: 100 },
  { key: 'familiar', zh: '熟', label: 'Familiar', min: 50, max: 74 },
  { key: 'seen', zh: '認', label: 'Seen', min: 25, max: 49 },
  { key: 'new', zh: '生', label: 'New', min: 0, max: 24 },
];

export function band(scoreValue) {
  return BANDS.find((b) => scoreValue >= b.min) ?? BANDS[BANDS.length - 1];
}

/**
 * Assemble a review queue from the full word list. Order: learning/
 * relearning cards that are due (most overdue first), then review cards
 * that are due (most overdue first), then new cards (oldest created first,
 * capped at `limitNew`) — the whole thing then cut to `limitTotal`.
 *
 * `counts.due` is the total due pile (learning + review, before the
 * limitTotal cut) so a "12 due" badge stays correct even when the queue
 * itself is capped; `counts.learning` breaks out how many of those are
 * learning/relearning (usually shown as urgent); `counts.new` is how many
 * new cards actually made it into this queue; `counts.total` is what's
 * actually returned in `cards`.
 */
export function buildQueue(words, options = {}) {
  const {
    now = Date.now(),
    limitNew = Infinity,
    limitTotal = Infinity,
    lessonId = null,
    includeNew = true,
  } = options;

  const pool = lessonId ? words.filter((w) => w.lessonId === lessonId) : words;

  const learning = [];
  const review = [];
  const fresh = [];

  for (const w of pool) {
    const srs = w.srs;
    if (!srs) continue;
    if (srs.state === 'learning' || srs.state === 'relearning') {
      if (isDue(srs, now)) learning.push(w);
    } else if (srs.state === 'review') {
      if (isDue(srs, now)) review.push(w);
    } else if (srs.state === 'new') {
      fresh.push(w);
    }
  }

  // Ascending due date == most overdue (earliest due) first.
  const byDue = (a, b) => new Date(a.srs.due).getTime() - new Date(b.srs.due).getTime();
  learning.sort(byDue);
  review.sort(byDue);
  fresh.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const newCards = includeNew ? fresh.slice(0, limitNew) : [];
  const cards = [...learning, ...review, ...newCards].slice(0, limitTotal);

  return {
    cards,
    counts: {
      due: learning.length + review.length,
      learning: learning.length,
      new: newCards.length,
      total: cards.length,
    },
  };
}

/**
 * Human label for a delay from "now". Only "m" (minutes) and whole-day-based
 * units appear — the scheduler never produces an hour-scale gap, so there is
 * no "h" unit.
 */
export function formatInterval(ms) {
  if (ms < DAY_MS) {
    const minutes = Math.max(1, Math.round(ms / MIN_MS));
    return `${minutes}m`;
  }
  const days = Math.round(ms / DAY_MS);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.round(days / 7)}w`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${Math.round(days / 365)}y`;
}

/**
 * Append a review outcome to a word's `stats`. Pure: returns a new object;
 * `history` is capped at the last 20 outcomes (1 = recalled), streak resets
 * on a miss.
 */
export function recordOutcome(stats, recalled) {
  const prevHistory = stats && stats.history ? stats.history : [];
  const prevReviews = stats && stats.reviews ? stats.reviews : 0;
  const prevCorrect = stats && stats.correct ? stats.correct : 0;
  const prevStreak = stats && stats.streak ? stats.streak : 0;
  return {
    reviews: prevReviews + 1,
    correct: prevCorrect + (recalled ? 1 : 0),
    streak: recalled ? prevStreak + 1 : 0,
    history: [...prevHistory, recalled ? 1 : 0].slice(-20),
  };
}
