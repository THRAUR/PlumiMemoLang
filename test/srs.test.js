import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRADE,
  DAY_MS,
  MIN_MS,
  newSrs,
  schedule,
  preview,
  isDue,
  score,
  band,
  buildQueue,
  formatInterval,
  recordOutcome,
} from '../server/srs.js';

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------- newSrs()

test('newSrs() returns the documented default shape', () => {
  assert.deepEqual(newSrs(), {
    state: 'new',
    ease: 2.5,
    interval: 0,
    step: 0,
    due: null,
    reps: 0,
    lapses: 0,
    lastReview: null,
  });
});

// ---------------------------------------------------------- schedule(): new

test('new + Again -> learning, step 0, due in 10 min', () => {
  const s = schedule(newSrs(), GRADE.AGAIN, NOW);
  assert.equal(s.state, 'learning');
  assert.equal(s.step, 0);
  assert.equal(s.interval, (10 * MIN_MS) / DAY_MS);
  assert.equal(s.due, iso(NOW + 10 * MIN_MS));
  assert.equal(s.reps, 1);
  assert.equal(s.lapses, 0);
  assert.equal(s.lastReview, iso(NOW));
});

test('new + Hard -> learning, repeats step 0 (10 min)', () => {
  const s = schedule(newSrs(), GRADE.HARD, NOW);
  assert.equal(s.state, 'learning');
  assert.equal(s.step, 0);
  assert.equal(s.interval, (10 * MIN_MS) / DAY_MS);
  assert.equal(s.due, iso(NOW + 10 * MIN_MS));
});

test('new + Good -> learning, advances to step 1, due in 10 min', () => {
  // Exact wording from the contract: "a new card graded Good is due in 10
  // min at step 1".
  const s = schedule(newSrs(), GRADE.GOOD, NOW);
  assert.equal(s.state, 'learning');
  assert.equal(s.step, 1);
  assert.equal(s.interval, (10 * MIN_MS) / DAY_MS);
  assert.equal(s.due, iso(NOW + 10 * MIN_MS));
});

test('new + Easy -> graduates immediately to review, interval 4 days', () => {
  const s = schedule(newSrs(), GRADE.EASY, NOW);
  assert.equal(s.state, 'review');
  assert.equal(s.step, 0);
  assert.equal(s.interval, 4);
  assert.equal(s.due, iso(NOW + 4 * DAY_MS));
});

// ------------------------------------------------- schedule(): learning step 1

const learningStep1 = { ...newSrs(), state: 'learning', step: 1, reps: 1 };

test('learning step 1 + Hard repeats the current step (1 day)', () => {
  const s = schedule(learningStep1, GRADE.HARD, NOW);
  assert.equal(s.state, 'learning');
  assert.equal(s.step, 1);
  assert.equal(s.interval, 1);
  assert.equal(s.due, iso(NOW + DAY_MS));
});

test('learning step 1 + Good graduates to review, interval 1 day', () => {
  // "Good again (step 1 -> past the last step) graduates to review with
  // interval 1 day."
  const s = schedule(learningStep1, GRADE.GOOD, NOW);
  assert.equal(s.state, 'review');
  assert.equal(s.step, 0);
  assert.equal(s.interval, 1);
  assert.equal(s.due, iso(NOW + DAY_MS));
});

test('learning step 1 + Easy graduates to review, interval 4 days', () => {
  const s = schedule(learningStep1, GRADE.EASY, NOW);
  assert.equal(s.state, 'review');
  assert.equal(s.step, 0);
  assert.equal(s.interval, 4);
  assert.equal(s.due, iso(NOW + 4 * DAY_MS));
});

test('learning step 1 + Again drops all the way back to step 0', () => {
  const s = schedule(learningStep1, GRADE.AGAIN, NOW);
  assert.equal(s.state, 'learning');
  assert.equal(s.step, 0);
  assert.equal(s.interval, (10 * MIN_MS) / DAY_MS);
  assert.equal(s.due, iso(NOW + 10 * MIN_MS));
});

// ---------------------------------------------------------- schedule(): review

function reviewSrs(overrides) {
  return { ...newSrs(), state: 'review', ease: 2.5, interval: 10, reps: 5, lastReview: iso(NOW - 10 * DAY_MS), ...overrides };
}

test('review + Hard: interval x1.2, ease -0.15', () => {
  const s = schedule(reviewSrs(), GRADE.HARD, NOW);
  assert.equal(s.state, 'review');
  assert.equal(s.interval, 12); // round(10 * 1.2)
  assert.equal(s.ease, 2.35);
  assert.equal(s.due, iso(NOW + 12 * DAY_MS));
});

