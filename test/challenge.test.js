/* The local challenge builder (server/lib/challenge.js), on a small seeded pool:
   the speaking question types of §8.4 and the rules they rest on. The tone variants
   get the closest look, because a wrong "wrong answer" (a variant that is really a
   correct way to say the word) would teach the learner to distrust their ear. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import {
  buildQuestions, toneVariants, bareReading, readingsOf, QUESTION_TYPES, FOCI, countAnswers,
} from '../server/lib/challenge.js';
import {
  splitSyllables, marksToNumbers, numbersToMarks, normalizePinyin, pinyinToZhuyin, hanziChars,
} from '../shared/zhuyin.js';
import { CHALLENGE_TYPES, recommendedChallengeTypes } from '../shared/goals.js';

let serial = 0;
function word(hanzi, pinyin, meaning, pos, examples = [], { zhuyin, reviews = 0 } = {}) {
  serial += 1;
  return {
    id: `w${serial}`, hanzi, pinyin, zhuyin: zhuyin ?? pinyinToZhuyin(pinyin), meaning, pos, type: 'word',
    examples, stats: { reviews }, srs: { state: reviews ? 'review' : 'new', reps: reviews },
  };
}

/* Chosen to hit the edges: a neutral tone (謝謝), a third-tone pair (你好), 不, a
   neutral-only particle (的), homophones (是 / 事), ü (綠), a capital (臺灣), tone
   NUMBERS instead of marks (喝茶), a repeated syllable (涮涮鍋), a name that is not
   pinyin (Arthur), an example too short to order (沒事) and one with a digit (3點). */
const POOL = [
  word('謝謝', 'xiè xie', 'thank you', 'v', [{ zh: '謝謝你的幫忙。', pinyin: 'xiè xie nǐ de bāng máng', translation: 'Thanks for your help.' }], { reviews: 2 }),
  word('攝影', 'shè yǐng', 'photography', 'n', [{ zh: '我喜歡攝影。', pinyin: 'wǒ xǐ huān shè yǐng', translation: 'I like photography.' }], { reviews: 1 }),
  word('騎', 'qí', 'to ride', 'v', [{ zh: '我騎腳踏車。', pinyin: 'wǒ qí jiǎo tà chē', translation: 'I ride a bicycle.' }]),
  word('涮涮鍋', 'shuàn shuàn guō', 'hot pot', 'n', [{ zh: '冬天我們吃涮涮鍋。', pinyin: 'dōng tiān wǒ men chī shuàn shuàn guō', translation: 'In winter we eat hot pot.' }]),
  word('你好', 'nǐ hǎo', 'hello', 'expr', [{ zh: '你好，我是Arthur。', pinyin: 'nǐ hǎo, wǒ shì Arthur.', translation: 'Hello, I am Arthur.' }], { reviews: 3 }),
  word('不要', 'bù yào', 'do not want', 'v', [{ zh: '我不要咖啡。', pinyin: 'wǒ bù yào kā fēi.', translation: 'I do not want coffee.' }]),
  word('是', 'shì', 'to be', 'v', [{ zh: '他是老師。', pinyin: 'tā shì lǎo shī.', translation: 'He is a teacher.' }]),
  word('事', 'shì', 'matter', 'n', [{ zh: '沒事。', pinyin: 'méi shì', translation: 'It is nothing.' }]),
  word('的', 'de', 'possessive particle', 'part', []),
  word('臺灣', 'Tái wān', 'Taiwan', 'n', [{ zh: '臺灣有很多美食。', pinyin: 'Tái wān yǒu hěn duō měi shí.', translation: 'Taiwan has a lot of delicious food.' }]),
  word('綠', 'lǜ', 'green', 'adj', [{ zh: '樹是綠的。', pinyin: 'shù shì lǜ de', translation: 'Trees are green.' }]),
  word('喝茶', 'he1 cha2', 'to drink tea', 'v', [{ zh: '我喜歡喝茶。', pinyin: 'wǒ xǐ huān hē chá', translation: 'I like drinking tea.' }], { zhuyin: '' }),
  word('點', 'diǎn', "o'clock", 'mw', [{ zh: '我3點去。', pinyin: 'wǒ 3 diǎn qù.', translation: 'I go at three.' }]),
];
const byId = new Map(POOL.map((w) => [w.id, w]));
const TONE_MARKS = /[̀́̄̌]/;

