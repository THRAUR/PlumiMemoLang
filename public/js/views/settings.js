/* ============================================================
   settings.js — every knob, one screen, seven Mac windows.

   There is no Save button: each control writes its own partial through
   PUT /api/settings the moment it changes (text and numbers debounced
   500 ms so a name does not fire eleven requests) and the reply — the
   whole settings document — goes back into state via setSettings().

   The API key is the exception to "read the live binding": the browser
   only ever sees ai.apiKeyMasked + ai.hasApiKey, so this view can show
   that a key exists but never what it is.
   ============================================================ */
import { api } from '../api.js';
import { settings, setSettings, refreshStats, on } from '../state.js';
import { navigate } from '../router.js';
import {
  h, toast, openWindow, confirmWindow, busy, pixelIcon, fmt, setTitle, tts,
} from '../ui.js';
import { SKILLS, REASONS, CLASSES, TEMPLATE_FIELDS, DEFAULT_GOALS, normaliseGoals, normaliseTemplates, focusOf, learnerProfile, LANGUAGES } from '/shared/goals.js';

/* ---------- option tables ---------- */
/* Exported for the welcome questions, which offer the same list. */
const LEVELS = [['beginner', 'Beginner'], ['elementary', 'Elementary'], ['intermediate', 'Intermediate'], ['advanced', 'Advanced']];
const SCRIPTS = [['zhuyin', '注音 Zhuyin', 'zh-Hant'], ['pinyin', 'Pinyin'], ['both', 'Both']];
const THEMES = [['light', 'Paper'], ['dark', 'Phosphor'], ['system', 'System']];
/* The field picker speaks the learner's language; the tags on a template row keep
   the short field names the server validates (TEMPLATE_FIELDS in shared/goals.js). */
const FIELD_LABELS = {
  hanzi: 'Characters', reading: 'Reading', meaning: 'Meaning', example: 'Example', audio: 'Audio',
  cloze: 'Fill the blank', notes: 'Notes', tags: 'Tags', record: 'Record yourself',
};
const HANZI_SEG = [['full', 'Big'], ['small', 'Small'], ['hidden', 'Hidden']];
const HANZI_HELP = {
  full: 'Characters lead, with the reading above them.',
  small: 'The reading leads; the characters sit small underneath, to check the meaning.',
  hidden: 'Only the reading. The characters stay out of the way.',
};
const FOCUS_TAG = { speaking: 'Speaking focus', characters: 'Characters focus', balanced: 'Balanced' };
const FOCUS_WORDS = { speaking: 'speaking', characters: 'characters', balanced: 'a mix of speaking and characters' };
const ABOUT_MAX = 500;       // the server's limit for goals.about

/* A settings document to render against while GET /api/settings is unavailable,
   so the screen is never blank and never throws on a missing branch. */
const FALLBACK = {
  learnerName: '', nativeLanguage: 'en', script: 'zhuyin', level: 'beginner',
  dailyGoalXp: 30, newWordsPerDay: 5, theme: 'system',
  tts: { voice: '', rate: 0.9 },
  cardTemplates: [],
  goals: { ...DEFAULT_GOALS },
  display: { hanzi: '' },
  ai: { priority: [], monthlyBudgetUsd: 5, hasApiKey: false, apiKeyMasked: '' },
};

/* ---------- module state ---------- */
let gen = 0;                 // render generation; async work from an old render is dropped
const pending = new Map();   // debounce timer → the save it owes
let offSettings = null;      // state.on('settings') unsubscribe
let onVoices = null;         // speechSynthesis voiceschanged handler
let modelsCache = null;
const repaints = new Set();  // panels that derive from settings and repaint in place

function cur() { return settings || FALLBACK; }
function icon(name, cell = 2) { return pixelIcon(name, cell); }
/* replaceChildren()/append() turn a null child into the text "null" — h()
   drops it. Conditional children go through these two. */
function setKids(el, ...kids) {
  el.replaceChildren();
  return addKids(el, ...kids);
}
function addKids(el, ...kids) {
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k);
  return el;
}
/* openWindow() lives in #windows, outside the view, so a hash change (the
   Back button, a tap on the tab bar) would leave a modal floating over the
   next screen. Every window this view opens goes through here and is closed
   on unmount. */
let liveWin = null;
function win(opts) {
  liveWin?.close();
  liveWin = openWindow({ ...opts, onClose: (r) => { liveWin = null; opts.onClose?.(r); } });
  return liveWin;
}
function closeWin() { liveWin?.close(); liveWin = null; }

/* ---------- saving ---------- */
async function save(patch) {
  try {
    const s = await api.put('/api/settings', patch);
    setSettings(s);
    toast('Saved', '', 1500);
    return s;
  } catch (e) {
    toast(e.message, 'bad');
    return null;
  }
}
/* One debouncer per field: two fields edited in the same second must both
   land, so they cannot share a timer. A pending save is FLUSHED on unmount,
   never dropped — leaving the screen must not eat the last keystroke. */
