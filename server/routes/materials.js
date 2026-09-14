/* Documents: a PDF, or a presentation LibreOffice can turn into one, that the
   learner uploads once and picks pages from class after class (§8.6). The file is
   <dataDir>/materials/<id>/source.pdf, thumbnails are cached beside it, and pages
   for the model are rendered per job and never kept. */
import { Router } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { coll, newId } from '../store.js';
import { isPlain } from '../defaults.js';
import { hasApiKey } from '../ai/tasks.js';
import { isAllowedModel } from '../ai/models.js';
import { readSettings } from '../stats.js';
import { capabilities, sniff, pageCount, renderPage, hasTextLayer, convertToPdf, OFFICE_EXTENSIONS } from '../lib/documents.js';
import { materialDir, sourcePdf, removeMaterial } from '../lib/materials.js';
import { parsePages, formatPages } from '../../shared/pages.js';
import { startExtractJob, checkDate } from './notes.js';

const r = Router();

const MAX_BYTES = 500 * 1024 * 1024;
const MAX_PAGES_PER_RUN = 20;
const THUMB_MIN = 120;
const THUMB_MAX = 800;
const RESERVED = /[\\/:*?"<>|]+/g;

function bad(msg, status = 400) { return Object.assign(new Error(msg), { status }); }
function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }

function materialOr404(id) {
  const m = coll('materials').get(id);
  if (!m) throw bad('No such document.', 404);
  return m;
}

/* Shown to the learner and sent back in a Content-Disposition: no control
   characters, no path separators, a sane length. Unicode stays (a Chinese book
   title is a fine file name). */
function displayName(raw) {
  const printable = [...str(raw)].filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127).join('');
  return (printable.replace(RESERVED, '_') || 'document.pdf').slice(-120);
}

r.get('/capabilities', async (req, res) => {
  res.json(await capabilities());
});

/* The body is the file itself (the phone uploads it with XMLHttpRequest for the
   progress bar), streamed straight to disk and counted on the way: a 400 MB scan
   never sits in memory, and a body over the limit is cut off, not buffered. */
r.post('/materials', async (req, res) => {
  const caps = await capabilities();
  if (!caps.documents) throw bad(caps.reasons.documents || 'Documents are not available on this machine.', 503);
  if (req.query.keep === undefined) throw bad('Say whether to keep the document in the library (keep=1 or keep=0).');
  const keep = req.query.keep === '1' || req.query.keep === 'true';
  if (Number(req.headers['content-length'] || 0) > MAX_BYTES) throw bad('That file is larger than 500 MB.', 413);

  const name = displayName(req.query.name);
  const ext = path.extname(name).toLowerCase();
  const id = newId();
  const dir = materialDir(id);
  await fsp.mkdir(dir, { recursive: true });
  const upload = path.join(dir, 'upload.bin');
  let size = 0;
  try {
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > MAX_BYTES) cb(bad('That file is larger than 500 MB.', 413));
        else cb(null, chunk);
      },
    });
    await pipeline(req, counter, fs.createWriteStream(upload));
    if (!size) throw bad('That file is empty.');

    const kind = await sniff(upload);
    const pdf = sourcePdf(id);
    if (kind === 'pdf') {
      await fsp.rename(upload, pdf);
    } else {
      const accepted = caps.officeTypes || [];
      const looksOffice = OFFICE_EXTENSIONS.includes(ext) && ['zip', 'ole', 'rtf'].includes(kind);
      if (!looksOffice) throw bad(`Upload a PDF${accepted.length ? ` or a ${accepted.join(', ')} file` : ''}.`, 415);
      if (!accepted.includes(ext)) throw bad(caps.reasons.office || `This machine cannot convert ${ext} files. Upload a PDF instead.`, 415);
      // LibreOffice names its output after its input, so give it the real extension.
      const named = path.join(dir, `upload${ext}`);
      await fsp.rename(upload, named);
      const { file, cleanup } = await convertToPdf(named);
      try { await fsp.copyFile(file, pdf); } finally { await cleanup(); }
      await fsp.rm(named, { force: true });
    }

    const pages = await pageCount(pdf);
    if (!pages) throw bad('That PDF has no pages.');
    const textLayer = await hasTextLayer(pdf, pages);
    const title = str(req.query.title).slice(0, 120)
      || name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim()
      || 'Document';
    const material = coll('materials').insert({
      id,
      title,
      fileName: name,
      size,
      pageCount: pages,
      kind: 'pdf',
      originalType: kind === 'pdf' ? 'pdf' : ext.slice(1),
      keep,
      pageOffset: 0,
      textLayer,
      covered: [],
    });
    res.status(201).json(material);
  } catch (e) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (e.code === 'ERR_STREAM_PREMATURE_CLOSE' || e.code === 'ECONNRESET') throw bad('The upload was interrupted. Try again.');
    throw e;
  }
});

/* The library: documents the learner kept, plus every "use once" document that has
   not done its job yet, newest first. That is one no note has used so far (uploaded,
   then the phone was closed) and one a note is still waiting on. Without the first
   case an unused upload would sit on disk where no screen can reach it. */
