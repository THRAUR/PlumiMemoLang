/* server/ai/tasks.js — no network: globalThis.fetch is stubbed with canned
   OpenRouter completions. The point of these tests is the layer around the
   model: routing, the human no-key error, normalisation (readings, dedupe,
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

const { TASKS, TASK_IDS, resolveModel, resolveApiKey, hasApiKey, runTask } = await import('../server/ai/tasks.js');
const { coll, doc, flushAll } = await import('../server/store.js');
const { pinyinToZhuyin, zhuyinToPinyin } = await import('../shared/zhuyin.js');

const usage = coll('usage');
const cache = doc('models-cache', {});
const realFetch = globalThis.fetch;
const KEY = 'sk-or-v1-abcdef1234';

// chat() reads this cache to decide how to ask for JSON; warm it so the
// extract call takes the json_schema path.
cache.set(() => ({
  fetchedAt: new Date().toISOString(),
  models: [
    { id: 'test/extract', name: 'Extractor', pricing: { prompt: 0.000003, completion: 0.000015, image: 0 }, supportsStructured: true, supportsJson: true, inputModalities: ['text', 'image'], contextLength: 200000, created: 0 },
    { id: 'test/default', name: 'Default', pricing: { prompt: 0.000001, completion: 0.000002, image: 0 }, supportsStructured: false, supportsJson: true, inputModalities: ['text'], contextLength: 128000, created: 0 },
  ],
}));

after(() => { globalThis.fetch = realFetch; return flushAll(); });

const SETTINGS = {
  nativeLanguage: 'fr',
  level: 'intermediate',
  script: 'zhuyin',
  ai: { apiKey: KEY, models: { default: 'test/default', extract: 'test/extract' } },
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

function completion(payload, { model = 'test/extract', cost = 0.0042 } = {}) {
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

test('resolveModel routes per task and falls back to the default', () => {
  assert.equal(resolveModel(SETTINGS, 'extract'), 'test/extract');
  assert.equal(resolveModel(SETTINGS, 'suggest'), 'test/default', 'an empty per-task model means "use the default"');
  assert.equal(resolveModel(SETTINGS, 'test'), 'test/default', 'the connection test has no model of its own');
  assert.equal(resolveModel({}, 'extract'), 'anthropic/claude-sonnet-4.5', 'the shipped default');
  assert.equal(resolveModel(undefined, 'extract'), 'anthropic/claude-sonnet-4.5');
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

  assert.equal(body.model, 'test/extract', 'extract uses its own model');
  assert.equal(body.temperature, 0.2);
  assert.deepEqual(body.usage, { include: true });
  assert.equal(body.response_format.type, 'json_schema', 'the cached model supports structured outputs');
  assert.equal(body.response_format.json_schema.name, 'extract');
  assert.equal(body.response_format.json_schema.strict, true);
  const schema = body.response_format.json_schema.schema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['lesson', 'words']);
  assert.deepEqual(schema.properties.words.items.required, [
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

  // ── lesson
  assert.equal(result.lesson.title, 'Ordering food', 'trimmed');
  assert.equal(result.lesson.titleZh, '點餐');
  assert.equal(result.lesson.summary, 'What to say in a restaurant.');
  assert.equal(result.lesson.sections.length, 2, 'the empty section is dropped');
  assert.equal(result.lesson.sections[0].body, '- 點餐\n- 買單', 'an array body is flattened to text');
  assert.equal(result.lesson.sections[1].kind, 'text', 'an unknown kind falls back to text');
  assert.equal(result.lesson.grammar.length, 1);
  assert.equal(result.lesson.grammar[0].pattern, '要 + noun');
  assert.equal(result.lesson.grammar[0].examples.length, 3, 'examples are capped at 3');
  assert.equal(result.lesson.dialogue.length, 1);
  assert.equal(result.lesson.dialogue[0].speaker, 'A', 'a missing speaker is filled in');

  // ── words
  assert.deepEqual(result.words.map((w) => w.hanzi), ['謝謝', '你好', '點餐']);
  assert.deepEqual(Object.keys(result.words[0]), [
    'hanzi', 'pinyin', 'zhuyin', 'meaning', 'meaningNative', 'pos', 'type', 'examples', 'notes', 'tags', 'isKnown',
  ], 'exactly the WordDraft keys, nothing the model invented');

  const [xiexie, nihao, diancan] = result.words;
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
  assert.equal(result.lesson.dialogue[0].zhuyin, pinyinToZhuyin('nǐ yào shén me'));

  // ── accounting
  assert.equal(model, 'test/extract');
  assert.deepEqual(reported, { promptTokens: 900, completionTokens: 300, totalTokens: 1200, cost: 0.0042 });
  const rows = usageSince(before);
  assert.equal(rows.length, 1, 'exactly one usage row per call');
  assert.equal(rows[0].task, 'extract');
  assert.equal(rows[0].model, 'test/extract');
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
});

test('runTask says so when the model returns the wrong shape', async (t) => {
  stubFetch(t, completion({ foo: 1 }));
  const before = usage.all().length;
  await assert.rejects(
    () => runTask('extract', EXTRACT_INPUT, { settings: SETTINGS }),
    (e) => {
      assert.match(e.message, /did not return a lesson/);
      assert.match(e.message, /Notes → lesson/, 'the message names the task to re-route in Settings');
      return true;
    },
  );
  const rows = usageSince(before);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, false, 'the tokens were still spent');
  assert.equal(rows[0].promptTokens, 900);
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
  }, { model: 'test/default' }));

  const { result, model } = await runTask('suggest', {
    known: ['你好', '謝謝'],
    level: 'beginner',
    recentTopics: ['Greetings', 'Ordering food'],
    count: 2,
    nativeLanguage: 'en',
  }, { settings: SETTINGS });

  assert.equal(model, 'test/default', 'suggest has no model of its own, so it uses the default');
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
  }, { model: 'test/default' }));

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
    completion({ answer: '  **謝謝** is the everyday thank-you.  ' }, { model: 'test/default' }),
    completion({
      pinyin: ' xiè xie ', meaning: ' thank you ', meaningNative: ' merci ', pos: 'v', type: 'word',
      examples: [EXAMPLE('謝謝你。'), EXAMPLE('謝謝!'), EXAMPLE('謝謝大家。'), EXAMPLE('太謝謝了。')],
      notes: ' Neutral tone on the second syllable. ', extra: 'ignored',
    }, { model: 'test/default' }),
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
  const calls = stubFetch(t, completion('你好!歡迎回來。(nǐ hǎo! huān yíng huí lái.)', { model: 'test/default' }));
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
  doc('settings', {}).set(() => ({ ai: { apiKey: KEY, models: { default: 'stored/model' } } }));
  const calls = stubFetch(t, completion('嗨!(hāi!)', { model: 'stored/model' }));
  const { result } = await runTask('test', {}, {});
  assert.equal(calls[0].body.model, 'stored/model');
  assert.equal(result.reply, '嗨!(hāi!)');
});
