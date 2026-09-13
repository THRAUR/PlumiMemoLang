/* Plumi, the study buddy. A stack of pixel frames; a mood picks one, idle
   blinks on its own, and say() hangs a speech bubble off the right side. */
import { h } from './ui.js';

const MOODS = ['idle', 'happy', 'think', 'sad', 'cheer', 'sleep'];
const FRAME = { idle: 'bird-idle', happy: 'bird-happy', think: 'bird-think', sad: 'bird-sad', cheer: 'bird-happy', sleep: 'bird-sleep' };

export function createBird({ size = 4, mood = 'idle', label = 'Plumi the bird' } = {}) {
  const el = h('div', { class: `bird bird--${mood}`, role: 'img', 'aria-label': label });
  const frame = h('div', { class: 'bird-frame' });
  const sprites = {};
  for (const name of new Set(Object.values(FRAME).concat('bird-blink'))) {
    const s = window.PlumiPixel.pixel(name, size);
    s.hidden = true;
    sprites[name] = s;
    frame.append(s);
  }
  el.append(frame);
  let current = mood, blinkTimer = null, bubble = null, bubbleTimer = null;

  function show(name) { for (const [n, s] of Object.entries(sprites)) s.hidden = n !== name; }
  function scheduleBlink() {
    clearTimeout(blinkTimer);
    if (current !== 'idle') return;
    blinkTimer = setTimeout(() => {
      if (current !== 'idle' || !el.isConnected) return;
      show('bird-blink');
      setTimeout(() => { if (current === 'idle') show('bird-idle'); scheduleBlink(); }, 140);
    }, 2400 + Math.random() * 2600);
  }
  function setMood(m) {
    if (!MOODS.includes(m)) m = 'idle';
    current = m;
    el.className = `bird bird--${m}`;
    show(FRAME[m]);
    scheduleBlink();
  }
  function say(text, ms = 4000) {
    bubble?.remove(); clearTimeout(bubbleTimer);
    if (!text) { bubble = null; return; }
    bubble = h('div', { class: 'bubble', role: 'status' }, text);
    el.append(bubble);
    if (ms > 0) bubbleTimer = setTimeout(() => { bubble?.remove(); bubble = null; }, ms);
    return bubble;
  }
  setMood(mood);
  return { el, setMood, say, get mood() { return current; } };
}

/* A greeting line for the Today screen and empty states. Chinese first,
   because the learner came here to read Chinese. */
export function greeting(name = '') {
  const hr = new Date().getHours();
  const zh = hr < 11 ? '早安' : hr < 18 ? '午安' : '晚安';
  const who = name ? `，${name}` : '';
  return `${zh}${who}！`;
}
