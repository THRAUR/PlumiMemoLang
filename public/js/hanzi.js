/* Hanzi with 注音 or pinyin as <ruby> — the way a Taiwanese textbook prints
   it. When the reading has one syllable per character it rides above each
   one; otherwise it sits on a line beneath. */
import { h, readingFor, profile } from './ui.js';
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

const zhLang = (kind) => (kind === 'zhuyin' ? 'zh-Hant' : undefined);

/* The word as the hero of a card, by the learner's display rules (§8.3). In "small"
   mode the reading IS the word and the characters are its footnote; in "hidden"
   they are gone; in "full" this is the ruby hanzi above. */
export function wordHero(word, { size = 'lg', align = 'center', mode } = {}) {
  const m = mode || profile().hanzi;
  const r = readingFor(word);
  if (m === 'full' || !r.primary) return hanziEl(word, { size });
  const hanzi = String(word?.hanzi || '');
  const el = h('div', { class: `word-hero word-hero--${size}${align === 'left' ? ' is-left' : ''}` });
  el.append(h('div', { class: `wh-reading${r.primary.kind === 'zhuyin' ? ' is-zhuyin' : ''}`, lang: zhLang(r.primary.kind) }, r.primary.text));
  if (r.secondary && profile().script === 'both') {
    el.append(h('div', { class: `wh-second${r.secondary.kind === 'zhuyin' ? ' is-zhuyin' : ''}`, lang: zhLang(r.secondary.kind) }, r.secondary.text));
  }
  if (m === 'small' && hanzi) el.append(h('div', { class: 'wh-hanzi', lang: 'zh-Hant' }, hanzi));
  return el;
}

/* The compact form of a word for a list row: primary text, then a quiet secondary. */
export function wordLine(word, { mode } = {}) {
  const m = mode || profile().hanzi;
  const r = readingFor(word);
  const hanzi = String(word?.hanzi || '');
  const el = h('span', { class: 'word-line' });
  if (m === 'full' || !r.primary) {
    el.append(h('span', { class: 'wl-primary is-hanzi', lang: 'zh-Hant' }, hanzi));
    if (r.primary) el.append(h('span', { class: `wl-secondary${r.primary.kind === 'zhuyin' ? ' is-zhuyin' : ''}`, lang: zhLang(r.primary.kind) }, r.primary.text));
    return el;
  }
  el.append(h('span', { class: `wl-primary${r.primary.kind === 'zhuyin' ? ' is-zhuyin' : ''}`, lang: zhLang(r.primary.kind) }, r.primary.text));
  if (m === 'small' && hanzi) el.append(h('span', { class: 'wl-secondary is-hanzi', lang: 'zh-Hant' }, hanzi));
  return el;
}

/* An example sentence by the same rules. In speaking focus the reading leads, the
   translation follows, and the characters come last and small. */
export function exampleEl(ex, { mode } = {}) {
  if (!ex || (!ex.zh && !ex.pinyin && !ex.zhuyin)) return null;
  const m = mode || profile().hanzi;
  const r = readingFor(ex);
  if (m === 'full' || !r.primary) {
    const el = h('div', { class: 'example' });
    if (ex.zh) el.append(h('div', { class: 'zh', lang: 'zh-Hant' }, ex.zh));
    if (r.primary) el.append(h('div', { class: `reading reading--${r.primary.kind}`, lang: zhLang(r.primary.kind) }, r.primary.text));
    if (ex.translation) el.append(h('div', { class: 'tr' }, ex.translation));
    return el;
  }
  const el = h('div', { class: 'example example--speak' });
  el.append(h('div', { class: `ex-reading${r.primary.kind === 'zhuyin' ? ' is-zhuyin' : ''}`, lang: zhLang(r.primary.kind) }, r.primary.text));
  if (ex.translation) el.append(h('div', { class: 'tr' }, ex.translation));
  if (m === 'small' && ex.zh) el.append(h('div', { class: 'ex-hanzi', lang: 'zh-Hant' }, ex.zh));
  return el;
}
