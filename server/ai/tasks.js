/* The one door to the models. Every AI call in the app goes through runTask()
   so that four things stay in a single place:

     - model order        the models in ./models.js, tried top to bottom; when one
                          fails, the next one takes over
     - the providers      OpenRouter models are paid with settings.ai.apiKey (else
                          OPENROUTER_API_KEY, else a sentence telling the learner
                          where to paste one); Claude plan models run through Claude
                          Code on this computer (./claude-code.js), included in the
                          learner's own Claude subscription
     - normalisation      what a model returns is *suggested* data, never trusted:
                          trimmed, deduped, readings filled in from shared/zhuyin.js,
                          fields coerced back into the shapes in ARCHITECTURE §3
     - accounting         one row in data/usage.json per call, success or failure,
                          so the Settings screen can show what this costs

   Nothing here ever logs or returns the API key. */
import { config } from '../config.js';
import { coll, doc } from '../store.js';
import { DEFAULT_SETTINGS, deepMerge, isPlain } from '../defaults.js';
import { chat } from '../openrouter.js';
import { claudeChat, claudeUsable } from './claude-code.js';
import { modelChain, isAllowedModel, isPlanModel, modelName, normalisePriority, providerOf } from './models.js';
import { buildMessages, SCHEMAS, POS, WORD_TYPES, SECTION_KINDS } from './prompts.js';
import { pinyinToZhuyin, zhuyinToPinyin } from '../../shared/zhuyin.js';
import { learnerProfile } from '../../shared/goals.js';
import { LESSONS_MAX } from './prompts.js';

const usageLog = coll('usage');

const EXAMPLES_CAP = 3;      // per word / grammar point — a memo card shows one
const TAGS_CAP = 8;
const WORDS_CAP = 60;        // a class produces 6–40; 60 means the model ran away
const SECTIONS_CAP = 12;

/* `importance` and `why` say what each task is worth. Since the key was limited
   to four models, every task walks the same list (./models.js) instead of
   picking its own; a task still sets its budget, tone and timeout.
   `planTimeoutMs`, where a task has one, is the limit for one attempt on a Claude
   plan model: Claude Code starts a process per call and writes more slowly than
   Gemini Flash Lite. Plan models run at low effort unless a task sets `planEffort`. */
export const TASKS = {
  extract: {
    id: 'extract',
    label: 'Notes → lesson',
    importance: 'high',
    why: 'Turns your notes into your whole lesson; mistakes here are learned.',
    defaultTemperature: 0.2,
    // Several lessons from one source, each with up to 40 words and their examples.
    maxTokens: 16000,
    // Per attempt. Three photo-capable models at 3 min each stays inside the
    // 10 minutes a phone waits on the job before it gives up.
    timeoutMs: 180000,
    // A short class note takes a plan model under a minute at low effort; twenty
    // document pages take a few. A plan attempt that runs out plus one OpenRouter
    // attempt still fit the phone's 10 minutes; only a chain where several models
    // all time out runs past it.
    planTimeoutMs: 240000,
    progress: 'Reading your notes…',
    progressAfter: 'Building the lesson…',
  },
  suggest: {
    id: 'suggest',
    label: 'Daily new words',
    importance: 'medium',
    why: 'Picks the words you meet tomorrow; a weak choice wastes a day, not a lesson.',
    defaultTemperature: 0.7,
    maxTokens: 2500,
    timeoutMs: 120000,
    progress: 'Choosing new words…',
    progressAfter: 'Checking them against what you know…',
  },
  reading: {
    id: 'reading',
    label: 'Reading challenge',
    importance: 'medium',
    why: 'Writes a passage you read end to end; awkward Chinese still reads as Chinese.',
    defaultTemperature: 0.6,
    maxTokens: 3000,
    timeoutMs: 150000,
    progress: 'Writing your reading…',
    progressAfter: 'Checking the questions…',
  },
  enrich: {
    id: 'enrich',
    label: 'Complete a word',
    importance: 'low',
    why: 'Fills in one missing reading or example, which you can see and fix.',
    defaultTemperature: 0.3,
    maxTokens: 1200,
    timeoutMs: 90000,
    progress: 'Completing the word…',
    progressAfter: 'Tidying the entry…',
  },
  explain: {
    id: 'explain',
    label: 'Explain / ask',
    importance: 'low',
    why: 'Answers one question in front of you; you can always ask again.',
    defaultTemperature: 0.4,
    maxTokens: 1000,
    timeoutMs: 90000,
    progress: 'Thinking…',
    progressAfter: '',
  },
  test: {
    id: 'test',
    label: 'Connection test',
    importance: 'low',
    why: 'Says hello, to prove a model on your list can answer.',
    defaultTemperature: 0.5,
    maxTokens: 300,
    timeoutMs: 45000,
    progress: 'Saying hello…',
    progressAfter: '',
  },
};

