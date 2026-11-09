// Controller: state machine + mouse / keyboard, wiring recognition, alignment, display and recording together.
//   setup (sound check) → ready → countdown → recording → saving → review → ready
// Mouse while recording: left click does nothing (guards against stray clicks), wheel moves one phrase back or forward, hold left 1 s to stop and save, hold right 1 s to discard and restart the countdown at once.

import { buildAliasMap, normalizeText, similarity } from './normalize.js';
import { parseScript } from './parse.js';
import { createMatcher, endHeard } from './matcher.js';
import { Speech, speechSupported } from './speech.js';
import { Vad } from './vad.js';
import { openStream, pickMime, TakeRecorder } from './recorder.js';
import { Prompter, speakerColors } from './prompter.js';
import { Editor } from './editor.js';
import { estimate, measureWpm, fmtSec, DEFAULT_WPM, TARGET_SEC } from './estimate.js';

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOLD_MS = 1000;
const INERTIA_AFTER = 700; // speaking, but no new word matched for this long → start inertia scrolling
const INERTIA_MAX = 3000; // inertia runs at most this long, then waits in place for recognition
const INERTIA_LEAD = 15; // inertia may run at most this many tokens ahead of the recognised position
const FAR_AFTER = 2000; // no new word matched for this long → search further ahead (recognition garbled a stretch; the speaker is already further on)
const END_HOLD = 2000; // keep recording this long after the closing "Thanks"
const END_QUIET = 3500; // also stop after this much quiet near the last few words (when "Thanks" was not recognised)
const MIN_TAKE = 10000; // no auto-stop in the first 10 s of a take
const WHEEL_STEP = 50;
const WHEEL_COOLDOWN = 90;
const RING = 2 * Math.PI * 18;

const DEFAULTS = { fontSize: 52, lang: 'en-US', noiseFloor: -55, camId: '', micId: '' };
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('tp.settings') || '{}') }; } catch { return { ...DEFAULTS }; }
}

const S = {
  state: 'boot',
  settings: loadSettings(),
  aliasMap: null,
  text: '',
  parsed: null,
  color: () => '#555',
  matcher: null,
  stats: { samples: {}, wpm: {} },
  stream: null,
  vad: null,
  speech: null,
  rec: null,
  sim: null,
  simTimers: [],
  simLastSpeak: 0,
  display: 0,
  lastAdvance: 0,
  inertiaUsed: 0,
  wideUntil: 0,
  t0: 0,
  startedAt: '',
  events: [],
  restarts: 0,
  takeParsed: null,
  takeText: '',
  stopTimer: null,
  countToken: null,
  hold: null,
  clickArmed: false,
  wheelAcc: 0,
  wheelAt: 0,
  pendingScript: null,
  testing: false,
  testDone: '',
  testCur: '',
};
let prompter;
let editor;

