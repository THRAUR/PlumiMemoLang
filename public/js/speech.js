/* Speaking practice in the browser: record yourself, play it back next to the
   model voice, and, where the browser has it, let speech recognition check what
   you said.

   Everything degrades. No microphone, no permission, or an insecure page → the
   record control hides or explains why. No recognition → the learner grades
   themselves. Nothing here is required for a session to work. */
import { h, pixelIcon, toast } from './ui.js';
import { hanziChars } from '/shared/zhuyin.js';

/* ---------- recording ---------- */

export const recording = {
  get supported() {
    return typeof window !== 'undefined'
      && Boolean(window.isSecureContext)
      && Boolean(navigator.mediaDevices?.getUserMedia)
      && typeof window.MediaRecorder !== 'undefined';
  },
};

/* iOS Safari records audio/mp4 only; Chrome and Firefox record webm/ogg. Asking for
   a type the browser cannot write throws, so probe in order of what plays back
   everywhere. */
function pickMime() {
  const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  for (const t of types) {
    try { if (window.MediaRecorder.isTypeSupported?.(t)) return t; } catch { /* keep probing */ }
  }
  return '';
}

function micError(e) {
  const name = e?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access was refused. Allow it for this site to record yourself.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found.';
  if (name === 'NotReadableError') return 'The microphone is busy in another app.';
  return e?.message || 'Recording could not start.';
}

export function createRecorder({ maxMs = 10000 } = {}) {
  let stream = null;
  let rec = null;
  let chunks = [];
  let started = 0;
  let timer = null;
  let url = null;
  let pending = null;

  function releaseStream() {
    if (stream) for (const track of stream.getTracks()) track.stop();
    stream = null;
  }

  const api = {
    state: 'idle',
    async start() {
      if (api.state === 'recording') return;
      if (!recording.supported) throw new Error('This browser cannot record audio on this page.');
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch (e) {
        throw new Error(micError(e));
      }
      const mime = pickMime();
      rec = new window.MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunks = [];
      rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
      rec.onstop = () => {
        clearTimeout(timer);
        releaseStream();
        const blob = new Blob(chunks, { type: rec?.mimeType || mime || 'audio/mp4' });
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(blob);
        api.state = 'idle';
        const done = pending;
        pending = null;
        done?.resolve({ url, blob, ms: Date.now() - started });
      };
      rec.start();
      started = Date.now();
      api.state = 'recording';
      // A learner who forgets to tap Stop should not record the rest of the evening.
      timer = setTimeout(() => { api.stop().catch(() => {}); }, maxMs);
    },
    stop() {
      if (api.state !== 'recording' || !rec) return Promise.reject(new Error('Nothing is being recorded.'));
      if (pending) return pending.promise;
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      pending = { promise, resolve };
      try { rec.stop(); } catch { releaseStream(); api.state = 'idle'; }
      return promise;
    },
    cancel() {
      clearTimeout(timer);
      pending = null;
      if (rec && api.state === 'recording') {
        rec.onstop = null;
        try { rec.stop(); } catch { /* already stopped */ }
      }
      releaseStream();
      api.state = 'idle';
    },
    release() {
      api.cancel();
      if (url) URL.revokeObjectURL(url);
      url = null;
    },
    get elapsed() { return api.state === 'recording' ? Date.now() - started : 0; },
  };
  return api;
}

/* The one record control every screen uses: a mic button that becomes Stop, a
   running timer, and "Play mine" once there is a take. */
