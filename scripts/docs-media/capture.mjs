// Browser side of the docs media pipeline: system Chrome via playwright-core, a CDP screencast (JPEG frames with
// wall-clock timestamps), a log of every page state change and input (page-side wall-clock times), and input
// helpers that can hit a planned wall-clock moment.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { optimisePng } from './encode.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VIEW = { width: 1280, height: 720 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits until wall-clock ms `t` (sleeps, then spins the last few ms: timers on Windows are coarse). */
export async function untilWall(t) {
  const d = t - Date.now() - 20;
  if (d > 0) await sleep(d);
  while (Date.now() < t) { /* spin */ }
}

export async function launch({ headed = false, fake = null } = {}) {
  const args = ['--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', '--force-color-profile=srgb', '--disable-features=Translate'];
  if (fake) {
    args.push('--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${fake.video}`, `--use-file-for-fake-audio-capture=${fake.audio}%noloop`);
  }
  if (headed) args.push('--window-position=-2400,0', `--window-size=${VIEW.width},${VIEW.height + 140}`);
  try {
    return await chromium.launch({ channel: 'chrome', headless: !headed, args });
  } catch (e) {
    throw new Error(`Could not start Google Chrome (playwright-core, channel "chrome"). Is Chrome installed? ${e.message.split('\n')[0]}`);
  }
}

// What Windows calls a webcam and a USB microphone, in the UI language of each clip
const DEVICE_NAMES = {
  en: { videoinput: 'HD Webcam', audioinput: 'Default - Microphone (USB Audio Device)', audiooutput: 'Default - Speakers' },
  zh: { videoinput: 'HD Webcam', audioinput: '默认 - 麦克风 (USB Audio Device)', audiooutput: '默认 - 扬声器' },
};

// Runs in the page before the app: UI language, a first-visit camera permission state, and the event log.
function pageInit(lang) {
  return `(() => {
  try {
    const s = JSON.parse(localStorage.getItem('tp.settings') || '{}');
    s.uiLang = ${JSON.stringify(lang)};
    localStorage.setItem('tp.settings', JSON.stringify(s));
  } catch {}
  // The sound check opens the camera by itself when it was allowed before. The demo shows the first visit:
  // report "prompt", so the camera opens when "Open camera and microphone" is clicked.
  try {
    const q = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (d) => (d && (d.name === 'camera' || d.name === 'microphone'))
      ? Promise.resolve({ name: d.name, state: 'prompt', onchange: null, addEventListener() {}, removeEventListener() {} })
      : q(d);
  } catch {}
  const now = () => performance.timeOrigin + performance.now();
  const log = (type, extra) => { try { window.__dmLog({ t: now(), type, ...extra }); } catch {} };
  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    const gum = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => { log('gum-call'); const s = await gum(c); log('gum-ok'); return s; };
    // The fake devices are named after their files (a local path): show ordinary device names instead
    const enumerate = md.enumerateDevices.bind(md);
    const NAMES = ${JSON.stringify(DEVICE_NAMES[lang] || DEVICE_NAMES.en)};
    md.enumerateDevices = async () => (await enumerate()).map((d) => ({
      deviceId: d.deviceId, groupId: d.groupId, kind: d.kind, label: d.label ? NAMES[d.kind] || d.label : '', toJSON() { return this; },
    }));
  }
  for (const type of ['pointerdown', 'pointerup', 'click', 'keydown', 'wheel']) {
    window.addEventListener(type, (e) => log(type, { button: e.button, key: e.key, x: e.clientX, y: e.clientY }), { capture: true, passive: true });
  }
  const watch = () => {
    new MutationObserver((recs) => {
      const vals = recs.map((r) => r.oldValue).slice(1);
      vals.push(document.body.dataset.state);
      for (const v of vals) log('state', { state: v });
    }).observe(document.body, { attributes: true, attributeFilter: ['data-state'], attributeOldValue: true });
    const cue = document.getElementById('cue');
    if (cue) {
      let last = '';
      new MutationObserver(() => {
        const k = (cue.classList.contains('on') ? '1' : '0') + cue.textContent;
        if (k === last) return;
        last = k;
        log('cue', { on: cue.classList.contains('on'), text: cue.textContent });
      }).observe(cue, { attributes: true, childList: true, characterData: true, subtree: true });
    }
    const pv = document.getElementById('pv');
    if (pv && pv.requestVideoFrameCallback) {
      let n = 0;
      const cb = (_t, m) => {
        if (n++ < 90) {
          log('cam-frame', { cap: m.captureTime != null ? m.captureTime + performance.timeOrigin : null, mt: m.mediaTime,
            exp: m.expectedDisplayTime + performance.timeOrigin, pres: m.presentationTime + performance.timeOrigin });
          pv.requestVideoFrameCallback(cb);
        }
      };
      pv.addEventListener('loadeddata', () => { n = 0; pv.requestVideoFrameCallback(cb); });
    }
    log('dom-ready');
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
  else watch();
})();`;
}

export class Session {
  /** opts: { lang, base, holdText, spaceText } */
  static async create(browser, opts) {
    const s = new Session();
    s.opts = opts;
    s.log = [];
    s.context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, locale: opts.lang === 'zh' ? 'zh-CN' : 'en-US' });
    await s.context.exposeBinding('__dmLog', (_src, ev) => { s.log.push(ev); });
    await s.context.addInitScript({ content: pageInit(opts.lang) });
    const overlay = fs.readFileSync(path.join(HERE, 'overlay.js'), 'utf8');
    await s.context.addInitScript({ content: `window.__DM_CFG = ${JSON.stringify({ hold: opts.holdText, space: opts.spaceText })};\n${overlay}` });
    s.page = await s.context.newPage();
    s.cdp = await s.context.newCDPSession(s.page);
    s.clickLag = 8; // ms from mouse.up to the page's click event; updated as clicks are measured
    s.page.on('pageerror', (e) => console.warn(`  [page error] ${e.message}`));
    return s;
  }

  async open(query) {
    await this.page.goto(`${this.opts.base}/${query}`);
    await this.page.waitForFunction(() => document.body.dataset.state !== 'boot', null, { timeout: 15000 });
    await this.page.evaluate(() => document.fonts.ready.then(() => true));
  }

  mark() {
    return this.log.length;
  }

  /** Logs a scripted action with node's wall-clock time before and after it. */
  async act(name, fn) {
    const t0 = Date.now();
    const r = await fn();
    this.log.push({ t: t0, type: 'action', name, done: Date.now() });
    return r;
  }

  /** Waits for a log event matching pred (searching from index `from`). */
  async waitLog(pred, { from = 0, timeout = 10000 } = {}) {
    const end = Date.now() + timeout;
    for (;;) {
      for (let i = from; i < this.log.length; i++) if (pred(this.log[i])) return this.log[i];
      if (Date.now() > end) throw new Error(`timed out waiting for a log event (${pred})`);
      await sleep(10);
    }
  }

  waitState(state, opts = {}) {
    return this.waitLog((e) => e.type === 'state' && e.state === state, opts);
  }

  async rect(selector) {
    const r = await this.page.locator(selector).first().boundingBox();
    if (!r) throw new Error(`${selector} is not visible`);
    return r;
  }

  async center(selector) {
    const r = await this.rect(selector);
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }

  /** Moves to (x, y), waits `pre` ms (the pointer dot shows where it will click), clicks. Returns the page's click event. */
  async click(x, y, { pre = 280, hold = 90, button = 'left' } = {}) {
    await this.act(`move ${x},${y}`, () => this.page.mouse.move(x, y, { steps: 6 }));
    await sleep(pre);
    const m = this.mark();
    await this.act(`${button} down`, () => this.page.mouse.down({ button }));
    await sleep(hold);
    await this.act(`${button} up`, () => this.page.mouse.up({ button }));
    const type = button === 'left' ? 'click' : 'pointerup';
    return this.waitLog((e) => e.type === type, { from: m, timeout: 2000 });
  }

  clickSel(selector, opts) {
    return this.center(selector).then(({ x, y }) => this.click(x, y, opts));
  }

  /** A click whose page click event lands as close as possible to wall-clock ms `at`. Returns { ev, error } (ms). */
  async clickAtWall(x, y, at) {
    await untilWall(at - 320);
    await this.act(`move ${x},${y}`, () => this.page.mouse.move(x, y, { steps: 6 }));
    await untilWall(at - 80 - this.clickLag);
    const m = this.mark();
    await this.act('left down', () => this.page.mouse.down());
    await untilWall(at - this.clickLag);
    const sent = Date.now();
    await this.act(`left up (planned click at ${at.toFixed(1)})`, () => this.page.mouse.up());
    const ev = await this.waitLog((e) => e.type === 'click', { from: m, timeout: 2000 });
    this.clickLag = Math.max(0, Math.min(40, (this.clickLag + (ev.t - sent)) / 2));
    return { ev, error: ev.t - at };
  }

  /** Holds a mouse button for ms (in place). Returns { down, up } page events. */
  async hold(x, y, { button = 'left', ms = 1150 } = {}) {
    await this.act(`move ${x},${y}`, () => this.page.mouse.move(x, y));
    const m = this.mark();
    await this.act(`${button} down (hold)`, () => this.page.mouse.down({ button }));
    const down = await this.waitLog((e) => e.type === 'pointerdown', { from: m, timeout: 2000 });
    await sleep(ms);
    await this.act(`${button} up (hold)`, () => this.page.mouse.up({ button }));
    const up = await this.waitLog((e) => e.type === 'pointerup', { from: m, timeout: 2000 });
    return { down, up };
  }

  async press(key) {
    const m = this.mark();
    await this.act(`key ${key}`, () => this.page.keyboard.press(key, { delay: 70 }));
    return this.waitLog((e) => e.type === 'keydown', { from: m, timeout: 2000 });
  }

  async overlayHidden(on) {
    await this.page.evaluate((v) => window.__dmOverlay?.hidden(v), on);
  }

  /** A PNG of the page without the overlay. */
  async shot(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await this.overlayHidden(true);
    await this.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await this.page.screenshot({ path: file });
    await this.overlayHidden(false);
    await optimisePng(file);
  }

  // ── Screencast ──
  async startCast(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    this.cast = { dir, frames: [], writes: [], n: 0 };
    this.onFrame = ({ data, metadata, sessionId }) => {
      this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      const c = this.cast;
      if (!c) return;
      const file = path.join(c.dir, `${String(c.n++).padStart(6, '0')}.jpg`);
      c.frames.push({ ts: metadata.timestamp ? metadata.timestamp * 1000 : Date.now(), file });
      c.writes.push(fsp.writeFile(file, Buffer.from(data, 'base64')));
    };
    this.cdp.on('Page.screencastFrame', this.onFrame);
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: VIEW.width, maxHeight: VIEW.height, everyNthFrame: 1 });
    // The first frame can be older than the start; wait until frames flow
    await sleep(150);
  }

  async stopCast() {
    await this.cdp.send('Page.stopScreencast');
    this.cdp.off('Page.screencastFrame', this.onFrame);
    const c = this.cast;
    this.cast = null;
    await Promise.all(c.writes);
    return c.frames.sort((a, b) => a.ts - b.ts);
  }

  async close() {
    await this.context.close().catch(() => {});
  }
}

/**
 * Render lag of the capture: how long after a page state change (logged time) the screencast shows it.
 * Uses anchors whose look changes inside `region` (e.g. the countdown digits). Returns ms per anchor.
 */
export async function renderLag(frames, anchors, region, luma) {
  const out = [];
  for (const at of anchors) {
    const before = frames.filter((f) => f.ts <= at).at(-1);
    if (!before) continue;
    const base = await luma(before.file, region);
    const after = frames.filter((f) => f.ts > at && f.ts < at + 400);
    for (const f of after) {
      if (Math.abs((await luma(f.file, region)) - base) > 0.6) { out.push({ at, ts: f.ts, lag: f.ts - at }); break; }
    }
  }
  return out;
}
