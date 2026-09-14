/* JSON-file store. One file per collection under DATA_DIR, held in memory,
   written atomically (tmp + rename) and debounced so a burst of grades during a
   review session costs one write, not forty. No database: the learner backs up
   a folder and has backed up everything. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const registry = new Map();      // name -> handle
const pending = new Map();       // name -> timer
const writing = new Map();       // name -> promise chain (serialises writes per file)
const DEBOUNCE_MS = 120;

export function newId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}
function nowIso() { return new Date().toISOString(); }

function fileFor(name) { return path.join(config.dataDir, `${name}.json`); }

async function readJson(name, fallback) {
  try {
    const raw = await fs.readFile(fileFor(name), 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    // A half-written or corrupt file must not silently become an empty
    // dictionary: keep the bad copy next to it and start from the fallback.
    const bad = fileFor(name) + `.corrupt-${Date.now()}`;
    await fs.rename(fileFor(name), bad).catch(() => {});
    console.error(`[store] ${name}.json could not be parsed; moved to ${path.basename(bad)}`);
    return fallback;
  }
}

function schedule(name) {
  if (pending.has(name)) return;
  pending.set(name, setTimeout(() => { pending.delete(name); void flush(name); }, DEBOUNCE_MS));
}

/* Windows refuses to replace a file that another program holds open for a moment (an
   antivirus or the search indexer glancing at it), so a failed swap is retried a few
   times before the write counts as failed. */
async function replaceFile(tmp, file) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (e) {
      if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
    }
  }
}

async function flush(name) {
  const h = registry.get(name);
  if (!h) return;
  const prev = writing.get(name) || Promise.resolve();
  const p = prev.then(async () => {
    const data = JSON.stringify(h.data, null, 2);
    const file = fileFor(name);
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, data, 'utf8');
    await replaceFile(tmp, file);
  }).catch((e) => console.error(`[store] write ${name}.json failed:`, e.message));
  writing.set(name, p);
  return p;
}

export async function flushAll() {
  for (const [name, t] of pending) { clearTimeout(t); pending.delete(name); await flush(name); }
  await Promise.all([...writing.values()]);
}

/* Array collections: words, lessons, notes, usage. */
export function coll(name) {
  if (registry.has(name)) return registry.get(name).api;
  const h = { data: [], loaded: false };
  const api = {
    name,
    all() { return h.data; },
    get(id) { return h.data.find((d) => d.id === id) || null; },
    find(fn) { return h.data.find(fn) || null; },
    filter(fn) { return h.data.filter(fn); },
    insert(doc) {
      const ts = nowIso();
      const full = { id: newId(), createdAt: ts, updatedAt: ts, ...doc };
      if (!full.id) full.id = newId();
      h.data.push(full);
      schedule(name);
      return full;
    },
    update(id, patch) {
      const i = h.data.findIndex((d) => d.id === id);
      if (i < 0) return null;
      const cur = h.data[i];
      const next = typeof patch === 'function' ? patch(cur) : { ...cur, ...patch };
      next.id = cur.id;
      next.createdAt = cur.createdAt;
      next.updatedAt = nowIso();
      h.data[i] = next;
      schedule(name);
      return next;
    },
    remove(id) {
      const i = h.data.findIndex((d) => d.id === id);
      if (i < 0) return false;
      h.data.splice(i, 1);
      schedule(name);
      return true;
    },
    replaceAll(arr) { h.data = Array.isArray(arr) ? arr : []; schedule(name); },
    touch() { schedule(name); },
    save() { return flush(name); },
    async load() { h.data = await readJson(name, []); if (!Array.isArray(h.data)) h.data = []; h.loaded = true; },
  };
  registry.set(name, { data: h.data, api, handle: h, kind: 'array' });
  // keep registry.data in sync with the live array reference
  Object.defineProperty(registry.get(name), 'data', { get: () => h.data });
  return api;
}

/* Object documents: settings, progress, suggestions, models-cache. */
export function doc(name, defaults = {}) {
  if (registry.has(name)) return registry.get(name).api;
  const h = { data: structuredClone(defaults), loaded: false };
  const api = {
    name,
    get() { return h.data; },
    set(patch) {
      h.data = typeof patch === 'function' ? patch(h.data) : { ...h.data, ...patch };
      schedule(name);
      return h.data;
    },
    touch() { schedule(name); },
    save() { return flush(name); },
    async load() {
      const stored = await readJson(name, null);
      h.data = stored && typeof stored === 'object' ? stored : structuredClone(defaults);
      h.loaded = true;
    },
  };
  registry.set(name, { api, handle: h, kind: 'object' });
  Object.defineProperty(registry.get(name), 'data', { get: () => h.data });
  return api;
}

export async function initStore() {
  await fs.mkdir(path.join(config.dataDir, 'uploads'), { recursive: true });
  await Promise.all([...registry.values()].map((r) => r.api.load()));
}

/* Load a collection that was registered after initStore() (routes register
   their own collections at import time, which is before init — but be safe). */
export async function ensureLoaded(name) {
  const r = registry.get(name);
  if (r && !r.handle.loaded) await r.api.load();
}

export function registeredNames() { return [...registry.keys()]; }
