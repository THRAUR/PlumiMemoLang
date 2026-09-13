/* TEMPORARY test harness — not part of the app, deleted after verification.
   Mocks fetch() with canned data so words.js / lessons.js can be screenshotted
   with populated content while the real API routes are still 404ing. */
const wordBase = (over) => ({
  pos: 'v', type: 'word', tags: [], examples: [], notes: '', lessonId: null,
  srs: { state: 'review', ease: 2.5, interval: 6, step: 0, due: '2026-09-20T08:00:00.000Z', reps: 4, lapses: 0, lastReview: '2026-09-13T08:00:00.000Z' },
  stats: { reviews: 5, correct: 4, streak: 2, history: [1, 1, 0, 1, 1] },
  ...over,
});

const W1 = wordBase({
  id: 'w1', hanzi: '謝謝', pinyin: 'xiè xie', zhuyin: 'ㄒㄧㄝˋ ˙ㄒㄧㄝ', meaning: 'thank you', meaningNative: 'merci',
  tags: ['greeting', 'polite'], lessonId: 'l1',
  examples: [{ zh: '謝謝你的幫忙。', pinyin: 'xiè xie nǐ de bāng máng', zhuyin: 'ㄒㄧㄝˋ ˙ㄒㄧㄝ ㄋㄧˇ ˙ㄉㄜ ㄅㄤ ㄇㄤˊ', translation: 'Thanks for your help.' }],
  notes: 'Common polite expression.\n- Can be doubled for emphasis\n- **Never** omit when receiving a gift',
  score: 82, band: { key: 'mastered', zh: '通', label: 'Mastered' },
});
const W2 = wordBase({ id: 'w2', hanzi: '再見', pinyin: 'zài jiàn', zhuyin: 'ㄗㄞˋ ㄐㄧㄢˋ', meaning: 'goodbye', lessonId: 'l1', score: 45, band: { key: 'seen', zh: '認', label: 'Seen' } });
const W3 = wordBase({ id: 'w3', hanzi: '請問', pinyin: 'qǐng wèn', zhuyin: 'ㄑㄧㄥˇ ㄨㄣˋ', meaning: 'excuse me, may I ask', pos: '', type: 'phrase', score: 8, band: { key: 'new', zh: '生', label: 'New' }, srs: { ...W1.srs, reps: 0, due: null, interval: 0 }, stats: { reviews: 0, correct: 0, streak: 0, history: [] } });

