/* challenge.js — the Duolingo-style mixed quiz (#/challenge).
     LANDING  a Mac window: scope, size, which question types, and (with an
              API key) an AI-written reading passage. One primary action.
     SESSION  the full-screen layer: one question at a time, an answer that
              stays local until "Check", then the feedback banner from ui.js.

   Every question type answers the same tiny interface so the session loop
   never knows what it is showing:
     { el, auto?, onShow?(), ready(), grade() -> {ok, title, detail}, key?(n) }
   `auto` marks a question that settles itself (Match pairs) — it has no Check.
   `self` marks one the learner grades themselves (Say it): it brings its own
   footer (footer()), takes Enter through enter(), settles through
   io.settle(result), and destroy() lets go of what it holds (the microphone).

   A reading passage arrives as ONE question carrying several sub-questions;
   normalise() flattens those into separate screens, because "each counts as a
   question" for the progress bar and the score.

   Questions follow the learner's goals (§8.3, §8.4): the landing offers the types
   that fit their focus first, and every word is shown the way they read Chinese,
   so a speaking learner sees readings where a character learner sees 字. */

import { api } from '../api.js';
import { settings, stats, setStats, refreshStats } from '../state.js';
import { navigate } from '../router.js';
import { createBird } from '../bird.js';
import { hanziEl, wordHero, wordLine, exampleEl } from '../hanzi.js';
import { recordControl, recognition, listenOnce, hanziMatch } from '../speech.js';
import { pinyinMatches, normalizePinyin, pinyinToZhuyin, hanziChars } from '/shared/zhuyin.js';
import { CHALLENGE_TYPES, recommendedChallengeTypes } from '/shared/goals.js';
import {
  h, toast, confirmWindow, emptyState, busy, celebrate, tts, speakButton, pixelIcon,
  fmt, readingFor, readingEl, openSession, feedback, setTitle, profile, hanziMode,
} from '../ui.js';

/* The question types come from shared/goals.js, the list the server builds
   from. The ones in TTS_TYPES need a speech synthesiser to exist at all: their
   question IS a sound. (Build the sentence and Say it only use the voice as help.) */
const TTS_TYPES = new Set(['listen', 'listen-meaning', 'tones']);
function offerable() { return CHALLENGE_TYPES.filter((t) => !TTS_TYPES.has(t.id) || tts.available); }
const FITS_TAG = { characters: 'Characters', speaking: 'Speaking', both: 'Mixed' };

const BOPOMOFO = /[ㄅ-ㄯㆠ-ㆿ]/;   // is that reading 注音 or pinyin?

/* ---------- module state (one view instance at a time) ---------- */
let token = 0;
let live = null;
const timers = new Set();
function later(fn, ms) { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; }
function clearTimers() { for (const t of timers) clearTimeout(t); timers.clear(); }

/* iOS Safari ignores speechSynthesis.speak() until the page has spoken once from
   a tap. The first question's audio plays after the build request, far from any
   tap, so a silent utterance inside the Start tap unlocks the voice for the run. */
function unlockSpeech() {
  if (!tts.available) return;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    window.speechSynthesis.speak(u);
  } catch { /* nothing to unlock */ }
}

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

/* 注音 for a pinyin string, or '' when it does not convert cleanly (a name, a typo). */
function safeZhuyin(pinyin) {
  try {
    const z = pinyinToZhuyin(String(pinyin || ''));
    return BOPOMOFO.test(z) && !/[a-z]/i.test(z) ? z : '';
  } catch { return ''; }
}

/* wordish() plus the reading a question left out, so readingFor() can honour a
   注音 learner's script even where the server only sent pinyin (tones). */
function withReadings(p = {}) {
  const w = wordish(p);
  if (!w.zhuyin && w.pinyin) w.zhuyin = safeZhuyin(w.pinyin);
  return w;
}

/* A reading as the learner reads it: the primary script, and the other one too
   when their script is "both". */
