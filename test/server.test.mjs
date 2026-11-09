// Server tests: cross-site protection, first-start script, gap-free chunk upload, finish naming, .part recovery.
// Each test starts its own server on a free port with a temporary root folder.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createServer } from '../server.mjs';

const NO_FFMPEG = 'tp-test-no-such-ffmpeg';
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;

function makeRoot(setup) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-server-'));
  setup?.(root);
  return root;
}

async function start(t, root, opts = {}) {
  const logs = [];
  const server = createServer({ root, port: 0, ffmpeg: NO_FFMPEG, log: (line) => logs.push(line), ...opts });
  if (!server.listening) await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const { port } = server.address();
  return { server, port, logs, origin: `http://127.0.0.1:${port}` };
}

/** http.request, so Host and Origin can be forged. Resolves { status, text, json, headers }. */
function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, text, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
const ageMinutes = (file, min) => { const t = new Date(Date.now() - min * 60_000); fs.utimesSync(file, t, t); };

describe('cross-site protection', () => {
  test('a forged cross-origin PUT /api/script is refused and the script is unchanged', async (t) => {
    const root = makeRoot((r) => write(path.join(r, 'script.md'), 'original'));
    const { port } = await start(t, root);
    const r = await request(port, { method: 'PUT', path: '/api/script', headers: { Origin: 'https://evil.example' }, body: 'pwned' });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'E_ORIGIN');
    assert.equal(fs.readFileSync(path.join(root, 'script.md'), 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(path.join(root, 'backups')), []);
  });

  test('a write with no Origin is refused unless Sec-Fetch-Site says same-origin or none', async (t) => {
    const root = makeRoot((r) => write(path.join(r, 'script.md'), 'original'));
    const { port } = await start(t, root);
    const bare = await request(port, { method: 'PUT', path: '/api/script', body: 'a' });
    assert.equal(bare.status, 403);
    const cross = await request(port, { method: 'PUT', path: '/api/script', headers: { 'Sec-Fetch-Site': 'cross-site' }, body: 'b' });
    assert.equal(cross.status, 403);
    const open = await request(port, { method: 'POST', path: '/api/takes/open', headers: { Origin: 'null' } });
    assert.equal(open.status, 403);
    assert.equal(fs.readFileSync(path.join(root, 'script.md'), 'utf8'), 'original');
    const same = await request(port, { method: 'PUT', path: '/api/script', headers: { 'Sec-Fetch-Site': 'same-origin' }, body: 'c' });
    assert.equal(same.status, 200);
    assert.equal(fs.readFileSync(path.join(root, 'script.md'), 'utf8'), 'c');
  });

  test('a wrong Host header is refused, even for GET', async (t) => {
    const root = makeRoot((r) => write(path.join(r, 'script.md'), 'secret words'));
    const { port } = await start(t, root);
    for (const host of ['evil.example', `evil.example:${port}`, `localhost:${port + 1}`]) {
      const r = await request(port, { path: '/api/script', headers: { Host: host } });
      assert.equal(r.status, 403, host);
      assert.equal(r.json.error, 'E_ORIGIN');
    }
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
      const r = await request(port, { path: '/api/script', headers: { Host: host } });
      assert.equal(r.status, 200, host);
      assert.equal(r.text, 'secret words');
    }
  });

  test('static files outside /api are served whatever the Host', async (t) => {
    const root = makeRoot((r) => write(path.join(r, 'public', 'index.html'), '<p>hi</p>'));
    const { port } = await start(t, root);
    const r = await request(port, { path: '/', headers: { Host: 'other.example' } });
    assert.equal(r.status, 200);
    assert.equal(r.text, '<p>hi</p>');
  });

  test('a same-origin PUT saves the script and backs up the old one', async (t) => {
    const root = makeRoot((r) => write(path.join(r, 'script.md'), 'old text'));
    const { port } = await start(t, root);
    const r = await request(port, {
      method: 'PUT', path: '/api/script', body: 'new text',
      headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}`, 'Content-Type': 'text/plain; charset=utf-8' },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    assert.equal(fs.readFileSync(path.join(root, 'script.md'), 'utf8'), 'new text');
    const backups = fs.readdirSync(path.join(root, 'backups'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^script-\d{8}-\d{6}\.md$/);
    assert.equal(fs.readFileSync(path.join(root, 'backups', backups[0]), 'utf8'), 'old text');
  });

  test('the page can still open the event stream', async (t) => {
    const root = makeRoot();
    const { port } = await start(t, root);
    const res = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/events', agent: false }, resolve).on('error', reject);
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    res.destroy();
  });
});

describe('first start', () => {
  test('script.md is created from examples/demo-two-speakers.md', async (t) => {
    const demo = 'Alice: Hello there.\n\nBob: Thanks.\n';
    const root = makeRoot((r) => write(path.join(r, 'examples', 'demo-two-speakers.md'), demo));
    const { port, logs } = await start(t, root);
    const r = await request(port, { path: '/api/script' });
    assert.equal(r.status, 200);
    assert.equal(r.text, demo);
    assert.equal(fs.readFileSync(path.join(root, 'script.md'), 'utf8'), demo);
    assert.ok(logs.includes('Created script.md from examples/demo-two-speakers.md'));
  });

  test('with no script.md and no example, GET /api/script returns an empty script', async (t) => {
    const root = makeRoot();
    const { port } = await start(t, root);
    const r = await request(port, { path: '/api/script' });
    assert.equal(r.status, 200);
    assert.equal(r.text, '');
    assert.equal(fs.existsSync(path.join(root, 'script.md')), false);
  });

  test('an existing script.md is never replaced by the example', async (t) => {
    const root = makeRoot((r) => {
      write(path.join(r, 'script.md'), 'mine');
      write(path.join(r, 'examples', 'demo-two-speakers.md'), 'demo');
    });
    const { port } = await start(t, root);
    assert.equal((await request(port, { path: '/api/script' })).text, 'mine');
  });

  test('the startup log lines', async (t) => {
    const root = makeRoot();
    const { port, logs } = await start(t, root);
    assert.equal(logs[0], `Teleprompter running: open http://localhost:${port} in Chrome`);
    assert.equal(logs[1], `Recordings are saved in ${path.join(root, 'takes')}`);
  });
});

