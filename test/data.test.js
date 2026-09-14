/* REST tests for the Claude plan in Settings and for deleting data (§9). The app is
   assembled the way routes.test.js does it, on its own throwaway data folder.
   Claude Code is the fake in test/fixtures/fake-claude.mjs, which reads what to
   answer from $HOME, so nothing here reaches the network or a real Claude login. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumi-data-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plumi-data-home-'));
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
fs.chmodSync(FAKE, 0o755);
process.env.DATA_DIR = dataDir;
process.env.HOME = home;
process.env.MEMOLANG_CLAUDE_BIN = FAKE;
delete process.env.MEMOLANG_DATA_DIR;
delete process.env.OPENROUTER_API_KEY;

const { default: express } = await import('express');
const { initStore, flushAll, coll, doc } = await import('../server/store.js');
const { DEFAULT_SETTINGS, DEFAULT_PROGRESS } = await import('../server/defaults.js');
const { mountRoutes } = await import('../server/routes/index.js');

for (const name of ['words', 'lessons', 'notes', 'materials', 'usage']) coll(name);
doc('settings', DEFAULT_SETTINGS);
doc('progress', DEFAULT_PROGRESS);
doc('suggestions', {});
doc('models-cache', {});
await initStore();

const app = express();
app.use(express.json({ limit: '40mb' }));
await mountRoutes(app);
app.use((err, req, res, next) => {    // eslint-disable-line no-unused-vars
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
  fs.rmSync(home, { recursive: true, force: true });
});

async function api(method, url, body) {
  const res = await fetch(`${base}/api${url}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json };
}
const GET = (u) => api('GET', u);
const POST = (u, b) => api('POST', u, b ?? {});
const PUT = (u, b) => api('PUT', u, b ?? {});

function scenario(s) { fs.writeFileSync(path.join(home, 'fake-claude.json'), JSON.stringify(s)); }

async function waitForJob(id) {
  for (let i = 0; i < 200; i++) {
    const job = (await GET(`/jobs/${id}`)).body;
    if (job?.status === 'done' || job?.status === 'error') return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('The job never finished.');
}

/* 1x1 transparent PNG. */
const PNG_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const SONNET = 'claude-code:sonnet';

test('the Claude plan is offered in /models, switched on through the order and reported by /ai/providers', async () => {
  scenario({});
  const models = (await GET('/models')).body;
  const plan = models.filter((m) => m.provider === 'claude-code');
  assert.deepEqual(plan.map((m) => m.id), [SONNET, 'claude-code:opus', 'claude-code:haiku']);
  assert.ok(plan.every((m) => m.rank === null && m.enabled === false && m.included === true), 'offered, not switched on');
  assert.equal(models.filter((m) => m.provider === 'openrouter').length, 4);

  assert.equal((await GET('/settings')).body.ai.ready, false, 'no key and no plan model: nothing can answer');

  const on = await PUT('/settings', { ai: { priority: [SONNET, 'google/gemini-3.5-flash-lite'] } });
  assert.equal(on.status, 200);
  assert.deepEqual(on.body.ai.priority.slice(0, 2), [SONNET, 'google/gemini-3.5-flash-lite']);
  assert.equal(on.body.ai.priority.length, 5, 'the OpenRouter models are completed; the other plan models stay off');
  assert.equal(on.body.ai.ready, true, 'the plan alone is enough');
  assert.equal((await PUT('/settings', { ai: { priority: ['claude-code:fable'] } })).status, 400, 'only the plan models this app knows');

  const providers = await GET('/ai/providers');
  assert.equal(providers.status, 200);
  assert.equal(providers.body.ready, true);
  assert.equal(providers.body.claude.installed, true);
  assert.equal(providers.body.claude.loggedIn, true);
  assert.equal(providers.body.claude.plan, 'max');
  assert.deepEqual(providers.body.claude.enabled, [SONNET]);
  assert.equal(providers.body.openrouter.hasApiKey, false);
  assert.ok(!JSON.stringify(providers.body).includes('example.com'), 'the account email never leaves the server');

  scenario({ text: '你好!(nǐ hǎo!)' });
  const tested = await POST('/ai/test', { model: SONNET });
  assert.equal(tested.status, 200, tested.body?.error);
  assert.equal(tested.body.reply, '你好!(nǐ hǎo!)');
  assert.equal((await POST('/ai/test', { model: 'google/gemini-3.5-flash-lite' })).status, 400, 'an OpenRouter model still needs the key');
});

test('with only the plan on, a photo note becomes a draft through Claude Code and costs nothing', async () => {
  scenario({
    structured: {
      lessons: [{
        lesson: { title: 'Greetings', titleZh: '打招呼', summary: 'Hello and thanks.', sections: [{ kind: 'vocab', title: 'Words', body: '- 你好' }], grammar: [], dialogue: [] },
        words: [{ hanzi: '你好', pinyin: 'nǐ hǎo', meaning: 'hello' }, { hanzi: '謝謝', pinyin: 'xiè xie', meaning: 'thank you' }],
      }],
    },
  });
  const note = await POST('/notes', {
    title: 'Class 1', text: '你好 nǐ hǎo hello\n謝謝 xiè xie thanks',
    images: [{ name: 'board.png', type: 'image/png', dataUrl: PNG_URL }],
  });
  assert.equal(note.status, 201);
  const started = await POST(`/notes/${note.body.id}/process`, {});
  assert.equal(started.status, 200, started.body?.error);
  const job = await waitForJob(started.body.jobId);
  assert.equal(job.status, 'done', job.error);

  const drafted = (await GET(`/notes/${note.body.id}`)).body;
  assert.equal(drafted.status, 'draft');
  assert.equal(drafted.model, SONNET);
  assert.deepEqual(drafted.draft.lessons[0].words.map((w) => w.hanzi), ['你好', '謝謝']);

  const usage = (await GET('/usage')).body;
  assert.equal(usage.totals.monthUsd, 0);
  assert.equal(usage.totals.includedCalls, 2, 'the connection test and the lesson');
  assert.equal(usage.entries[0].included, true);

  assert.equal((await POST(`/notes/${note.body.id}/import`, {})).status, 200);
});

