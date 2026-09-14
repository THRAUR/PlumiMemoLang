/* words.js — the dictionary (#/words, #/words/:id).
   Two screens in one module:
     INDEX   search + filters (persisted in sessionStorage) over a .list of rows
     DETAIL  one word: hanzi hero, memory stats, examples, notes, actions

   Every fetch can 404 while the routes are being written concurrently: each
   one is wrapped so a failure becomes a toast plus a clean empty/error card,
   never a console error or a blank screen. */
import { api } from '../api.js';
import { settings } from '../state.js';
import { navigate } from '../router.js';
import { createBird } from '../bird.js';
import { wordHero, wordLine, exampleEl as hzExampleEl } from '../hanzi.js';
import { pinyinToZhuyin } from '/shared/zhuyin.js';
import { recognition, recordControl, listenOnce, hanziMatch } from '../speech.js';
import {
  h, toast, openWindow, confirmWindow, emptyState, busy, meter, bandChip,
  pixelIcon, fmt, readingEl, speakButton, markdownish, setTitle, hanziMode,
  readingFor,
} from '../ui.js';

/* ---------- lookups ---------- */
const POS = [
  ['', '—'], ['n', 'Noun'], ['v', 'Verb'], ['adj', 'Adjective'], ['adv', 'Adverb'],
  ['mw', 'Measure word'], ['conj', 'Conjunction'], ['prep', 'Preposition'], ['part', 'Particle'],
  ['interj', 'Interjection'], ['pron', 'Pronoun'], ['num', 'Number'], ['expr', 'Expression'],
];
const TYPES = [
  ['word', 'Word'], ['character', 'Character'], ['phrase', 'Phrase'], ['sentence', 'Sentence'], ['grammar', 'Grammar'],
];
const BANDS = [['', 'All bands'], ['new', '生 New'], ['seen', '認 Seen'], ['familiar', '熟 Familiar'], ['mastered', '通 Mastered']];
const SORTS = [['score', 'Score'], ['recent', 'Recent'], ['alpha', 'A–Z'], ['due', 'Due']];
const SORT_DIR = { score: 'desc', recent: 'desc', alpha: 'asc', due: 'asc' };
const POS_LABEL = Object.fromEntries(POS);
const TYPE_LABEL = Object.fromEntries(TYPES);
const LANG_NAMES = { en: 'English', fr: 'French', de: 'German', es: 'Spanish', ja: 'Japanese', ko: 'Korean', pt: 'Portuguese', it: 'Italian', ru: 'Russian', nl: 'Dutch', id: 'Indonesian', th: 'Thai' };
const FILTERS_KEY = 'pml.words.filters';
const DEFAULT_FILTERS = { q: '', sort: 'score', lessonId: '', band: '', type: '' };

function nativeLabel() { return LANG_NAMES[settings?.nativeLanguage] || settings?.nativeLanguage || 'native language'; }

function loadFilters() {
  try { return { ...DEFAULT_FILTERS, ...JSON.parse(sessionStorage.getItem(FILTERS_KEY) || '{}') }; }
  catch { return { ...DEFAULT_FILTERS }; }
}
function saveFilters(f) { try { sessionStorage.setItem(FILTERS_KEY, JSON.stringify(f)); } catch { /* private mode etc. */ } }

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* A generation counter: every async chain checks it before touching the DOM,
   so a fast navigation away never paints into a screen the router replaced. */
let gen = 0;
let activeRec = null;   // the detail screen's recordControl, so unmount() can release the mic

/* ---------- the add/edit window, shared by the index, the detail actions,
   and (via a preset lessonId) anyone who wants to add straight into a lesson ---------- */
