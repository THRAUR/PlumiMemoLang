/* Every word the app says to a model. Kept in one file so the teaching voice
   can be read (and fixed) in one sitting, and so tasks.js stays about routing,
   validation and accounting.

   Three things are load-bearing and must never be softened:
     - Traditional characters, Taiwan usage. A simplified 说 in a lesson card is
       a wrong answer the learner will memorise.
     - Both readings for every Chinese string: pinyin with tone marks, zhuyin
       with ˊ ˇ ˋ after the syllable and ˙ before it.
     - JSON only. The schema is enforced when the model supports it, but half of
       OpenRouter's catalogue does not, so the prompt has to ask as well.

   Token budget matters too: the learner pays per token. Notes are capped, the
   known-word list is sent as bare hanzi, and `suggest`/`reading` never see a
   full Word object. */

import { SKILLS, REASONS } from '../../shared/goals.js';
import { groupRanges } from '../../shared/pages.js';

export const POS = ['n', 'v', 'adj', 'adv', 'mw', 'conj', 'prep', 'part', 'interj', 'pron', 'num', 'expr', ''];
export const WORD_TYPES = ['character', 'word', 'phrase', 'sentence', 'grammar'];
export const SECTION_KINDS = ['vocab', 'grammar', 'dialogue', 'culture', 'tip', 'text'];
export const LEVELS = ['beginner', 'elementary', 'intermediate', 'advanced'];

export const NOTES_CAP = 40000;        // characters of raw notes we are willing to send
export const KNOWN_CAP_EXTRACT = 1500; // hanzi listed for "already known"
export const KNOWN_CAP_SUGGEST = 1200;
export const IMAGE_CAP = 20;           // photos or document pages per extract call (documents allow 20 pages)
export const READING_WORDS_CAP = 40;

const LEVEL_HINT = {
  beginner: 'a few hundred characters; sentences of 4–10 characters, present tense, everyday topics',
  elementary: 'roughly 500–1000 words; short sentences, common connectives (因為…所以…, 可是)',
  intermediate: 'roughly 2000 words; compound sentences, opinions, past events, some written-style words',
  advanced: 'comfortable with news and essays; idioms (成語), formal register and nuance are welcome',
};

export function languageName(code) {
  const c = String(code || '').trim();
  if (!c || c.toLowerCase().startsWith('en')) return 'English';
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(c);
    if (name && name !== c) return name;
  } catch { /* fall through to the raw code */ }
  return c;
}

export function isEnglish(code) {
  return !code || String(code).trim().toLowerCase().startsWith('en');
}

function levelLine(level) {
  const key = LEVELS.includes(level) ? level : 'beginner';
  return `${key} (${LEVEL_HINT[key]})`;
}

/* The same teacher for every task. `json: false` is only for the connection
   test, which wants one plain sentence. */
export function systemPrompt(learner = {}, { json = true } = {}) {
  const { nativeLanguage = 'en', level = 'beginner', script = 'zhuyin' } = learner || {};
  const native = languageName(nativeLanguage);
  const lines = [
    'You are an expert Mandarin teacher writing study material for one adult learner who takes Traditional Chinese classes in Taiwan.',
    '',
    'Non-negotiable rules:',
    '- Traditional characters ONLY (繁體字, Taiwan standard). Never simplified: 說 not 说, 學 not 学, 這 not 这, 臺灣/台灣 not 台湾.',
    '- Taiwan usage and vocabulary: 腳踏車 (not 自行車), 捷運, 便當, 影片 (not 視頻), 計程車 (not 出租車), 馬鈴薯 (not 土豆).',
    '- pinyin: lowercase, tone MARKS, exactly one space between syllables — "xiè xie", never "xie4xie5", never "xièxie".',
    '- zhuyin (注音): one space between syllables, one syllable per Chinese character, tone symbols ˊ ˇ ˋ AFTER the syllable, the neutral tone ˙ BEFORE it, tone 1 unmarked. 謝謝 → "ㄒㄧㄝˋ ˙ㄒㄧㄝ". 你好 → "ㄋㄧˇ ㄏㄠˇ". 東西 → "ㄉㄨㄥ ˙ㄒㄧ".',
    '- Give BOTH readings for every Chinese string you write: words, example sentences, dialogue lines, passages.',
    `- Explanations, meanings, grammar notes and titles: English. The learner reads readings as ${script === 'pinyin' ? 'pinyin' : script === 'both' ? 'zhuyin and pinyin' : 'zhuyin'}, so never skip them.`,
    isEnglish(nativeLanguage)
      ? '- Leave every "meaningNative" field as an empty string (the learner works in English).'
      : `- "meaningNative" is the same meaning written in ${native}. Keep it short, no explanation.`,
    `- The learner's level is ${levelLine(level)}. Keep example sentences inside that range.`,
    ...goalLines(learner),
    '- Never invent a reading, a character or a usage you are unsure of; choose a simpler word you are sure about instead.',
  ];
  if (json) {
    lines.push('- Answer with JSON only: no prose before or after, no markdown, no code fences. Use exactly the requested keys; use "" or [] for anything you do not have.');
  }
  return lines.join('\n');
}

