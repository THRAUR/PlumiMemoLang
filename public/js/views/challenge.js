/* challenge.js — the Duolingo-style mixed quiz (#/challenge).
     LANDING  a Mac window: scope, size, which question types, and (with an
              API key) an AI-written reading passage. One primary action.
     SESSION  the full-screen layer: one question at a time, an answer that
              stays local until "Check", then the feedback banner from ui.js.

   Every question type answers the same tiny interface so the session loop
   never knows what it is showing:
     { el, auto?, onShow?(), ready(), grade() -> {ok, title, detail}, key?(n) }
   `auto` marks a question that settles itself (Match pairs) — it has no Check.

   A reading passage arrives as ONE question carrying several sub-questions;
   normalise() flattens those into separate screens, because "each counts as a
   question" for the progress bar and the score. */

import { api } from '../api.js';
import { settings, stats, setStats, refreshStats } from '../state.js';
import { navigate } from '../router.js';
import { createBird } from '../bird.js';
import { hanziEl } from '../hanzi.js';
import { pinyinMatches, normalizePinyin } from '/shared/zhuyin.js';
import {
  h, toast, confirmWindow, emptyState, busy, celebrate, tts, speakButton, pixelIcon,
  fmt, readingFor, readingEl, openSession, feedback, setTitle,
} from '../ui.js';

/* The question types the learner can switch off. `tts` marks the one that
   needs a speech synthesiser to exist at all. */
const TYPES = [
  { id: 'mc-meaning', label: 'Pick the meaning' },
  { id: 'mc-hanzi', label: 'Pick the word' },
  { id: 'listen', label: 'Listening', tts: true },
  { id: 'type-pinyin', label: 'Type the pinyin' },
  { id: 'match', label: 'Match pairs' },
  { id: 'order', label: 'Build the sentence' },
  { id: 'cloze', label: 'Fill the blank' },
];

const BOPOMOFO = /[ㄅ-ㄯㆠ-ㆿ]/;   // is that reading 注音 or pinyin?

/* ---------- module state (one view instance at a time) ---------- */
let token = 0;
let live = null;
const timers = new Set();
function later(fn, ms) { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; }
function clearTimers() { for (const t of timers) clearTimeout(t); timers.clear(); }

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/* The API hands readings out as one resolved string; hanziEl and readingFor
   want the word's own fields, so sort the string into the right slot. */
function wordish(p = {}) {
  const r = p.reading || '';
  return {
    hanzi: p.hanzi || '',
    zhuyin: p.zhuyin || (BOPOMOFO.test(r) ? r : ''),
    pinyin: p.pinyin || (r && !BOPOMOFO.test(r) ? r : ''),
  };
}

function normOptions(q) {
  const raw = Array.isArray(q?.options) ? q.options : [];
  const opts = raw.map((o, n) => (o && typeof o === 'object' ? { ...o, id: o.id ?? String(n) } : { id: String(n), text: String(o ?? '') }));
  let answerId = q?.answerId;
  if (answerId === undefined || answerId === null) {
    const ai = Number.isInteger(q?.answerIndex) ? q.answerIndex : -1;
    answerId = opts[ai]?.id;
  }
  return { opts, answerId };
}
function optText(o) { return o?.text ?? o?.meaning ?? o?.label ?? o?.hanzi ?? ''; }

/* ---------- the view ---------- */
async function render(root, params) {
  const my = ++token;
  setTitle('Challenge');
  const lessonId = params?.query?.lesson || '';
  const ctx = {
    root, my, lessonId,
    demo: params?.query?.demo || '',          // '1' | 'few' (empty state) | 'ai' (reading)
    scope: lessonId ? 'lesson' : 'all',
    pickedLesson: lessonId,
    size: 10,
    types: new Set(TYPES.filter((t) => !t.tts || tts.available).map((t) => t.id)),
    reading: false,
    lessons: [],
    leaving: false,
  };

  // The lesson list only decorates the scope control, so a 404 costs a toast
  // and the "All words" scope, never the screen.
  if (!lessonId && !ctx.demo) {
    try {
      const res = await api.get('/api/lessons');
      if (ctx.my !== token) return;
      ctx.lessons = (res?.lessons || []).filter((l) => l && l.id);
    } catch (e) { toast(e.message, 'bad'); }
  } else if (ctx.demo) {
    ctx.lessons = [{ id: 'demo-l1', title: 'Ordering food' }, { id: 'demo-l2', title: 'At school' }];
  }
  if (ctx.my !== token || !root.isConnected) return;
  paintLanding(ctx);
}