function openWordWindow({ word = null, lessonId = null, lessons = [], onSaved = null } = {}) {
  const isEdit = !!word;
  // A speaking learner's notes lead with pinyin and English; characters are only
  // kept to confirm the original meaning (docs/ARCHITECTURE.md §8), so the form
  // mirrors that order for them and leaves the characters field for last.
  const speaking = hanziMode() !== 'full';
  const hanziInput = h('input', { class: 'input zh', value: word?.hanzi || '', placeholder: '謝謝' });
  const pinyinInput = h('input', { class: 'input', value: word?.pinyin || '', placeholder: 'xiè xie' });
  const zhuyinInput = h('input', { class: 'input zh', value: word?.zhuyin || '', placeholder: 'ㄒㄧㄝˋ ˙ㄒㄧㄝ' });
  pinyinInput.addEventListener('blur', () => {
    if (zhuyinInput.value.trim() || !pinyinInput.value.trim()) return;
    try { const z = pinyinToZhuyin(pinyinInput.value.trim()); if (z) zhuyinInput.value = z; }
    catch { /* shared/zhuyin.js may still be a stub; leave the field alone */ }
  });
  // The meaning is written in the explanation language (Settings → Explain things in).
  const meaningInput = h('input', { class: 'input', value: word?.meaning || '', placeholder: `Meaning in ${nativeLabel()}` });
  const meaningNativeInput = h('input', { class: 'input', value: word?.meaningNative || '', placeholder: 'Second meaning (optional)' });
  const posSelect = h('select', { class: 'select' }, ...POS.map(([v, label]) => h('option', { value: v, selected: (word?.pos || '') === v }, label)));
  const typeSelect = h('select', { class: 'select' }, ...TYPES.map(([v, label]) => h('option', { value: v, selected: (word?.type || 'word') === v }, label)));
  const tagsInput = h('input', { class: 'input', value: (word?.tags || []).join(', '), placeholder: 'greeting, polite' });
  const notesInput = h('textarea', { class: 'textarea wd-notesarea', value: word?.notes || '' });
  const ex = (word?.examples || [])[0] || {};
  const exZh = h('input', { class: 'input zh', value: ex.zh || '', placeholder: '謝謝你的幫忙。' });
  const exPinyin = h('input', { class: 'input', value: ex.pinyin || '', placeholder: 'xiè xie nǐ de bāng máng' });
  const exTr = h('input', { class: 'input', value: ex.translation || '', placeholder: 'Thanks for your help.' });
  const lessonSelect = lessons.length
    ? h('select', { class: 'select' },
        h('option', { value: '' }, 'No lesson'),
        ...lessons.map((l) => h('option', { value: l.id, selected: (word?.lessonId || lessonId || '') === l.id }, l.titleZh ? `${l.titleZh} · ${l.title}` : l.title)))
    : null;

  const field = (label, input, help) => h('label', { class: 'field' }, h('span', { class: 'label' }, label), input, help ? h('span', { class: 'help' }, help) : null);

  const hanziField = field('Hanzi', hanziInput, speaking ? 'Characters are kept as a reference' : null);
  const readingRow = h('div', { class: 'grid-2' }, field('Pinyin', pinyinInput), field('Zhuyin', zhuyinInput));
  const exampleZhField = field('Example (Chinese)', exZh);
  const exampleReadingRow = h('div', { class: 'grid-2' }, field('Example pinyin', exPinyin), field('Example translation', exTr));
  const middleFields = [
    field('Meaning', meaningInput),
    field('Second meaning (optional)', meaningNativeInput),
    h('div', { class: 'grid-2' }, field('Part of speech', posSelect), field('Type', typeSelect)),
    lessonSelect ? field('Lesson', lessonSelect) : null,
    field('Tags', tagsInput, 'Comma separated'),
    field('Notes', notesInput),
  ];
  const bodyFields = speaking
    ? [readingRow, ...middleFields, h('p', { class: 'pl-eyebrow' }, 'Example'), exampleReadingRow, exampleZhField, hanziField]
    : [hanziField, readingRow, ...middleFields, h('p', { class: 'pl-eyebrow' }, 'Example'), exampleZhField, exampleReadingRow];

  openWindow({
    title: isEdit ? 'Edit word' : 'Add word',
    body: h('div', { class: 'stack wd-form' }, ...bodyFields),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save', class: 'btn--primary',
        onClick: async () => {
          const hanzi = hanziInput.value.trim();
          const meaning = meaningInput.value.trim();
          if (!hanzi) { toast('Hanzi is required.', 'bad'); hanziInput.focus(); return false; }
          if (!meaning) { toast('Meaning is required.', 'bad'); meaningInput.focus(); return false; }
          const examples = [];
          if (exZh.value.trim() || exPinyin.value.trim() || exTr.value.trim()) {
            examples.push({ zh: exZh.value.trim(), pinyin: exPinyin.value.trim(), translation: exTr.value.trim(), zhuyin: '' });
          }
          const payload = {
            hanzi, pinyin: pinyinInput.value.trim(), zhuyin: zhuyinInput.value.trim(),
            meaning, meaningNative: meaningNativeInput.value.trim(),
            pos: posSelect.value, type: typeSelect.value || 'word',
            tags: tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean),
            notes: notesInput.value.trim(), examples,
            lessonId: lessonSelect ? (lessonSelect.value || null) : (word?.lessonId ?? lessonId ?? null),
          };
          try {
            const res = isEdit ? await api.put(`/api/words/${word.id}`, payload) : await api.post('/api/words', payload);
            const merged = !!res.merged;
            const savedWord = res.word || res;
            toast(merged ? 'Already in your words — filled in the blanks.' : (isEdit ? 'Word updated.' : 'Word added.'), merged ? '' : 'ok');
            onSaved && onSaved(savedWord);
            if (merged) navigate(`/words/${savedWord.id}`);
          } catch (e) { toast(e.message, 'bad'); return false; }
        },
      },
    ],
  });
}

