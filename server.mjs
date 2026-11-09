// Local teleprompter server. Zero dependencies. Listens on 127.0.0.1 only.
//   Static pages (public/), script read/write (backs up first), script change push (SSE), chunked take upload and finish (ffmpeg to a normal mp4), speaking-rate stats.
// Chunked upload keeps what was already recorded if the browser crashes: takes/<id>.part keeps growing.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, 'public');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const TAKES = path.join(ROOT, 'takes');
const BACKUPS = path.join(ROOT, 'backups');
const SCRIPT = path.join(ROOT, 'script.md');
const STATS = path.join(ROOT, 'stats.json');
const PORT = Number(process.env.PORT) || 5178;
const ID_RE = /^take-\d{2,}-\d{8}-\d{6}$/;
const KEEP_SAMPLES = 5;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
};

fs.mkdirSync(TAKES, { recursive: true });
fs.mkdirSync(BACKUPS, { recursive: true });

const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const json = (res, obj, code = 200) => send(res, code, JSON.stringify(obj), TYPES['.json']);

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

// ── Script change push ──────────────────────────────────────
const clients = new Set();
let lastScript = fs.existsSync(SCRIPT) ? fs.readFileSync(SCRIPT, 'utf8') : '';
let watchTimer = null;
// Watch the directory, not the file: editors often save by writing a temp file and renaming it, which breaks a file watch
fs.watch(ROOT, (_ev, name) => {
  if (name !== 'script.md') return;
  clearTimeout(watchTimer);
  watchTimer = setTimeout(async () => {
    let text;
    try { text = await fsp.readFile(SCRIPT, 'utf8'); } catch { return; }
    if (text === lastScript) return;
    lastScript = text;
    const msg = `event: script\ndata: ${JSON.stringify({ text })}\n\n`;
    for (const c of clients) c.write(msg);
  }, 200);
});
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000);

// ── Takes ───────────────────────────────────────────────────
let lastNo = 0;
async function nextTakeNo() {
  for (const n of await fsp.readdir(TAKES)) {
    const m = /^take-(\d+)-/.exec(n);
    if (m) lastNo = Math.max(lastNo, Number(m[1]));
  }
  return ++lastNo;
}

