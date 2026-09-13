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
import {
  h, toast, openWindow, confirmWindow, busy, pixelIcon, fmt, setTitle, tts,
} from '../ui.js';

/* ---------- option tables ---------- */
const LANGUAGES = [
  ['en', 'English'], ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español'],
  ['it', 'Italiano'], ['pt', 'Português'], ['ja', '日本語', 'ja'], ['ko', '한국어', 'ko'],
  ['vi', 'Tiếng Việt'], ['th', 'ไทย', 'th'], ['id', 'Bahasa Indonesia'],
];
const LEVELS = [['beginner', 'Beginner'], ['elementary', 'Elementary'], ['intermediate', 'Intermediate'], ['advanced', 'Advanced']];
const SCRIPTS = [['zhuyin', '注音 Zhuyin', 'zh-Hant'], ['pinyin', 'Pinyin'], ['both', 'Both']];
const THEMES = [['light', 'Paper'], ['dark', 'Phosphor'], ['system', 'System']];
/* Order and wording are fixed by docs/ARCHITECTURE.md §4.7. The "why" is the
   only thing that makes a routing table usable: it says what the money buys. */
const TASKS = [
  { id: 'extract', label: 'Notes → lesson', importance: 'high', why: 'Turns your notes into the lesson you will learn from — use your best model' },
  { id: 'suggest', label: 'Daily new words', importance: 'medium', why: "Picks tomorrow's words; a mid-tier model is plenty" },
  { id: 'reading', label: 'Reading challenge', importance: 'medium', why: 'Writes a short passage; mid-tier' },
  { id: 'enrich', label: 'Complete a word', importance: 'low', why: 'Fills in readings and examples; a cheap model is fine' },
  { id: 'explain', label: 'Explain / ask', importance: 'low', why: 'Answers quick questions; a cheap model is fine' },
];
const CARD_FIELDS = ['hanzi', 'reading', 'meaning', 'example', 'audio', 'cloze', 'notes', 'tags'];
const PICKER_LIMIT = 30;

/* A settings document to render against while GET /api/settings is unavailable,
   so the screen is never blank and never throws on a missing branch. */
