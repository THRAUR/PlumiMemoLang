import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pinyinToZhuyin, zhuyinToPinyin, numbersToMarks, marksToNumbers, splitSyllables,
  normalizePinyin, pinyinMatches, isHanzi, hanziChars, alignReading, ZHUYIN_TONES,
} from '../shared/zhuyin.js';

const PAIRS = [
  ['nǚ', 'ㄋㄩˇ'], ['lǜ', 'ㄌㄩˋ'], ['qù', 'ㄑㄩˋ'], ['xué', 'ㄒㄩㄝˊ'], ['ér', 'ㄦˊ'], ['shì', 'ㄕˋ'], ['zi', '˙ㄗ'],
  ['yǒu', 'ㄧㄡˇ'], ['liù', 'ㄌㄧㄡˋ'], ['duì', 'ㄉㄨㄟˋ'], ['chūn', 'ㄔㄨㄣ'], ['jūn', 'ㄐㄩㄣ'], ['yòng', 'ㄩㄥˋ'],
  ['wēng', 'ㄨㄥ'], ['qióng', 'ㄑㄩㄥˊ'], ['yī', 'ㄧ'], ['wǔ', 'ㄨˇ'], ['yú', 'ㄩˊ'], ['yě', 'ㄧㄝˇ'], ['yuè', 'ㄩㄝˋ'],
  ['yuán', 'ㄩㄢˊ'], ['yún', 'ㄩㄣˊ'], ['wǒ', 'ㄨㄛˇ'], ['wèi', 'ㄨㄟˋ'], ['wén', 'ㄨㄣˊ'], ['wáng', 'ㄨㄤˊ'], ['dōng', 'ㄉㄨㄥ'],
  ['hē', 'ㄏㄜ'], ['fó', 'ㄈㄛˊ'], ['rè', 'ㄖㄜˋ'], ['rì', 'ㄖˋ'], ['zī', 'ㄗ'], ['cì', 'ㄘˋ'], ['sì', 'ㄙˋ'], ['zhī', 'ㄓ'],
  ['chī', 'ㄔ'], ['shí', 'ㄕˊ'], ['xiè xie', 'ㄒㄧㄝˋ ˙ㄒㄧㄝ'], ['nǐ hǎo', 'ㄋㄧˇ ㄏㄠˇ'], ['shén me', 'ㄕㄣˊ ˙ㄇㄜ'],
  ['péng yǒu', 'ㄆㄥˊ ㄧㄡˇ'], ['lǎo shī', 'ㄌㄠˇ ㄕ'], ['zhōng guó', 'ㄓㄨㄥ ㄍㄨㄛˊ'], ['diàn yǐng', 'ㄉㄧㄢˋ ㄧㄥˇ'],
  ['jué dìng', 'ㄐㄩㄝˊ ㄉㄧㄥˋ'], ['qún', 'ㄑㄩㄣˊ'], ['lüè', 'ㄌㄩㄝˋ'], ['zhōu', 'ㄓㄡ'], ['guì', 'ㄍㄨㄟˋ'], ['lùn', 'ㄌㄨㄣˋ'],
  ['yíng', 'ㄧㄥˊ'], ['biàn dāng', 'ㄅㄧㄢˋ ㄉㄤ'], ['jié yùn', 'ㄐㄧㄝˊ ㄩㄣˋ'], ['duō shǎo qián', 'ㄉㄨㄛ ㄕㄠˇ ㄑㄧㄢˊ'],
  ['pián yi', 'ㄆㄧㄢˊ ˙ㄧ'], ['dōng xi', 'ㄉㄨㄥ ˙ㄒㄧ'], ['nǐ chī fàn le ma', 'ㄋㄧˇ ㄔ ㄈㄢˋ ˙ㄌㄜ ˙ㄇㄚ'],
];