function paintLanding(ctx) {
  const words = ctx.demo === 'few' ? 2 : Number(stats?.counts?.words);
  const page = h('div', { class: 'ch-landing' });
  if (ctx.lessonId) page.append(h('p', { class: 'pl-eyebrow' }, 'Lesson challenge'));

  const body = [];
  // Only refuse when we actually know the number: with the API down we still
  // show the full landing, and Start reports the server's own message.
  if (Number.isFinite(words) && words < 4) {
    body.push(emptyState({
      bird: createBird({ size: 4, mood: 'think' }).el,
      title: 'Add at least 4 words first',
      text: 'A challenge needs a few words to draw questions and wrong answers from.',
      action: h('div', { class: 'row row--wrap ch-empty-actions' },
        h('button', { class: 'btn btn--primary', type: 'button', onClick: () => { ctx.leaving = true; navigate('/notes'); } }, pixelIcon('notes', 2), 'Add notes'),
        h('button', { class: 'btn', type: 'button', onClick: () => { ctx.leaving = true; navigate('/words'); } }, pixelIcon('words', 2), 'Browse words')),
    }));
  } else {
    body.push(...optionsBlock(ctx));
  }

  page.append(h('div', { class: 'pl-win ch-win' },
    h('div', { class: 'pl-titlebar' }, h('span', { class: 'pl-title' }, 'Challenge'), h('span', { class: 'spacer' }), pixelIcon('trophy', 2)),
    h('div', { class: 'win-body' }, ...body)));
  if (ctx.demo) page.append(h('p', { class: 'small faint' }, 'Demo data (?demo=1) — nothing is saved.'));
  ctx.root.replaceChildren(page);
}

function seg(items, value, onPick) {
  const box = h('div', { class: 'seg' });
  const btns = items.map((it) => h('button', {
    type: 'button', class: it.value === value ? 'is-active' : '',
    onClick: (e) => { for (const x of btns) x.classList.toggle('is-active', x === e.currentTarget); onPick(it.value); },
  }, it.label));
  box.append(...btns);
  return box;
}

function optionsBlock(ctx) {
  const out = [];

  /* Scope: a two-way switch when the learner arrived from a lesson, a plain
     list when they did not. */
  if (ctx.lessonId) {
    out.push(h('label', { class: 'field' }, h('span', { class: 'label' }, 'Scope'),
      seg([{ value: 'all', label: 'All words' }, { value: 'lesson', label: 'This lesson' }], ctx.scope, (v) => { ctx.scope = v; })));
  } else if (ctx.lessons.length) {
    const sel = h('select', { class: 'select' }, h('option', { value: '' }, 'All words'),
      ...ctx.lessons.map((l) => h('option', { value: l.id }, l.title || l.titleZh || 'Lesson')));
    sel.addEventListener('change', () => { ctx.pickedLesson = sel.value; ctx.scope = sel.value ? 'lesson' : 'all'; });
    out.push(h('label', { class: 'field' }, h('span', { class: 'label' }, 'Scope'), sel));
  }

  out.push(h('label', { class: 'field' }, h('span', { class: 'label' }, 'Questions'),
    seg([{ value: 10, label: '10' }, { value: 20, label: '20' }], ctx.size, (v) => { ctx.size = v; })));

  out.push(h('p', { class: 'pl-eyebrow' }, 'Question types'));
  const list = h('div', { class: 'ch-types' });
  for (const t of TYPES) {
    if (t.tts && !tts.available) continue;            // no voice, no listening question
    const input = h('input', { type: 'checkbox', checked: ctx.types.has(t.id) });
    input.addEventListener('change', () => {
      if (input.checked) ctx.types.add(t.id);
      else if (ctx.types.size <= 1) { input.checked = true; toast('Keep at least one question type.', ''); }
      else ctx.types.delete(t.id);
    });
    list.append(h('label', { class: 'check ch-type' }, input, h('span', { class: 'grow' }, t.label)));
  }
  out.push(list);

  // The AI reading needs a key. `?demo=ai` pretends there is one so the
  // passage question can be exercised without one.
  if (settings?.ai?.hasApiKey || ctx.demo === 'ai') {
    const input = h('input', { type: 'checkbox', checked: ctx.reading });
    input.addEventListener('change', () => { ctx.reading = input.checked; });
    out.push(h('label', { class: 'check ch-reading-toggle' }, input,
      h('span', { class: 'grow' }, 'Reading passage (AI)',
        h('span', { class: 'ch-hint-line' }, 'Plumi writes a short text from your words'))));
  }

  out.push(h('button', {
    class: 'btn btn--primary btn--lg btn--block', type: 'button', onClick: () => start(ctx),
  }, pixelIcon('bolt', 2), 'Start challenge'));
  return out;
}

