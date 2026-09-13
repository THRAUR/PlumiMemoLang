/* The local challenge builder: turns the dictionary into the Question shapes of
   §5 with no network involved. Every builder returns null when the words it was
   given cannot support that question (no meaning, no example short enough, not
   enough distractors) — the caller then tries another type instead of shipping a
   broken question. The RNG is seedable so a test can assert exact output. */
import { hanziChars } from '../../shared/zhuyin.js';

export const QUESTION_TYPES = ['mc-meaning', 'mc-hanzi', 'listen', 'type-pinyin', 'match', 'order', 'cloze'];
export const DEFAULT_TYPES = [...QUESTION_TYPES];
export const OPTION_IDS = ['a', 'b', 'c', 'd', 'e', 'f'];
const OPTIONS_PER_QUESTION = 4;
const MATCH_MIN = 4;
const MATCH_MAX = 5;
const ORDER_MAX_CHARS = 12;
const ORDER_MIN_CHARS = 3;
export const BLANK = '▢';

function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }
function norm(v) { return str(v).toLowerCase(); }
function reviewed(w) { return (w?.stats?.reviews || 0) > 0; }

/* mulberry32 over a string hash: same seed, same challenge, on any machine. */
export function makeRng(seed) {
  if (seed === undefined || seed === null || seed === '') return Math.random;
  let h = 2166136261 >>> 0;
  for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled(arr, rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* What to print under the hanzi. The learner's script preference decides, and
   we fall back to whichever reading exists so an option is never blank. */
export function readingOf(word, script = 'zhuyin') {
  const zhuyin = str(word?.zhuyin);
  const pinyin = str(word?.pinyin);
  return script === 'pinyin' ? pinyin || zhuyin : zhuyin || pinyin;
}

/* Distractors: other words, same part of speech first, never the same hanzi and
   never the same meaning (two options that read alike have no right answer).
   `show` is the field the option displays, so two distractors never look equal. */
function pickDistractors(word, all, rng, { n = 3, show = 'meaning', sameLength = false } = {}) {
  const answerHanzi = str(word.hanzi);
  const answerMeaning = norm(word.meaning);
  const answerLen = hanziChars(answerHanzi).length;
  const usable = all.filter((w) => w.id !== word.id
    && str(w.hanzi) !== answerHanzi
    && str(w.hanzi)
    && norm(w.meaning) !== answerMeaning
    && (show !== 'meaning' || str(w.meaning)));
  const samePos = (w) => Boolean(word.pos) && w.pos === word.pos;
  const lengthOk = (w) => !sameLength || hanziChars(str(w.hanzi)).length === answerLen;
  const tiers = [
    usable.filter((w) => lengthOk(w) && samePos(w)),
    usable.filter((w) => lengthOk(w) && !samePos(w)),
    sameLength ? usable.filter((w) => !lengthOk(w) && samePos(w)) : [],
    sameLength ? usable.filter((w) => !lengthOk(w) && !samePos(w)) : [],
  ];
  const seen = new Set([show === 'meaning' ? answerMeaning : norm(answerHanzi)]);
  const out = [];
  for (const tier of tiers) {
    for (const w of shuffled(tier, rng)) {
      const key = show === 'meaning' ? norm(w.meaning) : norm(w.hanzi);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(w);
      if (out.length === n) return out;
    }
  }
  return out.length === n ? out : null;
}

/* Shuffles the answer in with the distractors and hands back the winning id. */
function options(rng, answer, others) {
  const laid = shuffled([{ ...answer, correct: true }, ...others], rng)
    .map((o, i) => ({ ...o, id: OPTION_IDS[i] }));
  const answerId = laid.find((o) => o.correct).id;
  return { list: laid.map(({ correct, ...rest }) => rest), answerId };   // eslint-disable-line no-unused-vars
}

function exampleWith(word, test) {
  for (const ex of word.examples || []) {
    if (ex && str(ex.zh) && test(ex)) return ex;
  }
  return null;
}

function qMcMeaning(word, all, rng, ctx) {
  if (!str(word.meaning) || !str(word.hanzi)) return null;
  const ds = pickDistractors(word, all, rng, { n: OPTIONS_PER_QUESTION - 1, show: 'meaning' });
  if (!ds) return null;
  const { list, answerId } = options(rng, { text: str(word.meaning) }, ds.map((d) => ({ text: str(d.meaning) })));
  return { type: 'mc-meaning', wordId: word.id, prompt: { hanzi: str(word.hanzi), reading: readingOf(word, ctx.script) }, options: list, answerId };
}

function qMcHanzi(word, all, rng, ctx) {
  if (!str(word.meaning) || !str(word.hanzi)) return null;
  const ds = pickDistractors(word, all, rng, { n: OPTIONS_PER_QUESTION - 1, show: 'hanzi' });
  if (!ds) return null;
  const { list, answerId } = options(
    rng,
    { hanzi: str(word.hanzi), reading: readingOf(word, ctx.script) },
    ds.map((d) => ({ hanzi: str(d.hanzi), reading: readingOf(d, ctx.script) })),
  );
  return { type: 'mc-hanzi', wordId: word.id, prompt: { meaning: str(word.meaning) }, options: list, answerId };
}

function qListen(word, all, rng, ctx) {
  if (!str(word.hanzi)) return null;
  const ds = pickDistractors(word, all, rng, { n: OPTIONS_PER_QUESTION - 1, show: 'hanzi' });
  if (!ds) return null;
  const { list, answerId } = options(
    rng,
    { hanzi: str(word.hanzi), reading: readingOf(word, ctx.script) },
    ds.map((d) => ({ hanzi: str(d.hanzi), reading: readingOf(d, ctx.script) })),
  );
  return { type: 'listen', wordId: word.id, prompt: { tts: str(word.hanzi) }, options: list, answerId };
}

function qTypePinyin(word, all, rng, ctx) {     // eslint-disable-line no-unused-vars
  const pinyin = str(word.pinyin);
  const zhuyin = str(word.zhuyin);
  if (!str(word.hanzi) || (!pinyin && !zhuyin)) return null;
  return { type: 'type-pinyin', wordId: word.id, prompt: { hanzi: str(word.hanzi), meaning: str(word.meaning) }, answer: { pinyin, zhuyin } };
}

function qOrder(word, all, rng, ctx) {          // eslint-disable-line no-unused-vars
  const ex = exampleWith(word, (e) => {
    const n = hanziChars(e.zh).length;
    return n >= ORDER_MIN_CHARS && n <= ORDER_MAX_CHARS;
  });
  if (!ex) return null;
  const chars = hanziChars(ex.zh);
  const answerTiles = chars.map((text, i) => ({ id: `t${i + 1}`, text }));
  let tiles = shuffled(answerTiles, rng);
  // A "reorder" question already in the right order is not a question.
  for (let i = 0; i < 6 && tiles.every((t, idx) => t.id === answerTiles[idx].id); i += 1) tiles = shuffled(answerTiles, rng);
  return {
    type: 'order',
    wordId: word.id,
    prompt: { translation: str(ex.translation) || str(word.meaning) },
    tiles,
    answer: answerTiles.map((t) => t.id),
  };
}

function qCloze(word, all, rng, ctx) {          // eslint-disable-line no-unused-vars
  const hanzi = str(word.hanzi);
  if (!hanzi) return null;
  const ex = exampleWith(word, (e) => str(e.zh).includes(hanzi));
  if (!ex) return null;
  const ds = pickDistractors(word, all, rng, { n: OPTIONS_PER_QUESTION - 1, show: 'hanzi', sameLength: true });
  if (!ds) return null;
  const sentence = str(ex.zh).replace(hanzi, BLANK.repeat(Math.max(1, hanziChars(hanzi).length)));
  const { list, answerId } = options(rng, { hanzi }, ds.map((d) => ({ hanzi: str(d.hanzi) })));
  return {
    type: 'cloze',
    wordId: word.id,
    prompt: { sentence, translation: str(ex.translation) },
    options: list,
    answerId,
  };
}

/* match eats 4–5 words at once, so it takes the pool rather than one word. */
function qMatch(pool, rng, used) {
  const seenHanzi = new Set();
  const seenMeaning = new Set();
  const picked = [];
  for (const w of pool) {
    if (used.has(`match:${w.id}`)) continue;
    const hanzi = str(w.hanzi);
    const meaning = str(w.meaning);
    if (!hanzi || !meaning) continue;
    if (seenHanzi.has(norm(hanzi)) || seenMeaning.has(norm(meaning))) continue;
    seenHanzi.add(norm(hanzi));
    seenMeaning.add(norm(meaning));
    picked.push(w);
    if (picked.length === MATCH_MAX) break;
  }
  if (picked.length < MATCH_MIN) return null;
  for (const w of picked) used.add(`match:${w.id}`);
  return {
    type: 'match',
    pairs: shuffled(picked, rng).map((w, i) => ({ id: `p${i + 1}`, hanzi: str(w.hanzi), meaning: str(w.meaning), wordId: w.id })),
  };
}

const BUILDERS = {
  'mc-meaning': qMcMeaning,
  'mc-hanzi': qMcHanzi,
  listen: qListen,
  'type-pinyin': qTypePinyin,
  order: qOrder,
  cloze: qCloze,
};

/* How many answers a client can legitimately send back — POST /challenge/finish
   uses it so a replayed or padded answer list cannot mint XP. */
export function countAnswers(questions = []) {
  return questions.reduce((n, q) => n + (
    q?.type === 'match' ? (q.pairs?.length || 1)
      : q?.type === 'reading' ? (q.questions?.length || 1)
        : 1), 0);
}

/*  words   the whole collection (distractors come from all of it)
    size    how many questions to aim for
    lessonId  restrict the asked words to one lesson
    types   subset of QUESTION_TYPES
    script  'zhuyin' | 'pinyin' | 'both' (what readings to print)
    seed    any string for a deterministic build                             */
export function buildQuestions(words, { size = 10, lessonId = null, types = null, script = 'zhuyin', seed = null } = {}) {
  const all = (words || []).filter((w) => w && w.id && str(w.hanzi));
  const pool = lessonId ? all.filter((w) => w.lessonId === lessonId) : all;
  if (pool.length < 4) throw Object.assign(new Error('Add at least 4 words first.'), { status: 400 });

  const rng = makeRng(seed);
  const wanted = Math.max(1, Math.min(40, Math.round(Number(size) || 10)));
  const asked = (Array.isArray(types) ? types.filter((t) => QUESTION_TYPES.includes(t)) : []);
  const typeList = asked.length ? asked : DEFAULT_TYPES;
  // Words worth testing first (reps > 0), then the rest to top the session up.
  const ordered = [...shuffled(pool.filter(reviewed), rng), ...shuffled(pool.filter((w) => !reviewed(w)), rng)];
  const ctx = { script };
  const used = new Set();
  const questions = [];
  let wi = 0;
  let ti = 0;
  const guard = wanted * typeList.length * 2 + typeList.length;

  for (let step = 0; questions.length < wanted && step < guard; step += 1) {
    const type = typeList[ti % typeList.length];
    ti += 1;
    if (type === 'match') {
      const q = qMatch(ordered, rng, used);
      if (q) questions.push(q);
      continue;
    }
    const build = BUILDERS[type];
    if (!build) continue;
    for (let k = 0; k < ordered.length; k += 1) {
      const word = ordered[(wi + k) % ordered.length];
      if (used.has(`${type}:${word.id}`)) continue;
      const q = build(word, all, rng, ctx);
      if (!q) continue;
      used.add(`${type}:${word.id}`);
      wi = (wi + k + 1) % ordered.length;
      questions.push(q);
      break;
    }
  }

  return questions.map((q, i) => ({ id: `q${i + 1}`, ...q }));
}
