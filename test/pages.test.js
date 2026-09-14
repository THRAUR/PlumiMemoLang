import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePages, formatPages, groupRanges, printedToPdf, pdfToPrinted } from '../shared/pages.js';

test('parsePages reads the ways people type page ranges', () => {
  assert.deepEqual(parsePages('9-11, 25'), [9, 10, 11, 25]);
  assert.deepEqual(parsePages('9–11 and 25'), [9, 10, 11, 25]);
  assert.deepEqual(parsePages('pages 9 to 11, p. 25'), [9, 10, 11, 25]);
  assert.deepEqual(parsePages('p25'), [25]);
  assert.deepEqual(parsePages('25, 9-11, 10'), [9, 10, 11, 25], 'sorted and deduped');
  assert.deepEqual(parsePages('11-9'), [9, 10, 11], 'a backwards range is turned around');
  assert.deepEqual(parsePages('9 10 12'), [9, 10, 12]);
  assert.deepEqual(parsePages('第9到11頁、25'), [9, 10, 11, 25]);
});

test('parsePages refuses nonsense with a sentence', () => {
  assert.throws(() => parsePages(''), /Type the pages/);
  assert.throws(() => parsePages('chapter two'), /not a page or a range/);
  assert.throws(() => parsePages('0-3'), /start at 1/);
  assert.throws(() => parsePages('9-300', { max: 214 }), /214 pages, so page 300/);
  assert.throws(() => parsePages('1-40', { limit: 20 }), /more than 20 pages/);
  assert.throws(() => parsePages('1-900000'), /too long/);
});

test('formatPages, groupRanges and page offsets', () => {
  assert.equal(formatPages([25, 9, 10, 11]), '9–11, 25');
  assert.equal(formatPages([]), '');
  assert.deepEqual(groupRanges([25, 9, 10, 11]), [[9, 11], [25, 25]]);
  assert.deepEqual(printedToPdf([9, 25], 12), [21, 37], 'book page 1 is PDF page 13');
  assert.deepEqual(pdfToPrinted([21, 37], 12), [9, 25]);
});
