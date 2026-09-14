/* Default documents. Settings are deep-merged over these on read, so adding a
   field here is enough for an old data/settings.json to pick it up. */
import { DEFAULT_PRIORITY } from './ai/models.js';
import { BUILTIN_TEMPLATES, DEFAULT_GOALS } from '../shared/goals.js';

export const DEFAULT_SETTINGS = {
  learnerName: '',
  nativeLanguage: 'en',
  script: 'zhuyin',
  level: 'beginner',
  dailyGoalXp: 30,
  newWordsPerDay: 5,
  theme: 'system',
  tts: { voice: '', rate: 0.9 },
  // Definitions come from shared/goals.js; readSettings() keeps a stored list in
  // step with them. Only the two templates enabled before goals existed start on;
  // the welcome questions switch on the ones that fit the learner.
  cardTemplates: BUILTIN_TEMPLATES.map((t) => ({ ...t, enabled: t.id === 'recognition' || t.id === 'production' })),
  // Answered in #/welcome; see docs/ARCHITECTURE.md §8.1.
  goals: { ...DEFAULT_GOALS },
  // '' follows the focus (small characters for a speaking learner, full otherwise).
  display: { hanzi: '' },
  ai: {
    apiKey: '',
    // The order models are tried in, top first. The allow-list and the reasons
    // for this order live in server/ai/models.js; Settings reorders it.
    priority: [...DEFAULT_PRIORITY],
    monthlyBudgetUsd: 5,
  },
};

export const DEFAULT_PROGRESS = {
  xpTotal: 0,
  streak: { current: 0, best: 0, lastActive: null },
  days: {},
  challenges: [],
};

/* Deep merge for plain objects only; arrays are replaced whole (a template list
   the learner edited must not be zipped with the defaults). */
export function deepMerge(base, patch) {
  if (!isPlain(base) || !isPlain(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlain(v) && isPlain(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}
export function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