function saveSettings() {
  try { localStorage.setItem('tp.settings', JSON.stringify(S.settings)); } catch { /* private mode */ }
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  if (!t.hidden && t.textContent === msg) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

function setState(st) {
  S.state = st;
  document.body.dataset.state = st;
  $('#setup').hidden = st !== 'setup';
  $('#review').hidden = st !== 'review';
  $('#saving').hidden = st !== 'saving';
  $('#hint').hidden = st !== 'ready';
  $('#rec-dot').hidden = st !== 'recording';
  if (st !== 'editor') $('#editor').hidden = true;
  if (st === 'ready') updateHint();
}

// ── Script ──────────────────────────────────────────────────
function applyScript(text) {
  S.text = text;
  S.parsed = parseScript(text, S.aliasMap);
  S.color = speakerColors(S.parsed);
  S.matcher = createMatcher(S.parsed.tokens);
  S.display = 0;
  prompter.render(S.parsed);
  updateHint();
}

function onExternalScript(text) {
  if (text === S.text) return;
  if (editor.isOpen) editor.external(text);
  if (['countdown', 'recording', 'saving'].includes(S.state)) { S.pendingScript = text; return; }
  applyScript(text);
  if (!editor.isOpen) toast('script.md 改过了，提词已更新');
}

async function saveScript(text) {
  const r = await fetch('/api/script', { method: 'PUT', body: text, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  if (!r.ok) throw new Error(`服务器返回 ${r.status}`);
  applyScript(text);
}

function updateHint() {
  if (!S.parsed) return;
  const { total } = estimate(S.parsed, S.stats.wpm);
  const text = `预计 ${fmtSec(total)} / ${fmtSec(TARGET_SEC)}`;
  for (const [sel, prefix] of [['#hint-est', ''], ['#setup-est', '稿子']]) {
    const est = $(sel);
    est.textContent = prefix + text;
    est.classList.toggle('over', total > TARGET_SEC);
  }
}

// ── Position ────────────────────────────────────────────────
const wpmOf = (speaker) => S.stats.wpm?.[speaker] || DEFAULT_WPM;

function blockAt(p) {
  const P = S.parsed;
  if (!P.tokens.length) return null;
  return P.blocks[P.tokens[Math.min(Math.floor(p), P.tokens.length - 1)].block];
}

function updateCue() {
  const P = S.parsed;
  if (!P.tokens.length || S.display >= P.tokens.length) return prompter.setCue(null);
  const ti = Math.floor(S.display);
  const b = P.blocks[P.tokens[ti].block];
  const nb = P.blocks.slice(b.index + 1).find((x) => x.tokEnd > x.tokStart);
  if (!nb || nb.speaker === b.speaker) return prompter.setCue(null);
  const lastPara = P.paras[b.paras[b.paras.length - 1]];
  if (ti >= lastPara.tokStart) prompter.setCue(`${nb.speaker} →`, S.color(nb.speaker));
  else prompter.setCue(null);
}

function stepPhrase(dir) {
  const ps = S.parsed.phraseStarts;
  const n = S.parsed.tokens.length;
  const cur = S.matcher.cursor;
  let target;
  if (dir > 0) target = ps.find((p) => p > cur) ?? n;
  else {
    let k = -1;
    for (let i = 0; i < ps.length; i++) if (ps[i] <= cur) k = i;
    target = k >= 0 && ps[k] < cur ? ps[k] : (ps[Math.max(0, k - 1)] ?? 0);
  }
  S.matcher.set(target, Math.round(performance.now() - S.t0));
  S.display = target;
  S.lastAdvance = performance.now();
  S.inertiaUsed = 0;
}

// ── Recognition ─────────────────────────────────────────────
function onSpeech(ev) {
  if (S.state === 'setup') { S.testCur = ev.texts[0]; renderTest(); return; }
  if (S.state !== 'recording') return;
  const now = performance.now();
  const rel = Math.round(now - S.t0);
  const tails = ev.texts.map((tx) => normalizeText(tx.split(/\s+/).slice(-24).join(' '), S.aliasMap).slice(-8));
  // tail = the words used for alignment at this moment, for replay debugging; text is only the last result segment (Chrome's earlier non-final segments are not visible here)
  S.events.push({ t: rel, text: ev.latest, tail: tails[0].join(' '), final: ev.isFinal });
  const far = now - S.lastAdvance > FAR_AFTER;
  if (S.matcher.update(tails, rel, { wide: now < S.wideUntil, far })) {
    S.lastAdvance = now;
    S.inertiaUsed = 0;
  }
  if (rel >= MIN_TAKE && tails.some((t) => endHeard(S.parsed, S.matcher.cursor, t))) {
    S.matcher.jump(S.parsed.tokens.length, rel);
    S.lastAdvance = now;
    scheduleStop();
  }
}

function onSpeechRestart() {
  if (S.state === 'setup') {
    S.testDone = `${S.testDone} ${S.testCur}`.trim();
    S.testCur = '';
    return;
  }
  S.restarts++;
  S.wideUntil = performance.now() + 3000;
}

const STATUS = {
  listening: '正在听',
  stopped: '已停',
  network: '识别连不上网',
  denied: '麦克风或识别被拒绝',
  'no-mic': '没有麦克风',
  unsupported: '这个浏览器没有语音识别，请用 Chrome',
};
function onSpeechStatus(s) {
  $('#sr-status').textContent = STATUS[s] || s;
  if (S.state === 'recording' && (s === 'network' || s === 'denied')) toast(`${STATUS[s]}，现在只能用滚轮`);
}

// ── Record a take ───────────────────────────────────────────
function enterFullscreen() {
  if (S.sim || document.fullscreenElement) return;
  document.documentElement.requestFullscreen?.().catch(() => {});
}

function showCount(n) {
  const c = $('#count');
  c.hidden = n == null;
  if (n != null) c.textContent = String(n);
}

async function startCountdown() {
  if (!['ready', 'review'].includes(S.state)) return;
  if (!S.sim && !S.stream) { setState('setup'); toast('先打开摄像头和麦克风'); return; }
  if (S.pendingScript) { applyScript(S.pendingScript); S.pendingScript = null; }
  enterFullscreen();
  S.matcher.reset();
  S.display = 0;
  S.events = [];
  S.restarts = 0;
  S.inertiaUsed = 0;
  S.takeParsed = S.parsed;
  S.takeText = S.text;
  prompter.snap = true;
  setState('countdown');
  if (!S.sim) { S.speech.lang = S.settings.lang; S.speech.start(); }
  const token = {};
  S.countToken = token;
  for (const n of [3, 2, 1]) {
    showCount(n);
    await sleep(1000);
    if (S.countToken !== token || S.state !== 'countdown') return;
  }
  showCount(null);
  if (!S.sim) {
    S.rec = new TakeRecorder(S.stream);
    try {
      await S.rec.start();
    } catch (e) {
      toast(`没开始录：${e.message}`);
      S.speech.stop();
      S.rec = null;
      setState('ready');
      return;
    }
    S.speech.markBase();
  }
  S.t0 = performance.now();
  S.lastAdvance = S.t0;
  S.simLastSpeak = S.t0;
  S.wideUntil = 0;
  S.startedAt = new Date().toISOString();
  setState('recording');
  if (S.sim) runSim();
}

function cancelCountdown() {
  S.countToken = null;
  showCount(null);
  S.speech?.stop();
  setState('ready');
}

function scheduleStop() {
  if (S.stopTimer) return;
  S.stopTimer = setTimeout(() => { S.stopTimer = null; stopTake('auto'); }, END_HOLD);
}

function quietFor(now, speaking) {
  if (S.sim) return speaking ? 0 : now - S.simLastSpeak;
  return S.vad ? S.vad.quietFor(now) : 0;
}

function checkEnd(now, speaking) {
  const n = S.parsed.tokens.length;
  const cur = S.matcher.cursor;
  if (now - S.t0 < MIN_TAKE || S.stopTimer) return;
  if (cur >= n) scheduleStop();
  // Quiet only counts when both the volume check and recognition are quiet: with a badly calibrated noise floor the volume check may always say "not speaking"
  else if (cur >= n - 3 && Math.min(quietFor(now, speaking), now - S.lastAdvance) >= END_QUIET) stopTake('auto');
}

function buildMeta(endedBy, durationMs) {
  const P = S.takeParsed;
  const m = S.matcher;
  const missed = [];
  const manual = [];
  for (let k = 0; k < m.cursor; k++) {
    if (m.matched[k]) continue;
    if (m.manual[k]) manual.push(k);
    else if (!P.tokens[k].optional) missed.push(k);
  }
  return {
    startedAt: S.startedAt,
    durationMs,
    endedBy,
    lang: S.settings.lang,
    scriptHash: P.hash,
    scriptSnapshot: S.takeText,
    cursor: m.cursor,
    tokenCount: P.tokens.length,
    missed,
    missedWords: missed.map((k) => P.tokens[k].t),
    manual,
    tokenTimes: m.times.map((t) => (t == null ? null : Math.round(t))),
    recognitionRestarts: S.restarts,
    transcriptEvents: S.events,
    wpm: measureWpm(P, m.times),
  };
}

async function stopTake(endedBy) {
  if (S.state !== 'recording') return;
  clearTimeout(S.stopTimer);
  S.stopTimer = null;
  S.hold = null;
  const durationMs = Math.round(performance.now() - S.t0);
  S.speech?.stop();
  S.simTimers.forEach(clearTimeout);
  S.simTimers = [];
  const meta = buildMeta(endedBy, durationMs);
  const discarded = endedBy === 'discard';
  const rec = S.rec;
  S.rec = null;
  const saving = rec
    ? rec.stop().then(() => rec.finish(meta, discarded))
    : Promise.resolve({ file: '模拟，没存盘', stats: null });
  if (discarded) {
    saving
      .then((r) => { if (r.stats) S.stats = r.stats; toast(`作废的这条存为 ${r.file}`); })
      .catch((e) => toast(`作废的这条没存上：${e.message}`));
    setState('ready');
    startCountdown();
    return;
  }
  setState('saving');
  let res = null;
  let err = null;
  try {
    res = await saving;
    if (res.stats) S.stats = res.stats;
  } catch (e) {
    err = e;
  }
  showReview(meta, res, err);
}

// The server's finish note codes → review text (a later phase moves all UI text to the i18n table)
const NOTES = {
  E_NO_FFMPEG: () => 'ffmpeg 没转成，留的是浏览器原文件（没找到 ffmpeg）',
  E_FFMPEG_FAILED: (detail) => `ffmpeg 没转成，留的是浏览器原文件${detail ? `（${detail}）` : ''}`,
  E_GONE: () => '服务器上已没有这条的录像文件',
};

function showReview(meta, res, err) {
  const P = S.takeParsed;
  // Discarding never opens the review (it restarts the countdown), so only these two can end here
  const ended = { auto: '自动停', manual: '手动停' }[meta.endedBy];
  const bits = [res?.file ?? '没存上', fmtSec(meta.durationMs / 1000), ended, `没对上 ${meta.missed.length} 个词`];
  if (meta.manual.length) bits.push(`滚轮跳过 ${meta.manual.length} 个`);
  if (err) bits.push(`保存出错：${err.message}`);
  if (res?.note) bits.push(NOTES[res.note]?.(res.noteDetail) ?? res.note);
  if (res?.uploadFailed) bits.push('上传断过，已另存一份到下载文件夹');
  $('#rv-sum').textContent = bits.join(' · ');

  const missed = new Set(meta.missed);
  const manual = new Set(meta.manual);
  const body = $('#rv-body');
  body.textContent = '';
  const color = speakerColors(P);
  for (const b of P.blocks) {
    const sec = document.createElement('section');
    sec.className = 'rv-block';
    sec.style.setProperty('--spk', color(b.speaker));
    const who = document.createElement('div');
    who.className = 'rv-who';
    who.textContent = b.speaker + (b.title ? ` · ${b.title}` : '');
    sec.append(who);
    for (const pi of b.paras) {
      const p = P.paras[pi];
      const pe = document.createElement('p');
      for (let w = p.wordStart; w < p.wordEnd; w++) {
        const word = P.words[w];
        const s = document.createElement('span');
        s.textContent = word.text;
        if (word.tokFirst !== undefined) {
          const ks = [];
          for (let k = word.tokFirst; k < word.readAt; k++) ks.push(k);
          if (ks.some((k) => k >= meta.cursor)) s.className = 'unreached';
          else if (ks.some((k) => missed.has(k))) s.className = 'missed';
          else if (ks.some((k) => manual.has(k))) s.className = 'skip';
        }
        pe.append(s, ' ');
      }
      sec.append(pe);
    }
    body.append(sec);
  }
  setState('review');
  if (S.pendingScript) { applyScript(S.pendingScript); S.pendingScript = null; }
}

// ── Simulation mode (?sim=run1.json): no mic, no recording; recognition events are fed in on their timestamps ──
function runSim() {
  for (const ev of S.sim.events) {
    S.simTimers.push(setTimeout(() => {
      if (S.state !== 'recording') return;
      if (ev.restart) onSpeechRestart();
      else onSpeech({ texts: [ev.text], latest: ev.text.split(' ').slice(-4).join(' '), isFinal: !!ev.final });
    }, ev.t));
  }
}

function simSpeaking(now) {
  const rel = now - S.t0;
  return S.sim.speech.some(([a, b]) => rel >= a && rel <= b);
}

// ── Every frame ─────────────────────────────────────────────
let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  S.vad?.poll(now);
  if (S.state === 'setup') drawMeter();
  if (S.matcher) {
    const cur = S.matcher.cursor;
    if (S.state === 'recording') {
      const speaking = S.sim ? simSpeaking(now) : !!S.vad?.speaking;
      if (speaking) S.simLastSpeak = now;
      const stalled = now - S.lastAdvance > INERTIA_AFTER;
      if (speaking && stalled && S.inertiaUsed < INERTIA_MAX) {
        const rate = wpmOf(blockAt(S.display)?.speaker) / 60;
        S.display = Math.min(Math.max(S.display, cur) + rate * dt, cur + INERTIA_LEAD, S.parsed.tokens.length);
        S.inertiaUsed += dt * 1000;
        S.wideUntil = Math.max(S.wideUntil, now + 1500);
      } else if (!stalled || S.display < cur) {
        // Recognition is back: trust it (step back if inertia overshot)
        S.display = cur;
      }
      checkEnd(now, speaking);
    } else {
      S.display = cur;
    }
    prompter.update(S.display);
    updateCue();
  }
  prompter.tick(dt);
  drawHold(now);
  requestAnimationFrame(frame);
}

function drawHold(now) {
  const ring = $('#hold');
  if (!S.hold) { ring.hidden = true; return; }
  const p = Math.min(1, (now - S.hold.start) / HOLD_MS);
  ring.hidden = false;
  ring.dataset.kind = S.hold.kind;
  ring.querySelector('.fg').style.strokeDashoffset = String(RING * (1 - p));
  if (p >= 1) {
    const { kind } = S.hold;
    S.hold = null;
    stopTake(kind === 'stop' ? 'manual' : 'discard');
  }
}

// ── Sound check ─────────────────────────────────────────────
async function openMedia() {
  S.stream?.getTracks().forEach((t) => t.stop());
  S.stream = null;
  let stream;
  try {
    stream = await openStream({ camId: S.settings.camId, micId: S.settings.micId });
  } catch (e) {
    if (S.settings.camId || S.settings.micId) {
      S.settings.camId = '';
      S.settings.micId = '';
      saveSettings();
      return openMedia();
    }
    $('#media-info').textContent = `打不开摄像头或麦克风：${e.message}`;
    return;
  }
  S.stream = stream;
  $('#pv').srcObject = stream;
  if (S.vad) S.vad.setStream(stream);
  else S.vad = new Vad(stream, S.settings.noiseFloor);
  S.vad.resume();
  const v = stream.getVideoTracks()[0]?.getSettings() || {};
  const mime = pickMime();
  $('#media-info').textContent = `画面 ${v.width}×${v.height} @${Math.round(v.frameRate || 0)}fps · 录制格式 ${mime || '这个浏览器不能录'}`;
  $('#open-media').textContent = '重新打开摄像头和麦克风';
  const devs = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind, track) => {
    sel.textContent = '';
    for (const d of devs.filter((x) => x.kind === kind)) sel.append(new Option(d.label || kind, d.deviceId));
    const id = track?.getSettings().deviceId;
    if (id) sel.value = id;
  };
  fill($('#cam'), 'videoinput', stream.getVideoTracks()[0]);
  fill($('#mic'), 'audioinput', stream.getAudioTracks()[0]);
}

function drawMeter() {
  if (!S.vad) return;
  const pct = (db) => Math.max(0, Math.min(100, ((db + 80) / 80) * 100));
  const bar = $('#meter-bar');
  bar.style.width = `${pct(S.vad.db)}%`;
  bar.classList.toggle('on', S.vad.speaking);
  $('#meter-th').style.left = `${pct(S.vad.threshold)}%`;
}

function renderTest() {
  const all = `${S.testDone} ${S.testCur}`.trim();
  $('#sr-text').textContent = all || '（还没听到）';
  const heard = normalizeText(all, S.aliasMap);
  const P = S.parsed;
  const list = $('#sr-check');
  list.textContent = '';
  for (const spk of P.speakers) {
    const b = P.blocks.find((x) => x.speaker === spk && x.tokEnd > x.tokStart);
    if (!b) continue;
    const p = b.paras.map((i) => P.paras[i]).find((x) => x.tokEnd > x.tokStart);
    const toks = P.tokens.slice(p.tokStart, p.tokEnd).filter((t) => !t.optional);
    const hit = toks.filter((t) => heard.some((h) => similarity(h, t.t) > 0)).length;
    const li = document.createElement('li');
    li.className = hit / toks.length >= 0.8 ? 'ok' : '';
    li.style.setProperty('--spk', S.color(spk));
    const sentence = P.words.slice(p.wordStart, p.wordEnd).map((w) => w.text).join(' ');
    li.innerHTML = '<b></b> <span class="s"></span> <span class="n"></span>';
    li.querySelector('b').textContent = spk;
    li.querySelector('.s').textContent = `「${sentence}」`;
    li.querySelector('.n').textContent = `对上 ${hit}/${toks.length}`;
    list.append(li);
  }
}

function setFont(px) {
  const v = Math.max(36, Math.min(80, Math.round(px)));
  S.settings.fontSize = v;
  saveSettings();
  prompter.setFontSize(v);
  $('#fs').value = String(v);
  $('#fs-val').textContent = `${v}px`;
}

function stopTest() {
  if (!S.testing) return;
  S.testing = false;
  S.speech.stop();
  $('#sr-test').textContent = '开始测试识别';
}

// ── Bindings ────────────────────────────────────────────────
const isUi = (t) => !!t.closest?.('button, a, input, select, textarea, label');

function bindUi() {
  $('#open-media').addEventListener('click', openMedia);
  $('#cam').addEventListener('change', () => { S.settings.camId = $('#cam').value; saveSettings(); openMedia(); });
  $('#mic').addEventListener('change', () => { S.settings.micId = $('#mic').value; saveSettings(); openMedia(); });
  $('#calib').addEventListener('click', async () => {
    if (!S.vad) { toast('先打开麦克风'); return; }
    const btn = $('#calib');
    btn.disabled = true;
    $('#floor').textContent = '请保持安静 3 秒…';
    const f = await S.vad.calibrate(3000);
    S.settings.noiseFloor = f;
    saveSettings();
    $('#floor').textContent = `底噪 ${f} dB，说话阈值 ${(f + 10).toFixed(1)} dB`;
    btn.disabled = false;
  });
  $('#lang').value = S.settings.lang;
  $('#lang').addEventListener('change', () => {
    S.settings.lang = $('#lang').value;
    saveSettings();
    S.speech.lang = S.settings.lang;
    if (S.testing) { S.speech.stop(); S.speech.start(); }
  });
  $('#sr-test').addEventListener('click', () => {
    if (S.testing) { stopTest(); return; }
    S.testing = true;
    S.testDone = '';
    S.testCur = '';
    renderTest();
    S.speech.lang = S.settings.lang;
    S.speech.start();
    $('#sr-test').textContent = '停止测试';
  });
  $('#fs').addEventListener('input', () => setFont(Number($('#fs').value)));
  $('#setup-done').addEventListener('click', () => {
    if (!S.stream) { toast('先打开摄像头和麦克风'); return; }
    stopTest();
    setState('ready');
  });
  $('#setup-edit').addEventListener('click', openEditor);
  $('#hint').addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'edit') openEditor();
    if (act === 'setup') setState('setup');
  });
  $('#rv-open').addEventListener('click', () => fetch('/api/takes/open', { method: 'POST' }));
  $('#rv-setup').addEventListener('click', () => setState('setup'));
  $('#rv-back').addEventListener('click', () => setState('ready'));

  window.addEventListener('contextmenu', (e) => {
    if (!['setup', 'editor'].includes(S.state)) e.preventDefault();
  });
  window.addEventListener('pointerdown', (e) => {
    S.vad?.resume();
    if (S.state === 'recording') {
      if (e.button === 0) S.hold = { kind: 'stop', start: performance.now() };
      else if (e.button === 2) S.hold = { kind: 'discard', start: performance.now() };
      return;
    }
    if (S.state === 'countdown' && e.button === 2) { cancelCountdown(); return; }
    S.clickArmed = e.button === 0 && !isUi(e.target) && ['ready', 'review'].includes(S.state);
  });
  window.addEventListener('pointerup', (e) => {
    S.hold = null;
    if (!S.clickArmed || e.button !== 0) return;
    S.clickArmed = false;
    if (S.state === 'ready') startCountdown();
    else if (S.state === 'review') setState('ready');
  });
  window.addEventListener('wheel', (e) => {
    if (!['ready', 'recording'].includes(S.state)) return;
    e.preventDefault();
    S.wheelAcc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
    const now = performance.now();
    if (Math.abs(S.wheelAcc) < WHEEL_STEP || now - S.wheelAt < WHEEL_COOLDOWN) return;
    const dir = Math.sign(S.wheelAcc);
    S.wheelAcc = 0;
    S.wheelAt = now;
    stepPhrase(dir);
  }, { passive: false });
  window.addEventListener('keydown', onKey);
  // With unsaved script edits, ask before closing / reloading the page (the draft is also kept in localStorage)
  window.addEventListener('beforeunload', (e) => {
    if (editor.isOpen && editor.dirty) e.preventDefault();
  });
  window.addEventListener('resize', () => { prompter.layout(); prompter.snap = true; });

  const es = new EventSource('/api/events');
  es.addEventListener('script', (e) => {
    try { onExternalScript(JSON.parse(e.data).text); } catch { /* ignore malformed messages */ }
  });
}

