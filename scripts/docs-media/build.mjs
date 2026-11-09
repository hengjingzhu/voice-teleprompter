// npm run docs:media — screenshots and demo videos for the READMEs, rebuilt from the source assets.
//   node scripts/docs-media/build.mjs [--lang en|zh] [--only follow,hero,setup,controls,editor,screenshots]
//                                     [--src docs/media-src] [--font-en <file>] [--font-zh <file>] [--keep-tmp] [--headed]
// Writes docs/media/<lang>/*.png (committed) and docs/media-out/<lang>/*.mp4 + *-sheet.jpg (git-ignored; the MP4s are
// uploaded to GitHub). See docs/demo-media.md.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../server.mjs';
import { tl } from '../../public/i18n.js';
import { launch } from './capture.mjs';
import {
  needTools, setFontFlags, probe, prepareCaption, encodeClip, fitSize, posterFrame, contactSheet, soundOnsets, run,
} from './encode.mjs';
import {
  captureFollow, planFollow, planHero, captureControls, planControls, captureEditor, planEditor,
  buildCamFeed, captureSetup, planSetup, captureStills,
} from './clips.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLIPS = ['follow', 'hero', 'setup', 'controls', 'editor', 'screenshots'];
const MAX_BYTES = 10_000_000; // GitHub attachments: 10 MB
const ADD_SENTENCE = ' This line was just added.';

function parseArgs(argv) {
  const o = { langs: ['en', 'zh'], only: new Set(CLIPS), src: path.join(ROOT, 'docs', 'media-src'), fonts: {}, keepTmp: false, headed: false, camCounter: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v == null || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--lang') {
      const v = val();
      if (!['en', 'zh'].includes(v)) throw new Error('--lang must be en or zh');
      o.langs = [v];
    } else if (a === '--only') {
      const list = val().split(',').map((x) => x.trim()).filter(Boolean);
      for (const c of list) if (!CLIPS.includes(c)) throw new Error(`--only: unknown clip "${c}" (${CLIPS.join(', ')})`);
      o.only = new Set(list);
    } else if (a === '--src') o.src = path.resolve(val());
    else if (a === '--font-en') o.fonts.en = val();
    else if (a === '--font-zh') o.fonts.zh = val();
    else if (a === '--keep-tmp') o.keepTmp = true;
    else if (a === '--headed') o.headed = true;
    else if (a === '--cam-counter') o.camCounter = true; // debug: frame numbers burnt into the fake camera
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 5).join('\n'));
      process.exit(0);
    } else throw new Error(`unknown option ${a}`);
  }
  return o;
}

/** The source assets. voice-full may be .flac or .wav; opening-voice.wav is optional (derived when missing). */
function sourceFiles(dir) {
  const f = {
    script: ['demo-script.md'], voice: ['voice-full.flac', 'voice-full.wav'], timings: ['timings.json'], lines: ['lines.json'],
    opening: ['opening.mp4'], idle: ['idle-loop.mp4'],
  };
  const out = {};
  const missing = [];
  for (const [k, names] of Object.entries(f)) {
    out[k] = names.map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
    if (!out[k]) missing.push(names.join(' or '));
  }
  const ov = path.join(dir, 'opening-voice.wav');
  out.openingVoice = fs.existsSync(ov) ? ov : null;
  if (missing.length) {
    throw new Error(`Missing in ${dir}: ${missing.join(', ')}.\nTo try the pipeline without the real assets: node scripts/docs-media/make-placeholders.mjs, then add --src docs/media-out/placeholder-src`);
  }
  return out;
}

/**
 * The opening clip's voice: voice-full from 0 to the end of opening.mp4 (lines.json opening.endMs when given).
 * Written to tmp when the source folder does not have opening-voice.wav.
 */
async function openingVoice(src, linesJson, openingMs, tmpRoot) {
  if (src.openingVoice) return { file: src.openingVoice, derived: false };
  const endMs = linesJson.opening?.endMs ?? openingMs;
  const file = path.join(tmpRoot, 'opening-voice.wav');
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', src.voice, '-af', `atrim=end=${(endMs / 1000).toFixed(6)}`, '-ar', '48000', '-c:a', 'pcm_s16le', file]);
  return { file, derived: true };
}

/** lines.json: an array of lines, or { lines: [...], opening: {...}, … } */
function readLines(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const lines = Array.isArray(j) ? j : j.lines;
  if (!Array.isArray(lines) || !lines.length || lines.some((l) => !l.speaker || l.startMs == null || l.endMs == null)) {
    throw new Error(`${file}: expected lines with { speaker, text, startMs, endMs }`);
  }
  return { json: j, lines };
}

/** The opening voice must be the same samples as the start of the full voice (warn only). */
async function checkOpeningVoice(src) {
  const pcm = async (file) => (await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-t', '2', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'])).stdout;
  const [a, b] = await Promise.all([pcm(src.voice), pcm(src.openingVoice)]);
  let diff = 0;
  const n = Math.min(a.length, b.length) >> 1;
  for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(a.readInt16LE(i * 2) - b.readInt16LE(i * 2)));
  return diff <= 64 ? null : `opening-voice.wav does not start with the same samples as voice-full.wav (max difference ${diff}); the sound check clip and the hero assume it does`;
}

