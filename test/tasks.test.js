/* server/ai/tasks.js — no network: globalThis.fetch is stubbed with canned
   OpenRouter completions. The point of these tests is the layer around the
   model: the model chain and its fallback, the human no-key error, normalisation (readings, dedupe,
   isKnown, caps) and one usage row per call, success or failure. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'plumi-tasks-'));
process.env.MEMOLANG_DATA_DIR = TMP;
process.env.DATA_DIR = TMP;
delete process.env.OPENROUTER_API_KEY;        // so resolveApiKey() has only settings

const { TASKS, TASK_IDS, resolveChain, resolveModel, resolveApiKey, hasApiKey, runTask } = await import('../server/ai/tasks.js');
const { coll, doc, flushAll } = await import('../server/store.js');
const { pinyinToZhuyin, zhuyinToPinyin } = await import('../shared/zhuyin.js');

const usage = coll('usage');
const cache = doc('models-cache', {});
const realFetch = globalThis.fetch;
const KEY = 'sk-or-v1-abcdef1234';

const G35 = 'google/gemini-3.5-flash-lite';
const G31 = 'google/gemini-3.1-flash-lite';
const DS = 'deepseek/deepseek-v4-flash';
const G25 = 'google/gemini-2.5-flash-lite';

// chat() reads this cache to decide how to ask for JSON. Gemini 3.5 is marked as
// supporting structured outputs so extract takes the json_schema path, and
// DeepSeek only does json_object. The real catalog differs; these tests are
// about the request each path builds, not about the catalog.
cache.set(() => ({
  fetchedAt: new Date().toISOString(),
  models: [
    { id: G35, name: 'Google: Gemini 3.5 Flash Lite', pricing: { prompt: 0.0000003, completion: 0.0000025, image: 0 }, supportsStructured: true, supportsJson: true, inputModalities: ['text', 'image'], contextLength: 1048576, created: 0 },
    { id: DS, name: 'DeepSeek: DeepSeek V4 Flash 0423', pricing: { prompt: 0.000000048, completion: 0.000000095, image: 0 }, supportsStructured: false, supportsJson: true, inputModalities: ['text'], contextLength: 1048576, created: 0 },
  ],
}));

after(() => { globalThis.fetch = realFetch; return flushAll(); });

const SETTINGS = {
  nativeLanguage: 'fr',
  level: 'intermediate',
  script: 'zhuyin',
  // DeepSeek on top: a text task starts there, and a photo task shows the skip.
  ai: { apiKey: KEY, priority: [DS, G35, G31, G25] },
};

/* ── helpers ─────────────────────────────────────────────────────────────── */

function stubFetch(t, steps) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const i = calls.length;
    calls.push({
      url: String(url),
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : null,
      rawBody: init.body || '',
    });
    const step = Array.isArray(steps) ? steps[Math.min(i, steps.length - 1)] : steps;
    if (typeof step === 'function') return step(i, init);
    const { status = 200, body = {} } = step || {};
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  return calls;
}

