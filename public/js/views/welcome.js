/* ============================================================
   welcome.js — the welcome questions (docs/ARCHITECTURE.md §8.7).

   One question per screen, Duolingo's onboarding in Plume's clothes: a
   progress bar with a back button, Plumi asking in a speech bubble, big
   answer cards and one sticky Continue. The first real learner wanted to
   SPEAK and was drilled on characters; these answers are how every other
   screen learns what this learner is here for.

   Nothing is saved until the last screen, and then in ONE PUT: a learner who
   closes the tab halfway keeps the settings they had, never a half-set
   profile. Every answer starts from the current settings, so "Ask me again"
   in Settings opens on the learner's own choices.
   ============================================================ */
import { api } from '../api.js';
import { settings, setSettings } from '../state.js';
import { navigate } from '../router.js';
import { h, toast, progress, celebrate, busy, pixelIcon, setTitle } from '../ui.js';
import { createBird } from '../bird.js';
import { wordHero } from '../hanzi.js';
import { SKILLS, REASONS, CLASSES, BUILTIN_TEMPLATES, normaliseGoals, normaliseTemplates, focusOf, defaultHanziMode, recommendedTemplates, LANGUAGES } from '/shared/goals.js';
// The same list Settings offers, so the two screens can never disagree.

const ABOUT_MAX = 500;          // the server's limit for goals.about
const AUTO_ADVANCE_MS = 380;    // long enough to see the card light up, short enough to feel like one tap

const SKILL_ICONS = { speak: 'mic', listen: 'speaker', read: 'words', write: 'notes', type: 'dots' };
const SKILL_WORDS = { speak: 'speaking', listen: 'listening', read: 'reading', write: 'writing', type: 'typing' };

const SCRIPTS = ['pinyin', 'zhuyin', 'both'];
const HANZI = [
  { id: 'full', label: 'Big', hint: 'I’m learning them' },
  { id: 'small', label: 'Small', hint: 'Just to check the meaning' },
  { id: 'hidden', label: 'Hidden', hint: 'Only the reading' },
];
const LEVELS = [
  { id: 'beginner', label: 'Beginner', hint: 'A few words and phrases' },
  { id: 'elementary', label: 'Elementary', hint: 'Simple everyday conversations' },
  { id: 'intermediate', label: 'Intermediate', hint: 'Most everyday topics, with some effort' },
  { id: 'advanced', label: 'Advanced', hint: 'Natural conversations, shows, the news' },
];
const DAILY = [
  { xp: 10, label: 'Casual', hint: 'About 5 min a day' },
  { xp: 30, label: 'Regular', hint: 'About 15 min a day' },
  { xp: 50, label: 'Serious', hint: 'About 25 min a day' },
  { xp: 100, label: 'Intense', hint: 'About 50 min a day' },
];
/* Shown until GET /api/words answers, and for good when the deck is empty. */
const FALLBACK_WORD = { hanzi: '謝謝', pinyin: 'xiè xie', zhuyin: 'ㄒㄧㄝˋ ˙ㄒㄧㄝ', meaning: 'thank you' };
/* What each builtin card asks of the learner, in the words of someone who has
   never seen a template table. */
const TEMPLATE_BLURBS = {
  say: 'See the meaning, say it out loud, then hear it.',
  listening: 'Hear it, then recall what it means.',
  recognition: 'See the characters, recall the meaning.',
  production: 'See the meaning, recall the characters.',
  cloze: 'Find the missing word in a sentence.',
};
/* "Reading → meaning" names the reading the learner actually picked. */
function soundBlurb(script) {
  if (script === 'pinyin') return 'Read the pinyin, recall the meaning.';
  const zhuyin = h('span', { class: 'zh', lang: 'zh-Hant' }, '注音');
  return script === 'zhuyin' ? ['Read the ', zhuyin, ', recall the meaning.'] : ['Read the ', zhuyin, ' and pinyin, recall the meaning.'];
}
const TEMPLATE_ICONS = { say: 'mic', listening: 'speaker', sound: 'review', recognition: 'words', production: 'notes', cloze: 'doc' };

/* ---------- module state (one mounted flow at a time) ---------- */
let seq = 0;                 // render token: async work from an old render is dropped
let keyHandler = null;
let autoTimer = null;
const timers = new Set();

