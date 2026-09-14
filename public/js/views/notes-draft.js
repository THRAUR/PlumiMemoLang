/* ============================================================
   notes-draft.js — the review step between the model and the
   learner's dictionary. A draft is one to four lessons (§8.5), each
   with its own words and its own "Skip this lesson"; nothing becomes a
   real lesson or word until Import. Also the imported state, which
   links every lesson an import created, and the "From <document>,
   pages …" line of a note made from a document.

   Nothing the model wrote is trusted: it stays plain text built with h().
   ============================================================ */
import { api } from '../api.js';
import { refreshStats } from '../state.js';
import { h, toast, confirmWindow, busy, markdownish, profile } from '../ui.js';
import { wordLine, exampleEl } from '../hanzi.js';
import {
  isLive, enc, icon, plural, win, addKids, runJob, resolvedExtractModel, celebrateScreen, docHref, sourcePagesText,
} from './notes-kit.js';

const POS = [['', '—'], ['n', 'noun'], ['v', 'verb'], ['adj', 'adjective'], ['adv', 'adverb'],
  ['mw', 'measure word'], ['conj', 'conjunction'], ['prep', 'preposition'], ['part', 'particle'],
  ['interj', 'interjection'], ['pron', 'pronoun'], ['num', 'number'], ['expr', 'expression']];
const TYPES = [['character', 'character'], ['word', 'word'], ['phrase', 'phrase'],
  ['sentence', 'sentence'], ['grammar', 'grammar']];

/* The server always sends { lessons: [ { lesson, words } ] }; a draft from an older
   build ({ lesson, words }) reads the same way (§8.5), so no screen sees two shapes. */
export function draftLessons(draft) {
  const plain = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
  const clean = (l) => ({ lesson: plain(l?.lesson) ? l.lesson : {}, words: Array.isArray(l?.words) ? l.words.filter(plain) : [] });
  if (!plain(draft)) return [];
  if (Array.isArray(draft.lessons)) return draft.lessons.filter(plain).map(clean);
  if (plain(draft.lesson) || Array.isArray(draft.words)) return [clean(draft)];
  return [];
}

/* ---------- where a document note came from ---------- */
export function sourceBlock(note, my) {
  const src = note.source;
  if (!src || typeof src !== 'object') return null;
  const pages = sourcePagesText(src);
  const action = h('span', { class: 'nt-source-action' });
  const box = h('section', { class: 'card card--sunk card--flat nt-source' },
    h('div', { class: 'row nt-source-row' },
      h('span', { class: 'nt-doc-icon', 'aria-hidden': 'true' }, icon('doc', 2)),
      h('p', { class: 'grow' }, 'From ', h('b', null, src.title || 'a document'), pages ? `, ${pages}` : '')),
    action);
  /* The document may be gone: one the learner chose to use once is deleted at import.
     The library answers which ones still exist, without a 404 per note. */
  if (src.materialId) {
    api.get('/api/materials').then((res) => {
      if (!isLive(my)) return;
      const m = (Array.isArray(res?.materials) ? res.materials : []).find((x) => x.id === src.materialId);
      if (!m) { action.remove(); return; }
      action.replaceWith(h('a', { class: 'btn btn--sm', href: docHref(m.id) }, icon('doc'), m.keep ? 'Pick more pages' : 'Open the document'));
    }).catch(() => action.remove());
  }
  return box;
}