/* What the learner told the welcome questions (shared/goals.js), in words a model
   can act on. The focus line is the one that changes the material: a learner who
   wants to SPEAK needs phrases they can say, not character trivia. */
function goalLines(learner) {
  const g = learner?.goals || {};
  const lines = [];
  const skillWords = { speak: 'speak', listen: 'understand spoken Chinese', read: 'read characters', write: 'write characters', type: 'type Chinese' };
  const skills = (g.skills || []).filter((id) => SKILLS.some((x) => x.id === id)).map((id) => skillWords[id]);
  if (skills.length) lines.push(`- What the learner wants to be able to do: ${skills.join(', ')}.`);
  const reasons = (g.reasons || []).map((id) => REASONS.find((x) => x.id === id)?.label.toLowerCase()).filter(Boolean);
  if (reasons.length) lines.push(`- Why they learn: ${reasons.join(', ')}. Pick topics and examples that fit.`);
  if (g.classes === 'regular' || g.classes === 'sometimes') lines.push('- They take classes with a teacher; their notes and pages come from those classes.');
  const about = String(g.about || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (about) lines.push(`- In their own words: "${about}"`);
  if (learner?.focus === 'speaking') {
    lines.push(
      '- FOCUS: SPEAKING AND LISTENING. They read pinyin and English; characters are only a reference to check the original meaning.',
      '  Prefer phrases and sentence patterns they can say today over single characters, natural spoken Taiwanese Mandarin,',
      '  and example sentences short enough to repeat aloud (at most about 14 syllables). Add pronunciation notes where they help',
      '  (tones, tone sandhi of 一, 不 and third tones, common Taiwan pronunciations). No stroke order, radicals or character trivia.',
    );
  } else if (learner?.focus === 'characters') {
    lines.push('- FOCUS: READING AND WRITING CHARACTERS. Character components, radicals and look-alike characters make useful notes.');
  }
  return lines;
}

/* ── small helpers ───────────────────────────────────────────────────────── */

function cleanList(list, cap) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const s = String(item ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  // The tail is the most recently learned material, which is what the model
  // should be closest to.
  return cap && out.length > cap ? out.slice(-cap) : out;
}

function knownBlock(list, cap, label) {
  const items = cleanList(list, cap);
  if (!items.length) return `${label}: (none yet — this is the learner's first material)`;
  const more = Array.isArray(list) && cleanList(list).length > items.length
    ? ` (most recent ${items.length} of ${cleanList(list).length})` : '';
  return `${label}${more}:\n${items.join(' ')}`;
}

/* ── schemas (written naturally; openrouter.strictify() makes them strict) ── */

const EXAMPLE = {
  type: 'object',
  properties: {
    zh: { type: 'string', description: 'Traditional characters' },
    pinyin: { type: 'string', description: 'tone marks, one space per syllable' },
    zhuyin: { type: 'string', description: 'one space per syllable, ˙ before a neutral syllable' },
    translation: { type: 'string', description: 'English' },
  },
};

const WORD_DRAFT = {
  type: 'object',
  properties: {
    hanzi: { type: 'string', description: 'Traditional characters only' },
    pinyin: { type: 'string' },
    zhuyin: { type: 'string' },
    meaning: { type: 'string', description: 'English, short' },
    meaningNative: { type: 'string', description: "the learner's language, or empty" },
    pos: { type: 'string', enum: POS },
    type: { type: 'string', enum: WORD_TYPES },
    examples: { type: 'array', description: '1–2 short sentences', items: EXAMPLE },
    notes: { type: 'string', description: 'usage or nuance, one or two sentences, or empty' },
    tags: { type: 'array', description: 'lowercase English topic tags', items: { type: 'string' } },
    isKnown: { type: 'boolean', description: 'true when the hanzi appears in the known list' },
  },
};

const LESSON = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'English, ≤ 6 words' },
    titleZh: { type: 'string', description: 'Traditional characters, ≤ 8 characters' },
    summary: { type: 'string', description: '2–4 sentences, English' },
    sections: {
      type: 'array',
      description: '2–6 cards in reading order',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: SECTION_KINDS },
          title: { type: 'string' },
          titleZh: { type: 'string' },
          body: { type: 'string', description: "plain text or light markdown (**bold**, lines starting with '- ')" },
        },
      },
    },
    grammar: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'e.g. "A 比 B + adj"' },
          explanation: { type: 'string', description: 'English, 1–3 sentences' },
          examples: { type: 'array', description: 'exactly 2', items: EXAMPLE },
        },
      },
    },
    dialogue: {
      type: 'array',
      description: '4–8 lines, or empty when the material does not suggest one',
      items: {
        type: 'object',
        properties: {
          speaker: { type: 'string', description: 'A / B or a name' },
          zh: { type: 'string' },
          pinyin: { type: 'string' },
          zhuyin: { type: 'string' },
          translation: { type: 'string' },
        },
      },
    },
  },
};

