/* Settings, the model list and the connection test. The API key is write-only
   on purpose: it goes in, and only ever comes back as a mask. */
import { Router } from 'express';
import { doc } from '../store.js';
import { config } from '../config.js';
import { runTask, resolveApiKey, hasApiKey } from '../ai/tasks.js';
import { DEFAULT_PRIORITY, allowedModel, isAllowedModel, normalisePriority } from '../ai/models.js';
import { listModels, maskKey } from '../openrouter.js';
import { DEFAULT_SETTINGS, deepMerge, isPlain } from '../defaults.js';
import { readSettings } from '../stats.js';
import { SKILLS, REASONS, CLASSES, HANZI_MODES, TEMPLATE_FIELDS, normaliseTemplates } from '../../shared/goals.js';

const r = Router();

const SCRIPTS = ['zhuyin', 'pinyin', 'both'];
const LEVELS = ['beginner', 'elementary', 'intermediate', 'advanced'];
const THEMES = ['light', 'dark', 'system'];

function bad(msg, status = 400) { return Object.assign(new Error(msg), { status }); }

/* The shape every settings response has: no apiKey, but enough to tell the
   learner whether one is set and where it came from. The model order always
   comes back complete and inside the allow-list, whatever the file holds. */
function publicSettings(s) {
  const envKey = config.envApiKey;
  const key = String(s.ai?.apiKey || '');
  const out = { ...s, ai: { ...s.ai } };
  delete out.ai.apiKey;
  delete out.ai.models;     // the per-task model map from before the allow-list; ignored
  out.ai.priority = normalisePriority(s.ai?.priority);
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

/* Only the keys that were sent are validated and returned: a partial goals body
   (just `about`, say) must deep-merge without wiping the skills already stored. */
function checkGoals(g) {
  if (!isPlain(g)) throw bad('goals must be an object.');
  const out = {};
  const listOf = (value, allowed, name) => {
    if (!Array.isArray(value)) throw bad(`goals.${name} must be a list.`);
    const ids = allowed.map((x) => x.id);
    for (const v of value) if (!ids.includes(v)) throw bad(`"${String(v)}" is not one of the ${name} (${ids.join(', ')}).`);
    return [...new Set(value)];
  };
  if (g.skills !== undefined) out.skills = listOf(g.skills, SKILLS, 'skills');
  if (g.reasons !== undefined) out.reasons = listOf(g.reasons, REASONS, 'reasons');
  if (g.classes !== undefined) {
    if (!CLASSES.some((c) => c.id === g.classes)) throw bad(`goals.classes must be one of ${CLASSES.map((c) => c.id).join(', ')}.`);
    out.classes = g.classes;
  }
  if (g.about !== undefined) {
    const about = String(g.about ?? '').trim();
    if (about.length > 500) throw bad('Keep "anything Plumi should know" under 500 characters.');
    out.about = about;
  }
  if (g.onboardedAt !== undefined) {
    if (g.onboardedAt !== null && Number.isNaN(Date.parse(g.onboardedAt))) throw bad('goals.onboardedAt must be a date or null.');
    out.onboardedAt = g.onboardedAt === null ? null : new Date(g.onboardedAt).toISOString();
  }
  return out;
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
  if (body.cardTemplates !== undefined) p.cardTemplates = normaliseTemplates(checkTemplates(body.cardTemplates));
  if (body.goals !== undefined) p.goals = checkGoals(body.goals);
  if (body.display !== undefined) {
    if (!isPlain(body.display)) throw bad('display must be an object.');
    p.display = {};
    if (body.display.hanzi !== undefined) {
      if (!['', ...HANZI_MODES].includes(body.display.hanzi)) throw bad(`display.hanzi must be one of ${HANZI_MODES.join(', ')}, or "" to follow your goals.`);
      p.display.hanzi = body.display.hanzi;
    }
  }
  if (body.ai !== undefined) {
    if (!isPlain(body.ai)) throw bad('ai must be an object.');
    p.ai = {};
    // "" clears the key, undefined leaves whatever is stored alone.
    if (body.ai.apiKey !== undefined) p.ai.apiKey = String(body.ai.apiKey ?? '').trim();
    if (body.ai.monthlyBudgetUsd !== undefined) p.ai.monthlyBudgetUsd = checkNumber(body.ai.monthlyBudgetUsd, 'ai.monthlyBudgetUsd', 0, 1e6);
    if (body.ai.priority !== undefined) {
      if (!Array.isArray(body.ai.priority)) throw bad('ai.priority must be a list of model ids.');
      for (const id of body.ai.priority) {
        // The key's guardrail refuses anything else, so storing it would only
        // turn into an error on the next lesson.
        if (!isAllowedModel(id)) throw bad(`${String(id)} is not on the allowed model list.`);
      }
      p.ai.priority = normalisePriority(body.ai.priority);
    }
    if (body.ai.models !== undefined) {
      throw bad('Per-task models are gone. Reorder ai.priority instead.');
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
  const next = doc('settings').set((cur) => {
    const merged = deepMerge(deepMerge(DEFAULT_SETTINGS, cur || {}), patch);
    // The first write after the allow-list landed drops the old per-task map.
    merged.ai = { ...merged.ai };
    delete merged.ai.models;
    return merged;
  });
  // Answer through readSettings(), like GET: the reply must carry the normalised
  // template list and goals, or an older settings file comes back with old names.
  void next;
  res.json(publicSettings(readSettings()));
});

/* Only the allowed models, in the learner's order, with whatever the OpenRouter
   catalog knows about each (prices, context). The catalog is public, so this
   works before a key is set; if it cannot be reached, the static list still
   renders and `inCatalog` is false. */
r.get('/models', async (req, res) => {
  const s = readSettings();
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  let catalog = [];
  try {
    // resolveApiKey() throws when nothing is set; send a key only if one exists.
    catalog = await listModels({ apiKey: hasApiKey(s) ? resolveApiKey(s) : '', refresh });
  } catch {
    catalog = [];
  }
  res.json(normalisePriority(s.ai?.priority).map((id, i) => {
    const m = allowedModel(id);
    const c = catalog.find((x) => x.id === id) || null;
    return {
      ...(c || {}),
      id,
      name: m.name,
      vision: m.vision,
      why: m.why,
      rank: i + 1,
      recommendedRank: DEFAULT_PRIORITY.indexOf(id) + 1,
      inCatalog: Boolean(c),
      inputModalities: c?.inputModalities || (m.vision ? ['text', 'image'] : ['text']),
    };
  }));
});

r.post('/ai/test', async (req, res) => {
  const s = readSettings();
  if (!hasApiKey(s)) throw bad('Add your OpenRouter API key first.');
  const model = String(req.body?.model ?? '').trim();
  if (model && !isAllowedModel(model)) throw bad('That model is not on the allowed list.');
  // With a model: exactly that one, no fallback, so a dead model shows as dead.
  // Without: the whole list, the way every real task runs.
  const out = await runTask('test', {}, { settings: s, prefer: model, only: Boolean(model) });
  res.json({ ok: true, model: out.model, reply: out.result?.reply ?? '', usage: out.usage, fallbacks: out.fallbacks || [] });
});

export default r;