const FALLBACK = {
  learnerName: '', nativeLanguage: 'en', script: 'zhuyin', level: 'beginner',
  dailyGoalXp: 30, newWordsPerDay: 5, theme: 'system',
  tts: { voice: '', rate: 0.9 },
  cardTemplates: [],
  ai: { models: { default: '', extract: '', suggest: '', enrich: '', explain: '', reading: '' }, monthlyBudgetUsd: 5, hasApiKey: false, apiKeyMasked: '' },
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
function flushPending() {
  for (const [t, flush] of pending) { clearTimeout(t); flush(); }
  pending.clear();
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
function contextLabel(n) {
  const v = Number(n || 0);
  return v ? `${Math.round(v / 1000)}k ctx` : 'ctx ?';
}
function hasImage(m) { return (m?.inputModalities || []).includes('image'); }
async function getModels({ refresh = false } = {}) {
  if (!refresh && modelsCache) return modelsCache;
  const raw = await api.get(`/api/models${refresh ? '?refresh=1' : ''}`);
  modelsCache = Array.isArray(raw) ? raw : (raw?.models || []);
  return modelsCache;
}

/* ---------- the model picker ---------- */
function openModelPicker({ title = 'Choose a model', current = '', onPick }) {
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search by name or id', autocomplete: 'off' });
  const list = h('div', { class: 'list st-picker' });
  const note = h('p', { class: 'help' });

  const row = (m) => h('button', {
    class: `list-row st-model${m.id === current ? ' is-current' : ''}`, type: 'button',
    onClick: () => { closeWin(); onPick(m.id); },
  },
  h('span', { class: 'grow st-model-main' },
    h('span', { class: 'st-model-name ellipsis' }, m.name || m.id),
    h('span', { class: 'st-model-id mono ellipsis' }, m.id),
    h('span', { class: 'st-model-meta' },
      h('span', null, contextLabel(m.contextLength)),
      h('span', null, `${per1M(m.pricing?.prompt)} / ${per1M(m.pricing?.completion)} per 1M`))),
  h('span', { class: 'st-model-tags' },
    hasImage(m) ? h('span', { class: 'pl-tag' }, 'image') : null,
    m.supportsStructured ? h('span', { class: 'pl-tag' }, 'json') : null,
    m.id === current ? h('span', { class: 'pl-tag on' }, 'in use') : null));

  function paint() {
    const all = modelsCache || [];
    const q = search.value.trim().toLowerCase();
    const hits = q
      ? all.filter((m) => String(m.id || '').toLowerCase().includes(q) || String(m.name || '').toLowerCase().includes(q))
      : all;
    const top = hits.slice(0, PICKER_LIMIT);
    list.replaceChildren(...top.map(row));
    if (!all.length) {
      list.replaceChildren(h('div', { class: 'list-row' }, h('span', { class: 'help' }, 'No model list loaded. Close this and press “Refresh list”.')));
      note.textContent = '';
      return;
    }
    if (!top.length) list.replaceChildren(h('div', { class: 'list-row' }, h('span', { class: 'help' }, `Nothing matches “${search.value.trim()}”.`)));
    note.textContent = `${hits.length} of ${all.length} models${hits.length > top.length ? ` · showing the first ${PICKER_LIMIT}` : ''}`;
  }
  search.addEventListener('input', paint);
  paint();

  return win({
    title, wide: true,
    body: h('div', { class: 'stack st-pickerbox' },
      h('div', { class: 'search' }, icon('search'), search),
      list, note),
  });
}

/* ---------- 1. Learner ---------- */
function learnerPanel() {
  const s = cur();
  const nameSave = debouncedSaver();
  const name = h('input', { class: 'input', type: 'text', value: s.learnerName || '', placeholder: 'Your name', maxlength: 60 });
  name.addEventListener('input', () => nameSave({ learnerName: name.value.trim() }));

  return panel('Learner',
    field('Your name', name, 'Plumi greets you with it.'),
    h('div', { class: 'grid-2' },
      field('Explain things in', selectEl(LANGUAGES, s.nativeLanguage || 'en', (v) => save({ nativeLanguage: v }))),
      field('Your level', selectEl(LEVELS, s.level || 'beginner', (v) => save({ level: v })))),
    h('div', { class: 'field' },
      h('span', { class: 'label' }, 'Readings'),
      segEl(SCRIPTS, s.script || 'zhuyin', (v) => save({ script: v })),
      h('span', { class: 'help' }, 'What sits above the characters everywhere in the app.')),
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
      toast(res?.reply ? `${res.reply}` : 'The connection works.', 'ok', 5000);
    } catch (e) {
      toast(e.message, 'bad', 5000);
    } finally {
      busy(testBtn, false);
    }
  });

  /* --- models: the default and the per-task overrides --- */
  const defaultRow = h('div', { class: 'st-defaultrow' });
  const routing = h('div', { class: 'list st-tasks' });
  const modelsNote = h('p', { class: 'help st-modelsnote' }, 'Loading the model list…');
  const refresh = h('button', { class: 'btn btn--sm btn--ghost', type: 'button' }, icon('refresh'), 'Refresh list');

  function modelButton(label, { title, current, onPick, clear = null }) {
    const b = h('button', { class: 'btn btn--sm st-modelbtn', type: 'button' }, h('span', { class: 'ellipsis' }, label));
    b.addEventListener('click', () => openModelPicker({ title, current, onPick }));
    if (!clear) return b;
    const x = h('button', { class: 'btn btn--icon btn--sm btn--quiet', type: 'button', 'aria-label': 'Use the default model', title: 'Use the default' }, icon('x'));
    x.addEventListener('click', clear);
    return h('span', { class: 'row st-modelpick' }, b, x);
  }

  function paintModels() {
    const models = cur().ai?.models || {};
    const def = models.default || '';
    defaultRow.replaceChildren(
      h('span', { class: 'label' }, 'Default model'),
      modelButton(def || 'Choose a model', {
        title: 'Default model', current: def,
        onPick: (id) => save({ ai: { models: { default: id } } }),
      }));
    routing.replaceChildren(...TASKS.map((t) => {
      const override = models[t.id] || '';
      return h('div', { class: 'list-row st-task' },
        h('div', { class: 'grow st-task-main' },
          h('div', { class: 'st-task-top' },
            h('b', null, t.label),
            h('span', { class: `pl-tag ${t.importance === 'high' ? 'on' : ''}`.trim() }, t.importance)),
          h('div', { class: 'st-task-why' }, t.why)),
        h('div', { class: 'st-task-pick' },
          modelButton(override || `Default (${def || 'not set'})`, {
            title: `Model for ${t.label}`, current: override || def,
            onPick: (id) => save({ ai: { models: { [t.id]: id } } }),
            clear: override ? () => save({ ai: { models: { [t.id]: '' } } }) : null,
          })));
    }));
  }
  repaints.add(paintModels);

  async function loadModels(opts) {
    modelsNote.textContent = opts?.refresh ? 'Refreshing…' : 'Loading the model list…';
    try {
      const list = await getModels(opts);
      if (my !== gen) return;
      modelsNote.textContent = list.length
        ? `${list.length} models available on OpenRouter · ${list.filter(hasImage).length} of them can read images.`
        : 'OpenRouter returned no models.';
    } catch (e) {
      if (my !== gen) return;
      modelsNote.textContent = e.message;
      toast(e.message, 'bad');
    }
  }
  refresh.addEventListener('click', async () => {
    busy(refresh, true);
    await loadModels({ refresh: true });
    busy(refresh, false);
  });

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
  paintModels();
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
      defaultRow,
      h('div', { class: 'row row--wrap st-modelsrow' }, modelsNote, refresh)),
    h('div', { class: 'field' },
      h('span', { class: 'label' }, 'Which model does what'),
      routing,
      h('span', { class: 'help' }, 'Photo notes need a model with image input.')),
    h('hr', { class: 'divider' }),
    field('Monthly budget (USD)', budget, 'A soft ceiling: Plumi warns you, it does not stop you.'),
    usageBox);
}