/* hanzi.js's exampleEl() draws the sentence by the learner's display rules
   (§8.3, reading first and large in speaking focus) but has no speak option,
   so the button rides alongside in its own row. */
function exampleEl(ex) {
  const body = hzExampleEl(ex);
  if (!body) return null;
  return h('div', { class: 'row wd-example-row' }, h('div', { class: 'grow' }, body), speakButton(ex.zh || '', { size: 'sm', label: 'Play the sentence' }));
}

/* ---------- index (#/words) ---------- */
function wordRow(w) {
  // wordLine() leads with the reading and shrinks the characters for a speaking
  // learner (§8.3); a character learner gets characters with the reading beside them.
  const line1 = h('div', { class: 'wd-row-l1' }, wordLine(w));
  const line2 = h('div', { class: 'wd-row-l2' }, h('span', { class: 'muted ellipsis wd-row-meaning' }, w.meaning || ''), meter(w.score || 0));
  const chip = bandChip(w.band);
  if (chip) { chip.classList.add('wd-row-chip'); line2.append(chip); }
  return h('a', { class: 'list-row wd-row', href: `#/words/${w.id}` }, h('div', { class: 'wd-row-main' }, line1, line2));
}

async function fetchWords(filters) {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.lessonId) params.set('lessonId', filters.lessonId);
  if (filters.type) params.set('type', filters.type);
  if (filters.band) params.set('band', filters.band);
  params.set('sort', filters.sort || 'score');
  params.set('dir', SORT_DIR[filters.sort] || 'desc');
  return api.get(`/api/words?${params.toString()}`);
}