function readingNodes(w) {
  const r = readingFor(w);
  const mk = (x, cls = '') => h('span', { class: `reading reading--${x.kind}${cls}`, lang: x.kind === 'zhuyin' ? 'zh-Hant' : undefined }, x.text);
  const out = [];
  if (r.primary) out.push(mk(r.primary));
  if (r.secondary && profile().script === 'both') out.push(mk(r.secondary, ' ch-reading-second'));
  return out;
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
function optText(o) { return o?.text ?? o?.meaning ?? o?.label ?? o?.hanzi ?? o?.pinyin ?? ''; }

/* ---------- the view ---------- */
async function render(root, params) {
  const my = ++token;
  setTitle('Challenge');
  const lessonId = params?.query?.lesson || '';
  const me = profile();
  const recommended = new Set(recommendedChallengeTypes(me.focus));
  const ctx = {
    root, my, lessonId,
    demo: params?.query?.demo || '',          // '1' | 'few' (empty state) | 'ai' (reading)
    scope: lessonId ? 'lesson' : 'all',
    pickedLesson: lessonId,
    size: 10,
    focus: me.focus,
    recommended,                              // the types that fit the learner's goals
    types: new Set(offerable().filter((t) => recommended.has(t.id)).map((t) => t.id)),
    showAll: false,                           // "Show all types" is open
    reading: false,
    lessons: [],
    leaving: false,
  };
  if (!ctx.types.size) ctx.types = new Set(offerable().map((t) => t.id));

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
  if (ctx.focus !== 'balanced') {
    out.push(h('p', { class: 'help ch-types-help' }, ctx.focus === 'speaking' ? 'Chosen for speaking and listening.' : 'Chosen for reading and writing characters.'));
  }
  out.push(typesBlock(ctx));

  // The AI reading needs an AI to write it: an OpenRouter key or the Claude plan.
  // `?demo=ai` pretends there is one so the passage question can be exercised without one.
  if (settings?.ai?.ready || ctx.demo === 'ai') {
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

/* The type checklist. The types that fit the learner's focus are listed; the
   rest wait behind "Show all types", each tagged with who it is for. A type the
   learner ticked stays visible when the list folds, so nothing is picked unseen. */
function typesBlock(ctx) {
  const wrap = h('div', { class: 'ch-types-wrap' });
  const paint = () => {
    const all = offerable();
    const extras = all.filter((t) => !ctx.recommended.has(t.id));
    const visible = all.filter((t) => ctx.recommended.has(t.id) || ctx.showAll || ctx.types.has(t.id));
    const list = h('div', { class: 'ch-types' });
    for (const t of visible) {
      const input = h('input', { type: 'checkbox', checked: ctx.types.has(t.id) });
      input.addEventListener('change', () => {
        if (input.checked) ctx.types.add(t.id);
        else if (ctx.types.size <= 1) { input.checked = true; toast('Keep at least one question type.', ''); }
        else ctx.types.delete(t.id);
      });
      list.append(h('label', { class: 'check ch-type' }, input,
        h('span', { class: 'grow' }, t.label),
        ctx.recommended.has(t.id) ? null : h('span', { class: 'pl-tag' }, FITS_TAG[t.fits] || t.fits)));
    }
    const kids = [list];
    const folded = extras.filter((t) => !visible.includes(t)).length;
    if (extras.length && (ctx.showAll || folded)) {
      kids.push(h('button', {
        class: 'btn btn--quiet ch-more', type: 'button', 'aria-expanded': ctx.showAll ? 'true' : 'false',
        onClick: () => { ctx.showAll = !ctx.showAll; paint(); },
      }, pixelIcon(ctx.showAll ? 'up' : 'down', 2), ctx.showAll ? 'Show fewer types' : `Show all types (${folded} more)`));
    }
    wrap.replaceChildren(...kids);
  };
  paint();
  return wrap;
}

/* ---------- build ---------- */
async function start(ctx) {
  unlockSpeech();                                     // inside the tap: see unlockSpeech()
  const lessonId = ctx.scope === 'lesson' ? (ctx.lessonId || ctx.pickedLesson || '') : '';
  // In catalogue order, so the request lists the types the way the landing does.
  const types = offerable().map((t) => t.id).filter((id) => ctx.types.has(id));
  const opts = { size: ctx.size, lessonId: lessonId || null, types, reading: !!ctx.reading, focus: ctx.focus };

  const session = openSession({
    title: 'Challenge',
    onClose: () => {
      live = null;
      session._cleanup?.();                           // the run loop's key listener and microphone
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
        out.push({ type: 'reading', q: sub, passage, topIndex, wordId: null, recap: { text: sub.q || sub.question || passage.title } });
      }
      continue;
    }
    out.push({ type: q.type, q, topIndex, wordId: q.wordId || null, recap: recapFor(q) });
  }
  return out;
}

/* What the recap row says about a question: the word (drawn by wordLine, so it
   follows the display rules) and its meaning, or a sentence, or a count. */
function recapFor(q) {
  const p = q.prompt || {};
  const answer = normOptions(q).opts.find((o) => o.id === q.answerId) || null;
  switch (q.type) {
    case 'match': return { text: `${(q.pairs || []).length} pairs` };
    case 'order': case 'order-pinyin': return { text: p.translation || 'Build the sentence' };
    case 'cloze': return p.translation && hanziMode() !== 'full' ? { text: p.translation } : { text: p.sentence || p.translation || '', lang: p.sentence ? 'zh-Hant' : null };
    case 'mc-meaning': case 'listen-meaning': return { word: withReadings(p), meaning: optText(answer) };
    case 'mc-hanzi': case 'listen': return { word: withReadings(answer || { hanzi: p.tts }), meaning: p.meaning || '' };
    case 'type-pinyin': return { word: withReadings({ hanzi: p.hanzi, ...(q.answer || {}) }), meaning: p.meaning || '' };
    case 'mc-pinyin': case 'tones': return { word: withReadings({ hanzi: p.hanzi, pinyin: answer?.pinyin, zhuyin: answer?.zhuyin }), meaning: p.meaning || '' };
    case 'speak': return { word: withReadings(q.answer || {}), meaning: p.meaning || '' };
    default: return { text: p.meaning || p.translation || q.type || 'Question' };
  }
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
  // X button, Escape and the end screen all unbind the keyboard (and release a
  // Say-it question's microphone).
  session._cleanup = () => { stopKeys(); dropQuestion(); };

  function onKey(e) {
    if (ended || document.querySelector('.scrim')) return;
    if (!session.banner.hidden) return;                 // the feedback banner owns Enter
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (e.key === 'Enter' && !typing) {
      if (document.activeElement?.tagName === 'BUTTON') return;
      e.preventDefault();
      if (current?.enter) current.enter(); else check();
      return;
    }
    if (!typing && current?.key && /^[1-4]$/.test(e.key)) { e.preventDefault(); current.key(Number(e.key)); }
  }

  const io = {
    onChange: () => { if (checkBtn) checkBtn.disabled = !current || !current.ready(); },
    check: () => check(),
    done: () => check(),
    settle: (res) => check(res),
    setFooter: (...nodes) => { checkBtn = null; session.footer.replaceChildren(birdSlot, ...nodes); },
    scrollTo: (el) => later(() => bringIntoView(el), 40),
  };

  /* On a short phone a revealed answer can land below the fold. Scroll just
     enough to show it, never past its top. */
  function bringIntoView(el) {
    if (!el?.isConnected) return;
    const box = session.body.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const overflow = r.bottom - box.bottom + 12;
    if (overflow <= 0) return;
    session.body.scrollBy({ top: Math.min(overflow, r.top - box.top - 8), behavior: 'smooth' });
  }

  function dropQuestion() {
    try { current?.destroy?.(); } catch { /* already released */ }
  }

  function show() {
    if (i >= flat.length) { end(); return; }
    dropQuestion();
    const item = flat[i];
    qAt = performance.now();
    bird.setMood('idle');
    session.setProgress(answered, flat.length);
    current = buildQuestion(item, io);
    session.body.replaceChildren(current.el);
    session.body.scrollTop = 0;

    if (current.self) {
      io.setFooter(...current.footer());
    } else if (current.auto) {
      checkBtn = null;
      session.footer.replaceChildren(birdSlot, h('p', { class: 'ch-hint' }, current.hint || 'Tap a pair'));
    } else {
      checkBtn = h('button', { class: 'btn btn--primary btn--lg', type: 'button', disabled: true, onClick: () => check() }, 'Check');
      session.footer.replaceChildren(birdSlot, checkBtn);
      io.onChange();
    }
    current.onShow?.();
  }

  /* `forced` is a result a self-graded question hands over (io.settle); every
     other question is graded here, and only once it is ready. */
  function check(forced = null) {
    if (!current || current.settled || ended) return;
    if (!forced && (current.self || (!current.auto && !current.ready()))) return;
    current.settled = true;
    let res;
    try { res = forced || current.grade(); } catch (e) { res = { ok: false, title: 'Something went wrong', detail: e.message }; }
    const ms = Math.max(0, Math.round(performance.now() - qAt));
    const item = flat[i];
    answered += 1;
    if (res.ok) score += 1;
    answers.push({ index: i, wordId: item.wordId || null, correct: !!res.ok, ms });
    recap.push({ ...item.recap, correct: !!res.ok });
    session.setProgress(answered, flat.length);
    bird.setMood(res.ok ? 'happy' : 'sad');
    if (checkBtn) checkBtn.disabled = true;
    for (const b of session.footer.querySelectorAll('button')) b.disabled = true;
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
    dropQuestion();
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
      const hasWord = r.word && (r.word.hanzi || readingFor(r.word).primary);
      const main = hasWord
        ? h('span', { class: 'grow ch-recap-main' }, wordLine(r.word), r.meaning ? h('span', { class: 'ch-recap-meaning' }, r.meaning) : null)
        : h('span', { class: `grow ellipsis${r.lang ? ' hz hz--sm' : ''}`, lang: r.lang || undefined }, r.text || '—');
      rows.append(h('div', { class: `list-row ${r.correct ? 'is-ok' : 'is-bad'}` }, main, pixelIcon(r.correct ? 'check' : 'x', 2)));
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

/* A multiple-choice list. Rows for text answers, a 2-up grid for hanzi ones,
   and `render` for rows whose answer is not plain text (a reading). */
function makeChoice({ opts, answerId, grid = false, onChange = null, render = null }) {
  let sel = null, locked = false;
  const btns = new Map();
  const box = h('div', { class: grid ? 'options options--grid' : 'options' });
  opts.forEach((o, n) => {
    const b = h('button', { class: 'option', type: 'button', onClick: () => pick(o.id) });
    if (render) {
      b.classList.add('option--reading');
      b.append(h('span', { class: 'option-key' }, String(n + 1)), render(o));
    } else if (grid) {
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
function readingPair(answer = {}, { big = false } = {}) {
  const row = h('div', { class: `row ch-detail-readings${big ? ' ch-detail-readings--big' : ''}` });
  if (answer.pinyin) row.append(h('span', { class: 'reading reading--pinyin' }, answer.pinyin));
  if (answer.pinyin && answer.zhuyin) row.append(h('span', { class: 'faint' }, '·'));
  if (answer.zhuyin) row.append(h('span', { class: 'reading reading--zhuyin', lang: 'zh-Hant' }, answer.zhuyin));
  return row.childNodes.length ? row : null;
}

/* The banner's "here is what it was", by the display rules: the ruby hanzi and
   both readings in full mode (or in a character drill, `drill`), otherwise the
   reading first, then the meaning, then the characters small or not at all. */
function wordDetail({ hanzi, zhuyin, pinyin, reading, meaning }, { drill = false } = {}) {
  const w = withReadings({ hanzi, zhuyin, pinyin, reading });
  const mode = hanziMode();
  const box = h('div', { class: 'ch-detail' });
  if (drill || mode === 'full' || !readingFor(w).primary) {
    if (w.hanzi) box.append(hanziEl(w, { size: 'md' }));
    const r = readingEl(w, { both: true });
    if (r) box.append(r);
    if (meaning) box.append(h('span', { class: 'ch-detail-meaning' }, meaning));
    return box;
  }
  box.append(wordHero(w, { size: 'md', align: 'left', mode: 'hidden' }));
  if (meaning) box.append(h('span', { class: 'ch-detail-meaning' }, meaning));
  if (mode === 'small' && w.hanzi) box.append(h('span', { class: 'ch-hanzi-note', lang: 'zh-Hant' }, w.hanzi));
  return box;
}

/* A whole sentence in the banner, through hanzi.js so it follows the rules too. */
function sentenceDetail({ zh, pinyin, translation }) {
  const ex = exampleEl({ zh: zh || '', pinyin: pinyin || '', zhuyin: safeZhuyin(pinyin), translation: translation || '' });
  return ex ? h('div', { class: 'ch-detail ch-detail--sentence' }, ex) : null;
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

/* Listening questions: the play button IS the question, with a slower replay.
   The slow button is quiet ink: the body's one accent is the picked answer. */
function listenPad(text) {
  return h('div', { class: 'ch-listen' },
    speakButton(text, { size: 'lg', label: 'Play again' }),
    h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onClick: () => tts.speak(text, { rate: 0.6 }) }, pixelIcon('speaker', 2), 'Play slower'));
}

/* The answer line above a bank of tiles. Placement is tracked by SLOT, not by
   id: a sentence can repeat a character or a syllable. */
function tileBoard(tiles, { lang = undefined, label = (t) => t.text, onChange }) {
  let placed = [];
  const ansRow = h('div', { class: 'tile-answer' });
  const bank = h('div', { class: 'tile-bank' });
  const bankBtns = tiles.map((t, n) => h('button', {
    class: 'tile', type: 'button', lang,
    onClick: () => { if (!placed.includes(n)) { placed.push(n); repaint(); } },
  }, label(t)));
  bank.append(...bankBtns);
  function repaint() {
    ansRow.replaceChildren(...placed.map((n) => h('button', {
      class: 'tile', type: 'button', lang,
      onClick: () => { placed = placed.filter((x) => x !== n); repaint(); },
    }, label(tiles[n]))));
    bankBtns.forEach((b, n) => b.classList.toggle('is-used', placed.includes(n)));
    onChange();
  }
  repaint();
  return {
    ansRow,
    bank,
    get placed() { return placed; },
    lock(ok) {
      for (const b of bankBtns) b.disabled = true;
      for (const b of ansRow.children) b.disabled = true;
      ansRow.classList.add(ok ? 'is-ok' : 'is-bad');
    },
  };
}
function normTiles(raw) {
  return (Array.isArray(raw) ? raw : []).map((t, n) => (t && typeof t === 'object' ? { id: t.id ?? String(n), text: t.text ?? '' } : { id: String(n), text: String(t ?? '') }));
}

/* speech.js gives the record control no stop(); its own button stops a take and
   keeps it, so press that whenever the microphone or the speaker is needed. */
function stopRecording(rec) {
  const btn = rec?.el?.querySelector?.('.rec-btn.is-recording');
  if (btn) btn.click();
}

/* "Check me" (§8.4): recognition listens once and says whether it heard the
   word. It only ADVISES: its verdict may preselect a button after the reveal,
   never decide, because it returns characters, not a teacher's ear. */
function checkMe({ expected, rec, alive, onVerdict }) {
  if (!recognition.supported || !window.isSecureContext || !hanziChars(expected).length) return null;
  const label = h('span', null, 'Check me');
  const btn = h('button', { class: 'btn ch-check', type: 'button' }, pixelIcon('check', 2), label);
  const status = h('p', { class: 'ch-heard', role: 'status', 'aria-live': 'polite', hidden: true });
  const state = { listening: false };
  const say = (cls, ...kids) => { status.className = `ch-heard${cls ? ' ' + cls : ''}`; status.replaceChildren(...kids); status.hidden = false; };
  btn.addEventListener('click', () => {
    if (state.listening) return;
    stopRecording(rec);                      // both want the microphone; the take is kept
    state.listening = true;
    btn.disabled = true;
    label.textContent = 'Listening…';
    say('', 'Say it now.');
    // listenOnce() starts the recogniser synchronously, inside this tap: iOS
    // Safari only opens the microphone from a user gesture.
    listenOnce({ lang: 'zh-TW', timeoutMs: 7000 })
      .then((res) => {
        if (!alive()) return;
        const heard = [res?.text, ...(res?.alternatives || []).map((a) => a?.text)].filter(Boolean);
        const best = heard.reduce((m, t) => Math.max(m, hanziMatch(t, expected)), 0);
        if (best >= 0.8) { say('is-ok', pixelIcon('check', 2), 'Plumi heard it right'); onVerdict(true); }
        else if (heard.length) { say('', 'Plumi heard ', h('span', { class: 'ch-heard-zh', lang: 'zh-Hant' }, heard[0]), '. Listen, then try again.'); onVerdict(false); }
        else say('', 'Plumi did not hear anything.');
      })
      .catch((err) => { if (alive()) say('', err?.message || 'Plumi could not listen.'); })
      .finally(() => {
        state.listening = false;
        if (!alive()) return;
        btn.disabled = false;
        label.textContent = 'Check again';
      });
  });
  return { btn, status, state };
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
    case 'listen-meaning': return qListenMeaning(item, io);
    case 'mc-pinyin': return qMcPinyin(item, io);
    case 'tones': return qTones(item, io);
    case 'order-pinyin': return qOrderPinyin(item, io);
    case 'speak': return qSpeak(item, io);
    case 'mc-meaning':
    default: return qMcMeaning(item, io);
  }
}

function qMcMeaning(item, io) {
  const q = item.q;
  const w = withReadings(q.prompt || {});
  const { opts, answerId } = normOptions(q);
  const choice = makeChoice({ opts, answerId, onChange: io.onChange });
  // wordHero is the ruby hanzi in full mode and the reading as the hero otherwise,
  // so a speaking learner is asked about the word as they would say it (§8.4).
  const el = qCard('What does it mean?',
    h('div', { class: 'ch-prompt' }, wordHero(w, { size: 'xl' }), tts.available ? speakButton(w.hanzi, { label: 'Play the word' }) : null),
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
      return { ok, detail: ok ? null : wordDetail({ ...(choice.answer() || {}), meaning }, { drill: true }) };
    },
  };
}

function qListen(item, io) {
  const q = item.q;
  const text = q.prompt?.tts || q.prompt?.hanzi || '';
  const { opts, answerId } = normOptions(q);
  const choice = makeChoice({ opts, answerId, grid: true, onChange: io.onChange });
  const el = qCard('What did Plumi say?', listenPad(text), choice.el);
  return {
    el,
    onShow: () => later(() => tts.speak(text), 260),
    ready: () => !!choice.selected,
    key: (n) => choice.pick(choice.byIndex(n - 1)),
    grade() {
      const ok = choice.selected === answerId;
      choice.lock();
      return { ok, detail: ok ? null : wordDetail({ ...(choice.answer() || {}), hanzi: (choice.answer() || {}).hanzi || text }, { drill: true }) };
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

/* Type the reading. A character learner reads it off the bare characters; a
   speaking learner is given the meaning (characters small, or none) and types
   how the word is SAID (§8.4). */
function qTypePinyin(item, io) {
  const q = item.q;
  const w = wordish(q.prompt || {});
  const answer = q.answer || {};
  const meaning = q.prompt?.meaning || '';
  const mode = hanziMode();
  const byMeaning = mode !== 'full' && !!meaning;
  const input = h('input', {
    class: 'input input--big ch-input', type: 'text', placeholder: profile().script === 'zhuyin' ? '注音 or pinyin' : 'pinyin or 注音',
    autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': 'Type the reading',
  });
  input.addEventListener('input', () => io.onChange());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); io.check(); } });
  const prompt = byMeaning
    ? h('div', { class: 'ch-prompt' },
      h('p', { class: 'ch-meaning-hero' }, meaning),
      mode === 'small' && w.hanzi ? h('div', { class: 'ch-hanzi-note', lang: 'zh-Hant' }, w.hanzi) : null)
    : h('div', { class: 'ch-prompt' }, hanziEl(w, { reading: 'none', size: 'xl' }));
  const el = qCard(byMeaning ? 'Type how you say it' : 'How do you read it?',
    prompt,
    !byMeaning && meaning ? h('p', { class: 'meaning ch-meaning' }, meaning) : null,
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
      if (byMeaning && tts.available && w.hanzi) tts.speak(w.hanzi);   // hear what was typed
      // A typing question shows the exact reading either way: right or wrong,
      // that spelling is the thing being learned.
      if (byMeaning) {
        return {
          ok,
          detail: h('div', { class: 'ch-detail' },
            readingPair(answer, { big: true }),
            h('span', { class: 'ch-detail-meaning' }, meaning),
            mode === 'small' && w.hanzi ? h('span', { class: 'ch-hanzi-note', lang: 'zh-Hant' }, w.hanzi) : null),
        };
      }
      return {
        ok,
        detail: h('div', { class: 'ch-detail' },
          hanziEl({ hanzi: w.hanzi, pinyin: answer.pinyin || '', zhuyin: answer.zhuyin || '' }, { size: 'md' }),
          readingPair(answer),
          meaning ? h('span', { class: 'ch-detail-meaning' }, meaning) : null),
      };
    },
  };
}

/* Match pairs settles itself: the last correct pair is the answer. A speaking
   learner matches readings with meanings, a character learner 字 with meanings. */
function qMatch(item, io) {
  const pairs = (item.q.pairs || []).filter((p) => p && p.hanzi).map((p, n) => ({ ...p, id: p.id ?? String(n) }));
  const byReading = hanziMode() !== 'full';
  const leftFace = (p) => {
    const r = byReading ? readingFor(withReadings(p)).primary : null;
    if (!r) return { text: p.hanzi, cls: '', lang: 'zh-Hant' };
    return { text: r.text, cls: r.kind === 'zhuyin' ? ' is-zhuyin' : ' is-pinyin', lang: r.kind === 'zhuyin' ? 'zh-Hant' : undefined };
  };
  const lBtns = new Map(), rBtns = new Map();
  let selL = null, selR = null, misses = 0, locked = 0, flashing = false;

  const col = (side, items) => {
    const box = h('div', { class: `ch-match-col ch-match-col--${side}` });
    for (const p of items) {
      const face = side === 'l' ? leftFace(p) : null;
      const b = h('button', {
        class: `tile ch-tile ch-tile--${side}${face ? face.cls : ''}`, type: 'button',
        lang: face ? face.lang : undefined,
        onClick: () => select(side, p.id),
      }, face ? face.text : (p.meaning || ''));
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
      // Say each word as it locks in: a match game becomes a listening one too.
      const pair = pairs.find((p) => p.id === selL);
      if (tts.available && pair?.hanzi) tts.speak(pair.hanzi);
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
    hint: byReading ? 'Tap a reading, then its meaning' : 'Tap a word, then its meaning',
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
  const tiles = normTiles(q.tiles);
  const want = (Array.isArray(q.answer) ? q.answer : []).map(String);
  const board = tileBoard(tiles, { lang: 'zh-Hant', onChange: io.onChange });
  const el = qCard('Build the sentence',
    q.prompt?.translation ? h('p', { class: 'meaning ch-meaning' }, q.prompt.translation) : null,
    h('div', { class: 'ch-order' }, board.ansRow, board.bank));
  return {
    el,
    ready: () => board.placed.length > 0,
    grade() {
      // Compared as TEXT: swapping the two 謝 of 謝謝 leaves the sentence as it was.
      const sentence = want.map((id) => tiles.find((t) => t.id === id)?.text || '').join('');
      const ok = want.length > 0 && board.placed.map((n) => tiles[n].text).join('') === sentence;
      board.lock(ok);
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

/* Hear the word, pick its meaning. Right or wrong, the banner shows what was
   said: hearing a word and then seeing its reading is how the sound sticks. */
function qListenMeaning(item, io) {
  const q = item.q;
  const text = q.prompt?.tts || q.prompt?.hanzi || '';
  const w = withReadings(q.prompt || {});
  const { opts, answerId } = normOptions(q);
  const choice = makeChoice({ opts, answerId, onChange: io.onChange });
  const el = qCard('What does it mean?', listenPad(text), choice.el);
  return {
    el,
    onShow: () => later(() => tts.speak(text), 260),
    ready: () => !!choice.selected,
    key: (n) => choice.pick(choice.byIndex(n - 1)),
    grade() {
      const ok = choice.selected === answerId;
      choice.lock();
      return { ok, detail: wordDetail({ ...w, meaning: optText(choice.answer()) }) };
    },
  };
}

/* Meaning → reading. One wrong answer is the same word with a tone off, so the
   options are drawn in the learner's script with room for the tone marks. */
function qMcPinyin(item, io) {
  const q = item.q;
  const meaning = q.prompt?.meaning || '';
  const hanzi = q.prompt?.hanzi || '';
  const { opts, answerId } = normOptions(q);
  const choice = makeChoice({
    opts, answerId, onChange: io.onChange,
    render: (o) => h('span', { class: 'grow ch-option-reading' }, ...readingNodes(withReadings(o))),
  });
  const el = qCard('How do you say it?', h('div', { class: 'ch-prompt' }, h('p', { class: 'ch-meaning-hero' }, meaning)), choice.el);
  return {
    el,
    ready: () => !!choice.selected,
    key: (n) => choice.pick(choice.byIndex(n - 1)),
    grade() {
      const ok = choice.selected === answerId;
      choice.lock();
      if (tts.available && hanzi) tts.speak(hanzi);      // the right answer, heard
      const a = choice.answer() || {};
      return { ok, detail: ok ? null : wordDetail({ hanzi, pinyin: a.pinyin, zhuyin: a.zhuyin, meaning }) };
    },
  };
}

/* Hear the word, see its letters without marks, pick the marks. Tones are the
   point, so every option leads with pinyin; a 注音 reader also gets the tone
   symbols they know underneath. */
function qTones(item, io) {
  const q = item.q;
  const p = q.prompt || {};
  const text = p.tts || p.hanzi || '';
  const { opts, answerId } = normOptions(q);
  const withZhuyin = profile().script !== 'pinyin';
  const choice = makeChoice({
    opts, answerId, onChange: io.onChange,
    render: (o) => {
      const zy = withZhuyin ? safeZhuyin(o.pinyin) : '';
      return h('span', { class: 'grow ch-option-reading' },
        h('span', { class: 'reading reading--pinyin ch-tone' }, o.pinyin || optText(o)),
        zy ? h('span', { class: 'reading reading--zhuyin ch-reading-second', lang: 'zh-Hant' }, zy) : null);
    },
  });
  const el = qCard('Which tones do you hear?',
    listenPad(text),
    h('div', { class: 'ch-bare' },
      h('span', { class: 'reading reading--pinyin ch-bare-text' }, p.bare || ''),
      p.meaning ? h('span', { class: 'ch-bare-meaning' }, p.meaning) : null),
    choice.el);
  return {
    el,
    onShow: () => later(() => tts.speak(text), 260),
    ready: () => !!choice.selected,
    key: (n) => choice.pick(choice.byIndex(n - 1)),
    grade() {
      const ok = choice.selected === answerId;
      choice.lock();
      if (tts.available && text) tts.speak(text);        // hear it again with the marks in view
      const a = choice.answer() || {};
      return { ok, detail: ok ? null : wordDetail({ hanzi: p.hanzi, pinyin: a.pinyin, meaning: p.meaning }) };
    },
  };
}

/* Build the sentence from its syllables. A 注音 reader gets 注音 tiles (the
   server sends pinyin). "Hear it" is a hint the learner chooses to take; the
   sentence plays by itself once the answer is checked. */
function qOrderPinyin(item, io) {
  const q = item.q;
  const tiles = normTiles(q.tiles);
  const want = (Array.isArray(q.answer) ? q.answer : []).map(String);
  const zhuyin = profile().script !== 'pinyin';
  const label = (t) => (zhuyin ? safeZhuyin(t.text) || t.text : t.text);
  const board = tileBoard(tiles, { lang: zhuyin ? 'zh-Hant' : undefined, label, onChange: io.onChange });
  const voice = q.prompt?.tts || q.full?.zh || '';
  const hear = tts.available && voice
    ? h('button', { class: 'btn btn--quiet ch-hear', type: 'button', onClick: () => tts.speak(voice) }, pixelIcon('speaker', 2), 'Hear it')
    : null;
  const el = qCard('Build the sentence',
    h('div', { class: 'ch-order-prompt' }, h('p', { class: 'meaning ch-meaning' }, q.prompt?.translation || ''), hear),
    h('div', { class: `ch-order ch-order--${zhuyin ? 'zhuyin' : 'pinyin'}` }, board.ansRow, board.bank));
  return {
    el,
    ready: () => board.placed.length > 0,
    grade() {
      // By text, like order: a repeated syllable (shuàn shuàn) can go either way.
      const sentence = want.map((id) => tiles.find((t) => t.id === id)?.text || '').join(' ');
      const ok = want.length > 0 && board.placed.map((n) => tiles[n].text).join(' ') === sentence;
      board.lock(ok);
      if (tts.available && voice) tts.speak(voice);
      const full = q.full || {};
      return { ok, detail: sentenceDetail({ zh: full.zh, pinyin: full.pinyin || sentence, translation: q.prompt?.translation }) };
    },
  };
}

/* Say it (§8.4). The meaning is the prompt; the learner records themselves and,
   where the browser can, lets recognition listen. "Reveal" shows the reading,
   plays the model and moves the take beside it; then the LEARNER judges. A
   recognition verdict only decides which judgement button is the primary one. */
function qSpeak(item, io) {
  const q = item.q;
  const p = q.prompt || {};
  const answer = withReadings(q.answer || {});
  const voice = q.answer?.tts || answer.hanzi;
  let revealed = false;
  let alive = true;
  let verdict = null;                        // recognition's suggestion: true | false | null
  let judge = null;                          // the two judgement buttons, once revealed

  const rec = recordControl({ label: 'Record yourself', maxMs: 8000 });
  const check = checkMe({ expected: answer.hanzi, rec, alive: () => alive, onVerdict: (ok) => { verdict = ok; paintJudge(); } });
  const tools = h('div', { class: 'ch-say-tools' }, rec.el);
  if (check) tools.append(check.btn, check.status);
  const answerBox = h('div', { class: 'ch-reveal', hidden: true });

  const el = qCard('Say it in Chinese',
    h('div', { class: 'ch-prompt' },
      h('p', { class: 'ch-meaning-hero' }, p.meaning || ''),
      p.context ? h('p', { class: 'ch-context' }, `“${p.context}”`) : null),
    // Without a microphone or recognition the exercise still stands: say it, reveal, judge.
    !rec.el.hidden || check ? tools : h('p', { class: 'ch-say-hint' }, 'Say it out loud, then reveal the answer.'),
    answerBox);

  function reveal() {
    if (revealed || !alive) return;
    revealed = true;
    stopRecording(rec);                      // the model voice must not land in the take
    const row = h('div', { class: 'ch-reveal-row' });
    if (tts.available && voice) row.append(h('button', { class: 'btn ch-listen-btn', type: 'button', onClick: () => tts.speak(voice) }, pixelIcon('speaker', 2), 'Listen'));
    // The same control, and so the same take, moves beside the model voice.
    if (!rec.el.hidden) row.append(rec.el);
    answerBox.replaceChildren(...[wordHero(answer, { size: 'xl' }), row.childNodes.length ? row : null].filter(Boolean));
    answerBox.hidden = false;
    // Spoken inside the tap (iOS wants the gesture), and not while recognition
    // still listens, or it would hear Plumi instead of the learner.
    if (tts.available && voice && !check?.state.listening) tts.speak(voice);
    const notQuite = h('button', { class: 'btn btn--lg', type: 'button', onClick: () => settle(false) }, 'Not quite');
    const saidIt = h('button', { class: 'btn btn--lg', type: 'button', onClick: () => settle(true) }, 'I said it right');
    judge = { notQuite, saidIt };
    paintJudge();
    // One shrinkable group, like the end screen's: two .btn--lg side by side
    // overflow a 375px footer otherwise.
    io.setFooter(h('div', { class: 'ch-judge-row' }, notQuite, saidIt));
    io.scrollTo(answerBox);
  }
  /* The terracotta goes to the suggested verdict: "I said it right" unless
     recognition heard something else. */
  function paintJudge() {
    if (!judge) return;
    const doubt = verdict === false;
    judge.saidIt.classList.toggle('btn--primary', !doubt);
    judge.notQuite.classList.toggle('btn--primary', doubt);
  }
  function settle(ok) {
    if (!alive || !revealed) return;
    io.settle({
      ok,
      title: ok ? 'Nicely said!' : 'Keep practising',
      detail: ok ? null : h('div', { class: 'ch-detail' }, wordHero(answer, { size: 'md', align: 'left' })),
    });
  }
  return {
    el,
    self: true,
    footer: () => [h('button', { class: 'btn btn--primary btn--lg', type: 'button', onClick: reveal }, 'Reveal')],
    enter: () => { if (!revealed) reveal(); else settle(verdict !== false); },
    key: (n) => { if (n === 1) settle(false); else if (n === 2) settle(true); },
    ready: () => revealed,
    grade: () => ({ ok: verdict === true }),
    destroy: () => { alive = false; rec.destroy(); },
  };
}

/* ---------- ?demo=1 ----------
   One of every question type, in memory, so the session can be driven (and
   screenshotted) before /api/challenge exists. Never POSTs, never saves.
   The landing's type choices filter it, like a real build. */
function demoChallenge(opts) {
  const q = [
    { type: 'mc-meaning', wordId: 'w1', prompt: { hanzi: '謝謝', reading: 'ㄒㄧㄝˋ ˙ㄒㄧㄝ', pinyin: 'xiè xie', zhuyin: 'ㄒㄧㄝˋ ˙ㄒㄧㄝ' }, options: [{ id: 'a', text: 'thank you' }, { id: 'b', text: 'goodbye' }, { id: 'c', text: 'sorry' }, { id: 'd', text: 'excuse me' }], answerId: 'a' },
    { type: 'listen-meaning', wordId: 'w2', prompt: { tts: '學校', pinyin: 'xué xiào', zhuyin: 'ㄒㄩㄝˊ ㄒㄧㄠˋ', hanzi: '學校' }, options: [{ id: 'a', text: 'friend' }, { id: 'b', text: 'school' }, { id: 'c', text: 'thank you' }, { id: 'd', text: 'to drink tea' }], answerId: 'b' },
    { type: 'mc-hanzi', wordId: 'w2', prompt: { meaning: 'school' }, options: [{ id: 'a', hanzi: '學校', reading: 'ㄒㄩㄝˊ ㄒㄧㄠˋ' }, { id: 'b', hanzi: '朋友', reading: 'ㄆㄥˊ ㄧㄡˇ' }, { id: 'c', hanzi: '喝茶', reading: 'ㄏㄜ ㄔㄚˊ' }, { id: 'd', hanzi: '老師', reading: 'ㄌㄠˇ ㄕ' }], answerId: 'a' },
    { type: 'listen', wordId: 'w2', prompt: { tts: '學校' }, options: [{ id: 'a', hanzi: '學校', reading: 'ㄒㄩㄝˊ ㄒㄧㄠˋ' }, { id: 'b', hanzi: '朋友', reading: 'ㄆㄥˊ ㄧㄡˇ' }, { id: 'c', hanzi: '謝謝', reading: 'ㄒㄧㄝˋ ˙ㄒㄧㄝ' }, { id: 'd', hanzi: '喝茶', reading: 'ㄏㄜ ㄔㄚˊ' }], answerId: 'a' },
    { type: 'match', pairs: [{ id: 'p1', hanzi: '謝謝', meaning: 'thank you', wordId: 'w1', pinyin: 'xiè xie', zhuyin: 'ㄒㄧㄝˋ ˙ㄒㄧㄝ' }, { id: 'p2', hanzi: '學校', meaning: 'school', wordId: 'w2', pinyin: 'xué xiào', zhuyin: 'ㄒㄩㄝˊ ㄒㄧㄠˋ' }, { id: 'p3', hanzi: '朋友', meaning: 'friend', wordId: 'w3', pinyin: 'péng yǒu', zhuyin: 'ㄆㄥˊ ㄧㄡˇ' }, { id: 'p4', hanzi: '喝茶', meaning: 'to drink tea', wordId: 'w4', pinyin: 'hē chá', zhuyin: 'ㄏㄜ ㄔㄚˊ' }] },
    { type: 'mc-pinyin', wordId: 'w3', prompt: { meaning: 'friend', hanzi: '朋友' }, options: [{ id: 'a', pinyin: 'pēng yǒu', zhuyin: 'ㄆㄥ ㄧㄡˇ' }, { id: 'b', pinyin: 'hē chá', zhuyin: 'ㄏㄜ ㄔㄚˊ' }, { id: 'c', pinyin: 'péng yǒu', zhuyin: 'ㄆㄥˊ ㄧㄡˇ' }, { id: 'd', pinyin: 'xué xiào', zhuyin: 'ㄒㄩㄝˊ ㄒㄧㄠˋ' }], answerId: 'c' },
    { type: 'tones', wordId: 'w1', prompt: { tts: '謝謝', bare: 'xie xie', meaning: 'thank you', hanzi: '謝謝' }, options: [{ id: 'a', pinyin: 'xiē xie' }, { id: 'b', pinyin: 'xiè xie' }, { id: 'c', pinyin: 'xié xie' }, { id: 'd', pinyin: 'xiě xie' }], answerId: 'b' },
    { type: 'order', wordId: 'w4', prompt: { translation: 'I like drinking tea.' }, tiles: [{ id: 't3', text: '喝' }, { id: 't1', text: '我' }, { id: 't4', text: '茶' }, { id: 't2', text: '喜歡' }], answer: ['t1', 't2', 't3', 't4'] },
    { type: 'order-pinyin', wordId: 'w4', prompt: { translation: 'I like drinking tea.', tts: '我喜歡喝茶。' }, tiles: [{ id: 't4', text: 'hē' }, { id: 't1', text: 'wǒ' }, { id: 't5', text: 'chá' }, { id: 't3', text: 'huān' }, { id: 't2', text: 'xǐ' }], answer: ['t1', 't2', 't3', 't4', 't5'], full: { zh: '我喜歡喝茶。', pinyin: 'wǒ xǐ huān hē chá' } },
    { type: 'cloze', wordId: 'w1', prompt: { sentence: '▢你的幫忙。', translation: 'Thanks for your help.' }, options: [{ id: 'a', hanzi: '謝謝' }, { id: 'b', hanzi: '再見' }, { id: 'c', hanzi: '請問' }, { id: 'd', hanzi: '對不起' }], answerId: 'a' },
    { type: 'type-pinyin', wordId: 'w3', prompt: { hanzi: '朋友', meaning: 'friend' }, answer: { pinyin: 'péng yǒu', zhuyin: 'ㄆㄥˊ ㄧㄡˇ' } },
    { type: 'speak', wordId: 'w2', prompt: { meaning: 'school', context: 'The school is over there.' }, answer: { pinyin: 'xué xiào', zhuyin: 'ㄒㄩㄝˊ ㄒㄧㄠˋ', hanzi: '學校', tts: '學校' } },
  ];
  const playable = q.filter((x) => !TTS_TYPES.has(x.type) || tts.available);
  const asked = Array.isArray(opts?.types) ? opts.types : [];
  const picked = asked.length ? playable.filter((x) => asked.includes(x.type)) : playable;
  const list = picked.length ? picked : playable;
  if (opts?.reading) {
    list.push({
      type: 'reading', title: 'A morning at school',
      passage: { zh: '我早上七點去學校。我的朋友在門口等我。我們一起喝茶。', pinyin: 'wǒ zǎo shàng qī diǎn qù xué xiào', translation: 'I go to school at seven in the morning. My friend waits for me at the gate. We drink tea together.' },
      questions: [
        { q: 'What time does the writer go to school?', options: ['Seven', 'Eight', 'Nine', 'Ten'], answerIndex: 0 },
        { q: 'Where does the friend wait?', options: ['At the gate', 'In class', 'At home', 'At a tea shop'], answerIndex: 0 },
      ],
    });
  }
  return { id: 'demo-challenge', questions: list.slice(0, Math.max(4, Number(opts?.size) || 10)) };
}

function unmount() {
  token += 1;
  clearTimers();
  tts.stop();
  try { live?.close(); } catch { /* the layer is already gone */ }
  live = null;
}

export default { id: 'challenge', title: 'Challenge', render, unmount };