describe('chunk upload', () => {
  async function newTake(port, origin) {
    const r = await request(port, { method: 'POST', path: '/api/takes', headers: { Origin: origin } });
    assert.equal(r.status, 200);
    return r.json.id;
  }
  const chunk = (port, origin, id, offset, body) =>
    request(port, { method: 'POST', path: `/api/takes/${id}/chunk?offset=${offset}`, headers: { Origin: origin }, body });

  test('appends in order, ignores a repeated chunk, refuses a gap', async (t) => {
    const root = makeRoot();
    const { port, origin } = await start(t, root);
    const id = await newTake(port, origin);
    const part = path.join(root, 'takes', `${id}.part`);

    let r = await chunk(port, origin, id, 0, 'abc');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, size: 3 });

    r = await chunk(port, origin, id, 0, 'abc'); // the retry of a chunk whose reply got lost
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, size: 3 });
    assert.equal(fs.readFileSync(part, 'utf8'), 'abc');

    r = await chunk(port, origin, id, 3, 'defg');
    assert.deepEqual(r.json, { ok: true, size: 7 });

    r = await chunk(port, origin, id, 10, 'xyz'); // a chunk went missing before this one
    assert.equal(r.status, 409);
    assert.deepEqual(r.json, { error: 'E_OFFSET', size: 7 });

    r = await chunk(port, origin, id, 2, 'zz'); // overlaps but is not a clean repeat
    assert.equal(r.status, 409);
    assert.equal(fs.readFileSync(part, 'utf8'), 'abcdefg');
  });

  test('a chunk for an unknown take or a missing .part gets 410', async (t) => {
    const root = makeRoot();
    const { port, origin } = await start(t, root);
    let r = await chunk(port, origin, 'take-99-20260101-000000', 0, 'abc');
    assert.equal(r.status, 410);
    assert.equal(r.json.error, 'E_GONE');
    const id = await newTake(port, origin);
    fs.unlinkSync(path.join(root, 'takes', `${id}.part`));
    r = await chunk(port, origin, id, 0, 'abc');
    assert.equal(r.status, 410);
  });

  test('a bad id or offset gets 400', async (t) => {
    const root = makeRoot();
    const { port, origin } = await start(t, root);
    const id = await newTake(port, origin);
    assert.equal((await chunk(port, origin, 'not-a-take', 0, 'a')).json.error, 'E_BAD_ID');
    for (const off of ['', '-1', '1.5', 'abc']) assert.equal((await chunk(port, origin, id, off, 'a')).json.error, 'E_BAD_OFFSET', off);
    const noOffset = await request(port, { method: 'POST', path: `/api/takes/${id}/chunk`, headers: { Origin: origin }, body: 'a' });
    assert.equal(noOffset.status, 400);
  });

  test('finish without ffmpeg keeps the browser file and returns a note code', async (t) => {
    const root = makeRoot();
    const { port, origin } = await start(t, root);
    const id = await newTake(port, origin);
    await chunk(port, origin, id, 0, 'video-bytes');
    const r = await request(port, {
      method: 'POST', path: `/api/takes/${id}/finish`, headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ext: 'mp4', mime: 'video/mp4', discarded: false, meta: { durationMs: 1000, wpm: { Alice: 150 } } }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.file, `${id}.mp4`);
    assert.equal(r.json.note, 'E_NO_FFMPEG');
    assert.equal(r.json.stats.wpm.Alice, 150);
    assert.equal(fs.readFileSync(path.join(root, 'takes', `${id}.mp4`), 'utf8'), 'video-bytes');
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'takes', `${id}.json`), 'utf8'));
    assert.equal(meta.file, `${id}.mp4`);
    assert.equal(meta.uploadFailed, undefined);
    assert.equal(fs.existsSync(path.join(root, 'takes', `${id}.part`)), false);
  });

  test('finish with a failing ffmpeg returns E_FFMPEG_FAILED and keeps the browser file', async (t) => {
    const root = makeRoot();
    // node itself rejects ffmpeg's options and exits with an error: a deterministic "ffmpeg failed"
    const { port, origin } = await start(t, root, { ffmpeg: process.execPath });
    const id = await newTake(port, origin);
    await chunk(port, origin, id, 0, 'webm-bytes');
    const r = await request(port, {
      method: 'POST', path: `/api/takes/${id}/finish`, headers: { Origin: origin },
      body: JSON.stringify({ ext: 'webm', mime: 'video/webm', discarded: true, meta: {} }),
    });
    assert.equal(r.json.note, 'E_FFMPEG_FAILED');
    assert.equal(typeof r.json.noteDetail, 'string');
    assert.equal(r.json.file, `${id}-x.webm`);
    assert.equal(fs.readFileSync(path.join(root, 'takes', `${id}-x.webm`), 'utf8'), 'webm-bytes');
    assert.equal(fs.existsSync(path.join(root, 'takes', `${id}-x.mp4`)), false);
  });

  test('finish with uploadFailed names the file and its JSON <id>-partial', async (t) => {
    const root = makeRoot();
    const { port, origin } = await start(t, root);
    const id = await newTake(port, origin);
    await chunk(port, origin, id, 0, 'first-second');
    const r = await request(port, {
      method: 'POST', path: `/api/takes/${id}/finish`, headers: { Origin: origin },
      body: JSON.stringify({ ext: 'mp4', mime: 'video/mp4', discarded: false, uploadFailed: true, meta: { durationMs: 5000 } }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.file, `${id}-partial.mp4`);
    const takes = fs.readdirSync(path.join(root, 'takes')).sort();
    assert.deepEqual(takes, [`${id}-partial.json`, `${id}-partial.mp4`]);
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'takes', `${id}-partial.json`), 'utf8'));
    assert.equal(meta.file, `${id}-partial.mp4`);
    assert.equal(meta.uploadFailed, true);
    assert.equal(meta.durationMs, 5000);
  });

  test('finish after the .part is gone still saves the log and says E_GONE', async (t) => {
    const root = makeRoot();
    const { port, origin } = await start(t, root);
    const id = await newTake(port, origin);
    fs.unlinkSync(path.join(root, 'takes', `${id}.part`));
    const r = await request(port, {
      method: 'POST', path: `/api/takes/${id}/finish`, headers: { Origin: origin },
      body: JSON.stringify({ ext: 'mp4', mime: 'video/mp4', uploadFailed: true, meta: { durationMs: 1 } }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.file, null);
    assert.equal(r.json.note, 'E_GONE');
    assert.ok(fs.existsSync(path.join(root, 'takes', `${id}-partial.json`)));
  });
});