const numbered = (reading) => splitSyllables(reading).map((s) => marksToNumbers(s).toLowerCase());

/* Every syllable is one real syllable with a tone, its mark sits where pinyin puts
   it, and the whole reading converts to 注音 without leftover letters. */
function assertValidMarks(reading) {
  for (const syl of splitSyllables(reading)) {
    const num = marksToNumbers(syl);
    assert.match(num, /^[a-zü]+[1-5]$/iu, `"${syl}" in "${reading}" is one syllable with a tone`);
    assert.equal(numbersToMarks(num), syl, `"${syl}" carries its tone mark on the right vowel`);
  }
  assert.doesNotMatch(pinyinToZhuyin(reading), /[a-z]/i, `"${reading}" converts to 注音`);
}

function build(types, { size = 12, seed = 'plumi', focus = null, pool = POOL } = {}) {
  return buildQuestions(pool, { size, types, focus, seed, script: 'pinyin' });
}

test('the question types are the shared list', () => {
  assert.deepEqual(QUESTION_TYPES, CHALLENGE_TYPES.map((t) => t.id));
  assert.deepEqual(FOCI, ['speaking', 'characters', 'balanced']);
});

test('tone variants: a different reading, the same letters, valid tone marks', () => {
  let checked = 0;
  for (const w of POOL) {
    const { pinyin } = readingsOf(w);
    const variants = toneVariants(w.pinyin, { hanzi: w.hanzi });
    assert.equal(new Set(variants.map((v) => normalizePinyin(v))).size, variants.length, `${w.hanzi}: no two variants alike`);
    for (const v of variants) {
      assert.notEqual(normalizePinyin(v), normalizePinyin(pinyin), `${v} is not ${pinyin}`);
      assert.equal(normalizePinyin(v, { tones: false }), normalizePinyin(pinyin, { tones: false }), `${v} spells the letters of ${pinyin}`);
      assertValidMarks(v);
      const a = numbered(pinyin);
      const b = numbered(v);
      assert.equal(a.length, b.length);
      const changed = a.map((s, i) => (s === b[i] ? -1 : i)).filter((i) => i >= 0);
      assert.equal(changed.length, 1, `${v} changes exactly one syllable of ${pinyin}`);
      assert.match(b[changed[0]], /[1-4]$/, 'a variant never invents a neutral tone');
      assert.match(a[changed[0]], /[1-4]$/, 'a neutral tone is never varied');
      checked += 1;
    }
  }
  assert.ok(checked > 20, 'the pool produced plenty of variants to check');
});

test('tone variants: the syllables whose tone is not a fixed fact never vary', () => {
  assert.deepEqual(toneVariants('qí', { hanzi: '騎' }).sort(), ['qī', 'qǐ', 'qì'].sort());
  assert.deepEqual(toneVariants('lǜ', { hanzi: '綠' }).sort(), ['lǖ', 'lǘ', 'lǚ'].sort());
  assert.deepEqual(toneVariants('de', { hanzi: '的' }), [], 'a neutral tone has nothing to vary');
  // 不 is said bú before a fourth tone, so bù / bú are both right: only 要 varies.
  const buyao = toneVariants('bù yào', { hanzi: '不要' });
  assert.ok(buyao.length === 3 && buyao.every((v) => v.startsWith('bù ')), JSON.stringify(buyao));
  // Without characters to align, a bu / yi syllable is still left alone.
  assert.ok(toneVariants('bù yào').every((v) => v.startsWith('bù ')));
  // 你好 is SAID ní hǎo: offering it as a wrong answer would punish a good ear.
  const nihao = toneVariants('nǐ hǎo', { hanzi: '你好' });
  assert.ok(!nihao.includes('ní hǎo'), JSON.stringify(nihao));
  assert.ok(nihao.includes('nī hǎo') && nihao.includes('nì hǎo') && nihao.includes('nǐ hào'));
  // Case, digits and a decomposed accent come in; clean marks come out.
  assert.ok(toneVariants('Tái wān', { hanzi: '臺灣' }).every((v) => v.startsWith('T')));
  assert.ok(toneVariants('he1 cha2', { hanzi: '喝茶' }).includes('hé chá'));
  assert.ok(toneVariants('xiè', { hanzi: '謝' }).includes('xié'));
  assert.equal(bareReading('lǜ xiè'), 'lü xie');
  assert.equal(bareReading('he1 cha2'), 'he cha');
});