/* ---------- 5. Memo card templates ---------- */
function templatesPanel() {
  const list = h('div', { class: 'list st-templates' });

  function rowFor(t, i) {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = t.enabled !== false;
    cb.addEventListener('change', () => {
      const next = (cur().cardTemplates || []).map((x, j) => (j === i ? { ...x, enabled: cb.checked } : x));
      save({ cardTemplates: next });
    });
    const del = t.builtin ? null : h('button', {
      class: 'btn btn--icon btn--sm btn--quiet', type: 'button', 'aria-label': `Delete ${t.name}`, title: 'Delete',
    }, icon('x'));
    del?.addEventListener('click', async () => {
      if (!(await confirmWindow({ title: `Delete “${t.name}”?`, text: 'Cards already reviewed keep their history; this template just stops appearing.', okLabel: 'Delete', danger: true }))) return;
      save({ cardTemplates: (cur().cardTemplates || []).filter((_, j) => j !== i) });
    });
    return h('div', { class: 'list-row st-tpl' },
      h('label', { class: 'check st-tpl-check' }, cb, h('span', { class: 'sr-only' }, `Use ${t.name}`)),
      h('div', { class: 'grow st-tpl-main' },
        h('div', { class: 'st-tpl-top' },
          h('b', null, t.name || t.id),
          t.builtin ? null : h('span', { class: 'pl-tag' }, 'custom')),
        h('div', { class: 'st-tpl-fields' },
          tagList(t.front), h('span', { class: 'st-arrow' }, '→'), tagList(t.back))),
      del);
  }
  function paint() {
    const tpls = cur().cardTemplates || [];
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
    for (const f of CARD_FIELDS) {
      const cb = h('input', { type: 'checkbox' });
      inputs[f] = cb;
      box.append(h('label', { class: 'check st-fieldcheck' }, cb, f));
    }
    return { box, read: () => CARD_FIELDS.filter((f) => inputs[f].checked), which };
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
          const existing = cur().cardTemplates || [];
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
      learnerPanel(),
      lookPanel(),
      voicePanel(),
      aiPanel(my),
      templatesPanel(),
      dataPanel(my),
      aboutPanel(my));

    /* Panels that only display settings (the key, the routing table, the
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
