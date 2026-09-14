/* What the learner is learning FOR, and what that means for every screen.

   Pure, so the server (prompts, challenge defaults, template normalisation) and the
   browser (display, onboarding) read the same rules. The first build assumed every
   learner wants characters; the first real learner wants to SPEAK and keeps
   characters only as a reference. Nothing here assumes either: the answers to the
   welcome questions decide. */

export const SKILLS = [
  { id: 'speak', label: 'Speak', hint: 'Hold a conversation' },
  { id: 'listen', label: 'Understand', hint: 'Follow people when they talk' },
  { id: 'read', label: 'Read characters', hint: 'Menus, signs, messages' },
  { id: 'write', label: 'Write characters', hint: 'By hand' },
  { id: 'type', label: 'Type Chinese', hint: 'On a phone or a computer' },
];

export const REASONS = [
  { id: 'taiwan', label: 'Living in Taiwan' },
  { id: 'travel', label: 'Travel' },
  { id: 'work', label: 'Work' },
  { id: 'family', label: 'Partner or family' },
  { id: 'friends', label: 'Friends' },
  { id: 'school', label: 'School or university' },
  { id: 'media', label: 'Shows, music and games' },
  { id: 'exam', label: 'An exam (TOCFL, HSK)' },
  { id: 'fun', label: 'Just curious' },
];

export const CLASSES = [
  { id: 'regular', label: 'Yes, every week' },
  { id: 'sometimes', label: 'Now and then' },
  { id: 'none', label: 'No, on my own' },
];

export const HANZI_MODES = ['full', 'small', 'hidden'];

export const TEMPLATE_FIELDS = ['hanzi', 'reading', 'meaning', 'example', 'audio', 'cloze', 'notes', 'tags', 'record'];

/* Builtin memo-card templates. Their definitions always follow this list (a stored
   copy from an older build is corrected on read); only `enabled` is the learner's. */
export const BUILTIN_TEMPLATES = [
  { id: 'recognition', name: 'Characters → meaning', front: ['hanzi'], back: ['reading', 'meaning', 'example'], builtin: true },
  { id: 'production', name: 'Meaning → characters', front: ['meaning'], back: ['hanzi', 'reading', 'example'], builtin: true },
  { id: 'say', name: 'Say it', front: ['meaning', 'record'], back: ['reading', 'audio', 'example', 'hanzi'], builtin: true },
  { id: 'sound', name: 'Reading → meaning', front: ['reading'], back: ['meaning', 'audio', 'example', 'hanzi'], builtin: true },
  { id: 'listening', name: 'Listen', front: ['audio'], back: ['meaning', 'reading', 'hanzi'], builtin: true },
  { id: 'cloze', name: 'Fill the blank', front: ['cloze'], back: ['hanzi', 'reading', 'example'], builtin: true },
];

/* `fits` is who the question type is for. "both" types adapt their display to the
   learner (a speaking learner sees the reading where a character learner sees 字). */
export const CHALLENGE_TYPES = [
  { id: 'listen-meaning', label: 'Listen and pick the meaning', fits: 'speaking' },
  { id: 'mc-pinyin', label: 'Pick the pinyin', fits: 'speaking' },
  { id: 'tones', label: 'Hear the tones', fits: 'speaking' },
  { id: 'speak', label: 'Say it', fits: 'speaking' },
  { id: 'order-pinyin', label: 'Build the sentence', fits: 'speaking' },
  { id: 'mc-meaning', label: 'Pick the meaning', fits: 'both' },
  { id: 'type-pinyin', label: 'Type the pinyin', fits: 'both' },
  { id: 'match', label: 'Match pairs', fits: 'both' },
  { id: 'mc-hanzi', label: 'Pick the characters', fits: 'characters' },
  { id: 'listen', label: 'Listen and pick the characters', fits: 'characters' },
  { id: 'order', label: 'Build the sentence from characters', fits: 'characters' },
  { id: 'cloze', label: 'Fill the blank', fits: 'characters' },
];

export const DEFAULT_GOALS = { onboardedAt: null, skills: [], reasons: [], classes: 'regular', about: '' };

