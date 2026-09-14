# PlumiMemoLang — architecture and module contract

This document is the agreement between the modules. Several modules are written
independently against it, so **its shapes and signatures are binding**. If you
need to change one, change it here first.

## 1. What the product does

One learner, taking real Traditional Chinese classes every few days, keeps the app
open on a phone (and sometimes a laptop) on the local network.

- **Notes → lessons.** After class the learner pastes or photographs raw notes.
  An OpenRouter model of their choice turns them into a *lesson card* (vocabulary,
  grammar points, dialogue, cultural tips) and a list of *words*. The learner
  reviews the draft, then imports it.
- **Words = the dictionary.** Every word ever learned, with 注音 zhuyin, pinyin,
  meaning, examples, tags, its source lesson, and a **memorization score (0–100)**
  computed from its spaced-repetition state.
- **Review = memo cards.** A spaced-repetition (SM-2 style) flashcard session over
  due cards, with several *card templates* (which side shows what).
- **Challenge.** A Duolingo-style mixed quiz built locally from known words
  (multiple choice, listening via browser TTS, type-the-pinyin, match pairs,
  reorder tiles, fill the blank). Optionally an AI-written short reading.
- **Today.** Streak, XP against a daily goal, what is due, today's AI-suggested new
  words, the lesson path, a scoreboard.
- **Settings.** OpenRouter key, model per task (importance-based routing), goals,
  script preference (zhuyin / pinyin / both), explanation language, theme, TTS
  voice, card templates, backup/restore, AI usage & cost log.

Plumi, the pixel bird, is the coach: it greets, reacts to answers, celebrates.

## 2. Stack and conventions

- Node ≥ 22.12, Express 5, ES modules everywhere (`"type": "module"`).
- No build step. The browser loads `public/app.js` as a module; views are ES
  modules under `public/js/views/`. `shared/` is served at `/shared/` so the
  browser can import `/shared/zhuyin.js` directly.
- Persistence: JSON files in `DATA_DIR` (default `./data`), one file per
  collection, written atomically (tmp + rename), debounced. See `server/store.js`.
- IDs: 12-char base36 strings from `crypto.randomUUID()`. Timestamps: ISO 8601
  strings. Dates (calendar days) are `YYYY-MM-DD` in the server's local timezone.
- Errors: every API error is `{ "error": "human readable message" }` with a 4xx/5xx
  status. The client shows `err.message` verbatim.
- Long AI work runs as a **job**: the route returns `{ jobId }` immediately, the
  client polls `GET /api/jobs/:id`.

## 3. Data shapes

### 3.1 Word (`data/words.json`, array)

```js
{
  id: "k3j9x0q2a7bz",
  hanzi: "謝謝",            // Traditional characters, the unique key (trimmed)
  pinyin: "xiè xie",       // tone MARKS, one space per syllable
  zhuyin: "ㄒㄧㄝˋ ˙ㄒㄧㄝ",  // one space per syllable; neutral tone ˙ goes FIRST
  meaning: "thank you",    // in English (the app's working language)
  meaningNative: "merci",  // in settings.nativeLanguage, optional
  pos: "v",                // n | v | adj | adv | mw (measure word) | conj | prep | part | interj | pron | num | expr | ""
  type: "word",            // character | word | phrase | sentence | grammar
  examples: [ { zh: "謝謝你的幫忙。", pinyin: "xiè xie nǐ de bāng máng", zhuyin: "…", translation: "Thanks for your help." } ],
  notes: "",               // learner's or AI's free-text note (usage, nuance)
  tags: ["greeting"],
  lessonId: "…" | null,
  noteId: "…" | null,
  createdAt: "2026-09-13T08:00:00.000Z",
  updatedAt: "…",
  srs: { state: "new", ease: 2.5, interval: 0, step: 0, due: null, reps: 0, lapses: 0, lastReview: null },
  stats: { reviews: 0, correct: 0, streak: 0, history: [1,1,0,1] } // last 20 outcomes, 1 = recalled
}
```

Every word returned by the API also carries computed fields:
`score` (0–100) and `band` (`{ key, zh, label }`, see `srs.band`). They are never
stored.

`srs.interval` is in **days** (fractional while learning: 10 min = 0.0069).
`srs.state` ∈ `new | learning | review | relearning`.

### 3.2 Lesson (`data/lessons.json`, array)

```js
{
  id, title: "Ordering food", titleZh: "點餐", summary: "One paragraph in English.",
  classDate: "2026-09-11" | null, noteId: "…" | null, createdAt, updatedAt,
  order: 3,                                  // position on the path (1-based)
  sections: [                                // free-form cards, in reading order
    { kind: "vocab" | "grammar" | "dialogue" | "culture" | "tip" | "text",
      title: "Measure words for food", titleZh: "量詞",
      body: "Plain text or light markdown (**bold**, bullet lines starting with '- ')." }
  ],
  grammar: [ { pattern: "A 比 B + adj", explanation: "…", examples: [ {zh, pinyin, zhuyin, translation} ] } ],
  dialogue: [ { speaker: "A", zh: "…", pinyin: "…", zhuyin: "…", translation: "…" } ],
  wordIds: ["…"],                            // words belonging to this lesson
  status: "new" | "started" | "done"         // set by the client when the learner opens / finishes it
}
```

The API decorates lessons with `progress: { total, learned, mastered, avgScore }`
(learned = score ≥ 25, mastered = score ≥ 75).

### 3.3 Note (`data/notes.json`, array; images under `data/uploads/<noteId>/`)

```js
{
  id, title: "Class 12", classDate: "2026-09-11" | null, text: "raw pasted notes…",
  images: [ { name: "IMG_1.jpg", type: "image/jpeg", size: 123456, file: "uploads/<id>/IMG_1.jpg" } ],
  status: "new" | "processing" | "draft" | "imported" | "error",
  jobId: "…" | null,
  draft: null | { lesson: {…Lesson fields minus id/wordIds…}, words: [ {…Word fields minus id/srs/stats…, isKnown: false} ] },
  imported: null | { lessonId, wordIds: [], mergedHanzi: [] },
  model: "…", usage: { promptTokens, completionTokens, cost }, error: null | "…",
  createdAt, updatedAt
}
```

