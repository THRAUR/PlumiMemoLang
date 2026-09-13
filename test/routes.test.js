/* REST layer tests. The app is assembled here the way server/index.js does it
   (registering the collections, then initStore, then mountRoutes) instead of
   importing index.js, which listens on a real port and installs signal
   handlers. DATA_DIR is a throwaway folder and OPENROUTER_API_KEY is removed
   before anything reads the config, so no test can reach the network: the AI
   endpoints are only exercised on their no-key path. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumi-routes-'));
process.env.DATA_DIR = dataDir;
delete process.env.MEMOLANG_DATA_DIR;
delete process.env.OPENROUTER_API_KEY;

const { default: express } = await import('express');
const { initStore, flushAll, coll, doc } = await import('../server/store.js');
const { DEFAULT_SETTINGS, DEFAULT_PROGRESS } = await import('../server/defaults.js');
const { mountRoutes, ROUTERS } = await import('../server/routes/index.js');

for (const name of ['words', 'lessons', 'notes', 'usage']) coll(name);
doc('settings', DEFAULT_SETTINGS);
doc('progress', DEFAULT_PROGRESS);
doc('suggestions', {});
doc('models-cache', {});
await initStore();

const app = express();
app.disable('x-powered-by');
app.set('etag', false);
app.use(express.json({ limit: '40mb' }));
await mountRoutes(app);
app.use('/api', (req, res) => res.status(404).json({ error: `No such endpoint: ${req.method} ${req.originalUrl}` }));
app.use((err, req, res, next) => {    // eslint-disable-line no-unused-vars
  // PLUMI_DEBUG=1 prints the stack behind a 500 instead of just its message.
  if (process.env.PLUMI_DEBUG) console.error(err);
  res.status(err.status || err.statusCode || 500).json({ error: err.message || 'Something went wrong.' });
});

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  server.close();
  await flushAll();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function raw(method, url, body) {
  return fetch(`${base}/api${url}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function api(method, url, body) {
  const res = await raw(method, url, body);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json (a download, maybe) */ }
  return { status: res.status, body: json, text, headers: res.headers };
}
const GET = (u) => api('GET', u);
const POST = (u, b) => api('POST', u, b ?? {});
const PUT = (u, b) => api('PUT', u, b ?? {});
const DEL = (u) => api('DELETE', u);

