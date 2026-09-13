/* lessons.js — the lesson path (#/lessons, #/lessons/:id).
   Two screens in one module:
     INDEX   the path: one node per lesson, in `order`
     DETAIL  the lesson card: header + sections + grammar + dialogue +
             vocabulary, plus a full-screen "Study cards" flip-through

   Every fetch can 404 while the routes are being written concurrently: each
   one is wrapped so a failure becomes a toast plus a clean empty/error card,
   never a console error or a blank screen. */
import { api } from '../api.js';
import { settings } from '../state.js';
import { navigate } from '../router.js';
import { createBird } from '../bird.js';
import { hanziEl, readingLine } from '../hanzi.js';
import { hanziChars, pinyinToZhuyin } from '/shared/zhuyin.js';
import {
  h, toast, openWindow, confirmWindow, emptyState, meter, bandChip,
  pixelIcon, fmt, readingEl, speakButton, markdownish, setTitle, openSession,
} from '../ui.js';

/* ---------- lookups ---------- */
const POS = [
  ['', '—'], ['n', 'Noun'], ['v', 'Verb'], ['adj', 'Adjective'], ['adv', 'Adverb'],
  ['mw', 'Measure word'], ['conj', 'Conjunction'], ['prep', 'Preposition'], ['part', 'Particle'],
  ['interj', 'Interjection'], ['pron', 'Pronoun'], ['num', 'Number'], ['expr', 'Expression'],
];
const TYPES = [['word', 'Word'], ['character', 'Character'], ['phrase', 'Phrase'], ['sentence', 'Sentence'], ['grammar', 'Grammar']];
const LANG_NAMES = { en: 'English', fr: 'French', de: 'German', es: 'Spanish', ja: 'Japanese', ko: 'Korean', vi: 'Vietnamese', pt: 'Portuguese', it: 'Italian', ru: 'Russian', nl: 'Dutch', id: 'Indonesian', th: 'Thai' };
const KIND_LABEL = { vocab: 'Vocabulary', grammar: 'Grammar', dialogue: 'Dialogue', culture: 'Culture', tip: 'Tip', text: 'Notes' };

function nativeLabel() { return LANG_NAMES[settings?.nativeLanguage] || settings?.nativeLanguage || 'native language'; }
function hasHanzi(s) { return hanziChars(s).length > 0; }

/* A generation counter: async chains check it before touching the DOM, so a
   fast navigation away never paints into a screen the router already replaced. */
let gen = 0;
let liveSession = null;   // the open study session, so unmount() can close it

/* ---------- a compact add-word window, scoped to one lesson.
   (Same fields as the Words screen's window; views don't share internals,
   so this is a small, deliberate duplicate rather than a cross-view import.) ---------- */
