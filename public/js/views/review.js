/* review.js — the memo cards (#/review).
   Two screens in one module:
     LANDING  a Mac window in the normal view: what is due, which card
              templates to use this session, and the one primary action.
     SESSION  the full-screen layer from ui.js: one card at a time, front →
              "Show answer" → back → four grades, Plumi reacting in the footer.

   Grading is OPTIMISTIC: the next card appears at once and the POST flies in
   the background, because a learner tapping "Good" four times a second should
   never wait for the disk. A card graded Again comes back after three others
   (the server still schedules it; we only decide when it reappears on screen).

   Every request can 404 while the routes are being written: the landing must
   still paint, so failures become a toast plus a retry, never a console error. */

import { api } from '../api.js';
import { settings, stats, setStats, refreshStats } from '../state.js';
import { navigate } from '../router.js';
import { createBird } from '../bird.js';
import { hanziEl } from '../hanzi.js';
import { hanziChars } from '/shared/zhuyin.js';
import {
  h, toast, confirmWindow, emptyState, busy, celebrate, tts, speakButton, pixelIcon,
  fmt, readingFor, readingEl, openSession, markdownish, meter, bandChip, setTitle,
} from '../ui.js';

/* The four grades, in screen order. `key` indexes card.preview from the API
   (srs.preview), `g` is the number POST /api/review/grade wants. */
const GRADES = [
  { g: 0, key: 'again', label: 'Again', cls: 'btn--danger', kbd: '1' },
  { g: 1, key: 'hard', label: 'Hard', cls: '', kbd: '2' },
  { g: 2, key: 'good', label: 'Good', cls: 'btn--primary', kbd: '3' },
  { g: 3, key: 'easy', label: 'Easy', cls: 'btn--ok', kbd: '4' },
];

/* A local copy of the built-in templates (contract §3.4). Only a fallback:
   the queue response and settings both carry the real list, but either can be
   missing while the server is still coming up. */
const BUILTIN_TEMPLATES = [
  { id: 'recognition', name: 'Recognition', front: ['hanzi'], back: ['reading', 'meaning', 'example'], enabled: true },
  { id: 'production', name: 'Production', front: ['meaning'], back: ['hanzi', 'reading', 'example'], enabled: true },
  { id: 'sound', name: 'Sound', front: ['reading'], back: ['hanzi', 'meaning', 'example'], enabled: false },
  { id: 'listening', name: 'Listening', front: ['audio'], back: ['hanzi', 'reading', 'meaning'], enabled: false },
  { id: 'cloze', name: 'Fill the blank', front: ['cloze'], back: ['hanzi', 'reading', 'example'], enabled: false },
];
const RECOGNITION = BUILTIN_TEMPLATES[0];

/* Plumi's between-cards encouragement. Chinese first: the learner came here
   to read Chinese. */
const CHEERS = ['加油！', 'Nice streak', '很好！', 'Keep going', '你很棒！', 'Steady now'];

/* ---------- module state (one view instance at a time) ---------- */
let token = 0;              // bumps on render/unmount; stale async work checks it
let live = null;            // the open session, so unmount() can close it
const timers = new Set();

function later(fn, ms) {
  const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
  timers.add(t);
  return t;
}
function clearTimers() { for (const t of timers) clearTimeout(t); timers.clear(); }

/* ---------- queue fetching ---------- */
function queueUrl({ limit = 20, lessonId = '', newLimit = null, includeNew = null } = {}) {
  const p = new URLSearchParams();
  p.set('limit', String(limit));
  p.set('lessonId', lessonId || '');
  if (newLimit !== null) p.set('newLimit', String(newLimit));
  if (includeNew !== null) p.set('includeNew', includeNew ? '1' : '0');
  return `/api/review/queue?${p.toString()}`;
}

function templateList(data) {
  const fromQueue = (Array.isArray(data?.templates) ? data.templates : []).filter((t) => t && t.id);
  if (fromQueue.length) return fromQueue;
  const fromSettings = (Array.isArray(settings?.cardTemplates) ? settings.cardTemplates : []).filter((t) => t?.id && t.enabled);
  if (fromSettings.length) return fromSettings;
  return BUILTIN_TEMPLATES.filter((t) => t.enabled);
}

/* ---------- field renderers ----------
   A template is two lists of field names (contract §3.4). Each name knows how
   to draw itself on the front and on the back; unavailable fields return null
   and simply do not appear. */