function debouncedSaver(ms = 500) {
  let t = null;
  return (patch) => {
    if (t) { clearTimeout(t); pending.delete(t); }
    const flush = () => save(patch);
    t = setTimeout(() => { pending.delete(t); t = null; flush(); }, ms);
    pending.set(t, flush);
  };
}
/* Returns once every flushed save has landed, for "Ask me again", which must
   not open the questions before the last keystroke in the note is stored. */
function flushPending() {
  const saves = [];
  for (const [t, flush] of pending) { clearTimeout(t); saves.push(flush()); }
  pending.clear();
  return Promise.all(saves);
}

/* ---------- kit shorthands ---------- */
function panel(title, ...body) {
  return h('section', { class: 'pl-win st-panel' },
    h('div', { class: 'pl-titlebar' }, h('span', { class: 'pl-title' }, title), h('span', { class: 'spacer' })),
    h('div', { class: 'win-body' }, ...body));
}
function field(label, control, help) {
  return h('label', { class: 'field' },
    h('span', { class: 'label' }, label), control,
    help ? h('span', { class: 'help' }, help) : null);
}
function selectEl(options, value, onChange) {
  const sel = h('select', { class: 'select' },
    options.map(([v, label, lang]) => h('option', { value: v, lang: lang || undefined }, label)));
  sel.value = options.some(([v]) => v === value) ? value : options[0][0];
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}
function segEl(options, value, onPick) {
  const box = h('div', { class: 'seg st-seg' });
  const btns = options.map(([v, label, lang]) => {
    const b = h('button', { type: 'button', class: v === value ? 'is-active' : '', lang: lang || undefined }, label);
    b.addEventListener('click', () => {
      for (const x of btns) x.classList.toggle('is-active', x === b);
      onPick(v);
    });
    return b;
  });
  box.append(...btns);
  return box;
}
function numberEl({ value, min, max, step }, commit) {
  const input = h('input', { class: 'input st-num', type: 'number', min, max, step, value: String(value ?? '') });
  const fire = debouncedSaver();
  const read = () => {
    const n = Number(input.value);
    if (input.value === '' || !Number.isFinite(n)) return null;
    return Math.min(max, Math.max(min, n));
  };
  /* Clamp only on blur/commit: rewriting the box mid-keystroke fights the
     learner typing "120" through "1". */
  input.addEventListener('input', () => { const n = read(); if (n !== null) fire(commit(n)); });
  input.addEventListener('change', () => { const n = read(); if (n !== null) input.value = String(n); });
  return input;
}
function tagList(names) {
  const box = h('span', { class: 'st-fields' });
  if (!names?.length) return h('span', { class: 'st-fields' }, h('span', { class: 'faint small' }, 'nothing'));
  for (const n of names) box.append(h('span', { class: 'pl-tag' }, n));
  return box;
}

/* ---------- money / model formatting ---------- */
function per1M(price) {
  const v = Number(price || 0) * 1e6;
  if (!v) return 'free';
  return v < 1000 ? `$${v.toFixed(2)}` : `$${Math.round(v)}`;
}
function hasImage(m) { return (m?.inputModalities || []).includes('image'); }
async function getModels({ refresh = false } = {}) {
  if (!refresh && modelsCache) return modelsCache;
  const raw = await api.get(`/api/models${refresh ? '?refresh=1' : ''}`);
  modelsCache = Array.isArray(raw) ? raw : (raw?.models || []);
  return modelsCache;
}

/* ---------- 0. Your goals ----------
   The welcome answers, editable in place (docs/ARCHITECTURE.md §8.7). Chips and
   segments save the moment they change; the note for Plumi is debounced like
   every text field here and is never repainted, so a save cannot eat a
   half-typed sentence. */