function buildFixture(src) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'test', 'make-fixture.mjs'), src.script, 'demo.json', '--timings', src.timings], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`make-fixture failed: ${r.stderr || r.stdout}`);
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'demo.json'), 'utf8'));
}

/** A throwaway server root: the page, the aliases, the demo fixture, and the demo script as script.md. */
function serverRoot(dir, src) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'test', 'fixtures'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(dir, 'public'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'aliases.json'), path.join(dir, 'aliases.json'));
  fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'demo.json'), path.join(dir, 'test', 'fixtures', 'demo.json'));
  fs.copyFileSync(src.script, path.join(dir, 'script.md'));
  return dir;
}

function startServer(root) {
  return new Promise((resolve, reject) => {
    const server = createServer({ root, port: 0, log: () => {} });
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

const mb = (n) => (n / 1e6).toFixed(2);

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  needTools();
  setFontFlags(opt.fonts);
  const src = sourceFiles(opt.src);
  const tmpRoot = path.join(ROOT, 'docs', 'media-out', 'tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const warnings = [];

  const timings = JSON.parse(fs.readFileSync(src.timings, 'utf8'));
  const { json: linesJson, lines } = readLines(src.lines);
  const voiceMs = (await probe(src.voice)).duration * 1000;
  const openingMs = (await probe(src.opening)).duration * 1000;
  // The voice must be 48 kHz for the sample-exact cuts; Chrome's fake microphone gets a WAV made from it
  if ((await probe(src.voice)).audio?.sample_rate !== '48000') warnings.push(`${path.basename(src.voice)} is not 48 kHz; cuts are resampled`);
  const ov = await openingVoice(src, linesJson, openingMs, tmpRoot);
  src.openingVoice = ov.file;
  if (!ov.derived) {
    const bad = await checkOpeningVoice(src);
    if (bad) warnings.push(bad);
  }
  // Where sound really starts in the voice (silencedetect, as the onset check measures the MP4s)
  const voiceOnsetMs = (await soundOnsets(src.voice)).onsets[0] * 1000;
  const fixture = buildFixture(src);
  console.log(`Voice: ${(voiceMs / 1000).toFixed(2)} s; first sound at ${voiceOnsetMs.toFixed(0)} ms, first word in timings.json at ${timings[0].startMs} ms`);
  console.log(`Fixture test/fixtures/demo.json: ${fixture.events.length} events, audioOffsetMs ${fixture.audioOffsetMs}, setup.audioOffsetMs ${fixture.setup.audioOffsetMs}`);

  const server = await startServer(serverRoot(path.join(tmpRoot, 'root'), src));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`Server ${base} (temporary root docs/media-out/tmp/root)`);
  const browsers = [];
  const rows = [];
  const sheets = [];
  try {
    const sim = await launch({ headed: opt.headed });
    browsers.push(sim);
    const common = { fixture, lines, timings, voiceMs, heroMs: Math.min(10000, openingMs - 40), addSentence: ADD_SENTENCE, dialogMs: 1500, src, voiceOnsetMs };

    const finish = async (lang, name, plan, cap, extra = {}) => {
      const outDir = path.join(ROOT, 'docs', 'media-out', lang);
      const mediaDir = path.join(ROOT, 'docs', 'media', lang);
      const out = path.join(outDir, `${name}.mp4`);
      for (const w of plan.warnings) warnings.push(`${lang} ${w}`);
      // The capture log (page states, inputs, camera frames) and the plan, for checking timings by hand
      fs.mkdirSync(path.join(tmpRoot, lang), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, lang, `${name}-log.json`), JSON.stringify({ plan: { ...plan, left: undefined }, log: cap.log, frames: cap.frames.map((x) => x.ts) }, null, 1));
      const r = await fitSize((crf) => encodeClip({
        frames: cap.frames, from: plan.from, to: plan.to, audio: plan.audio, out, caption: extra.caption,
        crop: plan.crop || null, size: plan.left ? [640, 360] : [1280, 720], overlays: plan.overlays || [], left: plan.left || null,
        crf, tmp: path.join(tmpRoot, lang),
      }), MAX_BYTES);
      const info = await probe(out);
      await posterFrame(out, Math.min(info.duration - 0.1, Math.max(0, plan.poster)), path.join(mediaDir, `${name}-poster.png`), { photo: name === 'setup' || name === 'hero' });
      const sheet = path.join(outDir, `${name}-sheet.jpg`);
      await contactSheet(out, sheet);
      sheets.push(sheet);
      const { onsets } = await soundOnsets(out);
      const onsetDelta = plan.expectOnsets.map((e) => {
        const near = onsets.reduce((b, x) => (Math.abs(x - e) < Math.abs(b - e) ? x : b), Infinity);
        return Number.isFinite(near) ? Math.round((near - e) * 1000) : null;
      });
      if (!plan.expectOnsets.length && onsets.length) warnings.push(`${lang} ${name}: expected silence, sound found at ${onsets.map((x) => x.toFixed(2)).join(', ')} s`);
      rows.push({
        file: path.relative(ROOT, out).split(path.sep).join('/'), duration: info.duration, size: r.size, crf: r.crf,
        av: plan.av, lag: plan.L, onset: onsetDelta, w: info.video.width, h: info.video.height, extra: plan.clickErrors,
      });
      if (r.size >= MAX_BYTES) warnings.push(`${lang} ${name}: ${mb(r.size)} MB even at crf ${r.crf}`);
      console.log(`  ${name}.mp4 ${info.duration.toFixed(2)} s ${mb(r.size)} MB`);
    };

    let feed = null;
    for (const lang of opt.langs) {
      console.log(`[${lang}]`);
      const caption = await prepareCaption(lang, path.join(tmpRoot, 'caption'), opt.fonts);
      const mediaDir = path.join(ROOT, 'docs', 'media', lang);
      fs.mkdirSync(mediaDir, { recursive: true });
      const env = {
        ...common, lang, mediaDir, tmp: path.join(tmpRoot, lang),
        session: { lang, base, holdText: lang === 'zh' ? '按住 1 秒' : 'Hold 1 s', spaceText: tl(lang, 'key.Space') },
      };

      if (opt.only.has('follow') || opt.only.has('hero')) {
        const cap = await captureFollow(sim, env);
        const plan = await planFollow(cap, env);
        if (opt.only.has('follow')) await finish(lang, 'follow', plan, cap, { caption });
        if (opt.only.has('hero')) await finish(lang, 'hero', planHero(cap, plan, env), cap, { caption });
      }
      if (opt.only.has('controls')) {
        const cap = await captureControls(sim, env);
        await finish(lang, 'controls', await planControls(cap, env), cap, { caption });
      }
      if (opt.only.has('editor')) {
        const cap = await captureEditor(sim, env);
        await finish(lang, 'editor', await planEditor(cap, env, sim), cap, { caption });
      }
      if (opt.only.has('screenshots')) {
        await captureStills(sim, env);
        console.log('  ready.png recording.png review.png editor.png');
      }
      if (opt.only.has('setup')) {
        feed ??= await buildCamFeed({ src, fixture, dir: tmpRoot, counter: opt.camCounter });
        // Fake devices are fixed per browser launch, and each launch plays the feed from its start
        const b = await launch({ headed: opt.headed, fake: { video: feed.video, audio: feed.audio } });
        browsers.push(b);
        try {
          const cap = await captureSetup(b, env, feed);
          const plan = planSetup(cap, env, feed);
          console.log(`  camera 0 s from ${cap.camHow}; camera lag on screen ${cap.camLag.toFixed(0)} ms (median of ${cap.shown.length} frames); clicks off plan: calibrate ${cap.cal.error.toFixed(0)} ms, test ${cap.test.error.toFixed(0)} ms`);
          await finish(lang, 'setup', plan, cap, { caption });
          console.log('  setup.png');
        } finally {
          await b.close().catch(() => {});
          browsers.splice(browsers.indexOf(b), 1);
        }
      }
    }
  } finally {
    for (const b of browsers) await b.close().catch(() => {});
    await new Promise((r) => server.close(r));
  }

  // Frames, the fake camera feed (about 0.8 GB) and the server root; --keep-tmp keeps them with the capture logs
  if (!opt.keepTmp) fs.rmSync(tmpRoot, { recursive: true, force: true });

  console.log('\nfile                                  duration   size MB  crf   A/V ms med/max (n)  lag ms  onset check ms');
  for (const r of rows) {
    const sorted = [...(r.av || [])].sort((a, b) => a - b);
    const av = sorted.length ? `${sorted[sorted.length >> 1].toFixed(1)}/${sorted.at(-1).toFixed(1)} (${sorted.length})` : '-';
    const lag = r.lag == null ? '-' : r.lag.toFixed(0);
    const on = r.onset.length ? r.onset.map((x) => (x == null ? '?' : (x > 0 ? `+${x}` : String(x)))).join(', ') : '(silent)';
    console.log(`${r.file.padEnd(38)}${r.duration.toFixed(2).padStart(8)} s ${mb(r.size).padStart(8)} ${String(r.crf).padStart(4)} ${av.padStart(20)} ${lag.padStart(7)}  ${on.padEnd(14)} ${r.w}x${r.h}`);
  }
  console.log('\nA/V ms: gap between where the video shows a moment and where the audio has it, median / worst over n checks.');
  console.log('  follow, controls, hero: each countdown state change (render lag compensated). setup: each logged camera');
  console.log('  frame (lips vs voice). One frame at 30 fps is 33 ms.');
  console.log("onset check ms: first sound in the MP4 (silencedetect) minus where the plan puts the voice's first sound.");
  console.log('\nContact sheets (look at each one):');
  for (const s of sheets) console.log(`  ${path.relative(ROOT, s).split(path.sep).join('/')}`);
  if (warnings.length) {
    console.log('\nWarnings:');
    for (const w of warnings) console.log(`  - ${w}`);
  }
}

main().catch((e) => {
  console.error(`\n${e.stack || e.message || e}`);
  process.exitCode = 1;
});
