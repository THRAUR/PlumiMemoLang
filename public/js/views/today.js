/* today.js — the TODAY screen: the home dashboard the learner opens every
   morning. Its only job is to answer "what should I study right now?" and to
   put that one tap within reach.

   Four endpoints feed it (/stats, /lessons, /review/queue, /suggestions/today)
   and they are settled in PARALLEL with Promise.allSettled: the routes are
   written by another module, so a missing or broken one must never blank the
   page. Whatever answered gets rendered, the rest degrades to a clean state.

   The copy follows the learner's goals (profile() in ui.js): a speaking learner
   is coached about saying and hearing, a character learner about characters,
   and every Chinese word or phrase follows the display rules of §8.3.

   Accent budget (Plume's one-terracotta-per-region rule):
     · hero              → the goal ring
     · "Today" window    → the practice row's icon box, when there is something to practice
     · suggestions       → the "Add" buttons (or "Suggest words" when empty)
     · path              → the current node
     · scoreboard        → the best-streak number
     · this week         → today's spark bar
*/
import { h, toast, ring, meter, emptyState, busy, celebrate, progress, speakButton, pixelIcon, fmt, setTitle, profile, readingFor } from '../ui.js';
import { settings, stats, setStats, refreshStats, on } from '../state.js';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { createBird, greeting } from '../bird.js';
import { wordLine } from '../hanzi.js';
import { pinyinToZhuyin } from '/shared/zhuyin.js';

/* ---------- view-local state ---------- */
/* `seq` is a render token. Every await compares it before touching the DOM, so
   a slow job that finishes after the learner left is dropped instead of
   writing into a detached tree. */
let seq = 0;
let offStats = null;        // on('stats') unsubscribe
let bird = null;            // the hero bird, kept so a repaint only changes its mood
let ctx = {};               // the settled payloads: { lessons, queue, sugg, suggError }
let refs = {};              // the live nodes a stats update repaints in place
let sayTimer = null;
let flashTimer = null;
let restoreMood = null;     // the mood to go back to after a tap-on-Plumi line
let goalWas = false;        // to fire the confetti only when the goal is newly met

/* Six encouragements, half Chinese, half English. Each Chinese line carries its
   pinyin, because a speaking learner reads the reading, not the characters. */
const SAYINGS = [
  { zh: '加油', py: 'jiā yóu', end: '！', en: 'You have got this.' },
  { zh: '一天一點', py: 'yì tiān yì diǎn', end: '。', en: 'A little every day.' },
  { zh: '慢慢來', py: 'màn màn lái', end: '。', en: 'Slow is fine — just keep going.' },
  { zh: '再來五分鐘', py: 'zài lái wǔ fēn zhōng', end: '。', en: 'Five minutes beats zero minutes.' },
  { zh: '', en: 'You remember more than you think.' },
  { zh: '我們一起學', py: 'wǒ men yì qǐ xué', end: '。', en: 'We study together.' },
];
/* The readings of bird.js's greetings (早安 / 午安 / 晚安). */
const GREETING_PINYIN = { 早安: 'zǎo ān', 午安: 'wǔ ān', 晚安: 'wǎn ān' };
const LATIN_PUNCT = { '！': '!', '。': '.', '，': ',' };

/* ============================================================
   render
   ============================================================ */
async function render(root, params) {
  const my = ++seq;
  setTitle('Today');

  const settled = await Promise.allSettled([
    api.get('/api/stats'),
    api.get('/api/lessons'),
    api.get('/api/review/queue?limit=1'),
    api.get('/api/suggestions/today'),
  ]);
  if (my !== seq) return;                        // a newer navigation won

  // /stats is shared state: hand it to the owner's setter so the top bar and
  // the rail update from the same fetch.
  if (settled[0].status === 'fulfilled') setStats(settled[0].value);

  const lessons = Array.isArray(settled[1].value?.lessons) ? settled[1].value.lessons : [];
  ctx = {
    lessons: lessons.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    queue: settled[2].status === 'fulfilled' ? settled[2].value : null,
    sugg: settled[3].status === 'fulfilled' ? settled[3].value : null,
    suggError: settled[3].status === 'rejected' ? settled[3].reason?.message : null,
  };

  // ONE toast, not four. With the API down every endpoint fails and a stack of
  // error toasts would bury the screen the learner came to read; the first
  // message ("The app server is not reachable…", "No such endpoint…") says it.
  const failed = settled.find((r) => r.status === 'rejected');
  if (failed) toast(failed.reason?.message || 'Something went wrong.', 'bad');

  refs = {};
  goalWas = goalMet(stats);
  root.replaceChildren();
  root.append(hero());
  // First run: no words and no lessons. Sections 2–6 have nothing to say yet,
  // so one invitation replaces them all. The hero stays — Plumi still greets.
  if (isFirstRun()) root.append(welcome());
  else root.append(todayWindow(), suggestionsWindow(), ...lowerSections());

  offStats?.();
  offStats = on('stats', paintStats);
}

