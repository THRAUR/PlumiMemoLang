/* pinyin ↔ 注音 (zhuyin / bopomofo) utilities, shared by the server and the
   browser. Pure ES module: no Node imports, no globals.

   Conventions (Taiwan 教育部 style):
     - zhuyin syllables are separated by one space; tone 1 is unmarked,
       ˊ ˇ ˋ follow the syllable, the neutral tone ˙ goes BEFORE it:
       謝謝 → "ㄒㄧㄝˋ ˙ㄒㄧㄝ".
     - pinyin uses tone marks ("xiè xie"); digits ("xie4 xie5") and the
       v / u: spellings of ü are accepted on input everywhere.
   Everything here works on toneless "bases" internally and puts the tone back
   at the end, so every rule about spelling lives in exactly one table. */

export const ZHUYIN_TONES = { 1: '', 2: 'ˊ', 3: 'ˇ', 4: 'ˋ', 5: '˙' };

/* ── tables ─────────────────────────────────────────────────────────────── */

const INITIALS = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h', 'j', 'q', 'x', 'r', 'z', 'c', 's'];
const ZH_INITIAL = { b: 'ㄅ', p: 'ㄆ', m: 'ㄇ', f: 'ㄈ', d: 'ㄉ', t: 'ㄊ', n: 'ㄋ', l: 'ㄌ', g: 'ㄍ', k: 'ㄎ', h: 'ㄏ', j: 'ㄐ', q: 'ㄑ', x: 'ㄒ', zh: 'ㄓ', ch: 'ㄔ', sh: 'ㄕ', r: 'ㄖ', z: 'ㄗ', c: 'ㄘ', s: 'ㄙ' };
const PY_INITIAL = Object.fromEntries(Object.entries(ZH_INITIAL).map(([k, v]) => [v, k]));
const SIBILANT = new Set(['zh', 'ch', 'sh', 'r', 'z', 'c', 's']);   // take the "empty rime": zhi chi shi ri zi ci si
const PALATAL = new Set(['j', 'q', 'x']);                          // their u is really ü

/* finals as spelled AFTER an initial → zhuyin */
const FINALS = {
  a: 'ㄚ', o: 'ㄛ', e: 'ㄜ', ê: 'ㄝ', ai: 'ㄞ', ei: 'ㄟ', ao: 'ㄠ', ou: 'ㄡ', an: 'ㄢ', en: 'ㄣ', ang: 'ㄤ', eng: 'ㄥ', er: 'ㄦ',
  i: 'ㄧ', ia: 'ㄧㄚ', io: 'ㄧㄛ', ie: 'ㄧㄝ', iai: 'ㄧㄞ', iao: 'ㄧㄠ', iu: 'ㄧㄡ', ian: 'ㄧㄢ', in: 'ㄧㄣ', iang: 'ㄧㄤ', ing: 'ㄧㄥ', iong: 'ㄩㄥ',
  u: 'ㄨ', ua: 'ㄨㄚ', uo: 'ㄨㄛ', uai: 'ㄨㄞ', ui: 'ㄨㄟ', uan: 'ㄨㄢ', un: 'ㄨㄣ', uang: 'ㄨㄤ', ong: 'ㄨㄥ', ueng: 'ㄨㄥ',
  ü: 'ㄩ', üe: 'ㄩㄝ', üan: 'ㄩㄢ', ün: 'ㄩㄣ',
};
/* whole syllables with no initial → zhuyin */
const STANDALONE = {
  a: 'ㄚ', o: 'ㄛ', e: 'ㄜ', ê: 'ㄝ', ai: 'ㄞ', ei: 'ㄟ', ao: 'ㄠ', ou: 'ㄡ', an: 'ㄢ', en: 'ㄣ', ang: 'ㄤ', eng: 'ㄥ', er: 'ㄦ',
  yi: 'ㄧ', ya: 'ㄧㄚ', yo: 'ㄧㄛ', ye: 'ㄧㄝ', yai: 'ㄧㄞ', yao: 'ㄧㄠ', you: 'ㄧㄡ', yan: 'ㄧㄢ', yin: 'ㄧㄣ', yang: 'ㄧㄤ', ying: 'ㄧㄥ', yong: 'ㄩㄥ',
  wu: 'ㄨ', wa: 'ㄨㄚ', wo: 'ㄨㄛ', wai: 'ㄨㄞ', wei: 'ㄨㄟ', wan: 'ㄨㄢ', wen: 'ㄨㄣ', wang: 'ㄨㄤ', weng: 'ㄨㄥ',
  yu: 'ㄩ', yue: 'ㄩㄝ', yuan: 'ㄩㄢ', yun: 'ㄩㄣ',
};
/* the reverse direction: zhuyin rime → pinyin final, with and without an initial */
const RIME_TO_FINAL = Object.fromEntries(Object.entries(FINALS).filter(([k]) => k !== 'ueng' && k !== 'iai').map(([k, v]) => [v, k]));
const RIME_TO_STANDALONE = Object.fromEntries(Object.entries(STANDALONE).filter(([k]) => k !== 'yai').map(([k, v]) => [v, k]));