export const TASK_IDS = Object.keys(TASKS);

/* ── settings ────────────────────────────────────────────────────────────── */

/* runTask() is always called with the live settings by the routes; falling back
   to the stored document keeps a job that outlived its request working. */
function resolveSettings(settings) {
  const base = isPlain(settings) ? settings : doc('settings', DEFAULT_SETTINGS).get() || {};
  return deepMerge(DEFAULT_SETTINGS, base);
}

/* The models one call will try, in order: the learner's priority list, always
   complete and always inside the allow-list (./models.js), with `prefer` moved
   to the front and text-only models dropped when photos ride along. */
export function resolveChain(settings, { images = false, prefer = '' } = {}) {
  return modelChain(resolveSettings(settings)?.ai?.priority, { images, prefer });
}

/* The model a call starts with. Every task shares one list, so `taskId` is
   kept for the signature and only `opts.images` changes the answer. */
export function resolveModel(settings, taskId, opts = {}) {
  return resolveChain(settings, opts)[0] || '';
}

/* The learner's own key wins over the one in .env: they pasted it last. */
export function resolveApiKey(settings) {
  const key = str(resolveSettings(settings)?.ai?.apiKey) || str(config.envApiKey);
  if (!key) throw new Error('Add your OpenRouter API key in Settings first.');
  return key;
}

/* For routes that must answer "no-key" instead of failing (GET /suggestions/today). */
export function hasApiKey(settings) {
  try { return Boolean(resolveApiKey(settings)); } catch { return false; }
}

export const NO_AI_MESSAGE = 'Connect an AI first: turn on your Claude plan or add an OpenRouter API key in Settings.';

/* Whether anything on the list can answer at all: an OpenRouter key, or a Claude
   plan model in the order with Claude Code on this computer. Routes check it before
   they start a job, so the learner reads "connect an AI" instead of watching a job
   fail. */
export function aiReady(settings) {
  const s = resolveSettings(settings);
  if (hasApiKey(s)) return true;
  return normalisePriority(s.ai?.priority).some(isPlanModel) && claudeUsable();
}

function learnerFrom(settings, input) {
  const s = resolveSettings(settings);
  const l = isPlain(input?.learner) ? input.learner : {};
  // Goals come from settings only: they describe the learner, not one request.
  const profile = learnerProfile(s);
  return {
    goals: profile.goals,
    focus: profile.focus,
    hanzi: profile.hanzi,
    nativeLanguage: str(l.nativeLanguage) || str(input?.nativeLanguage) || str(s.nativeLanguage) || 'en',
    level: str(l.level) || str(input?.level) || str(s.level) || 'beginner',
    script: str(l.script) || str(input?.script) || str(s.script) || 'zhuyin',
  };
}

/* ── the call ────────────────────────────────────────────────────────────── */

