/* Where a document lives on disk and what happens to it over time. Shared by the
   materials and notes routers so neither imports the other's module state. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { coll } from '../store.js';
import { config } from '../config.js';

export function materialDir(id) { return path.join(config.dataDir, 'materials', id); }
export function sourcePdf(id) { return path.join(materialDir(id), 'source.pdf'); }

export async function removeMaterial(id) {
  await fs.rm(materialDir(id), { recursive: true, force: true });
  coll('materials').remove(id);
}

/* The learner chose "use it once": the file goes as soon as nothing needs it, i.e.
   no note made from it is still waiting to be imported. */
export async function releaseIfUnkept(materialId, { exceptNoteId = null } = {}) {
  const m = coll('materials').get(materialId);
  if (!m || m.keep) return false;
  const waiting = coll('notes').all().some((n) => n.id !== exceptNoteId && n.source?.materialId === materialId && n.status !== 'imported');
  if (waiting) return false;
  await removeMaterial(materialId);
  return true;
}

/* Pages that became lessons, in PDF numbering, so the page picker can mark them
   and the library can say "Covered: 9–11, 25". */
export function recordCoverage(materialId, { pages, lessonIds, noteId }) {
  const m = coll('materials').get(materialId);
  if (!m) return null;
  const entry = { pages: [...(pages || [])], lessonIds: [...(lessonIds || [])], noteId, at: new Date().toISOString() };
  return coll('materials').update(materialId, { covered: [...(m.covered || []), entry] });
}
