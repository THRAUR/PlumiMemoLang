/* Hanzi with 注音 or pinyin as <ruby> — the way a Taiwanese textbook prints
   it. When the reading has one syllable per character it rides above each
   one; otherwise it sits on a line beneath. */
import { h, readingFor } from './ui.js';
import { alignReading, hanziChars } from '/shared/zhuyin.js';

export function hanziEl(word, { reading = 'auto', size = 'lg', lang = 'zh-Hant' } = {}) {
  const text = String(word?.hanzi || '');
  const el = h('div', { class: `hz hz--${size}`, lang });
  const r = reading === 'none' ? null : reading === 'auto' ? readingFor(word).primary : (word?.[reading] ? { text: word[reading], kind: reading } : null);
  const chars = [...text];
  const syll = r ? alignReading(text, r.text) : null;
  if (r && syll) {
    const ruby = h('ruby');
    let i = 0;
    for (const ch of chars) {
      if (!hanziChars(ch).length) { ruby.append(ch); continue; }
      ruby.append(ch, h('rt', { class: r.kind === 'pinyin' ? 'pinyin' : '' }, syll[i++] ?? ''));
    }
    el.append(ruby);
  } else {
    el.append(text);
    if (r) el.append(h('div', { class: `reading reading--${r.kind} ${size === 'xl' ? 'reading--lg' : ''}`, style: { marginTop: '6px', lineHeight: '1.3' } }, r.text));
  }
  return el;
}

/* A plain reading line (no ruby), e.g. under a list row. */
export function readingLine(word) {
  const r = readingFor(word);
  if (!r.primary) return null;
  return h('span', { class: `reading reading--${r.primary.kind}`, lang: r.primary.kind === 'zhuyin' ? 'zh-Hant' : undefined }, r.primary.text);
}