function completion(payload, { model = G35, cost = 0.0042 } = {}) {
  return {
    status: 200,
    body: {
      id: 'gen-1',
      model,
      choices: [{ message: { role: 'assistant', content: typeof payload === 'string' ? payload : JSON.stringify(payload) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 900, completion_tokens: 300, total_tokens: 1200, cost },
    },
  };
}

function usageSince(n) { return usage.all().slice(n); }

const EXAMPLE = (zh) => ({ zh, pinyin: 'x', zhuyin: 'ㄒ', translation: zh });

/* ── the registry ────────────────────────────────────────────────────────── */

test('TASKS covers every task with an importance and a reason', () => {
  assert.deepEqual(TASK_IDS.sort(), ['enrich', 'explain', 'extract', 'reading', 'suggest', 'test']);
  const expected = { extract: 'high', suggest: 'medium', reading: 'medium', enrich: 'low', explain: 'low', test: 'low' };
  for (const [id, task] of Object.entries(TASKS)) {
    assert.equal(task.id, id);
    assert.equal(task.importance, expected[id], `${id} importance`);
    assert.ok(task.label.length, `${id} needs a label`);
    assert.ok(task.why.length > 20 && task.why.endsWith('.'), `${id} needs a one-line why`);
    assert.equal(typeof task.defaultTemperature, 'number');
  }
  assert.match(TASKS.extract.why, /learned/);
});

test('resolveChain walks the priority list, skips text-only models for photos, and stays on the allow-list', () => {
  assert.deepEqual(resolveChain(SETTINGS), [DS, G35, G31, G25]);
  assert.deepEqual(resolveChain(SETTINGS, { images: true }), [G35, G31, G25], 'DeepSeek cannot read photos');
  assert.deepEqual(resolveChain(SETTINGS, { prefer: G25 }), [G25, DS, G35, G31], 'a one-off pick goes first; the rest stays behind it');
  assert.deepEqual(
    resolveChain({ ai: { priority: ['anthropic/claude-sonnet-4.5', G31] } }),
    [G31, G35, DS, G25],
    'an id off the list is dropped, and the missing allowed models are appended',
  );
  assert.deepEqual(resolveChain({}), [G35, G31, DS, G25], 'the recommended order');
  assert.equal(resolveModel(SETTINGS, 'suggest'), DS);
  assert.equal(resolveModel(SETTINGS, 'extract', { images: true }), G35);
  assert.equal(resolveModel(undefined, 'extract'), G35, 'no settings at all still lands on an allowed model');
});

test('resolveApiKey prefers the learner\'s key and says where to paste one', () => {
  assert.equal(resolveApiKey(SETTINGS), KEY);
  assert.equal(hasApiKey(SETTINGS), true);
  assert.equal(hasApiKey({}), false);
  assert.throws(() => resolveApiKey({ ai: { apiKey: '' } }), (e) => {
    assert.equal(e.message, 'Add your OpenRouter API key in Settings first.');
    return true;
  });
});

test('runTask refuses to call without a key, and logs nothing', async () => {
  const before = usage.all().length;
  await assert.rejects(
    () => runTask('test', {}, { settings: { ai: { apiKey: '' } } }),
    /^Error: Add your OpenRouter API key in Settings first\.$/,
  );
  assert.equal(usage.all().length, before, 'no call, no usage row');
  await assert.rejects(() => runTask('nonsense', {}, { settings: SETTINGS }), /Unknown AI task: nonsense/);
});

/* ── extract ─────────────────────────────────────────────────────────────── */

const EXTRACT_ANSWER = {
  lesson: {
    title: '  Ordering food  ',
    titleZh: ' 點餐 ',
    summary: '  What to say in a restaurant.  ',
    sections: [
      { kind: 'vocab', title: ' Words ', body: ['- 點餐', '- 買單'] },     // array body → flattened
      { kind: 'nonsense', title: '', body: 'Waiters say 內用還是外帶?' },   // unknown kind → text
      { kind: 'tip', title: '', body: '   ' },                             // nothing in it → dropped
    ],
    grammar: [
      { pattern: ' 要 + noun ', explanation: '  to want something  ', examples: [EXAMPLE('我要這個。'), EXAMPLE('他要水。'), EXAMPLE('你要什麼?'), EXAMPLE('我要買單。')] },
      { pattern: '', explanation: '' },                                    // empty → dropped
    ],
    dialogue: [
      { speaker: '', zh: ' 你要什麼? ', pinyin: ' nǐ yào shén me ', translation: 'What would you like?' },
      { zh: '' },                                                          // no line → dropped
    ],
  },
  words: [
    {
      hanzi: ' 謝謝 ', pinyin: ' xiè xie ', meaning: ' thank you ', meaningNative: ' merci ',
      pos: 'v', type: 'word', tags: 'greeting, Polite',
      examples: [EXAMPLE('謝謝!'), EXAMPLE('謝謝你。'), EXAMPLE('真謝謝你。'), EXAMPLE('謝謝大家。')],
      isKnown: true,                                                       // the model is wrong; knownHanzi decides
    },
    { hanzi: '謝謝', meaning: '', notes: ' very common ', tags: ['manners'], examples: [EXAMPLE('謝謝老師。')] },
    { hanzi: '你好', pinyin: 'nǐ hǎo', meaning: 'hello', isKnown: false },   // in knownHanzi → true
    { hanzi: '   ', meaning: 'junk with no characters' },                   // dropped
    { hanzi: '點餐', zhuyin: 'ㄉㄧㄢˇ ㄘㄢ', meaning: 'to order food', type: 'phrase', pos: 'not-a-pos' },
    'a bare string, not an object',
  ],
};

const LONG_NOTES = `點餐 order food\n${'補充 '.repeat(14000)}`;   // > 40,000 chars

const EXTRACT_INPUT = {
  title: 'Class 12',
  classDate: '2026-09-11',
  text: LONG_NOTES,
  images: [{ dataUrl: 'data:image/jpeg;base64,AAAA' }, { dataUrl: 'not-an-image' }],
  learner: { nativeLanguage: 'fr', level: 'intermediate', script: 'zhuyin' },
  knownHanzi: ['你好', '  ', '你好'],
};

test('runTask extract builds the request the contract asks for', async (t) => {
  const calls = stubFetch(t, completion(EXTRACT_ANSWER));
  const progress = [];
  await runTask('extract', EXTRACT_INPUT, { settings: SETTINGS, onProgress: (p) => progress.push(p) });

  const { body, rawBody, headers } = calls[0];
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
  assert.ok(!rawBody.includes(KEY), 'the key is a header, never part of the prompt');

  assert.equal(body.model, G35, 'photos skip DeepSeek, the text-only model at the top of the list');
  assert.equal(body.temperature, 0.2);
  assert.deepEqual(body.usage, { include: true });
  assert.equal(body.response_format.type, 'json_schema', 'the cached model supports structured outputs');
  assert.equal(body.response_format.json_schema.name, 'extract');
  assert.equal(body.response_format.json_schema.strict, true);
  const schema = body.response_format.json_schema.schema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['lessons'], 'one source can become several lessons');
  assert.deepEqual(schema.properties.lessons.items.required, ['lesson', 'words']);
  assert.deepEqual(schema.properties.lessons.items.properties.words.items.required, [
    'hanzi', 'pinyin', 'zhuyin', 'meaning', 'meaningNative', 'pos', 'type', 'examples', 'notes', 'tags', 'isKnown',
  ]);

  // system + user
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /Traditional characters ONLY/);
  assert.match(body.messages[0].content, /ㄒㄧㄝˋ ˙ㄒㄧㄝ/, 'the zhuyin convention is spelled out');
  assert.match(body.messages[0].content, /French/, 'meaningNative is asked for in the learner\'s language');
  assert.match(body.messages[0].content, /JSON only/);

  // The user turn carries the photos as image_url parts.
  const parts = body.messages[1].content;
  assert.ok(Array.isArray(parts));
  assert.equal(parts[0].type, 'text');
  assert.equal(parts[1].type, 'image_url');
  assert.equal(parts[1].image_url.url, 'data:image/jpeg;base64,AAAA');
  assert.equal(parts.length, 2, 'the entry that is not an image is dropped');

  const text = parts[0].text;
  assert.match(text, /Class 12/);
  assert.match(text, /2026-09-11/);
  assert.match(text, /intermediate/);
  assert.match(text, /longer than 40,000 characters/, 'truncation is admitted');
  assert.ok(text.length < LONG_NOTES.length + 6000, 'the notes were actually cut');
  assert.match(text, /Words the learner already knows[^\n]*:\n你好/, 'the known list is compact and deduped');
  assert.match(text, /transcribe what it contains/i);

  assert.ok(progress.length >= 1, 'the job gets something to show');
  assert.match(progress[0], /notes/i);
});