export async function runTask(taskId, input = {}, { settings, onProgress, signal, timeoutMs, prefer = '', only = false } = {}) {
  const task = TASKS[taskId];
  if (!task) throw new Error(`Unknown AI task: ${taskId}`);

  const s = resolveSettings(settings);
  const wanted = str(prefer);
  // The key's guardrail refuses every other model, so an id from anywhere else
  // (an old tab, a hand-written request) stops here instead of at OpenRouter.
  if (wanted && !isAllowedModel(wanted)) throw new Error(`${wanted} is not on the allowed model list.`);
  // Only extract carries photos. A text-only model would refuse them or, worse,
  // answer confidently from the typed notes alone.
  const images = Array.isArray(input?.images) && input.images.length > 0;
  // `only` is the per-model connection test: a dead model must show up as dead,
  // not be hidden by the next one answering for it.
  const listed = only && wanted ? [wanted] : resolveChain(s, { images, prefer: wanted });
  // Without a key the OpenRouter models are left out instead of tried, since each
  // would fail the same way. The Claude plan models need no key.
  const keyed = hasApiKey(s);
  const chain = keyed ? listed : listed.filter(isPlanModel);
  if (!chain.length) {
    if (!keyed) resolveApiKey(s);            // throws the human "add your key" line
    throw new Error(images ? 'None of the allowed models can read photos.' : 'No allowed model is available.');
  }
  const learner = learnerFrom(s, input);
  const say = (text) => {
    if (!text || typeof onProgress !== 'function') return;
    try { onProgress(text); } catch { /* a broken progress sink must not fail the task */ }
  };

  const messages = buildMessages(taskId, input, learner);
  const schema = SCHEMAS[taskId] || null;
  const failures = [];
  // Providers that failed in a way every one of their models would: skipped for
  // the rest of this call, while the other provider's models still get their turn.
  const dead = new Set();

  say(task.progress);
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    const provider = providerOf(model);
    if (dead.has(provider)) continue;
    const started = Date.now();
    let usage = null;
    try {
      const out = provider === 'claude-code'
        ? await claudeChat({
          model,
          messages,
          schema,
          effort: task.planEffort || 'low',
          timeoutMs: timeoutMs || task.planTimeoutMs || task.timeoutMs,
          signal,
        })
        : await chat({
          apiKey: resolveApiKey(s),
          model,
          messages,
          schema,
          schemaName: taskId,
          temperature: task.defaultTemperature,
          maxTokens: task.maxTokens,
          timeoutMs: timeoutMs || task.timeoutMs,
          signal,
        });
      usage = out.usage;
      say(task.progressAfter);
      const result = normalise(taskId, out, input, learner);
      logUsage({ task: taskId, model: out.model || model, provider, usage, ms: Date.now() - started, ok: true });
      return { result, usage, model: out.model || model, fallbacks: failures };
    } catch (e) {
      const message = humanMessage(e, taskId, provider);
      // The learner paid for the tokens even when the answer was unusable, so
      // every failed attempt is logged with whatever usage it reported.
      logUsage({ task: taskId, model, provider, usage: usage || e?.usage, ms: Date.now() - started, ok: false, error: message });
      failures.push({ model, error: message });
      const reach = failureReach(e, signal);
      if (reach === 'provider') dead.add(provider);
      const next = reach === 'stop' ? null : chain.slice(i + 1).find((id) => !dead.has(providerOf(id)));
      if (next) {
        say(`${modelName(model)} failed. Trying ${modelName(next)}…`);
        continue;
      }
      throw finalError(e, message, failures);
    }
  }
  throw new Error('No allowed model is available.');   // unreachable: the loop returns or throws
}

/* How far a failure reaches.
     model     it belongs to one model (down, rate-limited, refused by the key's
               allow-list, too slow, an unusable answer): the next model takes over
     provider  every model of that provider would fail the same way (a rejected key,
               an empty balance; Claude Code missing, logged out or at the plan's
               usage limit): its other models are skipped, the other provider's run
     stop      nothing else should run: the learner cancelled */
function failureReach(e, signal) {
  if (signal?.aborted) return 'stop';
  if (e?.provider === 'claude-code') return ['model', 'provider', 'stop'].includes(e.scope) ? e.scope : 'model';
  const said = String(e?.message || '');
  if (/Cancelled/i.test(said)) return 'stop';
  const status = Number(e?.status ?? e?.cause?.status) || 0;
  if (status === 401 || status === 402 || /rejected the API key|out of credits/i.test(said)) return 'provider';
  return 'model';
}