/* Every standard Mandarin syllable, toneless. The validity gate for splitting
   unspaced pinyin ("nǐhǎo") and for refusing to convert words that only look
   like pinyin ("Arthur"). */
const TABLE = {
  '': 'a o e ê ai ei ao ou an en ang eng er yi ya yo ye yai yao you yan yin yang ying yong wu wa wo wai wei wan wen wang weng yu yue yuan yun',
  b: 'a o ai ei ao an en ang eng i ie iao ian in ing u',
  p: 'a o ai ei ao ou an en ang eng i ie iao ian in ing u',
  m: 'a o e ai ei ao ou an en ang eng i ie iao iu ian in ing u',
  f: 'a o ei ou an en ang eng u',
  d: 'a e ai ei ao ou an en ang eng i ia ie iao iu ian ing ong u uo ui uan un',
  t: 'a e ai ei ao ou an ang eng i ie iao ian ing ong u uo ui uan un',
  n: 'a e ai ei ao ou an en ang eng i ie iao iu ian in iang ing ong u uo uan un ü üe',
  l: 'a o e ai ei ao ou an ang eng i ia ie iao iu ian in iang ing ong u uo uan un ü üe',
  g: 'a e ai ei ao ou an en ang eng ong u ua uo uai ui uan un uang',
  k: 'a e ai ei ao ou an en ang eng ong u ua uo uai ui uan un uang',
  h: 'a e ai ei ao ou an en ang eng ong u ua uo uai ui uan un uang',
  j: 'i ia ie iao iu ian in iang ing iong u ue uan un',
  q: 'i ia ie iao iu ian in iang ing iong u ue uan un',
  x: 'i ia ie iao iu ian in iang ing iong u ue uan un',
  zh: 'a e i ai ei ao ou an en ang eng ong u ua uo uai ui uan un uang',
  ch: 'a e i ai ao ou an en ang eng ong u ua uo uai ui uan un uang',
  sh: 'a e i ai ei ao ou an en ang eng u ua uo uai ui uan un uang',
  r: 'e i ao ou an en ang eng ong u ua uo ui uan un',
  z: 'a e i ai ei ao ou an en ang eng ong u uo ui uan un',
  c: 'a e i ai ao ou an en ang eng ong u uo ui uan un',
  s: 'a e i ai ao ou an en ang eng ong u uo ui uan un',
};
const SYLLABLES = new Set();
for (const [ini, finals] of Object.entries(TABLE)) for (const f of finals.split(' ')) SYLLABLES.add(ini + f);

