#!/usr/bin/env node
/* A stand-in for the `claude` command in tests (MEMOLANG_CLAUDE_BIN points here).
   It never touches the network. Its behaviour comes from fake-claude.json in the home
   folder, because the app passes a child process only a few variables and the home
   folder is one of them. Every model run is appended to fake-claude-calls.jsonl next
   to it, so a test can check the flags, the environment and the message the app sent.
   The app starts it through Node, so it also runs on Windows.

   Modes: ok (default) · limit · login · badmodel · crash · nojson · slow · tools */
import fs from 'node:fs';
import path from 'node:path';

const home = process.env.HOME || process.env.USERPROFILE || '';
let scenario = {};
try { scenario = JSON.parse(fs.readFileSync(path.join(home, 'fake-claude.json'), 'utf8')); } catch { scenario = {}; }
const argv = process.argv.slice(2);
// With no arguments (a test runner that collects every .mjs file under test/ runs it
// that way) there is nothing to answer: exit at once instead of waiting on stdin.
if (!argv.length) process.exit(0);
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

if (argv[0] === '--version') {
  process.stdout.write(`${scenario.version || '9.9.9'} (Claude Code)\n`);
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  const auth = scenario.auth || {
    loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
    email: 'learner@example.com', orgId: '00000000-0000-0000-0000-000000000000', orgName: "learner@example.com's Organization",
    subscriptionType: 'max',
  };
  process.stdout.write(`${JSON.stringify(auth, null, 2)}\n`);
  process.exit(auth.loggedIn ? 0 : 1);
}

let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
let message = null;
try { message = JSON.parse(stdin.split('\n')[0]); } catch { message = null; }
const systemFile = flag('--system-prompt-file');
fs.appendFileSync(path.join(home, 'fake-claude-calls.jsonl'), `${JSON.stringify({
  argv,
  envNames: Object.keys(process.env).sort(),
  cwd: process.cwd(),
  system: systemFile ? fs.readFileSync(systemFile, 'utf8') : null,
  message,
})}\n`);

const mode = scenario.mode || 'ok';
if (mode === 'slow') await sleep(5000);
// Like the real one: a schema brings the StructuredOutput tool, and nothing else.
const schemaTools = flag('--json-schema') !== undefined ? ['StructuredOutput'] : [];
out({ type: 'system', subtype: 'init', model: 'claude-sonnet-5', tools: mode === 'tools' ? [...schemaTools, 'Bash'] : schemaTools, mcp_servers: [], apiKeySource: 'none' });
if (mode === 'tools') await sleep(5000);
out({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: mode === 'limit' ? 'rejected' : 'allowed', resetsAt: 1789363200, rateLimitType: 'five_hour',
    unifiedWindows: { five_hour: { utilization: mode === 'limit' ? 1 : 0.42, resetsAt: 1789363200 }, seven_day: { utilization: 0.05, resetsAt: 1789945200 } },
  },
});
const usage = { input_tokens: 12, cache_creation_input_tokens: 300, cache_read_input_tokens: 0, output_tokens: 80 };

if (mode === 'limit') {
  out({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 4pm", usage, total_cost_usd: 0 });
  process.exit(1);
}
if (mode === 'login') {
  out({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login', usage: {}, total_cost_usd: 0 });
  process.exit(1);
}
if (mode === 'badmodel') {
  process.stderr.write(`[claude-code:unrecognized_model] {"model":"${flag('--model')}"}\n`);
  out({ type: 'result', subtype: 'success', is_error: true, result: `There's an issue with the selected model (${flag('--model')}). It may not exist or you may not have access to it.` });
  process.exit(1);
}
if (mode === 'crash') {
  process.stderr.write('boom\n');
  process.exit(3);
}

const structured = scenario.structured ?? null;
const wantsSchema = flag('--json-schema') !== undefined;
const text = mode === 'nojson' ? 'Sure! Here is no JSON at all.' : scenario.text ?? (structured ? JSON.stringify(structured) : 'pong');
out({
  type: 'result', subtype: 'success', is_error: false,
  result: text,
  structured_output: wantsSchema && mode !== 'nojson' ? structured : undefined,
  usage, total_cost_usd: 0.0123,
  modelUsage: { 'claude-sonnet-5': { costUSD: 0.0123 } },
  session_id: 'fake-session',
});
process.exit(0);