function openEditor() {
  if (!['ready', 'review', 'setup'].includes(S.state)) return;
  // Opened from setup → return to setup; opened from review → return to ready (the review shows the old script)
  S.editorFrom = S.state === 'setup' ? 'setup' : 'ready';
  stopTest();
  setState('editor');
  editor.open(S.text);
}

function closeEditor() {
  setState(S.editorFrom || 'ready');
  // Re-run the setup page's "read each speaker's first line" check against the new script
  if (S.state === 'setup') renderTest();
}

function onKey(e) {
  if (S.state === 'editor') {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); editor.save(); }
    else if (e.key === 'Escape') { e.preventDefault(); editor.close(); }
    return;
  }
  if (e.target.closest?.('input, textarea, select')) return;
  const k = e.key;
  const live = ['ready', 'recording'].includes(S.state);
  if (k === ' ') {
    e.preventDefault();
    if (S.state === 'recording') stopTake('manual');
    else startCountdown();
  } else if (['ArrowRight', 'ArrowDown', 'PageDown'].includes(k)) {
    e.preventDefault();
    if (live) stepPhrase(1);
  } else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(k)) {
    e.preventDefault();
    if (live) stepPhrase(-1);
  } else if (k === 'x' || k === 'X' || k === 'Escape') {
    if (S.state === 'recording') stopTake('discard');
    else if (S.state === 'countdown') cancelCountdown();
  } else if (k === 'e' || k === 'E') openEditor();
  else if (k === 'm' || k === 'M') { if (['ready', 'review'].includes(S.state)) setState('setup'); }
  else if (k === '+' || k === '=') setFont(S.settings.fontSize + 2);
  else if (k === '-' || k === '_') setFont(S.settings.fontSize - 2);
  else if (k === 'f' || k === 'F') {
    if (document.fullscreenElement) document.exitFullscreen();
    else enterFullscreen();
  }
}