export function recordControl({ label = 'Record yourself', maxMs = 8000, onTake = null } = {}) {
  const el = h('div', { class: 'rec' });
  const none = { el, take: null, reset() {}, destroy() {} };
  if (!recording.supported) {
    el.hidden = true;
    return none;
  }
  const recorder = createRecorder({ maxMs });
  const btnLabel = h('span', null, label);
  const btn = h('button', { class: 'btn btn--sm rec-btn', type: 'button' }, pixelIcon('mic', 2), btnLabel);
  const time = h('span', { class: 'rec-time mono', hidden: true }, '0.0s');
  const play = h('button', { class: 'btn btn--sm btn--quiet rec-play', type: 'button', hidden: true }, pixelIcon('play', 2), 'Play mine');
  el.append(btn, time, play);

  let tick = null;
  let audio = null;
  const control = { el, take: null, reset, destroy };

  function paint() {
    const on = recorder.state === 'recording';
    btn.classList.toggle('is-recording', on);
    btnLabel.textContent = on ? 'Stop' : control.take ? 'Record again' : label;
    btn.querySelector('.px')?.replaceWith(pixelIcon(on ? 'stop' : 'mic', 2));
    time.hidden = !on;
    play.hidden = on || !control.take;
  }
  async function toggle() {
    if (recorder.state === 'recording') {
      clearInterval(tick);
      try {
        control.take = await recorder.stop();
        onTake?.(control.take);
      } catch { /* stopped by the timer already */ }
      paint();
      return;
    }
    try {
      audio?.pause();
      await recorder.start();
      tick = setInterval(() => { time.textContent = `${(recorder.elapsed / 1000).toFixed(1)}s`; }, 100);
      paint();
      // The auto-stop after maxMs resolves through stop(); poll for it so the
      // control repaints even when the learner never taps Stop.
      const watch = setInterval(() => {
        if (recorder.state !== 'recording') { clearInterval(watch); clearInterval(tick); paint(); }
      }, 200);
    } catch (e) {
      toast(e.message, 'bad', 5000);
      paint();
    }
  }
  btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  play.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!control.take) return;
    audio?.pause();
    audio = new Audio(control.take.url);
    audio.play().catch(() => toast('This recording could not play.', 'bad'));
  });
  function reset() {
    recorder.cancel();
    clearInterval(tick);
    audio?.pause();
    control.take = null;
    paint();
  }
  function destroy() {
    clearInterval(tick);
    audio?.pause();
    recorder.release();
  }
  paint();
  return control;
}

/* ---------- recognition ---------- */

function recognizerClass() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export const recognition = {
  // Browsers refuse the microphone on an insecure page, so offering the button there
  // would only ever end in an error.
  get supported() { return Boolean(recognizerClass()) && (typeof window === 'undefined' || window.isSecureContext !== false); },
};

export function listenOnce({ lang = 'zh-TW', timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const SR = recognizerClass();
    if (!SR) { reject(new Error('Speech recognition is not available in this browser.')); return; }
    const r = new SR();
    r.lang = lang;
    r.interimResults = false;
    r.continuous = false;
    r.maxAlternatives = 3;
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { r.abort(); } catch { /* already ended */ }
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('Plumi did not hear anything.')), timeoutMs);
    r.onresult = (ev) => {
      const first = ev.results?.[0];
      const alternatives = first ? [...first].map((a) => ({ text: a.transcript || '', confidence: Number(a.confidence) || 0 })) : [];
      finish(resolve, { text: alternatives[0]?.text || '', alternatives, confidence: alternatives[0]?.confidence || 0 });
    };
    r.onerror = (ev) => {
      const code = ev?.error || '';
      const msg = code === 'not-allowed' || code === 'service-not-allowed'
        ? 'Microphone access was refused.'
        : code === 'no-speech' ? 'Plumi did not hear anything.' : `Speech recognition failed (${code || 'unknown'}).`;
      finish(reject, new Error(msg));
    };
    r.onend = () => finish(reject, new Error('Plumi did not hear anything.'));
    try { r.start(); } catch (e) { finish(reject, new Error(e?.message || 'Speech recognition could not start.')); }
  });
}

/* Share of the expected characters that were heard, in order (longest common
   subsequence). Recognition returns characters, so this compares characters even
   for a learner who never reads them: the screen shows the reading, not this. */
export function hanziMatch(heard, expected) {
  const a = hanziChars(heard);
  const b = hanziChars(expected);
  if (!b.length) return 0;
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j];
      row[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(row[j], row[j - 1]);
      diag = up;
    }
  }
  return row[b.length] / b.length;
}
