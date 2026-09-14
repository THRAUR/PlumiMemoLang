import express from 'express';
import path from 'node:path';
import os from 'node:os';
import { config } from './config.js';
import { initStore, flushAll, coll, doc } from './store.js';
import { DEFAULT_SETTINGS, DEFAULT_PROGRESS } from './defaults.js';
import { mountRoutes } from './routes/index.js';
import { recoverInterruptedNotes } from './routes/notes.js';

/* Register every collection before loading so a route that only imports a
   store lazily still finds its file read from disk. */
for (const name of ['words', 'lessons', 'notes', 'materials', 'usage']) coll(name);
doc('settings', DEFAULT_SETTINGS);
doc('progress', DEFAULT_PROGRESS);
doc('suggestions', {});
doc('models-cache', {});
await initStore();
{
  const recovered = recoverInterruptedNotes();
  if (recovered) console.log(`[notes] ${recovered} note(s) were interrupted by a restart and marked for retry`);
}

const app = express();
app.disable('x-powered-by');
app.set('etag', false);
app.use(express.json({ limit: '40mb' }));        // note photos travel as data URLs

app.use('/shared', express.static(config.sharedDir, { extensions: ['js'] }));
app.use(express.static(config.publicDir, { index: 'index.html' }));

await mountRoutes(app);

app.use('/api', (req, res) => {
  res.status(404).json({ error: `No such endpoint: ${req.method} ${req.originalUrl}` });
});
// Deep links: a plain /words (no hash) still opens the app. Anything that
// looks like a file (has an extension) or does not want HTML is a real 404 —
// otherwise a missing script would arrive as index.html and fail as a syntax
// error instead of a clear "not found".
app.get('/{*splat}', (req, res) => {
  if (path.extname(req.path) || !req.accepts('html')) return res.status(404).type('text').send('Not found');
  res.sendFile(path.join(config.publicDir, 'index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  const msg = err.type === 'entity.too.large' ? 'That upload is too large (40 MB max).'
    : err.type === 'entity.parse.failed' ? 'The request body is not valid JSON.'
    : err.message || 'Something went wrong.';
  if (status >= 500) console.error(err);
  res.status(status).json({ error: msg });
});

const server = app.listen(config.port, config.host, () => {
  const lines = [`PlumiMemoLang ${config.version}`, ``, ` local    http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`];
  if (config.host === '0.0.0.0') {
    for (const ifs of Object.values(os.networkInterfaces())) {
      for (const i of ifs || []) if (i.family === 'IPv4' && !i.internal) lines.push(` network  http://${i.address}:${config.port}`);
    }
  }
  lines.push(` data     ${config.dataDir}`);
  lines.push(` api key  ${config.envApiKey ? 'from .env' : doc('settings').get()?.ai?.apiKey ? 'from settings' : 'not set — add it in Settings'}`);
  console.log(lines.join('\n'));
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use` + (config.portSource === 'PORT' ? ' (it came from the PORT variable in your shell)' : '') + '.');
    console.error(`Pick another one: MEMOLANG_PORT=3081 npm start`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

async function shutdown(sig) {
  console.log(`\n${sig}: saving…`);
  server.close();
  await flushAll();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