function ffmpegPlan(raw, out, mime) {
  const common = ['-y', '-hide_banner', '-loglevel', 'error', '-i', raw];
  const tail = ['-movflags', '+faststart', out];
  if (raw.endsWith('.webm')) {
    return { lossless: false, args: [...common, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', ...tail] };
  }
  if (/opus/i.test(mime)) return { lossless: true, args: [...common, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', ...tail] };
  // Chrome records fragmented mp4, and some players miss the duration; a plain remux gives a normal mp4
  return { lossless: true, args: [...common, '-c', 'copy', ...tail] };
}

function runFfmpeg(args) {
  return new Promise((resolve) => {
    let err = '';
    let p;
    try { p = spawn('ffmpeg', args, { windowsHide: true }); } catch (e) { resolve({ ok: false, error: String(e.message) }); return; }
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ ok: false, error: e.code === 'ENOENT' ? '没找到 ffmpeg' : String(e.message) }));
    p.on('close', (code) => resolve({ ok: code === 0, error: err.trim().slice(-500) }));
  });
}

async function readStats() {
  try { return JSON.parse(await fsp.readFile(STATS, 'utf8')); } catch { return { samples: {}, wpm: {} }; }
}

async function updateStats(wpm) {
  const stats = await readStats();
  for (const [speaker, v] of Object.entries(wpm || {})) {
    if (!(v > 40 && v < 300)) continue;
    const list = [...(stats.samples[speaker] || []), Math.round(v * 10) / 10].slice(-KEEP_SAMPLES);
    stats.samples[speaker] = list;
    const sorted = [...list].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    stats.wpm[speaker] = sorted.length % 2 ? sorted[mid] : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10;
  }
  await fsp.writeFile(STATS, JSON.stringify(stats, null, 2));
  return stats;
}

async function finishTake(id, body) {
  const ext = body.ext === 'webm' ? 'webm' : 'mp4';
  const base = id + (body.discarded ? '-x' : '');
  const part = path.join(TAKES, `${id}.part`);
  const raw = path.join(TAKES, `${base}.raw.${ext}`);
  const out = path.join(TAKES, `${base}.mp4`);
  await fsp.rename(part, raw);
  let file = path.basename(out);
  let note = '';
  const plan = ffmpegPlan(raw, out, body.mime || '');
  const r = await runFfmpeg(plan.args);
  if (r.ok) {
    if (plan.lossless) await fsp.unlink(raw);
  } else {
    // No ffmpeg, or the conversion failed: keep the original file the browser recorded
    await fsp.rm(out, { force: true });
    const plain = path.join(TAKES, `${base}.${ext}`);
    await fsp.rename(raw, plain);
    file = path.basename(plain);
    note = r.error;
  }
  await fsp.writeFile(path.join(TAKES, `${base}.json`), JSON.stringify({ ...body.meta, file, mime: body.mime }, null, 1));
  const stats = await updateStats(body.meta?.wpm);
  return { file, note, stats };
}

// ── Static files ────────────────────────────────────────────
async function serveStatic(res, p) {
  let file;
  if (p === '/' || p === '/index.html') file = path.join(PUB, 'index.html');
  else if (p === '/aliases.json') file = path.join(ROOT, 'aliases.json');
  else if (p.startsWith('/fixtures/')) file = path.join(FIXTURES, p.slice('/fixtures/'.length));
  else file = path.join(PUB, p);
  const allowed = file === path.join(ROOT, 'aliases.json') || [PUB, FIXTURES].some((r) => file.startsWith(r + path.sep));
  if (!allowed) return send(res, 404, 'not found');
  try {
    const body = await fsp.readFile(file);
    send(res, 200, body, TYPES[path.extname(file)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const { method } = req;

    if (p === '/api/script' && method === 'GET') return send(res, 200, await fsp.readFile(SCRIPT, 'utf8'), TYPES['.md']);
    if (p === '/api/script' && method === 'PUT') {
      const text = (await readBody(req)).toString('utf8');
      try { await fsp.copyFile(SCRIPT, path.join(BACKUPS, `script-${stamp()}.md`)); } catch { /* first save: no previous version */ }
      await fsp.writeFile(SCRIPT, text, 'utf8');
      return json(res, { ok: true });
    }
    if (p === '/api/events' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': hi\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/stats' && method === 'GET') return json(res, await readStats());
    if (p === '/api/takes' && method === 'POST') {
      const id = `take-${pad(await nextTakeNo())}-${stamp()}`;
      await fsp.writeFile(path.join(TAKES, `${id}.part`), '');
      return json(res, { id });
    }
    if (p === '/api/takes/open' && method === 'POST') {
      spawn('explorer.exe', [TAKES], { detached: true, stdio: 'ignore' }).unref();
      return json(res, { ok: true });
    }
    const m = /^\/api\/takes\/([^/]+)\/(chunk|finish)$/.exec(p);
    if (m && method === 'POST') {
      const [, id, action] = m;
      if (!ID_RE.test(id)) return json(res, { error: 'bad id' }, 400);
      if (action === 'chunk') {
        const buf = await readBody(req);
        await fsp.appendFile(path.join(TAKES, `${id}.part`), buf);
        return json(res, { ok: true, size: buf.length });
      }
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      return json(res, await finishTake(id, body));
    }
    if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (method === 'GET') return serveStatic(res, p);
    send(res, 404, 'not found');
  } catch (err) {
    console.error(err);
    json(res, { error: String(err?.message || err) }, 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`提词器已启动：用 Chrome 打开 http://localhost:${PORT}`);
  console.log(`录像存在 ${TAKES}`);
});