function goalsPanel() {
  const ids = (list) => list.map((x) => x.id);
  let focusMoved = false;      // a skills change on this visit moved the focus

  function chipSet(options, getOn, onToggle, label) {
    const box = h('div', { class: 'st-chips', role: 'group', 'aria-label': label });
    const buttons = options.map((o) => {
      const b = h('button', { class: 'st-chip', type: 'button', 'aria-pressed': 'false' }, icon('plus', 1), h('span', null, o.label));
      b.addEventListener('click', () => onToggle(o.id));
      box.append(b);
      return { id: o.id, b };
    });
    /* Painted in place, so the chip a keyboard user just pressed keeps focus. */
    box.paint = () => {
      const on = getOn();
      for (const { id, b } of buttons) {
        const isOn = on.includes(id);
        if (b.getAttribute('aria-pressed') === String(isOn)) continue;
        b.classList.toggle('is-on', isOn);
        b.setAttribute('aria-pressed', String(isOn));
        b.firstChild.replaceWith(icon(isOn ? 'check' : 'plus', 1));
      }
    };
    box.paint();
    return box;
  }
  /* Quick taps must not undo each other: each tap builds on the list the last
     tap left, not on settings that are still on their way back from the server. */
  function listEditor(key, allowed, { label, min = 0, minText = '', onSaved = null }) {
    let draft = null;
    let inFlight = 0;
    const now = () => draft || normaliseGoals(cur().goals)[key];
    async function toggle(id) {
      const before = now();
      const on = !before.includes(id);
      const next = ids(allowed).filter((x) => (x === id ? on : before.includes(x)));
      if (next.length < min) { toast(minText, 'bad'); return; }
      draft = next;
      inFlight += 1;
      chips.paint();
      const saved = await save({ goals: { [key]: next } });
      inFlight -= 1;
      if (!inFlight) draft = null;
      if (saved) onSaved?.(before, next);
      paint();                 // a failed save repaints the stored answer back
    }
    const chips = chipSet(allowed, now, toggle, label);
    return chips;
  }

  const focusTag = h('span', { class: 'pl-tag' });
  const skillChips = listEditor('skills', SKILLS, {
    label: 'What you want to do', min: 1, minText: 'Keep at least one thing you want to do.',
    onSaved: (before, next) => { if (focusOf({ skills: before }) !== focusOf({ skills: next })) focusMoved = true; },
  });
  const reasonChips = listEditor('reasons', REASONS, { label: 'Why you are learning' });

  /* The focus moved but the cards still drill the old one: offer to follow. */
  const hintText = h('span', { class: 'st-goalhint-text' });
  const switchBtn = h('button', { class: 'btn btn--sm btn--primary', type: 'button' }, 'Switch my cards to match');
  const hint = h('div', { class: 'st-goalhint', role: 'status', hidden: true }, hintText, switchBtn);
  function paintHint() {
    const p = learnerProfile(cur());
    const enabled = normaliseTemplates(cur().cardTemplates).filter((t) => t.builtin && t.enabled).map((t) => t.id);
    const matches = p.templates.length === enabled.length && p.templates.every((id) => enabled.includes(id));
    hintText.textContent = `Your focus is now ${FOCUS_WORDS[p.focus]}.`;
    hint.hidden = !focusMoved || matches;
  }
  switchBtn.addEventListener('click', async () => {
    const rec = learnerProfile(cur()).templates;
    // Builtins follow the focus; a template the learner made keeps its own switch.
    const next = normaliseTemplates(cur().cardTemplates).map((t) => (t.builtin ? { ...t, enabled: rec.includes(t.id) } : t));
    busy(switchBtn, true);
    const saved = await save({ cardTemplates: next });
    busy(switchBtn, false);
    if (saved) { focusMoved = false; paintHint(); }
  });

  /* Characters: the stored mode, or the one the focus picks while nothing is stored. */
  const hanziHelp = h('span', { class: 'help' });
  const hanziSeg = segEl(HANZI_SEG, learnerProfile(cur()).hanzi, (v) => {
    paintHanziHelp(v, true);
    save({ display: { hanzi: v } }).then((saved) => { if (!saved) paintHanzi(); });
  });
  function paintHanziHelp(mode, chosen = Boolean(cur().display?.hanzi)) {
    hanziHelp.textContent = `${HANZI_HELP[mode] || ''}${chosen ? '' : ' Picked from your goals.'}`;
  }
  function paintHanzi() {
    const mode = learnerProfile(cur()).hanzi;
    [...hanziSeg.children].forEach((b, i) => b.classList.toggle('is-active', HANZI_SEG[i][0] === mode));
    paintHanziHelp(mode);
  }

  const aboutSave = debouncedSaver();
  const about = h('textarea', {
    class: 'textarea st-about', rows: 3, maxlength: ABOUT_MAX,
    placeholder: 'My teacher is Carl, we meet twice a week', value: normaliseGoals(cur().goals).about,
  });
  const aboutCount = h('span', { class: 'st-count mono' });
  const paintCount = () => { aboutCount.textContent = `${about.value.length} / ${ABOUT_MAX}`; };
  about.addEventListener('input', () => { paintCount(); aboutSave({ goals: { about: about.value.trim() } }); });
  paintCount();

  const again = h('button', { class: 'btn', type: 'button' }, icon('refresh'), 'Ask me again');
  again.addEventListener('click', async () => {
    busy(again, true);
    await flushPending();
    navigate('/welcome');
  });

  function paint() {
    focusTag.textContent = FOCUS_TAG[learnerProfile(cur()).focus];
    skillChips.paint();
    reasonChips.paint();
    paintHanzi();
    paintHint();
  }
  repaints.add(paint);
  paint();

  return panel('Your goals',
    h('div', { class: 'field' },
      h('div', { class: 'st-goalhead' }, h('span', { class: 'label' }, 'What you want to do'), focusTag),
      skillChips, hint),
    h('div', { class: 'grid-2' },
      h('div', { class: 'field' },
        h('span', { class: 'label' }, 'Readings'),
        segEl(SCRIPTS, cur().script || 'zhuyin', (v) => save({ script: v }))),
      h('div', { class: 'field' },
        h('span', { class: 'label' }, 'Characters'),
        hanziSeg)),
    hanziHelp,
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Why you are learning'), reasonChips),
    h('label', { class: 'field' },
      h('span', { class: 'label' }, 'Anything Plumi should know'),
      about,
      h('span', { class: 'st-countrow' }, h('span', { class: 'help' }, 'Plumi reads this when it writes your lessons.'), aboutCount)),
    field('Classes', selectEl(CLASSES.map((c) => [c.id, c.label]), normaliseGoals(cur().goals).classes, (v) => save({ goals: { classes: v } }))),
    h('div', { class: 'row row--wrap st-again' },
      again,
      h('span', { class: 'help' }, 'Plumi asks the welcome questions again, starting from these answers.')));
}

