# PlumiMemoLang — context for a Claude Code session working in this repo

## What this is

A self-hosted, single-user web app for learning Traditional Chinese (繁體中文, Taiwan
usage: 注音 zhuyin first, pinyin second). Express on Node 22, vanilla ES modules in
the browser, **no build step, no framework, no database** (JSON files under
`data/`). The look is the Plume design system (paper-white early-Macintosh canvas,
one terracotta accent, pixel display type, Plumi the pixel bird) with Duolingo's
structure (a lesson path, streak + XP, full-screen sessions with a progress bar, a
feedback banner, a celebration screen).

Read `docs/ARCHITECTURE.md` first. It is the contract between modules: data shapes,
module APIs, REST endpoints and the UI kit. When in doubt, the doc wins over any
single file.

## Rules

- **Design tokens live only in `public/plume.css`.** Never invent a colour. `--accent`
  is a FILL; text uses `--accent-text`. Sage/amber/brick (`--green`, `--warn`,
  `--error`) are STATES (correct / due / wrong), never decoration. Terracotta appears
  once per screen region — one primary action, one highlight.
- **Pixel fonts never set body copy.** Pixelify Sans = headings and big numbers,
  Silkscreen = eyebrows / tags / button labels (always caps, tracked), Karla = body,
  JetBrains Mono = pinyin and code. Chinese text always gets `lang="zh-Hant"` and
  `font-family: var(--font-zh)`.
- **No third-party CDN.** Fonts are self-hosted in `public/fonts/`. No `@import`.
- **Client modules declare; they do not wire themselves up.** Side effects go in an
  exported `init()`/`render()` that `public/app.js` calls. Nothing may import
  `public/app.js`. Shared state is in `public/js/state.js`: read the live binding,
  write through the owner's setter.
- **All user text is escaped.** Build DOM with `h()` from `public/js/ui.js` (text
  children are set with `textContent`). `innerHTML` only with literal markup.
- **The API key never reaches the browser.** `GET /api/settings` returns it masked.
  It is stored in `data/settings.json` (gitignored) or `OPENROUTER_API_KEY`.
- **Every AI call goes through `runTask()` in `server/ai/tasks.js`** so the model
  routing, the usage log and the cost estimate stay in one place.
- **Comments record why.** Keep them. Do not strip or reformat existing comments.
- **Verify by loading, not just parsing:** `node --check` passes a missing import.
  Use `node --input-type=module -e "await import('./server/x.js')"` and run
  `npm test` (node:test). Frontend: start the server on a throwaway port and load
  the page in headless Chromium; a broken import is a blank page, not an error.

## Layout

```
server/          Express app, JSON store, SRS, OpenRouter client, AI tasks, routes
shared/          pure modules used by BOTH server and browser (zhuyin/pinyin utils)
public/          the app: index.html, plume.css (tokens), app.css (kit), js/, css/
public/js/views/ one module per screen; each owns a stylesheet in public/css/
test/            node:test suites (+ fixtures/seed.json)
scripts/         seed.mjs (fixture → running server), qa.sh (screenshot sweep), cdp.mjs (headless driver)
data/            your data (gitignored): words.json, lessons.json, notes.json …
```

## Run

```bash
npm install
npm start            # http://127.0.0.1:3080  (MEMOLANG_PORT / MEMOLANG_HOST / MEMOLANG_DATA_DIR in .env)
npm test
```
For a throwaway server while developing: `MEMOLANG_PORT=3097 DATA_DIR=/tmp/x node server/index.js`.
Visual check of every screen with seeded data: `scripts/qa.sh 3098 /tmp/qa` (prints console errors, writes PNGs).
Never `pkill -f` a pattern that appears in your own command line — kill by the PID `ss -ltnp` reports.

## Live instance

- **PM2 app `plumimemolang` runs straight from this directory** (`ecosystem.config.cjs`),
  bound to `127.0.0.1:3080`, with the learner's real data in `./data`. `tailscale serve`
  fronts it with HTTPS on port 8449, tailnet only. Never add a funnel or bind
  `0.0.0.0`: the app has no login.
- `public/*` and `shared/*` changes are live on a browser reload. `server/*.js` changes
  need `pm2 restart plumimemolang` (without `--update-env`). Restarting THIS app from a
  session is safe; never restart, reload or stop `arthur` — that is PlumiChat, and this
  session may be running inside it.
- **Start or re-save it with a clean environment.** From a Claude Code session, run pm2
  through `env -i` with only HOME, USER, LOGNAME, SHELL, LANG, PATH and PM2_HOME, or the
  session's variables get baked into `~/.pm2/dump.pm2` (see the header of
  `ecosystem.config.cjs`). Its `filter_env` list is the second line of defence.
- Dev servers, tests and `scripts/qa.sh` never touch `./data`: always pass a throwaway
  `DATA_DIR`.