/* --- draft: the lesson preview --- */
function lessonContent(l) {
  const sections = Array.isArray(l.sections) ? l.sections : [];
  const grammar = Array.isArray(l.grammar) ? l.grammar : [];
  const dialogue = Array.isArray(l.dialogue) ? l.dialogue : [];
  const box = h('div', { class: 'nt-content' });

  const sectionEl = (s) => h('div', { class: 'nt-section' },
    h('p', { class: 'pl-eyebrow' }, s.kind || 'text'),
    s.title ? h('h3', { class: 'h3' }, s.title) : null,
    s.titleZh ? h('div', { class: 'nt-section-zh zh', lang: 'zh-Hant' }, s.titleZh) : null,
    s.body ? markdownish(s.body) : null);

  if (sections[0]) box.append(sectionEl(sections[0]));

  const rest = h('div', { class: 'nt-more' });
  for (const s of sections.slice(1)) rest.append(sectionEl(s));
  if (grammar.length) {
    rest.append(h('p', { class: 'pl-eyebrow' }, 'Grammar'));
    for (const g of grammar) {
      rest.append(h('div', { class: 'nt-grammar' },
        h('div', { class: 'nt-pattern zh', lang: 'zh-Hant' }, g.pattern || ''),
        g.explanation ? h('p', null, g.explanation) : null,
        (Array.isArray(g.examples) ? g.examples : []).map((ex) => exampleEl(ex))));
    }
  }
  if (dialogue.length) {
    rest.append(h('p', { class: 'pl-eyebrow' }, 'Dialogue'));
    const lines = h('div', { class: 'nt-dialogue' });
    for (const d of dialogue) {
      /* exampleEl orders the line by the learner's display rules: a speaking
         learner reads the pinyin first and the characters last. */
      lines.append(h('div', { class: 'nt-line' },
        h('span', { class: 'nt-speaker' }, d.speaker || '·'),
        h('div', { class: 'grow' }, exampleEl({ zh: d.zh, pinyin: d.pinyin, zhuyin: d.zhuyin, translation: d.translation }))));
    }
    rest.append(lines);
  }
  if (rest.childElementCount) {
    rest.hidden = true;
    const more = h('button', { class: 'btn btn--sm btn--ghost', type: 'button', 'aria-expanded': 'false' }, 'Show more');
    more.addEventListener('click', () => {
      rest.hidden = !rest.hidden;
      more.textContent = rest.hidden ? 'Show more' : 'Show less';
      more.setAttribute('aria-expanded', rest.hidden ? 'false' : 'true');
    });
    box.append(rest, more);
  }
  return box.childElementCount ? box : null;
}

function wordEditor(word, onSave) {
  const f = {};
  const field = (key, label, extra = {}) => {
    const input = h('input', { class: `input${extra.zh ? ' zh' : ''}`, type: 'text', value: word[key] || '', lang: extra.lang || undefined });
    f[key] = () => input.value.trim();
    return h('label', { class: 'field' }, h('span', { class: 'label' }, label), input);
  };
  const pick = (key, label, options) => {
    const sel = h('select', { class: 'select' }, options.map(([v, t]) => h('option', { value: v }, t)));
    sel.value = options.some(([v]) => v === (word[key] || '')) ? (word[key] || '') : options[0][0];
    f[key] = () => sel.value;
    return h('label', { class: 'field' }, h('span', { class: 'label' }, label), sel);
  };
  const hanzi = field('hanzi', 'Hanzi (Traditional)', { zh: true, lang: 'zh-Hant' });
  const readings = h('div', { class: 'grid-2' },
    field('pinyin', 'Pinyin (tone marks)'),
    field('zhuyin', '注音 Zhuyin', { zh: true, lang: 'zh-Hant' }));
  /* A learner who is here to speak checks the reading first; the characters are
     their reference, so they come second. */
  const speaking = profile().focus === 'speaking';
  const examples = (Array.isArray(word.examples) ? word.examples : []).map((ex) => exampleEl(ex)).filter(Boolean);
  win({
    title: 'Edit word',
    wide: true,
    body: h('div', { class: 'stack' },
      speaking ? readings : hanzi,
      speaking ? hanzi : readings,
      field('meaning', 'Meaning (English)'),
      field('meaningNative', 'Meaning (your language)'),
      h('div', { class: 'grid-2' }, pick('pos', 'Part of speech', POS), pick('type', 'Type', TYPES)),
      examples.length ? h('div', { class: 'stack nt-editor-examples' }, h('p', { class: 'pl-eyebrow' }, 'Examples'), examples) : null),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save', primary: true, onClick: async () => {
          const patch = {};
          for (const [k, get] of Object.entries(f)) patch[k] = get();
          if (!patch.hanzi) { toast('A word needs its characters.', 'bad'); return false; }
          await onSave(patch);
        },
      },
    ],
  });
}

