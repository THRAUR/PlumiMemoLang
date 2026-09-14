/* Documents on disk: page counts, page images, text layers, and office files → PDF.

   Every tool is a separate program (poppler, LibreOffice) started WITHOUT a shell,
   with a timeout, a cap on its output and a minimal environment: a file name can
   never become a command, a hung converter can never hold a request forever, and
   the app's own environment (the OpenRouter key when it comes from .env) never
   reaches a child process. A missing tool is a missing capability, not a crash:
   capabilities() says what this machine can do and, when it cannot, why. */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const OFFICE_EXTENSIONS = ['.docx', '.doc', '.pptx', '.ppt', '.odt', '.odp', '.rtf'];

function childEnv() {
  return { PATH: process.env.PATH || '/usr/bin:/bin', HOME: os.homedir(), LANG: 'C.UTF-8' };
}

/* Present means "the binary starts"; ENOENT is the only answer that means absent. */
function installed(bin) {
  const r = spawnSync(bin, ['-v'], { stdio: 'ignore', timeout: 8000, env: childEnv() });
  return !(r.error && r.error.code === 'ENOENT');
}

export function run(bin, args, { timeoutMs = 60000, maxBytes = 64 * 1024 * 1024, cwd } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
    const out = [];
    let size = 0;
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(reject, new Error(`${bin} took too long.`));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      size += d.length;
      if (size > maxBytes) child.kill('SIGKILL');
      else out.push(d);
    });
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d.toString('utf8'); });
    child.on('error', (e) => done(reject, e.code === 'ENOENT' ? new Error(`${bin} is not installed.`) : e));
    child.on('close', (code) => {
      if (size > maxBytes) return done(reject, new Error(`${bin} produced more output than expected.`));
      done(resolve, { stdout: Buffer.concat(out), stderr: err, code });
    });
  });
}

/* ---------- what this machine can do ---------- */

let probing = null;

export function capabilities({ refresh = false } = {}) {
  if (probing && !refresh) return probing;
  probing = (async () => {
    const out = { documents: false, office: false, officeTypes: [], reasons: {} };
    const missing = ['pdfinfo', 'pdftoppm', 'pdftotext'].filter((b) => !installed(b));
    if (missing.length) out.reasons.documents = `This machine is missing ${missing.join(', ')} (the poppler-utils package), so PDFs cannot be read.`;
    else out.documents = true;
    if (!installed('soffice')) {
      out.reasons.office = 'LibreOffice is not installed, so Word and PowerPoint files cannot be converted. Upload a PDF instead.';
    } else {
      // Real conversions of tiny files, one per LibreOffice part: it can be installed
      // without Writer or Impress, and then those conversions fail in 300 ms. This
      // machine, for one, has Impress but no Writer.
      const cannot = [];
      try { await probeOffice('rtf'); out.officeTypes.push('.docx', '.doc', '.odt', '.rtf'); } catch { cannot.push('Word files'); }
      try { await probeOffice('pptx'); out.officeTypes.push('.pptx', '.ppt', '.odp'); } catch { cannot.push('PowerPoint files'); }
      out.office = out.officeTypes.length > 0;
      if (cannot.length) out.reasons.office = `LibreOffice on this machine cannot convert ${cannot.join(' or ')}. Upload a PDF instead.`;
    }
    return out;
  })();
  return probing;
}

async function probeOffice(kind) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'pml-probe-'));
  try {
    const src = path.join(work, `probe.${kind}`);
    if (kind === 'rtf') await fs.writeFile(src, '{\\rtf1\\ansi Plumi probe}');
    // A one-slide deck made with pptxgenjs; LibreOffice cannot be asked to invent one.
    else await fs.copyFile(new URL('./probe.pptx', import.meta.url), src);
    const { cleanup } = await convertToPdf(src, { timeoutMs: 60000 });
    await cleanup();
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

/* ---------- reading a PDF ---------- */

/* The first bytes decide, not the extension a phone gave the file. */
export async function sniff(file) {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await fh.read(buf, 0, 1024, 0);
    const head = buf.subarray(0, bytesRead);
    if (head.indexOf('%PDF-') !== -1) return 'pdf';               // some PDFs carry junk before the header
    if (head[0] === 0x50 && head[1] === 0x4b) return 'zip';        // docx, pptx, odt, odp
    if (bytesRead >= 4 && head.readUInt32BE(0) === 0xd0cf11e0) return 'ole';   // doc, ppt
    if (head.subarray(0, 5).toString('latin1') === '{\\rtf') return 'rtf';
    return 'unknown';
  } finally {
    await fh.close();
  }
}