test('listen-meaning carries the audio, both readings and the characters', () => {
  const qs = build(['listen-meaning']);
  assert.ok(qs.length >= 8);
  for (const q of qs) {
    const w = byId.get(q.wordId);
    assert.equal(q.type, 'listen-meaning');
    assert.equal(q.prompt.tts, w.hanzi, 'the browser speaks the characters');
    assert.equal(q.prompt.hanzi, w.hanzi);
    assert.equal(q.prompt.pinyin, readingsOf(w).pinyin);
    assert.match(q.prompt.zhuyin, /[ㄅ-ㄩ]/, '注音 is filled even when the word has none');
    assert.deepEqual(q.options.map((o) => o.id), ['a', 'b', 'c', 'd']);
    assert.equal(new Set(q.options.map((o) => o.text)).size, 4, 'no two meanings alike');
    assert.equal(q.options.find((o) => o.id === q.answerId).text, w.meaning);
  }
});

test('mc-pinyin: the reading among other readings and at least one tone variant', () => {
  const qs = build(['mc-pinyin'], { size: 20 });
  assert.ok(qs.length >= 8);
  for (const q of qs) {
    const w = byId.get(q.wordId);
    const { pinyin } = readingsOf(w);
    assert.equal(q.prompt.meaning, w.meaning);
    assert.equal(q.prompt.hanzi, w.hanzi);
    assert.deepEqual(q.options.map((o) => o.id), ['a', 'b', 'c', 'd']);
    const answer = q.options.find((o) => o.id === q.answerId);
    assert.equal(answer.pinyin, pinyin);
    assert.equal(new Set(q.options.map((o) => normalizePinyin(o.pinyin))).size, 4, 'no two options sound the same');
    for (const o of q.options) assert.match(o.zhuyin, /[ㄅ-ㄩ]/, `${o.pinyin} has 注音`);
    const variants = new Set(toneVariants(pinyin, { hanzi: w.hanzi }));
    const wrong = q.options.filter((o) => o.id !== q.answerId);
    assert.ok(wrong.some((o) => variants.has(o.pinyin)), `${pinyin}: one wrong answer is a tone variant`);
  }
  const asked = new Set(qs.map((q) => byId.get(q.wordId).hanzi));
  assert.ok(!asked.has('的'), 'a word with no tone to change is never asked');
});

test('tones: the word\'s letters four times, one set of marks right', () => {
  const qs = build(['tones'], { size: 20 });
  assert.ok(qs.length >= 6);
  for (const q of qs) {
    const w = byId.get(q.wordId);
    const { pinyin } = readingsOf(w);
    assert.equal(q.prompt.tts, w.hanzi);
    assert.equal(q.prompt.hanzi, w.hanzi);
    assert.equal(q.prompt.meaning, w.meaning);
    assert.equal(q.prompt.bare, bareReading(pinyin));
    assert.doesNotMatch(q.prompt.bare.normalize('NFD'), TONE_MARKS, 'bare means no tone marks');
    assert.deepEqual(q.options.map((o) => o.id), ['a', 'b', 'c', 'd']);
    assert.equal(q.options.find((o) => o.id === q.answerId).pinyin, pinyin);
    assert.equal(new Set(q.options.map((o) => normalizePinyin(o.pinyin))).size, 4, 'four different readings');
    const variants = new Set(toneVariants(pinyin, { hanzi: w.hanzi }));
    for (const o of q.options) {
      assert.equal(bareReading(o.pinyin), q.prompt.bare, `${o.pinyin} spells ${q.prompt.bare}`);
      if (o.id !== q.answerId) assert.ok(variants.has(o.pinyin), `${o.pinyin} is a tone variant of ${pinyin}`);
    }
  }
  const asked = new Set(qs.map((q) => byId.get(q.wordId).hanzi));
  for (const skip of ['的']) assert.ok(!asked.has(skip), `${skip} cannot give three variants`);
});

