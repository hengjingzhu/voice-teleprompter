// Placeholder source assets for the docs media pipeline, so it can be built and tested before the real
// voice and video exist. Writes the same files docs/media-src/ holds (see docs/demo-media.md):
//   demo-script.md, voice-full.wav, timings.json, lines.json, opening-voice.wav, opening.mp4, idle-loop.mp4
// The "voice" is silence with one short beep per word (each speaker has their own pitch), at plausible
// times: about 300 ms per word, pauses at sentence ends and longer ones at speaker changes.
// The videos are ffmpeg test patterns with a big label; opening.mp4 names who is speaking, and both show
// their frame number, so lip sync can be checked on the contact sheets.
//
//   node scripts/docs-media/make-placeholders.mjs [--out <dir>] [--script <file>] [--font-en <file>]
// Defaults: --out docs/media-out/placeholder-src (git-ignored), --script examples/demo-two-speakers.md
// Then: node scripts/docs-media/build.mjs --src docs/media-out/placeholder-src

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAliasMap } from '../../public/normalize.js';
import { parseScript } from '../../public/parse.js';
import { run, needTools, fontFile, setFontFlags } from './encode.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RATE = 48000;

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

/** Word timestamps and per-line times for a script, at a made-up but plausible reading pace. */
export function placeholderTimings(parsed) {
  const timings = [];
  const lines = [];
  let t = 450;
  let lastSpeaker = null;
  for (const b of parsed.blocks) {
    for (const pi of b.paras) {
      const p = parsed.paras[pi];
      if (lastSpeaker !== null) t += b.speaker !== lastSpeaker ? 750 : 250;
      lastSpeaker = b.speaker;
      const startMs = t;
      for (let w = p.wordStart; w < p.wordEnd; w++) {
        const word = parsed.words[w];
        if (word.optional) continue;
        const clean = word.text.replace(/^[^A-Za-z0-9$']+|[^A-Za-z0-9%']+$/g, '');
        if (!clean) continue;
        const dur = Math.min(480, 190 + 22 * clean.length);
        timings.push({ word: clean, startMs: Math.round(t), endMs: Math.round(t + dur), speaker: b.speaker });
        t += dur + 70;
        if (/[.?!]["”’)]*$/.test(word.text) && w < p.wordEnd - 1) t += 300;
      }
      lines.push({ speaker: b.speaker, text: parsed.words.slice(p.wordStart, p.wordEnd).map((x) => x.text).join(' '), startMs, endMs: timings.at(-1).endMs });
    }
  }
  return { timings, lines, durationMs: Math.round(t + 600) };
}

/** 16-bit mono PCM WAV */
function wav(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return buf;
}

function beeps(timings, speakers, durationMs) {
  const out = new Float32Array(Math.ceil((durationMs / 1000) * RATE));
  const pitch = (sp) => [440, 660, 550, 330][speakers.indexOf(sp)] ?? 550;
  for (const w of timings) {
    const f = pitch(w.speaker);
    const a = Math.round((w.startMs / 1000) * RATE);
    const n = Math.round(((w.endMs - w.startMs) * 0.7 / 1000) * RATE);
    const ramp = Math.round(0.008 * RATE);
    for (let i = 0; i < n && a + i < out.length; i++) {
      const env = Math.min(1, i / ramp, (n - i) / ramp);
      out[a + i] = 0.35 * env * Math.sin((2 * Math.PI * f * i) / RATE);
    }
  }
  return out;
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\u2019").replace(/:/g, '\\:').replace(/%/g, '\\%');

async function main() {
  needTools();
  setFontFlags({ en: arg('--font-en') });
  const out = path.resolve(arg('--out', path.join(ROOT, 'docs', 'media-out', 'placeholder-src')));
  const scriptFile = path.resolve(arg('--script', path.join(ROOT, 'examples', 'demo-two-speakers.md')));
  if (path.relative(path.join(ROOT, 'docs', 'media-src'), out) === '') throw new Error('Placeholders never go into docs/media-src');
  fs.mkdirSync(out, { recursive: true });
  const font = fontFile('en');

  const text = fs.readFileSync(scriptFile, 'utf8');
  const aliasMap = buildAliasMap(JSON.parse(fs.readFileSync(path.join(ROOT, 'aliases.json'), 'utf8')));
  const parsed = parseScript(text, aliasMap);
  const { timings, lines, durationMs } = placeholderTimings(parsed);
  const samples = beeps(timings, parsed.speakers, durationMs);

  fs.writeFileSync(path.join(out, 'demo-script.md'), text);
  fs.writeFileSync(path.join(out, 'voice-full.wav'), wav(samples));
  fs.writeFileSync(path.join(out, 'timings.json'), JSON.stringify(timings.map(({ word, startMs, endMs }) => ({ word, startMs, endMs })), null, 1));
  fs.writeFileSync(path.join(out, 'lines.json'), JSON.stringify(lines, null, 1));

  // The opening: the same samples from 0 to the end of the third spoken line + 0.5 s
  const cut = lines[Math.min(2, lines.length - 1)].endMs + 500;
  fs.writeFileSync(path.join(out, 'opening-voice.wav'), wav(samples.subarray(0, Math.round((cut / 1000) * RATE))));
  const sec = (cut / 1000).toFixed(3);
  const who = lines.slice(0, 3).map((l) => `drawtext=fontfile='${font}':text='${esc(l.speaker.toUpperCase())} speaking':fontsize=72:fontcolor=white:borderw=4:x=(w-tw)/2:y=h*0.45:enable='between(t,${(l.startMs / 1000).toFixed(3)},${(l.endMs / 1000).toFixed(3)})'`);
  const label = (txt) => `drawtext=fontfile='${font}':text='${txt}':fontsize=64:fontcolor=white:borderw=4:x=(w-tw)/2:y=h*0.2`;
  const counter = `drawtext=fontfile='${font}':text='frame %{n}':fontsize=40:fontcolor=yellow:borderw=3:x=40:y=h-80`;
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=s=1280x720:r=30:d=${sec}`,
    '-i', path.join(out, 'opening-voice.wav'),
    '-vf', [label('OPENING placeholder'), ...who, counter].join(','),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', path.join(out, 'opening.mp4')]);
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=s=1280x720:r=30:d=7',
    '-vf', [label('IDLE placeholder (silent)'), counter].join(','),
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(out, 'idle-loop.mp4')]);

  console.log(`Placeholders in ${out}`);
  console.log(`  voice-full.wav ${(durationMs / 1000).toFixed(1)} s, ${timings.length} words, ${lines.length} lines; opening ${sec} s`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