test('review + Good: interval x ease, ease unchanged', () => {
  const s = schedule(reviewSrs(), GRADE.GOOD, NOW);
  assert.equal(s.state, 'review');
  assert.equal(s.interval, 25); // round(10 * 2.5)
  assert.equal(s.ease, 2.5);
  assert.equal(s.due, iso(NOW + 25 * DAY_MS));
});

test('review + Easy: interval x ease x1.3, ease +0.15 (also whole-day rounding)', () => {
  const s = schedule(reviewSrs(), GRADE.EASY, NOW);
  assert.equal(s.state, 'review');
  // 10 * 2.5 * 1.3 = 32.5 -> rounds to 33.
  assert.equal(s.interval, 33);
  assert.equal(s.ease, 2.65);
  assert.equal(s.due, iso(NOW + 33 * DAY_MS));
});

test('review + Again lapses to relearning: ease -0.20, interval x0.3, lapses+1', () => {
  const s = schedule(reviewSrs({ lapses: 2 }), GRADE.AGAIN, NOW);
  assert.equal(s.state, 'relearning');
  assert.equal(s.step, 0);
  assert.equal(s.lapses, 3);
  assert.equal(s.ease, 2.3);
  assert.equal(s.interval, 3); // round(10 * 0.3)
  assert.equal(s.due, iso(NOW + 10 * MIN_MS)); // short-term step timer, not the reduced interval
});

test('lapse ease is floored at 1.3', () => {
  const s = schedule(reviewSrs({ ease: 1.35 }), GRADE.AGAIN, NOW);
  assert.equal(s.ease, 1.3);
});

test('lapse interval is floored at 1 day', () => {
  const s = schedule(reviewSrs({ interval: 2 }), GRADE.AGAIN, NOW);
  assert.equal(s.interval, 1); // round(2 * 0.3) = 1, already >= min
});

test('lapse interval floor kicks in for a very short interval', () => {
  const s = schedule(reviewSrs({ interval: 1 }), GRADE.AGAIN, NOW);
  // round(1 * 0.3) = 0, floored to the 1-day minimum.
  assert.equal(s.interval, 1);
});

test('review Hard/Good/Easy floor ease at 1.3', () => {
  const hard = schedule(reviewSrs({ ease: 1.35 }), GRADE.HARD, NOW);
  assert.equal(hard.ease, 1.3);
});

test('review ease ceiling is 3.0', () => {
  const s = schedule(reviewSrs({ ease: 2.95 }), GRADE.EASY, NOW);
  assert.equal(s.ease, 3.0);
});

test('review interval is capped at 365 days', () => {
  const s = schedule(reviewSrs({ interval: 300, ease: 3.0 }), GRADE.GOOD, NOW);
  // 300 * 3.0 = 900, clamped to 365.
  assert.equal(s.interval, 365);
});

// ------------------------------------------------------- schedule(): relearning

function relearningSrs(overrides) {
  return { ...newSrs(), state: 'relearning', ease: 2.3, interval: 3, step: 0, lapses: 1, reps: 6, lastReview: iso(NOW - MIN_MS), ...overrides };
}

test('relearning + Hard repeats the current step and does not touch interval', () => {
  const s = schedule(relearningSrs(), GRADE.HARD, NOW);
  assert.equal(s.state, 'relearning');
  assert.equal(s.step, 0);
  assert.equal(s.interval, 3); // preserved, not overwritten by the step delay
  assert.equal(s.due, iso(NOW + 10 * MIN_MS));
});

test('relearning + Again resets to step 0 without another lapse', () => {
  const s = schedule(relearningSrs({ step: 1 }), GRADE.AGAIN, NOW);
  assert.equal(s.state, 'relearning');
  assert.equal(s.step, 0);
  assert.equal(s.lapses, 1); // unchanged: only a review-state Again lapses
  assert.equal(s.interval, 3); // preserved
  assert.equal(s.due, iso(NOW + 10 * MIN_MS));
});

test('relearning + Good goes straight back to review with the reduced interval (one relearning step)', () => {
  // Anki's default relearning ladder is a single 10-minute step: a lapsed
  // card recalled ten minutes later must not be shown a third time in the
  // same session. The interval is the one the lapse already reduced.
  const graduated = schedule(relearningSrs({ step: 0 }), GRADE.GOOD, NOW);
  assert.equal(graduated.state, 'review');
  assert.equal(graduated.step, 0);
  assert.equal(graduated.interval, 3); // the reduced interval, unmodified
  assert.equal(graduated.due, iso(NOW + 3 * DAY_MS));
});