/* ---------- the draft ---------- */
export function draftBlock(note, my, reload) {
  const lessons = draftLessons(note.draft);
  const multi = lessons.length > 1;
  const box = h('section', { class: 'stack nt-draft' });

  function reprocessButton() {
    const b = h('button', { class: 'btn btn--sm btn--quiet', type: 'button' }, icon('refresh'), 'Reprocess');
    b.addEventListener('click', async () => {
      if (!(await confirmWindow({
        title: note.source ? 'Read these pages again?' : 'Reprocess these notes?',
        text: note.source
          ? 'Plumi reads the pages again and replaces this draft. Your edits to the draft are lost.'
          : 'Plumi reads the notes again and replaces this draft. Your edits to the draft are lost.',
        okLabel: 'Reprocess',
      }))) return;
      busy(b, true);
      let jobId = null;
      try {
        ({ jobId } = await api.post(`/api/notes/${enc(note.id)}/process`, {}));
      } catch (e) {
        busy(b, false);
        toast(e.message, 'bad');
        return;
      }
      if (!isLive(my)) return;
      await runJob({ host: box, jobId, my, model: note.model || resolvedExtractModel(Boolean(note.source)), onDone: () => reload() });
    });
    return b;
  }

  if (!lessons.length) {
    addKids(box,
      h('p', { class: 'pl-eyebrow' }, 'Review the draft'),
      h('div', { class: 'card card--sunk' }, h('p', { class: 'help' }, 'This draft came back empty. Reprocess to try again.')),
      h('div', { class: 'row' }, reprocessButton()));
    return box;
  }

  const state = lessons.map((_, li) => ({ skip: false, open: lessons.length <= 2 || li === 0, boxes: [], paint: null }));
  const chosen = (li) => state[li].boxes.map((cb, i) => (cb.checked ? i : -1)).filter((i) => i >= 0);

  /* --- the sticky import bar --- */
  const countEl = h('span', { class: 'nt-import-count' });
  const importBtn = h('button', { class: 'btn btn--primary btn--block', type: 'button' });
  function updateBar() {
    let lessonsIn = 0, wordsIn = 0, wordsOf = 0, skipped = 0;
    lessons.forEach((entry, li) => {
      state[li].paint?.();
      if (state[li].skip) { skipped += 1; return; }
      lessonsIn += 1;
      wordsIn += chosen(li).length;
      wordsOf += entry.words.length;
    });
    importBtn.replaceChildren(icon('check'), lessonsIn
      ? `Import ${plural(lessonsIn, 'lesson', 'lessons')} · ${plural(wordsIn, 'word', 'words')}`
      : 'Nothing to import');
    importBtn.disabled = !lessonsIn;
    countEl.textContent = `${wordsIn} / ${wordsOf} words${skipped ? ` · ${skipped} skipped` : ''}`;
  }

  function wordRow(li, w, wi) {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = !w.isKnown;
    state[li].boxes[wi] = cb;
    cb.addEventListener('change', updateBar);
    const row = h('div', { class: 'list-row nt-word' });
    const paint = () => {
      row.replaceChildren(
        h('label', { class: 'check nt-check' }, cb, h('span', { class: 'sr-only' }, `Import ${w.pinyin || w.hanzi || 'this word'}`)),
        h('div', { class: 'grow nt-word-main' },
          wordLine(w),
          /* The tags ride with the meaning, not with the readings: a long
             zhuyin string would otherwise push them onto a line of their own
             and every row would wrap differently. */
          h('div', { class: 'row row--wrap nt-word-meaning' },
            h('span', { class: 'grow' }, w.meaning || h('span', { class: 'faint' }, 'no meaning yet')),
            w.pos ? h('span', { class: 'pl-tag' }, w.pos) : null,
            w.isKnown ? h('span', { class: 'pl-tag' }, 'known') : null),
          w.meaningNative ? h('div', { class: 'nt-word-native muted small' }, w.meaningNative) : null),
        h('button', {
          class: 'btn btn--icon btn--sm', type: 'button', 'aria-label': `Edit ${w.pinyin || w.hanzi || 'word'}`, title: 'Edit',
          onClick: () => wordEditor(w, async (patch) => {
            /* The whole draft goes back to the server, so the edit has to be
               applied first — and rolled back if the write fails, or the copy
               in memory would drift from the stored one. */
            const before = { ...w };
            Object.assign(w, patch);
            let saved;
            try {
              saved = await api.put(`/api/notes/${enc(note.id)}/draft`, { draft: { lessons } });
            } catch (e) {
              Object.assign(w, before);
              throw e;                      // openWindow toasts and keeps the window open
            }
            toast('Saved');
            if (!isLive(my)) return;
            const fresh = draftLessons(saved?.draft)[li]?.words?.[wi];
            if (fresh) Object.assign(w, fresh);
            paint();
          }),
        }, icon('notes')));
    };
    paint();
    return row;
  }

  function lessonCard(li) {
    const { lesson: l, words } = lessons[li];
    const s = state[li];
    const name = multi ? `Lesson ${li + 1} of ${lessons.length}` : 'Lesson';
    const detailId = `nt-lesson-${note.id}-${li}`;
    const tag = h('span', { class: 'pl-tag' });
    const count = h('p', { class: 'nt-lesson-count' });
    const toggle = multi ? h('button', { class: 'btn btn--icon btn--quiet nt-lesson-toggle', type: 'button', 'aria-controls': detailId }) : null;
    const selectBtn = words.length ? h('button', { class: 'btn btn--sm btn--quiet', type: 'button' }, 'Select all') : null;
    const skip = multi ? h('input', { type: 'checkbox' }) : null;
    const detail = h('div', { class: 'nt-lesson-detail', id: detailId },
      lessonContent(l),
      h('div', { class: 'nt-words-box' },
        h('div', { class: 'section-head nt-words-head' }, h('p', { class: 'pl-eyebrow' }, `Words (${words.length})`), selectBtn),
        words.length
          ? h('div', { class: 'list nt-words' }, words.map((w, wi) => wordRow(li, w, wi)))
          : h('div', { class: 'card card--sunk' }, h('p', { class: 'help' }, multi
            ? 'The model found no words for this lesson.'
            : 'The model found no words in these notes. Try reprocessing with a stronger model.'))));
    const card = h('section', { class: 'pl-win nt-lesson', 'aria-label': name },
      h('div', { class: 'pl-titlebar' }, h('span', { class: 'pl-title' }, name), h('span', { class: 'spacer' }), tag, toggle),
      h('div', { class: 'win-body nt-preview' },
        h('div', { class: 'nt-lesson-head' },
          h('h2', { class: 'h2 nt-lesson-title' }, l.title || 'Untitled lesson'),
          l.titleZh ? h('p', { class: 'nt-lesson-zh zh', lang: 'zh-Hant' }, l.titleZh) : null,
          l.summary ? h('p', { class: 'muted nt-lesson-summary' }, l.summary) : null,
          count),
        detail,
        skip ? h('label', { class: 'check nt-skip' }, skip, h('span', null, 'Skip this lesson')) : null));

    s.paint = () => {
      const n = chosen(li).length;
      card.classList.toggle('is-skipped', s.skip);
      tag.className = `pl-tag${s.skip ? '' : ' on'}`;
      tag.textContent = s.skip ? 'skipped' : 'draft';
      detail.hidden = s.skip || !s.open;
      if (toggle) {
        toggle.hidden = s.skip;
        toggle.setAttribute('aria-expanded', s.open && !s.skip ? 'true' : 'false');
        toggle.setAttribute('aria-label', `${s.open ? 'Hide' : 'Show'} lesson ${li + 1}`);
        toggle.replaceChildren(icon(s.open ? 'up' : 'down'));
      }
      count.textContent = s.skip
        ? `Skipped · ${plural(words.length, 'word', 'words')}`
        : `${n} of ${plural(words.length, 'word', 'words')} selected`;
      if (selectBtn) selectBtn.textContent = n === words.length ? 'Select none' : 'Select all';
    };
    toggle?.addEventListener('click', () => { s.open = !s.open; s.paint(); });
    skip?.addEventListener('change', () => { s.skip = skip.checked; s.open = !s.skip; updateBar(); });
    selectBtn?.addEventListener('click', () => {
      const all = chosen(li).length === words.length;
      for (const cb of s.boxes) cb.checked = !all;
      updateBar();
    });
    return card;
  }

  importBtn.addEventListener('click', async () => {
    busy(importBtn, true);
    /* One entry per draft lesson, always: the server reads a missing entry as
       "all of that lesson's words". */
    const body = { lessons: lessons.map((_, li) => (state[li].skip ? { skip: true } : { skip: false, words: chosen(li) })) };
    let res;
    try {
      res = await api.post(`/api/notes/${enc(note.id)}/import`, body);
    } catch (e) {
      busy(importBtn, false);
      toast(e.message, 'bad');
      return;
    }
    if (!isLive(my)) return;
    if (res) lastImports.set(note.id, res);
    celebrateScreen();
    const n = Array.isArray(res?.lessonIds) ? res.lessonIds.length : (res?.lessonId ? 1 : 0);
    toast(`${n > 1 ? `${n} lessons` : 'Lesson'} created · +${res?.xp ?? 10} XP`, 'ok');
    await refreshStats();
    if (!isLive(my)) return;
    reload(null, { focusImported: true });
  });

  addKids(box,
    h('p', { class: 'pl-eyebrow' }, 'Review the draft'),
    multi ? h('p', { class: 'muted nt-draft-lead' }, `Plumi made ${lessons.length} lessons. Untick the words you don’t want, or skip a whole lesson.`) : null,
    lessons.map((_, li) => lessonCard(li)),
    h('div', { class: 'nt-import' },
      h('div', { class: 'row nt-import-top' }, reprocessButton(), h('span', { class: 'grow' }), countEl),
      importBtn));
  updateBar();
  return box;
}