`POST /api/notes` accepts `images: [{ name, type, dataUrl }]`; the server writes
the files and stores the metadata above. `GET /api/notes/:id/images/:name` serves them.

### 3.4 Settings (`data/settings.json`, object)

```js
{
  learnerName: "",
  nativeLanguage: "en",          // BCP-47-ish: en | fr | de | ja | … (explanations, meaningNative)
  script: "zhuyin",              // zhuyin | pinyin | both  — what readings to show
  level: "beginner",             // beginner | elementary | intermediate | advanced
  dailyGoalXp: 30,
  newWordsPerDay: 5,
  theme: "system",               // light | dark | system (also mirrored in localStorage)
  tts: { voice: "", rate: 0.9 }, // voice = SpeechSynthesisVoice.name, "" = best zh-TW
  cardTemplates: [               // memo-card templates. front/back are field lists.
    { id: "recognition", name: "Recognition", front: ["hanzi"], back: ["reading", "meaning", "example"], builtin: true, enabled: true },
    { id: "production",  name: "Production",  front: ["meaning"], back: ["hanzi", "reading", "example"], builtin: true, enabled: true },
    { id: "sound",       name: "Sound",       front: ["reading"], back: ["hanzi", "meaning", "example"], builtin: true, enabled: false },
    { id: "listening",   name: "Listening",   front: ["audio"],   back: ["hanzi", "reading", "meaning"], builtin: true, enabled: false },
    { id: "cloze",       name: "Fill the blank", front: ["cloze"], back: ["hanzi", "reading", "example"], builtin: true, enabled: false }
  ],
  ai: {
    apiKey: "",                  // never returned by the API; GET gives apiKeyMasked + hasApiKey
    priority: ["google/gemini-3.5-flash-lite", "google/gemini-3.1-flash-lite", "deepseek/deepseek-v4-flash", "google/gemini-2.5-flash-lite"],  // tried top to bottom; only ids from server/ai/models.js
    monthlyBudgetUsd: 5
  }
}
```

Field names usable in a template: `hanzi`, `reading` (zhuyin/pinyin per
`settings.script`), `meaning`, `example`, `audio` (a play button, TTS of hanzi),
`cloze` (an example sentence with the word blanked), `notes`, `tags`.

### 3.5 Progress (`data/progress.json`, object)

```js
{
  xpTotal: 0,
  streak: { current: 0, best: 0, lastActive: "2026-09-12" | null },
  days: { "2026-09-13": { xp: 12, reviews: 6, correct: 5, newWords: 2, challenges: 0, minutes: 4 } },
  challenges: [ { id, at, type: "mixed" | "lesson" | "reading", lessonId, score, total, xp } ]  // last 100
}
```

XP rules (server-side, in `server/stats.js`): review card graded +2 (+1 if Good/Easy);
challenge question correct +2; session/challenge completed +5; note imported +10;
suggestion accepted +1. A day with xp > 0 counts for the streak.

### 3.6 Suggestions (`data/suggestions.json`, object keyed by date)

```js
{ "2026-09-13": { model, generatedAt, items: [ { hanzi, pinyin, zhuyin, meaning, meaningNative, pos, why, example: {zh,pinyin,zhuyin,translation}, tags, status: "open" | "added" | "dismissed", wordId } ] } }
```

### 3.7 Usage log (`data/usage.json`, array, append-only)

```js
{ id, at, task: "extract", model, promptTokens, completionTokens, cost: 0.0123, ms: 4200, ok: true, error: null }
```

### 3.8 Jobs (in memory only)

```js
{ id, kind: "extract" | "suggest" | "reading" | "enrich", status: "queued" | "running" | "done" | "error", progress: "Reading your notes…", result: any, error: null | "…", createdAt, finishedAt }
```

## 4. Server modules

### 4.1 `server/config.js`
`export const config = { root, port, host, dataDir, publicDir, sharedDir, envApiKey }`.

### 4.2 `server/store.js`
```js
export async function initStore()                     // creates DATA_DIR + uploads/, loads files
export function coll(name)                            // array collections: words, lessons, notes, usage
//   .all() → array (live, do not mutate)   .get(id)   .find(fn)   .filter(fn)
//   .insert(doc) → doc (adds id/createdAt/updatedAt)   .update(id, patchOrFn) → doc | null
//   .remove(id) → bool   .replaceAll(array)   .save() (forces a flush)
export function doc(name, defaults)                   // object files: settings, progress, suggestions, models-cache
//   .get() → object (live)   .set(patchOrFn) → object   .save()
export function newId()
export async function flushAll()                      // awaited on SIGINT/SIGTERM
```

### 4.3 `server/jobs.js`
```js
export function createJob(kind, runner /* async (job) => result */) → job   // runs immediately, keeps last 50
export function getJob(id) → job | null
export function setProgress(job, text)
```

### 4.4 `server/srs.js` (pure, no I/O)
```js
export const GRADE = { AGAIN: 0, HARD: 1, GOOD: 2, EASY: 3 };
export const DAY_MS, MIN_MS;
export function newSrs() → srs
export function schedule(srs, grade, now = Date.now()) → srs        // pure, returns a new object
export function preview(srs, now = Date.now()) → { again: {ms, label}, hard: {…}, good: {…}, easy: {…} }
export function isDue(srs, now = Date.now()) → boolean               // new cards are never "due"; they are "new"
export function score(srs, stats, now = Date.now()) → 0..100           // memorization score
export function band(score) → { key: "new"|"seen"|"familiar"|"mastered", zh: "生"|"認"|"熟"|"通", label: "New"|"Seen"|"Familiar"|"Mastered", min, max }
export function buildQueue(words, { now, limitNew, limitTotal, lessonId, includeNew = true }) → { cards: Word[], counts: { due, learning, new, total } }
export function formatInterval(ms) → "10m" | "1d" | "3d" | "2w" | "1mo" | "3mo" | "1y"
export function recordOutcome(stats, recalled: boolean) → stats       // reviews/correct/streak/history(20)
```
Scheduling (Anki-flavoured SM-2, deterministic):
- Learning steps: `[10 min, 1 day]`. New + Again/Hard → step 0 (10 min). New + Good →
  step 1 (1 day... no: step 0 → due in 10 min; a second Good → graduate to 1 day).
  Precisely: `step` indexes the steps array; Good advances one step; past the
  last step the card graduates to `review` with interval 1 day. Easy graduates
  immediately with interval 4 days. Again resets to step 0.
