import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildAliasMap, normalizeText, normalizeWords, similarity } from '../public/normalize.js';

const aliasMap = buildAliasMap(JSON.parse(fs.readFileSync(new URL('../aliases.json', import.meta.url), 'utf8')));
const n = (s) => normalizeText(s, aliasMap);

test('lower case, no punctuation, apostrophes dropped', () => {
  assert.deepEqual(n('Hi, I’m Maya.'), ['hi', 'im', 'maya']);
  assert.deepEqual(n("We've known each other"), ['weve', 'known', 'each', 'other']);
  assert.deepEqual(n('cross-border'), ['cross', 'border']);
});

test('numbers: words and digits come out the same', () => {
  assert.deepEqual(n('twenty years'), n('20 years'));
  assert.deepEqual(n('over 3 million small'), ['over', '3000000', 'small']);
  assert.deepEqual(n('three million'), ['3000000']);
  assert.deepEqual(n('3,000,000'), ['3000000']);
  assert.deepEqual(n('45% of them'), ['45', 'percent', 'of', 'them']);
  assert.deepEqual(n('forty five percent of them'), ['45', 'percent', 'of', 'them']);
  assert.deepEqual(n('worth 2500 dollars.'), ['worth', '2500', 'dollars']);
  assert.deepEqual(n('worth $2,500'), ['worth', '2500', 'dollars']);
  assert.deepEqual(n('two thousand five hundred dollars'), ['2500', 'dollars']);
  assert.deepEqual(n('over 3,000 cups and 400 bags'), ['over', '3000', 'cups', 'and', '400', 'bags']);
  assert.deepEqual(n('four hundred bags'), ['400', 'bags']);
  assert.deepEqual(n('sixty two orders'), ['62', 'orders']);
  assert.deepEqual(n('from 6 to 62'), ['from', '6', 'to', '62']);
  assert.deepEqual(n('two to five people'), ['2', 'to', '5', 'people']);
  assert.deepEqual(n('one two'), ['1', '2']);
  assert.deepEqual(n('five hundred and twelve'), ['512']);
  assert.deepEqual(n('cups and bags'), ['cups', 'and', 'bags']);
});

test('aliases for names', () => {
  assert.deepEqual(n('we built chiller hub'), ['we', 'built', 'chillahub']);
  assert.deepEqual(n('we built ChillaHub.'), ['we', 'built', 'chillahub']);
  assert.deepEqual(n('e bay and tick tock'), ['ebay', 'and', 'tiktok']);
  assert.deepEqual(n('Thank you'), ['thanks']);
});

test('normalizeWords remembers which raw words each token came from', () => {
  const r = normalizeWords(['over', '3', 'million', 'small'], aliasMap);
  assert.deepEqual(r, [
    { t: 'over', from: 0, to: 0 },
    { t: '3000000', from: 1, to: 2 },
    { t: 'small', from: 3, to: 3 },
  ]);
});

test('similarity', () => {
  assert.equal(similarity('store', 'store'), 1);
  assert.equal(similarity('store', 'stores'), 0.7);
  assert.equal(similarity('to', '2'), 0.8);
  assert.equal(similarity('15', '50'), 0);
  assert.equal(similarity('platform', 'platforms'), 0.7);
  assert.equal(similarity('competitors', 'competitor'), 0.7);
  assert.equal(similarity('day', 'they'), 0);
});
