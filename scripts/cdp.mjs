#!/usr/bin/env node
/* Tiny CDP driver for QA — no dependencies (Node 22 has WebSocket).
     node scripts/cdp.mjs <url> <out.png> [width] [height] [steps...]
   Each step is "click:<css>", "type:<css>:<text>", "key:<Key>", "wait:<ms>",
   "eval:<js>", "shot:<file.png>". Console errors and uncaught exceptions are
   printed; the exit code is 1 if any occurred. */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const [,, url, out = '/tmp/cdp.png', w = '390', h = '844', ...steps] = process.argv;
const CH = process.env.CHROME || path.join(os.homedir(), '.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell');
const port = 9300 + Math.floor(Math.random() * 500);
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'cdp-'));
const chrome = spawn(CH, ['--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${w},${h}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = async () => { chrome.kill(); await fs.rm(profile, { recursive: true, force: true }).catch(() => {}); };

async function target() {
  for (let i = 0; i < 50; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const t = list.find((x) => x.type === 'page'); if (t) return t; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('chrome did not start');
}
const t = await target();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map(); const problems = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); return; }
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) problems.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
  if (m.method === 'Runtime.exceptionThrown') problems.push(`uncaught: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.value;
const shot = async (file) => { const { data } = await send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(file, Buffer.from(data, 'base64')); console.log('shot', file); };

try {
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: Number(w), height: Number(h), deviceScaleFactor: 1, mobile: Number(w) < 700 });
  await send('Page.navigate', { url });
  await sleep(1500);
  for (const step of steps) {
    const [kind, ...rest] = step.split(':');
    const arg = rest.join(':');
    if (kind === 'click') {
      const ok = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(arg)}); if (!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true; })()`);
      if (!ok) problems.push(`click: no element for ${arg}`);
      await sleep(500);
    } else if (kind === 'type') {
      const [sel, ...txt] = rest; const text = txt.join(':');
      await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`);
      await sleep(300);
    } else if (kind === 'key') {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: arg, code: arg, windowsVirtualKeyCode: arg === 'Enter' ? 13 : arg === ' ' ? 32 : arg.charCodeAt(0) });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: arg, code: arg });
      await sleep(400);
    } else if (kind === 'wait') await sleep(Number(arg) || 500);
    else if (kind === 'eval') console.log('eval →', JSON.stringify(await evalJs(arg)));
    else if (kind === 'shot') await shot(arg);
  }
  await shot(out);
} finally {
  ws.close();
  await cleanup();
}
if (problems.length) { console.log('PROBLEMS:'); for (const p of problems) console.log(' -', p); process.exit(1); }
console.log('no console errors');