/* ---------- build ---------- */
async function start(ctx) {
  const lessonId = ctx.scope === 'lesson' ? (ctx.lessonId || ctx.pickedLesson || '') : '';
  const opts = { size: ctx.size, lessonId: lessonId || null, types: [...ctx.types], reading: !!ctx.reading };

  const session = openSession({
    title: 'Challenge',
    onClose: () => {
      live = null;
      session._cleanup?.();                           // the run loop's key listener
      clearTimers();
      tts.stop();
      if (!ctx.leaving && ctx.my === token && ctx.root.isConnected) paintLanding(ctx);
    },
  });
  live = session;
  session.onLeave = () => session.close();            // nothing to lose while it builds

  const bird = createBird({ size: 5, mood: 'think' });
  const note = h('p', { class: 'muted' }, opts.reading ? 'Plumi is writing your reading…' : 'Building your challenge…');
  session.body.replaceChildren(h('div', { class: 'ch-build' }, bird.el, note));
  session.footer.replaceChildren(h('div', { class: 'grow' }),
    h('button', { class: 'btn', type: 'button', onClick: () => session.close() }, 'Cancel'));
  session.setBusy(true);

  let built = null;
  try {
    built = ctx.demo ? demoChallenge(opts) : await api.post('/api/challenge/build', opts);
    if (built?.jobId) built = await api.job(built.jobId, { onProgress: (p) => { note.textContent = String(p); } });
  } catch (e) {
    toast(e.message, 'bad');
    session.setBusy(false);
    session.close();
    return;
  }
  session.setBusy(false);
  if (!session.body.isConnected) return;              // closed while we waited
  const flat = normalise(built?.questions);
  if (!flat.length) {
    toast('The challenge came back without any questions.', 'bad');
    session.close();
    return;
  }
  runSession(ctx, session, built, opts, flat);
}

/* Flatten the server's question list into one screen per question, and give
   each screen the label the end-of-run recap will print. */
function normalise(questions) {
  const out = [];
  for (const [topIndex, q] of (Array.isArray(questions) ? questions : []).entries()) {
    if (!q || typeof q !== 'object') continue;
    const subs = q.type === 'reading' || q.passage ? (q.questions || q.subQuestions || q.items || []) : null;
    if (subs) {
      const p = q.passage || q.prompt?.passage || {};
      const passage = {
        title: q.title || p.title || 'Reading',
        zh: p.zh || p.text || '',
        zhuyin: p.zhuyin || '',
        pinyin: p.pinyin || '',
        translation: p.translation || '',
        open: false,
      };
      for (const sub of subs) {
        if (!sub) continue;
        out.push({ type: 'reading', q: sub, passage, topIndex, wordId: null, label: sub.q || sub.question || passage.title, lang: null });
      }
      continue;
    }
    const label = labelFor(q);
    out.push({ type: q.type, q, topIndex, wordId: q.wordId || null, label: label.text, lang: label.lang });
  }
  return out;
}
function labelFor(q) {
  if (q.type === 'match') return { text: `${(q.pairs || []).length} pairs`, lang: null };
  const hz = q.prompt?.hanzi || q.prompt?.tts || q.prompt?.sentence || '';
  if (hz) return { text: hz, lang: 'zh-Hant' };
  return { text: q.prompt?.meaning || q.prompt?.translation || q.type || 'Question', lang: null };
}