test('data: every part is counted, and deleting one tidies the parts that point at it', async () => {
  const hand = await POST('/lessons', { title: 'By hand' });
  const word = await POST('/words', { hanzi: '再見', pinyin: 'zài jiàn', meaning: 'goodbye', lessonId: hand.body.id });
  assert.equal(word.status, 201);
  await PUT('/settings', {
    learnerName: 'Learner', theme: 'dark',
    goals: { skills: ['speak'], onboardedAt: '2026-09-14T08:00:00Z' },
    ai: { apiKey: 'sk-or-v1-delete-me-please' },
  });

  const inv = (await GET('/data')).body.parts;
  assert.equal(inv.lessons.count, 2);
  assert.equal(inv.words.count, 3);
  assert.equal(inv.notes.count, 1);
  assert.equal(inv.notes.photos, 1);
  assert.ok(inv.progress.xpTotal > 0, 'the import paid XP');
  assert.equal(inv.usage.calls, 2);
  assert.equal(inv.goals.answered, true);
  assert.deepEqual(inv.profile.set, ['learnerName']);
  assert.ok(inv.preferences.changed.includes('theme') && inv.preferences.changed.includes('models'));
  assert.equal(inv.apiKey.source, 'settings');
  assert.equal(inv.documents.empty, true);

  for (const [body, why] of [
    [{ parts: ['words'] }, 'no confirmation'],
    [{ parts: ['words'], confirm: 'yes' }, 'the wrong confirmation'],
    [{ parts: [], confirm: 'delete' }, 'nothing named'],
    [{ parts: ['homework'], confirm: 'delete' }, 'a part that does not exist'],
  ]) {
    assert.equal((await POST('/data/delete', body)).status, 400, why);
  }
  assert.equal(coll('words').all().length, 3, 'a refused request deleted nothing');

  const lessons = await POST('/data/delete', { parts: ['lessons'], confirm: 'delete' });
  assert.equal(lessons.status, 200);
  assert.deepEqual(lessons.body.deleted, ['lessons']);
  assert.equal(lessons.body.parts.lessons.count, 0);
  assert.equal(coll('words').all().length, 3, 'the words stay');
  assert.ok(coll('words').all().every((w) => !w.lessonId), 'no word is filed under a deleted lesson');
  assert.deepEqual(coll('notes').all()[0].imported.lessonIds, [], 'the note no longer points at its lesson');

  const words = await POST('/data/delete', { parts: ['words'], confirm: 'delete' });
  assert.equal(words.body.parts.words.count, 0);
  assert.deepEqual(coll('notes').all()[0].imported.wordIds, [], 'nor at its words');

  const notes = await POST('/data/delete', { parts: ['notes'], confirm: 'delete' });
  assert.equal(notes.body.parts.notes.count, 0);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'uploads')), [], 'the photos are gone from disk');

  const reset = await POST('/data/delete', { parts: ['goals', 'profile', 'preferences', 'apiKey'], confirm: 'delete' });
  assert.equal(reset.status, 200);
  const s = reset.body.settings;
  assert.equal(s.goals.onboardedAt, null, 'the welcome questions come back');
  assert.equal(s.learnerName, '');
  assert.equal(s.theme, 'system');
  assert.deepEqual(s.ai.priority, DEFAULT_SETTINGS.ai.priority, 'the plan switches reset with the order');
  assert.equal(s.ai.hasApiKey, false);
  assert.equal(s.ai.apiKey, undefined);
  assert.equal(reset.body.parts.preferences.empty, true);
  assert.equal(reset.body.parts.apiKey.empty, true);
  assert.ok(reset.body.stats, 'the reply carries fresh stats for the header');
});

test('data: deleting everything leaves the defaults, empty folders and no set-aside copies', async () => {
  await POST('/words', { hanzi: '水', meaning: 'water' });
  await PUT('/settings', { learnerName: 'Learner', ai: { apiKey: 'sk-or-v1-delete-me-too' } });
  fs.mkdirSync(path.join(dataDir, 'materials', 'abc123'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'materials', 'abc123', 'source.pdf'), '%PDF-1.4');
  fs.writeFileSync(path.join(dataDir, 'words.json.corrupt-1789000000000'), '{ not json');
  await flushAll();

  const res = await POST('/data/delete', { parts: 'all', confirm: 'delete' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.deleted, ['all']);
  for (const [id, part] of Object.entries(res.body.parts)) assert.equal(part.empty, true, `${id} is empty`);
  assert.equal(res.body.settings.ai.hasApiKey, false);
  assert.equal(res.body.settings.goals.onboardedAt, null);
  assert.equal(fs.existsSync(path.join(dataDir, 'materials')), false, 'documents are gone from disk');
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'uploads')), []);
  assert.equal(fs.readdirSync(dataDir).some((f) => f.includes('.corrupt-')), false, 'a set-aside copy of old data goes too');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'words.json'), 'utf8')), [], 'written to disk, not only emptied in memory');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).ai.apiKey, '', 'the key is gone from the file');
});
