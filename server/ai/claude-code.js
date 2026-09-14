/* Claude Code as a model provider: the learner's own Claude plan (Pro, Max, …),
   through the `claude` command installed and logged in on this computer. What it
   answers is included in that plan, so it costs no OpenRouter credits. It does
   count toward the plan's usage limits, the same ones the learner's own Claude
   chats and Claude Code sessions use.

   Claude Code is a coding agent, so every call is locked down to a plain model
   call (checked on 2.1.270: the init event lists `mcp_servers: []` and `tools: []`, or
   only `StructuredOutput` when a schema is passed):
     --tools ""               no built-in tools: no shell, no files, no web
     --safe-mode              no CLAUDE.md, plugins, hooks, skills or MCP servers
     --strict-mcp-config      no MCP servers from any other config either
     --no-session-persistence nothing is written to ~/.claude/projects
     --disable-slash-commands
   A lesson built from a stranger's PDF cannot talk the model into running anything,
   because there is nothing to run. If a later version ever starts a session with
   tools anyway, the call is stopped before the model answers.

   Like every tool this app starts (server/lib/documents.js), it runs without a
   shell, with a timeout, an output cap and a minimal environment: HOME (where the
   login lives), USER, LOGNAME, LANG and PATH. Never ANTHROPIC_API_KEY: with an API
   key in its environment the CLI bills that key instead of the plan. And never
   OPENROUTER_API_KEY, which no child process gets.

   Effort, measured 2026-09-14 with Sonnet turning a six-line class note into one
   lesson: the default took 106 s and 13.5k output tokens, `--effort low` took 43 s
   and 5.1k tokens with the same structure (five sections, a seven-line dialogue,
   correct readings). Tasks run at low effort unless TASKS in ./tasks.js says
   otherwise. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { planModel } from './models.js';
import { extractJson } from '../openrouter.js';

const BIN_TTL_MS = 30 * 1000;
const STATUS_TTL_MS = 60 * 1000;
const STATUS_TIMEOUT_MS = 15 * 1000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;     // a 20-page lesson answers in well under 1 MB
const MAX_RUNNING = 2;                        // more lessons queue instead of stacking processes
const KILL_GRACE_MS = 3000;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export class ClaudeCodeError extends Error {
  /* `scope` says how far a failure reaches, for runTask()'s fallback:
       model     this model only: a timeout, an unusable answer, a model the plan lacks
       provider  every plan model alike: not installed, logged out, usage limit reached
       stop      nothing else should run: the learner cancelled */
  constructor(message, { scope = 'model', code = '', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ClaudeCodeError';
    this.provider = 'claude-code';
    this.scope = scope;
    this.code = code;
  }
}

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/* ── finding the command ─────────────────────────────────────────────────── */

let binCache = null;       // { at, path }
let statusCache = null;    // { at, value }
let limits = null;         // the plan's usage windows, from the last call that reported them

/* Where the command lives. MEMOLANG_CLAUDE_BIN (set in .env) is the only place
   looked at when it is set, so a test pointing at a fake never reaches the real
   one. The native installer puts `claude` in ~/.local/bin, which a pm2 service's
   PATH does not include, so the known install places are checked before PATH. */
export function findClaude() {
  if (binCache && Date.now() - binCache.at < BIN_TTL_MS) return binCache.path;
  const forced = String(process.env.MEMOLANG_CLAUDE_BIN || '').trim();
  const home = os.homedir();
  const candidates = forced ? [forced] : [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'claude')),
  ];
  let found = '';
  for (const file of candidates) {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) { found = file; break; }
    } catch { /* not here */ }
  }
  binCache = { at: Date.now(), path: found };
  return found;
}

export function resetClaudeCache() {
  binCache = null;
  statusCache = null;
  limits = null;
}

/* HOME is where the login lives; PATH is kept so the command finds the programs it
   expects. Nothing else from this process's environment is passed on. */