/* ---------- 1. Learner ---------- */
function learnerPanel() {
  const s = cur();
  const nameSave = debouncedSaver();
  const name = h('input', { class: 'input', type: 'text', value: s.learnerName || '', placeholder: 'Your name', maxlength: 60 });
  name.addEventListener('input', () => nameSave({ learnerName: name.value.trim() }));

  // Readings moved to "Your goals", next to how big the characters are.
  return panel('Learner',
    field('Your name', name, 'Plumi greets you with it.'),
    h('div', { class: 'grid-2' },
      field('Explain things in', selectEl(LANGUAGES, s.nativeLanguage || 'en', (v) => save({ nativeLanguage: v }))),
      field('Your level', selectEl(LEVELS, s.level || 'beginner', (v) => save({ level: v })))),
    h('div', { class: 'grid-2' },
      field('Daily goal (XP)', numberEl({ value: s.dailyGoalXp ?? 30, min: 5, max: 500, step: 5 }, (n) => ({ dailyGoalXp: n }))),
      field('New words per day', numberEl({ value: s.newWordsPerDay ?? 5, min: 0, max: 50, step: 1 }, (n) => ({ newWordsPerDay: n })))));
}

/* ---------- 2. Look ---------- */
function lookPanel() {
  /* The theme lives in localStorage (theme.js reads it before first paint) AND
     in settings, so a second device picks it up. localStorage wins locally. */
  const mode = window.PlumiTheme?.mode?.() || cur().theme || 'system';
  return panel('Look',
    h('div', { class: 'field' },
      h('span', { class: 'label' }, 'Theme'),
      segEl(THEMES, mode, (v) => { window.PlumiTheme?.set?.(v); save({ theme: v }); }),
      h('span', { class: 'help' }, 'Paper is the daylight desk; Phosphor is the late-night one. System follows your device.')));
}

/* ---------- 3. Voice ---------- */
function voicePanel() {
  if (!tts.available) return null;
  const sel = h('select', { class: 'select' });
  const voiceHelp = h('span', { class: 'help' });
  function paintVoices() {
    const list = tts.voices();
    const want = cur().tts?.voice || '';
    const opts = [h('option', { value: '' }, 'Best available')];
    for (const v of list) opts.push(h('option', { value: v.name }, `${v.name} · ${v.lang}`));
    if (want && !list.some((v) => v.name === want)) opts.push(h('option', { value: want }, `${want} (not on this device)`));
    sel.replaceChildren(...opts);
    sel.value = want;
    voiceHelp.textContent = list.length
      ? `${list.length} Chinese voice${list.length === 1 ? '' : 's'} installed. 台灣 (zh-TW) voices sound closest to your class.`
      : 'No Chinese voice is installed here yet — the browser will read with its default one.';
  }
  sel.addEventListener('change', () => save({ tts: { voice: sel.value } }));

  const rateNow = Number(cur().tts?.rate ?? 0.9);
  const rate = h('input', { class: 'st-range', type: 'range', min: 0.5, max: 1.2, step: 0.05, value: String(rateNow) });
  const rateVal = h('span', { class: 'st-rangeval mono' }, `${rateNow.toFixed(2)}×`);
  const rateSave = debouncedSaver();
  rate.addEventListener('input', () => {
    rateVal.textContent = `${Number(rate.value).toFixed(2)}×`;
    rateSave({ tts: { rate: Number(rate.value) } });
  });

  const test = h('button', { class: 'btn', type: 'button' }, icon('speaker'), 'Test voice');
  test.addEventListener('click', () => tts.speak('你好，我是 Plumi。', { rate: Number(rate.value) }));

  /* Chrome fills getVoices() asynchronously: without this the select is empty
     on a cold load and never recovers. */
  onVoices = paintVoices;
  try { speechSynthesis.addEventListener('voiceschanged', paintVoices); } catch { onVoices = null; }
  paintVoices();

  return panel('Voice',
    field('Voice', sel), voiceHelp,
    h('div', { class: 'field' },
      h('span', { class: 'label' }, 'Speed'),
      h('div', { class: 'row st-raterow' }, rate, rateVal)),
    h('div', { class: 'row row--wrap' }, test));
}