test('runTask extract normalises what comes back', async (t) => {
  stubFetch(t, completion(EXTRACT_ANSWER));
  const before = usage.all().length;
  const { result, usage: reported, model } = await runTask('extract', EXTRACT_INPUT, { settings: SETTINGS });
  // EXTRACT_ANSWER is the old single-lesson shape: a model that answers it still
  // gives one usable lesson.
  assert.equal(result.lessons.length, 1);
  const draft = result.lessons[0];

  // ── lesson
  assert.equal(draft.lesson.title, 'Ordering food', 'trimmed');
  assert.equal(draft.lesson.titleZh, '點餐');
  assert.equal(draft.lesson.summary, 'What to say in a restaurant.');
  assert.equal(draft.lesson.sections.length, 2, 'the empty section is dropped');
  assert.equal(draft.lesson.sections[0].body, '- 點餐\n- 買單', 'an array body is flattened to text');
  assert.equal(draft.lesson.sections[1].kind, 'text', 'an unknown kind falls back to text');
  assert.equal(draft.lesson.grammar.length, 1);
  assert.equal(draft.lesson.grammar[0].pattern, '要 + noun');
  assert.equal(draft.lesson.grammar[0].examples.length, 3, 'examples are capped at 3');
  assert.equal(draft.lesson.dialogue.length, 1);
  assert.equal(draft.lesson.dialogue[0].speaker, 'A', 'a missing speaker is filled in');

  // ── words
  assert.deepEqual(draft.words.map((w) => w.hanzi), ['謝謝', '你好', '點餐']);
  assert.deepEqual(Object.keys(draft.words[0]), [
    'hanzi', 'pinyin', 'zhuyin', 'meaning', 'meaningNative', 'pos', 'type', 'examples', 'notes', 'tags', 'isKnown',
  ], 'exactly the WordDraft keys, nothing the model invented');

  const [xiexie, nihao, diancan] = draft.words;
  assert.equal(xiexie.meaning, 'thank you');
  assert.equal(xiexie.meaningNative, 'merci', 'kept: the learner is not working in English');
  assert.equal(xiexie.notes, 'very common', 'the duplicate filled in what the first entry was missing');
  assert.deepEqual(xiexie.tags, ['greeting', 'polite', 'manners'], 'a "a, b" string becomes lowercase tags, merged');
  assert.equal(xiexie.examples.length, 3, 'capped at 3 across the merge');
  assert.equal(xiexie.isKnown, false, 'knownHanzi decides, not the model');
  assert.equal(nihao.isKnown, true);
  assert.equal(diancan.type, 'phrase');
  assert.equal(diancan.pos, '', 'a part of speech outside the contract is cleared');
  assert.equal(diancan.zhuyin, 'ㄉㄧㄢˇ ㄘㄢ', 'a reading the model gave is kept');

  // Readings are filled through shared/zhuyin.js. That module is being written
  // by another agent and its stub returns "" — an empty reading must stay empty
  // rather than blow up, so this asserts the wiring, whatever it returns today.
  assert.equal(xiexie.zhuyin, pinyinToZhuyin('xiè xie'), 'zhuyin comes from the pinyin');
  assert.equal(diancan.pinyin, zhuyinToPinyin('ㄉㄧㄢˇ ㄘㄢ'), 'and pinyin from the zhuyin');
  assert.equal(typeof xiexie.zhuyin, 'string');
  assert.equal(draft.lesson.dialogue[0].zhuyin, pinyinToZhuyin('nǐ yào shén me'));

  // ── accounting
  assert.equal(model, G35);
  assert.deepEqual(reported, { promptTokens: 900, completionTokens: 300, totalTokens: 1200, cost: 0.0042 });
  const rows = usageSince(before);
  assert.equal(rows.length, 1, 'exactly one usage row per call');
  assert.equal(rows[0].task, 'extract');
  assert.equal(rows[0].model, G35);
  assert.equal(rows[0].promptTokens, 900);
  assert.equal(rows[0].completionTokens, 300);
  assert.equal(rows[0].cost, 0.0042, 'the cost OpenRouter reported, not an estimate');
  assert.equal(rows[0].ok, true);
  assert.equal(rows[0].error, null);
  assert.ok(typeof rows[0].ms === 'number');
  assert.ok(Date.parse(rows[0].at) > 0);
  assert.ok(!JSON.stringify(rows[0]).includes(KEY), 'the usage log never holds the key');
});

