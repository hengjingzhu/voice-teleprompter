// What happens in each demo clip: the scripted mouse and keyboard actions, and which wall-clock moments the
// encoder needs (where each audio file starts, the clip window, the poster moment).
// Every function captures with a fresh browser context (clean localStorage) and returns plain data.

import fs from 'node:fs';
import path from 'node:path';
import { Session, untilWall, renderLag } from './capture.mjs';
import { ffmpeg, fontFile, regionLuma, FPS, outFrameOf } from './encode.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };

// The countdown digit sits centred on the reading line (12% from the top); its look changes at every
// countdown / recording state change, so it measures how late the screencast shows a page change.
const COUNT_REGION = { x: 560, y: 80, w: 160, h: 130 };
const DEFAULT_LAG = 33;

// Sound check plan: ms after the camera opens
export const SETUP_PLAN = { calibrate: 1300, test: 5400 };
const XF = 0.25; // crossfade between the idle loop and the opening clip in the camera feed, s
const WHEEL_NOTCHES = 3; // review.png: phrases skipped with the wheel (2 get re-matched and show no yellow)

/** Render lag from the state changes that change the countdown digit. */
async function lagOf(frames, log, from, to) {
  const anchors = log.filter((e) => e.type === 'state' && ['countdown', 'recording'].includes(e.state) && e.t >= from && e.t <= to).map((e) => e.t);
  const lags = await renderLag(frames, anchors, COUNT_REGION, regionLuma);
  const L = lags.length ? lags.reduce((a, x) => a + x.lag, 0) / lags.length : DEFAULT_LAG;
  return { L, lags };
}

/** A/V check: for each anchor, where the video shows it (30 fps frame) vs where the audio timeline puts it (ms each). */
function avError(lags, L, from) {
  return lags.map((a) => Math.abs((outFrameOf(a.ts, from) / FPS) * 1000 - (a.at + L - from)));
}

// lines.json may write speaker names in another case than the script ("jess" / "Jess")
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const startsWithName = (text, name) => String(text).toLowerCase().startsWith(`${String(name).toLowerCase()} `);

function speakerOrder(lines) {
  const order = [];
  for (const l of lines) if (!/^(both|all|together)$/i.test(l.speaker) && !order.some((x) => same(x, l.speaker))) order.push(l.speaker);
  return order;
}

/** Text column of the prompter (with the name tags and the cue left of it), as a 16:9 crop of the capture. */
async function textCrop(s) {
  const r = await s.page.evaluate(() => {
    const box = (el) => el.getBoundingClientRect();
    const col = box(document.getElementById('column'));
    const lefts = [...document.querySelectorAll('.who')].map((e) => box(e).left);
    const cue = document.getElementById('cue');
    const fs = parseFloat(getComputedStyle(document.getElementById('stage')).fontSize);
    // The cue's right edge is fixed; its text can be longer than now (another name): allow 7 em of tag width
    lefts.push(box(cue).right - 0.36 * fs * 7);
    return { left: Math.min(...lefts), right: col.right };
  });
  const x = Math.max(0, Math.floor(r.left - 16));
  let w = Math.min(1280 - x, Math.ceil(r.right + 16) - x);
  w += w % 2;
  let h = Math.round((w * 9) / 16);
  h -= h % 2;
  return { x, y: 0, w, h };
}

// ── follow.mp4 and hero.mp4 ──────────────────────────────────
export async function captureFollow(browser, env) {
  const s = await Session.create(browser, env.session);
  try {
    await s.open('?sim=demo.json');
    await sleep(500);
    await s.startCast(path.join(env.tmp, 'follow'));
    await sleep(1100);
    const m = s.mark();
    const click = await s.click(640, 430);
    const down = s.log.slice(m).find((e) => e.type === 'pointerdown');
    const rec = await s.waitState('recording', { from: m, timeout: 8000 });
    await sleep(300);
    const crop = await textCrop(s);
    const heroEnd = rec.t + env.fixture.audioOffsetMs + env.heroMs + 800;
    await untilWall(Math.max(down.t + 16500, heroEnd));
    const frames = await s.stopCast();
    return { frames, log: s.log.slice(), down, click, rec, crop };
  } finally {
    await s.close();
  }
}