function pickExample(word) {
  return (word?.examples || []).find((e) => e && e.zh) || null;
}
function clozeExample(word) {
  const hz = word?.hanzi || '';
  return (word?.examples || []).find((e) => e?.zh && hz && e.zh.includes(hz)) || null;
}

/* "我喜歡喝茶" + 喝茶 → 我喜歡▢. One blank for the whole word when it appears
   verbatim, otherwise one per character so the sentence keeps its shape. */
function blankNodes(text, hanzi) {
  const t = String(text || '');
  const word = hanzi && t.includes(hanzi) ? hanzi : null;
  if (!word) {
    const chars = new Set(hanziChars(hanzi || ''));
    return [...t].map((ch) => (chars.has(ch) ? h('span', { class: 'rv-blank' }, '▢') : ch));
  }
  const out = [];
  t.split(word).forEach((part, i) => {
    if (i) out.push(h('span', { class: 'rv-blank' }, '▢'));
    if (part) out.push(part);
  });
  return out;
}

function exampleEl(ex, { blankFor = null, speak = false } = {}) {
  const zh = h('div', { class: 'zh grow', lang: 'zh-Hant' }, ...(blankFor ? blankNodes(ex.zh, blankFor) : [ex.zh || '']));
  const box = h('div', { class: 'example rv-example' }, h('div', { class: 'row' }, zh, speak ? speakButton(ex.zh, { label: 'Play the sentence' }) : null));
  // On a blanked sentence the reading would hand over the answer.
  if (!blankFor) { const r = readingEl(ex); if (r) box.append(r); }
  if (ex.translation) box.append(h('div', { class: 'tr' }, ex.translation));
  return box;
}

function renderField(name, word, { side, tpl }) {
  switch (name) {
    case 'hanzi': {
      // Recognition asks for the reading, so the front must not print it.
      const hide = side === 'front' && (tpl.back || []).includes('reading');
      const el = hanziEl(word, { reading: hide ? 'none' : 'auto', size: 'xl' });
      if (hide) el.dataset.rvHidden = '1';
      return el;
    }
    case 'reading':
      return readingEl(word, { size: 'lg', both: side === 'back' });
    case 'meaning': {
      if (!word.meaning && !word.meaningNative) return null;
      const box = h('div', { class: 'rv-meaning' }, h('p', { class: 'meaning' }, word.meaning || word.meaningNative));
      if (side === 'back' && word.meaning && word.meaningNative) box.append(h('p', { class: 'small muted' }, word.meaningNative));
      return box;
    }
    case 'example': {
      const ex = pickExample(word);
      if (!ex) return null;
      return exampleEl(ex, { blankFor: side === 'front' ? word.hanzi : null, speak: side === 'back' });
    }
    case 'audio': {
      if (!tts.available) return null;
      return h('div', { class: 'rv-audio' },
        speakButton(word.hanzi, { size: 'lg', label: 'Play the word' }),
        h('span', { class: 'pl-eyebrow no-rule' }, 'Listen'));
    }
    case 'cloze': {
      const ex = clozeExample(word) || pickExample(word);
      if (!ex) return null;
      return h('div', { class: 'rv-cloze' },
        h('div', { class: 'hz hz--lg', lang: 'zh-Hant' }, ...blankNodes(ex.zh, word.hanzi)),
        ex.translation ? h('p', { class: 'small muted' }, ex.translation) : null);
    }
    case 'notes':
      return word.notes ? h('div', { class: 'card card--sunk rv-notes' }, markdownish(word.notes)) : null;
    case 'tags': {
      const tags = (word.tags || []).filter(Boolean);
      if (!tags.length) return null;
      return h('div', { class: 'row row--wrap rv-tags' }, ...tags.map((t) => h('span', { class: 'pl-tag' }, t)));
    }
    default:
      return null;
  }
}

/* Can this word carry this template's FRONT? A cloze needs an example holding
   the word; audio needs a speech synthesiser. */
function frontWorks(tpl, word) {
  for (const f of tpl.front || []) {
    if (f === 'hanzi' && !word.hanzi) return false;
    if (f === 'meaning' && !word.meaning && !word.meaningNative) return false;
    if (f === 'reading' && !readingFor(word).primary) return false;
    if (f === 'audio' && !tts.available) return false;
    if (f === 'example' && !pickExample(word)) return false;
    if (f === 'cloze' && !clozeExample(word)) return false;
    if (f === 'notes' && !word.notes) return false;
    if (f === 'tags' && !(word.tags || []).length) return false;
  }
  return true;
}