- Review: Again → `relearning`, step 0 (10 min), `lapses+1`, ease −0.20 (floor 1.3),
  interval = max(1, round(interval × 0.3)). Hard → interval × 1.2, ease −0.15.
  Good → interval × ease. Easy → interval × ease × 1.3, ease +0.15. Interval is
  rounded to whole days, minimum 1 day, maximum 365 days. Ease ceiling 3.0.
- Relearning + Good/Easy → back to `review` with the reduced interval (min 1 day).
- `score`: 0 when `reps === 0`. Otherwise `R = 0.9^(elapsedDays / intervalDays)`
  (interval floored at 0.25 d), `S = min(1, intervalDays / 45)`,
  `acc` = share of recalled outcomes in `stats.history` (1 if empty).
  `score = round(100 × R × (0.35 + 0.65 × S) × (0.6 + 0.4 × acc))`, capped at 35
  while `state` is `learning`/`relearning`. Bands: 0–24 new 生, 25–49 seen 認,
  50–74 familiar 熟, 75–100 mastered 通.
- `buildQueue` order: learning/relearning due (most overdue first) → review due
  (most overdue first) → new (oldest `createdAt` first, up to `limitNew`). Then cut
  at `limitTotal`. `lessonId` filters by `word.lessonId`.

### 4.5 `shared/zhuyin.js` (pure, ES module, works in Node and browsers)
```js
export function pinyinToZhuyin(pinyin) → string       // "xiè xie" | "xie4 xie5" | "xie4xie5" → "ㄒㄧㄝˋ ˙ㄒㄧㄝ"
export function zhuyinToPinyin(zhuyin) → string       // "ㄒㄧㄝˋ ˙ㄒㄧㄝ" → "xiè xie"
export function numbersToMarks(pinyin) → string       // "ni3 hao3" → "nǐ hǎo"; "lü4"/"lv4" → "lǜ"
export function marksToNumbers(pinyin) → string       // "nǐ hǎo" → "ni3 hao3"; neutral → 5
export function splitSyllables(pinyin) → string[]     // "nǐhǎo" → ["nǐ","hǎo"] (greedy, longest-first, valid-syllable table)
export function normalizePinyin(pinyin, { tones = true } = {}) → string   // lowercase, marks→numbers, no spaces/apostrophes/hyphens, ü→v; tones:false strips digits
export function pinyinMatches(typed, expected, { tones = true } = {}) → boolean
export function isHanzi(ch) → boolean                 // CJK Unified Ideographs (incl. ext A, compat)
export function hanziChars(str) → string[]            // only the ideographs, in order
export function alignReading(hanzi, reading) → (string|null)[]   // per-character syllables when counts match, else null
export const ZHUYIN_TONES = { 1: "", 2: "ˊ", 3: "ˇ", 4: "ˋ", 5: "˙" };
```
Zhuyin conventions: tone 1 unmarked; ˊ ˇ ˋ appended after the syllable; the neutral
tone ˙ is written **before** the syllable. Syllables separated by one space.
Handle: `ü` (`lü`, `nü`, and `ju/qu/xu/yu` where u = ü), `er`, `zhi/chi/shi/ri/zi/ci/si`
(bare initials ㄓㄔㄕㄖㄗㄘㄙ), `yi/wu/yu` forms, `ong/iong/ueng`, `iu → ㄧㄡ`,
`ui → ㄨㄟ`, `un → ㄨㄣ`, `ün → ㄩㄣ`.

### 4.6 `server/openrouter.js`
```js
export class OpenRouterError extends Error   // .status, .body
export async function listModels({ apiKey, refresh = false }) → Model[]
//  Model = { id, name, contextLength, pricing: { prompt, completion, image } /* USD per token, numbers */,
//            inputModalities: ["text","image"], supportsStructured: boolean, supportsJson: boolean, created }
//  Cached in doc("models-cache") for 24 h. Works without a key (the endpoint is public) but sends it if present.
export async function chat({ apiKey, model, messages, schema = null, schemaName = "result",
                             temperature = 0.3, maxTokens = 4096, timeoutMs = 180000, signal }) →
//  { text, json, usage: { promptTokens, completionTokens, totalTokens, cost }, model, id }
//  - POST https://openrouter.ai/api/v1/chat/completions with headers Authorization, "HTTP-Referer":
//    "https://github.com/THRAUR/PlumiMemoLang", "X-Title": "PlumiMemoLang"; body includes usage: { include: true }.
//  - If schema: response_format json_schema {name, strict: true, schema} when the model supports
//    structured outputs; else json_object when supported; else instruct in the prompt. Always run
//    extractJson() on the text; on parse failure retry ONCE with a "reply with only the JSON" nudge.
//  - images travel inside messages as { type: "image_url", image_url: { url: "data:…" } } parts.
export function extractJson(text) → any            // strips code fences, finds the outermost {…} or […]
export function estimateCost(model /* Model */, usage) → number | null
export function maskKey(key) → "sk-or-…a1b2" | ""
```