/* ---------- the session loop ---------- */
function runSession(ctx, session, built, opts, flat) {
  const startedAt = Date.now();
  const answers = [];            // exactly what POST /api/challenge/finish wants
  const recap = [];              // what the end screen prints
  let i = 0, answered = 0, score = 0, qAt = 0, ended = false;
  let current = null;
  let checkBtn = null;

  const bird = createBird({ size: 3, mood: 'idle' });
  const birdSlot = h('div', { class: 'grow ch-bird' }, bird.el);

  session.onLeave = async () => {
    if (await confirmWindow({ title: 'Leave the challenge?', text: 'This run will not be scored.', okLabel: 'Leave' })) {
      ended = true;
      session.close();
    }
  };
  document.addEventListener('keydown', onKey);
  const stopKeys = () => document.removeEventListener('keydown', onKey);
  // openSession's own close path runs onClose, which calls this back — so the
  // X button, Escape and the end screen all unbind the keyboard.
  session._cleanup = stopKeys;

  function onKey(e) {
    if (ended || document.querySelector('.scrim')) return;
    if (!session.banner.hidden) return;                 // the feedback banner owns Enter
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (e.key === 'Enter' && !typing) {
      if (document.activeElement?.tagName === 'BUTTON') return;
      e.preventDefault();
      check();
      return;
    }
    if (!typing && current?.key && /^[1-4]$/.test(e.key)) { e.preventDefault(); current.key(Number(e.key)); }
  }

  const io = {
    onChange: () => { if (checkBtn) checkBtn.disabled = !current || !current.ready(); },
    check: () => check(),
    done: () => check(),
  };

  function show() {
    if (i >= flat.length) { end(); return; }
    const item = flat[i];
    qAt = performance.now();
    bird.setMood('idle');
    session.setProgress(answered, flat.length);
    current = buildQuestion(item, io);
    session.body.replaceChildren(current.el);
    session.body.scrollTop = 0;

    if (current.auto) {
      checkBtn = null;
      session.footer.replaceChildren(birdSlot, h('p', { class: 'ch-hint' }, current.hint || 'Tap a pair'));
    } else {
      checkBtn = h('button', { class: 'btn btn--primary btn--lg', type: 'button', disabled: true, onClick: () => check() }, 'Check');
      session.footer.replaceChildren(birdSlot, checkBtn);
      io.onChange();
    }
    current.onShow?.();
  }

  function check() {
    if (!current || current.settled || ended) return;
    if (!current.auto && !current.ready()) return;
    current.settled = true;
    let res;
    try { res = current.grade(); } catch (e) { res = { ok: false, title: 'Something went wrong', detail: e.message }; }
    const ms = Math.max(0, Math.round(performance.now() - qAt));
    const item = flat[i];
    answered += 1;
    if (res.ok) score += 1;
    answers.push({ index: i, wordId: item.wordId || null, correct: !!res.ok, ms });
    recap.push({ label: item.label, lang: item.lang, correct: !!res.ok });
    session.setProgress(answered, flat.length);
    bird.setMood(res.ok ? 'happy' : 'sad');
    if (checkBtn) checkBtn.disabled = true;
    feedback(session, {
      ok: !!res.ok,
      title: res.title || (res.ok ? 'Correct!' : 'Not quite'),
      // ui.js hands `detail` straight to replaceChildren(), which turns a null
      // into the literal text "null" — so always pass a node. An empty one is
      // collapsed by .banner-detail:has(> .ch-quiet) in challenge.css.
      detail: res.detail || h('span', { class: 'ch-quiet sr-only' }, res.ok ? 'Correct' : 'Incorrect'),
      actionLabel: i + 1 >= flat.length ? 'See your score' : 'Continue',
      onAction: () => { i += 1; show(); },
    });
  }

  async function end() {
    if (ended) return;
    ended = true;
    stopKeys();
    tts.stop();
    session.setBusy(true);
    let res = null;
    if (!ctx.demo) {
      try {
        res = await api.post('/api/challenge/finish', {
          id: built?.id || null,
          type: opts.lessonId ? 'lesson' : opts.reading ? 'reading' : 'mixed',
          lessonId: opts.lessonId || null,
          answers,
        });
        if (res?.stats) setStats(res.stats);
      } catch (e) {
        toast(e.message, 'bad');
        await refreshStats();
      }
    }
    session.setBusy(false);
    if (!session.body.isConnected) return;
    endCard(res);
  }

  function endCard(res) {
    session.onLeave = null;                             // Escape just closes now
    session.setProgress(1, 1);
    const total = flat.length;
    const got = Number.isFinite(res?.score) ? res.score : score;
    const ratio = total ? got / total : 0;
    const mood = ratio >= 0.8 ? 'cheer' : ratio >= 0.5 ? 'happy' : 'sad';
    const cheer = createBird({ size: 5, mood });
    const xp = Number.isFinite(res?.xp) ? res.xp : (ctx.demo ? got * 2 + 5 : 0);
    const ms = Date.now() - startedAt;

    const rows = h('div', { class: 'list ch-recap' });
    for (const r of [...recap].sort((a, b) => Number(a.correct) - Number(b.correct))) {
      rows.append(h('div', { class: `list-row ${r.correct ? 'is-ok' : 'is-bad'}` },
        h('span', { class: `grow ellipsis${r.lang ? ' hz hz--sm' : ''}`, lang: r.lang || undefined }, r.label || '—'),
        pixelIcon(r.correct ? 'check' : 'x', 2)));
    }

    session.body.replaceChildren(h('div', { class: 'pl-win ch-end' },
      h('div', { class: 'pl-titlebar' }, h('span', { class: 'pl-title' }, 'Challenge complete'), h('span', { class: 'spacer' })),
      h('div', { class: 'win-body' },
        h('div', { class: 'ch-end-hero' }, cheer.el),
        h('p', { class: 'ch-score' }, `${got} / ${total}`),
        h('div', { class: 'scoreboard' },
          h('div', { class: 'score accent' }, h('div', { class: 'n' }, fmt.n(xp)), h('div', { class: 'l' }, 'XP')),
          h('div', { class: 'score' }, h('div', { class: 'n' }, `${total ? Math.round(ratio * 100) : 0}%`), h('div', { class: 'l' }, 'Accuracy')),
          h('div', { class: 'score' }, h('div', { class: 'n' }, fmt.ms(ms)), h('div', { class: 'l' }, 'Time'))),
        h('p', { class: 'pl-eyebrow' }, 'Every question'),
        rows)));
    later(() => cheer.say(ratio >= 0.8 ? '太棒了！' : ratio >= 0.5 ? '不錯！' : '下次會更好', 3200), 400);
    if (ratio >= 0.5) celebrate(session.body);

    // Both buttons in one shrinkable group: .btn--lg's 200px floor overflows a
    // 390px footer when it sits next to another button.
    session.footer.replaceChildren(h('div', { class: 'ch-end-actions' },
      h('button', { class: 'btn', type: 'button', onClick: () => { ctx.leaving = true; session.close(); navigate('/today'); } }, pixelIcon('today', 2), 'Back to Today'),
      h('button', { class: 'btn btn--primary btn--lg', type: 'button', onClick: () => { session.close(); start(ctx); } }, pixelIcon('refresh', 2), 'Play again')));
  }

  show();
}

/* ---------- shared question pieces ---------- */
function qCard(eyebrow, ...kids) {
  return h('div', { class: 'ch-q' }, eyebrow ? h('p', { class: 'pl-eyebrow' }, eyebrow) : null, ...kids);
}

