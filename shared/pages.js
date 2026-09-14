/* Page selections the way people type them after class: "9-11, 25", "9–11 and 25",
   "pages 9 to 11, p. 25", "第9到11頁、25". Pure (Node and browser). Errors are
   sentences, because the Notes screen shows them as they are. */

const MAX_SPAN = 10000;   // a typo like "1-900000" must not allocate a million pages

export function parsePages(text, { max = Infinity, limit = Infinity } = {}) {
  const cleaned = String(text ?? '')
    .toLowerCase()
    .replace(/[第頁页]/g, ' ')
    .replace(/\bpages?\b|\bpp?\.?(?=\s*\d)/g, ' ')
    .replace(/\s*(?:[-–—−~]|\bto\b|\bthrough\b|\bthru\b|到|至)\s*/g, '-')
    .replace(/\band\b|&|\+|、|，|;/g, ',');
  const parts = cleaned.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Type the pages to use, like 9-11, 25.');
  const set = new Set();
  for (const part of parts) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`"${part}" is not a page or a range. Try something like 9-11, 25.`);
    let a = Number(m[1]);
    let b = m[2] === undefined ? a : Number(m[2]);
    if (a < 1 || b < 1) throw new Error('Pages start at 1.');
    if (b < a) [a, b] = [b, a];
    if (Number.isFinite(max) && b > max) throw new Error(`This document has ${max} pages, so page ${b} is past the end.`);
    if (b - a + 1 > MAX_SPAN) throw new Error('That range is too long.');
    for (let p = a; p <= b; p++) {
      set.add(p);
      if (set.size > limit) throw new Error(`That is more than ${limit} pages. Pick fewer, or make the lessons in two goes.`);
    }
  }
  return [...set].sort((x, y) => x - y);
}

export function groupRanges(pages) {
  const sorted = [...new Set((Array.isArray(pages) ? pages : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    .sort((a, b) => a - b);
  const out = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && p === last[1] + 1) last[1] = p;
    else out.push([p, p]);
  }
  return out;
}

export function formatPages(pages) {
  return groupRanges(pages).map(([a, b]) => (a === b ? String(a) : `${a}–${b}`)).join(', ');
}

export function printedToPdf(pages, offset = 0) {
  const o = Number(offset) || 0;
  return (Array.isArray(pages) ? pages : []).map((p) => p + o);
}

export function pdfToPrinted(pages, offset = 0) {
  const o = Number(offset) || 0;
  return (Array.isArray(pages) ? pages : []).map((p) => p - o);
}
