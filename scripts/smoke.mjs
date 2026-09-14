/* Start PlumiMemoLang for real and check that it answers.

     npm run smoke                    node server/index.js, the way `npm start` runs it
     npm run smoke -- --launcher      the double-click file for this system instead:
                                      start-windows.cmd on Windows, start-mac.command
                                      everywhere else (it is plain bash)

   The unit tests import the modules but never start the process, and nobody can
   double-click a launcher on a CI runner. So CI runs this with --launcher on macOS,
   Windows and Linux before `npm ci`: the launcher has to install the packages itself,
   start the app and try to open the browser, and then the page, its first modules and
   the API must answer. The app gets a spare port (SMOKE_PORT, 3099 by default) and a
   throwaway data folder through the environment, which wins over .env, and a launcher
   is started from another folder, as a double-click would be. Nothing here touches
   ./data. */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WINDOWS = process.platform === 'win32';
const LAUNCHER = process.argv.includes('--launcher');
const PORT = Number(process.env.SMOKE_PORT) || 3099;
const BASE = `http://127.0.0.1:${PORT}`;
// A launcher's first start installs the packages before the app can answer.
const READY_MS = LAUNCHER ? 240_000 : 30_000;

// What a working start serves: the page, the first module and stylesheet it loads,
// a module from shared/, and the API.
const CHECKS = [
  ['/', 'text/html', 'src="/app.js"'],
  ['/app.js', 'javascript', 'import'],
  ['/plume.css', 'text/css', '--accent'],
  ['/shared/zhuyin.js', 'javascript', 'export'],
  ['/api/settings', 'application/json', '"nativeLanguage"'],
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(pathname) {
  const res = await fetch(BASE + pathname, { signal: AbortSignal.timeout(5000) });
  return { status: res.status, type: res.headers.get('content-type') || '', text: await res.text() };
}

async function answers() {
  try { await get('/api/health'); return true; } catch { return false; }
}

function start(env) {
  const stdio = ['ignore', 'pipe', 'pipe'];
  if (!LAUNCHER) {
    return { name: 'server/index.js', child: spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio }) };
  }
  if (IS_WINDOWS) {
    // A .cmd file only runs inside cmd.exe. The quoting is the one Node itself uses
    // for shell: true, so a folder with spaces in its name works too.
    const file = path.join(ROOT, 'start-windows.cmd');
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${file}""`], {
      cwd: os.tmpdir(), env, stdio, windowsVerbatimArguments: true, windowsHide: true,
    });
    return { name: 'start-windows.cmd', child };
  }
  // The file itself, not `bash file`: a double-click needs the executable bit and the
  // #! line as well. In its own process group, so one signal reaches npm and node.
  const file = path.join(ROOT, 'start-mac.command');
  return { name: 'start-mac.command', child: spawn(file, [], { cwd: os.tmpdir(), env, stdio, detached: true }) };
}

// Closing a launcher's window stops everything it started; do the same.
function stop(child) {
  if (!child.pid) return;
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else if (LAUNCHER) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  } else {
    child.kill('SIGTERM');
  }
}

if (await answers()) {
  console.error(`Something already answers on ${BASE}. Stop it, or pick another port with SMOKE_PORT.`);
  process.exit(1);
}

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'plumi-smoke-'));
const env = { ...process.env, MEMOLANG_PORT: String(PORT), MEMOLANG_HOST: '127.0.0.1', MEMOLANG_DATA_DIR: data, DATA_DIR: data };
const { name, child } = start(env);
let output = '';
let ended = null;
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
const exited = new Promise((resolve) => {
  child.on('exit', (code, signal) => { ended ??= `${name} stopped (exit ${code ?? signal}) before the app answered`; resolve(); });
  child.on('error', (err) => { ended ??= `${name} could not start (${err.code || err.message})`; resolve(); });
});

const failures = [];
let ours = false;
try {
  const deadline = Date.now() + READY_MS;
  let health = null;
  while (!health) {
    if (ended) throw new Error(ended);
    if (Date.now() > deadline) throw new Error(`the app did not answer within ${READY_MS / 1000} s`);
    const r = await get('/api/health').catch(() => null);
    if (r?.status === 200) health = JSON.parse(r.text);
    else await wait(500);
  }
  // This process, with this data folder: not another copy of the app that was already running.
  ours = health.ok === true && path.basename(String(health.dataDir)) === path.basename(data);
  if (!ours) throw new Error(`/api/health answered with another data folder: ${health.dataDir}`);
  console.log(`ok  ${name} started the app`);
  for (const [pathname, type, needle] of CHECKS) {
    const r = await get(pathname);
    if (r.status === 200 && r.type.includes(type) && r.text.includes(needle)) console.log(`ok  GET ${pathname}`);
    else failures.push(`GET ${pathname} answered ${r.status} ${r.type || '(no content type)'}`);
  }
} catch (err) {
  failures.push(err.message);
} finally {
  stop(child);
  if (ours) {
    const until = Date.now() + 15_000;
    while (Date.now() < until && await answers()) await wait(500);
    if (await answers()) failures.push(`the app kept running after ${name} was stopped`);
  }
  await Promise.race([exited, wait(5000)]);
  child.stdout.destroy();
  child.stderr.destroy();
  fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

if (failures.length) {
  console.error(`\nThe smoke test failed:\n- ${failures.join('\n- ')}\n\n--- what ${name} printed ---\n${output.trim()}`);
  process.exitCode = 1;
} else {
  console.log(`\nPlumiMemoLang starts${LAUNCHER ? ` from ${name}` : ''} and serves the app.`);
}
// A browser the app opened, or a pipe it left behind, must not keep a CI job waiting.
setTimeout(() => process.exit(), 3000).unref();