/* A multiple-choice list. Rows for text answers, a 2-up grid for hanzi ones. */
function makeChoice({ opts, answerId, grid = false, onChange = null }) {
  let sel = null, locked = false;
  const btns = new Map();
  const box = h('div', { class: grid ? 'options options--grid' : 'options' });
  opts.forEach((o, n) => {
    const b = h('button', { class: 'option', type: 'button', onClick: () => pick(o.id) });
    if (grid) {
      b.append(h('span', { class: 'hz', lang: 'zh-Hant' }, o.hanzi || optText(o)));
      const r = readingFor(wordish(o)).primary;
      if (r) b.append(h('span', { class: `reading reading--${r.kind}`, lang: r.kind === 'zhuyin' ? 'zh-Hant' : undefined }, r.text));
    } else {
      b.append(h('span', { class: 'option-key' }, String(n + 1)), h('span', { class: 'grow' }, optText(o)));
    }
    btns.set(o.id, b);
    box.append(b);
  });
  function pick(id) {
    if (locked || !btns.has(id)) return;
    sel = id;
    for (const [k, b] of btns) b.classList.toggle('is-selected', k === id);
    onChange?.();
  }
  return {
    el: box,
    get selected() { return sel; },
    pick,
    byIndex: (n) => opts[n]?.id,
    answer: () => opts.find((o) => o.id === answerId) || null,
    lock() {
      locked = true;
      for (const [k, b] of btns) {
        b.disabled = true;
        b.classList.remove('is-selected');
        if (k === answerId) b.classList.add('is-correct');
        else if (k === sel) b.classList.add('is-wrong');
      }
    },
  };
}

/* pinyin · 注音, side by side. readingEl() only shows the learner's chosen
   script, but a typing answer has to spell out BOTH. */
function readingPair(answer = {}) {
  const row = h('div', { class: 'row ch-detail-readings' });
  if (answer.pinyin) row.append(h('span', { class: 'reading reading--pinyin' }, answer.pinyin));
  if (answer.pinyin && answer.zhuyin) row.append(h('span', { class: 'faint' }, '·'));
  if (answer.zhuyin) row.append(h('span', { class: 'reading reading--zhuyin', lang: 'zh-Hant' }, answer.zhuyin));
  return row.childNodes.length ? row : null;
}

/* The banner's "here is what it was": ruby hanzi, both readings, the meaning. */
function wordDetail({ hanzi, zhuyin, pinyin, reading, meaning }) {
  const w = wordish({ hanzi, zhuyin, pinyin, reading });
  const box = h('div', { class: 'ch-detail' });
  if (w.hanzi) box.append(hanziEl(w, { size: 'md' }));
  const r = readingEl(w, { both: true });
  if (r) box.append(r);
  if (meaning) box.append(h('span', { class: 'ch-detail-meaning' }, meaning));
  return box;
}

/* A sentence with ▢ in it, the blank picked out. */
function blankSplit(sentence) {
  const s = String(sentence || '');
  if (!s.includes('▢')) return [s];
  const out = [];
  s.split('▢').forEach((part, n) => {
    if (n) out.push(h('span', { class: 'ch-blank' }, '▢'));
    if (part) out.push(part);
  });
  return out;
}

/* ---------- question types ---------- */
function buildQuestion(item, io) {
  switch (item.type) {
    case 'mc-hanzi': return qMcHanzi(item, io);
    case 'listen': return qListen(item, io);
    case 'type-pinyin': return qTypePinyin(item, io);
    case 'match': return qMatch(item, io);
    case 'order': return qOrder(item, io);
    case 'cloze': return qCloze(item, io);
    case 'reading': return qReading(item, io);
    case 'mc-meaning':
    default: return qMcMeaning(item, io);
  }
}

function qMcMeaning(item, io) {
  const q = item.q;
  const w = wordish(q.prompt || {});
  const { opts, answerId } = normOptions(q);
  const choice = makeChoice({ opts, answerId, onChange: io.onChange });
  const el = qCard('What does it mean?',
    h('div', { class: 'ch-prompt' }, hanziEl(w, { size: 'xl' }), tts.available ? speakButton(w.hanzi, { label: 'Play the word' }) : null),
    choice.el);
  return {
    el,
    ready: () => !!choice.selected,
    key: (n) => choice.pick(choice.byIndex(n - 1)),
    grade() {
      const ok = choice.selected === answerId;
      choice.lock();
      return { ok, detail: ok ? null : wordDetail({ ...w, meaning: optText(choice.answer()) }) };
    },
  };
}

function qMcHanzi(item, io) {
  const q = item.q;
  const meaning = q.prompt?.meaning || '';
  const { opts, answerId } = normOptions(q);
  const choice = makeChoice({ opts, answerId, grid: true, onChange: io.onChange });
  const el = qCard('Which word is it?', h('p', { class: 'meaning ch-meaning' }, meaning), choice.el);
  return {
    el,
    ready: () => !!choice.selected,
    key: (n) => choice.pick(choice.byIndex(n - 1)),
    grade() {
      const ok = choice.selected === answerId;
      choice.lock();
      return { ok, detail: ok ? null : wordDetail({ ...(choice.answer() || {}), meaning }) };
    },
  };
}