/* ---------- imported ---------- */
/* The last import's answer, by note: the imported state links every lesson it
   created even if the stored note were read back without them. */
const lastImports = new Map();

export function importedBlock(note, my) {
  const imp = note.imported || {};
  const hint = lastImports.get(note.id) || {};
  const listed = Array.isArray(imp.lessonIds) && imp.lessonIds.length ? imp.lessonIds
    : Array.isArray(hint.lessonIds) && hint.lessonIds.length ? hint.lessonIds
      : [imp.lessonId || hint.lessonId];
  const ids = [...new Set(listed.filter(Boolean))];
  const added = imp.wordIds?.length || 0;
  const merged = imp.mergedHanzi?.length || 0;
  const draftTitles = draftLessons(note.draft).map((d) => d.lesson?.title || '');
  const rows = ids.map((id, i) => {
    const title = h('span', { class: 'nt-row-title' }, (ids.length === draftTitles.length && draftTitles[i]) || `Lesson ${i + 1}`);
    const meta = h('span', { class: 'nt-row-meta' });
    const el = h('a', { class: 'list-row nt-row nt-row--center', href: `#/lessons/${enc(id)}` },
      icon('lessons'), h('span', { class: 'grow' }, title, meta), icon('arrow'));
    return { id, el, title, meta };
  });
  if (rows.length) {
    /* The real titles and word counts: a skipped lesson means the draft's order is
       not the import's, and the learner may have renamed a lesson since. */
    api.get('/api/lessons').then((res) => {
      if (!isLive(my)) return;
      const all = Array.isArray(res?.lessons) ? res.lessons : [];
      for (const r of rows) {
        const l = all.find((x) => x.id === r.id);
        if (!l) {
          r.meta.textContent = 'deleted since';
          r.el.removeAttribute('href');
          r.el.classList.add('is-gone');
          continue;
        }
        r.title.textContent = l.title || l.titleZh || 'Lesson';
        r.meta.textContent = plural(Array.isArray(l.wordIds) ? l.wordIds.length : 0, 'word', 'words');
      }
    }).catch(() => {});
  }
  return h('section', { class: 'card nt-imported' },
    h('div', { class: 'row nt-imported-head' }, icon('check', 3),
      h('p', { class: 'h3 grow' }, ids.length > 1 ? `Imported ${ids.length} lessons` : 'Imported')),
    h('p', { class: 'muted' },
      `${plural(added, 'word', 'words')} added, ${merged} ${merged === 1 ? 'was' : 'were'} already known.`),
    rows.length ? h('div', { class: 'list nt-lessons' }, rows.map((r) => r.el)) : null,
    ids.length
      ? h('div', { class: 'row row--wrap' },
        h('a', { class: 'btn btn--primary', href: ids.length === 1 ? `#/review?lesson=${enc(ids[0])}` : '#/review' }, icon('review'), 'Practice'))
      : null);
}