function openWordWindow({ lessonId, onSaved }) {
  const hanziInput = h('input', { class: 'input zh', placeholder: '謝謝' });
  const pinyinInput = h('input', { class: 'input', placeholder: 'xiè xie' });
  const zhuyinInput = h('input', { class: 'input zh', placeholder: 'ㄒㄧㄝˋ ˙ㄒㄧㄝ' });
  pinyinInput.addEventListener('blur', () => {
    if (zhuyinInput.value.trim() || !pinyinInput.value.trim()) return;
    try { const z = pinyinToZhuyin(pinyinInput.value.trim()); if (z) zhuyinInput.value = z; }
    catch { /* shared/zhuyin.js may still be a stub; leave the field alone */ }
  });
  const meaningInput = h('input', { class: 'input', placeholder: 'thank you' });
  const meaningNativeInput = h('input', { class: 'input', placeholder: `Meaning in ${nativeLabel()}` });
  const posSelect = h('select', { class: 'select' }, ...POS.map(([v, label]) => h('option', { value: v }, label)));
  const typeSelect = h('select', { class: 'select' }, ...TYPES.map(([v, label]) => h('option', { value: v, selected: v === 'word' }, label)));
  const tagsInput = h('input', { class: 'input', placeholder: 'greeting, polite' });
  const notesInput = h('textarea', { class: 'textarea ls-notesarea' });
  const exZh = h('input', { class: 'input zh', placeholder: '謝謝你的幫忙。' });
  const exPinyin = h('input', { class: 'input', placeholder: 'xiè xie nǐ de bāng máng' });
  const exTr = h('input', { class: 'input', placeholder: 'Thanks for your help.' });
  const field = (label, input, help) => h('label', { class: 'field' }, h('span', { class: 'label' }, label), input, help ? h('span', { class: 'help' }, help) : null);

  openWindow({
    title: 'Add word',
    body: h('div', { class: 'stack ls-wordform' },
      field('Hanzi', hanziInput),
      h('div', { class: 'grid-2' }, field('Pinyin', pinyinInput), field('Zhuyin', zhuyinInput)),
      field('Meaning', meaningInput),
      field(`Meaning in ${nativeLabel()}`, meaningNativeInput),
      h('div', { class: 'grid-2' }, field('Part of speech', posSelect), field('Type', typeSelect)),
      field('Tags', tagsInput, 'Comma separated'),
      field('Notes', notesInput),
      h('p', { class: 'pl-eyebrow' }, 'Example'),
      field('Example (Chinese)', exZh),
      h('div', { class: 'grid-2' }, field('Example pinyin', exPinyin), field('Example translation', exTr))),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save', class: 'btn--primary',
        onClick: async () => {
          const hanzi = hanziInput.value.trim();
          const meaning = meaningInput.value.trim();
          if (!hanzi) { toast('Hanzi is required.', 'bad'); hanziInput.focus(); return false; }
          if (!meaning) { toast('Meaning is required.', 'bad'); meaningInput.focus(); return false; }
          const examples = (exZh.value.trim() || exPinyin.value.trim() || exTr.value.trim())
            ? [{ zh: exZh.value.trim(), pinyin: exPinyin.value.trim(), translation: exTr.value.trim(), zhuyin: '' }] : [];
          const payload = {
            hanzi, pinyin: pinyinInput.value.trim(), zhuyin: zhuyinInput.value.trim(),
            meaning, meaningNative: meaningNativeInput.value.trim(),
            pos: posSelect.value, type: typeSelect.value || 'word',
            tags: tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean),
            notes: notesInput.value.trim(), examples, lessonId,
          };
          try {
            const res = await api.post('/api/words', payload);
            toast(res.merged ? 'Already in your words — filled in the blanks.' : 'Word added.', res.merged ? '' : 'ok');
            onSaved && onSaved(res.word || res);
          } catch (e) { toast(e.message, 'bad'); return false; }
        },
      },
    ],
  });
}

function exampleEl(ex) {
  return h('div', { class: 'example' },
    h('div', { class: 'row' }, h('div', { class: 'zh grow', lang: 'zh-Hant' }, ex.zh || ''), speakButton(ex.zh || '', { size: 'sm' })),
    readingEl(ex),
    ex.translation ? h('div', { class: 'tr' }, ex.translation) : null);
}

/* ---------- index (#/lessons) ---------- */
function computeNodeStates(lessons) {
  let currentAssigned = false;
  return lessons.map((lesson) => {
    const total = lesson.progress?.total || 0;
    const mastered = lesson.progress?.mastered || 0;
    const done = (total > 0 && mastered === total) || lesson.status === 'done';
    let state = 'plain';
    if (done) state = 'done';
    else if (!currentAssigned) { state = 'current'; currentAssigned = true; }
    else if (lesson.status === 'new') state = 'locked';
    return { lesson, state };
  });
}

function pathNode({ lesson, state }) {
  const cls = ['path-node'];
  if (state === 'done') cls.push('is-done');
  else if (state === 'current') cls.push('is-current');
  else if (state === 'locked') cls.push('is-locked');
  const icon = state === 'done' ? 'check' : state === 'current' ? 'star' : 'lessons';
  const node = h('a', { class: cls.join(' '), href: `#/lessons/${lesson.id}` },
    h('span', { class: 'path-btn' }, pixelIcon(icon, 3)),
    h('span', { class: 'path-meta' },
      h('span', { class: 't' }, lesson.titleZh ? `${lesson.titleZh} · ${lesson.title}` : lesson.title),
      h('span', { class: 's' }, `${fmt.n(lesson.progress?.total || 0)} words`, meter(lesson.progress?.avgScore || 0))));
  if (state === 'current') {
    const bird = createBird({ size: 3 });
    bird.el.classList.add('path-bird');
    node.append(bird.el);
  }
  return node;
}