### 4.7 `server/ai/tasks.js`
```js
export const TASKS = {
  extract: { id, label: "Notes → lesson", importance: "high",   why: "…", defaultTemperature },
  suggest: { id, label: "Daily new words",  importance: "medium" },
  reading: { id, label: "Reading challenge", importance: "medium" },
  enrich:  { id, label: "Complete a word",   importance: "low" },
  explain: { id, label: "Explain / ask",     importance: "low" },
  test:    { id, label: "Connection test",   importance: "low" }
};
export function resolveChain(settings, { images, prefer }) → string[] // the allowed models to try, in order (server/ai/models.js)
export function resolveModel(settings, taskId, opts) → string  // the first model of that chain
export function resolveApiKey(settings) → string               // settings.ai.apiKey || config.envApiKey
export async function runTask(taskId, input, { settings, onProgress, prefer, only }) → { result, usage, model, fallbacks }
//  Tries each model of the chain in turn: a failure that belongs to one model moves on to the next, a rejected
//  key or an empty balance stops at once. `prefer` goes first; `only` tries that one model with no backup.
//  Builds messages + schema for the task, calls openrouter.chat, validates/normalises the result
//  (fills zhuyin from pinyin with shared/zhuyin.js when missing, trims, dedupes words by hanzi),
//  appends to coll("usage"). Throws Error("…") with a human message on failure.
```
Task inputs → results:
- `extract` `{ title, classDate, text, images: [{ dataUrl }], learner: { nativeLanguage, level, script }, knownHanzi: string[] }`
  → `{ lesson: { title, titleZh, summary, sections, grammar, dialogue }, words: [ WordDraft ] }`.
  WordDraft = Word fields `hanzi, pinyin, zhuyin, meaning, meaningNative, pos, type, examples, notes, tags` plus
  `isKnown` (true when `hanzi` is in `knownHanzi`). Instruct: Traditional characters only (Taiwan usage),
  every syllable's pinyin with tone marks and zhuyin with tone symbols, one space per syllable, 6–40 words,
  every example sentence uses only words at the learner's level where possible.
- `suggest` `{ known: string[], level, recentTopics: string[], count, nativeLanguage }` → `{ items: [SuggestionItem] }`
  (never suggest a hanzi already in `known`; useful, frequent, thematically close to recent lessons; include `why`).
- `enrich` `{ word: Partial<Word>, nativeLanguage }` → `{ pinyin, zhuyin, meaning, meaningNative, pos, type, examples, notes }`.
- `explain` `{ word: Word, question, nativeLanguage }` → `{ answer }` (markdown-lite, ≤ 200 words).
- `reading` `{ words: Word[], level, nativeLanguage }` → `{ title, passage: {zh, pinyin, zhuyin, translation}, questions: [ { q, options: [4 strings], answerIndex } ] }`.
- `test` `{}` → `{ reply }` (one short sentence).

### 4.8 `server/stats.js`
```js
export function today() → "YYYY-MM-DD"
export function addXp(amount, { kind, extra }) → progress    // updates days[today], streak, xpTotal
export function bumpDay(fields /* {reviews, correct, newWords, challenges, minutes} */) → progress
export function getStats() → {
  today, xpToday, goal, xpTotal, streak: { current, best, lastActive, activeToday },
  counts: { words, new, seen, familiar, mastered, dueNow, learning },
  week: [ { date, xp, reviews } × 7 ] (oldest first, ends today),
  usage: { todayUsd, monthUsd, monthBudgetUsd }
}
```

## 5. REST API (all JSON, prefix `/api`)

| Method & path | Body → Response |
|---|---|
| `GET /health` | `{ ok: true, version, dataDir }` |
| `GET /settings` | Settings with `ai.apiKey` removed, plus `ai.apiKeyMasked`, `ai.hasApiKey` |
| `PUT /settings` | partial Settings (deep-merged; `ai.apiKey` accepted, `""` clears) → same as GET |
| `GET /models?refresh=1` | the allowed models only, in the learner's order: `Model` fields (4.6) plus `name, vision, why, rank, recommendedRank, inCatalog` |
| `POST /ai/test` | `{ model? }` → `{ ok, model, reply, usage, fallbacks }`. With `model`, only that model is tried; without it, the whole list. A model off the list is a 400 |
| `GET /stats` | see 4.8 |
| `GET /words?q=&lessonId=&tag=&type=&band=&sort=score|recent|alpha|due&dir=asc|desc` | `{ words: Word[], total, tags: string[] }` (`q` matches hanzi, pinyin (tone-insensitive), zhuyin, meaning, meaningNative, tags) |
| `POST /words` | WordDraft → `201 Word`, or `200 { word, merged: true }` when `hanzi` already exists (fills empty fields only) |
| `GET /words/:id` | Word + `lesson: { id, title } | null` |
| `PUT /words/:id` | partial Word (not `srs`/`stats`/`id`) → Word |
| `DELETE /words/:id` | `{ ok: true }` (also removes from lesson.wordIds) |
| `POST /words/:id/enrich` | `{}` → `{ jobId }` (job result: updated Word) |
| `POST /words/:id/explain` | `{ question }` → `{ answer, usage }` (synchronous) |
| `POST /words/:id/reset` | `{}` → Word (srs + stats reset) |
| `GET /words/export?format=json|csv` | file download (`Content-Disposition`) |
| `GET /lessons` | `{ lessons: Lesson[] }` with `progress`, sorted by `order` |
| `POST /lessons` | `{ title, titleZh?, summary?, sections?, grammar?, dialogue?, wordIds? }` → `201 Lesson` |
| `GET /lessons/:id` | Lesson + `words: Word[]` |
| `PUT /lessons/:id` | partial → Lesson |
| `DELETE /lessons/:id` | `{ ok: true }` (words keep existing, `lessonId` cleared) |
| `POST /lessons/reorder` | `{ ids: [] }` → `{ ok }` |
| `GET /notes` | `{ notes: Note[] }` (without `draft`, without `text` beyond 200 chars as `excerpt`) |
| `POST /notes` | `{ title, classDate, text, images: [{name,type,dataUrl}] }` → `201 Note` |
| `GET /notes/:id` | full Note |
| `PUT /notes/:id` | `{ title?, classDate?, text? }` → Note |
| `DELETE /notes/:id` | `{ ok }` (deletes uploads) |
| `GET /notes/:id/images/:name` | the image file |
| `POST /notes/:id/process` | `{ model? }`, an allowed model to start with, the rest of the list as backup → `{ jobId }`; on completion note.status = draft |
| `PUT /notes/:id/draft` | `{ draft }` → Note (the learner edited the draft before importing) |
| `POST /notes/:id/import` | `{ words: [indexes into draft.words] | "all", lesson: true }` → `{ lessonId, wordIds, mergedHanzi, xp }` |
| `GET /review/queue?limit=20&lessonId=&newLimit=` | `{ cards: Word[] (each with `preview`), counts, templates: enabled templates }` |
| `POST /review/grade` | `{ wordId, grade: 0-3, templateId, ms }` → `{ word, xp, stats }` |
| `POST /review/finish` | `{ reviewed, correct, ms }` → `{ xp, stats }` (session bonus) |
| `POST /challenge/build` | `{ size: 10, lessonId?, types?: string[], reading?: boolean }` → `{ id, questions: Question[] }` or `{ jobId }` if `reading` |
| `POST /challenge/finish` | `{ id, type, lessonId?, answers: [ { index, wordId, correct, ms } ] }` → `{ score, total, xp, stats }` (a correct answer also calls `recordOutcome` on the word — not `schedule`) |
| `GET /suggestions/today` | `{ date, status: "ready"|"none"|"generating"|"no-key", items, jobId? }` (generates once per day if a key exists and nothing is cached) |
| `POST /suggestions/refresh` | `{}` → `{ jobId }` |
| `POST /suggestions/:index/accept` | `{}` → `{ word, xp }` |
| `POST /suggestions/:index/dismiss` | `{}` → `{ ok }` |
| `GET /jobs/:id` | Job |
| `GET /usage` | `{ entries: last 200, totals: { todayUsd, monthUsd, allUsd, calls } }` |
| `GET /backup` | download of every collection as one JSON |
| `POST /backup/restore` | that JSON → `{ ok, counts }` |