function qListen(item, io) {
  const q = item.q;
  const text = q.prompt?.tts || q.prompt?.hanzi || '';
  const { opts, answerId } = normOptions(q);
  const choice = makeChoice({ opts, answerId, grid: true, onChange: io.onChange });
  const el = qCard('What did Plumi say?',
    h('div', { class: 'ch-listen' },
      speakButton(text, { size: 'lg', label: 'Play again' }),
      h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => tts.speak(text, { rate: 0.6 }) }, pixelIcon('speaker', 2), 'Play slower')),
    choice.el);
  return {
    el,
    onShow: () => later(() => tts.speak(text), 260),
    ready: () => !!choice.selected,
    key: (n) => choice.pick(choice.byIndex(n - 1)),
    grade() {
      const ok = choice.selected === answerId;
      choice.lock();
      return { ok, detail: ok ? null : wordDetail({ ...(choice.answer() || {}), hanzi: (choice.answer() || {}).hanzi || text }) };
    },
  };
}

/* The zhuyin/pinyin comparison lives in shared/zhuyin.js. Wrap it: a throw in
   there must not take the session down with it. */
function readingMatches(typed, answer) {
  const bare = (s) => String(s || '').replace(/\s+/g, '');
  try {
    if (answer.pinyin && pinyinMatches(typed, answer.pinyin, { tones: false })) return true;
  } catch { /* fall through to the plain comparisons */ }
  try {
    if (answer.pinyin && normalizePinyin(typed, { tones: false }) === normalizePinyin(answer.pinyin, { tones: false })) return true;
  } catch { /* ignore */ }
  return !!answer.zhuyin && bare(typed) === bare(answer.zhuyin);
}

function qTypePinyin(item, io) {
  const q = item.q;
  const w = wordish(q.prompt || {});
  const answer = q.answer || {};
  const input = h('input', {
    class: 'input input--big ch-input', type: 'text', placeholder: 'pinyin or 注音',
    autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': 'Type the reading',
  });
  input.addEventListener('input', () => io.onChange());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); io.check(); } });
  const el = qCard('How do you read it?',
    h('div', { class: 'ch-prompt' }, hanziEl(w, { reading: 'none', size: 'xl' })),
    q.prompt?.meaning ? h('p', { class: 'meaning ch-meaning' }, q.prompt.meaning) : null,
    input);
  return {
    el,
    onShow: () => later(() => input.focus(), 80),
    ready: () => input.value.trim().length > 0,
    grade() {
      const typed = input.value.trim();
      const ok = readingMatches(typed, answer);
      input.disabled = true;
      input.classList.add(ok ? 'is-ok' : 'is-bad');
      // A typing question shows the exact reading either way: right or wrong,
      // that spelling is the thing being learned.
      return {
        ok,
        detail: h('div', { class: 'ch-detail' },
          hanziEl({ hanzi: w.hanzi, pinyin: answer.pinyin || '', zhuyin: answer.zhuyin || '' }, { size: 'md' }),
          readingPair(answer),
          q.prompt?.meaning ? h('span', { class: 'ch-detail-meaning' }, q.prompt.meaning) : null),
      };
    },
  };
}

/* Match pairs settles itself: the last correct pair is the answer. */
function qMatch(item, io) {
  const pairs = (item.q.pairs || []).filter((p) => p && p.hanzi).map((p, n) => ({ ...p, id: p.id ?? String(n) }));
  const lBtns = new Map(), rBtns = new Map();
  let selL = null, selR = null, misses = 0, locked = 0, flashing = false;

  const col = (side, items) => {
    const box = h('div', { class: `ch-match-col ch-match-col--${side}` });
    for (const p of items) {
      const b = h('button', {
        class: `tile ch-tile ch-tile--${side}`, type: 'button',
        lang: side === 'l' ? 'zh-Hant' : undefined,
        onClick: () => select(side, p.id),
      }, side === 'l' ? p.hanzi : (p.meaning || ''));
      (side === 'l' ? lBtns : rBtns).set(p.id, b);
      box.append(b);
    }
    return box;
  };

  function paint() {
    for (const [k, b] of lBtns) if (!b.disabled) b.classList.toggle('is-selected', k === selL);
    for (const [k, b] of rBtns) if (!b.disabled) b.classList.toggle('is-selected', k === selR);
  }
  function select(side, id) {
    if (flashing) return;
    const btn = (side === 'l' ? lBtns : rBtns).get(id);
    if (!btn || btn.disabled) return;
    if (side === 'l') selL = selL === id ? null : id;
    else selR = selR === id ? null : id;
    paint();
    if (selL !== null && selR !== null) resolve();
  }
  function resolve() {
    const a = lBtns.get(selL), b = rBtns.get(selR);
    if (selL === selR) {
      for (const x of [a, b]) { x.classList.remove('is-selected'); x.classList.add('is-correct'); x.disabled = true; }
      selL = selR = null;
      locked += 1;
      if (locked === pairs.length) later(() => io.done(), 300);
    } else {
      misses += 1;
      flashing = true;
      a.classList.add('is-wrong'); b.classList.add('is-wrong');
      later(() => {
        a.classList.remove('is-wrong', 'is-selected'); b.classList.remove('is-wrong', 'is-selected');
        selL = selR = null; flashing = false; paint();
      }, 500);
    }
  }

  const el = qCard('Match the pairs', h('div', { class: 'ch-match' },
    col('l', shuffle(pairs)), col('r', shuffle(pairs))));
  return {
    el,
    auto: true,
    hint: 'Tap a word, then its meaning',
    ready: () => locked === pairs.length,
    grade() {
      const ok = misses === 0;
      return {
        ok,
        title: ok ? 'All matched!' : 'Matched — eventually',
        detail: ok ? null : `${misses} wrong ${misses === 1 ? 'try' : 'tries'} along the way.`,
      };
    },
  };
}