r.get('/materials', (req, res) => {
  const notes = coll('notes').all().filter((n) => n.source?.materialId);
  const used = new Set(notes.map((n) => n.source.materialId));
  const waiting = new Set(notes.filter((n) => n.status !== 'imported').map((n) => n.source.materialId));
  const materials = coll('materials').all()
    .filter((m) => m.keep || waiting.has(m.id) || !used.has(m.id))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  res.json({ materials });
});

r.get('/materials/:id', (req, res) => {
  res.json(materialOr404(req.params.id));
});

r.put('/materials/:id', (req, res) => {
  const m = materialOr404(req.params.id);
  const b = req.body;
  if (!isPlain(b)) throw bad('Send a document object.');
  const patch = {};
  if (b.title !== undefined) {
    const t = str(b.title).slice(0, 120);
    if (!t) throw bad('A document needs a title.');
    patch.title = t;
  }
  if (b.keep !== undefined) patch.keep = Boolean(b.keep);
  if (b.pageOffset !== undefined) {
    const o = Number(b.pageOffset);
    if (!Number.isInteger(o) || Math.abs(o) >= m.pageCount) {
      throw bad(`pageOffset must be a whole number between -${m.pageCount - 1} and ${m.pageCount - 1}.`);
    }
    patch.pageOffset = o;
  }
  res.json(coll('materials').update(m.id, patch));
});

r.delete('/materials/:id', async (req, res) => {
  const m = materialOr404(req.params.id);
  await removeMaterial(m.id);
  res.json({ ok: true });
});

r.get('/materials/:id/file', (req, res, next) => {
  const m = materialOr404(req.params.id);
  const pdfName = `${m.fileName.replace(/\.[^.]+$/, '') || 'document'}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(pdfName)}`);
  res.sendFile(sourcePdf(m.id), (err) => {
    if (err && !res.headersSent) next(bad('The document file is missing from disk.', 404));
  });
});

/* Thumbnails are cached per page and width. Widths snap to 40 px steps so a
   client asking for 161 and 159 does not fill the disk with near-duplicates, and
   concurrent requests for the same thumbnail share one render. */
const rendering = new Map();
r.get('/materials/:id/pages/:n/thumb', async (req, res) => {
  const m = materialOr404(req.params.id);
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 1 || n > m.pageCount) throw bad(`Page ${req.params.n} is not in this document.`, 404);
  const w = Math.min(THUMB_MAX, Math.max(THUMB_MIN, Math.round((Number(req.query.w) || 240) / 40) * 40));
  const dir = path.join(materialDir(m.id), 'thumbs');
  const file = path.join(dir, `p${n}-w${w}.jpg`);
  try {
    await fsp.access(file);
  } catch {
    if (!rendering.has(file)) {
      rendering.set(file, (async () => {
        await fsp.mkdir(dir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp.jpg`;
        await renderPage(sourcePdf(m.id), n, tmp, { width: w, quality: 70 });
        await fsp.rename(tmp, file);
      })().finally(() => rendering.delete(file)));
    }
    await rendering.get(file);
  }
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(file);
});

/* "Make lessons from pages 9–11 and 25": a note that points at the pages, and the
   same extract job class notes use. Validated completely before the note exists,
   so a typo never leaves an empty note behind. */
r.post('/materials/:id/lessons', async (req, res) => {
  const m = materialOr404(req.params.id);
  const b = isPlain(req.body) ? req.body : {};
  const s = readSettings();
  if (!hasApiKey(s)) throw bad('Add your OpenRouter API key first.');

  const numbering = b.numbering === 'pdf' ? 'pdf' : 'printed';
  const offset = numbering === 'printed' ? Number(m.pageOffset) || 0 : 0;
  let typed;
  try {
    typed = parsePages(Array.isArray(b.pages) ? b.pages.join(', ') : b.pages, { limit: MAX_PAGES_PER_RUN });
  } catch (e) {
    throw bad(e.message);
  }
  const pdfPages = typed.map((p) => p + offset);
  const outside = pdfPages.find((p) => p < 1 || p > m.pageCount);
  if (outside !== undefined) {
    throw bad(offset
      ? `Printed page ${outside - offset} would be PDF page ${outside}, which is not in this ${m.pageCount}-page document.`
      : `This document has ${m.pageCount} pages, so page ${outside} is past the end.`);
  }
  const split = ['one', 'per-range', 'auto'].includes(b.split) ? b.split : 'auto';
  const instructions = String(b.instructions ?? '').trim();
  if (instructions.length > 2000) throw bad('Keep the instructions under 2,000 characters.');
  const classDate = checkDate(b.classDate);
  const model = str(b.model);
  if (model && !isAllowedModel(model)) throw bad('That model is not on the allowed list.');

  const printed = formatPages(typed);
  const note = coll('notes').insert({
    title: str(b.title).slice(0, 120) || `${m.title} · p. ${printed}`,
    classDate,
    text: instructions,
    images: [],
    status: 'new',
    jobId: null,
    draft: null,
    imported: null,
    model: '',
    usage: null,
    error: null,
    source: { materialId: m.id, title: m.title, pages: pdfPages, printed, numbering, offset, split },
  });
  const job = startExtractJob(note, { settings: s, prefer: model });
  res.json({ noteId: note.id, jobId: job.id, pages: pdfPages });
});

export default r;