/* ---------- the view ---------- */
async function render(root, params) {
  const my = ++token;
  setTitle('Review');
  const ctx = {
    root,
    my,
    lessonId: params?.query?.lesson || '',
    demo: params?.query?.demo || '',          // '1' | 'empty' | 'zero' (see demoQueue)
    picked: null,           // Set<templateId>, kept across repaints
    templates: [],
    leaving: false,
  };
  await loadLanding(ctx);
}

async function loadLanding(ctx, opts = {}) {
  const { root } = ctx;
  root.replaceChildren(h('div', { class: 'rv-landing' }, shell(h('p', { class: 'muted' }, 'Looking at your queue…'), ctx)));
  let data = null;
  let error = null;
  try {
    data = ctx.demo ? demoQueue(ctx.demo) : await api.get(queueUrl({ limit: 20, lessonId: ctx.lessonId, ...opts }));
  } catch (e) {
    error = e;
  }
  if (ctx.my !== token || !root.isConnected) return;   // navigated away mid-flight
  if (error) toast(error.message, 'bad');
  paintLanding(ctx, data, error);
}

/* The landing's frame, so the loading, loaded and failed states share it. */
function shell(body, ctx, extraTitle = null) {
  return h('div', { class: 'pl-win rv-win' },
    h('div', { class: 'pl-titlebar' },
      h('span', { class: 'pl-title' }, 'Review'),
      h('span', { class: 'spacer' }),
      extraTitle),
    h('div', { class: 'win-body' }, body));
}

function paintLanding(ctx, data, error) {
  const counts = {
    due: Number(data?.counts?.due || 0),
    learning: Number(data?.counts?.learning || 0),
    new: Number(data?.counts?.new || 0),
    total: Number(data?.counts?.total || (data?.cards || []).length || 0),
  };
  const cards = (Array.isArray(data?.cards) ? data.cards : []).filter((c) => c && c.hanzi);
  ctx.templates = templateList(data);
  const ids = new Set(ctx.templates.map((t) => t.id));
  if (!ctx.picked) ctx.picked = new Set(ids);
  else for (const id of [...ctx.picked]) if (!ids.has(id)) ctx.picked.delete(id);
  if (!ctx.picked.size) ctx.picked = new Set(ids);

  const body = [];
  if (error) {
    body.push(emptyState({
      title: 'The queue did not load',
      text: error.message,
      action: h('button', { class: 'btn btn--primary', type: 'button', onClick: (e) => { busy(e.currentTarget); loadLanding(ctx); } },
        pixelIcon('refresh', 2), 'Try again'),
    }));
  } else {
    body.push(h('div', { class: 'scoreboard rv-counts' },
      score(counts.due, 'Due', counts.due > 0 ? 'due' : ''),
      score(counts.learning, 'Learning'),
      score(counts.new, 'New'),
      score(counts.total, 'In queue')));

    if (!cards.length) body.push(nothingDue(ctx, counts));
    else body.push(...startBlock(ctx, cards, counts));
  }

  const dueTag = counts.due > 0 ? h('span', { class: 'pl-tag due' }, `${counts.due} due`) : null;
  const page = h('div', { class: 'rv-landing' });
  if (ctx.lessonId) page.append(h('p', { class: 'pl-eyebrow' }, 'Lesson practice'));
  page.append(shell(body, ctx, dueTag));
  if (ctx.demo) page.append(h('p', { class: 'small faint' }, 'Demo data (?demo=1) — nothing is saved.'));
  ctx.root.replaceChildren(page);
}

/* `tone`: '' | 'accent' (the end card's one highlight) | 'due' (a STATE, amber).
   The landing's single terracotta belongs to "Start review", so the due count
   wears the due colour instead. */
function score(n, label, tone = '') {
  const cls = tone === 'accent' ? ' accent' : tone === 'due' ? ' is-due' : '';
  // Counts arrive as numbers, the end card's accuracy and time as strings.
  const text = typeof n === 'number' ? fmt.n(n) : String(n ?? '');
  return h('div', { class: `score${cls}` }, h('div', { class: 'n' }, text), h('div', { class: 'l' }, label));
}