function openNewLessonWindow() {
  const titleInput = h('input', { class: 'input', placeholder: 'Ordering food' });
  const titleZhInput = h('input', { class: 'input zh', placeholder: '點餐' });
  const summaryInput = h('textarea', { class: 'textarea', placeholder: 'One paragraph about this lesson…' });
  openWindow({
    title: 'New lesson',
    body: h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Title'), titleInput),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Title (Chinese)'), titleZhInput),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Summary'), summaryInput)),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Create', class: 'btn--primary',
        onClick: async () => {
          const title = titleInput.value.trim();
          if (!title) { toast('Title is required.', 'bad'); titleInput.focus(); return false; }
          try {
            const lesson = await api.post('/api/lessons', { title, titleZh: titleZhInput.value.trim(), summary: summaryInput.value.trim() });
            toast('Lesson created.', 'ok');
            navigate(`/lessons/${lesson.id}`);
          } catch (e) { toast(e.message, 'bad'); return false; }
        },
      },
    ],
  });
}

function emptyLessons() {
  return emptyState({
    bird: createBird({ mood: 'idle' }).el,
    title: 'No lessons yet.',
    text: 'Lessons come from your class notes — add notes and Plumi builds the cards.',
    action: h('a', { class: 'btn btn--primary', href: '#/notes' }, 'Add notes'),
  });
}