/* ---------- 4. AI (OpenRouter) ---------- */
function aiPanel(my) {
  /* --- the key --- */
  const keyRow = h('div', { class: 'row row--wrap st-keyrow' });
  const actionRow = h('div', { class: 'row row--wrap st-keyactions' });
  const keyInput = h('input', { class: 'input', type: 'password', placeholder: 'Paste a new key', autocomplete: 'off', spellcheck: 'false' });
  const saveKey = h('button', { class: 'btn btn--primary' }, 'Save key');
  const removeKey = h('button', { class: 'btn btn--sm btn--quiet', type: 'button' }, icon('trash'), 'Remove key');
  const testBtn = h('button', { class: 'btn btn--sm', type: 'button' }, icon('bolt'), 'Test connection');

  function paintKey() {
    const ai = cur().ai || {};
    setKids(keyRow,
      ai.hasApiKey ? h('span', { class: 'pl-tag good' }, 'key saved') : h('span', { class: 'pl-tag due' }, 'no key yet'),
      ai.hasApiKey && ai.apiKeyMasked ? h('span', { class: 'pill mono' }, ai.apiKeyMasked) : null);
    /* Remove sits with Test, not above the paste box, where it reads like
       that box's label. */
    setKids(actionRow, testBtn, ai.hasApiKey ? removeKey : null);
  }
  repaints.add(paintKey);

  saveKey.addEventListener('click', async () => {
    const v = keyInput.value.trim();
    if (!v) { toast('Paste a key first.', 'bad'); keyInput.focus(); return; }
    busy(saveKey, true);
    const s = await save({ ai: { apiKey: v } });
    busy(saveKey, false);
    if (s) keyInput.value = '';
  });
  removeKey.addEventListener('click', async () => {
    if (!(await confirmWindow({
      title: 'Remove the key?',
      text: 'Plumi stops being able to read notes, suggest words or write readings until you paste a new one.',
      okLabel: 'Remove', danger: true,
    }))) return;
    await save({ ai: { apiKey: '' } });
  });
  testBtn.addEventListener('click', async () => {
    busy(testBtn, true);
    try {
      const res = await api.post('/api/ai/test', {});
      const after = res?.fallbacks?.length ? ` after ${res.fallbacks.map((f) => nameOf(f.model)).join(', ')} failed` : '';
      toast(`${nameOf(res?.model)} answered${after}${res?.reply ? `: ${res.reply}` : '.'}`, 'ok', 6000);
    } catch (e) {
      toast(e.message, 'bad', 5000);
    } finally {
      busy(testBtn, false);
    }
  });

  /* --- models: the allowed list, in the order Plumi tries them ---
     The key only allows these models, so there is nothing to pick from, only
     an order to set. Each row says why it sits where it does and what it costs,
     and can be tested on its own: "is my backup alive?" has to be answerable
     before the day the first model is down. */
  const prioList = h('div', { class: 'list st-prio' });
  const prioNote = h('p', { class: 'help st-prio-note' }, 'Loading the model list…');
  const resetOrder = h('button', { class: 'btn btn--sm btn--quiet', type: 'button' }, icon('refresh'), 'Recommended order');
  resetOrder.hidden = true;
  const results = new Map();     // model id → the last per-model test, kept across repaints

  /* OpenRouter may answer with a dated id ("…-flash-lite-20260721"); the name
     is looked up by prefix so the toast still says "Gemini 3.5 Flash Lite". */
  function nameOf(id) {
    const s = String(id || '');
    const m = (modelsCache || []).find((x) => s === x.id || s.startsWith(`${x.id}-`) || s.startsWith(`${x.id}:`));
    return m?.name || s || 'A model';
  }
  function currentOrder() {
    const order = cur().ai?.priority;
    return Array.isArray(order) && order.length ? order : (modelsCache || []).map((m) => m.id);
  }
  function recommendedOrder() {
    return [...(modelsCache || [])]
      .filter((m) => m.recommendedRank)
      .sort((a, b) => a.recommendedRank - b.recommendedRank)
      .map((m) => m.id);
  }
  function move(id, delta) {
    const order = [...currentOrder()];
    const i = order.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    save({ ai: { priority: order } });
  }
  async function testOne(id, button) {
    busy(button, true);
    try {
      const res = await api.post('/api/ai/test', { model: id });
      if (my !== gen) return;
      results.set(id, { ok: true, label: 'works' });
      toast(`${nameOf(id)} works${res?.reply ? `: ${res.reply}` : '.'}`, 'ok', 5000);
    } catch (e) {
      if (my !== gen) return;
      results.set(id, { ok: false, label: 'failed' });
      toast(`${nameOf(id)}: ${e.message}`, 'bad', 6000);
    } finally {
      busy(button, false);
      if (my === gen) paintOrder();
    }
  }

  function paintOrder() {
    const order = currentOrder();
    /* Rows wait for the model list: without it every row would claim "text
       only" for a moment, which is exactly the fact the learner acts on. */
    if (!order.length || !modelsCache) {
      prioList.replaceChildren(h('div', { class: 'list-row' }, h('span', { class: 'help' }, 'Loading the model list…')));
      return;
    }
    const byId = new Map(modelsCache.map((m) => [m.id, m]));
    const keyed = Boolean(cur().ai?.hasApiKey);
    prioList.replaceChildren(...order.map((id, i) => {
      const m = byId.get(id) || { id, name: id };
      const last = results.get(id);
      const up = h('button', { class: 'btn btn--icon btn--sm btn--quiet', type: 'button', 'aria-label': `Move ${m.name} up`, title: 'Move up', disabled: i === 0 }, icon('up'));
      const down = h('button', { class: 'btn btn--icon btn--sm btn--quiet', type: 'button', 'aria-label': `Move ${m.name} down`, title: 'Move down', disabled: i === order.length - 1 }, icon('down'));
      up.addEventListener('click', () => move(id, -1));
      down.addEventListener('click', () => move(id, 1));
      const test = h('button', {
        class: 'btn btn--sm', type: 'button', disabled: !keyed,
        title: keyed ? `Send ${m.name} one short message` : 'Save a key first',
      }, icon('bolt'), 'Test');
      test.addEventListener('click', () => testOne(id, test));
      const price = m.pricing
        ? `${per1M(m.pricing.prompt)} in · ${per1M(m.pricing.completion)} out, per 1M tokens`
        : (m.inCatalog === false ? 'Not in the OpenRouter catalog right now' : '');
      return h('div', { class: 'list-row st-prio-row' },
        h('span', { class: `st-rank${i === 0 ? ' is-first' : ''}`, title: i === 0 ? 'Tried first' : 'Tried when the models above it fail' }, String(i + 1)),
        h('div', { class: 'grow st-prio-main' },
          h('div', { class: 'st-prio-top' },
            h('b', { class: 'st-prio-name' }, m.name || id),
            h('span', { class: 'pl-tag' }, hasImage(m) ? 'reads photos' : 'text only'),
            last ? h('span', { class: `pl-tag ${last.ok ? 'good' : 'bad'}` }, last.label) : null),
          m.why ? h('div', { class: 'st-prio-why' }, m.why) : null,
          price ? h('div', { class: 'st-prio-meta mono' }, price) : null,
          h('div', { class: 'row st-prio-actions' }, test)),
        h('div', { class: 'st-prio-move' }, up, down));
    }));
    const recommended = recommendedOrder();
    resetOrder.hidden = !recommended.length || recommended.join('\n') === order.join('\n');
  }
  repaints.add(paintOrder);
  resetOrder.addEventListener('click', () => {
    const recommended = recommendedOrder();
    if (recommended.length) save({ ai: { priority: recommended } });
  });

  async function loadModels() {
    try {
      await getModels();
      if (my !== gen) return;
      prioNote.textContent = 'Photo notes skip the models that cannot read photos.';
    } catch (e) {
      if (my !== gen) return;
      prioNote.textContent = e.message;
      toast(e.message, 'bad');
    }
    paintOrder();
  }

  /* --- budget --- */
  const budget = numberEl(
    { value: cur().ai?.monthlyBudgetUsd ?? 5, min: 0, max: 1000, step: 1 },
    (n) => ({ ai: { monthlyBudgetUsd: n } }));

  /* --- usage --- */
  const usageBox = h('div', { class: 'st-usagebox' }, h('p', { class: 'help' }, 'Loading usage…'));
  async function loadUsage() {
    let data;
    try {
      data = await api.get('/api/usage');
    } catch (e) {
      if (my !== gen) return;
      toast(e.message, 'bad');
      usageBox.replaceChildren(h('p', { class: 'help' }, 'The usage log could not load.'), h('p', { class: 'help' }, e.message));
      return;
    }
    if (my !== gen) return;
    const totals = data?.totals || {};
    const entries = (Array.isArray(data?.entries) ? data.entries : []).slice(-20).reverse();
    const budgetUsd = Number(cur().ai?.monthlyBudgetUsd || 0);
    const over = budgetUsd > 0 && Number(totals.monthUsd || 0) >= budgetUsd;
    usageBox.replaceChildren(
      h('div', { class: 'row row--wrap st-usagehead' },
        h('p', { class: 'pl-eyebrow no-rule' }, 'What you have spent'),
        over ? h('span', { class: 'pl-tag due' }, 'over budget') : null),
      h('div', { class: 'scoreboard' },
        h('div', { class: 'score' }, h('div', { class: 'n' }, fmt.usd(totals.todayUsd)), h('div', { class: 'l' }, 'Today')),
        h('div', { class: 'score' }, h('div', { class: 'n' }, fmt.usd(totals.monthUsd)), h('div', { class: 'l' }, 'This month')),
        h('div', { class: 'score' }, h('div', { class: 'n' }, fmt.usd(totals.allUsd)), h('div', { class: 'l' }, 'All time')),
        h('div', { class: 'score' }, h('div', { class: 'n' }, fmt.n(totals.calls)), h('div', { class: 'l' }, 'Calls'))),
      entries.length
        ? h('div', { class: 'list st-usage' }, entries.map((e) => h('div', { class: 'list-row st-usagerow' },
          h('span', { class: 'grow' },
            h('span', { class: 'st-usage-top' },
              h('span', { class: `pl-tag ${e.ok === false ? 'bad' : ''}`.trim() }, e.task || 'call'),
              h('span', { class: 'st-usage-model mono ellipsis' }, e.model || '')),
            h('span', { class: 'st-usage-meta' },
              h('span', null, `${fmt.n(e.promptTokens)} in`),
              h('span', null, `${fmt.n(e.completionTokens)} out`),
              h('span', null, fmt.rel(e.at)))),
          h('span', { class: 'st-usage-cost mono' }, fmt.usd(e.cost)))))
        : h('p', { class: 'help' }, 'No AI calls yet.'));
  }

  paintKey();
  paintOrder();
  loadModels();
  loadUsage();

  return panel('AI · OpenRouter',
    h('div', { class: 'field' },
      h('span', { class: 'label' }, 'API key'),
      keyRow,
      h('div', { class: 'row row--wrap st-keyform' }, keyInput, saveKey),
      h('span', { class: 'help' },
        'Create one at ',
        h('a', { href: 'https://openrouter.ai/keys', target: '_blank', rel: 'noopener noreferrer' }, 'openrouter.ai/keys'),
        '. It is stored on this machine only and never sent to the browser again.'),
      actionRow),
    h('hr', { class: 'divider' }),
    h('div', { class: 'field' },
      h('span', { class: 'label' }, 'Model order'),
      h('span', { class: 'help' }, 'Plumi starts at the top. When a model fails, it moves down to the next one. Your key only allows these models.'),
      prioList,
      h('div', { class: 'row row--wrap st-prio-foot' }, prioNote, resetOrder)),
    h('hr', { class: 'divider' }),
    field('Monthly budget (USD)', budget, 'A soft ceiling: Plumi warns you, it does not stop you.'),
    usageBox);
}