async function renderIndex(root) {
  const myGen = ++gen;
  setTitle('Words');
  const filters = loadFilters();

  const countPill = h('span', { class: 'pill' }, '0');
  const addBtn = h('button', { class: 'btn btn--primary', type: 'button' }, pixelIcon('plus', 2), 'Add word');
  const head = h('div', { class: 'row row--wrap wd-head' }, h('div', { class: 'row wd-head-title' }, h('h1', null, 'Words'), countPill), addBtn);

  const searchInput = h('input', { class: 'input', type: 'search', value: filters.q, placeholder: 'Search pinyin, English or characters', 'aria-label': 'Search words' });
  const searchBox = h('div', { class: 'search' }, pixelIcon('search', 2), searchInput);

  const segButtons = SORTS.map(([val, label]) => { const b = h('button', { type: 'button' }, label); b.dataset.val = val; return b; });
  const seg = h('div', { class: 'seg' }, ...segButtons);
  const lessonSelect = h('select', { class: 'select', 'aria-label': 'Filter by lesson' }, h('option', { value: '' }, 'All lessons'));
  const bandSelect = h('select', { class: 'select', 'aria-label': 'Filter by band' }, ...BANDS.map(([v, l]) => h('option', { value: v }, l)));
  const typeSelect = h('select', { class: 'select', 'aria-label': 'Filter by type' }, h('option', { value: '' }, 'All types'), ...TYPES.map(([v, l]) => h('option', { value: v }, l)));
  bandSelect.value = filters.band;
  typeSelect.value = filters.type;
  const filterRow = h('div', { class: 'wd-filters' }, seg, lessonSelect, bandSelect, typeSelect);

  const listHost = h('div', { class: 'wd-listhost' }, h('p', { class: 'muted' }, 'Loading…'));
  const footer = h('div', { class: 'row wd-export' },
    h('a', { class: 'btn btn--sm', href: '/api/words/export?format=csv', download: true }, 'Export CSV'),
    h('a', { class: 'btn btn--sm', href: '/api/words/export?format=json', download: true }, 'Export JSON'));

  root.replaceChildren(head, searchBox, filterRow, listHost, footer);

  let lessons = [];
  try { lessons = (await api.get('/api/lessons')).lessons || []; }
  catch (e) { toast(e.message, 'bad'); }
  if (myGen !== gen) return;
  for (const l of lessons) lessonSelect.append(h('option', { value: l.id }, l.titleZh ? `${l.titleZh} · ${l.title}` : l.title));
  lessonSelect.value = filters.lessonId;

  function markActiveSort() { for (const b of segButtons) b.classList.toggle('is-active', b.dataset.val === filters.sort); }
  markActiveSort();

  function openAdd(presetLessonId) {
    openWordWindow({ lessons, lessonId: presetLessonId || null, onSaved: () => refresh() });
  }
  addBtn.addEventListener('click', () => openAdd());

  function emptyWords() {
    const hasQuery = !!(filters.q || filters.lessonId || filters.band || filters.type);
    return emptyState({
      bird: createBird({ mood: 'idle' }).el,
      title: hasQuery ? 'No words match.' : 'No words yet.',
      text: hasQuery ? 'Try clearing a filter.' : 'Add your first word, or add notes and Plumi will build the list for you.',
      action: h('div', { class: 'wd-empty-actions' },
        h('a', { class: 'btn btn--sm', href: '#/notes' }, 'Add notes'),
        h('button', { class: 'btn btn--primary', type: 'button', onClick: () => openAdd() }, 'Add a word')),
    });
  }

  async function refresh() {
    saveFilters(filters);
    listHost.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    let res;
    try { res = await fetchWords(filters); }
    catch (e) {
      if (myGen !== gen) return;
      toast(e.message, 'bad');
      listHost.replaceChildren(emptyState({
        bird: createBird({ mood: 'sad' }).el,
        title: 'Words could not load.',
        text: e.message,
        action: h('button', { class: 'btn btn--sm', type: 'button', onClick: () => refresh() }, 'Try again'),
      }));
      return;
    }
    if (myGen !== gen) return;
    countPill.textContent = fmt.n(res.total || 0);
    if (!res.words || !res.words.length) { listHost.replaceChildren(emptyWords()); return; }
    listHost.replaceChildren(h('div', { class: 'list wd-list' }, ...res.words.map(wordRow)));
  }

  searchInput.addEventListener('input', debounce(() => { filters.q = searchInput.value.trim(); refresh(); }, 250));
  for (const b of segButtons) b.addEventListener('click', () => { filters.sort = b.dataset.val; markActiveSort(); refresh(); });
  lessonSelect.addEventListener('change', () => { filters.lessonId = lessonSelect.value; refresh(); });
  bandSelect.addEventListener('change', () => { filters.band = bandSelect.value; refresh(); });
  typeSelect.addEventListener('change', () => { filters.type = typeSelect.value; refresh(); });

  await refresh();
}

/* ---------- detail (#/words/:id) ---------- */
function intervalLabel(days) {
  if (days == null) return '—';
  return days < 1 ? `${Math.max(1, Math.round(days * 24 * 60))}m` : `${Math.round(days)}d`;
}

function enrichButton(word, reload) {
  const btn = h('button', { class: 'btn btn--sm', type: 'button' }, 'Complete with AI');
  const wrap = h('span', { class: 'row wd-enrich' }, btn);
  btn.addEventListener('click', async () => {
    busy(btn, true);
    const bird = createBird({ size: 2, mood: 'think' });
    wrap.append(bird.el);
    try {
      const { jobId } = await api.post(`/api/words/${word.id}/enrich`, {});
      await api.job(jobId);
      toast('Word completed.', 'ok');
      await reload();
    } catch (e) { toast(e.message, 'bad'); }
    finally { busy(btn, false); bird.el.remove(); }
  });
  return wrap;
}