test('relearning + Easy graduates back to review immediately with the reduced interval', () => {
  const s = schedule(relearningSrs({ step: 0 }), GRADE.EASY, NOW);
  assert.equal(s.state, 'review');
  assert.equal(s.step, 0);
  assert.equal(s.interval, 3);
  assert.equal(s.due, iso(NOW + 3 * DAY_MS));
});

// ---------------------------------------------------------- purity / no mutation

test('schedule() does not mutate its input', () => {
  const original = Object.freeze(reviewSrs());
  const snapshot = { ...original };
  assert.doesNotThrow(() => schedule(original, GRADE.GOOD, NOW));
  assert.deepEqual(original, snapshot);
});

test('schedule() returns a fresh object, not the same reference', () => {
  const original = newSrs();
  const next = schedule(original, GRADE.GOOD, NOW);
  assert.notEqual(next, original);
});

// -------------------------------------------------------------------- preview()

test('preview() labels match what schedule() actually produces', () => {
  const cases = [newSrs(), learningStep1, reviewSrs(), relearningSrs()];
  for (const srs of cases) {
    const prev = preview(srs, NOW);
    for (const [key, grade] of [['again', GRADE.AGAIN], ['hard', GRADE.HARD], ['good', GRADE.GOOD], ['easy', GRADE.EASY]]) {
      const next = schedule(srs, grade, NOW);
      const expectedMs = new Date(next.due).getTime() - NOW;
      assert.equal(prev[key].ms, expectedMs, `${key}.ms`);
      assert.equal(prev[key].label, formatInterval(expectedMs), `${key}.label`);
    }
  }
});

test('preview() for a brand new card', () => {
  const prev = preview(newSrs(), NOW);
  assert.equal(prev.again.label, '10m');
  assert.equal(prev.hard.label, '10m');
  assert.equal(prev.good.label, '10m');
  assert.equal(prev.easy.label, '4d');
});

test('preview() does not mutate its input', () => {
  const original = Object.freeze(newSrs());
  assert.doesNotThrow(() => preview(original, NOW));
});

// ---------------------------------------------------------------------- isDue()

test('a new card is never due', () => {
  assert.equal(isDue(newSrs(), NOW), false);
  assert.equal(isDue({ ...newSrs(), state: 'new', due: iso(NOW - DAY_MS) }, NOW), false);
});

test('isDue() is true once due <= now, false while still in the future', () => {
  const past = { ...reviewSrs(), due: iso(NOW - 1) };
  const exact = { ...reviewSrs(), due: iso(NOW) };
  const future = { ...reviewSrs(), due: iso(NOW + 1) };
  assert.equal(isDue(past, NOW), true);
  assert.equal(isDue(exact, NOW), true);
  assert.equal(isDue(future, NOW), false);
});

// ----------------------------------------------------------------------- score()

test('score() is 0 when reps is 0', () => {
  assert.equal(score(newSrs(), { history: [] }, NOW), 0);
});

test('score() is capped at 35 while learning', () => {
  const srs = { ...newSrs(), state: 'learning', interval: 1, reps: 2, lastReview: iso(NOW) };
  // Uncapped this would round to 36; the learning cap must bring it to 35.
  assert.equal(score(srs, { history: [] }, NOW), 35);
});

test('score() is capped at 35 while relearning', () => {
  const srs = { ...newSrs(), state: 'relearning', interval: 3, reps: 5, lastReview: iso(NOW) };
  assert.equal(score(srs, { history: [] }, NOW), 35);
});

test('score() is ~100 for a fresh review with a 45+ day interval and perfect history', () => {
  const srs = { ...newSrs(), state: 'review', interval: 45, reps: 10, lastReview: iso(NOW) };
  assert.equal(score(srs, { history: [1, 1, 1, 1, 1] }, NOW), 100);
  // A longer interval doesn't push it past 100.
  const longer = { ...srs, interval: 90 };
  assert.equal(score(longer, { history: [1, 1, 1, 1, 1] }, NOW), 100);
});

