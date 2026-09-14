/* The local challenge builder: turns the dictionary into the Question shapes of
   §5 with no network involved. Every builder returns null when the words it was
   given cannot support that question (no meaning, no example short enough, not
   enough distractors) — the caller then tries another type instead of shipping a
   broken question. The RNG is seedable so a test can assert exact output.

   §8.4 adds the speaking types (listen-meaning, mc-pinyin, tones, order-pinyin,
   speak). They ask about the SOUND of a word (its meaning heard aloud, its reading,
   its tones, saying it), so a learner who never reads characters is tested on what
   they will actually say. */
import {
  hanziChars, splitSyllables, marksToNumbers, numbersToMarks, normalizePinyin, pinyinToZhuyin, zhuyinToPinyin,
} from '../../shared/zhuyin.js';
import { CHALLENGE_TYPES, recommendedChallengeTypes } from '../../shared/goals.js';

/* shared/goals.js owns the list, so a type the landing screen offers is always a
   type this file can build, and the other way round. */
export const QUESTION_TYPES = CHALLENGE_TYPES.map((t) => t.id);
export const DEFAULT_TYPES = [...QUESTION_TYPES];
export const FOCI = ['speaking', 'characters', 'balanced'];
export const OPTION_IDS = ['a', 'b', 'c', 'd', 'e', 'f'];
const OPTIONS_PER_QUESTION = 4;
const MATCH_MIN = 4;
const MATCH_MAX = 5;
const ORDER_MAX_CHARS = 12;
const ORDER_MIN_CHARS = 3;
const ORDER_MAX_SYLLABLES = 12;
const ORDER_MIN_SYLLABLES = 3;
export const BLANK = '▢';

/* A run warms up the way a class does: recognise, then take apart, then produce.
   The type cycle follows this order (ties keep the CHALLENGE_TYPES order), so a
   speaking run opens on a word it shows and closes on a word the learner says. */
const RAMP = {
  'mc-meaning': 1,
  'listen-meaning': 2, 'mc-hanzi': 2, match: 2,
  'mc-pinyin': 3, listen: 3, cloze: 3,
  tones: 4, order: 4, 'order-pinyin': 4,
  'type-pinyin': 5, speak: 5,
};

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

/* ---------- readings and tones ---------- */

/* A reading in tone MARKS and composed characters, whatever was stored: "xie4 xie5"
   becomes "xiè xie" and a decomposed accent becomes one character, so every
   comparison and every variant below starts from one spelling. */
function marked(pinyin) {
  const s = str(pinyin).normalize('NFC');
  return /[0-5]/.test(s) ? numbersToMarks(s) : s;
}

/* Both readings of a word, each filled from the other when one is missing: the
   same question shows pinyin to one learner and 注音 to another. */
export function readingsOf(word) {
  const storedZhuyin = str(word?.zhuyin);
  const pinyin = marked(word?.pinyin) || (storedZhuyin ? zhuyinToPinyin(storedZhuyin) : '');
  const zhuyin = storedZhuyin || (pinyin ? pinyinToZhuyin(pinyin) : '');
  return { pinyin, zhuyin };
}

/* "lǜ xiè" → "lü xie": the letters without the four tone marks. The diaeresis on ü
   is part of the letter, not a tone, so it stays. */
export function bareReading(pinyin) {
  return marked(pinyin).normalize('NFD').replace(/[̀́̄̌]/g, '').normalize('NFC');
}

const PINYIN_RUN = /[a-zA-ZüÜêÊĀ-ǿÀ-ÿ]+/g;   // the letters shared/zhuyin.js reads as pinyin
const NUMBERED = /^([a-zü]+)([1-5])$/iu;
/* 不 and 一 change tone with the syllable after them (bù yào is said bú yào), so both
   marks can be right and neither may become a wrong answer. */
const SANDHI_CHARS = new Set(['不', '一']);
const SANDHI_SYLLABLES = new Set(['bu', 'yi']);