export const SCHEMAS = {
  extract: {
    type: 'object',
    properties: {
      lessons: {
        type: 'array',
        description: '1 to 4 lessons, as the split instruction says',
        items: {
          type: 'object',
          properties: {
            lesson: LESSON,
            words: { type: 'array', description: '6–40 entries', items: WORD_DRAFT },
          },
        },
      },
    },
  },

  suggest: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            hanzi: { type: 'string' },
            pinyin: { type: 'string' },
            zhuyin: { type: 'string' },
            meaning: { type: 'string' },
            meaningNative: { type: 'string' },
            pos: { type: 'string', enum: POS },
            why: { type: 'string', description: 'one sentence: why this word, now' },
            example: EXAMPLE,
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },

  enrich: {
    type: 'object',
    properties: {
      pinyin: { type: 'string' },
      zhuyin: { type: 'string' },
      meaning: { type: 'string' },
      meaningNative: { type: 'string' },
      pos: { type: 'string', enum: POS },
      type: { type: 'string', enum: WORD_TYPES },
      examples: { type: 'array', description: '1–2 short sentences', items: EXAMPLE },
      notes: { type: 'string' },
    },
  },

  explain: {
    type: 'object',
    properties: {
      answer: { type: 'string', description: '≤ 200 words, light markdown' },
    },
  },

  reading: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'English, ≤ 6 words' },
      passage: {
        type: 'object',
        properties: {
          zh: { type: 'string', description: '60–120 Traditional characters' },
          pinyin: { type: 'string' },
          zhuyin: { type: 'string' },
          translation: { type: 'string', description: 'English' },
        },
      },
      questions: {
        type: 'array',
        description: '3–4 comprehension questions',
        items: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'English question about the passage' },
            options: { type: 'array', description: 'exactly 4 short options', items: { type: 'string' } },
            answerIndex: { type: 'integer', description: '0-based index of the correct option' },
          },
        },
      },
    },
  },
};

/* ── user messages ───────────────────────────────────────────────────────── */

export const LESSONS_MAX = 4;

/* How many lessons one source becomes. `per-range` follows the page ranges the
   learner typed ("9–11, 25" → two lessons); `auto` lets the model find units. */