const DB = {
  settings: { learnerName: '', nativeLanguage: 'fr', script: 'zhuyin', level: 'beginner', dailyGoalXp: 30, newWordsPerDay: 5, theme: 'system', tts: { voice: '', rate: 0.9 }, cardTemplates: [], ai: { models: { default: 'anthropic/claude-sonnet-4.5' }, monthlyBudgetUsd: 5, apiKeyMasked: 'sk-or-…a1b2', hasApiKey: true } },
  stats: { today: '2026-09-13', xpToday: 12, goal: 30, xpTotal: 100, streak: { current: 3, best: 5, lastActive: '2026-09-12', activeToday: true }, counts: { words: 3, new: 1, seen: 1, familiar: 0, mastered: 1, dueNow: 1, learning: 0 }, week: [], usage: { todayUsd: 0, monthUsd: 0, monthBudgetUsd: 5 } },
  wordsList: { words: [W1, W2, W3], total: 3, tags: ['greeting', 'polite'] },
  wordDetail: { w1: { ...W1, lesson: { id: 'l1', title: 'Greetings' } }, w2: { ...W2, lesson: { id: 'l1', title: 'Greetings' } }, w3: { ...W3, lesson: null } },
  lessonsList: {
    lessons: [
      { id: 'l1', title: 'Greetings', titleZh: '打招呼', order: 1, status: 'done', progress: { total: 12, learned: 12, mastered: 12, avgScore: 90 } },
      { id: 'l2', title: 'Ordering food', titleZh: '點餐', order: 2, status: 'started', progress: { total: 18, learned: 10, mastered: 3, avgScore: 42 } },
      { id: 'l3', title: 'Directions', titleZh: '問路', order: 3, status: 'new', progress: { total: 0, learned: 0, mastered: 0, avgScore: 0 } },
    ],
  },
  lessonDetail: {
    l2: {
      id: 'l2', title: 'Ordering food', titleZh: '點餐', summary: 'Useful phrases for ordering at a restaurant.',
      classDate: '2026-09-11', noteId: 'n1', order: 2, status: 'started',
      sections: [{ kind: 'culture', title: 'Tipping', titleZh: '小費', body: 'Tipping is **not** expected in Taiwan.\n- Round up is fine\n- Service charge may be included' }],
      grammar: [{ pattern: '我要 + noun', explanation: 'Used to order or request something.', examples: [{ zh: '我要一杯茶。', pinyin: 'wǒ yào yì bēi chá', zhuyin: 'ㄨㄛˇ ㄧㄠˋ ㄧˋ ㄅㄟ ㄔㄚˊ', translation: 'I want a cup of tea.' }] }],
      dialogue: [
        { speaker: 'A', zh: '你要喝什麼？', pinyin: 'nǐ yào hē shén me', zhuyin: 'ㄋㄧˇ ㄧㄠˋ ㄏㄜ ㄕㄣˊ ˙ㄇㄜ', translation: 'What would you like to drink?' },
        { speaker: 'B', zh: '我要喝茶。', pinyin: 'wǒ yào hē chá', zhuyin: 'ㄨㄛˇ ㄧㄠˋ ㄏㄜ ㄔㄚˊ', translation: 'I want to drink tea.' },
      ],
      wordIds: ['w1', 'w2'], words: [W1, W2], progress: { total: 18, learned: 10, mastered: 3, avgScore: 42 },
    },
    l3: {
      id: 'l3', title: 'Directions', titleZh: '問路', summary: '', classDate: null, noteId: null, order: 3, status: 'new',
      sections: [], grammar: [], dialogue: [], wordIds: [], words: [], progress: { total: 0, learned: 0, mastered: 0, avgScore: 0 },
    },
  },
};

const origFetch = window.fetch.bind(window);
window.fetch = async (url, opt) => {
  const u = new URL(url, location.href);
  const p = u.pathname;
  const method = (opt && opt.method) || 'GET';
  let status = 200, body;
  const idFrom = () => p.split('/').pop();
  if (p === '/api/settings' && method === 'GET') body = DB.settings;
  else if (p === '/api/stats' && method === 'GET') body = DB.stats;
  else if (p === '/api/words' && method === 'GET') body = DB.wordsList;
  else if (/^\/api\/words\/[\w-]+$/.test(p) && method === 'GET') { body = DB.wordDetail[idFrom()]; if (!body) { status = 404; body = { error: 'No such word.' }; } }
  else if (p === '/api/lessons' && method === 'GET') body = DB.lessonsList;
  else if (/^\/api\/lessons\/[\w-]+$/.test(p) && method === 'GET') { body = DB.lessonDetail[idFrom()]; if (!body) { status = 404; body = { error: 'No such lesson.' }; } }
  else if (/^\/api\/lessons\/[\w-]+$/.test(p) && method === 'PUT') { body = DB.lessonDetail[idFrom()] || {}; }
  else { status = 404; body = { error: `No such endpoint: ${method} ${p}` }; }
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
};

const { initState } = await import('./js/state.js');
await initState();
const params = new URLSearchParams(location.search);
const view = params.get('view') || 'words';
const id = params.get('id');
const mod = await import(`./js/views/${view}.js`);
document.title = mod.default.title;
await mod.default.render(document.getElementById('view'), id ? { id } : {});
const clickSel = params.get('click');
if (clickSel) document.querySelector(clickSel)?.click();
window.__harnessDone = true;