test('runTask logs the failure too, with a human message', async (t) => {
  stubFetch(t, { status: 402, body: { error: { message: 'insufficient credits', code: 402 } } });
  const before = usage.all().length;
  await assert.rejects(
    () => runTask('extract', EXTRACT_INPUT, { settings: SETTINGS }),
    (e) => {
      assert.equal(e.message, 'Your OpenRouter account is out of credits.');
      return true;
    },
  );
  const rows = usageSince(before);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, false);
  assert.equal(rows[0].error, 'Your OpenRouter account is out of credits.');
  assert.equal(rows[0].cost, 0, 'always a number, so /api/usage can sum the column');
  assert.equal(rows[0].task, 'extract');
  assert.equal(rows[0].model, G35, 'an empty balance is empty for every model, so nothing else was tried');
});

test('runTask moves down the list when a model fails, and says so', async (t) => {
  const calls = stubFetch(t, [
    { status: 503, body: { error: { message: 'provider down', code: 503 } } },
    completion({ answer: 'Say it to thank anyone.' }, { model: G35 }),
  ]);
  const progress = [];
  const before = usage.all().length;
  const out = await runTask('explain', { word: { hanzi: '謝謝' }, question: 'When?' }, { settings: SETTINGS, onProgress: (p) => progress.push(p) });

  assert.deepEqual(calls.map((c) => c.body.model), [DS, G35], 'the second model on the list took over');
  assert.equal(out.model, G35);
  assert.deepEqual(out.result, { answer: 'Say it to thank anyone.' });
  assert.deepEqual(out.fallbacks.map((f) => f.model), [DS]);
  assert.match(out.fallbacks[0].error, /status 503/);
  assert.ok(progress.includes('DeepSeek V4 Flash 0423 failed. Trying Gemini 3.5 Flash Lite…'), 'the job says what is happening');
  assert.deepEqual(usageSince(before).map((r) => [r.model, r.ok]), [[DS, false], [G35, true]], 'one usage row per attempt');
});

test('runTask stops at once when every model would fail the same way', async (t) => {
  const calls = stubFetch(t, { status: 401, body: { error: { message: 'No auth credentials found', code: 401 } } });
  const before = usage.all().length;
  await assert.rejects(
    () => runTask('explain', { word: { hanzi: '謝謝' } }, { settings: SETTINGS }),
    /rejected the API key/,
  );
  assert.equal(calls.length, 1, 'a bad key is bad for every model: one call, not four');
  assert.equal(usageSince(before).length, 1);
});

test('runTask with `only` tries exactly one model, and refuses models off the list', async (t) => {
  const calls = stubFetch(t, { status: 404, body: { error: { message: 'Not found', code: 404 } } });
  await assert.rejects(() => runTask('test', {}, { settings: SETTINGS, prefer: G31, only: true }), /not found/);
  assert.deepEqual(calls.map((c) => c.body.model), [G31], 'a model under test gets no backup');
  await assert.rejects(
    () => runTask('test', {}, { settings: SETTINGS, prefer: 'anthropic/claude-sonnet-4.5' }),
    /not on the allowed model list/,
  );
  assert.equal(calls.length, 1, 'a model off the list never reaches OpenRouter');
});

