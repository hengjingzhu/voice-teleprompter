// Builds simulated recognition events for the ?sim= mode.
//   node test/make-fixture.mjs [script.md] [name.json] [--timings words.json]
// Defaults: test/fixtures/sample-two.md → test/fixtures/run1.json, 140 words per minute.
// With --timings (word timestamps of a voice track: [{ word, startMs, endMs }]) the events follow that
// track, and the fixture also gets `setup` events for the sound check page and `audioOffsetMs`
// (where the track's 0 s sits after the start of recording).
// Then open http://localhost:5178/?sim=run1.json to watch scrolling, the next-speaker cue,
// inertia scrolling and auto-stop without a microphone (add &stage=setup to start on the sound check page).

import fs from 'node:fs';
import path from 'node:path';
import { buildAliasMap } from '../public/normalize.js';
import { parseScript } from '../public/parse.js';
import { simulate, simulateSetup } from './simulate.mjs';

const args = process.argv.slice(2);
const ti = args.indexOf('--timings');
const timingsPath = ti >= 0 ? args.splice(ti, 2)[1] : null;
const root = new URL('..', import.meta.url);
const scriptPath = args[0] ?? 'test/fixtures/sample-two.md';
const name = path.basename(args[1] ?? 'run1.json');
const aliasMap = buildAliasMap(JSON.parse(fs.readFileSync(new URL('aliases.json', root), 'utf8')));
const parsed = parseScript(fs.readFileSync(new URL(scriptPath, root), 'utf8'), aliasMap);
const timings = timingsPath ? JSON.parse(fs.readFileSync(path.resolve(timingsPath), 'utf8')) : null;
const sim = timings
  ? { ...simulate(parsed, { timings, restartEvery: 40, drop: 3 }), setup: simulateSetup(parsed, { timings }) }
  : { ...simulate(parsed, { wpm: 140, restartEvery: 40, drop: 4 }), setup: simulateSetup(parsed) };
const out = new URL(`test/fixtures/${name}`, root);
fs.writeFileSync(out, JSON.stringify({
  note: timings
    ? `${scriptPath}: follows the voice track ${path.basename(timingsPath)}, misheard names and rewritten numbers, recognition restarts every 40 words and drops 3`
    : `${scriptPath}: 140 wpm, misheard names and rewritten numbers, recognition restarts every 40 words and drops 4`,
  scriptHash: parsed.hash,
  ...sim,
}));
console.log(`Wrote test/fixtures/${name}: ${sim.events.length} events, about ${Math.round(sim.events.at(-1).t / 1000)} s`);