function qOrder(item, io) {
  const q = item.q;
  const tiles = (Array.isArray(q.tiles) ? q.tiles : []).map((t, n) => (t && typeof t === 'object' ? { id: t.id ?? String(n), text: t.text ?? '' } : { id: String(n), text: String(t ?? '') }));
  const want = (Array.isArray(q.answer) ? q.answer : []).map(String);
  // Placement is tracked by SLOT, not by id: a sentence can repeat a character.
  let placed = [];
  const ansRow = h('div', { class: 'tile-answer' });
  const bank = h('div', { class: 'tile-bank' });
  const bankBtns = tiles.map((t, n) => h('button', {
    class: 'tile', type: 'button', lang: 'zh-Hant',
    onClick: () => { if (!placed.includes(n)) { placed.push(n); repaint(); } },
  }, t.text));
  bank.append(...bankBtns);

  function repaint() {
    ansRow.replaceChildren(...placed.map((n) => h('button', {
      class: 'tile', type: 'button', lang: 'zh-Hant',
      onClick: () => { placed = placed.filter((x) => x !== n); repaint(); },
    }, tiles[n].text)));
    bankBtns.forEach((b, n) => b.classList.toggle('is-used', placed.includes(n)));
    io.onChange();
  }
  repaint();

  const el = qCard('Build the sentence',
    q.prompt?.translation ? h('p', { class: 'meaning ch-meaning' }, q.prompt.translation) : null,
    h('div', { class: 'ch-order' }, ansRow, bank));
  return {
    el,
    ready: () => placed.length > 0,
    grade() {
      const got = placed.map((n) => tiles[n].id).join('');
      const ok = want.length > 0 && got === want.join('');
      for (const b of bankBtns) b.disabled = true;
      for (const b of ansRow.children) b.disabled = true;
      ansRow.classList.add(ok ? 'is-ok' : 'is-bad');
      const sentence = want.map((id) => tiles.find((t) => t.id === id)?.text || '').join('');
      return { ok, detail: h('div', { class: 'ch-detail' }, h('span', { class: 'hz hz--md', lang: 'zh-Hant' }, sentence)) };
    },
  };
}

function qCloze(item, io) {
  const q = item.q;
  const { opts, answerId } = normOptions(q);
  const choice = makeChoice({ opts, answerId, grid: true, onChange: io.onChange });
  const el = qCard('Fill the blank',
    h('div', { class: 'hz hz--lg ch-cloze', lang: 'zh-Hant' }, ...blankSplit(q.prompt?.sentence)),
    q.prompt?.translation ? h('p', { class: 'small muted ch-cloze-tr' }, q.prompt.translation) : null,
    choice.el);
  return {
    el,
    ready: () => !!choice.selected,
    key: (n) => choice.pick(choice.byIndex(n - 1)),
    grade() {
      const ok = choice.selected === answerId;
      choice.lock();
      if (ok) return { ok };
      const a = choice.answer() || {};
      const full = String(q.prompt?.sentence || '').replace('▢', a.hanzi || '');
      return { ok, detail: h('div', { class: 'ch-detail' }, h('span', { class: 'hz hz--md', lang: 'zh-Hant' }, full)) };
    },
  };
}

/* One sub-question of a reading passage. The passage stays on screen (and
   remembers whether the translation is open) across its questions. */
function qReading(item, io) {
  const sub = item.q;
  const p = item.passage;
  const { opts, answerId } = normOptions(sub);
  const choice = makeChoice({ opts, answerId, onChange: io.onChange });

  const box = h('div', { class: 'card ch-passage' });
  box.append(h('div', { class: 'row' },
    h('p', { class: 'pl-eyebrow grow' }, p.title || 'Reading'),
    tts.available ? speakButton(p.zh, { label: 'Read it aloud' }) : null));
  if (p.zh) box.append(h('div', { class: 'hz hz--md ch-passage-zh', lang: 'zh-Hant' }, p.zh));
  const r = readingEl({ zhuyin: p.zhuyin, pinyin: p.pinyin });
  if (r) box.append(r);
  if (p.translation) {
    const tr = h('p', { class: 'small muted ch-passage-tr', hidden: !p.open }, p.translation);
    const toggle = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, p.open ? 'Hide translation' : 'Show translation');
    toggle.addEventListener('click', () => {
      p.open = !p.open;
      tr.hidden = !p.open;
      toggle.textContent = p.open ? 'Hide translation' : 'Show translation';
    });
    box.append(toggle, tr);
  }

  const el = qCard(null, box, h('p', { class: 'meaning ch-meaning' }, sub.q || sub.question || ''), choice.el);
  return {
    el,
    ready: () => !!choice.selected,
    key: (n) => choice.pick(choice.byIndex(n - 1)),
    grade() {
      const ok = choice.selected === answerId;
      choice.lock();
      return { ok, detail: ok ? null : h('div', { class: 'ch-detail' }, h('span', { class: 'ch-detail-meaning' }, optText(choice.answer()))) };
    },
  };
}