test('runTask names every model it tried when they all fail', async (t) => {
  stubFetch(t, completion({ foo: 1 }));
  const before = usage.all().length;
  await assert.rejects(
    () => runTask('extract', EXTRACT_INPUT, { settings: SETTINGS }),
    (e) => {
      assert.match(e.message, /^Every model on your list failed \(Gemini 3\.5 Flash Lite, Gemini 3\.1 Flash Lite, Gemini 2\.5 Flash Lite\)\./);
      assert.match(e.message, /did not return any lessons/, 'and keeps the last reason');
      return true;
    },
  );
  const rows = usageSince(before);
  assert.deepEqual(rows.map((r) => r.model), [G35, G31, G25], 'photo notes never touch the text-only model');
  assert.ok(rows.every((r) => r.ok === false && r.promptTokens === 900), 'every attempt spent tokens and is logged');
});

test('runTask extract turns one source into several lessons and follows the split rule', async (t) => {
  const two = {
    lessons: [
      {
        lesson: { title: 'At the café', titleZh: '在咖啡店', summary: 'Ordering coffee.', sections: [{ kind: 'dialogue', title: 'Dialogue', body: 'A: 你好' }], grammar: [], dialogue: [] },
        words: [{ hanzi: '咖啡', pinyin: 'kā fēi', meaning: 'coffee' }, { hanzi: '糖', pinyin: 'táng', meaning: 'sugar' }],
      },
      {
        lesson: { title: '', titleZh: '問路', summary: 'Asking the way.', sections: [{ kind: 'vocab', title: 'Words', body: '- 右轉' }], grammar: [], dialogue: [] },
        words: [{ hanzi: '右轉', pinyin: 'yòu zhuǎn', meaning: 'turn right' }],
      },
    ],
  };
  const calls = stubFetch(t, [completion(two), completion(two)]);
  const doc = {
    title: 'Book',
    split: 'per-range',
    pages: [{ pdf: 3, printed: 2 }, { pdf: 4, printed: 3 }, { pdf: 6, printed: 5 }],
    instructions: 'Skip the exercises.',
    source: { title: 'Taiwan Mandarin' },
    images: [{ dataUrl: 'data:image/jpeg;base64,AAAA' }],
    knownHanzi: [],
  };
  const speaking = { ...SETTINGS, goals: { skills: ['speak', 'listen'], reasons: ['taiwan'], about: 'Classes with Carl.', onboardedAt: '2026-09-13T20:00:00Z' } };
  const { result } = await runTask('extract', doc, { settings: speaking });
  assert.equal(result.lessons.length, 2);
  assert.equal(result.lessons[1].lesson.title, 'Book · 2', 'a lesson without a title is numbered');
  assert.deepEqual(result.lessons[1].words.map((w) => w.hanzi), ['右轉']);

  const [system, user] = calls[0].body.messages;
  assert.match(system.content, /FOCUS: SPEAKING AND LISTENING/, 'the goals reach the model');
  assert.match(system.content, /Classes with Carl/);
  const text = user.content[0].text;
  assert.match(text, /lesson 1 = pages 2–3; lesson 2 = page 5/, 'one lesson per page range, in printed numbers');
  assert.match(text, /page 2 \(PDF page 3\)/);
  assert.match(text, /Skip the exercises/);
  assert.match(text, /learning to SPEAK/);

  // The learner asked for ONE lesson: the same answer is folded into one.
  const one = await runTask('extract', { ...doc, split: 'one' }, { settings: SETTINGS });
  assert.equal(one.result.lessons.length, 1);
  assert.deepEqual(one.result.lessons[0].words.map((w) => w.hanzi), ['咖啡', '糖', '右轉']);
  assert.equal(one.result.lessons[0].lesson.title, 'At the café');
  assert.equal(one.result.lessons[0].lesson.sections.length, 2);
});

/* ── suggest ─────────────────────────────────────────────────────────────── */

