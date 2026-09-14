/* Deleting the learner's data: one part at a time, or everything (§9.4).

   Each part is something the learner recognises from the screens: their lessons,
   their words, their notes, a panel of Settings. Parts point at each other, so a
   deletion tidies the other side in the same request. Words stay when their lessons
   go, no longer filed under them; lessons stay when their words go, without their
   word lists. Nothing outside the data folder is touched, and never the Claude
   login: that belongs to Claude Code on this computer, not to this app. */
import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { coll, doc, flushAll } from '../store.js';
import { config } from '../config.js';
import { DEFAULT_SETTINGS, DEFAULT_PROGRESS, deepMerge, isPlain } from '../defaults.js';
import { readSettings, getStats } from '../stats.js';
import { normalisePriority } from '../ai/models.js';
import { removeMaterial } from '../lib/materials.js';
import { normaliseTemplates } from '../../shared/goals.js';
import { publicSettings } from './settings.js';

const r = Router();

/* The order parts are deleted in when several go at once: lessons and words before
   notes, so the links notes leave behind are already gone; settings last. */
export const PARTS = ['lessons', 'words', 'notes', 'documents', 'progress', 'suggestions', 'usage', 'goals', 'profile', 'preferences', 'apiKey'];
/* The Learner panel of Settings. */
const PROFILE = ['learnerName', 'nativeLanguage', 'level', 'dailyGoalXp', 'newWordsPerDay'];