function openAskWindow(word) {
  const question = h('textarea', { class: 'textarea', placeholder: 'e.g. When would I use 了 here instead of 過?' });
  const answerBox = h('div', { class: 'wd-answer', hidden: true });
  openWindow({
    title: 'Ask about this word',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted' }, h('span', { class: 'hz hz--sm', lang: 'zh-Hant' }, word.hanzi), ' — ask anything about usage, nuance, or grammar.'),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Your question'), question),
      answerBox),
    actions: [
      { label: 'Close' },
      {
        label: 'Ask', class: 'btn--primary', closes: false,
        onClick: async () => {
          const q = question.value.trim();
          if (!q) { toast('Type a question first.', 'bad'); return; }
          try {
            const res = await api.post(`/api/words/${word.id}/explain`, { question: q });
            answerBox.hidden = false;
            answerBox.replaceChildren(markdownish(res.answer || ''));
          } catch (e) { toast(e.message, 'bad'); }
        },
      },
    ],
  });
}

/* "Practice saying it" (§8.4): hear the model, record your own attempt, and,
   where the browser can listen, get an instant check against the characters.
   recordControl() hides itself when there is no mic/secure context; the
   Check-me button only appears when the browser has speech recognition. */
function practiceBlock(word) {
  const card = h('div', { class: 'card wd-practice' },
    h('p', { class: 'pl-eyebrow' }, 'Practice saying it'),
    h('div', { class: 'row wd-practice-row' },
      speakButton(word.hanzi, { size: 'sm', label: 'Play the word' }),
      h('span', { class: 'small muted' }, 'Listen, then record yourself saying it.')));

  activeRec?.destroy();
  const rec = recordControl({ label: 'Record yourself' });
  activeRec = rec;
  card.append(rec.el);

  if (recognition.supported) {
    const checkBtn = h('button', { class: 'btn btn--sm', type: 'button' }, pixelIcon('check', 2), 'Check me');
    const result = h('div', { class: 'wd-practice-result', hidden: true });
    checkBtn.addEventListener('click', async () => {
      busy(checkBtn, true);
      result.hidden = true;
      try {
        const heard = await listenOnce({ lang: 'zh-TW' });
        const ok = hanziMatch(heard.text, word.hanzi || '') >= 0.8;
        result.hidden = false;
        result.replaceChildren(ok
          ? h('p', { class: 'wd-practice-ok' }, pixelIcon('check', 2), 'Plumi heard it right.')
          : h('div', null, h('p', { class: 'small muted' }, 'Plumi heard:'), h('p', { class: 'zh wd-practice-heard', lang: 'zh-Hant' }, heard.text || '—')));
      } catch (e) { toast(e.message, 'bad'); }
      finally { busy(checkBtn, false); }
    });
    card.append(h('div', { class: 'stack wd-practice-check' }, checkBtn, result));
  }
  return card;
}

async function renderDetail(root, id) {
  const myGen = ++gen;
  setTitle('Words');
  root.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  let word;
  try { word = await api.get(`/api/words/${id}`); }
  catch (e) {
    if (myGen !== gen) return;
    toast(e.message, 'bad');
    root.replaceChildren(
      h('a', { class: 'btn btn--sm btn--quiet wd-back', href: '#/words' }, pixelIcon('back', 2), 'Words'),
      h('div', { class: 'card' }, h('p', { class: 'h3' }, 'This word could not load.'), h('p', { class: 'muted' }, e.message)));
    return;
  }
  if (myGen !== gen) return;
  // A speaking learner reads the word by its sound; the characters stay a footnote.
  setTitle(hanziMode() === 'full' ? (word.hanzi || 'Words') : (readingFor(word).primary?.text || word.hanzi || 'Words'));
  paintDetail(root, word, myGen);
}

