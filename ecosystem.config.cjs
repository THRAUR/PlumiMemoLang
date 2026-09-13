// PM2 process definition for an always-on PlumiMemoLang. `npm start` is all a
// laptop needs; this file is for a box that keeps the app up across reboots.
//
//   pm2 start ecosystem.config.cjs      # from a plain login shell (see below)
//   pm2 save                            # remember it for the next boot
//   pm2 restart plumimemolang           # after a server/*.js change
//
// public/* and shared/* changes are live on a browser reload; only server/*.js
// needs the restart.
//
// ── Where it listens, and who can reach it ───────────────────────────────────
// The app has no login. It binds 127.0.0.1:3080 (the defaults in
// server/config.js) and `tailscale serve` puts HTTPS in front of it for your own
// tailnet only:
//
//   tailscale serve --bg --https=8449 http://127.0.0.1:3080
//
// Do not "fix" remote access with MEMOLANG_HOST=0.0.0.0 on a shared network:
// anyone who can reach the port can read your notes and spend your OpenRouter
// credits.
//
// ── The dump.pm2 environment trap ────────────────────────────────────────────
// `pm2 start` copies the WHOLE environment of the shell that runs it into the
// app, and `pm2 save` writes that copy to ~/.pm2/dump.pm2, which is replayed on
// every boot. Started from inside a Claude Code session (or from PlumiChat, which
// hosts one), that means CLAUDE_* markers, an Anthropic key and the host app's
// PORT= and HOST= ride along — and PORT is one of MemoLang's fallbacks, so the
// app would try to take the host app's port. `filter_env` below drops those
// names whichever shell starts the app. pm2 7 silently IGNORES `filter_env: true`
// (lib/Common.js tests `.length`), so only the array form filters anything.
//
// ── Why there are almost no variables below ──────────────────────────────────
// Configuration and secrets belong in .env, which Node reads itself through
// --env-file-if-exists. A value set in `env` here would OVERRIDE .env (the real
// environment wins over --env-file) and would be copied into dump.pm2. The
// OpenRouter key normally lives in Settings inside the app (data/settings.json).
module.exports = {
  apps: [
    {
      name: 'plumimemolang',
      script: 'server/index.js',
      cwd: __dirname,
      interpreter: 'node',
      node_args: '--env-file-if-exists=.env',
      exec_mode: 'fork',
      instances: 1,
      watch: false,

      // Come back after a crash, but never spin: a process that dies within 10 s
      // is a failed start and counts toward max_restarts, and the backoff widens
      // the gap between tries so a persistent failure leaves the box idle.
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 2000,
      exp_backoff_restart_delay: 2000,

      // Leak guard only. The Express server idles far below this.
      max_memory_restart: '300M',

      // On SIGINT the server flushes the JSON store's debounced writes before it
      // exits (shutdown() in server/index.js). pm2's default 1.6 s before SIGKILL
      // is tight on the slow /mnt/d disk; a grade must never be lost to a restart.
      kill_timeout: 5000,

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // Substring match on the variable NAME: anything inherited that contains
      // one of these is dropped (see the header). .env is unaffected — Node, not
      // pm2, reads it.
      filter_env: ['CLAUDE', 'ANTHROPIC', 'OPENROUTER', 'ARTHUR', 'PLUMI', 'PORT', 'HOST', 'TMPDIR', 'NODE_OPTIONS'],

      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