/* tone marks */
const MARKS = { a: 'āáǎà', e: 'ēéěè', i: 'īíǐì', o: 'ōóǒò', u: 'ūúǔù', ü: 'ǖǘǚǜ' };
const MARKED = new Map();   // marked char → [base, tone]
for (const [base, row] of Object.entries(MARKS)) [...row].forEach((ch, i) => MARKED.set(ch, [base, i + 1]));
const TONE_SYMBOL = { 'ˊ': 2, 'ˇ': 3, 'ˋ': 4, '˙': 5, '´': 2, '`': 4, '˙': 5, '‧': 5, '·': 5 };
const BOPOMOFO = /[\u3105-\u312F\u31A0-\u31BF]/;
const IS_PINYIN_CHAR = /[a-zA-ZüÜêÊ\u0100-\u01FF\u00C0-\u00FF]/;
const VOWEL_START = /^[aoeêāáǎàōóǒòēéěè]/;

/* ── small helpers ───────────────────────────────────────────────────────── */

export function isHanzi(ch) {
  return typeof ch === 'string' && ch.length > 0 && /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]|[\uD840-\uD87F][\uDC00-\uDFFF]/.test(ch);
}
export function hanziChars(str) {
  return [...String(str || '')].filter(isHanzi);
}

/* "xiè" → { base: "xie", tone: 4 }; "xie4" → same; "xie" → tone 0 (no information).
   Returns null unless the piece is one well-formed syllable. */
function analyse(piece) {
  const s = String(piece || '');
  if (!s) return null;
  let tone = 0, marks = 0, base = '';
  for (let i = 0; i < s.length; i++) {
    const raw = s[i];
    const ch = raw.toLowerCase();
    if (/[0-5]/.test(ch)) {
      if (i !== s.length - 1 || i === 0) return null;      // a digit only at the very end
      tone = ch === '0' ? 5 : Number(ch);
      break;
    }
    const m = MARKED.get(ch);
    if (m) { marks++; if (marks > 1) return null; base += m[0]; tone = tone || m[1]; continue; }
    if (ch === 'v') { base += 'ü'; continue; }
    if (ch === ':' && base.endsWith('u')) { base = base.slice(0, -1) + 'ü'; continue; }
    if (!IS_PINYIN_CHAR.test(ch)) return null;
    base += ch;
  }
  if (!base) return null;
  // jü/qü/xü/yü are written ju/qu/xu/yu; the table stores the written form.
  let key = base;
  if (/^[jqxy]ü/.test(key)) key = key[0] + 'u' + key.slice(2);
  if (!SYLLABLES.has(key)) return null;
  return { base: key, tone };
}

/* Longest-match segmentation of one run of pinyin letters with backtracking.
   Pinyin orthography puts an apostrophe before a syllable that starts with
   a / o / e, so inside a run such a syllable is refused first ("fangan" →
   fan·gan, never fang·an) and only allowed when nothing else works
   ("shíèr" → shí·èr: the two marks leave no other reading). */
function segmentRun(run) {
  const n = run.length;
  const memo = new Map();
  const rec = (i, lenient) => {
    if (i === n) return [];
    const key = `${i}:${lenient}`;
    if (memo.has(key)) return memo.get(key);
    let result = null;
    for (let len = Math.min(7, n - i); len >= 1; len--) {
      const piece = run.slice(i, i + len);
      if (!analyse(piece)) continue;
      if (!lenient && i > 0 && VOWEL_START.test(piece.toLowerCase())) continue;
      const rest = rec(i + len, lenient);
      if (rest) { result = [piece, ...rest]; break; }
    }
    memo.set(key, result);
    return result;
  };
  return rec(0, false) || rec(0, true);
}

/* Split text into pinyin runs and everything else, preserving order.
   [{ text, pinyin: true|false }] — a run is letters plus a trailing digit;
   apostrophes and hyphens split runs but are dropped. */