/* One failure keeps its own words. Several say which models were tried, so the
   learner can see the backups ran before anything reached them. */
function finalError(e, message, failures) {
  if (failures.length <= 1) return e?.message === message ? e : Object.assign(new Error(message), { cause: e });
  const tried = failures.map((f) => modelName(f.model)).join(', ');
  return Object.assign(new Error(`Every model on your list failed (${tried}). The last one said: ${message}`), { cause: e, failures });
}

function humanMessage(e, taskId, provider = 'openrouter') {
  if (e instanceof TypeError || e instanceof RangeError) {
    console.error(`[ai ${taskId}]`, e);      // our bug, not the learner's problem
    return 'The model returned something this app could not read. Try again.';
  }
  const m = e?.message ? String(e.message) : '';
  return m || (provider === 'claude-code' ? 'Something went wrong talking to Claude Code.' : 'Something went wrong talking to OpenRouter.');
}

function logUsage({ task, model, provider = 'openrouter', usage, ms, ok, error = null }) {
  try {
    const row = {
      at: new Date().toISOString(),
      task,
      model,
      provider,
      promptTokens: Number(usage?.promptTokens) || 0,
      completionTokens: Number(usage?.completionTokens) || 0,
      // Always a number: /api/usage and getStats() sum this column. 0 means
      // "free or unknown", which is the honest answer when a model has no prices.
      cost: Number.isFinite(usage?.cost) ? usage.cost : 0,
      ms: Number(ms) || 0,
      ok: Boolean(ok),
      error: error || null,
    };
    // A Claude plan call is included in the plan: nothing is charged, and
    // listCost keeps what it would have cost at API prices.
    if (provider === 'claude-code') {
      row.cost = 0;
      row.included = true;
      row.listCost = Number.isFinite(usage?.listCost) ? usage.listCost : null;
    }
    usageLog.insert(row);
  } catch (e) {
    console.error('[ai] could not write the usage log:', e.message);
  }
}

/* ── small coercions ─────────────────────────────────────────────────────── */

function str(v) {
  if (typeof v === 'string') return v.trim();
  if (v == null || typeof v === 'object') return '';
  return String(v).trim();
}

/* shared/zhuyin.js is written by another module and may return "" for a reading
   it cannot convert (or throw on input we did not foresee). Neither may lose a
   whole lesson: an empty reading is simply left empty for the learner to fill. */
function convert(fn, value) {
  if (!value) return '';
  try {
    const out = fn(value);
    return typeof out === 'string' ? out.trim() : '';
  } catch {
    return '';
  }
}

function readings(pinyinIn, zhuyinIn) {
  let pinyin = str(pinyinIn);
  let zhuyin = str(zhuyinIn);
  if (!zhuyin && pinyin) zhuyin = convert(pinyinToZhuyin, pinyin);
  if (!pinyin && zhuyin) pinyin = convert(zhuyinToPinyin, zhuyin);
  return { pinyin, zhuyin };
}

function oneOf(value, allowed, fallback) {
  const v = str(value).toLowerCase();
  return allowed.includes(v) ? v : fallback;
}

/* Models answer tags as an array, as "food, drink", or as one string. */
function tagList(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,、;]/) : [];
  const out = [];
  for (const t of raw) {
    const s = str(t).toLowerCase();
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= TAGS_CAP) break;
  }
  return out;
}

function normaliseExample(raw) {
  if (!isPlain(raw)) {
    const zh = str(raw);
    if (!zh) return null;
    return { zh, ...readings('', ''), translation: '' };
  }
  const zh = str(raw.zh ?? raw.chinese ?? raw.hanzi ?? raw.sentence);
  if (!zh) return null;
  const { pinyin, zhuyin } = readings(raw.pinyin, raw.zhuyin);
  return { zh, pinyin, zhuyin, translation: str(raw.translation ?? raw.english ?? raw.meaning) };
}

