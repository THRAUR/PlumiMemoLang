/* One draft shape for the whole app (docs/ARCHITECTURE.md §8.5):
     { lessons: [ { lesson, words } ] }
   Drafts written before one source could become several lessons were
   { lesson, words }; every reader goes through here so neither shape leaks. */
import { isPlain } from '../defaults.js';

export const LESSONS_MAX = 4;

export function draftLessons(draft) {
  if (!isPlain(draft)) return [];
  const clean = (l) => ({
    lesson: isPlain(l?.lesson) ? l.lesson : {},
    words: Array.isArray(l?.words) ? l.words.filter(isPlain) : [],
  });
  if (Array.isArray(draft.lessons)) return draft.lessons.filter(isPlain).map(clean);
  if (isPlain(draft.lesson) || Array.isArray(draft.words)) return [clean(draft)];
  return [];
}

export function normaliseDraft(draft) {
  const lessons = draftLessons(draft);
  return lessons.length ? { lessons } : null;
}

export function draftWordCount(draft) {
  return draftLessons(draft).reduce((n, l) => n + l.words.length, 0);
}