Question shapes (`POST /challenge/build`):
```js
{ type: "mc-meaning", wordId, prompt: { hanzi, reading }, options: [ { id, text } ], answerId }
{ type: "mc-hanzi",   wordId, prompt: { meaning },         options: [ { id, hanzi, reading } ], answerId }
{ type: "listen",     wordId, prompt: { tts: hanzi },       options: [ { id, hanzi, reading } ], answerId }
{ type: "type-pinyin", wordId, prompt: { hanzi, meaning }, answer: { pinyin, zhuyin } }   // compare with pinyinMatches(typed, answer.pinyin, {tones:false}) OR exact zhuyin
{ type: "match",      pairs: [ { id, hanzi, meaning, wordId } ] }  // 4–5 pairs
{ type: "order",      wordId, prompt: { translation }, tiles: [ { id, text } ] /* shuffled */, answer: [ids in order] }  // from an example ≤ 12 chars, tiles = characters
{ type: "cloze",      wordId, prompt: { sentence: "我▢你", translation }, options: [ { id, hanzi } ], answerId }
```
Mixed sessions draw from words with `reps > 0` first (things worth testing), then new
ones if needed; a lesson challenge draws from that lesson only. Distractors come from
other words (same `pos` when possible).

## 6. Client

### 6.1 Files and load order
`index.html` loads, in order: `theme.js` (sync, before CSS: sets `data-theme`),
`plume.css` (tokens + primitives), `app.css` (shell + kit), one `css/<view>.css`
per view, then `app.js` (module). `app.js` calls `initState()`, `initRouter()`,
`initShell()`.

### 6.2 Modules (`public/js/`)
- `api.js` — `api.get/post/put/del(url, body)` (throws `Error(server message)`),
  `api.job(jobId, { onProgress, intervalMs = 1500 })` polls until done/error.
- `state.js` — live bindings `settings`, `stats`; setters `setSettings(s)`,
  `setStats(s)`; `on(event, fn)` / `emit(event, data)` for `settings`, `stats`, `xp`
  (`{ amount }` after a gain). `refreshStats()` refetches `/api/stats`.
- `router.js` — hash routes: `#/today` (default), `#/lessons`, `#/lessons/:id`,
  `#/review` (+ `?lesson=id`), `#/words`, `#/words/:id`, `#/challenge` (+ `?lesson=`),
  `#/notes`, `#/notes/:id`, `#/settings`. `navigate(path)`, `current()`.
  A view module exports `default { id, title, render(root, params), unmount? }`.
- `ui.js` — `h(tag, attrs, ...children)`; `esc`; `toast(text, kind)`;
  `openWindow({ title, body, actions, wide, onClose })` → `{ close, el }` (a Mac
  window over a scrim); `confirmWindow({ title, text, okLabel, danger })` → Promise<bool>;
  `progress(value, max)` element; `celebrate(root)` pixel confetti; `tts.speak(text)`,
  `tts.voices()`; `fmt.rel(iso)`, `fmt.date(iso|ymd)`, `fmt.n(number)`, `fmt.usd(n)`;
  `openSession({ title, onClose })` → `{ el, body, footer, setProgress(0..1), close() }`
  (full-screen layer for review/challenge; hides the tab bar);
  `feedback(session, { ok, title, detail, actionLabel, onAction })` (the Duolingo
  banner rising from the bottom); `readingFor(word)` (respects `settings.script`).
- `pixel.js` — `renderPixels(el)`, `pixel(name, cell)` → element, `ART` registry.
- `bird.js` — `createBird({ size = 4, mood = "idle" })` → `{ el, setMood(m), say(text, ms) }`,
  moods: `idle | happy | think | sad | cheer | sleep`.
- `hanzi.js` — `hanziEl(word|{hanzi, zhuyin, pinyin}, { reading, size })` → element with `<ruby>` when
  the reading aligns per character (uses `alignReading` from `/shared/zhuyin.js`),
  else the reading on a line beneath; `readingLine(word)`.

### 6.3 UI kit (classes in `app.css`)
Shell: `.app`, `.rail` (desktop left nav), `.topbar`, `.view`, `.tabbar` (mobile),
`.session` (full-screen layer). Kit: `.btn` (+ `.btn--primary .btn--ghost .btn--danger
.btn--block .btn--lg .btn--sm .btn--icon`), `.card` (+ `.card--sunk .card--hover`),
`.pl-win/.pl-titlebar/.pl-title/.pl-close/.win-body`, `.pl-eyebrow`, `.pl-tag`
(+ `.on .due .bad .good`), `.pill`, `.field/.label/.input/.textarea/.select`, `.row`,
`.stack`, `.grid-2`, `.scoreboard/.score`, `.meter` (score bar 0–100, `.meter-fill`),
`.progress` (session bar) `.progress-fill`, `.hz` (hanzi, `.hz--xl .hz--lg .hz--md`),
`.reading` (pinyin in mono / zhuyin in CJK), `.list/.list-row`, `.empty` (empty
state with a bird), `.banner` (`.banner--ok .banner--bad`), `.option` (answer tile,
`.is-selected .is-correct .is-wrong`), `.tile` (order/match tiles), `.path/.path-node`
(`.is-done .is-current .is-locked`), `.streak`, `.xp`, `.ring` (daily goal).