/* ---------- ?demo=1 ----------
   One of every question type, in memory, so the session can be driven (and
   screenshotted) before /api/challenge exists. Never POSTs, never saves. */
function demoChallenge(opts) {
  const q = [
    { type: 'mc-meaning', wordId: 'w1', prompt: { hanzi: '謝謝', reading: 'ㄒㄧㄝˋ ˙ㄒㄧㄝ' }, options: [{ id: 'a', text: 'thank you' }, { id: 'b', text: 'goodbye' }, { id: 'c', text: 'sorry' }, { id: 'd', text: 'excuse me' }], answerId: 'a' },
    { type: 'mc-hanzi', wordId: 'w2', prompt: { meaning: 'school' }, options: [{ id: 'a', hanzi: '學校', reading: 'ㄒㄩㄝˊ ㄒㄧㄠˋ' }, { id: 'b', hanzi: '朋友', reading: 'ㄆㄥˊ ㄧㄡˇ' }, { id: 'c', hanzi: '喝茶', reading: 'ㄏㄜ ㄔㄚˊ' }, { id: 'd', hanzi: '老師', reading: 'ㄌㄠˇ ㄕ' }], answerId: 'a' },
    { type: 'type-pinyin', wordId: 'w3', prompt: { hanzi: '朋友', meaning: 'friend' }, answer: { pinyin: 'péng yǒu', zhuyin: 'ㄆㄥˊ ㄧㄡˇ' } },
    { type: 'match', pairs: [{ id: 'p1', hanzi: '謝謝', meaning: 'thank you', wordId: 'w1' }, { id: 'p2', hanzi: '學校', meaning: 'school', wordId: 'w2' }, { id: 'p3', hanzi: '朋友', meaning: 'friend', wordId: 'w3' }, { id: 'p4', hanzi: '喝茶', meaning: 'to drink tea', wordId: 'w4' }] },
    { type: 'order', wordId: 'w4', prompt: { translation: 'I like drinking tea.' }, tiles: [{ id: 't3', text: '喝' }, { id: 't1', text: '我' }, { id: 't4', text: '茶' }, { id: 't2', text: '喜歡' }], answer: ['t1', 't2', 't3', 't4'] },
    { type: 'cloze', wordId: 'w1', prompt: { sentence: '▢你的幫忙。', translation: 'Thanks for your help.' }, options: [{ id: 'a', hanzi: '謝謝' }, { id: 'b', hanzi: '再見' }, { id: 'c', hanzi: '請問' }, { id: 'd', hanzi: '對不起' }], answerId: 'a' },
  ];
  if (tts.available) {
    q.splice(2, 0, { type: 'listen', wordId: 'w2', prompt: { tts: '學校' }, options: [{ id: 'a', hanzi: '學校', reading: 'ㄒㄩㄝˊ ㄒㄧㄠˋ' }, { id: 'b', hanzi: '朋友', reading: 'ㄆㄥˊ ㄧㄡˇ' }, { id: 'c', hanzi: '謝謝', reading: 'ㄒㄧㄝˋ ˙ㄒㄧㄝ' }, { id: 'd', hanzi: '喝茶', reading: 'ㄏㄜ ㄔㄚˊ' }], answerId: 'a' });
  }
  if (opts?.reading) {
    q.push({
      type: 'reading', title: 'A morning at school',
      passage: { zh: '我早上七點去學校。我的朋友在門口等我。我們一起喝茶。', pinyin: 'wǒ zǎo shàng qī diǎn qù xué xiào', translation: 'I go to school at seven in the morning. My friend waits for me at the gate. We drink tea together.' },
      questions: [
        { q: 'What time does the writer go to school?', options: ['Seven', 'Eight', 'Nine', 'Ten'], answerIndex: 0 },
        { q: 'Where does the friend wait?', options: ['At the gate', 'In class', 'At home', 'At a tea shop'], answerIndex: 0 },
      ],
    });
  }
  return { id: 'demo-challenge', questions: q.slice(0, Math.max(4, Number(opts?.size) || 10)) };
}

function unmount() {
  token += 1;
  clearTimers();
  tts.stop();
  try { live?.close(); } catch { /* the layer is already gone */ }
  live = null;
}

export default { id: 'challenge', title: 'Challenge', render, unmount };
