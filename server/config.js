import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* Everything that depends on the machine lives here, read once. The app binds
   to loopback by default: it is a personal study desk, not a service.
   MEMOLANG_HOST=0.0.0.0 opens it to the phone on the same Wi-Fi / Tailscale and
   is announced at startup. The generic HOST variable is deliberately ignored:
   shells that run other apps often export HOST=0.0.0.0 globally, and a study
   desk must not end up on every interface by accident. PORT is honoured as a
   fallback for convenience; MEMOLANG_PORT wins. */
const env = process.env;
export const config = {
  root: ROOT,
  version: '0.1.0',
  port: Number(env.MEMOLANG_PORT) || Number(env.PORT) || 3080,
  portSource: env.MEMOLANG_PORT ? 'MEMOLANG_PORT' : env.PORT ? 'PORT' : 'default',
  host: env.MEMOLANG_HOST || '127.0.0.1',
  dataDir: path.resolve(ROOT, env.MEMOLANG_DATA_DIR || env.DATA_DIR || 'data'),
  publicDir: path.join(ROOT, 'public'),
  sharedDir: path.join(ROOT, 'shared'),
  envApiKey: (process.env.OPENROUTER_API_KEY || '').trim(),
};