test('order-pinyin: the tiles put back in answer order are the example\'s syllables', () => {
  const qs = build(['order-pinyin'], { size: 20 });
  assert.ok(qs.length >= 6);
  for (const q of qs) {
    const w = byId.get(q.wordId);
    const ex = w.examples.find((e) => e.zh === q.full.zh);
    assert.ok(ex, 'full.zh is one of the word\'s examples');
    assert.equal(q.full.pinyin, ex.pinyin);
    assert.equal(q.prompt.translation, ex.translation);
    assert.equal(q.prompt.tts, ex.zh);
    assert.ok(q.tiles.length >= 3 && q.tiles.length <= 12);
    assert.deepEqual([...q.answer].sort(), q.tiles.map((t) => t.id).sort(), 'the answer uses every tile once');
    const text = new Map(q.tiles.map((t) => [t.id, t.text]));
    const rebuilt = q.answer.map((id) => text.get(id));
    assert.deepEqual(rebuilt, splitSyllables(ex.pinyin).map((s) => s.toLowerCase()));
    assert.ok(q.tiles.every((t) => !/[\s.,!?，。！？]/.test(t.text)), 'punctuation is dropped');
    assert.notDeepEqual(q.tiles.map((t) => t.text), rebuilt, 'the tiles do not start in order');
  }
  const asked = new Set(qs.map((q) => byId.get(q.wordId).hanzi));
  assert.ok(!asked.has('事'), 'a two-syllable example is too short to order');
  assert.ok(!asked.has('點'), 'an example with a digit is skipped');
  assert.ok(!asked.has('的'), 'no example, no question');
});

test('speak carries the meaning, its context and everything the reveal needs', () => {
  const qs = build(['speak'], { size: 20 });
  assert.equal(qs.length, POOL.length, 'every word with a meaning and a reading can be said');
  for (const q of qs) {
    const w = byId.get(q.wordId);
    const { pinyin, zhuyin } = readingsOf(w);
    assert.equal(q.prompt.meaning, w.meaning);
    assert.equal(typeof q.prompt.context, 'string');
    if (q.prompt.context) assert.ok(w.examples.some((e) => e.translation === q.prompt.context));
    assert.deepEqual(q.answer, { pinyin, zhuyin, hanzi: w.hanzi, tts: w.hanzi });
    assert.equal(q.options, undefined);
  }
  assert.equal(qs.find((q) => q.wordId === POOL[0].id).prompt.context, 'Thanks for your help.');
  assert.equal(qs.find((q) => byId.get(q.wordId).hanzi === '的').prompt.context, '');
});

test('match pairs carry both readings and never two that sound alike', () => {
  const qs = build(['match'], { size: 4 });
  assert.ok(qs.length >= 2);
  for (const q of qs) {
    assert.ok(q.pairs.length >= 4 && q.pairs.length <= 5);
    for (const p of q.pairs) {
      const w = byId.get(p.wordId);
      assert.equal(p.hanzi, w.hanzi);
      assert.equal(p.meaning, w.meaning);
      assert.equal(p.pinyin, readingsOf(w).pinyin);
      assert.ok(p.zhuyin, `${p.hanzi} has 注音`);
    }
    assert.equal(new Set(q.pairs.map((p) => normalizePinyin(p.pinyin))).size, q.pairs.length, '是 and 事 never share a board');
  }
});

test('the learner\'s focus picks the types; an explicit list wins', () => {
  for (const focus of FOCI) {
    const allowed = new Set(recommendedChallengeTypes(focus));
    const qs = build(null, { size: 30, focus, seed: `focus-${focus}` });
    const types = new Set(qs.map((q) => q.type));
    for (const t of types) assert.ok(allowed.has(t), `${t} fits a ${focus} learner`);
    if (focus !== 'balanced') assert.deepEqual([...types].sort(), [...allowed].sort(), `a long ${focus} run uses every type it may`);
  }
  const speaking = build(null, { size: 30, focus: 'speaking' });
  assert.ok(!speaking.some((q) => ['mc-hanzi', 'listen', 'order', 'cloze'].includes(q.type)), 'no character drill for a speaking learner');
  assert.ok(build(['tones'], { focus: 'characters' }).every((q) => q.type === 'tones'));
  // A short run over many types still reaches the end of the ramp sometimes.
  const reached = new Set();
  for (let i = 0; i < 12; i += 1) for (const q of build(null, { size: 6, focus: 'balanced', seed: `short-${i}` })) reached.add(q.type);
  assert.ok(reached.has('speak') && reached.has('type-pinyin'), [...reached].join(', '));
});