export async function planFollow(cap, env) {
  const { frames, log, down, rec } = cap;
  const from = down.t - 900;
  const { L, lags } = await lagOf(frames, log, from, rec.t + 100);
  const voiceAt = rec.t + env.fixture.audioOffsetMs + L; // where voice-full's 0 s plays on the capture timeline
  // End on a line end: the last one that leaves the clip at most 15.5 s long (and at least 9 s)
  const ends = env.lines.map((l) => voiceAt + l.endMs + 650).filter((t) => t - from <= 15500 && t - from >= 9000);
  const to = ends.length ? Math.max(...ends) : from + 15000;
  const [, second] = speakerOrder(env.lines);
  const warnings = [];
  const cueSecond = log.find((e) => e.type === 'cue' && e.on && second && startsWithName(e.text, second) && e.t >= rec.t && e.t < to);
  const secondLine = env.lines.find((l) => same(l.speaker, second));
  if (!cueSecond) warnings.push(`follow: the "${second} →" cue does not show in the clip`);
  if (!secondLine || voiceAt + secondLine.startMs > to) warnings.push(`follow: ${second} does not start speaking in the clip`);
  const poster = secondLine ? Math.max(1, (voiceAt + secondLine.startMs - 350 - from) / 1000) : 6;
  return {
    from, to, L, lags,
    audio: [{ file: env.src.voice, at: voiceAt, start: 0, end: (to - voiceAt) / 1000, fade: 0.25 }],
    av: avError(lags, L, from),
    expectOnsets: [(voiceAt + env.voiceOnsetMs - from) / 1000],
    poster,
    warnings,
    voiceAt,
  };
}

export function planHero(cap, follow, env) {
  const from = follow.voiceAt; // the opening clip's 0 s = voice-full's 0 s
  const to = from + env.heroMs;
  return {
    from, to, L: follow.L, lags: follow.lags,
    crop: cap.crop,
    left: { file: env.src.opening, w: 640, start: 0 },
    audio: [{ leftAudio: true }],
    // Same render lag as follow; the 30 fps grid starts elsewhere, so the frame rounding differs
    av: avError(follow.lags, follow.L, from),
    expectOnsets: [env.voiceOnsetMs / 1000],
    poster: Math.min(env.heroMs / 1000 - 0.5, (env.lines[1]?.startMs ?? 3000) / 1000 + 0.6),
    warnings: [],
  };
}

// ── controls.mp4 ─────────────────────────────────────────────
export async function captureControls(browser, env) {
  const s = await Session.create(browser, env.session);
  try {
    await s.open('?sim=demo.json');
    await sleep(500);
    await s.startCast(path.join(env.tmp, 'controls'));
    await sleep(700);
    const m = s.mark();
    await s.click(640, 430);
    const down = s.log.slice(m).find((e) => e.type === 'pointerdown');
    const rec1 = await s.waitState('recording', { from: m, timeout: 8000 });
    await untilWall(rec1.t + 2300);
    const m2 = s.mark();
    const discard = await s.hold(640, 430, { button: 'right', ms: 1150 });
    const cd2 = await s.waitState('countdown', { from: m2, timeout: 3000 });
    const rec2 = await s.waitState('recording', { from: m2, timeout: 8000 });
    await untilWall(rec2.t + 2300);
    const m3 = s.mark();
    const stop = await s.hold(640, 430, { button: 'left', ms: 1150 });
    const saving = await s.waitState('saving', { from: m3, timeout: 3000 });
    const review = await s.waitState('review', { from: m3, timeout: 5000 });
    await sleep(1700);
    const frames = await s.stopCast();
    return { frames, log: s.log.slice(), down, rec1, discard, cd2, rec2, stop, saving, review };
  } finally {
    await s.close();
  }
}