function unmount() {
  seq++;                                   // orphan anything still in flight
  offStats?.();
  offStats = null;
  clearTimeout(sayTimer); sayTimer = null;
  clearTimeout(flashTimer); flashTimer = null;
  bird = null; restoreMood = null;
  ctx = {}; refs = {};
}

/* ============================================================
   Chinese in Plumi's mouth, by the learner's display rules
   ============================================================ */
/* Characters for a character learner. For a speaking learner the reading
   carries the phrase and the characters trail small, or not at all when hidden. */
function phrase(zh, py, end = '') {
  const mode = profile().hanzi;
  if (mode === 'full' || !py) return h('span', { class: 'zh', lang: 'zh-Hant' }, zh + end);
  const r = readingOf(zh, py);
  const reading = r.kind === 'zhuyin'
    ? h('span', { class: 'td-say zh', lang: 'zh-Hant' }, r.text + end)
    : h('span', { class: 'td-say' }, r.text + (LATIN_PUNCT[end] ?? end));
  if (mode === 'hidden') return reading;
  return h('span', null, reading, ' ', h('span', { class: 'td-say-hz', lang: 'zh-Hant' }, zh));
}
function readingOf(zh, py) {
  let zy = '';
  try { zy = pinyinToZhuyin(py); } catch { zy = ''; }
  return readingFor({ hanzi: zh, pinyin: py, zhuyin: zy }).primary || { text: py, kind: 'pinyin' };
}
function greetingNodes() {
  const name = settings?.learnerName || '';
  const zh = greeting('').replace(/！$/, '');
  const py = GREETING_PINYIN[zh];
  const mode = profile().hanzi;
  if (mode === 'full' || !py) return [h('span', { class: 'zh', lang: 'zh-Hant' }, greeting(name))];
  const r = readingOf(zh, py);
  // A sentence starts with a capital, in pinyin as in English: "Wǎn ān, Arthur!"
  const text = r.kind === 'pinyin' ? r.text.charAt(0).toUpperCase() + r.text.slice(1) : r.text;
  const out = [
    h('span', { class: `td-say${r.kind === 'zhuyin' ? ' zh' : ''}`, lang: r.kind === 'zhuyin' ? 'zh-Hant' : undefined }, text),
    name ? `, ${name}!` : '!',
  ];
  if (mode === 'small') out.push(' ', h('span', { class: 'td-say-hz', lang: 'zh-Hant' }, zh));
  return out;
}
function plural(n, word) { return n === 1 ? word : `${word}s`; }

/* ============================================================
   1. hero — Plumi, the greeting, then the goal and the streak
   ============================================================ */
function hero() {
  bird = createBird({ size: 5, mood: heroMood(stats) });

  const line = h('span', { class: 'td-line muted' }, ...coachLine());
  const bubble = h('div', { class: 'bubble td-bubble' },
    h('span', { class: 'td-hi' }, ...greetingNodes()),
    line);

  // Plumi is a real button: tapping the bird is the one bit of pure delight on
  // this screen, and it has to be reachable from the keyboard too.
  const tap = h('button', { class: 'td-bird', type: 'button', 'aria-label': 'Plumi says something' }, bird.el);
  tap.addEventListener('click', plumiSays);

  const goalHost = h('div', { class: 'td-tile td-goal' }, ...goalParts());
  const streakHost = h('div', { class: 'td-tile td-streak-tile' }, ...streakParts());

  const el = h('section', { class: 'td-hero' },
    h('div', { class: 'coach td-coach' }, tap, bubble),
    h('div', { class: 'td-numbers' }, goalHost, streakHost));

  refs.hero = el; refs.line = line; refs.goalHost = goalHost; refs.streakHost = streakHost;
  paintStreakCold();
  return el;
}

/* The ring's disc holds only the number (ui.js ring()); the goal itself sits
   under it, where it has the tile's whole width. */