function exampleList(value, cap = EXAMPLES_CAP) {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  const out = [];
  for (const ex of raw) {
    const e = normaliseExample(ex);
    if (e && !out.some((o) => o.zh === e.zh)) out.push(e);
    if (out.length >= cap) break;
  }
  return out;
}

function knownSetOf(list) {
  const set = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const s = str(item);
    if (s) set.add(s);
  }
  return set;
}

/* ── words ───────────────────────────────────────────────────────────────── */

/* `meaning` is already written in the explanation language (./prompts.js), so a
   second meaning is kept only when it adds something: never for an English
   learner, and not when the model copied the meaning into it. */
function secondMeaning(value, meaning, english) {
  const s = str(value);
  if (english || !s) return '';
  return s.toLowerCase() === str(meaning).toLowerCase() ? '' : s;
}

/* A WordDraft exactly as ARCHITECTURE §4.7 describes it: Word fields minus
   id/srs/stats, plus isKnown. Extra keys the model invented are dropped. */
function normaliseWordDraft(raw, { knownSet, english }) {
  if (!isPlain(raw)) return null;
  const hanzi = str(raw.hanzi ?? raw.zh ?? raw.word ?? raw.characters);
  if (!hanzi) return null;                       // nothing to learn without characters
  const { pinyin, zhuyin } = readings(raw.pinyin, raw.zhuyin);
  const meaning = str(raw.meaning ?? raw.english ?? raw.translation ?? raw.definition);
  return {
    hanzi,
    pinyin,
    zhuyin,
    meaning,
    meaningNative: secondMeaning(raw.meaningNative ?? raw.native ?? raw.meaning_native, meaning, english),
    pos: oneOf(raw.pos ?? raw.partOfSpeech, POS, ''),
    type: oneOf(raw.type, WORD_TYPES, 'word'),
    examples: exampleList(raw.examples ?? raw.example),
    notes: str(raw.notes ?? raw.note ?? raw.usage),
    tags: tagList(raw.tags ?? raw.tag),
    isKnown: knownSet.has(hanzi),
  };
}

/* hanzi is the dictionary key, so a repeat is a merge, not a second entry: the
   first mention wins and later ones only fill in what it was missing. */
function dedupeWords(list) {
  const byHanzi = new Map();
  for (const w of list) {
    const found = byHanzi.get(w.hanzi);
    if (!found) {
      byHanzi.set(w.hanzi, w);
      continue;
    }
    for (const key of ['pinyin', 'zhuyin', 'meaning', 'meaningNative', 'pos', 'notes']) {
      if (!found[key] && w[key]) found[key] = w[key];
    }
    if (found.type === 'word' && w.type !== 'word') found.type = w.type;
    for (const ex of w.examples) {
      if (found.examples.length >= EXAMPLES_CAP) break;
      if (!found.examples.some((o) => o.zh === ex.zh)) found.examples.push(ex);
    }
    for (const t of w.tags) {
      if (found.tags.length >= TAGS_CAP) break;
      if (!found.tags.includes(t)) found.tags.push(t);
    }
    found.isKnown = found.isKnown || w.isKnown;
  }
  return [...byHanzi.values()];
}

function wordDrafts(value, ctx) {
  const raw = Array.isArray(value) ? value : [];
  const drafts = raw.map((w) => normaliseWordDraft(w, ctx)).filter(Boolean);
  return dedupeWords(drafts).slice(0, WORDS_CAP);
}

/* Several lessons folded into one, for a learner who asked for exactly one. The
   first lesson's title and summary win; everything else is concatenated and the
   words are deduped the same way as within a lesson. */
function mergeLessons(list) {
  const [first, ...rest] = list;
  const lesson = { ...first.lesson };
  for (const key of ['sections', 'grammar', 'dialogue']) {
    lesson[key] = list.flatMap((x) => x.lesson[key] || []);
  }
  if (!lesson.summary) lesson.summary = rest.map((x) => x.lesson.summary).find(Boolean) || '';
  const words = dedupeWords(list.flatMap((x) => x.words.map((w) => ({ ...w, examples: [...w.examples], tags: [...w.tags] })))).slice(0, WORDS_CAP);
  return { lesson, words };
}