test('runTask suggest drops known words, dedupes, and sends only hanzi', async (t) => {
  const calls = stubFetch(t, completion({
    items: [
      { hanzi: '你好', pinyin: 'nǐ hǎo', meaning: 'hello', why: 'already known', example: EXAMPLE('你好。') },
      { hanzi: ' 早安 ', pinyin: 'zǎo ān', meaning: ' good morning ', meaningNative: 'bonjour', pos: 'expr', why: ' Said every day. ', example: EXAMPLE('早安!'), tags: ['greeting'] },
      { hanzi: '早安', pinyin: 'zǎo ān', meaning: 'duplicate' },
      { hanzi: '晚安', pinyin: 'wǎn ān', meaning: 'good night', why: 'The other half of the day.', example: EXAMPLE('晚安。') },
      { hanzi: '再見', pinyin: 'zài jiàn', meaning: 'goodbye', why: 'Too many.', example: EXAMPLE('再見。') },
    ],
  }, { model: DS }));

  const { result, model } = await runTask('suggest', {
    known: ['你好', '謝謝'],
    level: 'beginner',
    recentTopics: ['Greetings', 'Ordering food'],
    count: 2,
    nativeLanguage: 'en',
  }, { settings: SETTINGS });

  assert.equal(model, DS, 'a text task starts at the top of the list');
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' }, 'that model only does json_object');
  assert.equal(calls[0].body.temperature, 0.7);

  const prompt = calls[0].body.messages[1].content;
  assert.equal(typeof prompt, 'string');
  assert.match(prompt, /你好 謝謝/, 'the known list travels as bare hanzi');
  // Token budget: the known list is hanzi only — no serialised Word objects.
  assert.ok(!prompt.includes('srs') && !prompt.includes('"hanzi"'), 'no Word objects in the suggest prompt');
  assert.ok(prompt.length < 1200, 'the suggest prompt stays small');
  assert.match(prompt, /Greetings; Ordering food/);

  assert.deepEqual(result.items.map((i) => i.hanzi), ['早安', '晚安'], 'known + duplicate dropped, capped at count');
  assert.equal(result.items[0].meaning, 'good morning');
  assert.equal(result.items[0].why, 'Said every day.');
  assert.equal(result.items[0].status, 'open');
  assert.equal(result.items[0].wordId, null);
  assert.equal(result.items[0].example.zh, '早安!');
  assert.equal(result.items[0].meaningNative, '', 'nativeLanguage en means no meaningNative');
});

/* ── reading, explain, enrich, test ──────────────────────────────────────── */

test('runTask reading keeps only answerable questions and sends hanzi + meaning', async (t) => {
  const calls = stubFetch(t, completion({
    title: '  At the market  ',
    passage: { zh: '  我去市場買菜。  ', pinyin: 'wǒ qù shì chǎng mǎi cài', translation: 'I go to the market.' },
    questions: [
      { q: 'Where did I go?', options: ['market', 'school', 'home', 'office'], answerIndex: 0 },
      { q: 'Three options only', options: ['a', 'b', 'c'], answerIndex: 1 },
      { q: 'Out of range', options: ['a', 'b', 'c', 'd'], answerIndex: 9 },
      { q: '', options: ['a', 'b', 'c', 'd'], answerIndex: 0 },
      { q: 'Answer as a string', options: ['a', 'b', 'c', 'd'], answerIndex: '2' },
    ],
  }, { model: DS }));

  const { result } = await runTask('reading', {
    words: [{ hanzi: '市場', meaning: 'market', pinyin: 'shì chǎng', zhuyin: 'ㄕˋ ㄔㄤˇ', srs: { state: 'new' }, stats: { reviews: 0 } }],
    level: 'beginner',
  }, { settings: SETTINGS });

  const prompt = calls[0].body.messages[1].content;
  assert.match(prompt, /市場 \(market\)/);
  assert.ok(!prompt.includes('shì chǎng') && !prompt.includes('srs'), 'reading gets hanzi + meaning only');

  assert.equal(result.title, 'At the market');
  assert.equal(result.passage.zh, '我去市場買菜。');
  assert.equal(result.passage.zhuyin, pinyinToZhuyin('wǒ qù shì chǎng mǎi cài'));
  assert.deepEqual(result.questions.map((q) => q.q), ['Where did I go?', 'Answer as a string']);
  assert.equal(result.questions[1].answerIndex, 2, 'a numeric string is coerced');
  assert.equal(result.questions[0].options.length, 4);
});

test('runTask explain and enrich come back in the contract shape', async (t) => {
  stubFetch(t, [
    completion({ answer: '  **謝謝** is the everyday thank-you.  ' }, { model: DS }),
    completion({
      pinyin: ' xiè xie ', meaning: ' thank you ', meaningNative: ' merci ', pos: 'v', type: 'word',
      examples: [EXAMPLE('謝謝你。'), EXAMPLE('謝謝!'), EXAMPLE('謝謝大家。'), EXAMPLE('太謝謝了。')],
      notes: ' Neutral tone on the second syllable. ', extra: 'ignored',
    }, { model: DS }),
  ]);

  const explain = await runTask('explain', { word: { hanzi: '謝謝', pinyin: 'xiè xie' }, question: 'When do I use it?' }, { settings: SETTINGS });
  assert.deepEqual(explain.result, { answer: '**謝謝** is the everyday thank-you.' });

  const enrich = await runTask('enrich', { word: { hanzi: '謝謝' } }, { settings: SETTINGS });
  assert.deepEqual(Object.keys(enrich.result), ['pinyin', 'zhuyin', 'meaning', 'meaningNative', 'pos', 'type', 'examples', 'notes']);
  assert.equal(enrich.result.meaning, 'thank you');
  assert.equal(enrich.result.meaningNative, 'merci');
  assert.equal(enrich.result.examples.length, 3, 'capped at 3');
  assert.equal(enrich.result.zhuyin, pinyinToZhuyin('xiè xie'));
});