function goalParts() {
  const st = stats;
  const xp = st?.xpToday || 0;
  const goal = st?.goal || settings?.dailyGoalXp || 30;
  const met = goalMet(st);
  const r = ring(xp, goal);
  // Four digits no longer fit the disc at this ring's size.
  if (String(xp).length > 3) r.querySelector('.ring-label')?.classList.add('is-long');
  return [r, h('span', { class: 'td-tile-txt' },
    met
      ? h('span', { class: 'td-tile-main is-done' }, 'Goal reached')
      : h('span', { class: 'td-tile-main' }, `of ${fmt.n(goal)} XP today`),
    h('span', { class: 'td-tile-sub' }, met ? `${fmt.n(xp)} of ${fmt.n(goal)} XP` : `${fmt.n(Math.max(0, goal - xp))} XP to go`))];
}

function streakParts() {
  const s = stats?.streak || {};
  const n = s.current || 0;
  return [
    h('span', { class: 'td-flame', title: 'Day streak' }, pixelIcon('flame', 4), h('span', { class: 'td-flame-n' }, fmt.n(n))),
    h('span', { class: 'td-tile-txt' },
      h('span', { class: 'td-tile-main' }, 'day streak'),
      // A running streak that today has not fed yet gets the nudge instead of the record.
      h('span', { class: 'td-tile-sub' }, n > 0 && !s.activeToday ? 'Keep it going today' : `best ${fmt.n(s.best || 0)}`)),
  ];
}
function paintStreakCold() {
  refs.streakHost?.classList.toggle('is-cold', !stats?.streak?.activeToday);
}

/* The coaching sentence under the greeting — the whole screen in one line. */
function coachLine() {
  const st = stats;
  const goal = st?.goal || settings?.dailyGoalXp || 0;
  const focus = profile().focus;
  if (goalMet(st)) return ['Goal reached. ', phrase('太棒了', 'tài bàng le', '！')];
  if (isFirstRun()) return [focus === 'speaking' ? 'Add your first class notes, then say them out loud.' : 'Start by adding your first class notes.'];
  const c = counts();
  if (focus === 'speaking') {
    if (c.due > 0) return [`${c.due} ${plural(c.due, 'phrase')} to say out loud.`];
    if (c.new > 0) return [`${c.new} new ${plural(c.new, 'phrase')} to say out loud.`];
    return ['All caught up. Try a few new words out loud?'];
  }
  const kind = focus === 'characters' ? 'character card' : 'card';
  if (c.due > 0) return [`${c.due} ${plural(c.due, kind)} ${c.due === 1 ? 'is' : 'are'} waiting.`];
  if (!goal) return ['Ready when you are.'];
  return [focus === 'characters' ? 'All caught up — learn a new character?' : 'All caught up — learn something new?'];
}

function heroMood(st) {
  if (goalMet(st)) return 'cheer';
  if (new Date().getHours() >= 22) return 'sleep';   // late night: Plumi dozes off
  return (st?.xpToday || 0) > 0 ? 'happy' : 'idle';
}

/* A tap swaps the bubble's second line for an encouragement, then puts the
   coaching line back. (bird.say() hangs its own bubble inside .bird, which
   .coach .bubble flattens into the flow — this bubble IS Plumi's bubble.) */
function plumiSays() {
  if (!refs.line) return;
  const pick = SAYINGS[Math.floor(Math.random() * SAYINGS.length)];
  refs.line.replaceChildren(...sayNodes(pick));
  refs.line.classList.remove('td-pop');
  void refs.line.offsetWidth;                 // restart the animation on a re-tap
  refs.line.classList.add('td-pop');
  if (bird) {
    if (restoreMood === null) restoreMood = bird.mood;
    bird.setMood('happy');
  }
  clearTimeout(sayTimer);
  sayTimer = setTimeout(() => {
    sayTimer = null;
    if (bird && restoreMood) bird.setMood(restoreMood);
    restoreMood = null;
    if (refs.line) { refs.line.classList.remove('td-pop'); refs.line.replaceChildren(...coachLine()); }
  }, 4200);
}
/* replaceChildren() turns a null into the text "null", so the gaps are filtered. */
function sayNodes(s) {
  return [
    s.zh ? phrase(s.zh, s.py, s.end) : null,
    s.zh && s.en ? ' ' : null,
    s.en || null,
  ].filter((x) => x !== null);
}

/* ============================================================
   2. the "Today" window — the four ways into a session
   ============================================================ */