const SPEAKING_SKILLS = ['speak', 'listen'];
const CHARACTER_SKILLS = ['read', 'write'];
const ABOUT_MAX = 500;

function ids(list) { return list.map((x) => x.id); }
function pick(values, allowed) {
  const out = [];
  for (const v of Array.isArray(values) ? values : []) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (allowed.includes(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

export function normaliseGoals(raw) {
  const g = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const when = g.onboardedAt && !Number.isNaN(Date.parse(g.onboardedAt)) ? new Date(g.onboardedAt).toISOString() : null;
  return {
    onboardedAt: when,
    skills: pick(g.skills, ids(SKILLS)),
    reasons: pick(g.reasons, ids(REASONS)),
    classes: ids(CLASSES).includes(g.classes) ? g.classes : DEFAULT_GOALS.classes,
    about: typeof g.about === 'string' ? g.about.trim().slice(0, ABOUT_MAX) : '',
  };
}

export function focusOf(goals) {
  const skills = normaliseGoals(goals).skills;
  const speaking = skills.some((s) => SPEAKING_SKILLS.includes(s));
  const characters = skills.some((s) => CHARACTER_SKILLS.includes(s));
  if (speaking && !characters) return 'speaking';
  if (characters && !speaking) return 'characters';
  return 'balanced';
}

export function defaultHanziMode(focus) {
  return focus === 'speaking' ? 'small' : 'full';
}

export function recommendedTemplates(focus) {
  if (focus === 'speaking') return ['say', 'listening', 'sound'];
  if (focus === 'characters') return ['recognition', 'production', 'cloze'];
  return ['recognition', 'say', 'listening'];
}

export function recommendedChallengeTypes(focus) {
  if (focus === 'balanced') return ids(CHALLENGE_TYPES);
  const want = focus === 'speaking' ? 'speaking' : 'characters';
  return CHALLENGE_TYPES.filter((t) => t.fits === want || t.fits === 'both').map((t) => t.id);
}

/* A stored template list from any build → the current one. Builtins always exist and
   always carry the code's definition; custom templates pass through untouched. The
   first two builtins were the only ones enabled by default before goals existed. */
export function normaliseTemplates(list) {
  const stored = Array.isArray(list) ? list.filter((t) => t && typeof t === 'object' && t.id) : [];
  const byId = new Map(stored.map((t) => [String(t.id), t]));
  const builtins = BUILTIN_TEMPLATES.map((b) => {
    const mine = byId.get(b.id);
    const enabled = mine ? mine.enabled !== false : b.id === 'recognition' || b.id === 'production';
    return { ...b, front: [...b.front], back: [...b.back], enabled };
  });
  const builtinIds = ids(BUILTIN_TEMPLATES);
  const custom = stored.filter((t) => !builtinIds.includes(String(t.id))).map((t) => ({ ...t, builtin: false }));
  return [...builtins, ...custom];
}

export function learnerProfile(settings) {
  const goals = normaliseGoals(settings?.goals);
  const focus = focusOf(goals);
  const stored = settings?.display?.hanzi;
  const hanzi = HANZI_MODES.includes(stored) ? stored : defaultHanziMode(focus);
  const script = ['pinyin', 'zhuyin', 'both'].includes(settings?.script) ? settings.script : 'zhuyin';
  return {
    goals,
    focus,
    speaking: focus !== 'characters',
    characters: focus !== 'speaking',
    hanzi,
    script,
    templates: recommendedTemplates(focus),
    challengeTypes: recommendedChallengeTypes(focus),
    onboarded: Boolean(goals.onboardedAt),
  };
}

/* The languages Plumi can explain things in (settings.nativeLanguage). A third
   element is the lang attribute for a label in its own script. */
export const LANGUAGES = [
  ['en', 'English'], ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español'],
  ['it', 'Italiano'], ['pt', 'Português'], ['ja', '日本語', 'ja'], ['ko', '한국어', 'ko'],
  ['vi', 'Tiếng Việt'], ['th', 'ไทย', 'th'], ['id', 'Bahasa Indonesia'],
];