/* ---------- 5. Memo card templates ---------- */
function templatesPanel() {
  const list = h('div', { class: 'list st-templates' });

  /* Always the normalised list, matched by id: a PUT reply carries the stored list
     as it is (old names, and no "Say it" in a file from an older build), so a
     position in that list is not a position in this one. */
  const allTemplates = () => normaliseTemplates(cur().cardTemplates);
  /* Review needs at least one kind of card to ask. */
  const lastOn = (t) => t.enabled !== false && !allTemplates().some((x) => x.id !== t.id && x.enabled !== false);

  function rowFor(t) {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = t.enabled !== false;
    cb.addEventListener('change', () => {
      if (!cb.checked && lastOn(t)) {
        cb.checked = true;
        toast('Keep at least one card type on, or Review has nothing to ask.', 'bad');
        return;
      }
      const next = allTemplates().map((x) => (x.id === t.id ? { ...x, enabled: cb.checked } : x));
      save({ cardTemplates: next }).then((saved) => { if (!saved) paint(); });
    });
    const del = t.builtin ? null : h('button', {
      class: 'btn btn--icon btn--sm btn--quiet', type: 'button', 'aria-label': `Delete ${t.name}`, title: 'Delete',
    }, icon('x'));
    del?.addEventListener('click', async () => {
      if (lastOn(t)) { toast('Turn on another card type before deleting this one.', 'bad'); return; }
      if (!(await confirmWindow({ title: `Delete “${t.name}”?`, text: 'Cards already reviewed keep their history; this template just stops appearing.', okLabel: 'Delete', danger: true }))) return;
      save({ cardTemplates: allTemplates().filter((x) => x.id !== t.id) });
    });
    // Which builtins the learner's goals would pick, so "Switch my cards to match" is never a mystery.
    const fits = t.builtin && learnerProfile(cur()).templates.includes(t.id);
    return h('div', { class: 'list-row st-tpl' },
      h('label', { class: 'check st-tpl-check' }, cb, h('span', { class: 'sr-only' }, `Use ${t.name}`)),
      h('div', { class: 'grow st-tpl-main' },
        h('div', { class: 'st-tpl-top' },
          h('b', null, t.name || t.id),
          fits ? h('span', { class: 'pl-tag' }, 'fits your goals') : null,
          t.builtin ? null : h('span', { class: 'pl-tag' }, 'custom')),
        h('div', { class: 'st-tpl-fields' },
          tagList(t.front), h('span', { class: 'st-arrow' }, '→'), tagList(t.back))),
      del);
  }
  function paint() {
    const tpls = allTemplates();
    list.replaceChildren(...(tpls.length
      ? tpls.map(rowFor)
      : [h('div', { class: 'list-row' }, h('span', { class: 'help' }, 'No card templates yet. Add one below.'))]));
  }
  repaints.add(paint);
  paint();

  const add = h('button', { class: 'btn btn--primary', type: 'button' }, icon('plus'), 'New template');
  add.addEventListener('click', () => newTemplateWindow());

  return panel('Memo card templates',
    h('p', { class: 'help' }, 'Each enabled template becomes one kind of card in Review. Front is the question, back is the answer.'),
    list, h('div', { class: 'row row--wrap' }, add));
}

