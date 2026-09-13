/* OpenRouter client. The only place in the app that talks to a model provider.
   Two jobs, kept separate on purpose:
     - listModels()  the catalogue the Settings screen routes tasks against
     - chat()        one completion, with JSON coaxed out of it reliably

   Two hard rules live here:
     1. The learner's API key is never logged, never echoed, never put in a body
        or an error message. maskKey() is the only way it may reach a screen.
     2. Every failure comes out as a sentence a human can act on. The client
        prints err.message verbatim, so "TypeError: fetch failed" is a bug. */
import { doc } from './store.js';

const API = 'https://openrouter.ai/api/v1';
/* OpenRouter asks apps to identify themselves; these two headers are what shows
   up on the openrouter.ai activity page, so the learner can tell which app spent
   their credits. */
const REFERER = 'https://github.com/THRAUR/PlumiMemoLang';
const TITLE = 'PlumiMemoLang';

const CACHE_DOC = 'models-cache';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MODELS_TIMEOUT_MS = 20000;

const cache = doc(CACHE_DOC, {});

export class OpenRouterError extends Error {
  constructor(message, { status = 0, body = null, model = '', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'OpenRouterError';
    this.status = status;
    this.body = body;
    this.model = model;
  }
}

/* ── the key ─────────────────────────────────────────────────────────────── */

/* "sk-or-v1-abcdef1234" → "sk-or-…1234". Enough for the learner to recognise
   which key is stored, useless to anyone else. */
export function maskKey(key) {
  const k = typeof key === 'string' ? key.trim() : '';
  if (!k) return '';
  if (k.length <= 10) return `…${k.slice(-2)}`;   // not a real key; show almost nothing
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

/* ── errors ──────────────────────────────────────────────────────────────── */

function withModel(text, model) {
  return model ? `${text} (model: ${model})` : text;
}

/* Anything the provider said that is safe and useful to pass through. */
function detailOf(body) {
  const raw = typeof body === 'string' ? body
    : body?.error?.message || body?.error?.metadata?.raw || body?.message || '';
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

const TIMEOUT_MSG = 'OpenRouter did not answer in time.';

function messageForStatus(status, model, body) {
  const detail = detailOf(body);
  switch (status) {
    case 401:
    case 403:
      // 403 from OpenRouter is usually a disabled/invalid key too; moderation
      // refusals carry a "flagged" reason, so keep the provider's words then.
      if (status === 403 && /moderat|flag/i.test(detail)) {
        return `OpenRouter refused that request: ${detail}`;
      }
      return 'OpenRouter rejected the API key. Check it in Settings.';
    case 402:
      return 'Your OpenRouter account is out of credits.';
    case 404:
      return withModel('That model was not found on OpenRouter.', model);
    case 408:
    case 504:
      return withModel(TIMEOUT_MSG, model);
    case 429:
      return withModel('OpenRouter is rate-limiting requests. Try again in a minute.', model);
    case 400:
      return withModel(`OpenRouter rejected the request${detail ? `: ${detail}` : '.'}`, model);
    default:
      if (status >= 500) return withModel(`OpenRouter is having trouble (status ${status}). Try again in a moment.`, model);
      return withModel(`OpenRouter returned an error (status ${status})${detail ? `: ${detail}` : '.'}`, model);
  }
}

/* ── HTTP ────────────────────────────────────────────────────────────────── */

function headersFor(apiKey, json) {
  const h = { 'HTTP-Referer': REFERER, 'X-Title': TITLE, Accept: 'application/json' };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

/* One request, one human error. globalThis.fetch is read at call time so tests
   (and any future proxy) can replace it. */
async function request({ path, apiKey, body = null, timeoutMs, signal, model = '' }) {
  const fetchFn = globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new Error('This Node build has no fetch(); Node 22.12+ is required.');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const sig = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([ac.signal, signal]) : ac.signal;

  let res;
  try {
    res = await fetchFn(`${API}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: headersFor(apiKey, Boolean(body)),
      body: body ? JSON.stringify(body) : undefined,
      signal: sig,
    });
  } catch (e) {
    if (signal?.aborted) throw new OpenRouterError('Cancelled.', { status: 0, model, cause: e });
    // DNS, refused connection, TLS, or our own timeout: from the learner's seat
    // these are all "it did not answer".
    throw new OpenRouterError(withModel(TIMEOUT_MSG, model), { status: 0, model, cause: e });
  } finally {
    clearTimeout(timer);
  }

  let text = '';
  try {
    text = await res.text();
  } catch (e) {
    throw new OpenRouterError(withModel(TIMEOUT_MSG, model), { status: res.status, model, cause: e });
  }
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }

  if (!res.ok) {
    throw new OpenRouterError(messageForStatus(res.status, model, parsed ?? text), {
      status: res.status, body: parsed ?? text, model,
    });
  }
  // OpenRouter can answer 200 with an error envelope (provider-side failure).
  if (parsed?.error) {
    const status = Number(parsed.error.code) || 502;
    throw new OpenRouterError(messageForStatus(status, model, parsed), { status, body: parsed, model });
  }
  return parsed ?? {};
}

/* ── models ──────────────────────────────────────────────────────────────── */

function toNumber(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/* "text+image->text" → ["text", "image"] (older catalogue entries only carry
   the packed `modality` string). */
function modalitiesFromModality(modality) {
  const left = String(modality || '').split('->')[0];
  const parts = left.split('+').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return parts.length ? parts : ['text'];
}

function mapModel(entry) {
  const arch = entry?.architecture || {};
  const params = Array.isArray(entry?.supported_parameters) ? entry.supported_parameters : [];
  const pricing = entry?.pricing || {};
  const input = Array.isArray(arch.input_modalities) && arch.input_modalities.length
    ? arch.input_modalities.map((m) => String(m).toLowerCase())
    : modalitiesFromModality(arch.modality);
  return {
    id: String(entry?.id || ''),
    name: String(entry?.name || entry?.id || ''),
    contextLength: Number(entry?.context_length) || Number(entry?.top_provider?.context_length) || 0,
    // USD per token, as numbers — the catalogue sends strings ("0.000003").
    pricing: {
      prompt: toNumber(pricing.prompt),
      completion: toNumber(pricing.completion),
      image: toNumber(pricing.image),
    },
    inputModalities: input,
    supportsStructured: params.includes('structured_outputs'),
    supportsJson: params.includes('response_format'),
    created: Number(entry?.created) || 0,
  };
}

function readCache() {
  const c = cache.get() || {};
  const models = Array.isArray(c.models) ? c.models : null;
  return models && models.length ? { fetchedAt: c.fetchedAt || null, models } : null;
}

/* The catalogue. Public endpoint, but the key is sent when we have one so
   OpenRouter can include the learner's per-model permissions. Cached for 24 h in
   data/models-cache.json: it is a 400 KB answer that changes once a day at most. */
export async function listModels({ apiKey = '', refresh = false, timeoutMs = MODELS_TIMEOUT_MS, signal } = {}) {
  const cached = readCache();
  if (!refresh && cached?.fetchedAt) {
    const age = Date.now() - Date.parse(cached.fetchedAt);
    if (Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS) return cached.models;
  }
  try {
    const body = await request({ path: '/models', apiKey, timeoutMs, signal });
    const list = Array.isArray(body?.data) ? body.data : [];
    const models = list.map(mapModel).filter((m) => m.id);
    if (!models.length) throw new OpenRouterError('OpenRouter returned an empty model list.', { status: 0 });
    cache.set({ fetchedAt: new Date().toISOString(), models });
    return models;
  } catch (e) {
    // A stale catalogue still lets the learner pick a model offline.
    if (cached) return cached.models;
    throw e;
  }
}

/* Cache-only lookup: chat() needs to know what a model supports and must not
   trigger a network call of its own to find out. Warm it with listModels(). */
export function cachedModel(id) {
  const models = readCache()?.models;
  if (!models || !id) return null;
  const wanted = String(id);
  const exact = models.find((m) => m.id === wanted);
  if (exact) return exact;
  // "anthropic/claude-sonnet-4.5:floor" routes to the same model entry.
  const base = wanted.includes(':') ? wanted.slice(0, wanted.lastIndexOf(':')) : '';
  return (base && models.find((m) => m.id === base)) || null;
}

/* ── cost ────────────────────────────────────────────────────────────────── */

/* null when we do not know the model's prices; a number (possibly 0, for free
   models) when we do. */
export function estimateCost(model, usage) {
  const p = model?.pricing;
  if (!p || typeof p !== 'object') return null;
  const prompt = toNumber(usage?.promptTokens ?? usage?.prompt_tokens);
  const completion = toNumber(usage?.completionTokens ?? usage?.completion_tokens);
  const cost = prompt * toNumber(p.prompt) + completion * toNumber(p.completion);
  return Number.isFinite(cost) ? cost : null;
}

/* ── JSON out of prose ───────────────────────────────────────────────────── */

function tryParse(candidate) {
  const s = String(candidate || '').trim();
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { /* keep trying */ }
  // Models love a trailing comma before the closing brace.
  try { return JSON.parse(s.replace(/,(\s*[}\]])/g, '$1')); } catch { return undefined; }
}

/* Top-level balanced {…} / […] chunks, string- and escape-aware, in the order
   they appear. The first one is the outermost. */
function balancedChunks(text) {
  const out = [];
  let depth = 0, start = -1, opener = '', inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') {
      if (depth === 0) { start = i; opener = ch; }
      depth++;
    } else if (ch === '}' || ch === ']') {
      if (depth === 0) continue;                       // stray closer, ignore
      depth--;
      if (depth === 0 && start >= 0) {
        const expected = opener === '{' ? '}' : ']';
        if (ch === expected) out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  if (depth > 0 && start >= 0) out.push(text.slice(start));   // truncated tail, worth one try
  return out;
}

function stripFences(text) {
  // Keep the contents of every fenced block, drop the fences themselves.
  let out = text.replace(/```[ \t]*[A-Za-z0-9_+-]*[ \t]*\r?\n?([\s\S]*?)```/g, '$1');
  out = out.replace(/```[ \t]*[A-Za-z0-9_+-]*[ \t]*\r?\n?/g, '');   // unterminated fence
  return out;
}

/* Models wrap JSON in ``` fences, in "Sure! Here you go:" and in a closing
   "Let me know if you want more!". Take the JSON anyway. */
export function extractJson(text) {
  const raw = typeof text === 'string' ? text : text == null ? '' : String(text);
  const candidates = [];

  const whole = tryParse(raw);
  if (whole && typeof whole === 'object') return whole;

  for (const m of raw.matchAll(/```[ \t]*[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)```/g)) candidates.push(m[1]);
  const bare = stripFences(raw);
  candidates.push(...balancedChunks(bare));
  if (bare !== raw) candidates.push(bare);

  for (const c of candidates) {
    const value = tryParse(c);
    if (value !== undefined && value !== null && typeof value === 'object') return value;
  }
  const peek = raw.replace(/\s+/g, ' ').trim().slice(0, 160);
  throw new Error(`The model did not return JSON.${peek ? ` It answered: "${peek}${raw.length > 160 ? '…' : ''}"` : ''}`);
}

/* ── strict schemas ──────────────────────────────────────────────────────── */

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/* OpenAI-style strict json_schema demands, on EVERY object:
   additionalProperties: false, and `required` listing every declared property.
   Writing that by hand in a 60-node schema is how you get a 400 at 2 a.m., so
   task schemas are written naturally and passed through here. Optional fields
   are expressed as a nullable type ("string" | null), not by omission.
   Returns a copy; the input is never mutated. */
export function strictify(schema) {
  return walk(schema);

  function walk(node) {
    if (Array.isArray(node)) return node.map(walk);
    if (!isPlainObject(node)) return node;
    const out = { ...node };

    for (const key of ['items', 'contains', 'not', 'if', 'then', 'else', 'additionalItems', 'propertyNames']) {
      if (out[key] !== undefined) out[key] = walk(out[key]);
    }
    for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
      if (Array.isArray(out[key])) out[key] = out[key].map(walk);
    }
    for (const key of ['properties', '$defs', 'definitions', 'patternProperties']) {
      if (isPlainObject(out[key])) {
        out[key] = Object.fromEntries(Object.entries(out[key]).map(([k, v]) => [k, walk(v)]));
      }
    }

    const isObjectNode = out.type === 'object'
      || (Array.isArray(out.type) && out.type.includes('object'))
      || (out.type === undefined && isPlainObject(out.properties));
    if (isObjectNode) {
      out.additionalProperties = false;
      out.required = isPlainObject(out.properties) ? Object.keys(out.properties) : [];
    }
    return out;
  }
}

/* ── chat ────────────────────────────────────────────────────────────────── */

const NUDGE = 'That was not valid JSON. Reply again with ONLY the JSON value — no prose, no explanation, no code fences.';

function responseFormatFor(model, schema, schemaName) {
  if (!schema) return null;
  const info = cachedModel(model);
  if (info?.supportsStructured) {
    return { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema: strictify(schema) } };
  }
  if (info?.supportsJson) return { type: 'json_object' };
  // Unknown model (empty catalogue cache) or no JSON support: the prompt already
  // demands JSON and extractJson() is forgiving. Sending an unsupported
  // response_format is worse — some providers hard-fail on it.
  return null;
}

/* Some providers return content as an array of parts instead of a string. */
function textOf(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((p) => (typeof p === 'string' ? p : p?.text || p?.content || '')).join('');
  }
  return '';
}

function usageOf(raw, model) {
  const u = raw || {};
  const promptTokens = Number(u.prompt_tokens) || 0;
  const completionTokens = Number(u.completion_tokens) || 0;
  const totalTokens = Number(u.total_tokens) || promptTokens + completionTokens;
  const shaped = { promptTokens, completionTokens, totalTokens, cost: null };
  // `usage: { include: true }` makes OpenRouter report the real charge; without
  // it (or with an odd provider) fall back to the catalogue prices.
  shaped.cost = typeof u.cost === 'number' ? u.cost : estimateCost(cachedModel(model), shaped);
  return shaped;
}

function addUsage(a, b) {
  if (!a) return b;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: a.cost == null && b.cost == null ? null : (a.cost || 0) + (b.cost || 0),
  };
}

/* One completion. With `schema`, the answer is parsed as JSON and one retry is
   spent on a model that answered with prose. Images ride inside `messages` as
   { type: "image_url", image_url: { url: "data:…" } } parts.
   → { text, json, usage: { promptTokens, completionTokens, totalTokens, cost }, model, id } */
export async function chat({
  apiKey,
  model,
  messages,
  schema = null,
  schemaName = 'result',
  temperature = 0.3,
  maxTokens = 4096,
  timeoutMs = 180000,
  signal,
} = {}) {
  if (!apiKey) throw new Error('Add your OpenRouter API key in Settings first.');
  if (!model) throw new Error('No model is selected. Pick one in Settings.');
  if (!Array.isArray(messages) || !messages.length) throw new Error('Nothing to ask the model.');

  const responseFormat = responseFormatFor(model, schema, schemaName);
  let turns = messages;
  let total = null;
  let attempt = 0;
  let lastFinish = '';

  for (;;) {
    const body = {
      model,
      messages: turns,
      temperature,
      max_tokens: maxTokens,
      usage: { include: true },     // OpenRouter reports the actual cost back
    };
    if (responseFormat) body.response_format = responseFormat;

    const data = await request({ path: '/chat/completions', apiKey, body, timeoutMs, signal, model });
    const choice = data?.choices?.[0] || {};
    const text = textOf(choice.message);
    const refusal = choice.message?.refusal;
    total = addUsage(total, usageOf(data?.usage, model));
    lastFinish = choice.finish_reason || choice.native_finish_reason || '';
    const answered = { text, json: null, usage: total, model: data?.model || model, id: data?.id || null };

    if (refusal) {
      const err = new Error(`The model declined to answer: ${String(refusal).slice(0, 200)}`);
      err.usage = total;
      throw err;
    }
    if (!schema) {
      if (!text.trim()) {
        const err = new Error(withModel('The model returned an empty answer.', model));
        err.usage = total;
        throw err;
      }
      return answered;
    }

    try {
      answered.json = extractJson(text);
      return answered;
    } catch (e) {
      if (attempt === 0) {
        // One nudge, then give up: a second failure means the model cannot do
        // this task and burning more of the learner's credits will not help.
        turns = [...turns, { role: 'assistant', content: text || '(empty)' }, { role: 'user', content: NUDGE }];
        attempt++;
        continue;
      }
      const cut = lastFinish === 'length';
      const err = new Error(cut
        ? withModel('The answer was cut off before the JSON was complete. Try again, or choose a model with a larger output limit.', model)
        : `${withModel('The model did not return usable JSON.', model)} ${e.message}`);
      err.usage = total;
      err.cause = e;
      throw err;
    }
  }
}
