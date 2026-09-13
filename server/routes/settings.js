/* Settings, the model list and the connection test. The API key is write-only
   on purpose: it goes in, and only ever comes back as a mask. */
import { Router } from 'express';
import { doc } from '../store.js';
import { config } from '../config.js';
import { runTask, TASKS, resolveApiKey, hasApiKey } from '../ai/tasks.js';
import { listModels, maskKey } from '../openrouter.js';
import { DEFAULT_SETTINGS, deepMerge, isPlain } from '../defaults.js';
import { readSettings } from '../stats.js';

const r = Router();

const SCRIPTS = ['zhuyin', 'pinyin', 'both'];
const LEVELS = ['beginner', 'elementary', 'intermediate', 'advanced'];
const THEMES = ['light', 'dark', 'system'];
const TEMPLATE_FIELDS = ['hanzi', 'reading', 'meaning', 'example', 'audio', 'cloze', 'notes', 'tags'];
const MODEL_KEYS = ['default', ...Object.keys(TASKS)];

function bad(msg, status = 400) { return Object.assign(new Error(msg), { status }); }

/* The shape every settings response has: no apiKey, but enough to tell the
   learner whether one is set and where it came from. */
function publicSettings(s) {
  const envKey = config.envApiKey;
  const key = String(s.ai?.apiKey || '');
  const out = { ...s, ai: { ...s.ai } };
  delete out.ai.apiKey;
  out.ai.apiKeyMasked = maskKey(key || envKey);
  out.ai.hasApiKey = Boolean(key || envKey);
  out.ai.keySource = key ? 'settings' : envKey ? 'env' : 'none';
  return out;
}

function checkNumber(v, name, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`${name} must be a number.`);
  if (n < min || n > max) throw bad(`${name} must be between ${min} and ${max}.`);
  return n;
}

function checkTemplates(list) {
  if (!Array.isArray(list)) throw bad('cardTemplates must be an array.');
  if (!list.length) throw bad('Keep at least one card template.');
  const ids = new Set();
  return list.map((t, i) => {
    if (!isPlain(t)) throw bad(`Card template ${i + 1} is not an object.`);
    const id = String(t.id ?? '').trim();
    if (!id) throw bad(`Card template ${i + 1} needs an id.`);
    if (ids.has(id)) throw bad(`Two card templates share the id "${id}".`);
    ids.add(id);
    const sides = {};
    for (const side of ['front', 'back']) {
      const v = t[side];
      if (!Array.isArray(v)) throw bad(`Template "${id}": ${side} must be an array of fields.`);
      const fields = v.map((f) => String(f ?? '').trim());
      for (const f of fields) {
        if (!TEMPLATE_FIELDS.includes(f)) throw bad(`Template "${id}": "${f}" is not a card field (${TEMPLATE_FIELDS.join(', ')}).`);
      }
      if (side === 'front' && !fields.length) throw bad(`Template "${id}": the front needs at least one field.`);
      sides[side] = fields;
    }
    return {
      id,
      name: String(t.name ?? '').trim() || id,
      front: sides.front,
      back: sides.back,
      builtin: Boolean(t.builtin),
      enabled: t.enabled === undefined ? true : Boolean(t.enabled),
    };
  });
}

/* Validates a partial body and returns the patch to deep-merge. Anything not
   mentioned here is dropped rather than stored, so a typo in the client cannot
   quietly grow the settings file. */