export async function planControls(cap, env) {
  const { frames, log, down, rec1, cd2, rec2, saving, review, discard } = cap;
  const from = down.t - 600;
  const to = review.t + 1500;
  const { L, lags } = await lagOf(frames, log, from, rec2.t + 100);
  const off = env.fixture.audioOffsetMs;
  const v1 = rec1.t + off + L;
  const v2 = rec2.t + off + L;
  return {
    from, to, L, lags,
    audio: [
      { file: env.src.voice, at: v1, start: 0, end: Math.max(0.1, (cd2.t + L - v1) / 1000), fade: 0.12 },
      { file: env.src.voice, at: v2, start: 0, end: Math.max(0.1, (saving.t + L - v2) / 1000), fade: 0.12 },
    ],
    av: avError(lags, L, from),
    expectOnsets: [(v1 + env.voiceOnsetMs - from) / 1000, (v2 + env.voiceOnsetMs - from) / 1000],
    poster: (discard.down.t + 650 - from) / 1000,
    warnings: [],
  };
}

// ── editor.mp4 ───────────────────────────────────────────────
/** Caret target: the end of the first speaker's paragraph (the last one of their first block with two or more). */
async function caretTarget(s, lines) {
  const [first] = speakerOrder(lines);
  const own = lines.filter((l) => same(l.speaker, first));
  // lines.json has one entry per script line; prefer a speaker block's last line that follows another of theirs
  let pick = own[0];
  for (let i = 1; i < lines.length; i++) if (same(lines[i].speaker, first) && same(lines[i - 1].speaker, first)) { pick = lines[i]; break; }
  return s.page.evaluate((text) => {
    const ta = document.getElementById('ed-text');
    const v = ta.value;
    let pos = -1;
    let at = 0;
    for (const line of v.split('\n')) {
      if (line.trim().endsWith(text)) { pos = at + line.replace(/\s+$/, '').length; break; }
      at += line.length + 1;
    }
    if (pos < 0) return null;
    // Where the caret would be drawn: a hidden copy of the textarea with the same text up to pos
    const cs = getComputedStyle(ta);
    const div = document.createElement('div');
    for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth', 'borderRightWidth', 'boxSizing', 'tabSize']) div.style[p] = cs[p];
    const r = ta.getBoundingClientRect();
    Object.assign(div.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', visibility: 'hidden', borderStyle: 'solid', borderColor: 'transparent' });
    div.textContent = v.slice(0, pos);
    const mark = document.createElement('span');
    mark.textContent = '​';
    div.append(mark);
    document.body.append(div);
    const m = mark.getBoundingClientRect();
    div.remove();
    return { pos, x: m.left, y: m.top + m.height / 2 - ta.scrollTop, lineH: parseFloat(cs.lineHeight) };
  }, pick.text);
}

async function placeCaret(s, lines, { click = true } = {}) {
  const tg = await caretTarget(s, lines);
  if (!tg) throw new Error('editor: the paragraph to extend was not found in the textarea');
  if (click) await s.click(Math.round(tg.x + 14), Math.round(tg.y), { pre: 350 });
  const ok = await s.page.evaluate((pos) => document.getElementById('ed-text').selectionStart === pos, tg.pos);
  if (!ok) await s.page.evaluate((pos) => { const ta = document.getElementById('ed-text'); ta.focus(); ta.setSelectionRange(pos, pos); }, tg.pos);
  return { ...tg, clicked: ok };
}

// About 25 characters a second: quick within a word, a short pause after each one. The pause is longer than the
// editor's 120 ms refresh delay, so the preview and the estimate update word by word, as with real typing.
async function typeLikeAPerson(s, text, { perChar = 16, perWord = 125 } = {}) {
  const words = text.match(/\s*\S+/g) || [];
  for (const w of words) {
    await s.act(`type "${w}"`, () => s.page.keyboard.type(w, { delay: perChar }));
    await sleep(perWord);
  }
}

export async function captureEditor(browser, env) {
  const s = await Session.create(browser, env.session);
  const dialogs = [];
  s.page.on('dialog', async (d) => {
    const open = Date.now();
    await sleep(env.dialogMs);
    const accept = Date.now();
    dialogs.push({ open, accept, message: d.message(), type: d.type() });
    await d.accept();
  });
  try {
    await s.open('?sim=demo.json');
    await sleep(500);
    await s.startCast(path.join(env.tmp, 'editor'));
    await sleep(800);
    const m = s.mark();
    const key = await s.press('e');
    await s.waitState('editor', { from: m, timeout: 3000 });
    await sleep(1000);
    const caret = await placeCaret(s, env.lines);
    await sleep(250);
    const typeStart = Date.now();
    await typeLikeAPerson(s, env.addSentence);
    const typeEnd = Date.now();
    await sleep(1500);
    await s.page.evaluate(() => window.__dmOverlay?.showKey('Esc'));
    await sleep(80);
    const m2 = s.mark();
    await s.act('key Escape (the confirm dialog follows)', () => s.page.keyboard.press('Escape'));
    const ready = await s.waitState('ready', { from: m2, timeout: env.dialogMs + 5000 });
    await sleep(1300);
    const frames = await s.stopCast();
    return { frames, log: s.log.slice(), key, caret, typeStart, typeEnd, dialogs, ready };
  } finally {
    await s.close();
  }
}

/** PNGs that redraw Chrome's confirm dialog (native dialogs are not part of the page, so the screencast misses them). */
export async function renderDialog(browser, { lang, message, dir }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 400 }, deviceScaleFactor: 1 });
  try {
    const page = await ctx.newPage();
    const t = lang === 'zh' ? { says: 'localhost:5178 显示', ok: '确定', cancel: '取消', font: '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif' } : { says: 'localhost:5178 says', ok: 'OK', cancel: 'Cancel', font: '"Segoe UI", system-ui, sans-serif' };
    const esc = (x) => x.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    const html = (pressed) => `<!doctype html><html><body style="margin:0;background:transparent">
      <div id="wrap" style="display:inline-block;padding:4px 18px 26px">
        <div style="position:relative;width:410px;box-sizing:border-box;padding:22px 24px 20px;background:#fff;border-radius:12px;
          box-shadow:0 4px 8px 3px rgba(0,0,0,.15),0 1px 3px rgba(0,0,0,.3);font-family:${t.font};color:#1f1f1f">
          <div style="font-size:15px;line-height:22px">${esc(t.says)}</div>
          <div style="font-size:13px;line-height:20px;margin-top:12px">${esc(message)}</div>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:22px">
            <span id="ok" style="display:inline-flex;align-items:center;height:32px;padding:0 18px;border-radius:16px;background:${pressed ? '#0842a0' : '#0b57d0'};color:#fff;font-size:13px;font-weight:600">${esc(t.ok)}</span>
            <span style="display:inline-flex;align-items:center;height:30px;padding:0 17px;border-radius:16px;border:1px solid #747775;color:#0b57d0;font-size:13px;font-weight:600">${esc(t.cancel)}</span>
          </div>
          ${pressed ? '<div id="dot" style="position:absolute;width:18px;height:18px;border-radius:50%;background:rgba(17,17,17,.45);border:2px solid rgba(255,255,255,.9);box-shadow:0 0 0 1px rgba(0,0,0,.25)"></div>' : ''}
        </div>
      </div></body></html>`;
    const out = {};
    for (const pressed of [false, true]) {
      await page.setContent(html(pressed));
      await page.evaluate(() => document.fonts.ready.then(() => true));
      if (pressed) {
        await page.evaluate(() => {
          const ok = document.getElementById('ok').getBoundingClientRect();
          const box = document.getElementById('dot').parentElement.getBoundingClientRect();
          const dot = document.getElementById('dot');
          dot.style.left = `${ok.left - box.left + ok.width / 2 - 11}px`;
          dot.style.top = `${ok.top - box.top + ok.height / 2 - 11}px`;
        });
      }
      const file = path.join(dir, `dialog-${lang}${pressed ? '-pressed' : ''}.png`);
      const el = page.locator('#wrap');
      await el.screenshot({ path: file, omitBackground: true });
      const bb = await el.boundingBox();
      out[pressed ? 'pressed' : 'normal'] = { file, w: Math.round(bb.width), h: Math.round(bb.height) };
    }
    return out;
  } finally {
    await ctx.close();
  }
}

