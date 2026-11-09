// ffmpeg / ffprobe helpers for the docs media pipeline: clips from screencast frames, captions, audio placement,
// posters, contact sheets and the checks (silence detection, frame brightness).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';

export const FPS = 30;
export const BAND = 40; // caption band under the app picture, px
export const AUDIO_RATE = 48000;

export const CAPTIONS = {
  en: 'Demo · AI-generated people and voices · fictional names · simulated speech recognition',
  zh: '演示 · 人物和声音由 AI 生成 · 名字为虚构 · 语音识别为模拟',
};

/** Fails with a clear message when ffmpeg or ffprobe is missing. */
export function needTools() {
  for (const bin of ['ffmpeg', 'ffprobe']) {
    const r = spawnSync(bin, ['-version'], { windowsHide: true });
    if (r.error || r.status !== 0) throw new Error(`${bin} not found on PATH. Install ffmpeg (Windows: winget install Gyan.FFmpeg, macOS: brew install ffmpeg) and run again.`);
  }
}

/** Runs a command; resolves { stdout, stderr }, rejects with the end of stderr. */
export function run(cmd, args, { input = null } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new Error(`${cmd} failed (${code}): ${err.trim().split('\n').slice(-6).join('\n')}`));
    });
    if (input) p.stdin.end(input);
    else p.stdin.end();
  });
}

export const ffmpeg = (args, opts) => run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], opts);

export async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate,sample_rate,channels', '-of', 'json', file]);
  const j = JSON.parse(stdout.toString());
  return {
    duration: Number(j.format.duration),
    video: j.streams.find((s) => s.codec_type === 'video') || null,
    audio: j.streams.find((s) => s.codec_type === 'audio') || null,
  };
}

/** A path inside a filter option: forward slashes, ':' escaped, quoted. */
export const fpath = (p) => `'${path.resolve(p).replace(/\\/g, '/').replace(/:/g, '\\:')}'`;

const FONT_DEFAULTS = {
  win32: { en: 'C:/Windows/Fonts/segoeui.ttf', zh: 'C:/Windows/Fonts/msyh.ttc' },
};

let fontFlags = {};
/** --font-en / --font-zh given on the command line */
export function setFontFlags(flags) {
  fontFlags = { ...flags };
}

/** The caption font for a language: --font-en / --font-zh, else DOCS_MEDIA_FONT_EN / _ZH, else the Windows fonts. */
export function fontFile(lang, flags = fontFlags) {
  const env = process.env[`DOCS_MEDIA_FONT_${lang.toUpperCase()}`];
  const file = flags[lang] || env || FONT_DEFAULTS[process.platform]?.[lang];
  if (!file) {
    throw new Error(`No caption font for "${lang}" on ${process.platform}. Pass --font-${lang} <file> or set DOCS_MEDIA_FONT_${lang.toUpperCase()} `
      + `(a .ttf/.ttc/.otf that has ${lang === 'zh' ? 'Chinese glyphs, e.g. Noto Sans CJK' : 'Latin glyphs, e.g. DejaVu Sans or Helvetica'}).`);
  }
  if (!fs.existsSync(file)) throw new Error(`Caption font for "${lang}" not found: ${file}. Pass --font-${lang} <file> or set DOCS_MEDIA_FONT_${lang.toUpperCase()}.`);
  return file.replace(/\\/g, '/').replace(/:/g, '\\:');
}

// ── PNG with alpha (the caption pill), no dependencies ─────────
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function pngRgba(w, h, pixel) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** A rounded pill, anti-aliased (4×4 samples per pixel). */
export function pillPng(w, h, [r, g, b, a]) {
  const rad = h / 2;
  const inside = (x, y) => {
    const cx = Math.min(Math.max(x, rad), w - rad);
    return (x - cx) ** 2 + (y - rad) ** 2 <= rad * rad;
  };
  return pngRgba(w, h, (x, y) => {
    let n = 0;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) n += inside(x + (i + 0.5) / 4, y + (j + 0.5) / 4);
    return [r, g, b, Math.round((a * n) / 16)];
  });
}