describe('.part recovery at startup', () => {
  const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8]);
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(20, 7)]);
  const OTHER = Buffer.from('not a known container');

  test('without ffmpeg: old parts are renamed by container, empty ones deleted, fresh and logged ones left alone', async (t) => {
    const takes = (r) => path.join(r, 'takes');
    const root = makeRoot((r) => {
      const put = (name, data, min) => { write(path.join(takes(r), name), data); if (min) ageMinutes(path.join(takes(r), name), min); };
      put('take-01-20260101-000001.part', WEBM, 2);
      put('take-02-20260101-000002.part', MP4, 2);
      put('take-03-20260101-000003.part', OTHER, 2);
      put('take-04-20260101-000004.part', '', 2); // empty and old → deleted
      put('take-05-20260101-000005.part', '', 0); // empty but fresh → left alone
      put('take-06-20260101-000006.part', MP4, 0); // fresh: may still be recording
      put('take-07-20260101-000007.part', MP4, 2); // has a .json → left alone
      put('take-07-20260101-000007.json', '{}', 2);
    });
    const { server, port, origin, logs } = await start(t, root);
    const results = await server.recovery;
    const files = fs.readdirSync(takes(root)).sort();
    assert.deepEqual(files, [
      'take-01-20260101-000001-recovered.webm',
      'take-02-20260101-000002-recovered.mp4',
      'take-03-20260101-000003-recovered.mp4',
      'take-05-20260101-000005.part',
      'take-06-20260101-000006.part',
      'take-07-20260101-000007.json',
      'take-07-20260101-000007.part',
    ]);
    // Every byte is kept
    assert.deepEqual(fs.readFileSync(path.join(takes(root), 'take-01-20260101-000001-recovered.webm')), WEBM);
    assert.deepEqual(fs.readFileSync(path.join(takes(root), 'take-02-20260101-000002-recovered.mp4')), MP4);
    assert.deepEqual(fs.readFileSync(path.join(takes(root), 'take-03-20260101-000003-recovered.mp4')), OTHER);
    assert.deepEqual(results.map((x) => x.action), ['renamed', 'renamed', 'renamed', 'deleted', 'skipped', 'skipped', 'skipped']);
    // One English line per file, after the two startup lines
    assert.equal(logs.length, 2 + 7);
    assert.ok(logs.includes('Recovered take-01-20260101-000001.part as take-01-20260101-000001-recovered.webm without converting it (ffmpeg not found)'));
    assert.ok(logs.includes('Deleted empty take-04-20260101-000004.part'));
    // A late chunk for a recovered take gets 410, so the browser falls back to its own copy
    const r = await request(port, { method: 'POST', path: '/api/takes/take-02-20260101-000002/chunk?offset=32', headers: { Origin: origin }, body: 'x' });
    assert.equal(r.status, 410);
  });

  test('with a failing ffmpeg the part is still kept, renamed', async (t) => {
    const root = makeRoot((r) => {
      write(path.join(r, 'takes', 'take-01-20260101-000001.part'), MP4);
      ageMinutes(path.join(r, 'takes', 'take-01-20260101-000001.part'), 2);
    });
    const { server, logs } = await start(t, root, { ffmpeg: process.execPath });
    const [res] = await server.recovery;
    assert.equal(res.action, 'renamed');
    assert.deepEqual(fs.readdirSync(path.join(root, 'takes')), ['take-01-20260101-000001-recovered.mp4']);
    assert.deepEqual(fs.readFileSync(path.join(root, 'takes', 'take-01-20260101-000001-recovered.mp4')), MP4);
    assert.ok(logs.at(-1).endsWith('(ffmpeg failed)'));
  });

  test('with ffmpeg a truncated fragmented mp4 is remuxed and the part deleted', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async (t) => {
    const root = makeRoot();
    const part = path.join(root, 'takes', 'take-01-20260101-000001.part');
    fs.mkdirSync(path.dirname(part), { recursive: true });
    const full = path.join(root, 'full.mp4');
    const made = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10',
      '-t', '2', '-c:v', 'mpeg4', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', full], { windowsHide: true });
    assert.equal(made.status, 0, String(made.stderr));
    const bytes = fs.readFileSync(full);
    fs.writeFileSync(part, bytes.subarray(0, Math.floor(bytes.length * 0.7))); // as if the browser crashed mid-take
    ageMinutes(part, 2);
    const { server } = await start(t, root, { ffmpeg: 'ffmpeg' });
    const [res] = await server.recovery;
    assert.equal(res.action, 'recovered');
    assert.equal(fs.existsSync(part), false);
    const out = path.join(root, 'takes', 'take-01-20260101-000001-recovered.mp4');
    assert.ok(fs.statSync(out).size > 0);
  });
});