async function renderIndex(root) {
  const myGen = ++gen;
  setTitle('Lessons');
  const head = h('div', { class: 'row row--wrap ls-head' },
    h('h1', null, 'Lessons'),
    h('button', { class: 'btn btn--sm', type: 'button', onClick: () => openNewLessonWindow() }, 'New lesson'));
  const body = h('div', { class: 'ls-body' }, h('p', { class: 'muted' }, 'Loading…'));
  root.replaceChildren(head, body);

  let lessons;
  try {
    const res = await api.get('/api/lessons');
    lessons = (res.lessons || []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  } catch (e) {
    if (myGen !== gen) return;
    toast(e.message, 'bad');
    body.replaceChildren(emptyState({
      bird: createBird({ mood: 'sad' }).el,
      title: 'Lessons could not load.',
      text: e.message,
      action: h('button', { class: 'btn btn--sm', type: 'button', onClick: () => renderIndex(root) }, 'Try again'),
    }));
    return;
  }
  if (myGen !== gen) return;

  if (!lessons.length) { body.replaceChildren(emptyLessons()); return; }
  const pathEl = h('div', { class: 'path' }, ...computeNodeStates(lessons).map(pathNode));
  const hint = h('div', { class: 'card card--sunk ls-hint' },
    h('p', null, 'Lessons come from your class notes — add notes and Plumi builds the cards.'),
    h('a', { class: 'btn btn--sm', href: '#/notes' }, 'Add notes'));
  body.replaceChildren(pathEl, hint);
}

/* ---------- detail (#/lessons/:id) ---------- */
function lessonWordRow(w) {
  const line1 = h('div', { class: 'ls-word-l1' }, hanziEl(w, { size: 'md', reading: 'none' }), readingLine(w));
  const line2 = h('div', { class: 'ls-word-l2' }, h('span', { class: 'muted ellipsis ls-word-meaning' }, w.meaning || ''), meter(w.score || 0));
  const chip = bandChip(w.band);
  if (chip) { chip.classList.add('ls-word-chip'); line2.append(chip); }
  return h('a', { class: 'list-row ls-word-row', href: `#/words/${w.id}` }, h('div', { class: 'ls-word-main' }, line1, line2));
}

/* The full-screen flip-through: front (hanzi only) -> Show -> back (readings,
   meaning, example, speak) -> Next, ending on a small "practice now?" card. */
function startStudySession(lesson) {
  const words = lesson.words || [];
  if (!words.length) { toast('This lesson has no words yet.', ''); return; }
  const session = openSession({ title: lesson.titleZh || lesson.title });
  liveSession = session;
  let idx = 0;

  function showCard() {
    session.setProgress(idx, words.length);
    const w = words[idx];
    const body = h('div', { class: 'win-body ls-study-body' }, hanziEl(w, { size: 'xl', reading: 'none' }));
    session.body.replaceChildren(h('div', { class: 'pl-win ls-study-card' },
      h('div', { class: 'pl-titlebar' }, h('span', { class: 'pl-title' }, `${idx + 1} / ${words.length}`), h('span', { class: 'spacer' })),
      body));
    const showBtn = h('button', { class: 'btn btn--primary btn--lg', type: 'button' }, 'Show');
    showBtn.addEventListener('click', () => showBack(w, body));
    session.footer.replaceChildren(showBtn);
  }
  function showBack(w, body) {
    const ex = (w.examples || [])[0];
    body.append(
      readingEl(w, { both: true, size: 'lg' }),
      h('p', { class: 'meaning' }, w.meaning || ''),
      w.meaningNative ? h('p', { class: 'muted' }, w.meaningNative) : null,
      speakButton(w.hanzi, { size: 'lg' }),
      ex ? exampleEl(ex) : null);
    const isLast = idx >= words.length - 1;
    const nextBtn = h('button', { class: 'btn btn--primary btn--lg', type: 'button' }, isLast ? 'Finish' : 'Next');
    nextBtn.addEventListener('click', () => { idx += 1; if (idx >= words.length) showDone(); else showCard(); });
    session.footer.replaceChildren(nextBtn);
  }
  function showDone() {
    session.setProgress(words.length, words.length);
    session.body.replaceChildren(h('div', { class: 'pl-win ls-study-done' },
      h('div', { class: 'win-body' },
        h('p', { class: 'h3' }, 'Done — practice now?'),
        h('div', { class: 'row row--wrap' },
          h('button', { class: 'btn btn--primary', type: 'button', onClick: () => { session.close(); navigate(`/review?lesson=${lesson.id}`); } }, 'Practice now'),
          h('button', { class: 'btn', type: 'button', onClick: () => session.close() }, 'Close')))));
    session.footer.replaceChildren();
  }
  showCard();
}

async function renderDetail(root, id) {
  const myGen = ++gen;
  setTitle('Lessons');
  root.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  let lesson;
  try { lesson = await api.get(`/api/lessons/${id}`); }
  catch (e) {
    if (myGen !== gen) return;
    toast(e.message, 'bad');
    root.replaceChildren(
      h('a', { class: 'btn btn--sm btn--quiet ls-back', href: '#/lessons' }, pixelIcon('back', 2), 'Lessons'),
      h('div', { class: 'card' }, h('p', { class: 'h3' }, 'This lesson could not load.'), h('p', { class: 'muted' }, e.message)));
    return;
  }
  if (myGen !== gen) return;
  setTitle(lesson.title || 'Lessons');

  if (lesson.status === 'new') {
    try { lesson = { ...lesson, status: 'started' }; await api.put(`/api/lessons/${id}`, { status: 'started' }); }
    catch { /* best-effort: the learner still sees the lesson either way */ }
  }
  if (myGen !== gen) return;
  paintLesson(root, lesson, myGen);
}

function paintLesson(root, lesson, myGen) {
  const reload = () => renderDetail(root, lesson.id);
  const backLink = h('a', { class: 'btn btn--sm btn--quiet ls-back', href: '#/lessons' }, pixelIcon('back', 2), 'Lessons');

  const metaBits = [];
  if (lesson.classDate) metaBits.push(h('span', null, fmt.date(lesson.classDate)));
  if (lesson.noteId) metaBits.push(h('a', { href: `#/notes/${lesson.noteId}` }, 'View source note'));
  const metaLine = metaBits.length ? h('div', { class: 'row row--wrap small muted ls-meta' }, ...metaBits) : null;

  const p = lesson.progress || { total: 0, learned: 0, mastered: 0, avgScore: 0 };
  const progressLine = h('div', { class: 'row ls-progress' },
    h('span', { class: 'small muted' }, `${fmt.n(p.learned)} learned · ${fmt.n(p.mastered)} mastered · ${fmt.n(p.total)} words`),
    meter(p.avgScore || 0));

  const actionsRow = h('div', { class: 'row row--wrap ls-actions' },
    h('button', { class: 'btn btn--primary', type: 'button', onClick: () => startStudySession(lesson) }, 'Study cards'),
    h('button', { class: 'btn', type: 'button', onClick: () => navigate(`/review?lesson=${lesson.id}`) }, 'Practice'),
    h('button', { class: 'btn', type: 'button', onClick: () => navigate(`/challenge?lesson=${lesson.id}`) }, 'Challenge'));

  const win = h('div', { class: 'pl-win ls-win' },
    h('div', { class: 'pl-titlebar' }, h('span', { class: 'pl-title' }, lesson.titleZh || lesson.title), h('span', { class: 'spacer' })),
    h('div', { class: 'win-body' },
      h('h1', null, lesson.title),
      metaLine,
      lesson.summary ? h('p', null, lesson.summary) : null,
      progressLine,
      actionsRow));

  const sectionEls = (lesson.sections || []).map((s) => h('div', { class: 'card ls-section' },
    h('p', { class: 'pl-eyebrow' }, KIND_LABEL[s.kind] || s.kind || 'Section'),
    s.titleZh ? h('div', { class: 'zh ls-section-zh', lang: 'zh-Hant' }, s.titleZh) : null,
    s.title ? h('h3', null, s.title) : null,
    markdownish(s.body || '')));

  const grammarEls = (lesson.grammar || []).map((g) => h('div', { class: 'card ls-grammar' },
    h('p', { class: 'pl-eyebrow' }, 'Grammar'),
    hasHanzi(g.pattern) ? hanziEl({ hanzi: g.pattern }, { size: 'md' }) : h('div', { class: 'mono ls-pattern' }, g.pattern || ''),
    g.explanation ? h('p', null, g.explanation) : null,
    ...(g.examples || []).map(exampleEl)));

  const dialogueBlock = (lesson.dialogue && lesson.dialogue.length)
    ? h('div', { class: 'stack' }, h('p', { class: 'pl-eyebrow' }, 'Dialogue'),
        h('div', { class: 'ls-dialogue' }, ...lesson.dialogue.map((d) => h('div', { class: 'ls-dialogue-line' },
          h('span', { class: 'pl-tag' }, d.speaker || '·'),
          hanziEl({ hanzi: d.zh, zhuyin: d.zhuyin, pinyin: d.pinyin }, { size: 'md' }),
          d.translation ? h('span', { class: 'ls-dialogue-tr muted' }, d.translation) : null,
          speakButton(d.zh || '', { size: 'sm' })))))
    : null;

  const vocabSection = h('div', { class: 'stack ls-vocab' },
    h('p', { class: 'pl-eyebrow' }, 'Vocabulary'),
    (lesson.words && lesson.words.length) ? h('div', { class: 'list' }, ...lesson.words.map(lessonWordRow)) : h('p', { class: 'muted' }, 'No words in this lesson yet.'),
    h('button', { class: 'btn btn--sm', type: 'button', onClick: () => openWordWindow({ lessonId: lesson.id, onSaved: reload }) }, 'Add word to this lesson'));

  const isDone = lesson.status === 'done';
  const footerActions = h('div', { class: 'row row--wrap ls-foot-actions' },
    h('button', {
      class: 'btn btn--sm', type: 'button',
      onClick: async () => {
        try { await api.put(`/api/lessons/${lesson.id}`, { status: isDone ? 'started' : 'done' }); toast(isDone ? 'Marked as not done.' : 'Marked as done.', 'ok'); reload(); }
        catch (e) { toast(e.message, 'bad'); }
      },
    }, isDone ? 'Mark as not done' : 'Mark as done'),
    h('button', { class: 'btn btn--sm', type: 'button', onClick: () => openRenameWindow(lesson, reload) }, 'Rename'),
    h('button', {
      class: 'btn btn--sm btn--danger', type: 'button',
      onClick: async () => {
        const ok = await confirmWindow({ title: 'Delete this lesson?', text: 'Words stay in your dictionary; only the lesson card is removed.', okLabel: 'Delete', danger: true });
        if (!ok) return;
        try { await api.del(`/api/lessons/${lesson.id}`); toast('Lesson deleted.', 'ok'); navigate('/lessons'); }
        catch (e) { toast(e.message, 'bad'); }
      },
    }, 'Delete lesson'));

  const children = [backLink, win, ...sectionEls, ...grammarEls, dialogueBlock, vocabSection, h('hr', { class: 'divider' }), footerActions].filter(Boolean);
  if (myGen !== gen) return;
  root.replaceChildren(...children);
}

function openRenameWindow(lesson, reload) {
  const titleInput = h('input', { class: 'input', value: lesson.title || '' });
  const titleZhInput = h('input', { class: 'input zh', value: lesson.titleZh || '' });
  const summaryInput = h('textarea', { class: 'textarea', value: lesson.summary || '' });
  openWindow({
    title: 'Rename lesson',
    body: h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Title'), titleInput),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Title (Chinese)'), titleZhInput),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Summary'), summaryInput)),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save', class: 'btn--primary',
        onClick: async () => {
          const title = titleInput.value.trim();
          if (!title) { toast('Title is required.', 'bad'); return false; }
          try {
            await api.put(`/api/lessons/${lesson.id}`, { title, titleZh: titleZhInput.value.trim(), summary: summaryInput.value.trim() });
            toast('Lesson updated.', 'ok');
            reload();
          } catch (e) { toast(e.message, 'bad'); return false; }
        },
      },
    ],
  });
}

export default {
  id: 'lessons',
  title: 'Lessons',
  async render(root, params) {
    if (params?.id) await renderDetail(root, params.id);
    else await renderIndex(root);
  },
  unmount() {
    gen++;
    try { liveSession?.close(); } catch { /* the layer is already gone */ }
    liveSession = null;
  },
};