function todayWindow() {
  const c = counts();
  const focus = profile().focus;
  const speaking = focus === 'speaking';
  const list = h('div', { class: 'list td-acts' });

  list.append(actionRow({
    icon: speaking ? 'mic' : 'review',
    title: speaking ? 'Practice speaking' : focus === 'characters' ? 'Review characters' : 'Review',
    sub: reviewSub(c, focus),
    hot: c.due > 0 || c.new > 0,             // the window's single terracotta pop
    onClick: () => navigate('/review'),
  }));

  list.append(learnRow());

  // Hidden when there are no lessons at all; nothing to continue.
  if (ctx.lessons.length) {
    const next = ctx.lessons.find((l) => !isDone(l)) || ctx.lessons[ctx.lessons.length - 1];
    const done = isDone(next);
    list.append(actionRow({
      icon: 'lessons',
      title: done ? 'Revisit a lesson' : 'Continue lesson',
      sub: lessonLabel(next),
      onClick: () => navigate(`/lessons/${next.id}`),
    }));
  }

  const words = stats?.counts?.words ?? 0;
  const tooFew = words < 4;                  // a quiz needs distractors
  list.append(actionRow({
    icon: 'trophy',
    title: speaking ? 'Speaking challenge' : 'Challenge',
    sub: tooFew ? 'Add 4 words first'
      : speaking ? 'Listen, pick and say it'
        : focus === 'characters' ? 'Test the characters you know' : 'Test everything you know',
    off: tooFew,
    onClick: () => navigate('/challenge'),
  }));

  return h('section', { class: 'pl-win td-win' },
    titlebar(`Today · ${fmt.date(todayYmd())}`, { icon: 'today' }),
    list);
}

/* `due` already includes the learning cards that are due (docs §7). */
function reviewSub(c, focus) {
  if (!hasCounts()) return focus === 'speaking' ? 'Say your words out loud' : 'Your memo cards';
  if (focus === 'speaking') {
    if (c.due > 0) return `${c.due} ${plural(c.due, 'phrase')} to say out loud`;
    if (c.new > 0) return `${c.new} new ${plural(c.new, 'phrase')} to say out loud`;
    return 'All caught up';
  }
  if (c.due > 0) return `${c.due} due · ${c.learning} learning`;
  if (c.new > 0) return `${c.new} new ${plural(c.new, 'card')} to learn`;
  return 'All caught up';
}

/* New cards already have the practice row; this one is about today's suggestions. */
function learnRow() {
  const row = actionRow({ icon: 'bulb', title: 'Learn new words', sub: suggSub(), onClick: scrollToSugg });
  refs.learnSub = row.querySelector('.td-act-s');
  return row;
}
function suggSub() {
  const n = openItems().length;
  if (n) return profile().focus === 'speaking' ? `${n} new ${plural(n, 'word')} to hear and say` : `${n} suggested today`;
  const items = Array.isArray(ctx.sugg?.items) ? ctx.sugg.items : [];
  return items.length ? 'Done for today' : 'No suggestions yet';
}

function actionRow({ icon, title, sub, hot = false, off = false, onClick }) {
  const row = h('button', {
    class: `list-row td-act${hot ? ' is-hot' : ''}${off ? ' is-off' : ''}`,
    type: 'button',
    disabled: off,
  },
    h('span', { class: 'td-ico' }, pixelIcon(icon, 2)),
    h('span', { class: 'grow td-act-txt' },
      h('span', { class: 'td-act-t' }, title),
      h('span', { class: 'td-act-s small muted' }, ...[].concat(sub))),
    h('span', { class: 'td-arrow' }, pixelIcon('arrow', 2)));
  if (!off && onClick) row.addEventListener('click', onClick);
  return row;
}

