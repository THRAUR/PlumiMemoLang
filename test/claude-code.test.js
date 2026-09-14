/* server/ai/claude-code.js against a fake `claude` (test/fixtures/fake-claude.mjs):
   the lockdown flags, the environment a child gets, the message and image blocks,
   and how each kind of failure is reported. Nothing here reaches the network or the
   real Claude Code: MEMOLANG_CLAUDE_BIN is the only place the module looks. */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-claude.mjs');
fs.chmodSync(FAKE, 0o755);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'plumi-claude-home-'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'plumi-claude-data-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;          // the home folder on Windows
process.env.DATA_DIR = DATA;
delete process.env.MEMOLANG_DATA_DIR;
process.env.MEMOLANG_CLAUDE_BIN = FAKE;

const {
  claudeChat, claudeStatus, claudeUsable, claudeLimits, findClaude, resetClaudeCache, toClaudeInput, ClaudeCodeError,
} = await import('../server/ai/claude-code.js');

after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(DATA, { recursive: true, force: true });
});

const CALLS = path.join(HOME, 'fake-claude-calls.jsonl');
function scenario(s) { fs.writeFileSync(path.join(HOME, 'fake-claude.json'), JSON.stringify(s)); }
function calls() {
  try { return fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
beforeEach(() => {
  fs.rmSync(CALLS, { force: true });
  scenario({});
  process.env.MEMOLANG_CLAUDE_BIN = FAKE;
  resetClaudeCache();
});

const MESSAGES = [
  { role: 'system', content: 'You are a Mandarin teacher. Goals: speak.' },
  {
    role: 'user',
    content: [
      { type: 'text', text: 'Turn these notes into a lesson.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
      { type: 'image_url', image_url: { url: 'https://example.com/page.png' } },
    ],
  },
];
const ask = (extra = {}) => claudeChat({ model: 'claude-code:sonnet', messages: MESSAGES, timeoutMs: 20000, ...extra });

test('findClaude uses MEMOLANG_CLAUDE_BIN, and nothing else when it is set', () => {
  assert.equal(findClaude(), FAKE);
  assert.equal(claudeUsable(), true);
  process.env.MEMOLANG_CLAUDE_BIN = path.join(HOME, 'no-such-claude');
  resetClaudeCache();
  assert.equal(findClaude(), '', 'a wrong path is not quietly replaced by a real install');
  assert.equal(claudeUsable(), false);
});

test('claudeStatus says installed, logged in and which plan, and never who the account is', async () => {
  const s = await claudeStatus();
  assert.equal(s.installed, true);
  assert.equal(s.version, '9.9.9');
  assert.equal(s.loggedIn, true);
  assert.equal(s.plan, 'max');
  assert.equal(s.authMethod, 'claude.ai');
  assert.ok(!JSON.stringify(s).includes('example.com'), 'no email, no organisation');
  assert.ok(!JSON.stringify(s).includes('00000000-0000'), 'no organisation id');

  scenario({ auth: { loggedIn: false, authMethod: 'none' } });
  const cached = await claudeStatus();
  assert.equal(cached.loggedIn, true, 'answered from the cache for a minute');
  const fresh = await claudeStatus({ refresh: true });
  assert.equal(fresh.loggedIn, false);
  assert.equal(claudeUsable(), false, 'known to be logged out');
});

test('claudeChat locks the command down and sends the prompt, the image and the schema', async () => {
  const structured = { reply: '你好' };
  scenario({ structured });
  process.env.ANTHROPIC_API_KEY = 'sk-ant-must-not-leak';
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-must-not-leak';
  const schema = { type: 'object', properties: { reply: { type: 'string' } } };
  let out;
  try {
    out = await ask({ schema });
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  }
  assert.deepEqual(out.json, structured);
  assert.equal(out.model, 'claude-code:sonnet');
  assert.deepEqual(out.usage, { promptTokens: 312, completionTokens: 80, totalTokens: 392, cost: 0, included: true, listCost: 0.0123 });

  const [call] = calls();
  const after = (name) => call.argv[call.argv.indexOf(name) + 1];
  for (const flag of ['-p', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) {
    assert.ok(call.argv.includes(flag), `${flag} is passed`);
  }
  assert.equal(after('--tools'), '', 'no tools at all');
  assert.equal(after('--model'), 'sonnet');
  assert.equal(after('--effort'), 'low');
  assert.equal(after('--input-format'), 'stream-json');
  assert.equal(after('--output-format'), 'stream-json');
  assert.equal(after('--permission-prompts'), 'none');
  assert.deepEqual(JSON.parse(after('--json-schema')), schema);
  assert.equal(call.system, 'You are a Mandarin teacher. Goals: speak.', 'the system prompt travels as a file');
  assert.ok(!call.argv.some((a) => a.includes('Goals: speak')), 'and never as an argument');
  assert.deepEqual(call.envNames.filter((n) => /KEY|TOKEN|ANTHROPIC|OPENROUTER|SECRET/i.test(n)), [], 'no key reaches the command');
  assert.ok(call.envNames.includes(process.platform === 'win32' ? 'USERPROFILE' : 'HOME'), 'the home folder is where the login lives');
  const content = call.message.message.content;
  assert.deepEqual(content.map((c) => c.type), ['text', 'image'], 'a web address is not passed on');
  assert.deepEqual(content[1].source, { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' });
  assert.equal(fs.existsSync(call.cwd), false, 'the work folder is removed afterwards');
  assert.equal(claudeLimits().fiveHour.utilization, 0.42, 'the plan windows are remembered');
});

test('a plan at its usage limit fails the whole plan, and says until when', async () => {
  scenario({ mode: 'limit' });
  await assert.rejects(() => claudeChat({ model: 'claude-code:haiku', messages: MESSAGES, timeoutMs: 20000 }), (e) => {
    assert.ok(e instanceof ClaudeCodeError);
    assert.equal(e.scope, 'provider');
    assert.equal(e.code, 'limit');
    assert.match(e.message, /^Your Claude plan has reached its usage limit until /);
    return true;
  });
  assert.equal(claudeLimits().status, 'rejected');
});

test('logged out, a model the plan lacks, a crash and prose instead of JSON each say what happened', async () => {
  scenario({ mode: 'login' });
  await assert.rejects(ask, (e) => e.scope === 'provider' && e.code === 'login' && /not logged in/.test(e.message));
  scenario({ mode: 'badmodel' });
  await assert.rejects(() => claudeChat({ model: 'claude-code:opus', messages: MESSAGES, timeoutMs: 20000 }), (e) => e.scope === 'model' && /cannot use Claude Opus/.test(e.message));
  scenario({ mode: 'crash' });
  await assert.rejects(ask, (e) => e.scope === 'model' && /boom/.test(e.message));
  scenario({ mode: 'nojson' });
  await assert.rejects(() => ask({ schema: { type: 'object' } }), (e) => e.scope === 'model' && /usable JSON/.test(e.message) && e.usage?.included === true);
});

test('a slow answer times out, a cancel stops at once, and a session that has tools is stopped', async () => {
  scenario({ mode: 'slow' });
  const t0 = Date.now();
  await assert.rejects(() => ask({ timeoutMs: 400 }), (e) => e.code === 'timeout' && e.scope === 'model');
  assert.ok(Date.now() - t0 < 4000, 'the process is killed, not waited for');

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  await assert.rejects(() => ask({ signal: ac.signal }), (e) => e.scope === 'stop' && e.message === 'Cancelled.');

  scenario({ mode: 'tools' });
  const t1 = Date.now();
  await assert.rejects(ask, (e) => e.code === 'unsafe' && e.scope === 'provider');
  assert.ok(Date.now() - t1 < 4000, 'stopped as soon as the session announced its tools');
  await assert.rejects(() => ask({ schema: { type: 'object' } }), (e) => e.code === 'unsafe',
    'with a schema only StructuredOutput is allowed, not one tool more');
});

test('without Claude Code the plan cannot answer, and only plan models are accepted', async () => {
  process.env.MEMOLANG_CLAUDE_BIN = path.join(HOME, 'nope');
  resetClaudeCache();
  await assert.rejects(ask, (e) => e.code === 'not-installed' && e.scope === 'provider');
  const s = await claudeStatus({ refresh: true });
  assert.equal(s.installed, false);
  assert.equal(s.loggedIn, false);
  await assert.rejects(() => claudeChat({ model: 'google/gemini-3.5-flash-lite', messages: MESSAGES }), /not a Claude plan model/);
});

test('toClaudeInput folds the system turns into one prompt and keeps the rest in order', () => {
  const { system, content } = toClaudeInput([
    { role: 'system', content: 'A' },
    { role: 'user', content: 'B' },
    { role: 'assistant', content: 'C' },
    { role: 'user', content: [{ type: 'text', text: 'D' }, { type: 'image_url', image_url: { url: 'data:image/tiff;base64,AAAA' } }] },
  ]);
  assert.equal(system, 'A');
  assert.deepEqual(content, [
    { type: 'text', text: 'B' },
    { type: 'text', text: 'Your earlier answer:\nC' },
    { type: 'text', text: 'D' },
  ], 'an image type Claude cannot read is dropped');
});