/* Nothing due → a sleeping bird and the one useful next step. */
function nothingDue(ctx, counts) {
  const per = Math.max(1, Number(settings?.newWordsPerDay || 5));
  const actions = [];
  if (counts.new > 0) {
    actions.push(h('button', {
      class: 'btn btn--primary', type: 'button',
      onClick: async (e) => {
        const b = e.currentTarget; busy(b);
        try {
          const data = ctx.demo ? demoQueue('1') : await api.get(queueUrl({ limit: Math.max(20, per), lessonId: ctx.lessonId, newLimit: per, includeNew: true }));
          if (ctx.my !== token) return;
          if (!(data?.cards || []).length) { toast('No new words are waiting.', ''); return; }
          startSession(ctx, data);
        } catch (err) { toast(err.message, 'bad'); } finally { busy(b, false); }
      },
    }, pixelIcon('plus', 2), `Learn ${per} new word${per === 1 ? '' : 's'}`));
  } else {
    actions.push(h('button', { class: 'btn btn--primary', type: 'button', onClick: () => { ctx.leaving = true; navigate('/notes'); } }, pixelIcon('notes', 2), 'Add notes'));
    actions.push(h('button', { class: 'btn', type: 'button', onClick: () => { ctx.leaving = true; navigate('/challenge'); } }, pixelIcon('trophy', 2), 'Try a challenge'));
  }
  return emptyState({
    bird: createBird({ size: 4, mood: 'sleep' }).el,
    title: 'Nothing due right now',
    text: counts.new > 0
      ? 'Every card you have seen is scheduled for later. Want to meet some new words?'
      : 'Plumi is having a nap. Bring in new words and the queue fills itself.',
    action: h('div', { class: 'row row--wrap rv-empty-actions' }, ...actions),
  });
}

/* Templates + the primary action. */
function startBlock(ctx, cards, counts) {
  const out = [];
  out.push(h('p', { class: 'pl-eyebrow' }, 'Card templates'));
  const list = h('div', { class: 'rv-templates' });
  for (const t of ctx.templates) {
    const input = h('input', { type: 'checkbox', checked: ctx.picked.has(t.id) });
    input.addEventListener('change', () => {
      if (input.checked) ctx.picked.add(t.id);
      else if (ctx.picked.size <= 1) { input.checked = true; toast('Keep at least one card template.', ''); }
      else ctx.picked.delete(t.id);
    });
    list.append(h('label', { class: 'check rv-tpl' }, input,
      h('span', { class: 'grow' },
        h('span', { class: 'rv-tpl-name' }, t.name || t.id),
        h('span', { class: 'rv-tpl-sides' }, (t.front || []).join(' + '), ' → ', (t.back || []).join(' + ')))));
  }
  out.push(list);

  out.push(h('button', {
    class: 'btn btn--primary btn--lg btn--block', type: 'button',
    onClick: () => startSession(ctx, { cards, counts, templates: ctx.templates }),
  }, pixelIcon('review', 2), `Start review · ${cards.length}`));

  if (ctx.lessonId) {
    out.push(h('button', {
      class: 'btn btn--block', type: 'button',
      onClick: async (e) => {
        const b = e.currentTarget; busy(b);
        try {
          const data = ctx.demo ? demoQueue('1') : await api.get(queueUrl({ limit: 200, lessonId: ctx.lessonId, newLimit: 200 }));
          if (ctx.my !== token) return;
          if (!(data?.cards || []).length) { toast('This lesson has no cards yet.', ''); return; }
          startSession(ctx, data);
        } catch (err) { toast(err.message, 'bad'); } finally { busy(b, false); }
      },
    }, pixelIcon('lessons', 2), 'Cram all lesson cards'));
  }
  return out;
}