export async function pageCount(file) {
  const { stdout, stderr, code } = await run('pdfinfo', [file], { timeoutMs: 30000, maxBytes: 1024 * 1024 });
  const m = /^Pages:\s+(\d+)/m.exec(stdout.toString('utf8'));
  if (code !== 0 || !m) {
    if (/password|encrypt/i.test(stderr)) throw new Error('This PDF is password-protected. Remove the password and upload it again.');
    throw new Error('This file is not a PDF this machine can read.');
  }
  return Number(m[1]);
}

/* One page as a JPEG, written to `out`. `width` sizes a thumbnail by its width;
   `longSide` sizes a page for the model by its longest side. */
export async function renderPage(file, page, out, { width = 0, longSide = 0, quality = 80 } = {}) {
  const base = out.replace(/\.jpe?g$/i, '');
  const size = width ? ['-scale-to-x', String(width), '-scale-to-y', '-1'] : ['-scale-to', String(longSide || 1400)];
  const { code, stderr } = await run('pdftoppm', [
    '-f', String(page), '-l', String(page), ...size,
    '-jpeg', '-jpegopt', `quality=${quality}`, '-singlefile', file, base,
  ], { timeoutMs: 60000, maxBytes: 1024 * 1024 });
  if (code !== 0) throw new Error(`Page ${page} could not be drawn${stderr ? `: ${stderr.trim().slice(0, 120)}` : '.'}`);
  const written = `${base}.jpg`;
  if (written !== out) await fs.rename(written, out);
  return out;
}

/* The text a PDF carries for one page ("" for a scan without OCR). */
export async function pageText(file, page, { maxChars = 4000 } = {}) {
  try {
    const { stdout, code } = await run('pdftotext', ['-f', String(page), '-l', String(page), '-layout', '-enc', 'UTF-8', file, '-'], {
      timeoutMs: 30000, maxBytes: 8 * 1024 * 1024,
    });
    if (code !== 0) return '';
    return stdout.toString('utf8').replace(/\f/g, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars);
  } catch {
    return '';
  }
}

export async function hasTextLayer(file, pages) {
  for (let p = 1; p <= Math.min(3, pages); p++) {
    if ((await pageText(file, p, { maxChars: 400 })).replace(/\s+/g, '').length > 20) return true;
  }
  return false;
}

/* ---------- office → PDF ---------- */

/* LibreOffice keeps a user profile and refuses to run twice on one: every
   conversion gets its own throwaway profile and output folder. The caller moves
   the PDF where it belongs, then calls cleanup(). */
export async function convertToPdf(inputFile, { timeoutMs = 180000 } = {}) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'pml-office-'));
  const cleanup = () => fs.rm(work, { recursive: true, force: true });
  try {
    const { stderr } = await run('soffice', [
      `-env:UserInstallation=file://${path.join(work, 'profile')}`,
      '--headless', '--norestore', '--nologo', '--nodefault',
      '--convert-to', 'pdf', '--outdir', work, inputFile,
    ], { timeoutMs, maxBytes: 1024 * 1024 });
    const file = path.join(work, `${path.basename(inputFile, path.extname(inputFile))}.pdf`);
    try {
      await fs.access(file);
    } catch {
      throw new Error(/could not be loaded/i.test(stderr) ? 'LibreOffice could not open this file' : 'LibreOffice produced no PDF');
    }
    return { file, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
