/* Backup and restore. One file holds everything the learner cannot recreate:
   the dictionary, the lessons, the notes, the schedule and the streak. The API
   key is never in it — a backup lands in a cloud drive.
   Note photos are NOT in it either (they would multiply the file size); their
   metadata is, so a restored note still says which photos it had. Documents
   (data/materials) are left out entirely: a scanned textbook can be hundreds of
   megabytes, and a material record without its PDF would only be a broken row. */
import { Router } from 'express';
import { coll, doc } from '../store.js';
import { config } from '../config.js';
import * as srs from '../srs.js';
import { DEFAULT_SETTINGS, DEFAULT_PROGRESS, deepMerge, isPlain } from '../defaults.js';
import { readSettings, today } from '../stats.js';
import { newStats } from '../lib/words.js';

const r = Router();

const ARRAYS = ['words', 'lessons', 'notes', 'usage'];

function bad(msg, status = 400) { return Object.assign(new Error(msg), { status }); }

r.get('/backup', (req, res) => {
  const settings = { ...readSettings(), ai: { ...readSettings().ai } };
  delete settings.ai.apiKey;
  const payload = {
    version: config.version,
    exportedAt: new Date().toISOString(),
    words: coll('words').all(),
    lessons: coll('lessons').all(),
    notes: coll('notes').all().map((n) => ({
      ...n,
      images: (n.images || []).map(({ name, type, size, file }) => ({ name, type, size, file })),
    })),
    settings,
    progress: doc('progress').get() || {},
    suggestions: doc('suggestions').get() || {},
    usage: coll('usage').all(),
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="plumimemolang-backup-${today()}.json"`);
  res.send(JSON.stringify(payload, null, 2));
});

r.post('/backup/restore', (req, res) => {
  const b = req.body;
  if (!isPlain(b)) throw bad('That is not a PlumiMemoLang backup.');
  for (const name of ARRAYS) {
    if (b[name] !== undefined && !Array.isArray(b[name])) throw bad(`${name} must be an array.`);
  }
  for (const name of ['settings', 'progress', 'suggestions']) {
    if (b[name] !== undefined && !isPlain(b[name])) throw bad(`${name} must be an object.`);
  }
  if (Array.isArray(b.words) && b.words.some((w) => !isPlain(w) || !String(w.hanzi ?? '').trim())) {
    throw bad('Every word in the backup needs its hanzi.');
  }

  const counts = {};
  if (b.words) {
    // A backup written before a field existed still restores: fill the schedule
    // and the tally rather than refusing the file.
    coll('words').replaceAll(b.words.map((w) => ({ ...w, srs: isPlain(w.srs) ? w.srs : srs.newSrs(), stats: isPlain(w.stats) ? w.stats : newStats() })));
    counts.words = b.words.length;
  }
  if (b.lessons) { coll('lessons').replaceAll(b.lessons.filter(isPlain)); counts.lessons = coll('lessons').all().length; }
  if (b.notes) { coll('notes').replaceAll(b.notes.filter(isPlain)); counts.notes = coll('notes').all().length; }
  if (b.usage) { coll('usage').replaceAll(b.usage.filter(isPlain)); counts.usage = coll('usage').all().length; }
  if (b.settings) {
    // The key in the backup (there should not be one) is ignored; the key on
    // this machine survives a restore.
    const current = doc('settings').get() || {};
    const incoming = { ...b.settings, ai: { ...(b.settings.ai || {}) } };
    delete incoming.ai.apiKey;
    doc('settings').set(() => deepMerge(deepMerge(DEFAULT_SETTINGS, incoming), { ai: { apiKey: String(current.ai?.apiKey || '') } }));
    counts.settings = 1;
  }
  if (b.progress) { doc('progress').set(() => deepMerge(DEFAULT_PROGRESS, b.progress)); counts.progress = 1; }
  if (b.suggestions) { doc('suggestions').set(() => ({ ...b.suggestions })); counts.suggestions = 1; }

  res.json({ ok: true, counts });
});

export default r;