test('score() decays as elapsed time grows past the interval', () => {
  const srs = { ...newSrs(), state: 'review', interval: 10, reps: 5 };
  const stats = { history: [1, 1, 1, 1, 1] };
  const fresh = score({ ...srs, lastReview: iso(NOW) }, stats, NOW);
  const halfway = score({ ...srs, lastReview: iso(NOW - 5 * DAY_MS) }, stats, NOW);
  const overdue = score({ ...srs, lastReview: iso(NOW - 10 * DAY_MS) }, stats, NOW);
  const wayOverdue = score({ ...srs, lastReview: iso(NOW - 40 * DAY_MS) }, stats, NOW);
  assert.ok(fresh > halfway, `${fresh} > ${halfway}`);
  assert.ok(halfway > overdue, `${halfway} > ${overdue}`);
  assert.ok(overdue > wayOverdue, `${overdue} > ${wayOverdue}`);
});

test('score() is lowered by a shaky recall history', () => {
  const srs = { ...newSrs(), state: 'review', interval: 10, reps: 5, lastReview: iso(NOW) };
  const perfect = score(srs, { history: [1, 1, 1, 1] }, NOW);
  const shaky = score(srs, { history: [1, 0, 1, 0] }, NOW);
  const empty = score(srs, { history: [] }, NOW); // no history defaults to acc = 1
  assert.ok(perfect > shaky, `${perfect} > ${shaky}`);
  assert.equal(perfect, empty);
});

test('score() does not mutate its inputs', () => {
  const srs = Object.freeze({ ...newSrs(), state: 'review', interval: 10, reps: 5, lastReview: iso(NOW) });
  const stats = Object.freeze({ history: Object.freeze([1, 1]) });
  assert.doesNotThrow(() => score(srs, stats, NOW));
});

// ------------------------------------------------------------------------ band()

test('band() boundaries', () => {
  assert.equal(band(0).key, 'new');
  assert.equal(band(24).key, 'new');
  assert.equal(band(25).key, 'seen');
  assert.equal(band(49).key, 'seen');
  assert.equal(band(50).key, 'familiar');
  assert.equal(band(74).key, 'familiar');
  assert.equal(band(75).key, 'mastered');
  assert.equal(band(100).key, 'mastered');
});

test('band() carries zh and label', () => {
  assert.deepEqual(band(0), { key: 'new', zh: '生', label: 'New', min: 0, max: 24 });
  assert.deepEqual(band(30), { key: 'seen', zh: '認', label: 'Seen', min: 25, max: 49 });
  assert.deepEqual(band(60), { key: 'familiar', zh: '熟', label: 'Familiar', min: 50, max: 74 });
  assert.deepEqual(band(90), { key: 'mastered', zh: '通', label: 'Mastered', min: 75, max: 100 });
});

// ------------------------------------------------------------------ buildQueue()

function word(id, fields) {
  return { id, hanzi: id, lessonId: null, createdAt: iso(NOW - DAY_MS), ...fields };
}

function makeWords() {
  return [
    word('review-overdue-5d', { lessonId: 'L1', srs: { ...reviewSrs(), due: iso(NOW - 5 * DAY_MS) } }),
    word('learning-overdue-1d', { lessonId: 'L1', srs: { ...newSrs(), state: 'learning', due: iso(NOW - 1 * DAY_MS) } }),
    word('learning-overdue-3d', { lessonId: 'L1', srs: { ...newSrs(), state: 'learning', due: iso(NOW - 3 * DAY_MS) } }),
    word('other-lesson-review-overdue-10d', { lessonId: 'L2', srs: { ...reviewSrs(), due: iso(NOW - 10 * DAY_MS) } }),
    word('new-oldest', { lessonId: 'L1', srs: newSrs(), createdAt: iso(NOW - 100 * DAY_MS) }),
    word('new-newer', { lessonId: 'L1', srs: newSrs(), createdAt: iso(NOW - 50 * DAY_MS) }),
    word('review-not-due', { lessonId: 'L1', srs: { ...reviewSrs(), due: iso(NOW + DAY_MS) } }),
    word('relearning-overdue-2d', { lessonId: 'L1', srs: { ...relearningSrs(), due: iso(NOW - 2 * DAY_MS) } }),
    word('no-srs-field', { lessonId: 'L1' }), // defensive: must be skipped, not throw
  ];
}

test('buildQueue() orders learning/relearning due (most overdue first), then review due, then new (oldest first)', () => {
  const words = makeWords();
  const { cards, counts } = buildQueue(words, { now: NOW, lessonId: 'L1' });
  assert.deepEqual(
    cards.map((w) => w.id),
    [
      'learning-overdue-3d',
      'relearning-overdue-2d',
      'learning-overdue-1d',
      'review-overdue-5d',
      'new-oldest',
      'new-newer',
    ]
  );
  assert.deepEqual(counts, { due: 4, learning: 3, new: 2, total: 6 });
});

