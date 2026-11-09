// Builds simulated recognition events for the ?sim= mode.
//   node test/make-fixture.mjs [script.md] [name.json]
// Defaults: test/fixtures/sample-two.md → test/fixtures/run1.json.
// Then open http://localhost:5178/?sim=run1.json to watch scrolling, the next-speaker cue,
// inertia scrolling and auto-stop without a microphone.

import fs from 'node:fs';
import path from 'node:path';
import { buildAliasMap } from '../public/normalize.js';
import { parseScript } from '../public/parse.js';
import { simulate } from './simulate.mjs';

const root = new URL('..', import.meta.url);
const scriptPath = process.argv[2] ?? 'test/fixtures/sample-two.md';
const name = path.basename(process.argv[3] ?? 'run1.json');
const aliasMap = buildAliasMap(JSON.parse(fs.readFileSync(new URL('aliases.json', root), 'utf8')));
const parsed = parseScript(fs.readFileSync(new URL(scriptPath, root), 'utf8'), aliasMap);
const sim = simulate(parsed, { wpm: 140, restartEvery: 40, drop: 4 });
const out = new URL(`test/fixtures/${name}`, root);
fs.writeFileSync(out, JSON.stringify({
  note: `${scriptPath}: 140 wpm, misheard names and rewritten numbers, recognition restarts every 40 words and drops 4`,
  scriptHash: parsed.hash,
  ...sim,
}));
console.log(`Wrote test/fixtures/${name}: ${sim.events.length} events, about ${Math.round(sim.events.at(-1).t / 1000)} s`);
