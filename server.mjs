// Local teleprompter server. Zero dependencies. Listens on 127.0.0.1 only.
//   Static pages (public/), script read/write (backs up first), script change push (SSE), chunked take upload and finish (ffmpeg to a normal mp4), speaking-rate stats.
// Chunked upload keeps what was already recorded if the browser crashes: takes/<id>.part keeps growing, and a .part left behind is recovered at the next start.
// Run it with `node server.mjs` (PORT env var changes the port), or import createServer() (the tests do).

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ID_RE = /^take-\d{2,}-\d{8}-\d{6}$/;
const KEEP_SAMPLES = 5;
const DEMO_SCRIPT = 'demo-two-speakers.md';
const RECOVER_AFTER_MS = 60_000; // a .part untouched this long is not being recorded any more
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
};

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

async function sizeOf(file) {
  try { return (await fsp.stat(file)).size; } catch { return 0; }
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

/** @returns {Promise<{ok: true} | {ok: false, code: 'E_NO_FFMPEG' | 'E_FFMPEG_FAILED', detail?: string}>} */
function runFfmpeg(bin, args) {
  return new Promise((resolve) => {
    let err = '';
    let p;
    const fail = (e) => resolve(e.code === 'ENOENT' ? { ok: false, code: 'E_NO_FFMPEG' } : { ok: false, code: 'E_FFMPEG_FAILED', detail: String(e.message) });
    try { p = spawn(bin, args, { windowsHide: true }); } catch (e) { fail(e); return; }
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', fail);
    p.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, code: 'E_FFMPEG_FAILED', detail: err.trim().slice(-500) }));
  });
}

/** Opens a folder in the system file manager. Resolves false instead of throwing when that is not possible. */
function openFolder(dir) {
  const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  return new Promise((resolve) => {
    let p;
    try { p = spawn(cmd, [dir], { detached: true, stdio: 'ignore' }); } catch { resolve(false); return; }
    p.on('error', () => resolve(false)); // stays attached: a missing xdg-open must never crash the server
    p.on('spawn', () => { p.unref(); resolve(true); });
  });
}

/** Container of a recording from its first bytes: EBML header → webm; 'ftyp' at offset 4 → mp4; anything else is treated as mp4. */
async function sniffContainer(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(12);
    const { bytesRead } = await fh.read(buf, 0, 12, 0);
    if (bytesRead >= 4 && buf.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
    return 'mp4';
  } finally {
    await fh.close();
  }
}

/**
 * Starts the teleprompter server. All files live under `root`.
 * @param {{ root: string, port?: number, host?: string, ffmpeg?: string, log?: (line: string) => void }} opts
 *   ffmpeg: the ffmpeg command (tests pass a missing one); log: where log lines go (default console.log).
 * @returns {http.Server} already listening. `server.recovery` is a promise that settles when the startup
 *   recovery of left-over .part files is done (it resolves to one result per .part).
 */