function splitRule(input) {
  const split = ['one', 'per-range', 'auto'].includes(input?.split) ? input.split : 'one';
  if (split === 'per-range') {
    const printed = (Array.isArray(input?.pages) ? input.pages : []).map((p) => Number(p?.printed ?? p?.pdf)).filter(Number.isFinite);
    const ranges = groupRanges(printed).slice(0, LESSONS_MAX).map(([a, b]) => (a === b ? `page ${a}` : `pages ${a}–${b}`));
    if (ranges.length > 1) {
      return `Make one lesson per page range, in this order: ${ranges.map((r, i) => `lesson ${i + 1} = ${r}`).join('; ')}.`;
    }
  }
  if (split === 'auto') {
    return `Make one lesson per coherent unit or topic in the material (a textbook unit, a dialogue with its vocabulary, a grammar topic), at most ${LESSONS_MAX}. Never split one dialogue or one grammar explanation across lessons. One lesson is right when the material is one topic.`;
  }
  return 'Make exactly ONE lesson that covers everything below.';
}

function extractMessage(input, learner) {
  const title = String(input?.title || '').trim();
  const classDate = String(input?.classDate || '').trim();
  const rawText = String(input?.text || '');
  const text = rawText.slice(0, NOTES_CAP);
  const truncated = rawText.length > NOTES_CAP;
  const instructions = String(input?.instructions || '').trim().slice(0, 2000);
  const pages = Array.isArray(input?.pages) ? input.pages : [];
  const isDocument = pages.length > 0;
  const sourceTitle = String(input?.source?.title || '').trim();

  const images = (Array.isArray(input?.images) ? input.images : [])
    .map((im) => (typeof im === 'string' ? im : im?.dataUrl || im?.url || ''))
    .filter((url) => typeof url === 'string' && /^(data:image\/|https?:\/\/)/.test(url))
    .slice(0, IMAGE_CAP);
  const droppedImages = (Array.isArray(input?.images) ? input.images.length : 0) - images.length;

  const parts = [
    isDocument
      ? 'Turn these pages into lesson cards, each with its vocabulary list.'
      : 'Turn these class notes into lesson cards, each with its vocabulary list.',
    '',
    `Title the learner gave: ${title || '(none — write one per lesson)'}`,
    `Class date: ${classDate || '(unknown)'}`,
    `Learner level: ${levelLine(learner.level)}`,
    `Reading the learner studies with: ${learner.script}`,
    `Learner's language for meaningNative: ${isEnglish(learner.nativeLanguage) ? 'English — leave meaningNative empty' : languageName(learner.nativeLanguage)}`,
    '',
    splitRule(input),
    '',
  ];

  if (isDocument) {
    const labels = pages.map((p) => (p?.printed && Number(p.printed) !== Number(p.pdf) ? `page ${p.printed} (PDF page ${p.pdf})` : `page ${p?.pdf ?? p?.printed}`));
    parts.push(
      `Source: ${sourceTitle ? `"${sourceTitle}", ` : ''}${labels.length} page${labels.length > 1 ? 's' : ''}: ${labels.join(', ')}.`,
      `The pages are attached as images in that order${droppedImages > 0 ? ` (${droppedImages} more were left out)` : ''}. They may be scans of a textbook: read everything on them — dialogues, vocabulary tables, grammar boxes, exercises — before you structure anything. Ignore page furniture (running headers, page numbers, publisher notes).`,
      '',
    );
  }
  if (instructions) {
    parts.push("--- THE LEARNER'S INSTRUCTIONS FOR THIS MATERIAL (follow them) ---", instructions, '--- END OF INSTRUCTIONS ---', '');
  }
  if (text.trim()) {
    parts.push(
      isDocument
        ? '--- TEXT LAYER OF THE PAGES (may be incomplete or garbled; the images are the truth) ---'
        : '--- RAW NOTES (verbatim, messy, possibly mixed languages) ---',
      text.trim(),
      isDocument ? '--- END OF TEXT LAYER ---' : '--- END OF NOTES ---',
    );
    if (truncated) parts.push(`(The text was longer than ${NOTES_CAP.toLocaleString('en-US')} characters and was cut here. Work with what you have.)`);
    parts.push('');
  } else if (!images.length) {
    parts.push('(No text and no photos were provided — say so by returning an empty lessons array.)', '');
  }

  if (images.length && !isDocument) {
    parts.push(
      `${images.length} photo${images.length > 1 ? 's' : ''} of the same class ${images.length > 1 ? 'are' : 'is'} attached: handwritten notes, a whiteboard, or textbook pages${droppedImages > 0 ? ` (${droppedImages} more were left out)` : ''}.`,
      'Read every photo carefully and transcribe what it contains first, in your head — characters, readings, translations, the teacher\'s examples, anything in the margins — then structure the result. Do not describe the photos.',
      '',
    );
  }

  parts.push(
    knownBlock(input?.knownHanzi, KNOWN_CAP_EXTRACT, 'Words the learner already knows'),
    'Set "isKnown": true for any word from that list. Still include such a word when a lesson genuinely needs it (a grammar pattern, a dialogue line); do not pad the list with words the material never mentions.',
    '',
    'Answer { "lessons": [ { "lesson": { … }, "words": [ … ] } ] }. For EACH lesson:',
    '1. lesson.title — English, ≤ 6 words — and lesson.titleZh in Traditional characters.',
    '2. lesson.summary — 2–4 sentences: what it covers and what the learner should be able to do afterwards.',
    '3. lesson.sections — 2 to 6 cards, kind ∈ vocab | grammar | dialogue | culture | tip | text, in reading order. Body is plain text or light markdown ("- " bullets, **bold**). This is where explanations go.',
    '4. lesson.grammar — every pattern the lesson touches, each with a short English explanation and exactly 2 examples (zh + pinyin + zhuyin + translation).',
    '5. lesson.dialogue — 4 to 8 lines of natural spoken Taiwanese Mandarin reusing the lesson\'s words when the material has or suggests a conversation; otherwise [].',
    '6. words — 6 to 40 entries: every vocabulary item of that lesson, plus the obvious siblings a teacher would expect, no filler. type ∈ character | word | phrase | sentence | grammar. Each entry: hanzi, pinyin, zhuyin, meaning, meaningNative, pos, 1–2 examples, tags, isKnown.',
    '',
    learner.focus === 'speaking'
      ? 'This learner is learning to SPEAK: prefer words, phrases and whole sentences people actually say; list a single character only when it is a word on its own; keep examples short enough to say aloud.'
      : 'Prefer the words the material actually contains over words you would have chosen.',
    'If something is ambiguous, follow the more common Taiwan usage and say so in notes.',
  );

  const content = [{ type: 'text', text: parts.join('\n') }];
  for (const url of images) content.push({ type: 'image_url', image_url: { url } });
  return [{ role: 'user', content: images.length ? content : parts.join('\n') }];
}