/* ---------- the session ---------- */
function startSession(ctx, data) {
  const queue = (data.cards || []).filter((c) => c && c.hanzi).map((word) => ({ word }));
  if (!queue.length) { toast('Nothing to review right now.', ''); return; }

  const offered = (Array.isArray(data.templates) && data.templates.length ? data.templates : ctx.templates) || [];
  const chosen = offered.filter((t) => ctx.picked?.has(t.id));
  const use = (chosen.length ? chosen : offered.length ? offered : [RECOGNITION]);

  const startedAt = Date.now();
  let idx = 0, graded = 0, correct = 0, xpEarned = 0, rotate = 0;
  let revealed = false, ended = false, cardAt = 0;
  let front = null, back = null, hiddenHanzi = null;
  const pending = [];

  const bird = createBird({ size: 3, mood: 'think' });
  const birdSlot = h('div', { class: 'grow rv-bird' }, bird.el);

  const session = openSession({
    title: 'Review',
    onClose: () => {
      live = null;
      document.removeEventListener('keydown', onKey);
      clearTimers();
      if (!ctx.leaving && ctx.my === token && ctx.root.isConnected) loadLanding(ctx);
    },
  });
  live = session;
  session.onLeave = async () => {
    if (await confirmWindow({ title: 'Leave the review?', text: 'Cards you already graded are saved.', okLabel: 'Leave' })) end(false);
  };
  document.addEventListener('keydown', onKey);

  function onKey(e) {
    if (ended || document.querySelector('.scrim')) return;      // a window owns the keyboard
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (!revealed) {
      if (e.key === ' ' || e.key === 'Enter') {
        if (e.key === 'Enter' && document.activeElement?.tagName === 'BUTTON') return;   // let the button click
        e.preventDefault();
        reveal();
      }
      return;
    }
    const hit = GRADES.find((g) => g.kbd === e.key);
    if (hit) { e.preventDefault(); grade(hit); }
  }

  function chooseTemplate(word) {
    // Rotate through the chosen templates; a front this word cannot carry
    // (no example for a cloze, no voice for audio) falls back to recognition.
    const tpl = use[rotate++ % use.length] || RECOGNITION;
    return frontWorks(tpl, word) ? tpl : RECOGNITION;
  }

  function showCard() {
    if (idx >= queue.length) { end(true); return; }
    const item = queue[idx];
    const word = item.word;
    const tpl = item.tpl = chooseTemplate(word);
    revealed = false;
    hiddenHanzi = null;
    cardAt = performance.now();
    bird.setMood('think');
    session.setProgress(graded, Math.max(1, queue.length));

    front = h('div', { class: 'rv-fields rv-front' });
    for (const f of (tpl.front || ['hanzi'])) {
      const node = renderField(f, word, { side: 'front', tpl });
      if (!node) continue;
      if (node.dataset?.rvHidden === '1') hiddenHanzi = node;
      front.append(node);
    }
    if (!front.childNodes.length) front.append(hanziEl(word, { size: 'xl' }));
    back = h('div', { class: 'rv-fields rv-back', hidden: true });

    // .rv-stage centres the card in the body with auto margins, which (unlike
    // justify-content) still lets a long card scroll instead of clipping.
    session.body.replaceChildren(h('div', { class: 'rv-stage' },
      h('div', { class: 'pl-win rv-card' },
        h('div', { class: 'pl-titlebar' },
          h('span', { class: 'pl-title' }, tpl.name || 'Card'),
          h('span', { class: 'spacer' }),
          h('span', { class: 'rv-count' }, `${Math.min(idx + 1, queue.length)} / ${queue.length}`)),
        h('div', { class: 'win-body rv-body' }, front, back))));
    session.body.scrollTop = 0;

    // The listening card plays itself once, the way a teacher would say it.
    if ((tpl.front || []).includes('audio')) later(() => { if (!ended) tts.speak(word.hanzi); }, 260);

    session.footer.replaceChildren(birdSlot, h('button', {
      class: 'btn btn--primary btn--lg', type: 'button', onClick: reveal,
    }, 'Show answer', h('span', { class: 'kbd' }, 'space')));
  }

  function reveal() {
    if (revealed || ended) return;
    revealed = true;
    const item = queue[idx];
    const { word, tpl } = item;
    // The hanzi flips from bare to ruby: the reading WAS the question.
    if (hiddenHanzi) hiddenHanzi.replaceWith(hanziEl(word, { size: 'xl' }));
    for (const f of (tpl.back || [])) {
      const node = renderField(f, word, { side: 'back', tpl });
      if (node) back.append(node);
    }
    const chip = bandChip(word.band);
    if (chip || Number.isFinite(word.score)) {
      const metaRow = h('div', { class: 'row rv-meta' }, chip);
      if (Number.isFinite(word.score)) metaRow.append(meter(word.score));
      metaRow.append(h('span', { class: 'pl-tag' }, fmt.due(word.srs?.due)));
      back.append(metaRow);
    }
    back.hidden = false;
    bird.setMood('idle');
    gradeFooter();
  }

  function gradeFooter() {
    const item = queue[idx];
    const actions = h('div', { class: 'rv-actions' });
    for (const gr of GRADES) {
      const label = item.word?.preview?.[gr.key]?.label;
      actions.append(h('button', {
        class: `btn ${gr.cls}`, type: 'button', title: `${gr.label} — press ${gr.kbd}`, 'aria-keyshortcuts': gr.kbd,
        onClick: () => grade(gr),
      }, gr.label, label ? h('span', { class: 'kbd' }, label) : null));
    }
    session.footer.replaceChildren(birdSlot, actions);
  }

  function grade(gr) {
    if (!revealed || ended) return;
    const item = queue[idx];
    const word = item.word;
    const ms = Math.max(0, Math.round(performance.now() - cardAt));
    graded += 1;
    if (gr.g > 0) correct += 1;
    bird.setMood(gr.g === 0 ? 'sad' : gr.g >= 2 ? 'happy' : 'idle');
    if (graded % 5 === 0) bird.say(CHEERS[(graded / 5 - 1) % CHEERS.length], 2600);

    // Again → back into the queue behind three other cards (or at the end).
    if (gr.g === 0) queue.splice(Math.min(idx + 4, queue.length), 0, { word });

    if (!ctx.demo) {
      const p = api.post('/api/review/grade', { wordId: word.id, grade: gr.g, templateId: item.tpl?.id || RECOGNITION.id, ms })
        .then((res) => {
          if (res?.stats) setStats(res.stats);
          xpEarned += Number(res?.xp || 0);
          if (res?.word) item.word = { ...word, ...res.word };   // fresh preview if it comes back
        })
        .catch((e) => toast(e.message, 'bad'));
      pending.push(p);
    } else {
      xpEarned += 2 + (gr.g >= 2 ? 1 : 0);
    }

    idx += 1;
    showCard();
  }

  async function end(complete) {
    if (ended) return;
    ended = true;
    document.removeEventListener('keydown', onKey);
    tts.stop();
    if (!complete) { session.close(); return; }

    session.setBusy(true);
    const ms = Date.now() - startedAt;
    let after = stats;
    if (!ctx.demo) {
      await Promise.allSettled(pending);                       // let the grades land first
      try {
        const res = await api.post('/api/review/finish', { reviewed: graded, correct, ms });
        if (res?.stats) { setStats(res.stats); after = res.stats; }
        xpEarned += Number(res?.xp || 0);
      } catch (e) {
        toast(e.message, 'bad');
        await refreshStats();
        after = stats;
      }
    } else {
      xpEarned += 5;
    }
    session.setBusy(false);
    if (!session.body.isConnected) return;                     // someone closed it meanwhile
    endCard(after, ms);
  }

  function endCard(after, ms) {
    session.onLeave = null;                                    // Escape just closes now
    session.setProgress(1, 1);
    const cheer = createBird({ size: 5, mood: 'cheer' });
    const acc = graded ? Math.round((correct / graded) * 100) : 0;
    session.body.replaceChildren(h('div', { class: 'rv-stage' }, h('div', { class: 'pl-win rv-end' },
      h('div', { class: 'pl-titlebar' }, h('span', { class: 'pl-title' }, 'Session complete'), h('span', { class: 'spacer' })),
      h('div', { class: 'win-body' },
        h('div', { class: 'rv-end-hero' }, cheer.el),
        h('h2', { class: 'h2 rv-end-title' }, 'Session complete'),
        h('div', { class: 'scoreboard' },
          score(graded, 'Cards'),
          score(`${acc}%`, 'Accuracy'),
          score(xpEarned, 'XP earned', 'accent'),
          score(fmt.ms(ms), 'Time'))))));
    later(() => cheer.say('做得好！', 3200), 400);
    celebrate(session.body);

    const dueLeft = ctx.demo ? 1 : Number(after?.counts?.dueNow || 0);
    const actions = [h('button', {
      class: 'btn', type: 'button',
      onClick: () => { ctx.leaving = true; session.close(); navigate('/today'); },
    }, pixelIcon('today', 2), 'Back to Today')];
    if (dueLeft > 0) {
      actions.push(h('button', {
        class: 'btn btn--primary btn--lg', type: 'button',
        onClick: async (e) => {
          const b = e.currentTarget; busy(b);
          try {
            const data = ctx.demo ? demoQueue('1') : await api.get(queueUrl({ limit: 20, lessonId: ctx.lessonId }));
            if (!(data?.cards || []).length) { toast('Nothing due right now.', ''); session.close(); return; }
            session.close();
            startSession(ctx, data);
          } catch (err) { toast(err.message, 'bad'); busy(b, false); }
        },
      }, pixelIcon('review', 2), 'Review more'));
    }
    // One shrinkable group: .btn--lg's 200px floor overflows a 390px footer
    // when it sits next to another button.
    session.footer.replaceChildren(h('div', { class: 'rv-end-actions' }, ...actions));
  }

  // score() takes numbers on the landing and strings here; both are fine.
  showCard();
}