export async function planEditor(cap, env, browser) {
  const { key, ready, dialogs, typeEnd } = cap;
  const from = key.t - 800;
  const to = ready.t + 1200;
  const overlays = [];
  const warnings = [];
  const d = dialogs[0];
  if (d) {
    const png = await renderDialog(browser, { lang: env.lang, message: d.message, dir: env.tmp });
    const x = Math.round((1280 - png.normal.w) / 2);
    overlays.push({ file: png.normal.file, x, y: 0, from: d.open, to: d.accept - 300 });
    overlays.push({ file: png.pressed.file, x, y: 0, from: d.accept - 300, to: d.accept + 40 });
  } else warnings.push('editor: no confirm dialog came up on Esc');
  if (!cap.caret.clicked) warnings.push('editor: the click did not put the caret at the paragraph end (placed by script instead)');
  return { from, to, L: null, lags: [], overlays, audio: [], av: [], expectOnsets: [], poster: (typeEnd + 700 - from) / 1000, warnings };
}

// ── setup.mp4 (sound check with a fake camera and microphone) ──
/**
 * The camera / microphone feed for the sound check: the idle loop while the camera opens and the noise floor
 * is calibrated, then the opening clip (and its voice) placed so that its first word lands where the
 * simulated recognition test expects it, then the idle loop again. One timeline, 0 = the camera opens.
 */