## 7. Additions and deviations recorded during the build (2026-09-13)

The modules were written against the contract above; these are the places where
the code adds to it or deliberately differs. The code is right; treat this list
as the amendment.

- **SRS relearning is one step.** A lapsed card graded Good/Easy at its 10-minute
  relearning step goes straight back to `review` with the interval the lapse
  reduced (Anki's default). `buildQueue().counts`: `due` = learning+review cards
  due before the `limitTotal` cut, `learning` = the learning/relearning subset,
  `new` = new cards pulled in, `total` = cards returned.
- **Extra exports.** `server/openrouter.js`: `strictify(schema)`, `cachedModel(id)`.
  `server/ai/tasks.js`: `hasApiKey(settings)` (the no-key test; `resolveApiKey`
  THROWS when there is no key), `TASK_IDS`. `server/stats.js`: `readSettings()`
  (defaults deep-merged over the stored doc — every router reads settings through
  it), `usageTotals()`, `shiftDay()`. `server/lib/words.js`: `upsertWord` (the one
  dedupe-by-hanzi door used by POST /words, note import and suggestions),
  `fileWordInLesson(wordId, lessonId, prevLessonId)` (keeps `lesson.wordIds` in
  step when a word is created or moved with a `lessonId`).
- **Settings.** `GET /settings` also returns `ai.keySource: "settings" | "env" | "none"`.
- **Words.** `POST /words` → `201 Word` or `200 { word, merged: true }`.
  `GET /words?lessonId=none` lists unfiled words. CSV: every field quoted, tags
  joined with `; `, CRLF, UTF-8 BOM.
- **Notes.** List rows carry `excerpt`, `imageCount`, `hasDraft`, `draftWords`.
  `PUT /notes/:id` also accepts `status`. `POST /notes/:id/import` returns
  `{ lessonId, wordIds, mergedHanzi, created, xp, stats }`. Processing without a
  key is a `400` ("Add your OpenRouter API key first."), not a failed job.
- **Challenge.** `POST /challenge/build` accepts `seed` for deterministic output;
  question ids are `q1…`, option ids `a`–`d`, tiles `t1…`, pairs `p1…`. A `reading`
  job returns `{ id, questions: [{ type: "reading", title, passage, questions: [{ q, options: [{id,text}], answerId }] }], model, usage }`.
  `finish` caps answers at what was asked and forgets the id afterwards.
- **Suggestions.** `GET /suggestions/today` never returns `"none"`: a cached day is
  `"ready"` even with zero items. `accept` returns `{ word, xp, stats }`.
- **Client.** `setTitle()` lives in `ui.js` (nothing imports `app.js`). Session views
  accept `?demo=1` for an offline walkthrough. `theme.js` honours `?theme=light|dark`
  on the URL (screenshots and tests).
- **Environment.** `MEMOLANG_PORT` (falls back to `PORT`), `MEMOLANG_HOST` (the
  generic `HOST` is ignored on purpose), `MEMOLANG_DATA_DIR` (falls back to `DATA_DIR`).
- **Dev tools.** `scripts/seed.mjs` seeds a server from `test/fixtures/seed.json`;
  `scripts/qa.sh` boots a throwaway server and screenshots every screen at phone
  and desktop widths, reporting console errors; `scripts/cdp.mjs` drives headless
  Chromium step by step (click / type / key / shot) for session flows;
  `public/kit.html` is the static kit showcase.
- **Allowed models (added later the same day).** The OpenRouter key carries a guardrail
  allow-list, and OpenRouter answers any other model id with 404. `server/ai/models.js`
  holds the four allowed ids, the recommended order and the reasons for it.
  `settings.ai.models` (one model per task) is retired: `settings.ai.priority` is the
  order, `GET /settings` always returns it complete, and `PUT` rejects ids off the list.
  `runTask()` walks the order and falls back on any failure that belongs to one model;
  a rejected key or an empty balance stops at once. Photo notes skip text-only models.
  The extract timeout is 3 min per attempt, so three attempts fit inside the 10 minutes
  the client waits on a job.

## 8. Goals, speaking-first learning and documents (2026-09-13, evening)

After using the app, the learner reported three things the first build got wrong or
lacked:

1. On a phone some UI broke: the goal ring's label, the date field in Notes, and more.
2. They want to SPEAK. Their notes carry characters, pinyin and English; they rely on
   pinyin and English and keep characters only to check the original meaning. Screens
   that drill characters do not help them. The app must ask each learner's goals and
   adapt to them.
3. They want to upload documents, such as a scanned book as a PDF, pick pages ("9–11 and
   25"), get one or several lessons from them, keep the document if they agree, and pick
   new pages from it after a later class.

This section is the contract for that work and is binding like §1–§6.

### 8.1 Settings additions

```js
settings.goals = {
  onboardedAt: null,           // ISO string once the welcome questions are answered; null → the app opens #/welcome
  skills: ['speak', 'listen'], // subset of speak | listen | read | write | type
  reasons: [],                 // subset of REASONS ids in shared/goals.js
  classes: 'regular',          // regular | sometimes | none
  about: '',                   // ≤ 500 chars the AI reads as context ("classes with Carl twice a week")
}
settings.display = {
  hanzi: '',                   // '' (follow the focus) | full | small | hidden: how prominent characters are
}
// settings.script stays: pinyin | zhuyin | both, which reading is shown
```

`cardTemplates` gains the builtin `say` and the new field `record`. `readSettings()`
normalises the stored list with `normaliseTemplates()`: every builtin is present (missing
ones appended, disabled), a builtin's name, front and back always follow the code, and
`enabled` stays the learner's choice. Custom templates are kept as they are.

| id | name | front | back | fits |
|---|---|---|---|---|
| recognition | Characters → meaning | hanzi | reading, meaning, example | characters |
| production | Meaning → characters | meaning | hanzi, reading, example | characters |
| say | Say it | meaning, record | reading, audio, example, hanzi | speaking |
| sound | Reading → meaning | reading | meaning, audio, example, hanzi | speaking |
| listening | Listen | audio | meaning, reading, hanzi | speaking |
| cloze | Fill the blank | cloze | hanzi, reading, example | characters |

`record` renders `recordControl()` from `public/js/speech.js`. When the learner recorded on
the front, the back shows "Play mine" next to the model's audio.

### 8.2 `shared/goals.js` (pure; Node and browser)

```js
export const SKILLS            // [{ id, label, hint }]  speak, listen, read, write, type
export const REASONS           // [{ id, label }]
export const CLASSES           // [{ id, label }]  regular, sometimes, none
export const HANZI_MODES       // ['full', 'small', 'hidden']
export const TEMPLATE_FIELDS   // hanzi, reading, meaning, example, audio, cloze, notes, tags, record
export const BUILTIN_TEMPLATES // the table above, without `enabled`
export const CHALLENGE_TYPES   // [{ id, label, fits: 'speaking' | 'characters' | 'both' }]
export const DEFAULT_GOALS
export function normaliseGoals(raw) → goals
export function focusOf(goals) → 'speaking' | 'characters' | 'balanced'
export function defaultHanziMode(focus) → 'small' | 'full'
export function recommendedTemplates(focus) → string[]
export function recommendedChallengeTypes(focus) → string[]
export function normaliseTemplates(list) → template[]
export function learnerProfile(settings) → { goals, focus, speaking, characters, hanzi, script, templates, challengeTypes, onboarded }
```

Focus is `speaking` when skills include speak or listen and neither read nor write;
`characters` when they include read or write and neither speak nor listen; `balanced`
otherwise, including no answer yet. Typing does not change the focus.

Recommended templates: speaking → say, listening, sound; characters → recognition,
production, cloze; balanced → recognition, say, listening.

### 8.3 Display rules (client)

`public/js/ui.js` exposes `profile()` (the learnerProfile of the live settings) and
`hanziMode()`. `public/js/hanzi.js` adds:

- `wordHero(word, { size: 'xl' | 'lg' | 'md' | 'sm' })`: the word as the hero of a card. In
  `full` mode it is the existing ruby hanzi. In `small` mode the reading is large
  (pinyin in JetBrains Mono, zhuyin in the CJK face) with the characters small and muted
  underneath. In `hidden` mode it is the reading only.
- `wordLine(word)`: the compact form for list rows, primary text plus secondary, by the
  same rules.
- `exampleEl(example, { speak })`: an example sentence. In speaking focus the reading
  line comes first and larger, then the translation, then the characters small.

Every screen that shows a word as its main content uses these. `hanziEl` stays for places
where characters ARE the question: the recognition template, cloze and mc-hanzi.

### 8.4 Speaking practice

`public/js/speech.js`:

```js
export const recording           // { supported }: getUserMedia + MediaRecorder + secure context
export function createRecorder({ maxMs })  // { start(), stop() → Promise<{ url, blob, ms }>, cancel(), release(), state }
export function recordControl({ label, maxMs, onTake })  // { el, take, reset(), destroy() }: mic button, timer, "Play mine"
export const recognition         // { supported }: SpeechRecognition / webkitSpeechRecognition
export function listenOnce({ lang = 'zh-TW', timeoutMs })  // Promise<{ text, alternatives, confidence }>
export function hanziMatch(heard, expected) → 0..1  // share of the expected characters heard, in order
```

Recording needs a secure context. The live app is HTTPS through tailscale, and localhost
counts as secure. With no microphone or no permission the control hides or explains;
with no recognition the learner grades themselves.

New challenge question types in `server/lib/challenge.js`:

```js
{ type: 'listen-meaning', id, wordId, prompt: { tts, pinyin, zhuyin, hanzi }, options: [{ id, text }], answerId }
{ type: 'mc-pinyin',     id, wordId, prompt: { meaning, hanzi }, options: [{ id, pinyin, zhuyin }], answerId }   // distractors include a tone variant
{ type: 'tones',         id, wordId, prompt: { tts, bare, meaning, hanzi }, options: [{ id, pinyin }], answerId } // bare = pinyin without marks
{ type: 'order-pinyin',  id, wordId, prompt: { translation, tts }, tiles: [{ id, text }], answer: [ids], full: { zh, pinyin } }
{ type: 'speak',         id, wordId, prompt: { meaning, context }, answer: { pinyin, zhuyin, hanzi, tts } }
```

`match` pairs also carry `pinyin` and `zhuyin`. `POST /challenge/build` accepts `focus`;
without `types` the defaults are `recommendedChallengeTypes(focus)`. The client renders
every type by the display rules: in speaking focus `mc-meaning` shows the reading as the
prompt, `type-pinyin` shows the meaning, and `match` pairs readings with meanings.

Build notes from the speaking work: `mc-meaning` prompts also carry `pinyin` and `zhuyin`;
a hand-picked `types` list the pool cannot build is a 400 that says so; types are ordered
from recognising to producing, with a seeded pick when there are more types than
questions. Tone variants change exactly one syllable and never touch 不 or 一, a neutral
tone, or a 2↔3 change before a third tone, because tone sandhi (nǐ hǎo is said ní hǎo)
would mark a good ear wrong. `server/lib/challenge.js` also exports `toneVariants`,
`bareReading`, `readingsOf` and `FOCI`.

### 8.5 AI: goals in every prompt, several lessons from one source

- `learnerFrom()` adds `goals`, `focus` and `hanzi`. `systemPrompt()` describes them. In
  speaking focus it asks for phrases and sentence patterns the learner can say today,
  natural spoken Taiwanese Mandarin, example sentences short enough to repeat (about 14
  syllables at most), tone and tone-sandhi notes where useful, and no stroke-order or
  radical trivia. Every Chinese string still gets characters, pinyin and zhuyin.
- `extract` returns `{ lessons: [ { lesson, words } ] }` with 1 to 4 lessons. Input gains
  `split: 'one' | 'auto' | 'per-range'`, `pages: [{ pdf, printed }]` and `instructions`.
  `one` means exactly one lesson, `per-range` one lesson per page range, and `auto` one per
  coherent unit or topic, at most 4. Notes without a document use `one`.
- A draft stored before this change (`{ lesson, words }`) is read as
  `{ lessons: [ { lesson, words } ] }` everywhere.

### 8.6 Documents (materials)

Data: `data/materials.json` (array). Files live under `data/materials/<id>/`: `source.pdf`
and a `thumbs/` cache.

```js
Material {
  id, title, fileName, size, pageCount,
  kind: 'pdf',                  // office files are converted to PDF on upload
  keep: true,                   // the learner agreed to keep it in the library
  pageOffset: 0,                // printed page p is PDF page p + pageOffset
  textLayer: false,             // pdftotext found text on the first pages
  covered: [ { pages: [9, 10, 11, 25], lessonIds: [], noteId, at } ],   // PDF numbering
  createdAt, updatedAt
}
```

Documents need poppler (`pdfinfo`, `pdftoppm`, `pdftotext`); office conversion needs
`soffice`. Both are probed at boot. The UI hides what the box cannot do and says why.

| Method & path | Body → Response |
|---|---|
| `GET /capabilities` | `{ documents, office, officeTypes, reasons: { documents?, office? } }`. `officeTypes` lists the extensions this machine converts: here .pptx, .ppt and .odp, because LibreOffice has Impress but no Writer |
| `POST /materials?name=&title=&keep=1\|0` | raw file bytes, streamed (PDF; .docx .doc .pptx .ppt .odt .odp .rtf when office), ≤ 500 MB → `201 Material` |
| `GET /materials` | `{ materials }`: kept ones plus ones a note still uses, newest first |
| `GET /materials/:id` | Material |
| `PUT /materials/:id` | `{ title?, keep?, pageOffset? }` → Material |
| `DELETE /materials/:id` | `{ ok }`; lessons and notes made from it stay |
| `GET /materials/:id/file` | the PDF, inline |
| `GET /materials/:id/pages/:n/thumb?w=240` | `image/jpeg` of PDF page n (1-based), w from 120 to 800, cached |
| `POST /materials/:id/lessons` | `{ pages: "9-11, 25", numbering: "printed" \| "pdf", split, instructions, title?, classDate?, model? }` → `{ noteId, jobId, pages }` |

`POST /materials/:id/lessons` creates a Note that points at the pages
(`note.source = { materialId, title, pages, printed, split }`, with `note.text` holding the
instructions) and starts the same job as `POST /notes/:id/process`. That job renders each
page to JPEG (at most 1600 px) and adds the page's text layer when there is one. At most
20 pages per run. On import, `material.covered` records the pages. A material with
`keep: false` is deleted once its note is imported or deleted.

`shared/pages.js` (pure): `parsePages(text, { max, limit })` returns sorted page numbers
and accepts "9-11, 25", "9–11 and 25", "pages 9 to 11, p. 25" and "第9到11頁、25"; it throws
an Error with a human sentence on nonsense. Also `formatPages(pages)` → "9–11, 25",
`groupRanges(pages)` → `[[9, 11], [25, 25]]`, `printedToPdf(pages, offset)` and
`pdfToPrinted(pages, offset)`.

Notes API changes: list rows add `source` and `draftLessons`; `GET /notes/:id` returns
the draft in the lessons shape; `PUT /notes/:id/draft` takes `{ draft: { lessons } }`;
`POST /notes/:id/import` takes `{ lessons: [ { words: "all" | number[], skip?: boolean } ] }`,
where the legacy `{ words, lesson }` still means the first lesson, and returns
`{ lessonIds, lessonId, wordIds, mergedHanzi, created, xp, stats }`.

### 8.7 Onboarding

`#/welcome` (view id `welcome`) asks one question per screen, full-screen with a progress
bar and Plumi, Duolingo-style: skills (multi) → how they read Chinese (script and how
prominent characters are) → reasons (multi) and "anything Plumi should know" → classes →
level → daily goal → explanation language → done. Finishing sends one
`PUT /api/settings` with `goals` (including `onboardedAt`), `script`, `display`, `level`,
`dailyGoalXp`, `nativeLanguage` and `cardTemplates` with the recommended templates
enabled. `app.js` sends a learner whose `goals.onboardedAt` is null to `#/welcome` once per
page load. Settings gets a "Your goals" panel with the same answers and an "Ask me again"
button.

### 8.8 Phone rules (every view)

- Hover styles live inside `@media (hover: hover)`, so a tapped button never stays grey.
- Text inputs, selects and textareas are at least 16 px, or iOS zooms in.
- Date inputs use the kit rule in app.css, because iOS draws them wider than their box.
- Nothing overlaps a stroke or leaves its box at 375 px; long pinyin wraps.
- While a text field has focus on a phone, the tab bar hides so the keyboard cannot push
  it over the field.
- Check at 375×667, 390×844 and 430×932 with `scripts/cdp.mjs`. Playwright's WebKit cannot run on this
  machine (missing GTK 4 and GStreamer libraries), so iOS-only behaviour is handled from known Safari rules.

### 8.9 Known follow-ups

- `listenOnce()` has no cancel: a check still listening when a card changes keeps the
  microphone open until its timeout. Add an AbortSignal and wire it in review, challenge
  and Words, which each carry their own "Check me" today and could share one control.
- `recordControl()` has no `stop()`; callers stop a take by clicking its button.
- iOS Safari speaks only after a first utterance from a tap. Review and challenge speak a
  silent one on Start; a shared `tts.unlock()` would make that one rule.
- `readingFor()`, `wordHero()` and `wordLine()` could take an explicit script, so the
  welcome flow can preview an unsaved choice without building a stripped-down word.
- Speech recognition may answer in Simplified characters, which lowers `hanziMatch()`;
  it only advises, so the learner still decides.