/* ── per-task normalisation ──────────────────────────────────────────────── */

function unusable(taskId, what) {
  // No advice here: runTask() moves on to the next model by itself, and the
  // final error names every model it tried.
  return new Error(`The model did not return ${what}.`);
}

function normalise(taskId, out, input, learner) {
  const english = isEnglishCode(learner.nativeLanguage);
  const json = out.json;

  if (taskId === 'test') {
    // No schema for the connection test: one plain sentence is the friendliest
    // proof that the key works, even on a model that cannot do JSON at all.
    const text = str(out.text);
    const guess = text.startsWith('{') ? safeJson(text) : null;
    const reply = str(guess?.reply) || text;
    if (!reply) throw unusable(taskId, 'an answer');
    return { reply };
  }

  if (!isPlain(json)) throw unusable(taskId, 'a JSON object');

  if (taskId === 'extract') {
    // A model that ignored the new shape and answered one { lesson, words } is
    // still one usable lesson.
    const raw = Array.isArray(json.lessons) ? json.lessons
      : isPlain(json.lesson) || Array.isArray(json.words) ? [{ lesson: json.lesson, words: json.words }] : null;
    if (!raw) throw unusable(taskId, 'any lessons (no "lessons" key)');
    const knownSet = knownSetOf(input?.knownHanzi);
    let lessons = [];
    for (const item of raw) {
      if (!isPlain(item)) continue;
      const l = isPlain(item.lesson) ? item.lesson : {};
      const lesson = {
        title: str(l.title),
        titleZh: str(l.titleZh ?? l.title_zh),
        summary: str(l.summary),
        sections: sectionList(l.sections),
        grammar: grammarList(l.grammar),
        dialogue: dialogueList(l.dialogue),
      };
      const words = wordDrafts(item.words, { knownSet, english });
      if (!words.length && !lesson.summary && !lesson.sections.length) continue;
      lessons.push({ lesson, words });
    }
    if (!lessons.length) throw unusable(taskId, 'anything usable from that material');
    // "One lesson" is the learner's instruction, not a suggestion.
    if ((input?.split || 'one') === 'one' && lessons.length > 1) lessons = [mergeLessons(lessons)];
    lessons = lessons.slice(0, LESSONS_MAX);
    const fallback = str(input?.title) || 'Untitled lesson';
    lessons.forEach(({ lesson }, i) => {
      if (!lesson.title) lesson.title = lessons.length > 1 ? `${fallback} · ${i + 1}` : fallback;
    });
    return { lessons };
  }

  if (taskId === 'suggest') {
    if (!Array.isArray(json.items)) throw unusable(taskId, 'a list of words (no "items" key)');
    const knownSet = knownSetOf(input?.known);
    const count = Math.max(1, Math.min(20, Number(input?.count) || 5));
    const seen = new Set();
    const items = [];
    for (const raw of json.items) {
      const w = normaliseWordDraft(raw, { knownSet, english });
      // The model was told not to suggest what the learner knows; enforce it.
      if (!w || w.isKnown || seen.has(w.hanzi)) continue;
      seen.add(w.hanzi);
      items.push({
        hanzi: w.hanzi,
        pinyin: w.pinyin,
        zhuyin: w.zhuyin,
        meaning: w.meaning,
        meaningNative: w.meaningNative,
        pos: w.pos,
        why: str(raw?.why ?? raw?.reason),
        example: exampleList(raw?.example ?? raw?.examples, 1)[0] || null,
        tags: w.tags,
        status: 'open',
        wordId: null,
      });
      if (items.length >= count) break;
    }
    return { items };
  }

  if (taskId === 'enrich') {
    const { pinyin, zhuyin } = readings(json.pinyin, json.zhuyin);
    const result = {
      pinyin,
      zhuyin,
      meaning: str(json.meaning ?? json.english),
      meaningNative: secondMeaning(json.meaningNative, json.meaning ?? json.english, english),
      pos: oneOf(json.pos, POS, str(input?.word?.pos) || ''),
      type: oneOf(json.type, WORD_TYPES, str(input?.word?.type) || 'word'),
      examples: exampleList(json.examples ?? json.example),
      notes: str(json.notes ?? json.note),
    };
    if (!result.pinyin && !result.zhuyin && !result.meaning && !result.examples.length) {
      throw unusable(taskId, 'anything to add to that word');
    }
    return result;
  }

  if (taskId === 'explain') {
    const answer = str(json.answer ?? json.text ?? json.explanation);
    if (!answer) throw unusable(taskId, 'an answer');
    return { answer };
  }

  if (taskId === 'reading') {
    const p = isPlain(json.passage) ? json.passage : {};
    const zh = str(p.zh ?? p.text ?? p.chinese);
    if (!zh) throw unusable(taskId, 'a passage');
    const { pinyin, zhuyin } = readings(p.pinyin, p.zhuyin);
    const questions = [];
    for (const raw of Array.isArray(json.questions) ? json.questions : []) {
      const q = str(raw?.q ?? raw?.question);
      const options = (Array.isArray(raw?.options) ? raw.options : []).map(str).filter(Boolean).slice(0, 4);
      const answerIndex = Number.parseInt(raw?.answerIndex ?? raw?.answer_index ?? raw?.answer, 10);
      // A question with three options or an out-of-range answer is not fixable
      // without guessing, and guessing here teaches the learner a wrong fact.
      if (!q || options.length !== 4 || !Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3) continue;
      questions.push({ q, options, answerIndex });
      if (questions.length >= 4) break;
    }
    return {
      title: str(json.title) || 'Short reading',
      passage: { zh, pinyin, zhuyin, translation: str(p.translation ?? p.english) },
      questions,
    };
  }

  throw unusable(taskId, 'a result');
}

