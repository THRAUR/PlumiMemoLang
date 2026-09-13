# PlumiMemoLang

Your own Traditional Chinese study desk, running on your machine. Paste the notes
from your class, and Plumi — a small pixel bird — turns them into a lesson card
and a deck of memo cards. Review them with spaced repetition, watch a memorization
score grow for every word, test yourself with Duolingo-style challenges, and get a
handful of new words suggested every morning.

Taiwan usage throughout: 繁體字 with 注音 first, pinyin second.

## What it does

| Screen | What you do there |
|---|---|
| **Today** | Streak, XP against a daily goal, what is due, today's suggested words, your lesson path. One tap into a session. |
| **Notes** | Paste raw notes or drop photos of the whiteboard. An OpenRouter model of your choice writes the lesson and the word list; you review the draft, then import it. |
| **Lessons** | Your path, one node per class. Each lesson card has vocabulary, grammar points with examples, a dialogue, cultural tips. Study, practice, or challenge it. |
| **Review** | Spaced-repetition memo cards (SM-2 style). Several card templates — recognition, production, sound, listening, fill-the-blank — and your own. |
| **Words** | Everything you have learned, searchable by 字, pinyin (tones optional), 注音 or meaning, with a 0–100 memorization score and a band: 生 new · 認 seen · 熟 familiar · 通 mastered. |
| **Challenge** | A mixed quiz built from your own words: pick the meaning, pick the word, listening (browser voice), type the pinyin, match pairs, build the sentence, fill the blank, and an optional AI-written reading passage. |
| **Settings** | OpenRouter key, one model per task (routed by how much the task matters), goals, 注音/pinyin, explanation language, theme, voice, card templates, backup. |

Everything stays on your machine. Your notes leave it only when you ask for a
lesson, and only to the model you picked on OpenRouter.

## Run it

You need [Node.js](https://nodejs.org) 22 or newer.

```bash
git clone https://github.com/THRAUR/PlumiMemoLang.git
cd PlumiMemoLang
npm install
npm start
```

Open http://127.0.0.1:3080. Then, in **Settings → AI**, paste an
[OpenRouter key](https://openrouter.ai/keys) and pick a model. Photo notes need a
model that accepts images; the picker marks them.

### On your phone

The app has no login, so keep it on `127.0.0.1` and let
[Tailscale](https://tailscale.com) put HTTPS in front of it for your own devices:

```bash
tailscale serve --bg --https=8449 http://127.0.0.1:3080
```

Open `https://<this-machine>.<your-tailnet>.ts.net:8449` on the phone and add it to
the home screen: it installs as an app with its own icon. Setting
`MEMOLANG_HOST=0.0.0.0` also works, but only on a network you trust completely —
anyone who can reach the port can read your notes and spend your OpenRouter credits.

### Keep it running

`ecosystem.config.cjs` runs it under [pm2](https://pm2.keymetrics.io) and brings it
back after a reboot. Start it from a plain login shell; the file explains why.

```bash
pm2 start ecosystem.config.cjs && pm2 save
pm2 restart plumimemolang      # after changing anything in server/
```

### Configuration

Copy `.env.example` to `.env`. Every value is optional.

| Variable | Default | Meaning |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Your key. The one saved in Settings wins over this. |
| `MEMOLANG_PORT` | `3080` | Port to listen on (`PORT` is honoured as a fallback). |
| `MEMOLANG_HOST` | `127.0.0.1` | Interface to bind. The generic `HOST` variable is ignored on purpose. |
| `MEMOLANG_DATA_DIR` | `./data` | Where your data lives. Back up this folder, or use Settings → Data. |

## How the AI is used (and paid for)

Every model call goes through one place, with a task name attached, so you can
route by importance in Settings:

| Task | Importance | What it does |
|---|---|---|
| Notes → lesson | high | Reads your raw notes (text and photos), writes the lesson card and the word list with 注音, pinyin, meanings and examples. Use your best model here — what it writes is what you will learn. |
| Daily new words | medium | Picks a few useful words you do not know yet, close to what you are studying. |
| Reading challenge | medium | Writes a short passage at your level from your own words, with questions. |
| Complete a word | low | Fills in missing readings and examples for one word. |
| Explain / ask | low | Answers a quick question about a word. |

Each call is logged with its token counts and cost (OpenRouter reports the
price); Settings shows today's and this month's spend against a budget you set.
Prompts are kept compact: the model only ever sees the characters you already
know, never your whole dictionary.

## The memorization score

Each word carries a spaced-repetition state: an ease factor, an interval, a due
date. The score you see (0–100) combines how likely you still remember the word
today (it decays past the due date), how far apart your reviews have become
(stability), and your recent accuracy on it. Bands: 生 0–24, 認 25–49, 熟 50–74,
通 75–100.

## Where things live

```
server/     Express app, JSON store, scheduler (srs.js), OpenRouter client, AI tasks, routes
shared/     pinyin ↔ 注音 utilities used by both server and browser
public/     the app — no build step; plume.css holds the design tokens
data/       your words, lessons, notes, progress (gitignored)
docs/       ARCHITECTURE.md — the contract every module follows
```

The look is **Plume**, the design system shared by the Plumi family: paper-white
early-Macintosh canvas, one terracotta accent, pixel display type, hard-offset
shadows that press down, and Plumi the bird.

## Develop

```bash
npm test                  # unit + route tests (node:test)
npm run dev               # restarts on server changes
scripts/qa.sh 3098 /tmp/qa   # seeded server + screenshots of every screen, phone and desktop
```

Read `docs/ARCHITECTURE.md` and `CLAUDE.md` before changing things.

## Licence

MIT.
