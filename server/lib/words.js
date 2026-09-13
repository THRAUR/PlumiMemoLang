/* Everything the routes need to do to a word that is not "read it from the
   store": the computed score/band decoration, one dedupe-by-hanzi insert shared
   by POST /words, the notes import and accepted suggestions (three doors into
   the same dictionary must agree), the list filters, and the CSV export. */
import { coll } from '../store.js';
import * as srs from '../srs.js';
import { normalizePinyin, pinyinToZhuyin } from '../../shared/zhuyin.js';

export const POS = ['n', 'v', 'adj', 'adv', 'mw', 'conj', 'prep', 'part', 'interj', 'pron', 'num', 'expr', ''];
export const TYPES = ['character', 'word', 'phrase', 'sentence', 'grammar'];
export const SORTS = ['score', 'recent', 'alpha', 'due'];
/* Fields a client may write. srs/stats/id/createdAt are the server's business. */
export const WRITABLE = ['hanzi', 'pinyin', 'zhuyin', 'meaning', 'meaningNative', 'pos', 'type', 'examples', 'notes', 'tags', 'lessonId', 'noteId'];
const TEXT = ['hanzi', 'pinyin', 'zhuyin', 'meaning', 'meaningNative', 'pos', 'type', 'notes'];
/* Merging fills only what is blank, so the learner's own edit always wins. */
const FILLABLE = ['pinyin', 'zhuyin', 'meaning', 'meaningNative', 'pos', 'type', 'notes'];

function bad(msg, status = 400) { return Object.assign(new Error(msg), { status }); }
function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }
function uniq(list) { return [...new Set(list)]; }

export function newStats() { return { reviews: 0, correct: 0, streak: 0, history: [] }; }

export function blankWord() {
  return {
    hanzi: '', pinyin: '', zhuyin: '', meaning: '', meaningNative: '', pos: '', type: 'word',
    examples: [], notes: '', tags: [], lessonId: null, noteId: null,
  };
}

/* score/band are computed on every read and never stored: the score decays with
   time, so a stored copy is wrong the moment it is written. */
export function decorate(word) {
  if (!word) return null;
  const score = srs.score(word.srs, word.stats);
  return { ...word, score, band: srs.band(score) };
}
export function decorateAll(list) { return (list || []).map(decorate); }

/* shared/zhuyin.js is allowed to give up (and its stub returns ''): treat any
   failure as "no zhuyin" rather than poisoning the word. */
export function zhuyinFor(pinyin) {
  const p = str(pinyin);
  if (!p) return '';
  try { return str(pinyinToZhuyin(p)); } catch { return ''; }
}

function cleanExamples(v) {
  if (!Array.isArray(v)) return undefined;
  return v
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({ zh: str(e.zh), pinyin: str(e.pinyin), zhuyin: str(e.zhuyin), translation: str(e.translation) }))
    .filter((e) => e.zh)
    .slice(0, 8);
}

function cleanTags(v) {
  if (!Array.isArray(v)) return undefined;
  return uniq(v.map((t) => str(t)).filter(Boolean)).slice(0, 24);
}

/* strict = a human typed this (a bad pos is a 400); loose = a model produced it
   (a bad pos is dropped, the rest of the import still lands). */