function tokenize(text) {
  const out = [];
  const s = String(text || '');
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (IS_PINYIN_CHAR.test(ch)) {
      let j = i;
      while (j < s.length && (IS_PINYIN_CHAR.test(s[j]) || (/[0-5]/.test(s[j]) && j > i && (IS_PINYIN_CHAR.test(s[j - 1]) || s[j - 1] === ':')) || (s[j] === ':' && j > i && /u/i.test(s[j - 1])))) j++;
      out.push({ text: s.slice(i, j), pinyin: true });
      i = j;
    } else if (ch === "'" || ch === '’' || ch === '-') {
      out.push({ text: ch, pinyin: false, joiner: true });
      i++;
    } else {
      out.push({ text: ch, pinyin: false });
      i++;
    }
  }
  return out;
}

/* "nǐhǎo" → ["nǐ", "hǎo"]; "xi'an" → ["xi", "an"]; "xie4xie5" → ["xie4", "xie5"].
   Runs that are not pinyin at all ("Arthur") come back whole. */
export function splitSyllables(pinyin) {
  const out = [];
  for (const t of tokenize(pinyin)) {
    if (!t.pinyin) continue;
    const parts = segmentRun(t.text);
    if (parts) out.push(...parts); else out.push(t.text);
  }
  return out;
}

/* ── tone marks ⇄ numbers ───────────────────────────────────────────────── */

function placeMark(base, tone) {
  if (!tone || tone === 5) return base;
  let idx = -1;
  if (base.includes('a')) idx = base.indexOf('a');
  else if (base.includes('e')) idx = base.indexOf('e');
  else if (base.includes('ou')) idx = base.indexOf('o');
  else for (let i = base.length - 1; i >= 0; i--) if ('iouü'.includes(base[i])) { idx = i; break; }
  if (idx < 0) return base;
  return base.slice(0, idx) + MARKS[base[idx]][tone - 1] + base.slice(idx + 1);
}
function keepCase(original, converted) {
  return /^[A-ZÀ-Ý]/.test(original) ? converted[0].toUpperCase() + converted.slice(1) : converted;
}
/* The syllable's letters as typed, without a trailing digit, ü spelled ü. */
function lettersOf(piece) {
  return piece.replace(/[0-5]$/, '').replace(/u:/g, 'ü').replace(/v/g, 'ü').replace(/V/g, 'Ü');
}

/* "ni3 hao3" → "nǐ hǎo"; "lv4" → "lǜ"; "xie4xie5" → "xièxie". Spacing is kept. */
export function numbersToMarks(pinyin) {
  return tokenize(pinyin).map((t) => {
    if (!t.pinyin) return t.text;
    const parts = segmentRun(t.text);
    if (!parts) return t.text;
    return parts.map((p) => {
      const info = analyse(p);
      const letters = lettersOf(p);
      if (!info || !/[0-5]$/.test(p)) return letters;
      const unmarked = [...letters.toLowerCase()].map((ch) => (MARKED.get(ch) || [ch])[0]).join('');
      return keepCase(letters, placeMark(unmarked, info.tone));
    }).join('');
  }).join('');
}

/* "nǐ hǎo" → "ni3 hao3"; an unmarked syllable is neutral → 5. */
export function marksToNumbers(pinyin) {
  return tokenize(pinyin).map((t) => {
    if (!t.pinyin) return t.text;
    const parts = segmentRun(t.text);
    if (!parts) return t.text;
    return parts.map((p) => {
      const info = analyse(p);
      if (!info) return p;
      const letters = [...lettersOf(p)].map((ch) => { const m = MARKED.get(ch.toLowerCase()); return m ? (ch === ch.toLowerCase() ? m[0] : m[0].toUpperCase()) : ch; }).join('');
      return `${letters}${info.tone || 5}`;
    }).join('');
  }).join('');
}

/* Lowercase, marks → numbers, no spaces / apostrophes / hyphens, ü → v;
   tones:false also drops the digits. For comparisons, never for display. */