function childEnv() {
  const env = {};
  for (const name of ['HOME', 'USER', 'LOGNAME', 'LANG', 'PATH']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.HOME ||= os.homedir();
  env.PATH ||= '/usr/local/bin:/usr/bin:/bin';
  // A helper the learner never sees should not update itself or send reports.
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return env;
}

/* One run of the command. With `onLine`, stdout is read as lines (the stream-json
   events) and `onLine(line, stop)` may stop the run; without it, stdout is
   collected. Resolves when the process has exited, saying how it ended; only a
   command that cannot start at all rejects. */
function run(bin, args, { cwd, input = '', timeoutMs = 60000, signal, onLine = null, maxBytes = MAX_OUTPUT_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let rest = '';
    let stopped = '';
    let settled = false;

    const stop = (why) => {
      if (stopped || settled) return;
      stopped = why;
      child.kill('SIGTERM');
      setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const onAbort = () => stop('abort');
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const line = (text) => {
      if (!text.trim() || stopped) return;
      try { onLine(text, stop); } catch { /* a line that is not an event is skipped */ }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) { stop('overflow'); return; }
      if (!onLine) { stdout += chunk; return; }
      rest += chunk;
      let i;
      while ((i = rest.indexOf('\n')) >= 0) {
        const one = rest.slice(0, i);
        rest = rest.slice(i + 1);
        line(one);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { if (stderr.length < 16000) stderr += chunk; });
    child.stdin.on('error', () => { /* the command exited before reading everything */ });
    child.on('error', (e) => finish(e));
    child.on('close', (code, sig) => {
      if (onLine && rest) line(rest);
      finish(null, code, sig);
    });
    child.stdin.end(input);

    function finish(err, code = null, sig = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve({ code, signal: sig, stdout, stderr, stopped });
    }
  });
}

/* ── status ──────────────────────────────────────────────────────────────── */

/* What Settings shows about the plan. `claude auth status` also reports the
   account's email and organisation; only whether it is logged in, how, and which
   plan ever leave this function. */
export async function claudeStatus({ refresh = false } = {}) {
  if (!refresh && statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return { ...statusCache.value, limits };
  if (refresh) binCache = null;
  const bin = findClaude();
  let value = { installed: false, version: '', loggedIn: false, authMethod: '', plan: '', checkedAt: new Date().toISOString() };
  if (bin) {
    const quiet = { cwd: os.tmpdir(), timeoutMs: STATUS_TIMEOUT_MS, maxBytes: 64 * 1024 };
    const [ver, auth] = await Promise.all([
      run(bin, ['--version'], quiet).catch(() => null),
      run(bin, ['auth', 'status', '--json'], quiet).catch(() => null),
    ]);
    let who = null;
    try { who = JSON.parse(auth?.stdout || ''); } catch { who = null; }
    value = {
      installed: Boolean(ver && !ver.stopped && ver.code === 0),
      version: /\d+\.\d+\.\d+/.exec(ver?.stdout || '')?.[0] || '',
      loggedIn: who?.loggedIn === true,
      authMethod: typeof who?.authMethod === 'string' ? who.authMethod : '',
      plan: typeof who?.subscriptionType === 'string' ? who.subscriptionType : '',
      checkedAt: new Date().toISOString(),
    };
  }
  statusCache = { at: Date.now(), value };
  return { ...value, limits };
}

/* Sync and cheap, for the routes' "can any AI answer?" check: the command is here,
   and it is not known to be logged out. */
export function claudeUsable() {
  if (!findClaude()) return false;
  return statusCache?.value?.loggedIn !== false || Date.now() - statusCache.at >= STATUS_TTL_MS;
}

export function claudeLimits() { return limits; }

function windowOf(w) {
  const u = Number(w?.utilization);
  return Number.isFinite(u) ? { utilization: Math.max(0, Math.min(1, u)), resetsAt: Number(w?.resetsAt) || null } : null;
}

/* The `rate_limit_event` every call reports: how much of the plan's 5-hour and
   7-day windows is used, and when each resets (epoch seconds). */
function readLimits(info) {
  if (!isPlainObject(info)) return null;
  const w = isPlainObject(info.unifiedWindows) ? info.unifiedWindows : {};
  return {
    status: String(info.status || ''),
    resetsAt: Number(info.resetsAt) || null,
    fiveHour: windowOf(w.five_hour),
    sevenDay: windowOf(w.seven_day),
    at: new Date().toISOString(),
  };
}

/* ── the call ────────────────────────────────────────────────────────────── */

let running = 0;
const queue = [];
function acquire() {
  if (running < MAX_RUNNING) { running += 1; return Promise.resolve(); }
  return new Promise((resolve) => queue.push(resolve));      // release() hands the slot over
}
function release() {
  const next = queue.shift();
  if (next) next();
  else running -= 1;
}

function imageBlock(url) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(url || ''));
  if (!m) return null;           // a web address is not fetched: the CLI has no web access here
  const type = m[1].toLowerCase();
  if (!IMAGE_TYPES.includes(type)) return null;
  return { type: 'image', source: { type: 'base64', media_type: type, data: m[2] } };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.type === 'text' ? p.text || '' : '')).join('');
  return '';
}