export function cleanWordInput(input = {}, { strict = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Send a word object.');
  const out = {};
  for (const f of TEXT) if (input[f] !== undefined) out[f] = str(input[f]);
  if (out.pos !== undefined && !POS.includes(out.pos)) {
    if (strict) throw bad(`"${out.pos}" is not a part of speech (${POS.filter(Boolean).join(', ')}).`);
    delete out.pos;
  }
  if (out.type !== undefined && !TYPES.includes(out.type)) {
    if (strict) throw bad(`"${out.type}" is not a word type (${TYPES.join(', ')}).`);
    delete out.type;
  }
  const examples = cleanExamples(input.examples);
  if (examples) out.examples = examples;
  else if (strict && input.examples !== undefined && !Array.isArray(input.examples)) throw bad('examples must be an array.');
  const tags = cleanTags(input.tags);
  if (tags) out.tags = tags;
  else if (strict && input.tags !== undefined && !Array.isArray(input.tags)) throw bad('tags must be an array of strings.');
  for (const f of ['lessonId', 'noteId']) {
    if (input[f] === undefined) continue;
    out[f] = input[f] === null || input[f] === '' ? null : str(input[f]);
  }
  return out;
}

/* The one way a word enters the dictionary. Returns the decorated word and
   whether it merged into an existing entry (the hanzi is the unique key). */
export function upsertWord(input, { lessonId = null, noteId = null, extraTags = [], strict = false } = {}) {
  const words = coll('words');
  const draft = cleanWordInput(input, { strict });
  const hanzi = str(draft.hanzi);
  if (!hanzi) throw bad('A word needs its hanzi.');
  const tags = uniq([...(draft.tags || []), ...extraTags.map((t) => str(t)).filter(Boolean)]);

  const existing = words.find((w) => str(w.hanzi) === hanzi);
  if (existing) {
    const patch = {};
    for (const f of FILLABLE) if (!str(existing[f]) && str(draft[f])) patch[f] = str(draft[f]);
    const fresh = tags.filter((t) => !(existing.tags || []).includes(t));
    if (fresh.length) patch.tags = [...(existing.tags || []), ...fresh];
    if (!(existing.examples || []).length && (draft.examples || []).length) patch.examples = draft.examples;
    // A word already filed under a lesson keeps it: re-importing a note must not
    // move words between lessons behind the learner's back.
    if (lessonId && !existing.lessonId) patch.lessonId = lessonId;
    if (noteId && !existing.noteId) patch.noteId = noteId;
    const zhuyin = patch.zhuyin ?? existing.zhuyin;
    const pinyin = patch.pinyin ?? existing.pinyin;
    if (!str(zhuyin) && str(pinyin)) {
      const z = zhuyinFor(pinyin);
      if (z) patch.zhuyin = z;
    }
    const word = Object.keys(patch).length ? words.update(existing.id, patch) : existing;
    if (patch.lessonId) fileWordInLesson(word.id, patch.lessonId);
    return { word: decorate(word), merged: true, created: false };
  }

  const next = { ...blankWord(), ...draft, hanzi, tags };
  if (lessonId) next.lessonId = lessonId;
  if (noteId) next.noteId = noteId;
  if (!str(next.zhuyin) && str(next.pinyin)) next.zhuyin = zhuyinFor(next.pinyin);
  next.srs = srs.newSrs();
  next.stats = newStats();
  const inserted = words.insert(next);
  if (inserted.lessonId) fileWordInLesson(inserted.id, inserted.lessonId);
  return { word: decorate(inserted), merged: false, created: true };
}

/* Keep lesson.wordIds in step when the WORD side of the link changes (the
   lessons route already handles the lesson side). Adding a word "to this
   lesson" from the Words screen must show up on the lesson's vocabulary list. */
export function fileWordInLesson(wordId, lessonId, prevLessonId = null) {
  const lessons = coll('lessons');
  if (prevLessonId && prevLessonId !== lessonId) {
    const prev = lessons.get(prevLessonId);
    if (prev && (prev.wordIds || []).includes(wordId)) {
      lessons.update(prev.id, { wordIds: prev.wordIds.filter((id) => id !== wordId) });
    }
  }
  if (lessonId) {
    const lesson = lessons.get(lessonId);
    if (lesson && !(lesson.wordIds || []).includes(wordId)) {
      lessons.update(lesson.id, { wordIds: [...(lesson.wordIds || []), wordId] });
    }
  }
}

/* Fill blanks from an AI (enrich) or any other partial source. Never overwrites. */
export function fillEmpty(word, patchIn, { strict = false } = {}) {
  const draft = cleanWordInput(patchIn || {}, { strict });
  const patch = {};
  for (const f of FILLABLE) if (!str(word[f]) && str(draft[f])) patch[f] = str(draft[f]);
  if (!(word.examples || []).length && (draft.examples || []).length) patch.examples = draft.examples;
  const fresh = (draft.tags || []).filter((t) => !(word.tags || []).includes(t));
  if (fresh.length) patch.tags = [...(word.tags || []), ...fresh];
  const zhuyin = patch.zhuyin ?? word.zhuyin;
  const pinyin = patch.pinyin ?? word.pinyin;
  if (!str(zhuyin) && str(pinyin)) {
    const z = zhuyinFor(pinyin);
    if (z) patch.zhuyin = z;
  }
  return patch;
}

export function matchesQuery(word, q) {
  const needle = str(q).toLowerCase();
  if (!needle) return true;
  const hay = [word.hanzi, word.meaning, word.meaningNative, word.zhuyin, ...(word.tags || [])];
  if (hay.some((v) => str(v).toLowerCase().includes(needle))) return true;
  // Typing "xiexie" or "xie xie" must find 謝謝 whatever tones were typed.
  const np = normalizePinyin(needle, { tones: false });
  return Boolean(np) && normalizePinyin(word.pinyin || '', { tones: false }).includes(np);
}

export function filterWords(list, { q = '', lessonId = '', tag = '', type = '', band = '' } = {}) {
  const wantBand = str(band);
  const wantLesson = str(lessonId);
  const wantTag = str(tag);
  const wantType = str(type);
  return list.filter((w) => {
    if (!matchesQuery(w, q)) return false;
    if (wantLesson) {
      // lessonId=none lists the words that belong to no lesson yet.
      if (wantLesson === 'none' || wantLesson === 'null') { if (w.lessonId) return false; }
      else if (w.lessonId !== wantLesson) return false;
    }
    if (wantTag && !(w.tags || []).includes(wantTag)) return false;
    if (wantType && w.type !== wantType) return false;
    if (wantBand && srs.band(srs.score(w.srs, w.stats))?.key !== wantBand) return false;
    return true;
  });
}

/* Sorts a decorated list (score is already computed). */
export function sortWords(list, sort = 'score', dir = '') {
  const key = SORTS.includes(sort) ? sort : 'score';
  const defaultDir = key === 'alpha' || key === 'due' ? 'asc' : 'desc';
  const sign = (dir === 'asc' || dir === 'desc' ? dir : defaultDir) === 'asc' ? 1 : -1;
  const out = [...list];
  out.sort((a, b) => {
    if (key === 'alpha') return sign * String(a.hanzi || '').localeCompare(String(b.hanzi || ''), 'zh-Hant');
    if (key === 'recent') return sign * (Date.parse(a.updatedAt || a.createdAt || 0) - Date.parse(b.updatedAt || b.createdAt || 0));
    if (key === 'due') {
      // Cards with no due date (new ones) always sit at the end, whatever dir is.
      const da = a.srs?.due ? Date.parse(a.srs.due) : null;
      const db = b.srs?.due ? Date.parse(b.srs.due) : null;
      if (da === null && db === null) return 0;
      if (da === null) return 1;
      if (db === null) return -1;
      return sign * (da - db);
    }
    return sign * ((a.score || 0) - (b.score || 0));
  });
  return out;
}

export function allTags(list) {
  return uniq(list.flatMap((w) => w.tags || []).map((t) => str(t)).filter(Boolean)).sort((a, b) => a.localeCompare(b));
}

const CSV_HEADER = ['hanzi', 'pinyin', 'zhuyin', 'meaning', 'meaningNative', 'pos', 'type', 'tags', 'score', 'lesson', 'example'];

function csvCell(v) { return `"${String(v ?? '').replace(/"/g, '""')}"`; }

/* Quoted everywhere and prefixed with a BOM: without it Excel reads the UTF-8
   hanzi as mojibake, which is the one thing this file exists to show. */
export function toCsv(words, lessonTitles = new Map()) {
  const lines = [CSV_HEADER.map(csvCell).join(',')];
  for (const w of words) {
    lines.push([
      w.hanzi, w.pinyin, w.zhuyin, w.meaning, w.meaningNative, w.pos, w.type,
      (w.tags || []).join('; '), w.score ?? '',
      w.lessonId ? lessonTitles.get(w.lessonId) || '' : '',
      w.examples?.[0]?.zh || '',
    ].map(csvCell).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function lessonTitleMap() {
  return new Map(coll('lessons').all().map((l) => [l.id, l.title || '']));
}
