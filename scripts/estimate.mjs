// npm run estimate [-- path/to/script.md] — prints what the page would show for a script:
// the speakers it found, the spoken word count, the estimated length and the Target.
// Uses each speaker's measured speed from stats.json when there is one, else 130 words per minute.
// Words are counted the way the prompter counts them: "3 million" is one, "45%" is two, a leading "1." is none.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScript } from '../public/parse.js';
import { buildAliasMap } from '../public/normalize.js';
import { estimate, fmtSec, DEFAULT_WPM } from '../public/estimate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.resolve(root, process.argv[2] ?? 'script.md');
const parsed = parseScript(fs.readFileSync(file, 'utf8'), buildAliasMap(JSON.parse(fs.readFileSync(path.join(root, 'aliases.json'), 'utf8'))));
let stats = { wpm: {} };
try { stats = JSON.parse(fs.readFileSync(path.join(root, 'stats.json'), 'utf8')); } catch { /* no measured speeds yet */ }
const { total } = estimate(parsed, stats.wpm || {});
const words = parsed.tokens.filter((t) => !t.optional).length;

console.log(`Script:   ${path.relative(root, file) || file}`);
console.log(`Speakers: ${parsed.speakers.length ? parsed.speakers.join(', ') : '(none — the whole script is one block)'}`);
for (const s of parsed.speakers) console.log(`          ${s}: ${stats.wpm?.[s] ? `${stats.wpm[s]} wpm (measured)` : `${DEFAULT_WPM} wpm (default)`}`);
console.log(`Blocks:   ${parsed.blocks.map((b) => b.speaker || '(no speaker)').join(' · ')}`);
console.log(`Words:    ${words}`);
console.log(`Estimate: ${fmtSec(total)}${parsed.targetSec ? ` / Target ${fmtSec(parsed.targetSec)}${total > parsed.targetSec ? ' — OVER' : ''}` : ' (no Target line)'}`);
