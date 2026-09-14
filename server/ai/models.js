/* The models this app is allowed to call, and the order it tries them in.

   The learner's OpenRouter key carries a guardrail with an allow-list: any other
   model id is refused, and OpenRouter reports the refusal as 404 "not found"
   (seen in the usage log with anthropic/claude-sonnet-4.5, which does exist). So
   a model outside this list can only ever produce an error, and no screen may
   offer one. This file is the single source of truth: Settings reorders the
   list, runTask() walks it top to bottom and falls back on failure.

   Why this default order (OpenRouter catalog, 2026-09-13):
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
   cache can never send a photo to a text-only model. */
export const ALLOWED_MODELS = [
  {
    id: 'google/gemini-3.5-flash-lite',
    name: 'Gemini 3.5 Flash Lite',
    vision: true,
    why: 'Newest and best at Traditional Chinese and 注音. Reads photos.',
  },
  {
    id: 'google/gemini-3.1-flash-lite',
    name: 'Gemini 3.1 Flash Lite',
    vision: true,
    why: 'One generation older, same strengths. Reads photos.',
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    name: 'DeepSeek V4 Flash 0423',
    vision: false,
    why: 'Strong Chinese and the cheapest. Text only, so photo notes skip it.',
  },
  {
    id: 'google/gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash Lite',
    vision: true,
    why: 'Oldest and weakest, but reads photos. The last resort.',
  },
];

export const ALLOWED_IDS = ALLOWED_MODELS.map((m) => m.id);
export const DEFAULT_PRIORITY = [...ALLOWED_IDS];

function clean(id) {
  return typeof id === 'string' ? id.trim() : '';
}

export function isAllowedModel(id) {
  return ALLOWED_IDS.includes(clean(id));
}

export function allowedModel(id) {
  return ALLOWED_MODELS.find((m) => m.id === clean(id)) || null;
}

export function modelName(id) {
  return allowedModel(id)?.name || clean(id) || 'the model';
}

/* Any stored order → a complete, valid order: the learner's allowed ids in their
   order, then every allowed model they have not placed. A model added to the
   list later therefore lands at the bottom instead of being unreachable, and an
   id that fell off the list is silently dropped. */
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