function suggestMessage(input, learner) {
  const count = Math.max(1, Math.min(20, Number(input?.count) || 5));
  const topics = cleanList(input?.recentTopics, 8);
  const parts = [
    `Propose ${count} new Traditional Chinese words for this learner to study today.`,
    '',
    `Learner level: ${levelLine(learner.level)}`,
    topics.length ? `Recent lesson topics (most recent last): ${topics.join('; ')}` : 'No lessons recorded yet.',
    '',
    knownBlock(input?.known, KNOWN_CAP_SUGGEST, 'Already known — never suggest any of these'),
    '',
    'Rules:',
    '- High-frequency and immediately useful in Taiwan: something the learner could say or read this week.',
    '- Thematically close to the recent topics, so today\'s words reinforce the last class.',
    `- None of them may appear in the known list${count > 1 ? ', and no duplicates among them' : ''}.`,
    '- Each item: hanzi, pinyin, zhuyin, meaning, meaningNative, pos, why (one sentence, concrete), one short example sentence with pinyin, zhuyin and translation, and 1–3 tags.',
  ];
  if (learner.focus === 'speaking') {
    parts.push('- This learner is learning to SPEAK: suggest words and short phrases people say out loud in daily life in Taiwan, not literary or written-only words. Put the most useful one first.');
  }
  return [{ role: 'user', content: parts.join('\n') }];
}

function enrichMessage(input, learner) {
  const w = input?.word || {};
  const compact = {
    hanzi: String(w.hanzi || '').trim(),
    pinyin: String(w.pinyin || '').trim(),
    zhuyin: String(w.zhuyin || '').trim(),
    meaning: String(w.meaning || '').trim(),
    pos: String(w.pos || '').trim(),
    type: String(w.type || '').trim(),
    notes: String(w.notes || '').trim(),
    examples: Array.isArray(w.examples) ? w.examples.length : 0,
    tags: cleanList(w.tags, 6),
  };
  const parts = [
    'Complete this dictionary entry.',
    '',
    JSON.stringify(compact),
    '',
    `Learner level: ${levelLine(learner.level)}`,
    'Fill every field: keep what is already correct, replace what is wrong, and write what is missing.',
    'Return pinyin, zhuyin, meaning, meaningNative, pos, type, examples (1–2 short sentences with zh, pinyin, zhuyin, translation) and notes (usage, register, Taiwan-specific nuance, or "").',
  ];
  return [{ role: 'user', content: parts.join('\n') }];
}

