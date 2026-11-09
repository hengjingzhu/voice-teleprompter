import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildAliasMap, normalizeText } from '../public/normalize.js';
import { parseScript } from '../public/parse.js';
import { createMatcher, endHeard } from '../public/matcher.js';
import { estimate, measureWpm } from '../public/estimate.js';
import { simulate } from './simulate.mjs';

const root = new URL('..', import.meta.url);
const aliasMap = buildAliasMap(JSON.parse(fs.readFileSync(new URL('aliases.json', root), 'utf8')));
const load = (rel) => parseScript(fs.readFileSync(new URL(rel, root), 'utf8'), aliasMap);
const tail = (text) => normalizeText(text.split(/\s+/).slice(-24).join(' '), aliasMap).slice(-8);

// Tests about specific sentences use the fixed sample.
const sample = load('test/fixtures/sample-two.md');

// The simulations run on the sample, every example script, and your own script.md when it exists,
// so `npm test` also tells you whether the prompter can follow a new script to the end.
const SCRIPTS = ['test/fixtures/sample-two.md'];
if (fs.existsSync(new URL('examples/', root))) {
  for (const f of fs.readdirSync(new URL('examples/', root)).sort()) if (f.endsWith('.md')) SCRIPTS.push(`examples/${f}`);
}
if (fs.existsSync(new URL('script.md', root))) SCRIPTS.push('script.md');

/** Position after the last word the simulation "heard". Restarts drop words, sometimes the final Thanks. */
const lastHeard = (sim) => sim.events.filter((e) => e.text).at(-1).truth;

/** Feeds simulated events to a matcher; returns the trace of [true position, cursor] after each event. */
function run(parsed, sim) {
  const m = createMatcher(parsed.tokens);
  let wideUntil = -1;
  let lastAdvance = 0;
  let prev = 0;
  const trace = [];
  for (const ev of sim.events) {
    if (ev.restart) { wideUntil = ev.t + 3000; continue; }
    if (m.update([tail(ev.text)], ev.t, { wide: ev.t < wideUntil, far: ev.t - lastAdvance > 2000 })) lastAdvance = ev.t;
    assert.ok(m.cursor >= prev, `t=${ev.t} moved backwards`);
    prev = m.cursor;
    trace.push({ t: ev.t, truth: ev.truth, cursor: m.cursor, text: ev.text.split(' ').slice(-3).join(' ') });
  }
  return { m, trace };
}

function checkTrace(trace, { maxLag = 8, okLag = 2, okShare = 0.85 } = {}) {
  for (const r of trace) {
    assert.ok(r.cursor <= r.truth + 1, `ran ahead: t=${r.t} truth=${r.truth} cursor=${r.cursor} "${r.text}"`);
    assert.ok(r.truth - r.cursor <= maxLag, `fell too far behind: t=${r.t} truth=${r.truth} cursor=${r.cursor} "${r.text}"`);
  }
  const good = trace.filter((r) => r.truth - r.cursor <= okLag).length / trace.length;
  assert.ok(good >= okShare, `only ${(good * 100).toFixed(0)}% of moments are within ${okLag} tokens`);
}

for (const file of SCRIPTS) {
  describe(`follows ${file}`, () => {
    const parsed = load(file);

    test('read exactly (no mishearings, no restarts): follows to the end', () => {
      const sim = simulate(parsed, { subs: {}, restartEvery: 1e9 });
      const { m, trace } = run(parsed, sim);
      checkTrace(trace, { maxLag: 3, okLag: 1, okShare: 0.9 });
      assert.equal(m.cursor, lastHeard(sim));
    });

    test('misheard names, rewritten numbers, a restart every 40 words dropping 3: still follows', () => {
      const sim = simulate(parsed);
      const { m, trace } = run(parsed, sim);
      checkTrace(trace);
      assert.equal(m.cursor, lastHeard(sim));
    });

    test('more restarts, more dropped words (5 every 25)', () => {
      const sim = simulate(parsed, { restartEvery: 25, drop: 5 });
      const { m, trace } = run(parsed, sim);
      checkTrace(trace, { maxLag: 10, okShare: 0.75 });
      assert.equal(m.cursor, lastHeard(sim));
    });

    test('numbering read aloud ("one, order…") still follows', () => {
      const sim = simulate(parsed, { speakNumbering: true });
      const { m, trace } = run(parsed, sim);
      checkTrace(trace);
      assert.equal(m.cursor, lastHeard(sim));
    });

    test('20 words of pure noise: catches up afterwards and follows to the end', { skip: parsed.words.length < 60 && 'script shorter than 60 words' }, () => {
      const start = Math.floor(parsed.words.length * 0.4);
      const sim = simulate(parsed, { garble: [start, start + 20], restartEvery: 1e9 });
      const { m, trace } = run(parsed, sim);
      assert.equal(m.cursor, parsed.tokens.length);
      for (const r of trace) assert.ok(r.cursor <= r.truth + 1, `ran ahead: t=${r.t}`);
      // Within 10 events after the noise ends, the cursor is at most 3 tokens behind.
      const endIdx = trace.findIndex((r) => r.truth >= parsed.words[start + 20].readAt);
      const after = trace.slice(endIdx + 10, endIdx + 20);
      assert.ok(after.every((r) => r.truth - r.cursor <= 3), `did not catch up: ${JSON.stringify(after.map((r) => r.truth - r.cursor))}`);
    });
  });
}