function paintDetail(root, word, myGen) {
  const reload = () => renderDetail(root, word.id);
  const backLink = h('a', { class: 'btn btn--sm btn--quiet wd-back', href: '#/words' }, pixelIcon('back', 2), 'Words');

  // wordHero follows the learner's display mode (§8.3): full ruby hanzi for a
  // character learner, a big reading with small characters for a speaking one.
  // readingEl below it always spells out both scripts, whichever mode is showing.
  const heroReading = readingEl(word, { both: true, size: 'lg' });
  if (heroReading) heroReading.classList.add('wd-hero-reading');
  const hero = h('div', { class: 'wd-hero' },
    h('div', { class: 'row wd-hero-hz' }, wordHero(word, { size: 'xl' }), speakButton(word.hanzi, { size: 'lg' })),
    heroReading);

  const meaningBlock = h('div', { class: 'wd-meaning' },
    h('p', { class: 'meaning' }, word.meaning || ''),
    word.meaningNative ? h('p', { class: 'muted' }, word.meaningNative) : null);

  const tagsRow = h('div', { class: 'row row--wrap wd-tags' },
    word.pos ? h('span', { class: 'pl-tag' }, POS_LABEL[word.pos] || word.pos) : null,
    h('span', { class: 'pl-tag' }, TYPE_LABEL[word.type] || word.type || 'word'),
    ...(word.tags || []).map((t) => h('span', { class: 'pl-tag' }, t)),
    word.lesson ? h('a', { class: 'pl-tag on', href: `#/lessons/${word.lesson.id}` }, word.lesson.title) : null);

  const srs = word.srs || {};
  const stats = word.stats || { reviews: 0, correct: 0 };
  const acc = stats.reviews ? `${Math.round((100 * stats.correct) / stats.reviews)}%` : '—';
  const meterBig = meter(word.score || 0);
  meterBig.classList.add('meter--lg');
  const memoryCard = h('div', { class: 'card wd-memory' },
    h('p', { class: 'pl-eyebrow' }, 'Memory'),
    h('div', { class: 'row wd-memory-row' }, meterBig, h('span', { class: 'wd-score' }, String(word.score ?? 0)), bandChip(word.band)),
    h('p', { class: 'help' }, `Reviewed ${fmt.n(stats.reviews || 0)} times · accuracy ${acc} · next review ${fmt.due(srs.due)} · interval ${intervalLabel(srs.interval)}`),
    h('button', { class: 'btn btn--sm btn--primary', type: 'button', onClick: () => navigate('/review') }, 'Practice now'));

  const examples = (word.examples || []).map(exampleEl);
  const notesBlock = word.notes ? h('div', { class: 'wd-notes' }, h('p', { class: 'pl-eyebrow' }, 'Notes'), markdownish(word.notes)) : null;

  const hasKey = !!settings?.ai?.ready;   // any AI: an OpenRouter key or the Claude plan
  const editBtn = h('button', {
    class: 'btn btn--sm', type: 'button',
    onClick: async () => {
      let lessons = [];
      try { lessons = (await api.get('/api/lessons')).lessons || []; } catch (e) { toast(e.message, 'bad'); }
      openWordWindow({ word, lessons, onSaved: reload });
    },
  }, 'Edit');
  const resetBtn = h('button', {
    class: 'btn btn--sm', type: 'button',
    onClick: async () => {
      const ok = await confirmWindow({ title: 'Reset progress?', text: 'This clears review history and starts the word fresh.', okLabel: 'Reset' });
      if (!ok) return;
      try { await api.post(`/api/words/${word.id}/reset`, {}); toast('Progress reset.', 'ok'); reload(); }
      catch (e) { toast(e.message, 'bad'); }
    },
  }, 'Reset progress');
  const deleteBtn = h('button', {
    class: 'btn btn--sm btn--danger', type: 'button',
    onClick: async () => {
      const ok = await confirmWindow({ title: 'Delete this word?', text: `This removes ${word.hanzi} and its review history. This cannot be undone.`, okLabel: 'Delete', danger: true });
      if (!ok) return;
      try { await api.del(`/api/words/${word.id}`); toast('Word deleted.', 'ok'); navigate('/words'); }
      catch (e) { toast(e.message, 'bad'); }
    },
  }, 'Delete');

  const actions = h('div', { class: 'row row--wrap wd-actions' },
    editBtn,
    hasKey ? enrichButton(word, reload) : null,
    hasKey ? h('button', { class: 'btn btn--sm', type: 'button', onClick: () => openAskWindow(word) }, 'Ask about this word') : null,
    resetBtn, deleteBtn);

  const win = h('div', { class: 'pl-win wd-detail-win' },
    h('div', { class: 'pl-titlebar' }, h('span', { class: 'pl-title' }, bandChip(word.band)), h('span', { class: 'spacer' })),
    h('div', { class: 'win-body' },
      hero, meaningBlock, tagsRow, practiceBlock(word), memoryCard,
      examples.length ? h('p', { class: 'pl-eyebrow' }, 'Examples') : null,
      ...examples,
      notesBlock,
      h('hr', { class: 'divider' }),
      actions));

  if (myGen !== gen) return;
  root.replaceChildren(backLink, win);
}

export default {
  id: 'words',
  title: 'Words',
  async render(root, params) {
    if (params?.id) await renderDetail(root, params.id);
    else await renderIndex(root);
  },
  unmount() { gen++; activeRec?.destroy(); activeRec = null; },
};