test('pinyin → zhuyin for every reference pair', () => {
  for (const [py, zy] of PAIRS) assert.equal(pinyinToZhuyin(py), zy, `pinyinToZhuyin(${py})`);
});
test('zhuyin → pinyin for every reference pair', () => {
  for (const [py, zy] of PAIRS) assert.equal(zhuyinToPinyin(zy), py, `zhuyinToPinyin(${zy})`);
});
test('pinyinToZhuyin accepts digits, unspaced input and v for ü', () => {
  assert.equal(pinyinToZhuyin('xie4 xie5'), 'ㄒㄧㄝˋ ˙ㄒㄧㄝ');
  assert.equal(pinyinToZhuyin('xie4xie5'), 'ㄒㄧㄝˋ ˙ㄒㄧㄝ');
  assert.equal(pinyinToZhuyin('nǐhǎo'), 'ㄋㄧˇ ㄏㄠˇ');
  assert.equal(pinyinToZhuyin('lv4'), 'ㄌㄩˋ');
  assert.equal(pinyinToZhuyin('nu:3'), 'ㄋㄩˇ');
});
test('pinyinToZhuyin leaves non-pinyin text alone and drops tone symbols for toneless multi-syllable input', () => {
  assert.equal(pinyinToZhuyin('nǐ hǎo, wǒ shì Arthur'), 'ㄋㄧˇ ㄏㄠˇ, ㄨㄛˇ ㄕˋ Arthur');
  assert.equal(pinyinToZhuyin('nihao'), 'ㄋㄧ ㄏㄠ');
  assert.equal(pinyinToZhuyin(''), '');
  assert.equal(pinyinToZhuyin('謝謝'), '謝謝');
});
test('zhuyinToPinyin keeps punctuation and foreign words', () => {
  assert.equal(zhuyinToPinyin('ㄋㄧˇ ㄏㄠˇ，ㄨㄛˇ ㄕˋ Arthur'), 'nǐ hǎo，wǒ shì Arthur');
  assert.equal(zhuyinToPinyin('ㄒㄧㄝˋ˙ㄒㄧㄝ'), 'xiè xie');   // unspaced zhuyin still splits
});
test('numbersToMarks and marksToNumbers', () => {
  assert.equal(numbersToMarks('ni3 hao3'), 'nǐ hǎo');
  assert.equal(numbersToMarks('lv4'), 'lǜ');
  assert.equal(numbersToMarks('xie4xie5'), 'xièxie');
  assert.equal(numbersToMarks('Zhong1 guo2'), 'Zhōng guó');
  assert.equal(numbersToMarks('liu4'), 'liù');
  assert.equal(numbersToMarks('gui4'), 'guì');
  assert.equal(numbersToMarks('you3'), 'yǒu');
  assert.equal(marksToNumbers('nǐ hǎo'), 'ni3 hao3');
  assert.equal(marksToNumbers('xiè xie'), 'xie4 xie5');
  assert.equal(marksToNumbers('lǜ'), 'lü4');
});
test('splitSyllables', () => {
  assert.deepEqual(splitSyllables('nǐhǎo'), ['nǐ', 'hǎo']);
  assert.deepEqual(splitSyllables("xi'an"), ['xi', 'an']);
  assert.deepEqual(splitSyllables('xian'), ['xian']);
  assert.deepEqual(splitSyllables('fangan'), ['fan', 'gan']);
  assert.deepEqual(splitSyllables('shíèr'), ['shí', 'èr']);
  assert.deepEqual(splitSyllables('xie4xie5'), ['xie4', 'xie5']);
  assert.deepEqual(splitSyllables('zhōng guó'), ['zhōng', 'guó']);
  assert.deepEqual(splitSyllables('Arthur'), ['Arthur']);
});
test('normalizePinyin and pinyinMatches', () => {
  assert.equal(normalizePinyin('Xiè xie'), 'xie4xie5');
  assert.equal(normalizePinyin('Xiè xie', { tones: false }), 'xiexie');
  assert.equal(normalizePinyin('lǜ sè'), 'lv4se4');
  assert.ok(pinyinMatches('xiexie', 'xiè xie', { tones: false }));
  assert.ok(pinyinMatches('xie4xie', 'xiè xie'), 'a missing neutral digit counts as 5');
  assert.ok(pinyinMatches('xie4 xie5', 'xiè xie'));
  assert.ok(!pinyinMatches('xie4xie4', 'xiè xie'));
  assert.ok(!pinyinMatches('', 'xiè xie'));
  assert.ok(pinyinMatches('ㄒㄧㄝˋ˙ㄒㄧㄝ', 'xiè xie'));
  assert.ok(pinyinMatches('ㄒㄧㄝ ㄒㄧㄝ', 'xiè xie', { tones: false }));
  assert.ok(!pinyinMatches('ㄒㄧㄝ ㄒㄧㄝ', 'xiè xie'));
});
test('isHanzi, hanziChars, alignReading', () => {
  assert.ok(isHanzi('謝'));
  assert.ok(!isHanzi('a'));
  assert.ok(!isHanzi('，'));
  assert.deepEqual(hanziChars('你好嗎？ ok'), ['你', '好', '嗎']);
  assert.deepEqual(alignReading('謝謝', 'ㄒㄧㄝˋ ˙ㄒㄧㄝ'), ['ㄒㄧㄝˋ', '˙ㄒㄧㄝ']);
  assert.deepEqual(alignReading('謝謝你', 'xièxie nǐ'), ['xiè', 'xie', 'nǐ']);
  assert.equal(alignReading('謝謝', 'xiè'), null);
  assert.deepEqual(alignReading('你好嗎？', 'nǐ hǎo ma'), ['nǐ', 'hǎo', 'ma']);
  assert.equal(alignReading('', 'nǐ'), null);
});
test('ZHUYIN_TONES', () => {
  assert.deepEqual(ZHUYIN_TONES, { 1: '', 2: 'ˊ', 3: 'ˇ', 4: 'ˋ', 5: '˙' });
});