function later(fn, ms) {
  const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
  timers.add(t);
  return t;
}
function detach() {
  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  keyHandler = null;
  clearTimeout(autoTimer);
  autoTimer = null;
  for (const t of timers) clearTimeout(t);
  timers.clear();
}

const zh = (text) => h('span', { class: 'zh', lang: 'zh-Hant' }, text);
function listJoin(words) {
  if (words.length <= 1) return words[0] || '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/* One answer card. Several multi-select answers can be on at once, so "on" is
   an ink check; a single-select card lights up in the kit's terracotta
   selection, because only one per question ever is. */
function card({ multi = false, on = false, icon = null, label, hint = null, side = null, lang, onPick }) {
  const el = h('button', {
    class: `option wl-opt${multi ? ' wl-opt--multi' : ''}`,
    type: 'button',
    role: multi ? null : 'radio',
    dataset: multi ? undefined : { single: '1' },
  },
    icon ? h('span', { class: 'wl-ico' }, pixelIcon(icon, 3)) : null,
    h('span', { class: 'wl-opt-txt' },
      h('span', { class: 'wl-opt-label', lang }, label),
      hint ? h('span', { class: 'wl-opt-hint' }, hint) : null),
    side,
    multi ? h('span', { class: 'wl-check', 'aria-hidden': 'true' }, pixelIcon('check', 2)) : null);
  mark(el, multi, on);
  el.addEventListener('click', () => onPick(el));
  return el;
}
function mark(el, multi, on) {
  el.classList.toggle(multi ? 'is-on' : 'is-selected', on);
  el.setAttribute(multi ? 'aria-pressed' : 'aria-checked', String(on));
}
function chipIcon(on) { return pixelIcon(on ? 'check' : 'plus', 2); }
function paintChip(el, on) {
  el.classList.toggle('is-on', on);
  el.setAttribute('aria-pressed', String(on));
  el.firstChild?.replaceWith(chipIcon(on));
}

/* The reading a script choice shows, as the label of its card. */
function scriptLabel(id) {
  if (id === 'zhuyin') return [zh('注音'), ' Zhuyin'];
  return id === 'pinyin' ? 'Pinyin' : 'Both';
}
function scriptSample(id) {
  const py = h('span', { class: 'wl-sample mono' }, 'nǐ hǎo');
  const zy = h('span', { class: 'wl-sample zh', lang: 'zh-Hant' }, 'ㄋㄧˇ ㄏㄠˇ');
  if (id === 'pinyin') return h('span', { class: 'wl-samples' }, py);
  if (id === 'zhuyin') return h('span', { class: 'wl-samples' }, zy);
  return h('span', { class: 'wl-samples' }, h('span', { class: 'wl-sample zh', lang: 'zh-Hant' }, 'ㄋㄧˇ'), h('span', { class: 'wl-sample mono' }, 'nǐ'));
}
/* A tiny picture of each characters mode, so "Small" is seen, not parsed. */
function glyph(mode) {
  const box = h('span', { class: `wl-glyph wl-glyph--${mode}`, 'aria-hidden': 'true' });
  if (mode !== 'full') box.append(h('span', { class: 'wl-glyph-py mono' }, 'zì'));
  if (mode !== 'hidden') box.append(h('span', { class: 'wl-glyph-hz', lang: 'zh-Hant' }, '字'));
  return box;
}
/* wordHero() reads the SAVED script through readingFor(), and nothing is saved
   yet. A word that carries only the chosen reading renders that reading whatever
   the saved script says; "both" gets its pinyin line added by the preview. */
function readingOnly(w, script) {
  const base = { hanzi: w.hanzi, meaning: w.meaning };
  if (script === 'pinyin' && w.pinyin) return { ...base, pinyin: w.pinyin };
  if (w.zhuyin) return { ...base, zhuyin: w.zhuyin };
  return { ...base, pinyin: w.pinyin };
}

/* ============================================================
   render
   ============================================================ */
function render(root) {
  const my = ++seq;
  detach();
  setTitle('Welcome');

  const s = settings || {};
  const goals = normaliseGoals(s.goals);
  const again = Boolean(goals.onboardedAt);          // opened from Settings → "Ask me again"
  const storedHanzi = HANZI.some((m) => m.id === s.display?.hanzi) ? s.display.hanzi : '';
  const storedFocus = focusOf(goals);
  const a = {
    skills: [...goals.skills],
    script: SCRIPTS.includes(s.script) ? s.script : 'zhuyin',
    hanzi: '',
    hanziTouched: false,       // the learner picked a characters mode on this visit
    reasons: [...goals.reasons],
    about: goals.about,
    classes: goals.classes,
    level: LEVELS.some((l) => l.id === s.level) ? s.level : 'beginner',
    dailyGoalXp: Number(s.dailyGoalXp) || 30,
    nativeLanguage: s.nativeLanguage || 'en',
  };

  let index = 0;
  let saving = false;
  let sample = FALLBACK_WORD;
  let paintPreview = null;

  /* The characters mode follows the answer to the first question until the
     learner picks one: speaking → small, characters → full. A mode stored
     earlier survives as long as the focus it was chosen under does. */
  function preselectHanzi() {
    const focus = focusOf({ skills: a.skills });
    return storedHanzi && focus === storedFocus ? storedHanzi : defaultHanziMode(focus);
  }

  /* ---------- the shell: top bar, Plumi, the stage, the sticky Continue ---------- */
  const back = h('button', { class: 'btn btn--icon btn--quiet wl-back', type: 'button', 'aria-label': 'Back' }, pixelIcon('back', 2));
  const bar = progress(1, 8, 'wl-progress');
  const bird = createBird({ size: 4, mood: 'happy' });
  const askEl = h('h1', { class: 'wl-ask' });
  const hintEl = h('p', { class: 'wl-hint' });
  const bubble = h('div', { class: 'bubble wl-bubble', 'aria-live': 'polite' }, askEl, hintEl);
  const stage = h('div', { class: 'wl-stage' });
  const next = h('button', { class: 'btn btn--primary btn--lg btn--block wl-next', type: 'button' }, 'Continue');
  const page = h('div', { class: 'wl' },
    h('div', { class: 'wl-top' }, h('div', { class: 'wl-top-in' }, back, bar)),
    h('div', { class: 'wl-main' }, h('div', { class: 'coach wl-coach' }, bird.el, bubble), stage),
    h('div', { class: 'wl-foot' }, h('div', { class: 'wl-foot-in' }, next)));

  /* A single-select tap lights the card, then moves on by itself, the way
     Duolingo's onboarding does. Screens with two questions pass advance: false. */
  function choose(group, el, apply, { advance = true } = {}) {
    for (const c of group) mark(c, false, c === el);
    apply();
    bird.setMood('happy');
    paintNext();
    clearTimeout(autoTimer);
    if (!advance) return;
    const at = index;
    autoTimer = setTimeout(() => { if (my === seq && index === at && !saving) go(); }, AUTO_ADVANCE_MS);
  }

  /* ---------- the questions ---------- */
  const STEPS = [
    {
      ask: 'What do you want to be able to do with Chinese?',
      hint: again ? 'Pick as many as you like.' : 'Hi, I’m Plumi! Pick as many as you like.',
      ok: () => a.skills.length > 0,
      build() {
        const order = SKILLS.map((x) => x.id);
        return h('div', { class: 'wl-options', role: 'group', 'aria-label': 'What you want to do' },
          SKILLS.map((sk) => card({
            multi: true, on: a.skills.includes(sk.id), icon: SKILL_ICONS[sk.id], label: sk.label, hint: sk.hint,
            onPick: (el) => {
              const on = !a.skills.includes(sk.id);
              a.skills = order.filter((id) => (id === sk.id ? on : a.skills.includes(id)));
              mark(el, true, on);
              bird.setMood(on ? 'happy' : 'idle');
              paintNext();
            },
          })));
      },
    },
    {
      ask: 'How do you read Chinese?',
      hint: 'You can change this later in Settings.',
      ok: () => true,
      enter() { if (!a.hanziTouched) a.hanzi = preselectHanzi(); },
      build() {
        const scriptCards = SCRIPTS.map((id) => {
          const el = h('button', { class: 'option wl-opt wl-opt--col', type: 'button', role: 'radio', dataset: { single: '1' } },
            h('span', { class: 'wl-opt-label' }, scriptLabel(id)), scriptSample(id));
          mark(el, false, a.script === id);
          el.addEventListener('click', () => choose(scriptCards, el, () => { a.script = id; paintPreview?.(); }, { advance: false }));
          return el;
        });
        const hanziCards = HANZI.map((m) => card({
          on: a.hanzi === m.id, label: m.label, hint: m.hint, side: glyph(m.id),
          onPick: (el) => choose(hanziCards, el, () => { a.hanzi = m.id; a.hanziTouched = true; paintPreview?.(); }, { advance: false }),
        }));
        const preview = h('div', { class: 'card card--sunk wl-preview', 'aria-live': 'polite' });
        const body = h('div', { class: 'wl-reading' },
          h('div', { class: 'wl-group' },
            h('p', { class: 'pl-eyebrow' }, 'Readings'),
            h('div', { class: 'wl-scripts', role: 'radiogroup', 'aria-label': 'Readings' }, scriptCards)),
          h('div', { class: 'wl-group' },
            h('p', { class: 'pl-eyebrow' }, 'Characters (', zh('漢字'), ')'),
            h('div', { class: 'wl-options', role: 'radiogroup', 'aria-label': 'Characters' }, hanziCards)),
          h('div', { class: 'wl-group' },
            h('p', { class: 'pl-eyebrow' }, 'One of your words'),
            preview));
        paintPreview = () => {
          const hero = wordHero(readingOnly(sample, a.script), { size: 'lg', mode: a.hanzi });
          if (a.script === 'both' && a.hanzi !== 'full' && sample.pinyin && hero.classList.contains('word-hero') && !hero.querySelector('.wh-second')) {
            hero.querySelector('.wh-reading')?.after(h('div', { class: 'wh-second' }, sample.pinyin));
          }
          preview.replaceChildren(hero);
          if (sample.meaning) preview.append(h('p', { class: 'wl-preview-meaning' }, sample.meaning));
          // The little pictures on the characters cards speak the chosen reading too.
          const zy = a.script !== 'pinyin';
          for (const g of body.querySelectorAll('.wl-glyph-py')) {
            g.textContent = zy ? 'ㄗˋ' : 'zì';
            g.classList.toggle('is-zhuyin', zy);
            if (zy) g.setAttribute('lang', 'zh-Hant'); else g.removeAttribute('lang');
          }
        };
        paintPreview();
        return body;
      },
    },
    {
      ask: 'Why are you learning?',
      hint: 'Pick any that fit.',
      ok: () => true,
      build() {
        const order = REASONS.map((x) => x.id);
        const chips = REASONS.map((r) => {
          const el = h('button', { class: 'wl-chip', type: 'button' }, chipIcon(false), h('span', null, r.label));
          paintChip(el, a.reasons.includes(r.id));
          el.addEventListener('click', () => {
            const on = !a.reasons.includes(r.id);
            a.reasons = order.filter((id) => (id === r.id ? on : a.reasons.includes(id)));
            paintChip(el, on);
            if (on) bird.setMood('happy');
          });
          return el;
        });
        const count = h('span', { class: 'wl-count mono' });
        const ta = h('textarea', {
          class: 'textarea wl-about', id: 'wl-about', rows: 3, maxlength: ABOUT_MAX,
          placeholder: 'My teacher is Carl, we meet twice a week', value: a.about,
        });
        const paintCount = () => { count.textContent = `${ta.value.length} / ${ABOUT_MAX}`; };
        ta.addEventListener('input', () => { a.about = ta.value.slice(0, ABOUT_MAX); paintCount(); });
        paintCount();
        return h('div', { class: 'wl-reasons' },
          h('div', { class: 'wl-chips', role: 'group', 'aria-label': 'Why you are learning' }, chips),
          h('div', { class: 'field wl-field' },
            h('label', { class: 'wl-field-label', for: 'wl-about' }, 'Anything Plumi should know?'),
            ta,
            h('div', { class: 'wl-count-row' },
              h('span', { class: 'help' }, 'Plumi reads this when it writes your lessons.'),
              count)));
      },
    },
    {
      ask: 'Do you take classes?',
      ok: () => Boolean(a.classes),
      build() {
        const cards = CLASSES.map((c) => card({
          on: a.classes === c.id, label: c.label,
          onPick: (el) => choose(cards, el, () => { a.classes = c.id; }),
        }));
        return h('div', { class: 'wl-options', role: 'radiogroup', 'aria-label': 'Classes' }, cards);
      },
    },
    {
      ask: 'How much Chinese do you know?',
      hint: 'No test, promise.',
      ok: () => Boolean(a.level),
      build() {
        const cards = LEVELS.map((l, i) => card({
          on: a.level === l.id, label: l.label, hint: l.hint,
          side: h('span', { class: 'wl-bars', 'aria-hidden': 'true' }, [0, 1, 2, 3].map((n) => h('i', { class: n <= i ? 'is-on' : null }))),
          onPick: (el) => choose(cards, el, () => { a.level = l.id; }),
        }));
        return h('div', { class: 'wl-options', role: 'radiogroup', 'aria-label': 'Level' }, cards);
      },
    },
    {
      ask: 'Pick a daily goal',
      hint: 'A little every day beats a lot now and then.',
      ok: () => a.dailyGoalXp > 0,
      build() {
        // A goal set by hand in Settings (40 XP, say) stays on offer instead of
        // being silently rounded to the nearest preset.
        const list = DAILY.some((d) => d.xp === a.dailyGoalXp) ? DAILY : [...DAILY, { xp: a.dailyGoalXp, label: 'Your own goal', hint: 'The goal you have now' }];
        const cards = list.map((d) => card({
          on: a.dailyGoalXp === d.xp, label: d.label, hint: d.hint,
          side: h('span', { class: 'wl-xp' }, String(d.xp), h('small', null, 'XP')),
          onPick: (el) => choose(cards, el, () => { a.dailyGoalXp = d.xp; }),
        }));
        return h('div', { class: 'wl-options', role: 'radiogroup', 'aria-label': 'Daily goal' }, cards);
      },
    },
    {
      ask: 'Explain things in…',
      hint: 'Plumi’s explanations and translations use this language.',
      ok: () => Boolean(a.nativeLanguage),
      build() {
        const cards = LANGUAGES.map(([code, label, lang]) => card({
          on: a.nativeLanguage === code, label, lang,
          onPick: (el) => choose(cards, el, () => { a.nativeLanguage = code; }),
        }));
        return h('div', { class: 'wl-langs', role: 'radiogroup', 'aria-label': 'Explanation language' }, cards);
      },
    },
    {
      ask: 'Here’s your plan!',
      mood: 'cheer',
      last: true,
      ok: () => a.skills.length > 0,
      build() {
        const focus = focusOf({ skills: a.skills });
        const mode = a.hanzi || preselectHanzi();
        const names = new Map(BUILTIN_TEMPLATES.map((t) => [t.id, t.name]));
        const doing = SKILLS.filter((x) => a.skills.includes(x.id)).map((x) => SKILL_WORDS[x.id]);
        const charLine = { full: 'Characters stay big, with the reading on top.', small: 'Characters stay small.', hidden: 'Characters stay hidden.' }[mode];
        const lang = LANGUAGES.find(([code]) => code === a.nativeLanguage);
        const fact = (label, ...value) => h('div', { class: 'wl-fact' }, h('span', { class: 'label' }, label), h('span', { class: 'wl-fact-v' }, ...value));
        return h('div', { class: 'wl-plan' },
          h('div', { class: 'card wl-plan-card' },
            h('p', { class: 'wl-plan-lead' }, `Plumi will focus on ${listJoin(doing)}. ${charLine}`),
            h('div', { class: 'wl-facts' },
              fact('Readings', scriptLabel(a.script === 'both' ? 'zhuyin' : a.script), a.script === 'both' ? ' and pinyin' : null),
              fact('Daily goal', `${a.dailyGoalXp} XP`),
              fact('Explanations', lang ? h('span', { lang: lang[2] }, lang[1]) : a.nativeLanguage))),
          h('p', { class: 'pl-eyebrow' }, focus === 'balanced' ? 'Your card types' : `Your card types for ${focus}`),
          h('div', { class: 'list wl-cards' }, recommendedTemplates(focus).map((id) => h('div', { class: 'list-row wl-cardrow' },
            h('span', { class: 'wl-ico' }, pixelIcon(TEMPLATE_ICONS[id] || 'review', 3)),
            h('span', { class: 'wl-opt-txt' },
              h('span', { class: 'wl-opt-label' }, names.get(id) || id),
              h('span', { class: 'wl-opt-hint' }, id === 'sound' ? soundBlurb(a.script) : TEMPLATE_BLURBS[id] || ''))))));
      },
    },
  ];

  /* ---------- moving between screens ---------- */
  function paintNext() { next.disabled = saving || !STEPS[index].ok(); }

  function show(i, dir = 1) {
    clearTimeout(autoTimer);
    index = i;
    const step = STEPS[i];
    step.enter?.();
    askEl.textContent = step.ask;
    hintEl.textContent = step.hint || '';
    hintEl.hidden = !step.hint;
    bubble.classList.remove('is-new');
    void bubble.offsetWidth;                  // replay the bubble's rise on every question
    bubble.classList.add('is-new');
    bird.setMood(step.mood || 'idle');
    paintPreview = null;
    const body = step.build();
    body.classList.add('wl-step');
    if (dir < 0) body.classList.add('is-back');
    stage.replaceChildren(body);
    bar.set(i + 1, STEPS.length);
    // A learner sent here by app.js has nowhere to go back to on the first question.
    back.style.visibility = i > 0 || again ? '' : 'hidden';
    back.setAttribute('aria-label', i === 0 ? 'Back to Settings' : 'Back');
    next.textContent = step.last ? 'Start learning' : 'Continue';
    paintNext();
    window.scrollTo(0, 0);
  }

  function go() {
    if (saving || !STEPS[index].ok()) return;
    clearTimeout(autoTimer);
    if (STEPS[index].last) { finish(); return; }
    show(index + 1, 1);
  }

  back.addEventListener('click', () => {
    if (saving) return;
    if (index > 0) show(index - 1, -1);
    else if (again) navigate('/settings');
  });
  next.addEventListener('click', go);

  async function finish() {
    saving = true;
    busy(next, true);
    const focus = focusOf({ skills: a.skills });
    const rec = recommendedTemplates(focus);
    const body = {
      goals: { skills: a.skills, reasons: a.reasons, about: a.about.trim(), classes: a.classes, onboardedAt: new Date().toISOString() },
      script: a.script,
      display: { hanzi: a.hanzi || preselectHanzi() },
      level: a.level,
      dailyGoalXp: a.dailyGoalXp,
      nativeLanguage: a.nativeLanguage,
      // Builtins follow the focus; a template the learner made keeps its own switch.
      // normaliseTemplates() because a PUT reply carries the stored list as it is.
      cardTemplates: normaliseTemplates(settings?.cardTemplates).map((t) => (t.builtin ? { ...t, enabled: rec.includes(t.id) } : t)),
    };
    let res;
    try {
      res = await api.put('/api/settings', body);
    } catch (e) {
      if (my !== seq) return;
      saving = false;
      busy(next, false);
      paintNext();
      bird.setMood('sad');
      later(() => { if (my === seq && !saving) bird.setMood(STEPS[index].mood || 'idle'); }, 1800);
      toast(e.message, 'bad', 5000);
      return;
    }
    // Saved: the rest of the app reads the answers from state even if the
    // learner already left this screen.
    setSettings(res);
    if (my !== seq) return;
    bird.setMood('cheer');
    // On the body, not this view: the confetti keeps falling over Today.
    celebrate(document.body);
    later(() => { if (my === seq) navigate('/today'); }, 700);
  }

  /* Enter continues. Space still toggles a focused card; inside the textarea
     Enter is a new line (Ctrl/Cmd+Enter continues). */
  keyHandler = (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.altKey || e.shiftKey) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest('textarea') && !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    if (t?.closest('.wl-back')) { back.click(); return; }
    const single = t?.closest('.wl-opt[data-single]');
    if (single && single.getAttribute('aria-checked') !== 'true') { single.click(); return; }
    go();
  };
  document.addEventListener('keydown', keyHandler);

  root.append(page);
  show(0, 1);

  /* The learner's own most recent word makes the preview real. A short one
     reads best at this size; any failure keeps 謝謝, a preview is not worth an error. */
  api.get('/api/words?sort=recent').then((res) => {
    if (my !== seq) return;
    const words = (Array.isArray(res?.words) ? res.words : []).filter((w) => w?.hanzi && (w.pinyin || w.zhuyin));
    const pick = words.find((w) => [...w.hanzi].length <= 4) || words[0];
    if (!pick) return;
    sample = pick;
    paintPreview?.();
  }).catch(() => {});
}

function unmount() {
  seq++;
  detach();
}

export default { id: 'welcome', title: 'Welcome', render, unmount };