/* Where each syllable sits in the reading, so a variant can swap one of them and
   leave the spacing, the punctuation and a capital letter exactly as they were. */
function syllableSlots(reading) {
  const slots = [];
  for (const run of reading.matchAll(PINYIN_RUN)) {
    const pieces = splitSyllables(run[0]);
    if (pieces.join('') !== run[0]) {            // not pinyin after all ("Arthur"): one fixed slot
      slots.push({ start: run.index, end: run.index + run[0].length, letters: '', tone: 0 });
      continue;
    }
    let at = run.index;
    for (const piece of pieces) {
      const m = NUMBERED.exec(marksToNumbers(piece));
      slots.push({ start: at, end: at + piece.length, letters: m ? m[1] : '', tone: m ? Number(m[2]) : 0 });
      at += piece.length;
    }
  }
  return slots;
}

/* Every reading that differs from this one by the tone of exactly ONE syllable:
   "shè yǐng" → "shē yǐng", "shé yǐng", …, "shè yìng". Syllables whose tone is not a
   fixed fact of the word never vary: a neutral tone, 不 and 一, and a second or
   third tone right before a third tone (nǐ hǎo is SAID ní hǎo, so offering
   "ní hǎo" as the wrong answer would mark a good ear wrong). */
export function toneVariants(pinyin, { hanzi = '' } = {}) {
  const reading = marked(pinyin);
  const slots = syllableSlots(reading);
  const chars = hanziChars(hanzi);
  const aligned = chars.length > 0 && chars.length === slots.length;
  const seen = new Set([normalizePinyin(reading)]);
  const out = [];
  slots.forEach((slot, i) => {
    if (!slot.letters || slot.tone < 1 || slot.tone > 4) return;
    if (aligned ? SANDHI_CHARS.has(chars[i]) : SANDHI_SYLLABLES.has(slot.letters.toLowerCase())) return;
    const next = slots[i + 1];
    for (let tone = 1; tone <= 4; tone += 1) {
      if (tone === slot.tone) continue;
      if (next?.tone === 3 && ((slot.tone === 3 && tone === 2) || (slot.tone === 2 && tone === 3))) continue;
      const numbered = `${slot.letters}${tone}`;
      const piece = numbersToMarks(numbered);
      if (marksToNumbers(piece).toLowerCase() !== numbered.toLowerCase()) continue;
      const variant = reading.slice(0, slot.start) + piece + reading.slice(slot.end);
      const key = normalizePinyin(variant);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(variant);
    }
  });
  return out;
}

/* ---------- distractors ---------- */

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

/* Other words' readings as wrong answers to "how do you say <meaning>?". Readings
   with as many syllables as the answer come first, so length gives nothing away.
   `taken` holds the normalised readings already on screen (with tones), so two
   options never sound the same; it is updated in place. */
