import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildAliasMap } from '../public/normalize.js';
import { parseScript } from '../public/parse.js';

const aliasMap = buildAliasMap(JSON.parse(fs.readFileSync(new URL('../aliases.json', import.meta.url), 'utf8')));
// Parser rules are tested on a fixed sample (numbering, "3 million", "45%", titles, Both).
// How well the prompter follows real scripts is tested by the simulations in matcher.test.mjs.
const script = fs.readFileSync(new URL('./fixtures/sample-two.md', import.meta.url), 'utf8');
const parsed = parseScript(script, aliasMap);

test('finds the speakers and blocks', () => {
  assert.deepEqual(parsed.speakers, ['Maya', 'Leo']);
  assert.deepEqual(parsed.blocks.map((b) => b.speaker), ['Maya', 'Leo', 'Maya', 'Leo', 'Maya', 'Leo', 'Both']);
  assert.deepEqual(parsed.blocks.map((b) => b.title), ['', '', '', '', 'Why us', 'Next', '']);
  assert.equal(parsed.blocks[6].both, true);
});

test('"1. Order:" is not a speaker, and the number is an optional token', () => {
  const leo = parsed.blocks[3];
  const first = parsed.paras[leo.paras[1]];
  const w = parsed.words[first.wordStart];
  assert.equal(w.text, '1.');
  assert.equal(w.optional, true);
  const tok = parsed.tokens[first.tokStart];
  assert.equal(tok.t, '1');
  assert.equal(tok.optional, true);
  assert.equal(parsed.tokens[first.tokStart + 1].t, 'order');
});

test('"3 million" becomes one token that owns both words', () => {
  const tok = parsed.tokens.find((t) => t.t === '3000000');
  assert.ok(tok);
  assert.equal(parsed.words[tok.from].text, '3');
  assert.equal(parsed.words[tok.to].text, 'million');
  assert.equal(parsed.words[tok.from].readAt, tok.index + 1);
  assert.equal(parsed.words[tok.to].readAt, tok.index + 1);
});

test('weights: names and numbers heavy, stop words light', () => {
  const w = (t) => parsed.tokens.find((x) => x.t === t).weight;
  assert.equal(w('ebay'), 1.5);
  assert.equal(w('tiktok'), 1.5);
  assert.equal(w('45'), 1.5);
  assert.equal(w('of'), 0.3);
  assert.equal(w('coffee'), 1);
  assert.equal(w('im'), 0.3);
  assert.equal(parsed.tokens.find((x) => x.optional).weight, 0.3);
});

test('block token ranges are contiguous and the last token is "thanks"', () => {
  let k = 0;
  for (const b of parsed.blocks) {
    assert.equal(b.tokStart, k);
    k = b.tokEnd;
  }
  assert.equal(k, parsed.tokens.length);
  assert.equal(parsed.tokens[parsed.tokens.length - 1].t, 'thanks');
});

test('phrases split at punctuation, at least one per paragraph', () => {
  assert.ok(parsed.phraseStarts.length > parsed.paras.length);
  assert.equal(parsed.phraseStarts[0], 0);
});

test('// comment lines add no words or tokens', () => {
  const p = parseScript('// a note\nAlex: Hello there.\n  // indented note\nAlex: Bye.', aliasMap);
  assert.deepEqual(p.tokens.map((t) => t.t), ['hello', 'there', 'bye']);
  assert.equal(p.paras.length, 2);
  // "//" in the middle of a line is ordinary text
  const q = parseScript('Visit chillahub.ai // today', aliasMap);
  assert.ok(q.words.some((w) => w.text === '//'));
});

test('"Target: m:ss" on the first line sets the limit and is never a speaker', () => {
  const p = parseScript('// note first\nTarget: 1:05\nAlex: Hi.\nAlex: Bye.', aliasMap);
  assert.equal(p.targetSec, 65);
  assert.deepEqual(p.speakers, ['Alex']);
  assert.ok(!p.words.some((w) => /target/i.test(w.text)));
  assert.equal(parseScript('target : 0:45\nHi.', aliasMap).targetSec, 45);
  assert.equal(parseScript('Hi.', aliasMap).targetSec, null);
});

test('"Target:" anywhere else, or in another form, is spoken text', () => {
  const later = parseScript('Alex: Hi.\nTarget: 1:00', aliasMap);
  assert.equal(later.targetSec, null);
  assert.ok(later.words.some((w) => w.text === 'Target:'));
  for (const bad of ['Target: 90', 'Target: 1:75', 'Target: one minute']) {
    const p = parseScript(`${bad}\nHi.`, aliasMap);
    assert.equal(p.targetSec, null, bad);
    assert.equal(p.words[0].text, 'Target:', bad);
  }
});

test('every example script parses, has speakers or text, and sets a Target', () => {
  const dir = new URL('../examples/', import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.ok(files.includes('demo-two-speakers.md'));
  for (const f of files) {
    const p = parseScript(fs.readFileSync(new URL(f, dir), 'utf8'), aliasMap);
    assert.ok(p.tokens.length > 20, f);
    assert.ok(p.targetSec > 0, f);
    assert.ok(!p.words.some((w) => w.text.startsWith('//')), `${f}: a comment leaked into the text`);
  }
});

test('a "Name: text" line seen once, with no empty-colon form, is not a speaker', () => {
  const p = parseScript('Alex:\nNote: this is a line.\nMore text.', aliasMap);
  assert.equal(p.blocks.length, 1);
  assert.equal(p.paras.length, 2);
});