function bad(msg, status = 400) { return Object.assign(new Error(msg), { status }); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/* ---------- what there is ---------- */

function preferencesChanged(s) {
  const changed = [];
  if (s.theme !== DEFAULT_SETTINGS.theme) changed.push('theme');
  if (!same(s.tts, DEFAULT_SETTINGS.tts)) changed.push('voice');
  if (!same(normaliseTemplates(s.cardTemplates), normaliseTemplates(DEFAULT_SETTINGS.cardTemplates))) changed.push('cards');
  if (!same(normalisePriority(s.ai?.priority), normalisePriority(DEFAULT_SETTINGS.ai.priority))) changed.push('models');
  if (Number(s.ai?.monthlyBudgetUsd) !== DEFAULT_SETTINGS.ai.monthlyBudgetUsd) changed.push('budget');
  return changed;
}

/* Counts for the Delete data panel. `empty` means there is nothing that button
   would delete. */
export function inventory() {
  const s = readSettings();
  const words = coll('words').all();
  const notes = coll('notes').all();
  const materials = coll('materials').all();
  const progress = deepMerge(DEFAULT_PROGRESS, doc('progress').get() || {});
  const days = Object.values(progress.days || {}).filter((d) => (Number(d?.xp) || 0) > 0 || (Number(d?.reviews) || 0) > 0).length;
  const challenges = Array.isArray(progress.challenges) ? progress.challenges.length : 0;
  const suggestionDays = Object.keys(doc('suggestions').get() || {}).length;
  const g = s.goals || {};
  const profileSet = PROFILE.filter((k) => !same(s[k], DEFAULT_SETTINGS[k]));
  const changed = preferencesChanged(s);
  const keySource = s.ai?.apiKey ? 'settings' : config.envApiKey ? 'env' : 'none';
  const lessons = coll('lessons').all().length;
  const calls = coll('usage').all().length;
  return {
    lessons: { count: lessons, empty: !lessons },
    words: { count: words.length, reviewed: words.filter((w) => (Number(w.srs?.reps) || 0) > 0).length, empty: !words.length },
    notes: { count: notes.length, photos: notes.reduce((n, x) => n + (Array.isArray(x.images) ? x.images.length : 0), 0), empty: !notes.length },
    documents: { count: materials.length, bytes: materials.reduce((n, m) => n + (Number(m.size) || 0), 0), empty: !materials.length },
    progress: {
      xpTotal: Number(progress.xpTotal) || 0, bestStreak: Number(progress.streak?.best) || 0, days, challenges,
      empty: !Number(progress.xpTotal) && !days && !challenges && !Number(progress.streak?.best),
    },
    suggestions: { days: suggestionDays, empty: !suggestionDays },
    usage: { calls, empty: !calls },
    goals: {
      answered: Boolean(g.onboardedAt), onboardedAt: g.onboardedAt || null,
      empty: !g.onboardedAt && !(g.skills || []).length && !(g.reasons || []).length && !g.about
        && g.classes === DEFAULT_SETTINGS.goals.classes && !s.display?.hanzi && s.script === DEFAULT_SETTINGS.script,
    },
    profile: { set: profileSet, empty: !profileSet.length },
    preferences: { changed, empty: !changed.length },
    // A key that comes from .env is not this app's to delete.
    apiKey: { source: keySource, empty: keySource !== 'settings' },
  };
}

/* ---------- deleting ---------- */

function settingsWith(fn) {
  doc('settings').set((cur) => fn(deepMerge(DEFAULT_SETTINGS, cur || {})));
}

/* Only the two folders this app writes files into, and only inside the data folder. */
async function emptyFolder(name) {
  const dir = path.join(config.dataDir, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

const DELETE = {
  lessons() {
    for (const w of coll('words').all()) if (w.lessonId) coll('words').update(w.id, { lessonId: null });
    for (const n of coll('notes').all()) {
      if (n.imported?.lessonId || n.imported?.lessonIds?.length) coll('notes').update(n.id, { imported: { ...n.imported, lessonId: null, lessonIds: [] } });
    }
    // A document marks the pages that became lessons; those lessons are gone.
    for (const m of coll('materials').all()) if ((m.covered || []).length) coll('materials').update(m.id, { covered: [] });
    coll('lessons').replaceAll([]);
  },
  words() {
    for (const l of coll('lessons').all()) if ((l.wordIds || []).length) coll('lessons').update(l.id, { wordIds: [] });
    for (const n of coll('notes').all()) {
      if (n.imported?.wordIds?.length) coll('notes').update(n.id, { imported: { ...n.imported, wordIds: [], mergedHanzi: [] } });
    }
    // A suggestion marked "added" pointed at one of those words; it can be added again.
    doc('suggestions').set((cur) => Object.fromEntries(Object.entries(cur || {}).map(([day, entry]) => [day,
      isPlain(entry) && Array.isArray(entry.items)
        ? { ...entry, items: entry.items.map((it) => (it?.status === 'added' ? { ...it, status: 'open', wordId: null } : it)) }
        : entry])));
    coll('words').replaceAll([]);
  },
  async notes() {
    for (const l of coll('lessons').all()) if (l.noteId) coll('lessons').update(l.id, { noteId: null });
    for (const w of coll('words').all()) if (w.noteId) coll('words').update(w.id, { noteId: null });
    coll('notes').replaceAll([]);
    await emptyFolder('uploads');
    // A document the learner chose to use once lived only for its notes.
    for (const m of [...coll('materials').all()]) if (!m.keep) await removeMaterial(m.id);
  },
  async documents() {
    coll('materials').replaceAll([]);
    await fs.rm(path.join(config.dataDir, 'materials'), { recursive: true, force: true });
  },
  progress() { doc('progress').set(() => structuredClone(DEFAULT_PROGRESS)); },
  suggestions() { doc('suggestions').set(() => ({})); },
  usage() { coll('usage').replaceAll([]); },
  goals() {
    settingsWith((s) => ({ ...s, goals: { ...DEFAULT_SETTINGS.goals }, display: { ...DEFAULT_SETTINGS.display }, script: DEFAULT_SETTINGS.script }));
  },
  profile() {
    settingsWith((s) => ({ ...s, ...Object.fromEntries(PROFILE.map((k) => [k, structuredClone(DEFAULT_SETTINGS[k])])) }));
  },
  preferences() {
    settingsWith((s) => ({
      ...s,
      theme: DEFAULT_SETTINGS.theme,
      tts: { ...DEFAULT_SETTINGS.tts },
      cardTemplates: structuredClone(DEFAULT_SETTINGS.cardTemplates),
      // The Claude plan switches are places in the model order, so they reset with it.
      // The OpenRouter key is its own part and stays.
      ai: { ...s.ai, priority: [...DEFAULT_SETTINGS.ai.priority], monthlyBudgetUsd: DEFAULT_SETTINGS.ai.monthlyBudgetUsd },
    }));
  },
  apiKey() { settingsWith((s) => ({ ...s, ai: { ...s.ai, apiKey: '' } })); },
};

async function deleteAll() {
  for (const name of ['words', 'lessons', 'notes', 'materials', 'usage']) coll(name).replaceAll([]);
  doc('progress').set(() => structuredClone(DEFAULT_PROGRESS));
  doc('suggestions').set(() => ({}));
  doc('models-cache').set(() => ({}));
  doc('settings').set(() => structuredClone(DEFAULT_SETTINGS));
  await fs.rm(path.join(config.dataDir, 'materials'), { recursive: true, force: true });
  await emptyFolder('uploads');
  await flushAll();
  // Copies the store set aside because it could not read them hold old data too.
  for (const name of await fs.readdir(config.dataDir)) {
    if (/\.json\.corrupt-\d+$/.test(name)) await fs.rm(path.join(config.dataDir, name), { force: true });
  }
}

r.get('/data', (req, res) => {
  res.json({ parts: inventory() });
});

r.post('/data/delete', async (req, res) => {
  const b = isPlain(req.body) ? req.body : {};
  // Nothing is deleted by a stray request: the body has to say so in words.
  if (b.confirm !== 'delete') throw bad('To delete data, send confirm: "delete".');
  const all = b.parts === 'all' || (Array.isArray(b.parts) && b.parts.includes('all'));
  const asked = !all && Array.isArray(b.parts) ? [...new Set(b.parts.map((p) => String(p)))] : [];
  if (!all && !asked.length) throw bad('Say which parts of your data to delete.');
  const unknown = asked.find((p) => !PARTS.includes(p));
  if (unknown) throw bad(`"${unknown}" is not a part of your data (${PARTS.join(', ')}, or all).`);

  if (all) {
    await deleteAll();
  } else {
    for (const part of PARTS) if (asked.includes(part)) await DELETE[part]();
    await flushAll();
  }
  res.json({
    ok: true,
    deleted: all ? ['all'] : PARTS.filter((p) => asked.includes(p)),
    parts: inventory(),
    settings: publicSettings(readSettings()),
    stats: getStats(),
  });
});

export default r;