test('runTask test answers in plain text, no JSON required', async (t) => {
  const calls = stubFetch(t, completion('你好!歡迎回來。(nǐ hǎo! huān yíng huí lái.)', { model: DS }));
  const before = usage.all().length;
  const { result, usage: reported } = await runTask('test', {}, { settings: SETTINGS });

  assert.equal(calls[0].body.response_format, undefined, 'the connection test asks for a sentence, not JSON');
  assert.ok(!calls[0].body.messages[0].content.includes('JSON only'));
  assert.equal(result.reply, '你好!歡迎回來。(nǐ hǎo! huān yíng huí lái.)');
  assert.equal(reported.cost, 0.0042);
  assert.equal(usageSince(before)[0].task, 'test');
});

test('runTask falls back to the stored settings document', async (t) => {
  // A job can outlive the request that started it; settings must still resolve.
  doc('settings', {}).set(() => ({ ai: { apiKey: KEY, priority: [G25] } }));
  const calls = stubFetch(t, completion('嗨!(hāi!)', { model: G25 }));
  const { result } = await runTask('test', {}, {});
  assert.equal(calls[0].body.model, G25, 'the stored order, completed with the rest of the list');
  assert.equal(result.reply, '嗨!(hāi!)');
});

/* ── the Claude plan: server/ai/claude-code.js against test/fixtures/fake-claude.mjs ── */

const { fileURLToPath } = await import('node:url');
const { resetClaudeCache } = await import('../server/ai/claude-code.js');
const { aiReady } = await import('../server/ai/tasks.js');
const PLAN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'plumi-tasks-home-'));
const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const SONNET = 'claude-code:sonnet';
const HAIKU = 'claude-code:haiku';
const ASK = { word: { hanzi: '謝謝' }, question: 'When?' };

/* The fake reads what to answer from $HOME, the one variable the app passes on
   besides USER, LOGNAME, LANG and PATH. */