function scrollToSugg() {
  const el = refs.sugg;
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('td-flash');
  void el.offsetWidth;
  el.classList.add('td-flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashTimer = null; el.classList.remove('td-flash'); }, 1200);
}

/* ============================================================
   3. suggestions — "New words for today"
   ============================================================ */
function suggestionsWindow() {
  const body = h('div', { class: 'td-sugg-body' });
  // Quiet, not ghost: the "Add" buttons own this window's terracotta.
  const refresh = h('button', {
    class: 'btn btn--icon btn--quiet td-refresh', type: 'button',
    'aria-label': 'Suggest new words again', title: 'Refresh',
  }, pixelIcon('refresh', 2));
  refresh.addEventListener('click', () => runRefresh(refresh));

  const win = h('section', { class: 'pl-win td-win td-sugg' },
    titlebar('New words for today', { icon: 'bulb', right: refresh }),
    body);
  refs.sugg = win; refs.suggBody = body;
  paintSugg();
  return win;
}

function paintSugg() {
  const host = refs.suggBody;
  if (!host) return;
  host.replaceChildren();
  const d = ctx.sugg;

  if (!d) {                                   // the endpoint did not answer
    host.append(suggState(
      h('div', { class: 'card card--sunk td-note' }, h('p', { class: 'small' }, ctx.suggError || 'Suggestions are unavailable right now.')),
      retryButton()));
    return;
  }
  if (d.status === 'no-key') {
    host.append(suggState(
      h('div', { class: 'card card--sunk td-note' }, h('p', { class: 'small' }, 'Connect an AI in Settings (your Claude plan or an OpenRouter key) and Plumi will suggest new words every morning.')),
      h('button', { class: 'btn btn--primary', type: 'button', onClick: () => navigate('/settings') }, pixelIcon('settings', 2), 'Open settings')));
    return;
  }
  if (d.status === 'generating') { paintGenerating(d.jobId); return; }

  const items = Array.isArray(d.items) ? d.items : [];
  const visible = items.map((item, index) => ({ item, index })).filter((x) => x.item.status !== 'dismissed');
  const open = visible.filter((x) => x.item.status === 'open');

  if (!items.length) {                        // nothing cached for today yet
    host.append(suggState(
      h('p', { class: 'muted small' }, 'No words picked for today yet.'),
      h('button', { class: 'btn btn--primary', type: 'button', onClick: (e) => runRefresh(e.currentTarget) }, pixelIcon('bulb', 2), 'Suggest words')));
    return;
  }
  if (!open.length) {                         // every item handled
    const added = items.some((i) => i.status === 'added');
    host.append(suggState(h('p', { class: 'td-done-line' },
      added ? 'All of today’s words are in your deck. ' : 'Nothing new for today. ',
      phrase('明天見', 'míng tiān jiàn', '！'))));
    return;
  }

  const list = h('div', { class: 'list td-acts td-suglist' });
  const built = visible.map((v) => ({ ...v, ...suggRow(v.item, v.index) }));
  for (const b of built) list.append(b.row);
  host.append(list);
  if (open.length >= 2) {
    host.append(h('div', { class: 'td-sugg-foot' }, addAllButton(built.filter((b) => b.item.status === 'open'))));
  }
}

function suggState(...children) {
  return h('div', { class: 'win-body td-state' }, ...children);
}
function retryButton() {
  const b = h('button', { class: 'btn btn--sm', type: 'button' }, pixelIcon('refresh', 2), 'Try again');
  b.addEventListener('click', async () => { busy(b, true); await reloadSugg(); });
  return b;
}

/* The AI is picking words: a thinking bird, a barber-pole bar, the job's own
   progress text, then a re-fetch. */
function paintGenerating(jobId) {
  const host = refs.suggBody;
  const think = createBird({ size: 4, mood: 'think' });
  const bar = progress(0, 1);
  bar.classList.add('is-busy');
  const line = h('p', { class: 'small muted td-jobline' }, 'Plumi is picking today’s words…');
  host.append(h('div', { class: 'win-body td-state' },
    h('div', { class: 'row td-generating' }, think.el, h('div', { class: 'grow' }, bar, line))));
  if (!jobId) return;
  const my = seq;
  api.job(jobId, { onProgress: (text) => { if (my === seq && text) line.textContent = text; } })
    .then(() => { if (my === seq) reloadSugg(); })
    .catch((e) => {
      if (my !== seq) return;
      toast(e.message, 'bad');
      ctx.sugg = { status: 'ready', items: [] };     // a clean "nothing yet" state
      paintSugg();
    });
}

async function reloadSugg() {
  const my = seq;
  try {
    const d = await api.get('/api/suggestions/today');
    if (my !== seq) return;
    ctx.sugg = d; ctx.suggError = null;
  } catch (e) {
    if (my !== seq) return;
    ctx.sugg = null; ctx.suggError = e.message;
    toast(e.message, 'bad');
  }
  paintSugg();
  updateLearnRow();
}

async function runRefresh(btn) {
  const my = seq;
  if (btn) busy(btn, true);
  try {
    const res = await api.post('/api/suggestions/refresh');
    if (my !== seq) return;
    ctx.sugg = { status: 'generating', jobId: res?.jobId, items: [] };
    paintSugg();                              // paints the bird, then polls the job
  } catch (e) {
    if (my !== seq) return;
    toast(e.message, 'bad');
  } finally {
    if (my === seq && btn && btn.isConnected) busy(btn, false);
  }
}

/* The word leads by the learner's display rules (wordLine: pinyin first for a
   speaking learner, 字 first for a character learner), with its play button
   right beside it: hearing a new word is the first thing a speaker wants. */
function suggRow(item, index) {
  const row = h('div', { class: 'list-row td-sug' });
  const acts = h('div', { class: 'td-sug-acts' });
  const name = item.meaning || item.pinyin || item.hanzi;

  row.append(
    h('div', { class: 'td-sug-txt' },
      h('div', { class: 'td-sug-word' },
        wordLine({ hanzi: item.hanzi, pinyin: item.pinyin, zhuyin: item.zhuyin }),
        speakButton(item.hanzi, { label: `Play ${name}` })),
      h('div', { class: 'td-sug-mean' },
        item.meaning || '',
        item.meaningNative ? h('span', { class: 'muted td-sug-native' }, ` · ${item.meaningNative}`) : null),
      item.why ? h('div', { class: 'small faint td-sug-why' }, item.why) : null),
    acts);

  if (item.status === 'added') { markAdded(row, acts); return { row, acts }; }

  const add = h('button', { class: 'btn btn--sm btn--primary', type: 'button' }, pixelIcon('plus', 2), 'Add');
  add.addEventListener('click', () => accept(item, index, row, acts, add));
  const no = h('button', { class: 'btn btn--sm btn--quiet', type: 'button', 'aria-label': `Skip ${name} today`, title: 'Not today' }, 'Skip');
  no.addEventListener('click', () => dismiss(item, index, row, no));
  acts.append(add, no);
  return { row, acts };
}

function markAdded(row, acts) {
  row.classList.add('is-added');
  // A 12px check: the tag is 18px tall.
  acts.replaceChildren(h('span', { class: 'pl-tag good' }, pixelIcon('check', 1), 'Added'));
}

async function accept(item, index, row, acts, btn) {
  const my = seq;
  busy(btn, true);
  try {
    const res = await api.post(`/api/suggestions/${index}/accept`);
    if (my !== seq) return;
    // The route hands back the fresh stats (+1 XP); fall back to a refetch.
    if (res && res.stats) setStats(res.stats); else refreshStats();
    item.status = 'added';
    markAdded(row, acts);
    updateLearnRow();
  } catch (e) {
    if (my !== seq) return;
    toast(e.message, 'bad');
    busy(btn, false);
  }
}

async function dismiss(item, index, row, btn) {
  const my = seq;
  busy(btn, true);
  try {
    await api.post(`/api/suggestions/${index}/dismiss`);
    if (my !== seq) return;
    item.status = 'dismissed';
    row.remove();
    updateLearnRow();
    if (!openItems().length) paintSugg();     // the last one: show the closing line
  } catch (e) {
    if (my !== seq) return;
    toast(e.message, 'bad');
    busy(btn, false);
  }
}

function addAllButton(pairs) {
  const b = h('button', { class: 'btn btn--sm', type: 'button' }, pixelIcon('plus', 2), 'Add all');
  b.addEventListener('click', async () => {
    const my = seq;
    busy(b, true);
    for (const p of pairs) {
      if (my !== seq) return;
      if (p.item.status !== 'open') continue;
      try {
        const res = await api.post(`/api/suggestions/${p.index}/accept`);
        if (my !== seq) return;
        if (res && res.stats) setStats(res.stats);
        p.item.status = 'added';
        markAdded(p.row, p.acts);
      } catch (e) {
        if (my !== seq) return;
        toast(e.message, 'bad');
        break;                                 // one failure is enough; keep the rest
      }
    }
    if (my !== seq) return;
    busy(b, false);
    b.remove();
    updateLearnRow();
    if (!pairs.some((p) => p.item.status === 'open')) refreshStats();
  });
  return b;
}

function updateLearnRow() {
  if (!refs.learnSub) return;
  refs.learnSub.replaceChildren(suggSub());
}

function openItems() {
  const items = Array.isArray(ctx.sugg?.items) ? ctx.sugg.items : [];
  return items.map((item, index) => ({ item, index })).filter((x) => x.item.status === 'open');
}

/* ============================================================
   4. path preview — the last four stops
   ============================================================ */
function pathWindow() {
  const all = ctx.lessons;
  const currentId = all.find((l) => !isDone(l))?.id || null;
  const path = h('div', { class: 'path td-path' });

  for (const lesson of all.slice(-4)) {
    const done = isDone(lesson);
    const isCurrent = lesson.id === currentId;
    const p = lesson.progress || {};
    const node = h('a', {
      class: `path-node${done ? ' is-done' : isCurrent ? ' is-current' : ''}`,
      href: `#/lessons/${lesson.id}`,
    },
      h('span', { class: 'path-btn' }, pixelIcon(done ? 'check' : isCurrent ? 'star' : 'lessons', 3)),
      h('span', { class: 'path-meta' },
        h('span', { class: 't' }, ...lessonLabel(lesson)),
        h('span', { class: 's' },
          h('span', { class: 'td-path-words' }, `${p.total ?? lesson.wordIds?.length ?? 0} words`),
          p.total ? meter(p.avgScore ?? 0) : null)));
    // Plumi stands on the stop the learner is on (an in-flow flex item).
    if (isCurrent) {
      const b = createBird({ size: 3, mood: 'idle', label: 'You are here' });
      b.el.classList.add('path-bird');
      node.append(b.el);
    }
    path.append(node);
  }

  return h('section', { class: 'pl-win td-win' },
    titlebar('Your path', { icon: 'lessons' }),
    h('div', { class: 'win-body td-path-body' },
      path,
      h('div', { class: 'td-path-foot' },
        h('a', { class: 'btn btn--sm btn--ghost', href: '#/lessons' }, 'All lessons', pixelIcon('arrow', 2)))));
}

/* ============================================================
   5. scoreboard   6. this week
   ============================================================ */
function scoreboardSection() {
  const board = h('div', { class: 'scoreboard td-board' }, ...scores());
  refs.board = board;
  return h('section', { class: 'td-progress' }, h('p', { class: 'pl-eyebrow' }, 'Progress'), board);
}
function scores() {
  const st = stats, c = st?.counts || {};
  return [
    scoreCell(c.words || 0, 'Words'),
    scoreCell(c.mastered || 0, 'Mastered'),
    scoreCell(st?.streak?.best || 0, 'Best streak', true),
    scoreCell(st?.xpTotal || 0, 'Total XP'),
  ];
}
function scoreCell(n, label, accent = false) {
  return h('div', { class: `score${accent ? ' accent' : ''}` },
    h('div', { class: 'n' }, fmt.n(n)),
    h('div', { class: 'l' }, label));
}

function weekCard() {
  const body = h('div', { class: 'td-week-body' }, ...weekInner());
  refs.weekHost = body;
  return h('section', { class: 'card td-week' },
    h('div', { class: 'card-head' }, h('h3', null, 'This week'), h('span', { class: 'pl-tag' }, 'XP')),
    body);
}
function weekInner() {
  const st = stats;
  // No stats yet? Seven local zero-days keep the card's shape instead of a hole.
  const days = Array.isArray(st?.week) && st.week.length ? st.week : fallbackWeek();
  const goal = st?.goal || settings?.dailyGoalXp || 30;
  const max = Math.max(goal, ...days.map((d) => d.xp || 0), 1);
  // A week with no XP at all would be 64px of empty box; flatten it instead.
  const flat = days.every((d) => !(d.xp > 0));
  const spark = h('div', { class: `spark td-spark${flat ? ' is-flat' : ''}` });
  const labels = h('div', { class: 'td-days' });
  days.forEach((d, i) => {
    const xp = d.xp || 0;
    const last = i === days.length - 1;
    spark.append(h('i', {
      class: `${last ? 'is-today' : ''}${xp ? '' : ' is-zero'}`.trim(),
      style: { height: `${Math.max(3, Math.round((xp / max) * 100))}%` },
      title: `${fmt.date(d.date)} · ${xp} XP`,
    }));
    labels.append(h('span', { class: last ? 'is-today' : null }, dayInitial(d.date)));
  });
  const reviews = days.reduce((n, d) => n + (d.reviews || 0), 0);
  const spend = st?.usage?.todayUsd || 0;
  return [spark, labels, h('p', { class: 'small muted td-week-line' },
    `${fmt.n(reviews)} review${reviews === 1 ? '' : 's'} this week`,
    spend > 0 ? ` · AI spend today ${fmt.usd(spend)}` : null)];
}

/* The path is tall and narrow, the numbers are short and wide: on a laptop they
   sit side by side, on a phone they stack in reading order. */
function lowerSections() {
  const board = scoreboardSection();
  const week = weekCard();
  if (!ctx.lessons.length) return [board, week];
  return [h('div', { class: 'td-lower' }, pathWindow(), h('div', { class: 'td-col' }, board, week))];
}

/* ============================================================
   7. first run
   ============================================================ */
function welcome() {
  const b = createBird({ size: 5, mood: 'idle' });
  return h('section', { class: 'card td-welcome' }, emptyState({
    bird: b.el,
    title: [phrase('歡迎', 'huān yíng', '！'), ' Welcome to your study desk.'],
    text: 'Paste your first class notes and Plumi builds your lesson and cards. Or add a word by hand.',
    action: h('div', { class: 'row row--wrap td-welcome-acts' },
      h('a', { class: 'btn btn--primary', href: '#/notes' }, pixelIcon('notes', 2), 'Add notes'),
      h('a', { class: 'btn', href: '#/words' }, pixelIcon('plus', 2), 'Add a word')),
  }));
}

/* ============================================================
   stats updates — repaint the numbers in place, never the whole screen
   ============================================================ */
function paintStats() {
  const st = stats;
  if (refs.goalHost) refs.goalHost.replaceChildren(...goalParts());
  if (refs.streakHost) { refs.streakHost.replaceChildren(...streakParts()); paintStreakCold(); }
  if (refs.line && !sayTimer) refs.line.replaceChildren(...coachLine());
  if (refs.board) refs.board.replaceChildren(...scores());
  if (refs.weekHost) refs.weekHost.replaceChildren(...weekInner());
  if (bird && restoreMood === null) bird.setMood(heroMood(st));
  // Crossing the daily goal while the screen is open earns the confetti once.
  const met = goalMet(st);
  if (met && !goalWas && refs.hero) celebrate(refs.hero);
  goalWas = met;
}

/* ============================================================
   helpers
   ============================================================ */
function titlebar(title, { icon = null, right = null } = {}) {
  return h('div', { class: 'pl-titlebar' },
    icon ? h('span', { class: 'td-titleicon' }, pixelIcon(icon, 2)) : null,
    h('span', { class: 'pl-title' }, title),
    h('span', { class: 'spacer' }),
    right);
}

/* The queue is the truth about what is waiting; /stats is the fallback. */
function counts() {
  const q = ctx.queue?.counts, s = stats?.counts;
  return {
    due: q?.due ?? s?.dueNow ?? 0,
    learning: q?.learning ?? s?.learning ?? 0,
    new: q?.new ?? s?.new ?? 0,
  };
}
function hasCounts() { return !!(ctx.queue?.counts || stats?.counts); }

function goalMet(st) {
  const goal = st?.goal || 0;
  return goal > 0 && (st?.xpToday || 0) >= goal;
}
function isFirstRun() { return (stats?.counts?.words || 0) === 0 && ctx.lessons.length === 0; }

/* Same rule as the Lessons view: the learner marked it done, or every word in
   it is mastered. */
function isDone(lesson) {
  const p = lesson?.progress;
  return lesson?.status === 'done' || !!(p && p.total > 0 && p.mastered === p.total);
}
/* A speaking learner reads the English title; the Chinese one trails as the
   reference. A character learner reads 中文 first, as before. */
function lessonLabel(lesson) {
  const zh = lesson?.titleZh;
  const en = lesson?.title || 'Lesson';
  const mode = profile().hanzi;
  if (!zh || mode === 'hidden') return [en];
  if (mode === 'small') return [en, ' · ', h('span', { class: 'zh', lang: 'zh-Hant' }, zh)];
  return [h('span', { class: 'zh', lang: 'zh-Hant' }, zh), ' · ', en];
}

function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function todayYmd() { return stats?.today || ymd(new Date()); }
function fallbackWeek() {
  const now = new Date(), out = [];
  for (let i = 6; i >= 0; i--) out.push({ date: ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)), xp: 0, reviews: 0 });
  return out;
}
function dayInitial(date) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? new Date(date + 'T12:00:00') : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  try { return d.toLocaleDateString(undefined, { weekday: 'narrow' }); } catch { return ''; }
}

export default { id: 'today', title: 'Today', render, unmount };
