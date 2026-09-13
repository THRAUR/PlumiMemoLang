#!/usr/bin/env node
/* Seed a running server with the fixture: node scripts/seed.mjs http://127.0.0.1:3098 [fixture.json]
   Creates the lessons, then the words (attached to their lesson), then a few
   graded reviews so scores and the streak are not all zero. */
import fs from 'node:fs/promises';

const base = (process.argv[2] || 'http://127.0.0.1:3080').replace(/\/$/, '');
const file = process.argv[3] || new URL('../test/fixtures/seed.json', import.meta.url);
const fx = JSON.parse(await fs.readFile(file, 'utf8'));

async function call(method, path, body) {
  const res = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${data?.error || ''}`);
  return data;
}

const lessonIdByHanzi = new Map();
const lessons = [];
for (const l of fx.lessons) {
  const { words, ...rest } = l;
  const created = await call('POST', '/lessons', rest);
  lessons.push({ created, words });
  for (const hz of words) lessonIdByHanzi.set(hz, created.id);
}
const idByHanzi = new Map();
for (const w of fx.words) {
  const res = await call('POST', '/words', { ...w, lessonId: lessonIdByHanzi.get(w.hanzi) || null });
  const word = res.word || res;
  idByHanzi.set(w.hanzi, word.id);
}
for (const { created, words } of lessons) {
  await call('PUT', `/lessons/${created.id}`, { wordIds: words.map((hz) => idByHanzi.get(hz)).filter(Boolean) });
}
// A little history: grade the first lesson's words Good twice so they are "seen".
let graded = 0;
for (const hz of fx.lessons[0].words) {
  const id = idByHanzi.get(hz);
  if (!id) continue;
  try { await call('POST', '/review/grade', { wordId: id, grade: 2, templateId: 'recognition', ms: 3000 }); graded++; } catch (e) { console.warn(e.message); break; }
}
console.log(`seeded ${lessons.length} lessons, ${idByHanzi.size} words, ${graded} grades at ${base}`);