function newTemplateWindow() {
  const name = h('input', { class: 'input', type: 'text', placeholder: 'Hanzi → meaning', maxlength: 40 });
  const mk = (which) => {
    const box = h('div', { class: 'st-fieldpick' });
    const inputs = {};
    for (const f of TEMPLATE_FIELDS) {
      const cb = h('input', { type: 'checkbox' });
      inputs[f] = cb;
      box.append(h('label', { class: 'check st-fieldcheck' }, cb, FIELD_LABELS[f] || f));
    }
    return { box, read: () => TEMPLATE_FIELDS.filter((f) => inputs[f].checked), which };
  };
  const front = mk('front');
  const back = mk('back');

  win({
    title: 'New card template', wide: true,
    body: h('div', { class: 'stack' },
      field('Name', name),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Front (the question)'), front.box),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Back (the answer)'), back.box)),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Add template', primary: true, onClick: async () => {
          const label = name.value.trim();
          const f = front.read(), b = back.read();
          if (!label) { toast('Give the template a name.', 'bad'); return false; }
          if (!f.length || !b.length) { toast('Pick at least one field for each side.', 'bad'); return false; }
          const existing = normaliseTemplates(cur().cardTemplates);
          const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'template';
          let id = base, n = 2;
          while (existing.some((t) => t.id === id)) id = `${base}-${n++}`;
          const next = [...existing, { id, name: label, front: f, back: b, builtin: false, enabled: true }];
          const saved = await save({ cardTemplates: next });
          if (!saved) return false;
        },
      },
    ],
  });
}