function validatePatch(body) {
  if (!isPlain(body)) throw bad('Send a settings object.');
  const p = {};
  if (body.learnerName !== undefined) {
    const name = String(body.learnerName ?? '').trim();
    if (name.length > 60) throw bad('That name is too long (60 characters max).');
    p.learnerName = name;
  }
  if (body.nativeLanguage !== undefined) {
    const lang = String(body.nativeLanguage ?? '').trim();
    if (!lang) throw bad('nativeLanguage cannot be empty.');
    if (lang.length > 8) throw bad('nativeLanguage must be a short code like "en" or "fr".');
    p.nativeLanguage = lang;
  }
  if (body.script !== undefined) {
    if (!SCRIPTS.includes(body.script)) throw bad(`script must be one of ${SCRIPTS.join(', ')}.`);
    p.script = body.script;
  }
  if (body.level !== undefined) {
    if (!LEVELS.includes(body.level)) throw bad(`level must be one of ${LEVELS.join(', ')}.`);
    p.level = body.level;
  }
  if (body.theme !== undefined) {
    if (!THEMES.includes(body.theme)) throw bad(`theme must be one of ${THEMES.join(', ')}.`);
    p.theme = body.theme;
  }
  if (body.dailyGoalXp !== undefined) p.dailyGoalXp = Math.round(checkNumber(body.dailyGoalXp, 'dailyGoalXp', 5, 500));
  if (body.newWordsPerDay !== undefined) p.newWordsPerDay = Math.round(checkNumber(body.newWordsPerDay, 'newWordsPerDay', 0, 50));
  if (body.tts !== undefined) {
    if (!isPlain(body.tts)) throw bad('tts must be an object.');
    p.tts = {};
    if (body.tts.voice !== undefined) p.tts.voice = String(body.tts.voice ?? '').trim();
    if (body.tts.rate !== undefined) p.tts.rate = checkNumber(body.tts.rate, 'tts.rate', 0.5, 2);
  }
  if (body.cardTemplates !== undefined) p.cardTemplates = checkTemplates(body.cardTemplates);
  if (body.ai !== undefined) {
    if (!isPlain(body.ai)) throw bad('ai must be an object.');
    p.ai = {};
    // "" clears the key, undefined leaves whatever is stored alone.
    if (body.ai.apiKey !== undefined) p.ai.apiKey = String(body.ai.apiKey ?? '').trim();
    if (body.ai.monthlyBudgetUsd !== undefined) p.ai.monthlyBudgetUsd = checkNumber(body.ai.monthlyBudgetUsd, 'ai.monthlyBudgetUsd', 0, 1e6);
    if (body.ai.models !== undefined) {
      if (!isPlain(body.ai.models)) throw bad('ai.models must be an object.');
      p.ai.models = {};
      for (const [k, v] of Object.entries(body.ai.models)) {
        if (!MODEL_KEYS.includes(k)) throw bad(`"${k}" is not a model slot (${MODEL_KEYS.join(', ')}).`);
        if (v !== null && v !== undefined && typeof v !== 'string') throw bad(`ai.models.${k} must be a model id string.`);
        p.ai.models[k] = String(v ?? '').trim();
      }
      if (p.ai.models.default !== undefined && !p.ai.models.default) throw bad('Pick a default model.');
    }
  }
  return p;
}

r.get('/settings', (req, res) => {
  res.json(publicSettings(readSettings()));
});

r.put('/settings', (req, res) => {
  const patch = validatePatch(req.body);
  // Stored complete: the file stays readable and a later default change still
  // reaches it through readSettings().
  const next = doc('settings').set((cur) => deepMerge(deepMerge(DEFAULT_SETTINGS, cur || {}), patch));
  res.json(publicSettings(deepMerge(DEFAULT_SETTINGS, next)));
});

/* The model list is public at OpenRouter, so this works before a key is set. */
r.get('/models', async (req, res) => {
  const s = readSettings();
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  // resolveApiKey() throws when nothing is set; the model list is public, so
  // send whatever key exists and otherwise none.
  const models = await listModels({ apiKey: hasApiKey(s) ? resolveApiKey(s) : '', refresh });
  res.json(models);
});

r.post('/ai/test', async (req, res) => {
  const s = readSettings();
  if (!hasApiKey(s)) throw bad('Add your OpenRouter API key first.');
  const model = String(req.body?.model ?? '').trim();
  // runTask routes through settings.ai.models[taskId]; a one-off override is a
  // settings clone, so nothing about the test is written to disk.
  const settings = model ? deepMerge(s, { ai: { models: { test: model } } }) : s;
  const out = await runTask('test', {}, { settings });
  res.json({ ok: true, model: out.model, reply: out.result?.reply ?? '', usage: out.usage });
});

export default r;