test('a type that cannot be built is skipped, and the build stays deterministic', () => {
  const plain = POOL.slice(0, 6).map((w) => ({ ...w, examples: w.examples.map(({ zh, translation }) => ({ zh, translation })) }));
  assert.deepEqual(build(['order-pinyin'], { pool: plain }), [], 'no example pinyin, no order-pinyin');
  const mixed = build(['order-pinyin', 'mc-meaning'], { pool: plain, size: 5 });
  assert.equal(mixed.length, 5);
  assert.ok(mixed.every((q) => q.type === 'mc-meaning'));

  const one = build(null, { size: 12, focus: 'speaking', seed: 'same' });
  const two = build(null, { size: 12, focus: 'speaking', seed: 'same' });
  assert.deepEqual(one, two, 'same seed, same challenge');
  assert.deepEqual(one.map((q) => q.id), one.map((_, i) => `q${i + 1}`));
  // The run warms up: nothing produced from memory before something recognised.
  const firstSpeak = one.findIndex((q) => q.type === 'speak');
  const firstMeaning = one.findIndex((q) => q.type === 'mc-meaning');
  assert.ok(firstMeaning >= 0 && firstSpeak > firstMeaning, one.map((q) => q.type).join(', '));
  assert.equal(countAnswers(one), one.reduce((n, q) => n + (q.type === 'match' ? q.pairs.length : 1), 0));
  assert.ok(one.every((q) => q.type === 'match' || hanziChars(byId.get(q.wordId).hanzi).length > 0));
});

/* The route: focus is validated, defaults to the learner's own goals, and never
   overrides a list of types the client sent. Assembled like test/routes.test.js. */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumi-challenge-'));
process.env.DATA_DIR = dataDir;
delete process.env.MEMOLANG_DATA_DIR;
delete process.env.OPENROUTER_API_KEY;

test('POST /challenge/build: focus from the body, else from the learner\'s goals', async () => {
  const { default: express } = await import('express');
  const { initStore, flushAll, coll, doc } = await import('../server/store.js');
  const { DEFAULT_SETTINGS, DEFAULT_PROGRESS } = await import('../server/defaults.js');
  const { mountRoutes } = await import('../server/routes/index.js');
  for (const name of ['words', 'lessons', 'notes', 'usage']) coll(name);
  doc('settings', DEFAULT_SETTINGS);
  doc('progress', DEFAULT_PROGRESS);
  doc('suggestions', {});
  doc('models-cache', {});
  await initStore();
  for (const w of POOL) {
    const { id, ...rest } = w;   // eslint-disable-line no-unused-vars
    coll('words').insert(rest);
  }
  const app = express();
  app.use(express.json());
  await mountRoutes(app);
  app.use((err, req, res, next) => {    // eslint-disable-line no-unused-vars
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  after(async () => {
    server.close();
    await flushAll();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const post = async (body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/challenge/build`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const typesOf = (res) => new Set(res.body.questions.map((q) => q.type));
  const within = (res, focus) => [...typesOf(res)].every((t) => recommendedChallengeTypes(focus).includes(t));

  const speaking = await post({ size: 16, seed: 'r1', focus: 'speaking' });
  assert.equal(speaking.status, 200);
  assert.ok(within(speaking, 'speaking'), [...typesOf(speaking)].join(', '));

  const refused = await post({ focus: 'singing' });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /focus/);

  doc('settings').set((cur) => ({ ...cur, goals: { onboardedAt: new Date().toISOString(), skills: ['read', 'write'], reasons: [], classes: 'none', about: '' } }));
  const fromGoals = await post({ size: 16, seed: 'r2' });
  assert.equal(fromGoals.status, 200);
  assert.ok(within(fromGoals, 'characters'), `no focus sent → the learner's (characters): ${[...typesOf(fromGoals)].join(', ')}`);

  const listed = await post({ size: 3, seed: 'r3', focus: 'characters', types: ['speak'] });
  assert.deepEqual([...typesOf(listed)], ['speak'], 'an explicit list beats the focus');

  const unbuildable = await post({ size: 3, types: ['order-pinyin'], lessonId: null, seed: 'r4' });
  assert.equal(unbuildable.status, 200, 'this pool has pinyin examples, so it builds');
  coll('words').replaceAll(coll('words').all().map((w) => ({ ...w, examples: [] })));
  const empty = await post({ size: 3, types: ['order-pinyin'] });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /question types/);
});