/* ---------- 6. Data ---------- */
function dataPanel(my) {
  const restoreFile = h('input', { class: 'st-file', type: 'file', accept: '.json,application/json' });
  const restore = h('button', { class: 'btn', type: 'button' }, icon('refresh'), 'Restore backup');
  restore.addEventListener('click', () => restoreFile.click());
  restoreFile.addEventListener('change', async () => {
    const file = (restoreFile.files || [])[0];
    restoreFile.value = '';
    if (!file) return;
    busy(restore, true);
    let payload;
    try {
      /* Parsed here, not on the server, so a wrong file is caught before it
         can touch anything. */
      payload = JSON.parse(await file.text());
    } catch {
      busy(restore, false);
      toast('That file is not valid JSON.', 'bad');
      return;
    }
    busy(restore, false);
    if (!payload || typeof payload !== 'object') { toast('That backup file has the wrong shape.', 'bad'); return; }
    if (!(await confirmWindow({
      title: 'Restore this backup?',
      text: 'This replaces every word, lesson and note.',
      okLabel: 'Restore', danger: true,
    }))) return;
    busy(restore, true);
    try {
      const res = await api.post('/api/backup/restore', payload);
      const counts = res?.counts || {};
      const bits = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ');
      toast(bits ? `Restored: ${bits}` : 'Backup restored.', 'ok', 5000);
      await refreshStats();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      busy(restore, false);
    }
  });

  const where = h('p', { class: 'help st-where' }, 'Looking for your data folder…');
  api.get('/api/health').then((hl) => {
    if (my !== gen) return;
    where.replaceChildren('Your data lives in ', h('span', { class: 'mono' }, hl?.dataDir || 'the data folder'),
      '. Back that folder up and you have backed up everything.');
  }).catch(() => {
    if (my !== gen) return;
    where.textContent = 'Your data lives in the data folder next to the app (see MEMOLANG_DATA_DIR in .env).';
  });

  return panel('Data',
    h('div', { class: 'row row--wrap st-databtns' },
      h('a', { class: 'btn btn--primary', href: '/api/backup', download: 'plumimemolang-backup.json' }, icon('star'), 'Download backup'),
      restore, restoreFile,
      h('a', { class: 'btn', href: '/api/words/export?format=csv', download: 'plumimemolang-words.csv' }, icon('words'), 'Export words (CSV)')),
    where,
    h('p', { class: 'help' }, 'To open the app on your phone, start the server with MEMOLANG_HOST=0.0.0.0 and use the network address it prints.'));
}

/* ---------- 7. About ---------- */
function aboutPanel(my) {
  const version = h('span', { class: 'pill mono' }, 'version …');
  api.get('/api/health').then((hl) => {
    if (my !== gen) return;
    version.textContent = `v${hl?.version || '?'}`;
  }).catch(() => { if (my === gen) version.textContent = 'version unknown'; });
  return panel('About',
    h('div', { class: 'row row--wrap' },
      h('span', { class: 'pl-eyebrow no-rule' }, 'PlumiMemoLang'), version),
    h('p', { class: 'help' }, 'PlumiMemoLang · your data stays on this machine; notes are sent to OpenRouter only when you ask for a lesson.'));
}

/* ---------- the view ---------- */
export default {
  id: 'settings',
  title: 'Settings',
  async render(root) {
    const my = ++gen;
    repaints.clear();

    /* voicePanel() is null on a browser without speechSynthesis. */
    setKids(root,
      goalsPanel(),
      learnerPanel(),
      lookPanel(),
      voicePanel(),
      aiPanel(my),
      templatesPanel(),
      dataPanel(my),
      aboutPanel(my));

    /* Panels that only display settings (the key, the model order, the
       template list) repaint themselves whenever the document changes —
       nothing here re-renders a field the learner might be typing in. */
    offSettings = on('settings', () => {
      if (my !== gen) return;
      for (const fn of repaints) { try { fn(); } catch (e) { console.warn('settings repaint:', e.message); } }
    });

    setTitle('Settings');
  },
  unmount() {
    gen++;
    flushPending();
    closeWin();
    repaints.clear();
    offSettings?.();
    offSettings = null;
    if (onVoices) {
      try { speechSynthesis.removeEventListener('voiceschanged', onVoices); } catch { /* no TTS here */ }
      onVoices = null;
    }
  },
};