test('a stutter: a repeated "in" does not pull the cursor to a later "in"', () => {
  const at = sample.words.findIndex((w, i) => w.text === 'in' && sample.words[i - 1]?.text === 'worked');
  assert.ok(at > 0);
  const sim = simulate(sample, { extra: { [at]: 'in' } });
  const { m, trace } = run(sample, sim);
  checkTrace(trace);
  assert.equal(m.cursor, lastHeard(sim));
});

test('hearing a single stop word does not jump to a later copy of it', () => {
  const m = createMatcher(sample.tokens);
  // Read up to "Brightcup is a small coffee cart in the city."
  m.update([tail('hi im maya im leo and we run brightcup brightcup is a small coffee cart in the city')], 0);
  const c = m.cursor;
  assert.equal(sample.tokens[c].t, 'we');
  m.update([['and']], 1);
  assert.equal(m.cursor, c);
  m.update([['the']], 2);
  assert.equal(m.cursor, c);
});

test('a sentence that is not in the script does not move the cursor', () => {
  const m = createMatcher(sample.tokens);
  m.update([tail('hi im maya')], 0);
  const c = m.cursor;
  m.update([tail('hi im maya sorry can we start again please')], 1);
  assert.ok(m.cursor - c <= 1, `jumped to ${m.cursor}`);
});

test('wheel moves: forward is marked manual, backward just goes back', () => {
  const m = createMatcher(sample.tokens);
  m.set(10, 0);
  assert.equal(m.cursor, 10);
  assert.equal(m.manual[5], 1);
  assert.equal(m.times[5], null);
  m.set(4, 0);
  assert.equal(m.cursor, 4);
});

test('ending: "Thanks" counts only once the second-to-last block is reached', () => {
  // The sample ends with "Both: Thanks!"
  const blocks = sample.blocks.filter((b) => b.tokEnd > b.tokStart);
  const prev = blocks[blocks.length - 2];
  assert.equal(endHeard(sample, prev.tokStart, ['coffee', 'thanks']), true);
  assert.equal(endHeard(sample, prev.tokStart + 5, ['thank', 'you']), false); // raw words that skipped the alias table do not count
  assert.equal(endHeard(sample, prev.tokStart + 5, normalizeText('thank you', aliasMap)), true);
  assert.equal(endHeard(sample, prev.tokStart - 1, ['thanks']), false);
  assert.equal(endHeard(sample, 0, ['thanks']), false);
});

// ── Replays of real takes ──
// Real recordings are private and not in the repo. Put them in test/private/ to run these tests.
// They were recorded with a laptop's built-in mic; parts with a strong accent came out as noise.
// Older takes stored only the latest recognition text, so the replay sees less text than the live run did.
const privateDir = new URL('test/private/', root);
const hasPrivate = (name) => fs.existsSync(new URL(`${name}.json`, privateDir));
const NO_PRIVATE = 'private real-take data not present (test/private/)';

function replay(name) {
  const fx = JSON.parse(fs.readFileSync(new URL(`${name}.json`, privateDir), 'utf8'));
  const p = parseScript(fx.scriptSnapshot, aliasMap);
  const m = createMatcher(p.tokens);
  const finals = [];
  let lastAdvance = 0;
  let endAt = null;
  let cursorAtEnd = null;
  for (const ev of fx.events) {
    const tl = ev.tail != null ? ev.tail.split(' ').filter(Boolean) : tail([...finals, ev.text].join(' '));
    if (ev.final) finals.push(ev.text);
    if (m.update([tl], ev.t, { far: ev.t - lastAdvance > 2000 })) lastAdvance = ev.t;
    if (endAt == null && ev.t >= 10000 && endHeard(p, m.cursor, tl)) { endAt = ev.t; cursorAtEnd = m.cursor; }
  }
  return { fx, p, m, endAt, cursorAtEnd };
}

test('real take 01: follows all the way to "Thanks"', { skip: !hasPrivate('real-take01') && NO_PRIVATE }, () => {
  const { p, endAt, cursorAtEnd } = replay('real-take01');
  assert.ok(endAt != null && endAt < 101000, `ending not recognised: ${endAt}`);
  assert.ok(cursorAtEnd >= p.tokens.length - 3, `only reached ${cursorAtEnd}/${p.tokens.length} at the end`);
});

test('real take 02: last block came out as noise, ending still recognised at the first "Thanks" (89 s)', { skip: !hasPrivate('real-take02') && NO_PRIVATE }, () => {
  const { p, endAt, cursorAtEnd } = replay('real-take02');
  // In the live run the cursor stuck at token 197; the speaker said Thanks, then wheeled 28 words and said thank you again at 96 s.
  assert.ok(endAt != null && endAt < 90000, `ending recognised too late: ${endAt}`);
  assert.ok(cursorAtEnd > 197, `did not catch up at all in the noisy part: ${cursorAtEnd}`);
  assert.ok(p.tokens.length - cursorAtEnd <= 12, `${p.tokens.length - cursorAtEnd} tokens short of the end`);
});

test('real take 01: estimate from its measured speeds is within 6 s of the real length', { skip: !hasPrivate('real-take01') && NO_PRIVATE }, () => {
  const fx = JSON.parse(fs.readFileSync(new URL('real-take01.json', privateDir), 'utf8'));
  const p = parseScript(fx.scriptSnapshot, aliasMap);
  const wpm = measureWpm(p, fx.tokenTimes);
  const { total } = estimate(p, wpm);
  assert.ok(Math.abs(total - fx.durationMs / 1000) < 6, `estimated ${total.toFixed(1)} s, real ${(fx.durationMs / 1000).toFixed(1)} s, speeds ${JSON.stringify(wpm)}`);
});