export function normalizePinyin(pinyin, { tones = true } = {}) {
  let s = marksToNumbers(String(pinyin || '')).toLowerCase().replace(/ü/g, 'v').replace(/u:/g, 'v');
  s = s.replace(/[\s'’\-.,;:!?，。！？、]/g, '');
  if (!tones) s = s.replace(/[0-5]/g, '');
  return s;
}

/* ── pinyin → zhuyin ────────────────────────────────────────────────────── */

function syllableToZhuyin(base, tone) {
  let initial = '';
  for (const ini of INITIALS) if (base.startsWith(ini)) { initial = ini; break; }
  let body;
  if (!initial) {
    body = STANDALONE[base];
    if (body === undefined) return null;
  } else {
    let fin = base.slice(initial.length);
    if (PALATAL.has(initial) && fin.startsWith('u')) fin = 'ü' + fin.slice(1);
    if (SIBILANT.has(initial) && fin === 'i') fin = '';
    const rime = fin === '' ? '' : FINALS[fin];
    if (rime === undefined) return null;
    body = ZH_INITIAL[initial] + rime;
  }
  if (tone === 5) return '˙' + body;
  return body + (ZHUYIN_TONES[tone] || '');
}

/* "xiè xie" | "xie4 xie5" | "xie4xie5" | "nǐhǎo" → "ㄒㄧㄝˋ ˙ㄒㄧㄝ" / "ㄋㄧˇ ㄏㄠˇ".
   When the input carries no tone information at all, syllables come back
   without tone symbols (rather than all tone 1). Text that is not pinyin
   passes through untouched. */
export function pinyinToZhuyin(pinyin) {
  const tokens = tokenize(pinyin);
  const runs = tokens.filter((t) => t.pinyin).map((t) => segmentRun(t.text) || []);
  const hasTones = runs.some((parts) => parts.some((p) => (analyse(p) || {}).tone));
  // An unmarked syllable is neutral when the text is tone-marked ("xiè xie")
  // or when it stands alone ("ma" = 嗎); a toneless multi-syllable string
  // ("nihao") simply has no tone information.
  const neutralWhenUnmarked = hasTones || runs.reduce((n, parts) => n + parts.length, 0) === 1;
  const out = [];
  let prevWasSyllable = false;
  for (const t of tokens) {
    if (t.joiner) continue;
    if (!t.pinyin) {
      if (/\s/.test(t.text)) { if (!out.length || /\s$/.test(out[out.length - 1])) continue; out.push(' '); prevWasSyllable = false; continue; }
      out.push(t.text); prevWasSyllable = false; continue;
    }
    const parts = segmentRun(t.text);
    if (!parts) { if (prevWasSyllable) out.push(' '); out.push(t.text); prevWasSyllable = true; continue; }
    for (const p of parts) {
      const info = analyse(p);
      const tone = info.tone || (neutralWhenUnmarked ? 5 : 0);
      const z = syllableToZhuyin(info.base, tone) ?? p;
      if (prevWasSyllable) out.push(' ');
      out.push(z);
      prevWasSyllable = true;
    }
  }
  return out.join('').trim();
}

/* ── zhuyin → pinyin ────────────────────────────────────────────────────── */

/* One bopomofo syllable = optional ˙, optional initial, optional medial,
   optional final, optional tone. Used both to split unspaced zhuyin and to
   convert it. */
function splitZhuyin(text) {
  const s = String(text || '');
  const syllables = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (!(BOPOMOFO.test(ch) || TONE_SYMBOL[ch] === 5)) { i++; continue; }
    let j = i, tone = 1, body = '';
    if (TONE_SYMBOL[s[j]] === 5) { tone = 5; j++; }
    if (j < s.length && PY_INITIAL[s[j]]) { body += s[j]; j++; }
    if (j < s.length && 'ㄧㄨㄩ'.includes(s[j])) { body += s[j]; j++; }
    if (j < s.length && 'ㄚㄛㄜㄝㄞㄟㄠㄡㄢㄣㄤㄥㄦ'.includes(s[j])) { body += s[j]; j++; }
    if (j < s.length && TONE_SYMBOL[s[j]] && TONE_SYMBOL[s[j]] !== 5) { tone = TONE_SYMBOL[s[j]]; j++; }
    else if (j < s.length && TONE_SYMBOL[s[j]] === 5 && tone === 1) { tone = 5; j++; }   // a trailing ˙ (some fonts/IMEs)
    if (!body) { i = j > i ? j : i + 1; continue; }
    syllables.push({ body, tone, start: i, end: j });
    i = j;
  }
  return syllables;
}

function zhuyinSyllableToPinyin({ body, tone }) {
  let initial = '', rime = body;
  if (PY_INITIAL[body[0]]) { initial = PY_INITIAL[body[0]]; rime = body.slice(1); }
  let base;
  if (!initial) {
    base = RIME_TO_STANDALONE[rime];
    if (base === undefined) return null;
  } else {
    let fin = rime === '' ? (SIBILANT.has(initial) ? 'i' : null) : RIME_TO_FINAL[rime];
    if (fin === null || fin === undefined) return null;
    if (PALATAL.has(initial) && fin.startsWith('ü')) fin = 'u' + fin.slice(1);
    base = initial + fin;
  }
  return placeMark(base, tone);
}

/* "ㄒㄧㄝˋ ˙ㄒㄧㄝ" → "xiè xie". Other characters pass through. */
export function zhuyinToPinyin(zhuyin) {
  const s = String(zhuyin || '');
  const syls = splitZhuyin(s);
  if (!syls.length) return s;
  const out = [];
  let pos = 0, prevWasSyllable = false;
  for (const syl of syls) {
    const between = s.slice(pos, syl.start);
    if (/\S/.test(between)) { out.push(between.replace(/\s+/g, ' ')); prevWasSyllable = false; }
    const py = zhuyinSyllableToPinyin(syl) ?? s.slice(syl.start, syl.end);
    if (prevWasSyllable || (out.length && !/\s$/.test(out[out.length - 1]) && /\s/.test(between))) out.push(' ');
    out.push(py);
    prevWasSyllable = true;
    pos = syl.end;
  }
  const tail = s.slice(pos);
  if (/\S/.test(tail)) out.push(tail);
  return out.join('').replace(/\s+/g, ' ').trim();
}

/* ── comparison and alignment ───────────────────────────────────────────── */

/* True when what the learner typed matches the expected pinyin — tones optional
   with { tones: false } — or when they typed the zhuyin instead. */
export function pinyinMatches(typed, expected, { tones = true } = {}) {
  const t = String(typed || '').trim();
  if (!t) return false;
  if (BOPOMOFO.test(t)) {
    const strip = (z) => String(z).replace(/[\s'’\-]/g, '').replace(tones ? /$^/ : /[ˊˇˋ˙]/g, '');
    const expectedZ = BOPOMOFO.test(String(expected)) ? String(expected) : pinyinToZhuyin(String(expected || ''));
    return strip(t) === strip(expectedZ);
  }
  const a = normalizePinyin(t, { tones }), b = normalizePinyin(expected, { tones });
  return a.length > 0 && a === b;
}

/* Per-character syllables when the reading lines up with the ideographs,
   else null: alignReading("謝謝", "ㄒㄧㄝˋ ˙ㄒㄧㄝ") → ["ㄒㄧㄝˋ", "˙ㄒㄧㄝ"]. */
export function alignReading(hanzi, reading) {
  const chars = hanziChars(hanzi);
  const r = String(reading || '').trim();
  if (!chars.length || !r) return null;
  let syll;
  if (BOPOMOFO.test(r)) syll = splitZhuyin(r).map((x) => r.slice(x.start, x.end));
  else syll = splitSyllables(r);
  return syll.length === chars.length ? syll : null;
}
