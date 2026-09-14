/* The models this app is allowed to call, and the order it tries them in.

   There are two kinds.

   OpenRouter models, paid per call with the learner's OpenRouter key. The key
   carries a guardrail with an allow-list: any other model id is refused, and
   OpenRouter reports the refusal as 404 "not found" (seen in the usage log with
   anthropic/claude-sonnet-4.5, which does exist). So a model outside this list can
   only ever produce an error, and no screen may offer one.

   Claude plan models (added 2026-09-14), answered by Claude Code on this computer,
   logged in to the learner's own Claude subscription (./claude-code.js). Their
   calls are included in the plan, so they cost no OpenRouter credits; they count
   toward the plan's usage limits instead. They are opt-in: one is only tried once
   the learner has put it in the order in Settings.

   This file is the single source of truth: Settings reorders the list, runTask()
   walks it top to bottom and falls back on failure.

   Why this default order for the OpenRouter models (catalog, 2026-09-13):
     1. Gemini 3.5 Flash Lite   newest of the four (2026-07), reads photos. Gemini
                                is the safest bet for Traditional characters, Taiwan
                                vocabulary and 注音, which is the whole point here.
     2. Gemini 3.1 Flash Lite   one generation back (2026-05), reads photos.
     3. DeepSeek V4 Flash 0423  strong Chinese and by far the cheapest, but TEXT
                                ONLY, and trained mostly on mainland text, so it is a
                                backup rather than a first choice. Skipped
                                automatically for notes that carry photos.
     4. Gemini 2.5 Flash Lite   oldest (2025-07) and weakest, but reads photos: the
                                last resort that still works for every task.
   The ids are the catalog ids, not the display names on the guardrail screen.
   `vision` is curated rather than read from the catalog cache so that a cold
   cache can never send a photo to a text-only model.

   The Claude plan models, in the order Settings recommends them:
     1. Claude Sonnet   strong at Traditional Chinese, Taiwan usage and 注音, reads
                        photos, and quick at low effort: the fit for every task here.
     2. Claude Opus     the most careful, but uses the plan's limits fastest.
     3. Claude Haiku    the fastest and lightest on the limits; shorter lessons.
   `cli` is the alias passed to `claude --model`, which always means the newest model
   of that family (2026-09-14: claude-sonnet-5, claude-opus-5, claude-haiku-4-5). */
export const PROVIDERS = {
  openrouter: { id: 'openrouter', name: 'OpenRouter' },
  'claude-code': { id: 'claude-code', name: 'Your Claude plan' },
};

export const ALLOWED_MODELS = [
  {
    id: 'google/gemini-3.5-flash-lite',
    provider: 'openrouter',
    name: 'Gemini 3.5 Flash Lite',
    vision: true,
    why: 'Newest and best at Traditional Chinese and 注音. Reads photos.',
  },
  {
    id: 'google/gemini-3.1-flash-lite',
    provider: 'openrouter',
    name: 'Gemini 3.1 Flash Lite',
    vision: true,
    why: 'One generation older, same strengths. Reads photos.',
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    provider: 'openrouter',
    name: 'DeepSeek V4 Flash 0423',
    vision: false,
    why: 'Strong Chinese and the cheapest. Text only, so photo notes skip it.',
  },
  {
    id: 'google/gemini-2.5-flash-lite',
    provider: 'openrouter',
    name: 'Gemini 2.5 Flash Lite',
    vision: true,
    why: 'Oldest and weakest, but reads photos. The last resort.',
  },
];

export const PLAN_MODELS = [
  {
    id: 'claude-code:sonnet',
    provider: 'claude-code',
    cli: 'sonnet',
    name: 'Claude Sonnet',
    vision: true,
    why: 'Strong at Traditional Chinese and 注音, reads photos, and quick. The best fit.',
  },
  {
    id: 'claude-code:opus',
    provider: 'claude-code',
    cli: 'opus',
    name: 'Claude Opus',
    vision: true,
    why: 'The most careful writer. Uses your plan’s limits fastest.',
  },
  {
    id: 'claude-code:haiku',
    provider: 'claude-code',
    cli: 'haiku',
    name: 'Claude Haiku',
    vision: true,
    why: 'The fastest and the lightest on your limits. Shorter lessons.',
  },
];

const EVERY_MODEL = [...ALLOWED_MODELS, ...PLAN_MODELS];

/* Every id this app may call, of either kind. */
export const ALLOWED_IDS = EVERY_MODEL.map((m) => m.id);
export const PLAN_IDS = PLAN_MODELS.map((m) => m.id);
/* The OpenRouter models only: a Claude plan model joins the order when the learner adds it. */
export const DEFAULT_PRIORITY = ALLOWED_MODELS.map((m) => m.id);

function clean(id) {
  return typeof id === 'string' ? id.trim() : '';
}

export function isAllowedModel(id) {
  return ALLOWED_IDS.includes(clean(id));
}

export function allowedModel(id) {
  return EVERY_MODEL.find((m) => m.id === clean(id)) || null;
}

export function planModel(id) {
  return PLAN_MODELS.find((m) => m.id === clean(id)) || null;
}

export function isPlanModel(id) {
  return Boolean(planModel(id));
}

export function providerOf(id) {
  return allowedModel(id)?.provider || 'openrouter';
}

export function modelName(id) {
  return allowedModel(id)?.name || clean(id) || 'the model';
}

/* Any stored order → a complete, valid order: the learner's allowed ids in their
   order, then every OpenRouter model they have not placed. An OpenRouter model
   added to the list later therefore lands at the bottom instead of being
   unreachable; a Claude plan model is only ever where the learner put it; an id
   that fell off the list is silently dropped. */
export function normalisePriority(priority) {
  const order = [];
  const push = (id) => {
    const s = clean(id);
    if (isAllowedModel(s) && !order.includes(s)) order.push(s);
  };
  if (Array.isArray(priority)) priority.forEach(push);
  DEFAULT_PRIORITY.forEach(push);
  return order;
}

/* The models one call will try, in order.
     images  only models that can read photos (a text-only model would either
             error or, worse, answer confidently without having seen them)
     prefer  an allowed model picked for this one call; it goes first and the
             rest of the priority list stays behind it as the backup */
export function modelChain(priority, { images = false, prefer = '' } = {}) {
  let order = normalisePriority(priority);
  const first = clean(prefer);
  if (first && isAllowedModel(first)) order = [first, ...order.filter((id) => id !== first)];
  if (images) order = order.filter((id) => allowedModel(id)?.vision);
  return order;
}