function usePlan(scenario) {
  process.env.HOME = PLAN_HOME;
  process.env.MEMOLANG_CLAUDE_BIN = FAKE_CLAUDE;
  fs.chmodSync(FAKE_CLAUDE, 0o755);
  fs.writeFileSync(path.join(PLAN_HOME, 'fake-claude.json'), JSON.stringify(scenario));
  fs.rmSync(path.join(PLAN_HOME, 'fake-claude-calls.jsonl'), { force: true });
  resetClaudeCache();
}
function planCalls() {
  try {
    return fs.readFileSync(path.join(PLAN_HOME, 'fake-claude-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
after(() => fs.rmSync(PLAN_HOME, { recursive: true, force: true }));

test('a Claude plan model answers first, needs no key, and is logged as included', async (t) => {
  usePlan({ structured: { answer: 'Say it to thank anyone.' } });
  const calls = stubFetch(t, completion({ answer: 'OpenRouter must not be asked.' }));
  const before = usage.all().length;
  const settings = { ...SETTINGS, ai: { apiKey: '', priority: [SONNET, G35] } };
  assert.equal(aiReady(settings), true, 'the plan alone is enough');

  const out = await runTask('explain', ASK, { settings });
  assert.equal(out.model, SONNET);
  assert.deepEqual(out.result, { answer: 'Say it to thank anyone.' });
  assert.equal(calls.length, 0, 'no OpenRouter call, and no key needed');

  const [call] = planCalls();
  assert.equal(call.argv[call.argv.indexOf('--model') + 1], 'sonnet');
  assert.ok(call.argv.includes('--json-schema'), 'the task schema goes along');
  assert.match(call.system, /Traditional characters ONLY/, 'the same teacher prompt as OpenRouter gets');

  const [row] = usageSince(before);
  assert.equal(row.provider, 'claude-code');
  assert.equal(row.model, SONNET);
  assert.equal(row.cost, 0, 'included in the plan');
  assert.equal(row.included, true);
  assert.equal(row.listCost, 0.0123, 'what it would have cost at API prices');
  assert.equal(row.ok, true);
});

test('a plan at its usage limit hands over to OpenRouter and skips the other plan models', async (t) => {
  usePlan({ mode: 'limit' });
  const calls = stubFetch(t, completion({ answer: 'From Gemini.' }, { model: G35 }));
  const progress = [];
  const before = usage.all().length;
  const settings = { ...SETTINGS, ai: { apiKey: KEY, priority: [SONNET, HAIKU, G35] } };

  const out = await runTask('explain', ASK, { settings, onProgress: (p) => progress.push(p) });
  assert.equal(out.model, G35);
  assert.equal(planCalls().length, 1, 'Haiku runs on the same plan, so it is not tried');
  assert.deepEqual(calls.map((c) => c.body.model), [G35]);
  assert.deepEqual(out.fallbacks.map((f) => f.model), [SONNET]);
  assert.match(out.fallbacks[0].error, /usage limit/);
  assert.ok(progress.includes('Claude Sonnet failed. Trying Gemini 3.5 Flash Lite…'), 'the job says what is happening');
  assert.deepEqual(usageSince(before).map((r) => [r.model, r.ok, r.provider]), [[SONNET, false, 'claude-code'], [G35, true, 'openrouter']]);
});

test('a rejected OpenRouter key skips OpenRouter, and a plan model lower on the list still answers', async (t) => {
  usePlan({ structured: { answer: 'From the plan.' } });
  const calls = stubFetch(t, { status: 401, body: { error: { message: 'No auth credentials found', code: 401 } } });
  const settings = { ...SETTINGS, ai: { apiKey: KEY, priority: [DS, G35, HAIKU] } };
  const out = await runTask('explain', ASK, { settings });
  assert.equal(out.model, HAIKU);
  assert.deepEqual(calls.map((c) => c.body.model), [DS], 'one rejected call, not one per OpenRouter model');
});

test('without Claude Code the plan says so, and nothing else is tried without a key', async (t) => {
  usePlan({});
  process.env.MEMOLANG_CLAUDE_BIN = path.join(PLAN_HOME, 'no-claude-here');
  resetClaudeCache();
  const calls = stubFetch(t, completion({ answer: 'never' }));
  const settings = { ...SETTINGS, ai: { apiKey: '', priority: [SONNET] } };
  assert.equal(aiReady(settings), false);
  await assert.rejects(() => runTask('explain', ASK, { settings }), /Claude Code is not installed/);
  assert.equal(calls.length, 0);
  assert.equal(aiReady({ ai: { apiKey: '', priority: [G35] } }), false, 'no key and no plan: nothing can answer');
  assert.equal(aiReady({ ai: { apiKey: KEY } }), true);
});

test('photo notes reach a plan model as image blocks, and `only` tests one plan model', async (t) => {
  usePlan({ structured: EXTRACT_ANSWER });
  stubFetch(t, completion({ never: true }));
  const settings = { ...SETTINGS, ai: { apiKey: KEY, priority: [DS, SONNET] } };
  const { model, result } = await runTask('extract', EXTRACT_INPUT, { settings });
  assert.equal(model, SONNET, 'the text-only model at the top is skipped for photos');
  assert.equal(result.lessons.length, 1);
  assert.deepEqual(planCalls()[0].message.message.content.map((c) => c.type), ['text', 'image']);

  usePlan({ text: '你好!(nǐ hǎo!)' });
  const hello = await runTask('test', {}, { settings, prefer: HAIKU, only: true });
  assert.equal(hello.model, HAIKU);
  assert.equal(hello.result.reply, '你好!(nǐ hǎo!)');
  assert.ok(!planCalls()[0].argv.includes('--json-schema'), 'the connection test asks for a sentence, not JSON');
});

/* ── the explanation language ────────────────────────────────────────────── */

test('everything written for the learner follows "Explain things in", not English', async (t) => {
  const { buildMessages } = await import('../server/ai/prompts.js');
  const fr = { nativeLanguage: 'fr', level: 'beginner', script: 'pinyin', focus: 'speaking', goals: { skills: ['speak'] } };
  const [system, user] = buildMessages('extract', { title: 'Class', text: '謝謝 xiè xie = thank you' }, fr);
  assert.match(system.content, /The explanation language is French/);
  assert.match(system.content, /Nothing written for the learner stays in English/);
  assert.doesNotMatch(system.content, /titles: English/, 'the old always-English rule is gone');
  assert.match(system.content, /They read pinyin and French/);
  assert.match(user.content, /lesson\.title — French/);
  assert.match(user.content, /meaning in French/);
  assert.match(user.content, /meanings and explanations in English: write them in French instead/, 'English class notes are translated, not copied');
  assert.match(buildMessages('explain', { word: { hanzi: '謝謝' }, question: 'why?' }, fr)[1].content, /Answer in French/);
  const reading = buildMessages('reading', { words: [] }, fr)[1].content;
  assert.match(reading, /passage\.translation: French/);
  assert.match(reading, /questions in French/);
  const suggest = buildMessages('suggest', { known: [] }, fr)[1].content;
  assert.match(suggest, /meaning in French/);
  assert.match(suggest, /a translation in French/);

  const en = buildMessages('extract', { title: 'Class', text: '謝謝' }, { nativeLanguage: 'en' });
  assert.match(en[0].content, /The explanation language is English/);
  assert.doesNotMatch(en[0].content, /Nothing written for the learner stays in English/);
  assert.doesNotMatch(en[1].content, /write them in English instead/);

  // A model that copies the meaning into meaningNative anyway is not shown twice.
  stubFetch(t, completion({ pinyin: 'xiè xie', meaning: 'merci', meaningNative: ' Merci ', examples: [] }, { model: DS }));
  const enrich = await runTask('enrich', { word: { hanzi: '謝謝' } }, { settings: SETTINGS });
  assert.equal(enrich.result.meaning, 'merci');
  assert.equal(enrich.result.meaningNative, '', 'a copy of the meaning is dropped');
});