// ── Caption ────────────────────────────────────────────────────
export const CAPTION_STYLE = { size: 18, pillH: 28, padX: 14, pill: [24, 24, 27, 200], band: 'white' };

/** Measures the caption with the real font (ffmpeg bbox) and writes the pill PNG and the text file. */
export async function prepareCaption(lang, dir, fonts) {
  const font = fontFile(lang, fonts);
  const text = CAPTIONS[lang];
  fs.mkdirSync(dir, { recursive: true });
  const textFile = path.join(dir, `caption-${lang}.txt`);
  fs.writeFileSync(textFile, text);
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'info', '-f', 'lavfi', '-i', 'color=c=black:s=1800x80',
    '-vf', `drawtext=fontfile='${font}':textfile=${fpath(textFile)}:expansion=none:fontsize=${CAPTION_STYLE.size}:fontcolor=white:x=10:y=20,bbox=min_val=60`,
    '-frames:v', '1', '-f', 'null', '-']);
  const m = /x1:(\d+) x2:(\d+)/.exec(stderr);
  if (!m) throw new Error(`could not measure the ${lang} caption`);
  const textW = Number(m[2]) - 10 + 1;
  const pillW = textW + 2 * CAPTION_STYLE.padX;
  const pill = path.join(dir, `pill-${lang}.png`);
  fs.writeFileSync(pill, pillPng(pillW, CAPTION_STYLE.pillH, CAPTION_STYLE.pill));
  return { lang, font, text, textFile, pill, pillW, textW };
}

/** Filter steps (after [in]) that add the white band and the caption pill + text; returns { graph, out }. */
function captionGraph(inLabel, cap, pillIdx, width, height) {
  const H = height + BAND;
  const py = height + Math.round((BAND - CAPTION_STYLE.pillH) / 2);
  const px = Math.round((width - cap.pillW) / 2);
  const cy = py + CAPTION_STYLE.pillH / 2;
  return {
    graph: [
      `[${inLabel}]pad=${width}:${H}:0:0:color=${CAPTION_STYLE.band}[cb0]`,
      `[cb0][${pillIdx}:v]overlay=${px}:${py}[cb1]`,
      `[cb1]drawtext=fontfile='${cap.font}':textfile=${fpath(cap.textFile)}:expansion=none:fontsize=${CAPTION_STYLE.size}:fontcolor=white:x=(w-tw)/2:y=${cy}-(ascent-descent)/2+1[cb2]`,
    ].join(';'),
    out: 'cb2',
    height: H,
  };
}

// ── Frames → clip ─────────────────────────────────────────────
/**
 * Concat list for the screencast frames that cover [from, to] (wall ms): each frame lasts until the next one.
 * frames: [{ ts, file }] sorted by ts.
 */
export function concatList(frames, from, to) {
  let s = 0;
  while (s + 1 < frames.length && frames[s + 1].ts <= from) s++;
  const lines = [];
  let last = null;
  for (let i = s; i < frames.length && frames[i].ts < to; i++) {
    const a = Math.max(frames[i].ts, from);
    const b = Math.min(frames[i + 1]?.ts ?? to, to);
    if (b - a <= 0) continue;
    lines.push(`file '${frames[i].file.replace(/\\/g, '/')}'`, `duration ${((b - a) / 1000).toFixed(6)}`);
    last = frames[i].file;
  }
  if (!last) throw new Error('no frames in the clip window');
  lines.push(`file '${last.replace(/\\/g, '/')}'`);
  return `${lines.join('\n')}\n`;
}

/** Output frame (30 fps, ffmpeg fps filter rounding to nearest) at which the screencast frame shown from wall ms `ts` appears. */
export const outFrameOf = (ts, from) => Math.round(((ts - from) / 1000) * FPS);