/* The OpenAI-style messages server/ai/prompts.js builds → one system prompt and one
   user turn of Anthropic content blocks. prompts.js only ever builds [system, user];
   anything else is folded into the user turn in order, so nothing is lost. */
export function toClaudeInput(messages) {
  const system = [];
  const content = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.role === 'system') {
      const s = textOf(m.content).trim();
      if (s) system.push(s);
      continue;
    }
    const parts = Array.isArray(m?.content) ? m.content : [{ type: 'text', text: String(m?.content ?? '') }];
    for (const p of parts) {
      if (p?.type === 'text' && p.text) {
        content.push({ type: 'text', text: m.role === 'assistant' ? `Your earlier answer:\n${p.text}` : p.text });
      } else if (p?.type === 'image_url') {
        const block = imageBlock(p.image_url?.url);
        if (block) content.push(block);
      }
    }
  }
  if (!content.length) content.push({ type: 'text', text: '(empty)' });
  return { system: system.join('\n\n'), content };
}

function usageOf(result) {
  const u = isPlainObject(result?.usage) ? result.usage : {};
  const promptTokens = (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0);
  const completionTokens = Number(u.output_tokens) || 0;
  const list = Number(result?.total_cost_usd);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, cost: 0, included: true, listCost: Number.isFinite(list) ? list : null };
}

/* When a limit resets, on this server's clock: "4:00 PM", or "Sep 16, 4:00 PM". */
function resetTime(epochSeconds) {
  const n = Number(epochSeconds);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n * 1000);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}

/* What the CLI said (the result text, then stderr) → one sentence and its scope. */
function failure(said, code, info, seen) {
  const s = String(said || '').replace(/\s+/g, ' ').trim();
  if (seen?.status === 'rejected' || /usage limit|limit reached|hit your limit|out of extra usage/i.test(s)) {
    const until = resetTime(seen?.resetsAt);
    return new ClaudeCodeError(`Your Claude plan has reached its usage limit${until ? ` until ${until}` : ' for now'}.`, { scope: 'provider', code: 'limit' });
  }
  if (/not logged in|\/login|invalid api key|authentication|oauth token|unauthori[sz]ed/i.test(s)) {
    return new ClaudeCodeError('Claude Code on this computer is not logged in. Run claude in a terminal once and log in with your Claude account.', { scope: 'provider', code: 'login' });
  }
  if (/unrecognized_model|issue with the selected model|may not exist or you may not have access/i.test(s)) {
    return new ClaudeCodeError(`Your Claude plan cannot use ${info.name} right now.`, { scope: 'model', code: 'model' });
  }
  const detail = s.length > 200 ? `${s.slice(0, 200)}…` : s;
  return new ClaudeCodeError(detail ? `Claude Code failed: ${detail}` : `Claude Code stopped without an answer (exit ${code}).`, { scope: 'model' });
}

/* One completion, in the shape openrouter.chat() returns, so runTask() treats both
   providers alike:
   → { text, json, usage: { promptTokens, completionTokens, totalTokens, cost: 0, included: true, listCost }, model, id }
   `listCost` is what the CLI says the call would have cost at API prices. Nothing is
   charged; Settings shows it as what the plan covered. */