/* 1x1 transparent PNG. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PNG_URL = `data:image/png;base64,${PNG}`;

const CHALLENGE_SEED = [
  { hanzi: '貓', pinyin: 'māo', meaning: 'cat', pos: 'n', examples: [{ zh: '我有一隻貓。', translation: 'I have a cat.' }] },
  { hanzi: '狗', pinyin: 'gǒu', meaning: 'dog', pos: 'n', examples: [{ zh: '他的狗很大。', translation: 'His dog is big.' }] },
  { hanzi: '書', pinyin: 'shū', meaning: 'book', pos: 'n', examples: [{ zh: '我看書。', translation: 'I read a book.' }] },
  { hanzi: '水', pinyin: 'shuǐ', meaning: 'water', pos: 'n', examples: [{ zh: '我喝水。', translation: 'I drink water.' }] },
  { hanzi: '車', pinyin: 'chē', meaning: 'car', pos: 'n', examples: [{ zh: '這是我的車。', translation: 'This is my car.' }] },
  { hanzi: '花', pinyin: 'huā', meaning: 'flower', pos: 'n', examples: [{ zh: '花很漂亮。', translation: 'The flowers are pretty.' }] },
  { hanzi: '山', pinyin: 'shān', meaning: 'mountain', pos: 'n', examples: [{ zh: '山很高。', translation: 'The mountain is high.' }] },
  { hanzi: '魚', pinyin: 'yú', meaning: 'fish', pos: 'n', examples: [{ zh: '我吃魚。', translation: 'I eat fish.' }] },
];

const ids = {};     // shared between tests, in file order

test('every router module loads (mountRoutes hides import errors)', async () => {
  for (const name of ROUTERS) {
    const mod = await import(`../server/routes/${name}.js`);
    assert.equal(typeof mod.default, 'function', `${name}.js must export default a Router`);
  }
});

test('GET /health', async () => {
  const { status, body } = await GET('/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.dataDir, dataDir);
});

test('settings: GET hides the key, PUT deep-merges and validates', async () => {
  const first = await GET('/settings');
  assert.equal(first.status, 200);
  assert.equal(first.body.ai.apiKey, undefined);
  assert.equal(first.body.ai.hasApiKey, false);
  assert.equal(first.body.ai.apiKeyMasked, '');
  assert.equal(first.body.script, 'zhuyin');
  assert.equal(first.body.cardTemplates.length, DEFAULT_SETTINGS.cardTemplates.length);

  // A partial body must not wipe its siblings.
  const put = await PUT('/settings', { dailyGoalXp: 40, ai: { models: { extract: 'openai/gpt-5' } }, nativeLanguage: 'fr' });
  assert.equal(put.status, 200);
  assert.equal(put.body.dailyGoalXp, 40);
  assert.equal(put.body.nativeLanguage, 'fr');
  assert.equal(put.body.ai.models.extract, 'openai/gpt-5');
  assert.equal(put.body.ai.models.default, DEFAULT_SETTINGS.ai.models.default, 'the other model slots survive');
  assert.equal(put.body.newWordsPerDay, DEFAULT_SETTINGS.newWordsPerDay);

  // The key goes in and only comes back masked.
  const keyed = await PUT('/settings', { ai: { apiKey: 'sk-or-v1-0123456789abcdef' } });
  assert.equal(keyed.body.ai.apiKey, undefined);
  assert.equal(keyed.body.ai.hasApiKey, true);
  assert.equal(typeof keyed.body.ai.apiKeyMasked, 'string');
  assert.ok(keyed.body.ai.apiKeyMasked.length > 0);
  assert.ok(!keyed.body.ai.apiKeyMasked.includes('0123456789'), 'the mask must not show the middle of the key');
  assert.equal(doc('settings').get().ai.apiKey, 'sk-or-v1-0123456789abcdef', 'it is stored');

  // "" clears it again, so the rest of the suite stays offline.
  const cleared = await PUT('/settings', { ai: { apiKey: '' } });
  assert.equal(cleared.body.ai.hasApiKey, false);

  for (const [bodyIn, why] of [
    [{ script: 'bopomofo' }, 'unknown script'],
    [{ level: 'wizard' }, 'unknown level'],
    [{ theme: 'neon' }, 'unknown theme'],
    [{ nativeLanguage: 'esperantoish' }, 'language code too long'],
    [{ dailyGoalXp: 1 }, 'goal below the floor'],
    [{ dailyGoalXp: 5000 }, 'goal above the ceiling'],
    [{ newWordsPerDay: -1 }, 'negative new words'],
    [{ ai: { monthlyBudgetUsd: -3 } }, 'negative budget'],
    [{ cardTemplates: 'nope' }, 'templates not an array'],
    [{ cardTemplates: [{ id: 'a', front: ['hanzi'], back: ['nonsense'] }] }, 'unknown card field'],
    [{ cardTemplates: [{ id: 'a', front: ['hanzi'], back: [] }, { id: 'a', front: ['meaning'], back: [] }] }, 'duplicate template id'],
    [{ ai: { models: { nope: 'x' } } }, 'unknown model slot'],
  ]) {
    const res = await PUT('/settings', bodyIn);
    assert.equal(res.status, 400, `${why} must be rejected`);
    assert.equal(typeof res.body.error, 'string');
  }
  // A rejected PUT changed nothing.
  assert.equal((await GET('/settings')).body.dailyGoalXp, 40);
});

test('words: create, dedupe-merge, search, export, delete', async () => {
  const created = await POST('/words', {
    hanzi: '  謝謝  ', pinyin: 'xiè xie', meaning: 'thank you', pos: 'v', tags: ['greeting'],
    examples: [{ zh: '謝謝你的幫忙。', translation: 'Thanks for your help.' }],
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.hanzi, '謝謝', 'hanzi is trimmed');
  assert.equal(created.body.score, 0);
  assert.equal(created.body.band.key, 'new');
  assert.equal(created.body.srs.state, 'new');
  assert.deepEqual(created.body.stats, { reviews: 0, correct: 0, streak: 0, history: [] });
  ids.thanks = created.body.id;

  assert.equal((await POST('/words', { hanzi: '   ' })).status, 400);
  assert.equal((await POST('/words', { hanzi: '好', pos: 'noun' })).status, 400, 'pos is validated');
  assert.equal((await POST('/words', { hanzi: '好', lessonId: 'nope' })).status, 404, 'lessonId is checked');

  // Same hanzi merges, filling blanks only.
  const merged = await POST('/words', { hanzi: '謝謝', meaning: 'thanks a lot', meaningNative: 'merci', notes: 'polite', tags: ['polite'] });
  assert.equal(merged.status, 200);
  assert.equal(merged.body.merged, true);
  assert.equal(merged.body.word.id, ids.thanks);
  assert.equal(merged.body.word.meaning, 'thank you', 'a filled field is never overwritten');
  assert.equal(merged.body.word.meaningNative, 'merci', 'a blank one is filled');
  assert.equal(merged.body.word.notes, 'polite');
  assert.deepEqual(merged.body.word.tags, ['greeting', 'polite']);
  assert.equal(coll('words').all().length, 1, 'no duplicate row');

  for (const w of CHALLENGE_SEED) {
    const res = await POST('/words', w);
    assert.equal(res.status, 201, `seed ${w.hanzi}`);
    ids[w.meaning] = res.body.id;
  }

  const list = await GET('/words');
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 9);
  assert.deepEqual(list.body.tags, ['greeting', 'polite']);
  assert.ok(list.body.words.every((w) => typeof w.score === 'number' && w.band?.key));

  assert.equal((await GET('/words?q=' + encodeURIComponent('謝'))).body.total, 1, 'hanzi substring');
  assert.equal((await GET('/words?q=thank')).body.total, 1, 'meaning substring');
  assert.equal((await GET('/words?q=merci')).body.total, 1, 'native meaning');
  assert.equal((await GET('/words?q=xie4')).body.total, 1, 'pinyin, tone-insensitive');
  assert.equal((await GET('/words?q=zzz')).body.total, 0);
  assert.equal((await GET('/words?tag=greeting')).body.total, 1);
  assert.equal((await GET('/words?tag=nope')).body.total, 0);
  assert.equal((await GET('/words?band=new')).body.total, 9, 'nothing is learned yet');
  assert.equal((await GET('/words?band=mastered')).body.total, 0);
  assert.equal((await GET('/words?type=word')).body.total, 9);

  const alpha = await GET('/words?sort=alpha&dir=asc');
  assert.equal(alpha.body.words.length, 9);
  assert.deepEqual(
    [...alpha.body.words.map((w) => w.hanzi)].sort((a, b) => a.localeCompare(b, 'zh-Hant')),
    alpha.body.words.map((w) => w.hanzi),
    'alpha sort is really sorted',
  );

  const one = await GET(`/words/${ids.thanks}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.lesson, null);
  assert.equal((await GET('/words/nope')).status, 404);
  assert.equal((await GET('/words/nope')).body.error, 'No such word.');

  const updated = await PUT(`/words/${ids.thanks}`, { meaning: 'thank you (polite)', srs: { state: 'review', reps: 99 }, stats: { reviews: 99 }, id: 'hack' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.meaning, 'thank you (polite)');
  assert.equal(updated.body.id, ids.thanks, 'id is not writable');
  assert.equal(updated.body.srs.state, 'new', 'srs is not writable');
  assert.equal(updated.body.stats.reviews, 0, 'stats are not writable');
  assert.equal((await PUT(`/words/${ids.thanks}`, { hanzi: '' })).status, 400);
  assert.equal((await PUT(`/words/${ids.thanks}`, { hanzi: '貓' })).status, 409, 'renaming onto another word clashes');

  const csvRes = await raw('GET', '/words/export?format=csv');
  const csvBytes = Buffer.from(await csvRes.arrayBuffer());
  // fetch's text() strips a leading BOM, so the bytes are what to assert on.
  assert.deepEqual([...csvBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM so Excel reads the hanzi');
  const csv = { status: csvRes.status, text: csvBytes.toString('utf8').replace(/^\uFEFF/, ''), headers: csvRes.headers };
  assert.equal(csv.status, 200);
  assert.ok(csv.text.includes('"hanzi","pinyin","zhuyin","meaning","meaningNative","pos","type","tags","score","lesson","example"'));
  assert.ok(csv.text.includes('"謝謝"'));
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="plumimemolang-words\.csv"/);
  const jsonExport = await GET('/words/export?format=json');
  assert.equal(jsonExport.body.count, 9);
  assert.match(jsonExport.headers.get('content-disposition'), /plumimemolang-words\.json/);

  // AI endpoints: only the no-key path is exercised.
  assert.equal((await POST(`/words/${ids.thanks}/enrich`)).status, 400);
  assert.equal((await POST(`/words/${ids.thanks}/explain`, { question: 'why two characters?' })).status, 400);
  assert.equal((await POST(`/words/${ids.thanks}/explain`, {})).status, 400, 'a question is required');

  const throwaway = await POST('/words', { hanzi: '測試', meaning: 'test only' });
  assert.equal((await DEL(`/words/${throwaway.body.id}`)).status, 200);
  assert.equal((await GET(`/words/${throwaway.body.id}`)).status, 404);
  assert.equal((await DEL('/words/nope')).status, 404);
});

test('lessons: CRUD, progress, reorder, links to words', async () => {
  assert.equal((await POST('/lessons', {})).status, 400);
  const made = await POST('/lessons', { title: '  Ordering food  ', titleZh: '點餐', summary: 'Food words.', classDate: '2026-09-11', wordIds: [ids.cat, ids.dog] });
  assert.equal(made.status, 201);
  assert.equal(made.body.title, 'Ordering food');
  assert.equal(made.body.order, 1);
  assert.deepEqual(made.body.progress, { total: 2, learned: 0, mastered: 0, avgScore: 0 });
  ids.lesson = made.body.id;

  const second = await POST('/lessons', { title: 'At the station' });
  assert.equal(second.body.order, 2, 'order is max + 1');

  assert.equal((await POST('/lessons', { title: 'Bad', wordIds: ['nope'] })).status, 404);
  assert.equal((await POST('/lessons', { title: 'Bad', sections: [{ kind: 'poem' }] })).status, 400);

  const listed = await GET('/lessons');
  assert.equal(listed.body.lessons.length, 2);
  assert.deepEqual(listed.body.lessons.map((l) => l.order), [1, 2]);
  assert.ok(listed.body.lessons.every((l) => l.progress));

  const full = await GET(`/lessons/${ids.lesson}`);
  assert.equal(full.body.words.length, 2);
  assert.ok(full.body.words.every((w) => typeof w.score === 'number'));
  assert.equal((await GET('/lessons/nope')).status, 404);

  // The words now point back at the lesson.
  assert.equal((await GET(`/words/${ids.cat}`)).body.lesson.title, 'Ordering food');
  assert.equal((await GET(`/words?lessonId=${ids.lesson}`)).body.total, 2);
  assert.equal((await GET('/words?lessonId=none')).body.total, 7);

  const edited = await PUT(`/lessons/${ids.lesson}`, { status: 'started', summary: 'Ordering at a night market.' });
  assert.equal(edited.body.status, 'started');
  assert.equal((await PUT(`/lessons/${ids.lesson}`, { status: 'finished' })).status, 400);
  assert.equal((await PUT(`/lessons/${ids.lesson}`, { title: '' })).status, 400);

  const reordered = await POST('/lessons/reorder', { ids: [second.body.id, ids.lesson] });
  assert.equal(reordered.status, 200);
  assert.deepEqual((await GET('/lessons')).body.lessons.map((l) => l.id), [second.body.id, ids.lesson]);
  assert.equal((await POST('/lessons/reorder', { ids: 'nope' })).status, 400);

  // Deleting a lesson keeps the words and unlinks them.
  assert.equal((await DEL(`/lessons/${second.body.id}`)).status, 200);
  const dropped = await PUT(`/lessons/${ids.lesson}`, { wordIds: [ids.cat] });
  assert.equal(dropped.body.progress.total, 1);
  assert.equal((await GET(`/words/${ids.dog}`)).body.lesson, null, 'a word removed from a lesson is unlinked');
});

test('review: the queue, grading, XP and the streak', async () => {
  const queue = await GET('/review/queue?limit=5');
  assert.equal(queue.status, 200);
  assert.ok(queue.body.cards.length > 0 && queue.body.cards.length <= 5);
  assert.equal(queue.body.counts.total >= queue.body.cards.length, true);
  assert.ok(queue.body.cards.every((c) => c.preview?.good?.label && typeof c.score === 'number'));
  assert.ok(queue.body.templates.length > 0 && queue.body.templates.every((t) => t.enabled));
  assert.equal((await GET('/review/queue?lessonId=nope')).status, 404);
  const lessonQueue = await GET(`/review/queue?lessonId=${ids.lesson}`);
  assert.ok(lessonQueue.body.cards.every((c) => c.lessonId === ids.lesson));

  const before = (await GET('/stats')).body;
  const graded = await POST('/review/grade', { wordId: ids.thanks, grade: 2, templateId: 'recognition', ms: 4200 });
  assert.equal(graded.status, 200);
  assert.equal(graded.body.xp, 3, '2 for the card + 1 for a comfortable recall');
  assert.notEqual(graded.body.word.srs.state, 'new', 'the card was scheduled');
  assert.ok(graded.body.word.srs.due, 'it has a due date now');
  assert.equal(graded.body.word.srs.reps, 1);
  assert.equal(graded.body.word.stats.reviews, 1);
  assert.equal(graded.body.word.stats.correct, 1);
  assert.deepEqual(graded.body.word.stats.history, [1]);
  assert.ok(graded.body.word.preview.again);
  assert.equal(graded.body.stats.xpToday, before.xpToday + 3);
  assert.equal(graded.body.stats.streak.current, 1);
  assert.equal(graded.body.stats.streak.best, 1);
  assert.equal(graded.body.stats.streak.activeToday, true);
  assert.equal(graded.body.stats.today, graded.body.stats.week.at(-1).date);
  assert.equal(graded.body.stats.week.length, 7);
  assert.equal(graded.body.stats.counts.words, 9);
  assert.equal(graded.body.stats.counts.learning, 1);

  const again = await POST('/review/grade', { wordId: ids.cat, grade: 0, ms: 9000 });
  assert.equal(again.body.xp, 2, 'no bonus for a lapse');
  assert.deepEqual(again.body.word.stats.history, [0]);

  assert.equal((await POST('/review/grade', { wordId: 'nope', grade: 2 })).status, 404);
  assert.equal((await POST('/review/grade', { wordId: ids.cat, grade: 7 })).status, 400);
  assert.equal((await POST('/review/grade', { wordId: ids.cat, grade: 1.5 })).status, 400);

  const finished = await POST('/review/finish', { reviewed: 2, correct: 1, ms: 60000 });
  assert.equal(finished.body.xp, 5);
  assert.equal((await POST('/review/finish', { reviewed: 0 })).body.xp, 0, 'no bonus for an empty session');
  const stats = (await GET('/stats')).body;
  assert.equal(stats.xpToday, before.xpToday + 3 + 2 + 5);
  assert.equal(stats.goal, 40);
  assert.ok(stats.week.at(-1).reviews >= 2);
});

test('challenge: every question type builds a valid shape, finishing pays XP', async () => {
  const { QUESTION_TYPES } = await import('../server/lib/challenge.js');
  const words = new Map((await GET('/words')).body.words.map((w) => [w.id, w]));

  function checkQuestion(q) {
    assert.ok(q.id, 'every question has an id');
    assert.ok(QUESTION_TYPES.includes(q.type), `known type: ${q.type}`);
    if (q.type === 'match') {
      assert.ok(q.pairs.length >= 4 && q.pairs.length <= 5);
      const seen = new Set();
      for (const p of q.pairs) {
        assert.ok(p.id && p.hanzi && p.meaning && words.has(p.wordId));
        assert.ok(!seen.has(p.hanzi));
        seen.add(p.hanzi);
      }
      return;
    }
    const word = words.get(q.wordId);
    assert.ok(word, 'the asked word exists');
    if (q.type === 'type-pinyin') {
      assert.equal(q.prompt.hanzi, word.hanzi);
      assert.ok(q.answer.pinyin || q.answer.zhuyin);
      return;
    }
    if (q.type === 'order') {
      assert.ok(q.tiles.length >= 3 && q.tiles.length <= 12);
      assert.deepEqual([...q.answer].sort(), q.tiles.map((t) => t.id).sort(), 'answer covers every tile');
      const byId = new Map(q.tiles.map((t) => [t.id, t.text]));
      const sentence = q.answer.map((id) => byId.get(id)).join('');
      assert.ok(word.examples.some((e) => e.zh.includes(sentence)), 'the tiles rebuild the example');
      assert.ok(typeof q.prompt.translation === 'string');
      return;
    }
    // Every remaining type is multiple choice.
    assert.equal(q.options.length, 4);
    const optionIds = q.options.map((o) => o.id);
    assert.deepEqual(optionIds, ['a', 'b', 'c', 'd']);
    assert.ok(optionIds.includes(q.answerId));
    const answer = q.options.find((o) => o.id === q.answerId);
    if (q.type === 'mc-meaning') {
      assert.equal(q.prompt.hanzi, word.hanzi);
      assert.equal(answer.text, word.meaning);
      assert.equal(new Set(q.options.map((o) => o.text)).size, 4, 'no two options read alike');
    } else if (q.type === 'mc-hanzi' || q.type === 'listen') {
      assert.equal(answer.hanzi, word.hanzi);
      assert.equal(new Set(q.options.map((o) => o.hanzi)).size, 4);
      if (q.type === 'listen') assert.equal(q.prompt.tts, word.hanzi);
      else assert.equal(q.prompt.meaning, word.meaning);
    } else if (q.type === 'cloze') {
      assert.ok(q.prompt.sentence.includes('▢'), 'the word is blanked out');
      assert.ok(!q.prompt.sentence.includes(word.hanzi));
      assert.equal(answer.hanzi, word.hanzi);
    }
  }

  const built = await POST('/challenge/build', { size: 8, seed: 'plumi' });
  assert.equal(built.status, 200);
  assert.ok(built.body.id);
  assert.equal(built.body.questions.length, 8);
  built.body.questions.forEach(checkQuestion);
  assert.ok(new Set(built.body.questions.map((q) => q.type)).size >= 5, 'a mixed session really mixes');

  // Same seed, same challenge.
  const again = await POST('/challenge/build', { size: 8, seed: 'plumi' });
  assert.deepEqual(again.body.questions, built.body.questions);

  // Each type can be built on its own.
  for (const type of QUESTION_TYPES) {
    const one = await POST('/challenge/build', { size: 1, types: [type], seed: `seed-${type}` });
    assert.equal(one.status, 200, `${type} builds`);
    assert.equal(one.body.questions.length, 1, `${type} produced a question`);
    assert.equal(one.body.questions[0].type, type);
    checkQuestion(one.body.questions[0]);
  }

  assert.equal((await POST('/challenge/build', { types: ['sing-it'] })).status, 400);
  assert.equal((await POST('/challenge/build', { size: 99 })).status, 400);
  assert.equal((await POST('/challenge/build', { lessonId: 'nope' })).status, 404, 'unknown lesson');
  assert.equal((await POST('/challenge/build', { lessonId: ids.lesson })).status, 400, 'a one-word lesson cannot fill a challenge');

  const before = (await GET('/stats')).body;
  const fish = words.get(ids.fish);
  const finish = await POST('/challenge/finish', {
    id: built.body.id,
    type: 'mixed',
    answers: [
      { index: 0, wordId: fish.id, correct: true, ms: 2000 },
      { index: 1, wordId: ids.book, correct: false, ms: 3000 },
      { index: 2, wordId: ids.water, correct: true, ms: 1500 },
    ],
  });
  assert.equal(finish.status, 200);
  assert.equal(finish.body.score, 2);
  assert.equal(finish.body.total, 3);
  assert.equal(finish.body.xp, 9, '2 per correct answer + 5 for finishing');
  assert.equal(finish.body.stats.xpToday, before.xpToday + 9);
  const fishAfter = (await GET(`/words/${fish.id}`)).body;
  assert.equal(fishAfter.stats.reviews, 1, 'a challenge answer counts towards accuracy');
  assert.equal(fishAfter.stats.correct, 1);
  assert.equal(fishAfter.srs.state, 'new', 'but it never reschedules the card');
  assert.equal(fishAfter.srs.due, null);

  // A padded answer list cannot mint XP beyond what was asked.
  const small = await POST('/challenge/build', { size: 2, seed: 'cap' });
  const padded = await POST('/challenge/finish', {
    id: small.body.id,
    answers: Array.from({ length: 50 }, (_, i) => ({ index: i, correct: true, ms: 10 })),
  });
  const asked = small.body.questions.reduce((n, q) => n + (q.type === 'match' ? q.pairs.length : 1), 0);
  assert.equal(padded.body.total, asked);
  assert.equal(padded.body.score, asked);
  assert.equal((await POST('/challenge/finish', { answers: 'nope' })).status, 400);
});

test('notes: photos land on disk, the list stays small, deleting cleans up', async () => {
  assert.equal((await POST('/notes', {})).status, 400, 'an empty note is refused');
  assert.equal((await POST('/notes', { text: 'x', images: [{ name: 'a.svg', type: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }] })).status, 400, 'only photo types');
  assert.equal((await POST('/notes', { text: 'x', images: [{ name: 'a.png', dataUrl: 'not-a-data-url' }] })).status, 400);
  assert.equal((await POST('/notes', { text: 'x', classDate: '11/09/2026' })).status, 400, 'classDate shape');

  const text = 'Class notes: '.padEnd(320, 'x');
  const made = await POST('/notes', {
    title: '  Class 12  ',
    classDate: '2026-09-11',
    text,
    images: [{ name: '../IMG 1.jpg', type: 'image/png', dataUrl: PNG_URL }, { name: '../IMG 1.jpg', type: 'image/png', dataUrl: PNG_URL }],
  });
  assert.equal(made.status, 201);
  const note = made.body;
  ids.note = note.id;
  assert.equal(note.title, 'Class 12');
  assert.equal(note.status, 'new');
  assert.equal(note.draft, null);
  assert.equal(note.images.length, 2);
  assert.equal(note.images[0].name, 'IMG_1.jpg', 'the name is sanitised');
  assert.equal(note.images[1].name, 'IMG_1-2.jpg', 'and made unique');
  assert.equal(note.images[0].file, `uploads/${note.id}/IMG_1.jpg`);
  assert.equal(note.images[0].type, 'image/png');
  assert.ok(note.images[0].size > 0);
  for (const img of note.images) assert.ok(fs.existsSync(path.join(dataDir, img.file)), `${img.file} is on disk`);

  const listed = await GET('/notes');
  const row = listed.body.notes.find((n) => n.id === note.id);
  assert.equal(row.text, undefined, 'the raw text stays out of the list');
  assert.equal(row.draft, undefined);
  assert.equal(row.excerpt.length, 200);
  assert.equal(row.excerpt, text.slice(0, 200));
  assert.equal(row.imageCount, 2);

  assert.equal((await GET(`/notes/${note.id}`)).body.text, text, 'the full note still has it');
  assert.equal((await GET('/notes/nope')).status, 404);

  const served = await raw('GET', `/notes/${note.id}/images/IMG_1.jpg`);
  assert.equal(served.status, 200);
  assert.equal(Buffer.from(await served.arrayBuffer()).toString('base64'), PNG);
  assert.equal((await GET(`/notes/${note.id}/images/nope.png`)).status, 404);
  assert.equal((await GET(`/notes/${note.id}/images/${encodeURIComponent('../../settings.json')}`)).status, 404, 'no path traversal');

  // AI paths without a key.
  assert.equal((await POST(`/notes/${note.id}/process`)).status, 400);
  assert.equal((await POST(`/notes/${note.id}/import`, { words: 'all' })).status, 400, 'nothing to import yet');
  assert.equal((await PUT(`/notes/${note.id}/draft`, { draft: { lesson: {}, words: [] } })).status, 400, 'no draft to edit yet');

  const edited = await PUT(`/notes/${note.id}`, { title: 'Class 12 — food' });
  assert.equal(edited.body.title, 'Class 12 — food');
});

test('notes: importing a draft creates a lesson, merges known words and pays XP', async () => {
  // The draft is normally written by the extract job; PUT /notes/:id exposes the
  // status so the import path can be tested without a model.
  assert.equal((await PUT(`/notes/${ids.note}`, { status: 'draft' })).body.status, 'draft');
  const draft = {
    lesson: {
      title: 'Animals and drinks', titleZh: '動物與飲料', summary: 'From class 12.',
      sections: [{ kind: 'vocab', title: 'New words', body: 'cat, tea' }],
      grammar: [], dialogue: [],
    },
    words: [
      { hanzi: '貓', pinyin: 'māo', meaning: 'cat (again)', isKnown: true },
      { hanzi: '茶', pinyin: 'chá', meaning: 'tea', pos: 'n', examples: [{ zh: '我喝茶。', translation: 'I drink tea.' }] },
      { hanzi: '牛奶', pinyin: 'niú nǎi', meaning: 'milk', pos: 'n' },
    ],
  };
  const saved = await PUT(`/notes/${ids.note}/draft`, { draft });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.draft.words.length, 3);
  assert.equal((await PUT(`/notes/${ids.note}/draft`, { draft: { words: [] } })).status, 400, 'a draft needs a lesson');

  const before = (await GET('/stats')).body;
  const imported = await POST(`/notes/${ids.note}/import`, { words: 'all', lesson: true });
  assert.equal(imported.status, 200);
  assert.ok(imported.body.lessonId);
  assert.equal(imported.body.wordIds.length, 3);
  assert.deepEqual(imported.body.mergedHanzi, ['貓'], 'a word the learner already has is merged, not duplicated');
  assert.equal(imported.body.created, 2);
  assert.equal(imported.body.xp, 10);
  assert.equal(imported.body.stats.xpToday, before.xpToday + 10);
  assert.equal(imported.body.stats.counts.words, before.counts.words + 2);

  const lesson = await GET(`/lessons/${imported.body.lessonId}`);
  assert.equal(lesson.body.title, 'Animals and drinks');
  assert.equal(lesson.body.noteId, ids.note);
  assert.equal(lesson.body.classDate, '2026-09-11');
  assert.equal(lesson.body.words.length, 3, 'merged words are listed too');
  assert.equal(lesson.body.progress.total, 3);

  const cat = (await GET(`/words/${ids.cat}`)).body;
  assert.equal(cat.meaning, 'cat', 'the merge did not overwrite the meaning');
  assert.equal(cat.lesson.title, 'Ordering food', 'nor did it move the word to the new lesson');
  const tea = coll('words').find((w) => w.hanzi === '茶');
  assert.equal(tea.lessonId, imported.body.lessonId);
  assert.equal(tea.noteId, ids.note);

  const noteAfter = (await GET(`/notes/${ids.note}`)).body;
  assert.equal(noteAfter.status, 'imported');
  assert.deepEqual(noteAfter.imported.mergedHanzi, ['貓']);
  assert.equal(noteAfter.imported.lessonId, imported.body.lessonId);

  // Deleting the note takes its upload folder with it.
  assert.equal((await DEL(`/notes/${ids.note}`)).status, 200);
  assert.equal(fs.existsSync(path.join(dataDir, 'uploads', ids.note)), false);
  assert.equal((await GET(`/notes/${ids.note}`)).status, 404);
  assert.ok(coll('words').find((w) => w.hanzi === '茶'), 'the imported words stay');
});

test('suggestions: without a key Today is told so, not shown an error', async () => {
  const res = await GET('/suggestions/today');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'no-key');
  assert.deepEqual(res.body.items, []);
  assert.ok(res.body.date);
  assert.equal(res.body.jobId, undefined);
  assert.equal((await POST('/suggestions/refresh')).status, 400);
  assert.equal((await POST('/suggestions/0/accept')).status, 404);
  assert.equal((await POST('/suggestions/0/dismiss')).status, 404);
});

test('usage and jobs', async () => {
  const usage = await GET('/usage');
  assert.equal(usage.status, 200);
  assert.deepEqual(usage.body.entries, [], 'no model was called');
  assert.deepEqual(usage.body.totals, { todayUsd: 0, monthUsd: 0, allUsd: 0, calls: 0 });

  const job = await GET('/jobs/does-not-exist');
  assert.equal(job.status, 404);
  assert.match(job.body.error, /No such job/);
  assert.equal((await GET('/nope')).status, 404, 'unknown endpoints are JSON 404s');
});

test('backup: round-trips every collection and keeps the key out', async () => {
  await PUT('/settings', { ai: { apiKey: 'sk-or-v1-keep-me-please' } });
  const dump = await GET('/backup');
  assert.equal(dump.status, 200);
  assert.match(dump.headers.get('content-disposition'), /attachment; filename="plumimemolang-backup-\d{4}-\d{2}-\d{2}\.json"/);
  const backup = JSON.parse(dump.text);
  assert.equal(backup.version, '0.1.0');
  assert.ok(backup.exportedAt);
  assert.equal(backup.settings.ai.apiKey, undefined, 'a backup never carries the key');
  assert.equal(backup.words.length, coll('words').all().length);
  assert.ok(backup.words.every((w) => w.srs && w.stats));
  assert.equal(backup.words.some((w) => w.score !== undefined), false, 'computed fields are not stored');
  assert.ok(backup.lessons.length >= 1);
  assert.ok(backup.progress.xpTotal > 0);
  assert.ok(Array.isArray(backup.progress.challenges) && backup.progress.challenges.length >= 1);
  assert.deepEqual(backup.progress.challenges.at(-1).type, 'mixed');
  assert.ok(backup.notes.every((n) => (n.images || []).every((i) => i.file && i.dataUrl === undefined)));
  assert.deepEqual(backup.suggestions, {});

  assert.equal((await POST('/backup/restore', { words: 'nope' })).status, 400);
  assert.equal((await POST('/backup/restore', { words: [{ pinyin: 'x' }] })).status, 400, 'a word needs its hanzi');
  assert.equal((await POST('/backup/restore', { settings: [] })).status, 400);

  const restored = await POST('/backup/restore', {
    ...backup,
    words: [...backup.words, { id: 'restoredword', hanzi: '電腦', pinyin: 'diàn nǎo', meaning: 'computer', tags: [], examples: [] }],
    settings: { ...backup.settings, dailyGoalXp: 55 },
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.counts.words, backup.words.length + 1);
  assert.equal(restored.body.counts.lessons, backup.lessons.length);

  const after = await GET('/words/restoredword');
  assert.equal(after.status, 200);
  assert.equal(after.body.hanzi, '電腦');
  assert.equal(after.body.srs.state, 'new', 'a word with no schedule gets a fresh one');
  assert.deepEqual(after.body.stats, { reviews: 0, correct: 0, streak: 0, history: [] });

  const settings = await GET('/settings');
  assert.equal(settings.body.dailyGoalXp, 55);
  assert.equal(settings.body.ai.hasApiKey, true, 'restoring a backup does not log you out of OpenRouter');
  assert.equal(doc('settings').get().ai.apiKey, 'sk-or-v1-keep-me-please');
  await PUT('/settings', { ai: { apiKey: '' } });
});