export async function buildCamFeed({ src, fixture, dir, counter = false }) {
  fs.mkdirSync(dir, { recursive: true });
  const setup = fixture.setup;
  if (setup?.audioOffsetMs == null) throw new Error('test/fixtures/demo.json has no setup.audioOffsetMs (make-fixture with --timings)');
  const tOpen = (SETUP_PLAN.test + setup.audioOffsetMs) / 1000;
  if (tOpen < 0.6) throw new Error(`the opening clip would start ${tOpen.toFixed(2)} s after the camera opens; the voice's first word starts too late (${-setup.audioOffsetMs} ms)`);
  const speechEnd = Math.max(...setup.speech.map((x) => x[1]));
  // Back to the idle loop shortly after the second speaker's sentence, before the next line (and any early mouth movement)
  const tCut = (SETUP_PLAN.test + speechEnd + 150) / 1000;
  const total = tCut + 12;
  const video = path.join(dir, 'cam.y4m');
  const audio = path.join(dir, 'mic.wav');
  const norm = 'fps=30,scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,format=yuv420p,settb=AVTB';
  const g = [
    `[0:v]${norm},trim=duration=${(tOpen + XF).toFixed(3)},setpts=PTS-STARTPTS[ia]`,
    `[1:v]${norm},trim=end=${(tCut - tOpen + XF).toFixed(3)},setpts=PTS-STARTPTS[op]`,
    `[2:v]${norm},trim=duration=${(total - tCut).toFixed(3)},setpts=PTS-STARTPTS[ib]`,
    `[ia][op]xfade=transition=fade:duration=${XF}:offset=${tOpen.toFixed(3)}[x1]`,
    `[x1][ib]xfade=transition=fade:duration=${XF}:offset=${tCut.toFixed(3)}[x2]`,
    `[x2]trim=duration=${total.toFixed(3)}${counter ? `,drawtext=fontfile='${fontFile('en')}':text='%{n}':fontsize=120:fontcolor=white:box=1:boxcolor=black:x=30:y=30` : ''}[v]`,
  ];
  await ffmpeg(['-stream_loop', '-1', '-i', src.idle, '-i', src.opening, '-stream_loop', '-1', '-i', src.idle,
    '-filter_complex', g.join(';'), '-map', '[v]', '-pix_fmt', 'yuv420p', '-f', 'yuv4mpegpipe', video]);
  // Microphone: a quiet room (pink noise about -60 dBFS) and the opening voice until the cut
  const voiceEnd = tCut - tOpen + 0.1;
  await ffmpeg(['-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=0.004:sample_rate=48000:duration=${total.toFixed(3)}:seed=7`, '-i', src.openingVoice,
    '-filter_complex', [
      `[1:a]aresample=48000,aformat=channel_layouts=mono,atrim=end=${voiceEnd.toFixed(3)},afade=t=out:st=${(voiceEnd - 0.1).toFixed(3)}:d=0.1,adelay=delays=${Math.round(tOpen * 48000)}S:all=1[v]`,
      `[0:a]aformat=channel_layouts=mono[n]`,
      `[n][v]amix=inputs=2:normalize=0:duration=first[a]`,
    ].join(';'), '-map', '[a]', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1', audio]);
  return { video, audio, tOpen, tCut, total };
}

export async function captureSetup(browser, env, feed) {
  const s = await Session.create(browser, env.session);
  try {
    await s.open('?sim=demo.json&stage=setup');
    if ((await s.page.evaluate(() => document.body.dataset.state)) !== 'setup') throw new Error('sound check page did not open');
    await sleep(600);
    await s.startCast(path.join(env.tmp, 'setup'));
    await sleep(700);
    const m = s.mark();
    const openBtn = await s.center('#open-media');
    await s.click(openBtn.x, openBtn.y);
    const down = s.log.slice(m).find((e) => e.type === 'pointerdown');
    // The camera's 0 s: capture time of a frame minus its media time (rVFC), else just before getUserMedia returns
    let camStart = null;
    let camHow = 'rVFC captureTime - mediaTime';
    try {
      // The first frames reach the page some 0.8 s after getUserMedia; three are enough (they agree to 0.1 ms)
      await s.waitLog((e) => e.type === 'cam-frame' && e.cap != null && s.log.filter((x) => x.type === 'cam-frame').length >= 3, { from: m, timeout: 1150 });
      const fr = s.log.filter((e) => e.type === 'cam-frame' && e.cap != null);
      if (fr.length >= 3) camStart = median(fr.map((e) => e.cap - e.mt * 1000));
    } catch { /* fall back below */ }
    if (camStart == null) {
      const ok = await s.waitLog((e) => e.type === 'gum-ok', { from: m, timeout: 3000 });
      camStart = ok.t - 75;
      camHow = 'getUserMedia resolve - 75 ms';
    }
    const calib = await s.center('#calib');
    const cal = await s.clickAtWall(calib.x, calib.y, camStart + SETUP_PLAN.calibrate);
    // The calibration result moves the rows below it: find the button after it is shown
    await untilWall(camStart + SETUP_PLAN.test - 450);
    const testBtn = await s.center('#sr-test');
    const test = await s.clickAtWall(testBtn.x, testBtn.y, camStart + SETUP_PLAN.test);
    const lastEv = env.fixture.setup.events.at(-1).t;
    await untilWall(test.ev.t + lastEv + 1200);
    const m2 = s.mark();
    const done = await s.clickSel('#setup-done');
    const ready = await s.waitState('ready', { from: m2, timeout: 3000 });
    await sleep(1000);
    const frames = await s.stopCast();
    // Screenshot: back to the sound check (camera still on, test results kept)
    const m3 = s.mark();
    await s.press('m');
    await s.waitState('setup', { from: m3, timeout: 3000 });
    await sleep(900);
    await s.shot(path.join(env.mediaDir, 'setup.png'));
    // Camera lag: from a camera frame's capture to the first screencast frame at or after its expected display time
    const shown = s.log.filter((e) => e.type === 'cam-frame' && e.cap != null)
      .map((e) => ({ cap: e.cap, ts: frames.find((f) => f.ts >= e.exp)?.ts }))
      .filter((x) => x.ts != null);
    const camLag = shown.length ? median(shown.map((x) => x.ts - x.cap)) : DEFAULT_LAG;
    return { frames, log: s.log.slice(), down, camStart, camHow, camLag, shown, cal, test, done, ready, lastEv };
  } finally {
    await s.close();
  }
}

export function planSetup(cap, env, feed) {
  const { down, camStart, camLag, shown, test, ready, lastEv } = cap;
  const from = down.t - 700;
  const to = ready.t + 1000;
  const audioAt = camStart + camLag; // the feed's 0 s as the screencast shows the camera
  const voiceStart = audioAt + feed.tOpen * 1000 + env.voiceOnsetMs;
  // A/V: for each logged camera frame, where the clip shows it vs where the audio has that moment
  const errs = shown.filter((x) => x.ts >= from && x.ts < to).map((x) => Math.abs((outFrameOf(x.ts, from) / FPS) * 1000 - (x.cap + camLag - from)));
  return {
    from, to, L: camLag, lags: [],
    audio: [{ file: feed.audio, at: audioAt, start: 0 }],
    av: errs,
    // Planned vs real "Test recognition" click: the simulated transcript is that much off the voice
    clickErrors: { calibrate: cap.cal.error, test: test.error },
    expectOnsets: [(voiceStart - from) / 1000],
    poster: (test.ev.t + lastEv + 700 - from) / 1000,
    warnings: Math.abs(test.error) > 1000 / FPS ? [`setup: the test click was ${test.error.toFixed(0)} ms off plan`] : [],
  };
}

/** Writes the PNG stills of the prompter: ready, recording (with the next-speaker cue), review, editor. */
export async function captureStills(browser, env) {
  const s = await Session.create(browser, env.session);
  s.page.on('dialog', (d) => d.accept());
  const out = (n) => path.join(env.mediaDir, n);
  try {
    await s.open('?sim=demo.json');
    await sleep(700);
    await s.shot(out('ready.png'));
    const m = s.mark();
    await s.click(640, 430, { pre: 50 });
    const rec = await s.waitState('recording', { from: m, timeout: 8000 });
    const [, second] = speakerOrder(env.lines);
    // Mid-take: the second time the second speaker's cue comes up (the first is right at the start)
    await s.waitLog((e) => e.type === 'cue' && e.on && startsWithName(e.text, second) && e.t > rec.t + 2500, { from: m, timeout: 60000 });
    await sleep(550);
    await s.shot(out('recording.png'));
    // Wheel notches forward (the matcher re-matches words up to 12 tokens back, so one or two phrases would not
    // stay skipped): the review page then shows skipped words in yellow. Then the take ends by itself.
    await sleep(1800);
    for (let i = 0; i < WHEEL_NOTCHES; i++) {
      await s.act('wheel down', () => s.page.mouse.wheel(0, 120));
      await sleep(160);
    }
    try {
      await s.waitState('review', { from: m, timeout: env.voiceMs + 15000 });
    } catch {
      await s.press(' ');
      await s.waitState('review', { from: m, timeout: 5000 });
    }
    await sleep(800);
    await s.shot(out('review.png'));
    const m2 = s.mark();
    await s.press('e');
    await s.waitState('editor', { from: m2, timeout: 3000 });
    await sleep(400);
    await placeCaret(s, env.lines, { click: false });
    await s.page.keyboard.type(env.addSentence, { delay: 5 });
    await sleep(700);
    await s.shot(out('editor.png'));
    await s.page.keyboard.press('Escape');
    await s.waitState('ready', { from: m2, timeout: 5000 });
  } finally {
    await s.close();
  }
}