function pickReadingDistractors(word, all, rng, { n, taken }) {
  const answerMeaning = norm(word.meaning);
  const count = splitSyllables(readingsOf(word).pinyin).length;
  const usable = [];
  for (const w of all) {
    if (w.id === word.id || str(w.hanzi) === str(word.hanzi) || norm(w.meaning) === answerMeaning) continue;
    const r = readingsOf(w);
    if (r.pinyin) usable.push({ w, r, sameCount: splitSyllables(r.pinyin).length === count });
  }
  const samePos = (x) => Boolean(word.pos) && x.w.pos === word.pos;
  const tiers = [
    usable.filter((x) => x.sameCount && samePos(x)),
    usable.filter((x) => x.sameCount && !samePos(x)),
    usable.filter((x) => !x.sameCount && samePos(x)),
    usable.filter((x) => !x.sameCount && !samePos(x)),
  ];
  const out = [];
  for (const tier of tiers) {
    for (const x of shuffled(tier, rng)) {
      if (out.length === n) return out;
      const key = normalizePinyin(x.r.pinyin);
      if (!key || taken.has(key)) continue;
      taken.add(key);
      out.push({ pinyin: x.r.pinyin, zhuyin: x.r.zhuyin });
    }
  }
  return out;
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

/* ---------- builders ---------- */

function qMcMeaning(word, all, rng, ctx) {
  if (!str(word.meaning) || !str(word.hanzi)) return null;
  const ds = pickDistractors(word, all, rng, { n: OPTIONS_PER_QUESTION - 1, show: 'meaning' });
  if (!ds) return null;
  const { list, answerId } = options(rng, { text: str(word.meaning) }, ds.map((d) => ({ text: str(d.meaning) })));
  // pinyin and zhuyin ride along with `reading` so a speaking learner's prompt can
  // be the reading itself, in whichever script (or both) they read (§8.3).
  const { pinyin, zhuyin } = readingsOf(word);
  return { type: 'mc-meaning', wordId: word.id, prompt: { hanzi: str(word.hanzi), reading: readingOf(word, ctx.script), pinyin, zhuyin }, options: list, answerId };
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

/* Hear the word, pick what it means. The readings and the characters travel with
   the prompt for the feedback after the answer, not for the question. */
function qListenMeaning(word, all, rng, ctx) {   // eslint-disable-line no-unused-vars
  const hanzi = str(word.hanzi);
  const meaning = str(word.meaning);
  if (!hanzi || !meaning) return null;
  const ds = pickDistractors(word, all, rng, { n: OPTIONS_PER_QUESTION - 1, show: 'meaning' });
  if (!ds) return null;
  const { list, answerId } = options(rng, { text: meaning }, ds.map((d) => ({ text: str(d.meaning) })));
  const { pinyin, zhuyin } = readingsOf(word);
  return { type: 'listen-meaning', wordId: word.id, prompt: { tts: hanzi, pinyin, zhuyin, hanzi }, options: list, answerId };
}

/* Meaning → reading. One wrong answer is always the right word with one tone
   wrong, because that is the mistake a speaker actually makes; the others are
   readings of other words. A word with no tone to change is not asked. */
function qMcPinyin(word, all, rng, ctx) {        // eslint-disable-line no-unused-vars
  const meaning = str(word.meaning);
  const { pinyin, zhuyin } = readingsOf(word);
  if (!meaning || !pinyin) return null;
  const variants = shuffled(toneVariants(pinyin, { hanzi: word.hanzi }), rng);
  if (!variants.length) return null;
  const taken = new Set([normalizePinyin(pinyin), normalizePinyin(variants[0])]);
  const wrong = [{ pinyin: variants[0] }, ...pickReadingDistractors(word, all, rng, { n: OPTIONS_PER_QUESTION - 2, taken })];
  // A small or very homophonous dictionary tops up with more tone variants.
  for (const v of variants.slice(1)) {
    if (wrong.length >= OPTIONS_PER_QUESTION - 1) break;
    const key = normalizePinyin(v);
    if (taken.has(key)) continue;
    taken.add(key);
    wrong.push({ pinyin: v });
  }
  if (wrong.length < OPTIONS_PER_QUESTION - 1) return null;
  const { list, answerId } = options(
    rng,
    { pinyin, zhuyin },
    wrong.map((o) => ({ pinyin: o.pinyin, zhuyin: o.zhuyin || pinyinToZhuyin(o.pinyin) })),
  );
  return { type: 'mc-pinyin', wordId: word.id, prompt: { meaning, hanzi: str(word.hanzi) }, options: list, answerId };
}

/* Hear the word and see its letters without marks; pick the marks. All four
   options spell the same letters, so only the ear (or the memory of the word)
   can tell them apart. Needs three distinct variants, or the word is skipped. */
function qTones(word, all, rng, ctx) {           // eslint-disable-line no-unused-vars
  const hanzi = str(word.hanzi);
  const { pinyin } = readingsOf(word);
  if (!hanzi || !pinyin) return null;
  const variants = toneVariants(pinyin, { hanzi });
  if (variants.length < OPTIONS_PER_QUESTION - 1) return null;
  const wrong = shuffled(variants, rng).slice(0, OPTIONS_PER_QUESTION - 1);
  const { list, answerId } = options(rng, { pinyin }, wrong.map((p) => ({ pinyin: p })));
  return { type: 'tones', wordId: word.id, prompt: { tts: hanzi, bare: bareReading(pinyin), meaning: str(word.meaning), hanzi }, options: list, answerId };
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
  // A "reorder" question already in the right order is not a question. Compared by
  // text: swapping the two 謝 of 謝謝 leaves the sentence exactly as it was.
  const inOrder = (list) => list.every((t, idx) => t.text === answerTiles[idx].text);
  for (let i = 0; i < 6 && inOrder(tiles); i += 1) tiles = shuffled(answerTiles, rng);
  return {
    type: 'order',
    wordId: word.id,
    prompt: { translation: str(ex.translation) || str(word.meaning) },
    tiles,
    answer: answerTiles.map((t) => t.id),
  };
}

/* Build an example sentence from its syllables. The English is the prompt, so an
   example without a translation cannot be asked; a digit in the pinyin ("wǒ 3 diǎn")
   is not a syllable and would silently vanish from the tiles, so it is skipped too.
   Tiles are lower case: a capital would give away the first tile. */
function qOrderPinyin(word, all, rng, ctx) {    // eslint-disable-line no-unused-vars
  const ex = exampleWith(word, (e) => {
    const reading = marked(e.pinyin);
    if (!str(e.translation) || !reading || /\d/.test(reading)) return false;
    const n = splitSyllables(reading).length;
    return n >= ORDER_MIN_SYLLABLES && n <= ORDER_MAX_SYLLABLES;
  });
  if (!ex) return null;
  const reading = marked(ex.pinyin);
  const answerTiles = splitSyllables(reading).map((text, i) => ({ id: `t${i + 1}`, text: text.toLowerCase() }));
  const inOrder = (list) => list.every((t, idx) => t.text === answerTiles[idx].text);
  let tiles = shuffled(answerTiles, rng);
  for (let i = 0; i < 6 && inOrder(tiles); i += 1) tiles = shuffled(answerTiles, rng);
  if (inOrder(tiles)) return null;                 // "hā hā hā" has no wrong order
  return {
    type: 'order-pinyin',
    wordId: word.id,
    prompt: { translation: str(ex.translation), tts: str(ex.zh) },
    tiles,
    answer: answerTiles.map((t) => t.id),
    full: { zh: str(ex.zh), pinyin: reading },
  };
}

/* Say it: the meaning is the whole prompt. The example's English comes along as
   context, because a bare meaning ("to ride", "matter") often fits several words.
   The client records, may run recognition, and the learner judges themselves. */
function qSpeak(word, all, rng, ctx) {          // eslint-disable-line no-unused-vars
  const meaning = str(word.meaning);
  const hanzi = str(word.hanzi);
  const { pinyin, zhuyin } = readingsOf(word);
  if (!meaning || !hanzi || (!pinyin && !zhuyin)) return null;
  const ex = exampleWith(word, (e) => str(e.translation) && str(e.zh).includes(hanzi)) || exampleWith(word, (e) => str(e.translation));
  const context = ex && norm(ex.translation) !== norm(meaning) ? str(ex.translation) : '';
  return { type: 'speak', wordId: word.id, prompt: { meaning, context }, answer: { pinyin, zhuyin, hanzi, tts: hanzi } };
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
  const seenReading = new Set();
  const picked = [];
  for (const w of pool) {
    if (used.has(`match:${w.id}`)) continue;
    const hanzi = str(w.hanzi);
    const meaning = str(w.meaning);
    if (!hanzi || !meaning) continue;
    // A speaking learner matches READINGS with meanings, so two words that sound
    // alike (是 and 事 are both shì) can never share a board.
    const { pinyin, zhuyin } = readingsOf(w);
    const sound = pinyin ? normalizePinyin(pinyin) : zhuyin.replace(/\s+/g, '');
    if (seenHanzi.has(norm(hanzi)) || seenMeaning.has(norm(meaning)) || (sound && seenReading.has(sound))) continue;
    seenHanzi.add(norm(hanzi));
    seenMeaning.add(norm(meaning));
    if (sound) seenReading.add(sound);
    picked.push({ w, pinyin, zhuyin });
    if (picked.length === MATCH_MAX) break;
  }
  if (picked.length < MATCH_MIN) return null;
  for (const { w } of picked) used.add(`match:${w.id}`);
  return {
    type: 'match',
    pairs: shuffled(picked, rng).map(({ w, pinyin, zhuyin }, i) => ({ id: `p${i + 1}`, hanzi: str(w.hanzi), meaning: str(w.meaning), wordId: w.id, pinyin, zhuyin })),
  };
}

const BUILDERS = {
  'mc-meaning': qMcMeaning,
  'mc-hanzi': qMcHanzi,
  listen: qListen,
  'type-pinyin': qTypePinyin,
  order: qOrder,
  cloze: qCloze,
  'listen-meaning': qListenMeaning,
  'mc-pinyin': qMcPinyin,
  tones: qTones,
  'order-pinyin': qOrderPinyin,
  speak: qSpeak,
};

/* How many answers a client can legitimately send back — POST /challenge/finish
   uses it so a replayed or padded answer list cannot mint XP. */
export function countAnswers(questions = []) {
  return questions.reduce((n, q) => n + (
    q?.type === 'match' ? (q.pairs?.length || 1)
      : q?.type === 'reading' ? (q.questions?.length || 1)
        : 1), 0);
}

/* The types a run cycles through. With more types than questions, a seeded draw
   picks which ones make it, or the last types of the ramp (type-pinyin, speak)
   would never appear in a short run. */
function typeCycle(types, wanted, rng) {
  const unique = [...new Set(types)];
  const chosen = unique.length > wanted ? shuffled(unique, rng).slice(0, wanted) : unique;
  return chosen.sort((a, b) => (RAMP[a] ?? 9) - (RAMP[b] ?? 9) || QUESTION_TYPES.indexOf(a) - QUESTION_TYPES.indexOf(b));
}

/*  words   the whole collection (distractors come from all of it)
    size    how many questions to aim for
    lessonId  restrict the asked words to one lesson
    types   subset of QUESTION_TYPES
    focus   'speaking' | 'characters' | 'balanced': picks the types when `types` is empty
    script  'zhuyin' | 'pinyin' | 'both' (what readings to print)
    seed    any string for a deterministic build                             */
export function buildQuestions(words, { size = 10, lessonId = null, types = null, focus = null, script = 'zhuyin', seed = null } = {}) {
  const all = (words || []).filter((w) => w && w.id && str(w.hanzi));
  const pool = lessonId ? all.filter((w) => w.lessonId === lessonId) : all;
  if (pool.length < 4) throw Object.assign(new Error('Add at least 4 words first.'), { status: 400 });

  const rng = makeRng(seed);
  const wanted = Math.max(1, Math.min(40, Math.round(Number(size) || 10)));
  const asked = (Array.isArray(types) ? types.filter((t) => QUESTION_TYPES.includes(t)) : []);
  // No list: the learner's focus decides (§8.4). No focus either: every type.
  const fallback = FOCI.includes(focus) ? recommendedChallengeTypes(focus) : DEFAULT_TYPES;
  // Words worth testing first (reps > 0), then the rest to top the session up.
  const ordered = [...shuffled(pool.filter(reviewed), rng), ...shuffled(pool.filter((w) => !reviewed(w)), rng)];
  const typeList = typeCycle(asked.length ? asked : fallback, wanted, rng);
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