export function createServer({ root, port = 5178, host = '127.0.0.1', ffmpeg = 'ffmpeg', log = console.log } = {}) {
  const ROOT = path.resolve(root);
  const PUB = path.join(ROOT, 'public');
  const FIXTURES = path.join(ROOT, 'test', 'fixtures');
  const EXAMPLES = path.join(ROOT, 'examples');
  const TAKES = path.join(ROOT, 'takes');
  const BACKUPS = path.join(ROOT, 'backups');
  const SCRIPT = path.join(ROOT, 'script.md');
  const STATS = path.join(ROOT, 'stats.json');
  const ALIASES = path.join(ROOT, 'aliases.json');

  fs.mkdirSync(TAKES, { recursive: true });
  fs.mkdirSync(BACKUPS, { recursive: true });

  // First start: give the user the demo script to try
  if (!fs.existsSync(SCRIPT) && fs.existsSync(path.join(EXAMPLES, DEMO_SCRIPT))) {
    try {
      fs.copyFileSync(path.join(EXAMPLES, DEMO_SCRIPT), SCRIPT, fs.constants.COPYFILE_EXCL);
      log(`Created script.md from examples/${DEMO_SCRIPT}`);
    } catch (e) {
      if (e.code !== 'EEXIST') log(`Could not create script.md from examples/${DEMO_SCRIPT}: ${e.message}`);
    }
  }

  // One operation at a time per take: a retried chunk must not race its first attempt, and finish / recovery must not race a chunk
  const locks = new Map();
  function locked(key, fn) {
    const run = (locks.get(key) || Promise.resolve()).then(() => fn());
    const tail = run.catch(() => {});
    locks.set(key, tail);
    tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
    return run;
  }

  // ── Script change push ──────────────────────────────────────
  const clients = new Set();
  let lastScript = fs.existsSync(SCRIPT) ? fs.readFileSync(SCRIPT, 'utf8') : '';
  let watchTimer = null;
  // Watch the directory, not the file: editors often save by writing a temp file and renaming it, which breaks a file watch
  const watcher = fs.watch(ROOT, (_ev, name) => {
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
  watcher.on('error', () => { /* the folder went away; script push stops, the rest keeps working */ });
  const pinger = setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000);
  pinger.unref();

  // ── Takes ───────────────────────────────────────────────────
  let lastNo = 0;
  async function nextTakeNo() {
    for (const n of await fsp.readdir(TAKES)) {
      const m = /^take-(\d+)-/.exec(n);
      if (m) lastNo = Math.max(lastNo, Number(m[1]));
    }
    return ++lastNo;
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

  // Appends a chunk only when it starts exactly where the file ends, so the file never has a gap or a repeated chunk
  async function appendChunk(id, offset, buf) {
    const part = path.join(TAKES, `${id}.part`);
    let size;
    try { size = (await fsp.stat(part)).size; } catch (e) {
      if (e.code === 'ENOENT') return [410, { error: 'E_GONE' }];
      throw e;
    }
    if (size === offset) {
      await fsp.appendFile(part, buf);
      return [200, { ok: true, size: size + buf.length }];
    }
    if (size === offset + buf.length) return [200, { ok: true, size }]; // a retry of a chunk that already arrived
    return [409, { error: 'E_OFFSET', size }];
  }

  async function finishTake(id, body) {
    const ext = body.ext === 'webm' ? 'webm' : 'mp4';
    // uploadFailed: the browser stopped uploading part-way, so the server only has the start of the take
    const base = id + (body.discarded ? '-x' : '') + (body.uploadFailed ? '-partial' : '');
    const part = path.join(TAKES, `${id}.part`);
    const raw = path.join(TAKES, `${base}.raw.${ext}`);
    const out = path.join(TAKES, `${base}.mp4`);
    let file = null;
    let note = '';
    let noteDetail;
    try {
      await fsp.rename(part, raw);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      note = 'E_GONE'; // recovered at a server restart, or deleted; the browser has its own copy. Still save the log below.
    }
    if (!note) {
      file = path.basename(out);
      const plan = ffmpegPlan(raw, out, body.mime || '');
      const r = await runFfmpeg(ffmpeg, plan.args);
      if (r.ok && (await sizeOf(out)) > 0) {
        if (plan.lossless) await fsp.unlink(raw);
      } else {
        // No ffmpeg, or the conversion failed: keep the original file the browser recorded
        await fsp.rm(out, { force: true });
        const plain = path.join(TAKES, `${base}.${ext}`);
        await fsp.rename(raw, plain);
        file = path.basename(plain);
        note = r.ok ? 'E_FFMPEG_FAILED' : r.code;
        noteDetail = r.ok ? 'empty output' : r.detail;
      }
    }
    const record = { ...body.meta, file, mime: body.mime };
    if (body.uploadFailed) record.uploadFailed = true;
    await fsp.writeFile(path.join(TAKES, `${base}.json`), JSON.stringify(record, null, 1));
    const stats = await updateStats(body.meta?.wpm);
    return { file, note, noteDetail, stats };
  }

  // ── Recovery of .part files left by a crash (browser, server or computer) ──
  // mp4 parts are remuxed (-c copy) into a normal mp4. webm parts are remuxed (-c copy) into a .webm, not re-encoded to mp4:
  // a lossless copy takes seconds and needs no encoder, while re-encoding a long take can take minutes and needs libx264.
  // The finish step's webm → mp4 conversion can still be done by hand later.
  async function recoverPart(name) {
    const part = path.join(TAKES, name);
    const base = name.slice(0, -'.part'.length);
    return locked(base, async () => {
      let st;
      try { st = await fsp.stat(part); } catch { return { file: name, action: 'gone' }; }
      if (fs.existsSync(path.join(TAKES, `${base}.json`))) {
        log(`Left ${name} alone: ${base}.json exists`);
        return { file: name, action: 'skipped' };
      }
      if (Date.now() - st.mtimeMs < RECOVER_AFTER_MS) {
        log(`Left ${name} alone: it changed less than 60 s ago, a take may still be recording`);
        return { file: name, action: 'skipped' };
      }
      if (st.size === 0) {
        await fsp.unlink(part);
        log(`Deleted empty ${name}`);
        return { file: name, action: 'deleted' };
      }
      const ext = await sniffContainer(part);
      const out = path.join(TAKES, `${base}-recovered.${ext}`);
      const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', part, '-c', 'copy', ...(ext === 'mp4' ? ['-movflags', '+faststart'] : []), out];
      const r = await runFfmpeg(ffmpeg, args);
      if (r.ok && (await sizeOf(out)) > 0) {
        await fsp.unlink(part); // only now: the recovered file exists and is not empty
        log(`Recovered ${name} as ${path.basename(out)}`);
        return { file: name, action: 'recovered', to: path.basename(out) };
      }
      // Keep every byte: the .part itself becomes the recovered file
      await fsp.rm(out, { force: true });
      await fsp.rename(part, out);
      const why = r.ok ? 'ffmpeg wrote an empty file' : r.code === 'E_NO_FFMPEG' ? 'ffmpeg not found' : 'ffmpeg failed';
      log(`Recovered ${name} as ${path.basename(out)} without converting it (${why})`);
      return { file: name, action: 'renamed', to: path.basename(out) };
    });
  }

  async function recoverParts() {
    let names;
    try { names = (await fsp.readdir(TAKES)).filter((n) => n.endsWith('.part')).sort(); } catch { return []; }
    const results = [];
    for (const name of names) {
      try {
        results.push(await recoverPart(name));
      } catch (e) {
        log(`Could not recover ${name}: ${e.message}`);
        results.push({ file: name, action: 'error', error: e.message });
      }
    }
    return results;
  }

  // ── Cross-site protection ───────────────────────────────────
  // Only this page may use the API: the Host must be this server (blocks DNS rebinding), and writes must come from
  // this origin (blocks other web pages from overwriting script.md or opening folders; browsers always send Origin on cross-origin POST/PUT).
  function apiAllowed(req) {
    const { port: p } = server.address();
    const hosts = [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`];
    if (!hosts.includes(String(req.headers.host || '').toLowerCase())) return false;
    if (req.method === 'GET' || req.method === 'HEAD') return true;
    const origin = req.headers.origin;
    if (origin !== undefined) return hosts.some((h) => String(origin).toLowerCase() === `http://${h}`);
    return ['same-origin', 'none'].includes(req.headers['sec-fetch-site']);
  }

  // ── Static files ────────────────────────────────────────────
  async function serveStatic(res, p) {
    let file;
    if (p === '/' || p === '/index.html') file = path.join(PUB, 'index.html');
    else if (p === '/aliases.json') file = ALIASES;
    else if (p.startsWith('/fixtures/')) file = path.join(FIXTURES, p.slice('/fixtures/'.length));
    else file = path.join(PUB, p);
    const allowed = file === ALIASES || [PUB, FIXTURES].some((r) => file.startsWith(r + path.sep));
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
      const url = new URL(req.url, 'http://localhost');
      const p = decodeURIComponent(url.pathname);
      const { method } = req;

      if (p === '/api' || p.startsWith('/api/')) {
        if (!apiAllowed(req)) return json(res, { error: 'E_ORIGIN' }, 403);
      }

      if (p === '/api/script' && method === 'GET') {
        let text = '';
        try { text = await fsp.readFile(SCRIPT, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        return send(res, 200, text, TYPES['.md']);
      }
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
        return (await openFolder(TAKES)) ? json(res, { ok: true }) : json(res, { error: 'E_OPEN_FOLDER' }, 500);
      }
      const m = /^\/api\/takes\/([^/]+)\/(chunk|finish)$/.exec(p);
      if (m && method === 'POST') {
        const [, id, action] = m;
        if (!ID_RE.test(id)) return json(res, { error: 'E_BAD_ID' }, 400);
        if (action === 'chunk') {
          const offset = url.searchParams.get('offset');
          if (!/^\d+$/.test(offset || '')) return json(res, { error: 'E_BAD_OFFSET' }, 400);
          const buf = await readBody(req);
          const [code, out] = await locked(id, () => appendChunk(id, Number(offset), buf));
          return json(res, out, code);
        }
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        return json(res, await locked(id, () => finishTake(id, body)));
      }
      if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      if (method === 'GET') return serveStatic(res, p);
      send(res, 404, 'not found');
    } catch (err) {
      console.error(err);
      if (!res.headersSent) json(res, { error: String(err?.message || err) }, 500);
      else res.end();
    }
  });

  // Closing also stops the script watch, the SSE pings and the open SSE streams, so the process (or a test) can exit
  const close = server.close.bind(server);
  server.close = (cb) => {
    watcher.close();
    clearInterval(pinger);
    clearTimeout(watchTimer);
    for (const c of clients) c.end();
    clients.clear();
    return close(cb);
  };

  server.recovery = new Promise((resolve) => {
    server.once('listening', () => {
      const { port: p } = server.address();
      log(`Teleprompter running: open http://localhost:${p} in Chrome`);
      log(`Recordings are saved in ${TAKES}`);
      // After listen, so a long ffmpeg run never delays the page
      resolve(recoverParts());
    });
  });
  server.listen(port, host);
  return server;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const norm = (file) => {
    try { file = fs.realpathSync(file); } catch { /* keep the path as given */ }
    const href = pathToFileURL(file).href;
    return process.platform === 'win32' ? href.toLowerCase() : href;
  };
  return norm(fileURLToPath(import.meta.url)) === norm(path.resolve(process.argv[1]));
}

if (isMainModule()) {
  const port = Number(process.env.PORT) || 5178;
  const server = createServer({ root: path.dirname(fileURLToPath(import.meta.url)), port });
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE'
      ? `Port ${port} is already in use. Is the teleprompter already running? Set PORT to use another port.`
      : `Server error: ${e.message}`);
    process.exit(1);
  });
}