function sectionList(value) {
  const out = [];
  for (const raw of Array.isArray(value) ? value : []) {
    if (!isPlain(raw)) continue;
    const section = {
      kind: oneOf(raw.kind, SECTION_KINDS, 'text'),
      title: str(raw.title),
      titleZh: str(raw.titleZh ?? raw.title_zh),
      body: bodyText(raw.body ?? raw.text ?? raw.content),
    };
    if (!section.title && !section.body) continue;
    out.push(section);
    if (out.length >= SECTIONS_CAP) break;
  }
  return out;
}

/* A section body should be text; some models answer with an array of lines or a
   nested object. Flatten instead of throwing the lesson away. */
function bodyText(value) {
  if (Array.isArray(value)) return value.map((v) => bodyText(v)).filter(Boolean).join('\n');
  if (isPlain(value)) return Object.values(value).map((v) => bodyText(v)).filter(Boolean).join('\n');
  return str(value);
}

function grammarList(value) {
  const out = [];
  for (const raw of Array.isArray(value) ? value : []) {
    if (!isPlain(raw)) continue;
    const pattern = str(raw.pattern ?? raw.structure ?? raw.title);
    const explanation = str(raw.explanation ?? raw.note ?? raw.description);
    if (!pattern && !explanation) continue;
    out.push({ pattern, explanation, examples: exampleList(raw.examples ?? raw.example) });
  }
  return out;
}

function dialogueList(value) {
  const out = [];
  for (const raw of Array.isArray(value) ? value : []) {
    if (!isPlain(raw)) continue;
    const zh = str(raw.zh ?? raw.line ?? raw.chinese);
    if (!zh) continue;
    const { pinyin, zhuyin } = readings(raw.pinyin, raw.zhuyin);
    out.push({
      speaker: str(raw.speaker ?? raw.name ?? raw.role) || String.fromCharCode(65 + (out.length % 2)),
      zh,
      pinyin,
      zhuyin,
      translation: str(raw.translation ?? raw.english),
    });
  }
  return out;
}

function isEnglishCode(code) {
  return !code || String(code).trim().toLowerCase().startsWith('en');
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}