/* ---------- ?demo=1 ----------
   A tiny in-memory queue so the card, the grades and the end screen can be
   exercised (and screenshotted) while the review routes do not exist yet.
   `?demo=empty` returns an empty queue with new words waiting and `?demo=zero`
   an empty one with nothing at all, so both empty states are reachable too.
   Harmless: it only runs when the hash carries demo=, and it never POSTs. */
function demoQueue(mode = '1') {
  const templates = BUILTIN_TEMPLATES.filter((t) => ['recognition', 'production', 'cloze'].includes(t.id));
  if (mode === 'empty') return { cards: [], counts: { due: 0, learning: 0, new: 2, total: 0 }, templates };
  if (mode === 'zero') return { cards: [], counts: { due: 0, learning: 0, new: 0, total: 0 }, templates };
  const preview = { again: { ms: 6e5, label: '10m' }, hard: { ms: 864e5, label: '1d' }, good: { ms: 2592e5, label: '3d' }, easy: { ms: 6048e5, label: '7d' } };
  const mk = (hanzi, zhuyin, pinyin, meaning, ex, extra = {}) => ({
    id: 'demo-' + hanzi, hanzi, zhuyin, pinyin, meaning, meaningNative: '', pos: 'v', type: 'word',
    examples: ex ? [ex] : [], notes: '', tags: ['demo'], preview, score: 48, band: { key: 'seen', zh: '認', label: 'Seen' },
    srs: { state: 'review', due: new Date(Date.now() - 6e5).toISOString() }, ...extra,
  });
  return {
    cards: [
      mk('謝謝', 'ㄒㄧㄝˋ ˙ㄒㄧㄝ', 'xiè xie', 'thank you', { zh: '謝謝你的幫忙。', pinyin: 'xiè xie nǐ de bāng máng', zhuyin: 'ㄒㄧㄝˋ ˙ㄒㄧㄝ ㄋㄧˇ ˙ㄉㄜ ㄅㄤ ㄇㄤˊ', translation: 'Thanks for your help.' }),
      mk('喝茶', 'ㄏㄜ ㄔㄚˊ', 'hē chá', 'to drink tea', { zh: '我喜歡喝茶。', pinyin: 'wǒ xǐ huān hē chá', zhuyin: 'ㄨㄛˇ ㄒㄧˇ ㄏㄨㄢ ㄏㄜ ㄔㄚˊ', translation: 'I like drinking tea.' }, { notes: 'Everyday verb + object pair.' }),
      mk('學校', 'ㄒㄩㄝˊ ㄒㄧㄠˋ', 'xué xiào', 'school', { zh: '學校在那裡。', pinyin: 'xué xiào zài nà lǐ', zhuyin: 'ㄒㄩㄝˊ ㄒㄧㄠˋ ㄗㄞˋ ㄋㄚˋ ㄌㄧˇ', translation: 'The school is over there.' }),
      mk('朋友', 'ㄆㄥˊ ㄧㄡˇ', 'péng yǒu', 'friend', { zh: '他是我的朋友。', pinyin: 'tā shì wǒ de péng yǒu', zhuyin: 'ㄊㄚ ㄕˋ ㄨㄛˇ ˙ㄉㄜ ㄆㄥˊ ㄧㄡˇ', translation: 'He is my friend.' }),
    ],
    counts: { due: 3, learning: 1, new: 2, total: 4 },
    templates,
  };
}

function unmount() {
  token += 1;
  clearTimers();
  tts.stop();
  try { live?.close(); } catch { /* the layer is already gone */ }
  live = null;
}

export default { id: 'review', title: 'Review', render, unmount };