export async function claudeChat({ model, messages, schema = null, effort = 'low', timeoutMs = 300000, signal } = {}) {
  const info = planModel(model);
  if (!info) throw new ClaudeCodeError(`${model || 'That model'} is not a Claude plan model.`, { scope: 'model' });
  if (signal?.aborted) throw new ClaudeCodeError('Cancelled.', { scope: 'stop' });
  const bin = findClaude();
  if (!bin) {
    throw new ClaudeCodeError('Claude Code is not installed on this computer, so your Claude plan cannot answer.', { scope: 'provider', code: 'not-installed' });
  }
  const { system, content } = toClaudeInput(messages);

  await acquire();
  let work = null;
  try {
    work = await fsp.mkdtemp(path.join(os.tmpdir(), 'pml-claude-'));
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--model', info.cli, '--effort', EFFORTS.includes(effort) ? effort : 'low',
      '--tools', '', '--safe-mode', '--strict-mcp-config', '--no-session-persistence',
      '--disable-slash-commands', '--permission-prompts', 'none',
    ];
    if (system) {
      // A file, not an argument: the system prompt carries the learner's goals and
      // their own words, which do not belong in `ps`.
      const file = path.join(work, 'system.txt');
      await fsp.writeFile(file, system, 'utf8');
      args.push('--system-prompt-file', file);
    }
    if (schema) args.push('--json-schema', JSON.stringify(schema));
    const input = `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;

    let result = null;
    let seen = null;
    const ran = await run(bin, args, {
      cwd: work, input, timeoutMs, signal,
      onLine: (text, stop) => {
        const event = JSON.parse(text);
        if (event?.type === 'system' && event.subtype === 'init') {
          // A session that came up with tools or MCP servers is stopped before the model
          // answers. The one exception is StructuredOutput, the tool Claude Code adds when
          // a schema is passed (2.1.270): it only hands the JSON back.
          const allowed = schema ? ['StructuredOutput'] : [];
          const tools = Array.isArray(event.tools) ? event.tools : [];
          if (tools.some((t) => !allowed.includes(t)) || (event.mcp_servers || []).length) stop('unsafe');
        } else if (event?.type === 'rate_limit_event') {
          seen = readLimits(event.rate_limit_info) || seen;
          if (seen) limits = seen;
        } else if (event?.type === 'result') {
          result = event;
        }
      },
    }).catch((e) => {
      throw new ClaudeCodeError(
        e?.code === 'ENOENT' || e?.code === 'EACCES' ? 'Claude Code could not be started on this computer.' : `Claude Code could not be started: ${e?.message || e}`,
        { scope: 'provider', code: 'not-installed', cause: e },
      );
    });

    if (ran.stopped === 'abort') throw new ClaudeCodeError('Cancelled.', { scope: 'stop' });
    if (ran.stopped === 'unsafe') {
      throw new ClaudeCodeError('Claude Code started with tools switched on, so Plumi stopped it before it answered.', { scope: 'provider', code: 'unsafe' });
    }
    if (ran.stopped === 'timeout') throw new ClaudeCodeError(`${info.name} did not answer in time.`, { scope: 'model', code: 'timeout' });
    if (ran.stopped === 'overflow') throw new ClaudeCodeError(`${info.name} answered with more than this app reads.`, { scope: 'model' });

    const usage = usageOf(result);
    if (!result || result.is_error || result.subtype !== 'success') {
      const err = failure(`${typeof result?.result === 'string' ? result.result : ''}\n${ran.stderr}`, ran.code, info, seen);
      err.usage = usage;
      throw err;
    }
    const text = typeof result.result === 'string' ? result.result : '';
    let json = null;
    if (schema) {
      json = isPlainObject(result.structured_output) ? result.structured_output : null;
      if (!json) {
        try {
          json = extractJson(text);
        } catch (e) {
          const err = new ClaudeCodeError(`${info.name} did not return usable JSON.`, { scope: 'model', cause: e });
          err.usage = usage;
          throw err;
        }
      }
    } else if (!text.trim()) {
      const err = new ClaudeCodeError(`${info.name} returned an empty answer.`, { scope: 'model' });
      err.usage = usage;
      throw err;
    }
    return { text, json, usage, model: info.id, id: typeof result.session_id === 'string' ? result.session_id : null };
  } finally {
    release();
    if (work) await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
