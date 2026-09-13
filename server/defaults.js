/* Default documents. Settings are deep-merged over these on read, so adding a
   field here is enough for an old data/settings.json to pick it up. */
export const DEFAULT_SETTINGS = {
  learnerName: '',
  nativeLanguage: 'en',
  script: 'zhuyin',
  level: 'beginner',
  dailyGoalXp: 30,
  newWordsPerDay: 5,
  theme: 'system',
  tts: { voice: '', rate: 0.9 },
  cardTemplates: [
    { id: 'recognition', name: 'Recognition', front: ['hanzi'], back: ['reading', 'meaning', 'example'], builtin: true, enabled: true },
    { id: 'production', name: 'Production', front: ['meaning'], back: ['hanzi', 'reading', 'example'], builtin: true, enabled: true },
    { id: 'sound', name: 'Sound', front: ['reading'], back: ['hanzi', 'meaning', 'example'], builtin: true, enabled: false },
    { id: 'listening', name: 'Listening', front: ['audio'], back: ['hanzi', 'reading', 'meaning'], builtin: true, enabled: false },
    { id: 'cloze', name: 'Fill the blank', front: ['cloze'], back: ['hanzi', 'reading', 'example'], builtin: true, enabled: false },
  ],
  ai: {
    apiKey: '',
    models: { default: 'anthropic/claude-sonnet-4.5', extract: '', suggest: '', enrich: '', explain: '', reading: '' },
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