async function boot() {
  prompter = new Prompter($('#stage'));
  const [aliases, text, stats] = await Promise.all([
    fetch('/aliases.json').then((r) => r.json()),
    fetch('/api/script').then((r) => r.text()),
    fetch('/api/stats').then((r) => r.json()),
  ]);
  S.aliasMap = buildAliasMap(aliases);
  S.stats = stats;
  editor = new Editor({
    root: $('#editor'),
    aliasMap: S.aliasMap,
    getStats: () => S.stats,
    onSave: saveScript,
    onClose: closeEditor,
    toast,
  });
  setFont(S.settings.fontSize);
  applyScript(text);
  S.speech = new Speech({ lang: S.settings.lang, onResult: onSpeech, onStatus: onSpeechStatus, onRestart: onSpeechRestart });
  bindUi();

  const sim = new URLSearchParams(location.search).get('sim');
  if (sim) {
    S.sim = await fetch(`/fixtures/${encodeURIComponent(sim)}`).then((r) => r.json());
    $('#hint-sim').textContent = ' · 模拟模式：不开麦、不录像';
    setState('ready');
  } else {
    setState('setup');
    if (!speechSupported) $('#sr-status').textContent = STATUS.unsupported;
    // Camera was allowed before: open it right away
    try {
      const cam = await navigator.permissions.query({ name: 'camera' });
      if (cam.state === 'granted') openMedia();
    } catch { /* some browsers do not support this query */ }
  }
  requestAnimationFrame(frame);
}

boot();