/**
 * Builds one MP4 from screencast frames.
 *   frames, from, to (wall ms); audio: [{ file, at (wall ms where the file's `start` s plays), start = 0, end = null (s), fade = 0.06 }]
 *   crop: { x, y, w, h } of the 1280×720 capture; size: [w, h] output picture (before the caption band)
 *   overlays: [{ file, x, y, from, to } (wall ms)] PNGs shown over the picture
 *   left: { file, start = 0 } a video placed left of the capture (hero); its audio is used when audio is empty and leftAudio is set
 */
export async function encodeClip({ frames, from, to, audio = [], out, caption, crop = null, size = [1280, 720], overlays = [], left = null, crf = 22, tmp }) {
  fs.mkdirSync(tmp, { recursive: true });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const list = path.join(tmp, `${path.basename(out, '.mp4')}-frames.txt`);
  fs.writeFileSync(list, concatList(frames, from, to));
  const dur = (to - from) / 1000;
  const inputs = ['-f', 'concat', '-safe', '0', '-i', list];
  let n = 1;
  const g = [];
  let v = '0:v';
  const [W, H] = size;
  const capChain = [`settb=AVTB`, `fps=${FPS}`];
  if (crop) capChain.push(`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`);
  capChain.push(`scale=${W}:${H}:flags=lanczos`, 'setsar=1');
  g.push(`[${v}]${capChain.join(',')}[cap]`);
  v = 'cap';
  for (const o of overlays) {
    inputs.push('-i', o.file);
    const a = ((o.from - from) / 1000).toFixed(3);
    const b = ((o.to - from) / 1000).toFixed(3);
    g.push(`[${v}][${n}:v]overlay=${o.x}:${o.y}:enable='between(t,${a},${b})'[ov${n}]`);
    v = `ov${n}`;
    n++;
  }
  let width = W;
  if (left) {
    inputs.push('-ss', String(left.start || 0), '-i', left.file);
    g.push(`[${n}:v]settb=AVTB,fps=${FPS},scale=${left.w}:${H}:force_original_aspect_ratio=increase,crop=${left.w}:${H},setsar=1,trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS[lv]`);
    g.push(`[lv][${v}]hstack=inputs=2[hs]`);
    v = 'hs';
    width = left.w + W;
    left.idx = n;
    n++;
  }
  inputs.push('-i', caption.pill);
  const cap = captionGraph(v, caption, n, width, H);
  g.push(cap.graph);
  n++;
  g.push(`[${cap.out}]format=yuv420p,trim=duration=${dur.toFixed(3)}[vout]`);

  // Audio: every piece delayed to its place on the clip timeline, then mixed
  const pieces = [];
  for (const a of audio) {
    if (a.leftAudio) {
      pieces.push({ idx: left.idx, start: 0, end: null, delay: 0, fade: 0 });
      continue;
    }
    inputs.push('-i', a.file);
    const offset = (a.at - from) / 1000; // where the file's `start` lands on the clip timeline
    const start = (a.start || 0) + Math.max(0, -offset);
    pieces.push({ idx: n, start, end: a.end ?? null, delay: Math.max(0, offset), fade: a.fade ?? 0.06 });
    n++;
  }
  const mix = [];
  pieces.forEach((p, k) => {
    const chain = [`aresample=${AUDIO_RATE}`, 'aformat=sample_fmts=fltp:channel_layouts=stereo', `atrim=start=${p.start.toFixed(5)}${p.end != null ? `:end=${p.end.toFixed(5)}` : ''}`, 'asetpts=N/SR/TB'];
    if (p.end != null && p.fade > 0) chain.push(`afade=t=out:st=${Math.max(0, p.end - p.start - p.fade).toFixed(5)}:d=${p.fade}`);
    if (p.delay > 0) chain.push(`adelay=delays=${Math.round(p.delay * AUDIO_RATE)}S:all=1`);
    g.push(`[${p.idx}:a]${chain.join(',')}[a${k}]`);
    mix.push(`[a${k}]`);
  });
  if (!mix.length) {
    g.push(`anullsrc=r=${AUDIO_RATE}:cl=stereo,atrim=duration=${dur.toFixed(3)}[aout]`);
  } else {
    g.push(`${mix.join('')}amix=inputs=${mix.length}:normalize=0:dropout_transition=0,apad,atrim=duration=${dur.toFixed(3)}[aout]`);
  }
  const args = [...inputs, '-filter_complex', g.join(';'), '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '128k', '-ar', String(AUDIO_RATE), '-t', dur.toFixed(3), '-movflags', '+faststart', out];
  fs.writeFileSync(path.join(tmp, `${path.basename(out, '.mp4')}-ffmpeg.txt`), args.map((a) => (/\s|;|\[/.test(a) ? JSON.stringify(a) : a)).join(' '));
  await ffmpeg(args);
  return { out, duration: dur, width, height: cap.height };
}

/** Re-encodes with a higher crf until the file is under maxBytes. Returns the crf used. */
export async function fitSize(build, maxBytes, crf = 22) {
  for (;;) {
    const r = await build(crf);
    const size = fs.statSync(r.out).size;
    if (size < maxBytes || crf >= 34) return { ...r, crf, size };
    crf += 3;
  }
}

// ── Stills, sheets, checks ────────────────────────────────────
/** One frame of a video as an optimised PNG (256 colours; dithered when it shows camera footage). */
export async function posterFrame(video, t, out, { photo = false } = {}) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await ffmpeg(['-ss', t.toFixed(3), '-i', video, '-frames:v', '1',
    '-vf', `split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=${photo ? 'sierra2_4a' : 'none'}`,
    '-compression_level', '9', out]);
}

/** Re-compresses a PNG (Playwright writes fast, large ones). Keeps the smaller file. */
export async function optimisePng(file) {
  const tmp = `${file}.opt.png`;
  await ffmpeg(['-i', file, '-pred', 'mixed', '-compression_level', '9', '-pix_fmt', 'rgb24', tmp]);
  if (fs.statSync(tmp).size < fs.statSync(file).size) fs.renameSync(tmp, file);
  else fs.rmSync(tmp);
}

/** Contact sheet: one frame per second, labelled with its time, 4 per row. */
export async function contactSheet(video, out) {
  const { duration, video: vs } = await probe(video);
  const count = Math.floor(duration) + 1;
  const rows = Math.ceil(count / 4);
  const w = 400;
  const h = Math.round((vs.height / vs.width) * w / 2) * 2;
  await ffmpeg(['-i', video, '-vf',
    `select='isnan(prev_selected_t)+gte(t-prev_selected_t,0.999)',scale=${w}:${h},drawtext=fontfile='${fontFile('en')}':text='%{eif\\:t\\:d} s':fontsize=22:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=4:x=6:y=6,tile=4x${rows}:padding=4:margin=4:color=gray`,
    '-frames:v', '1', '-fps_mode', 'vfr', '-q:v', '3', out]);
}

/** Times (s) where sound starts after silence (silencedetect), and the first one. */
export async function soundOnsets(video, noise = '-40dB', min = 0.08) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', video, '-af', `silencedetect=n=${noise}:d=${min}`, '-vn', '-f', 'null', '-']);
  const { duration } = await probe(video);
  const starts = [...stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  // A silence that runs to the end of the file "ends" there: that is not a sound starting
  const ends = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1])).filter((t) => t < duration - 0.05);
  // Sound from 0 (no silence_start at 0) counts as an onset at 0
  const onsets = starts.length && starts[0] > 0.001 ? [0, ...ends] : ends;
  return { onsets, silenceStarts: starts };
}

/** Mean brightness (0–255) of a region of a JPEG/PNG. */
export async function regionLuma(file, { x, y, w, h }) {
  const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `crop=${w}:${h}:${x}:${y},format=gray`, '-f', 'rawvideo', '-']);
  let s = 0;
  for (const b of stdout) s += b;
  return s / stdout.length;
}
