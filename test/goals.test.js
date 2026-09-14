import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SKILLS, CHALLENGE_TYPES, BUILTIN_TEMPLATES, TEMPLATE_FIELDS, DEFAULT_GOALS,
  focusOf, normaliseGoals, learnerProfile, recommendedTemplates, recommendedChallengeTypes, normaliseTemplates,
} from '../shared/goals.js';

test('focusOf reads what the learner wants to be able to do', () => {
  assert.equal(focusOf({ skills: ['speak', 'listen'] }), 'speaking');
  assert.equal(focusOf({ skills: ['speak', 'type'] }), 'speaking', 'typing does not make it a character course');
  assert.equal(focusOf({ skills: ['read', 'write'] }), 'characters');
  assert.equal(focusOf({ skills: ['speak', 'read'] }), 'balanced');
  assert.equal(focusOf({ skills: [] }), 'balanced');
  assert.equal(focusOf(undefined), 'balanced');
});

test('normaliseGoals keeps known answers only', () => {
  const g = normaliseGoals({ skills: ['speak', 'fly', 'speak'], reasons: ['taiwan', 'nope'], classes: 'daily', about: `  ${'x'.repeat(600)}  `, onboardedAt: 'not a date' });
  assert.deepEqual(g.skills, ['speak']);
  assert.deepEqual(g.reasons, ['taiwan']);
  assert.equal(g.classes, DEFAULT_GOALS.classes);
  assert.equal(g.about.length, 500);
  assert.equal(g.onboardedAt, null);
  assert.deepEqual(normaliseGoals(null), DEFAULT_GOALS);
});

test('a speaking learner gets small characters and sound-first practice', () => {
  const p = learnerProfile({ script: 'pinyin', goals: { skills: ['speak', 'listen'], onboardedAt: '2026-09-13T20:00:00Z' } });
  assert.equal(p.focus, 'speaking');
  assert.equal(p.hanzi, 'small');
  assert.equal(p.script, 'pinyin');
  assert.equal(p.onboarded, true);
  assert.deepEqual(p.templates, ['say', 'listening', 'sound']);
  assert.ok(p.challengeTypes.includes('speak') && p.challengeTypes.includes('tones'));
  assert.ok(!p.challengeTypes.includes('mc-hanzi') && !p.challengeTypes.includes('cloze'));
  assert.equal(learnerProfile({ goals: { skills: ['speak'] }, display: { hanzi: 'hidden' } }).hanzi, 'hidden', 'an explicit choice wins');
  assert.equal(learnerProfile({}).onboarded, false);
});

test('every recommendation names something that exists', () => {
  const templateIds = BUILTIN_TEMPLATES.map((t) => t.id);
  const typeIds = CHALLENGE_TYPES.map((t) => t.id);
  for (const focus of ['speaking', 'characters', 'balanced']) {
    for (const id of recommendedTemplates(focus)) assert.ok(templateIds.includes(id), `${focus}: template ${id}`);
    for (const id of recommendedChallengeTypes(focus)) assert.ok(typeIds.includes(id), `${focus}: type ${id}`);
  }
  for (const t of BUILTIN_TEMPLATES) for (const f of [...t.front, ...t.back]) assert.ok(TEMPLATE_FIELDS.includes(f), `${t.id} uses ${f}`);
  assert.equal(recommendedChallengeTypes('balanced').length, CHALLENGE_TYPES.length);
  assert.equal(SKILLS.length, 5);
});

test('normaliseTemplates restores builtins, keeps choices and custom templates', () => {
  const stored = [
    { id: 'recognition', name: 'Recognition', front: ['hanzi'], back: ['meaning'], builtin: true, enabled: false },
    { id: 'listening', name: 'Listening', front: ['audio'], back: ['hanzi'], builtin: true, enabled: true },
    { id: 'mine', name: 'Mine', front: ['meaning'], back: ['reading'], builtin: false, enabled: true },
  ];
  const out = normaliseTemplates(stored);
  assert.deepEqual(out.map((t) => t.id), ['recognition', 'production', 'say', 'sound', 'listening', 'cloze', 'mine']);
  const byId = Object.fromEntries(out.map((t) => [t.id, t]));
  assert.equal(byId.recognition.enabled, false, 'the learner turned it off');
  assert.equal(byId.recognition.name, 'Characters → meaning', 'the definition follows the code');
  assert.deepEqual(byId.listening.back, ['meaning', 'reading', 'hanzi']);
  assert.equal(byId.say.enabled, false, 'a new builtin arrives switched off');
  assert.equal(byId.production.enabled, true, 'the old defaults stay on when missing');
  assert.equal(byId.mine.enabled, true);
  assert.equal(normaliseTemplates(undefined).length, BUILTIN_TEMPLATES.length);
});