function explainMessage(input, learner) {
  const w = input?.word || {};
  const question = String(input?.question || '').trim();
  const parts = [
    'Answer the learner\'s question about one word.',
    '',
    `Word: ${String(w.hanzi || '').trim()}${w.pinyin ? ` (${String(w.pinyin).trim()})` : ''}${w.meaning ? ` — ${String(w.meaning).trim()}` : ''}`,
    w.notes ? `Existing note: ${String(w.notes).trim()}` : '',
    '',
    `Question: ${question || 'Explain this word: when do I use it, and what do learners get wrong?'}`,
    '',
    `Answer in English${isEnglish(learner.nativeLanguage) ? '' : ` (a ${languageName(learner.nativeLanguage)} gloss in brackets is welcome)`}, 200 words maximum.`,
    'Light markdown only: **bold**, "- " bullets. Every Chinese string you write gets pinyin with tone marks in brackets.',
    'Be concrete: contrast with the word the learner would confuse it with, and give one example sentence at their level.',
    `Learner level: ${levelLine(learner.level)}`,
  ].filter(Boolean);
  return [{ role: 'user', content: parts.join('\n') }];
}

function readingMessage(input, learner) {
  // Only hanzi + meaning: a full Word object would triple the prompt for no gain.
  const words = (Array.isArray(input?.words) ? input.words : [])
    .map((w) => ({ hanzi: String(w?.hanzi || '').trim(), meaning: String(w?.meaning || '').trim() }))
    .filter((w) => w.hanzi)
    .slice(0, READING_WORDS_CAP);
  const parts = [
    'Write a short reading exercise.',
    '',
    `Learner level: ${levelLine(learner.level)}`,
    'Use as many of these words as reads naturally (do not force them in):',
    words.map((w) => (w.meaning ? `${w.hanzi} (${w.meaning})` : w.hanzi)).join(', ') || '(no words yet — choose level-appropriate everyday vocabulary)',
    '',
    'Requirements:',
    '- passage.zh: 60–120 Traditional characters, one small everyday scene with a beginning and an end. Natural spoken Taiwanese Mandarin.',
    '- passage.pinyin and passage.zhuyin: the whole passage, one space per syllable, punctuation kept.',
    '- passage.translation: English.',
    '- questions: 3 or 4 comprehension questions in English, each with exactly 4 short options and answerIndex (0-based) pointing at the correct one. Wrong options must be plausible but clearly wrong to someone who understood the passage.',
    '- title: English, ≤ 6 words.',
  ];
  if (learner.focus === 'speaking') {
    parts.push('- This learner is learning to SPEAK and LISTEN: write the passage as a short spoken exchange between two people (label the speakers), in words people really say.');
  }
  return [{ role: 'user', content: parts.join('\n') }];
}

function testMessage() {
  return [{
    role: 'user',
    content: 'Say hello to a Traditional Chinese learner in ONE short friendly sentence of Traditional Chinese (Taiwan usage), then its pinyin with tone marks in brackets. Nothing else.',
  }];
}

const BUILDERS = {
  extract: extractMessage,
  suggest: suggestMessage,
  enrich: enrichMessage,
  explain: explainMessage,
  reading: readingMessage,
  test: testMessage,
};

/* → [{ role: "system" }, { role: "user" }]. `learner` is
   { nativeLanguage, level, script }, already resolved from settings/input. */
export function buildMessages(taskId, input, learner) {
  const build = BUILDERS[taskId];
  if (!build) throw new Error(`Unknown AI task: ${taskId}`);
  const wantsJson = Boolean(SCHEMAS[taskId]);
  return [
    { role: 'system', content: systemPrompt(learner, { json: wantsJson }) },
    ...build(input || {}, learner),
  ];
}