test('buildQueue() lessonId filters by word.lessonId', () => {
  const words = makeWords();
  const { cards } = buildQueue(words, { now: NOW });
  // Without a lessonId filter, the other-lesson review card takes part too,
  // ordered by its own overdueness among review cards.
  assert.deepEqual(
    cards.map((w) => w.id),
    [
      'learning-overdue-3d',
      'relearning-overdue-2d',
      'learning-overdue-1d',
      'other-lesson-review-overdue-10d',
      'review-overdue-5d',
      'new-oldest',
      'new-newer',
    ]
  );
});

test('buildQueue() limitNew caps how many new cards are pulled in', () => {
  const words = makeWords();
  const { cards, counts } = buildQueue(words, { now: NOW, lessonId: 'L1', limitNew: 1 });
  assert.deepEqual(cards.map((w) => w.id).slice(-1), ['new-oldest']);
  assert.equal(counts.new, 1);
});

test('buildQueue() limitTotal cuts the combined queue', () => {
  const words = makeWords();
  const { cards, counts } = buildQueue(words, { now: NOW, lessonId: 'L1', limitTotal: 2 });
  assert.deepEqual(cards.map((w) => w.id), ['learning-overdue-3d', 'relearning-overdue-2d']);
  assert.equal(counts.total, 2);
  // The due/learning counts still reflect the true totals, not the truncated slice.
  assert.equal(counts.due, 4);
  assert.equal(counts.learning, 3);
});

test('buildQueue() includeNew:false excludes new cards entirely', () => {
  const words = makeWords();
  const { cards, counts } = buildQueue(words, { now: NOW, lessonId: 'L1', includeNew: false });
  assert.ok(!cards.some((w) => w.srs.state === 'new'));
  assert.equal(counts.new, 0);
});

test('buildQueue() never includes a not-yet-due review card', () => {
  const words = makeWords();
  const { cards } = buildQueue(words, { now: NOW, lessonId: 'L1' });
  assert.ok(!cards.some((w) => w.id === 'review-not-due'));
});

// -------------------------------------------------------------- formatInterval()

test('formatInterval() minutes', () => {
  assert.equal(formatInterval(MIN_MS), '1m');
  assert.equal(formatInterval(10 * MIN_MS), '10m');
});

test('formatInterval() days', () => {
  assert.equal(formatInterval(DAY_MS), '1d');
  assert.equal(formatInterval(3 * DAY_MS), '3d');
  assert.equal(formatInterval(4 * DAY_MS), '4d');
  assert.equal(formatInterval(6 * DAY_MS), '6d');
});

test('formatInterval() weeks', () => {
  assert.equal(formatInterval(14 * DAY_MS), '2w');
});

test('formatInterval() months', () => {
  assert.equal(formatInterval(30 * DAY_MS), '1mo');
  assert.equal(formatInterval(90 * DAY_MS), '3mo');
});

test('formatInterval() year (matches the 365-day cap)', () => {
  assert.equal(formatInterval(365 * DAY_MS), '1y');
});

// -------------------------------------------------------------- recordOutcome()

test('recordOutcome() starting from empty stats', () => {
  const stats = { reviews: 0, correct: 0, streak: 0, history: [] };
  const s1 = recordOutcome(stats, true);
  assert.deepEqual(s1, { reviews: 1, correct: 1, streak: 1, history: [1] });
});

test('recordOutcome() a miss resets the streak but keeps history/reviews', () => {
  const stats = { reviews: 3, correct: 3, streak: 3, history: [1, 1, 1] };
  const s = recordOutcome(stats, false);
  assert.deepEqual(s, { reviews: 4, correct: 3, streak: 0, history: [1, 1, 1, 0] });
});

test('recordOutcome() history is capped at the last 20 outcomes', () => {
  const history = new Array(20).fill(1);
  const stats = { reviews: 20, correct: 20, streak: 20, history };
  const s = recordOutcome(stats, true);
  assert.equal(s.history.length, 20);
  assert.equal(s.reviews, 21);
  assert.equal(s.correct, 21);
  assert.equal(s.streak, 21);

  const s2 = recordOutcome(stats, false);
  assert.equal(s2.history.length, 20);
  assert.deepEqual(s2.history, [...new Array(19).fill(1), 0]);
  assert.equal(s2.streak, 0);
});

test('recordOutcome() does not mutate its input', () => {
  const stats = Object.freeze({ reviews: 1, correct: 1, streak: 1, history: Object.freeze([1]) });
  assert.doesNotThrow(() => recordOutcome(stats, true));
  assert.equal(stats.history.length, 1);
});
