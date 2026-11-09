// Controller: state machine + mouse / keyboard, wiring recognition, alignment, display and recording together.
//   setup (sound check) → ready → countdown → recording → saving → review → ready
// Mouse while recording: left click does nothing (guards against stray clicks), wheel moves one phrase back or forward, hold left 1 s to stop and save, hold right 1 s to discard and restart the countdown at once.
// Every mouse and keyboard control is an entry in shortcuts.js; the handlers below look the entry up and call ACTIONS[entry.action].
// All text comes from i18n.js.

import { buildAliasMap, normalizeText, similarity } from './normalize.js';
import { parseScript } from './parse.js';
import { createMatcher, endHeard } from './matcher.js';
import { Speech, speechSupported } from './speech.js';
import { Vad } from './vad.js';
import { openStream, pickMime, TakeRecorder } from './recorder.js';
import { Prompter, speakerColors } from './prompter.js';
import { Editor } from './editor.js';
import { estimate, measureWpm, fmtSec, DEFAULT_WPM } from './estimate.js';
import { t, bind, unbind, codeText, hasKey, applyDom, getLang, setLang, htmlLang } from './i18n.js';
import { BUTTONS, matchKey, matchPointerDown, matchClick, matchWheel, menuBlocked } from './shortcuts.js';

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  lastReview: null,
};
let prompter;
let editor;

function saveSettings() {
  try { localStorage.setItem('tp.settings', JSON.stringify(S.settings)); } catch { /* private mode */ }
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  if (!el.hidden && el.textContent === msg) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
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
  if (!editor.isOpen) toast(t('toast.scriptChanged'));
}

/** The error a failed API answer stands for: its server code when known, else the status. */
async function apiError(r) {
  const code = await r.json().then((j) => j?.error).catch(() => null);
  return new Error(code && hasKey(`err.${code}`) ? codeText(code) : t('err.server', { status: r.status }));
}

async function saveScript(text) {
  const r = await fetch('/api/script', { method: 'PUT', body: text, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  if (!r.ok) throw await apiError(r);
  applyScript(text);
}

function updateHint() {
  if (!S.parsed) return;
  const { total } = estimate(S.parsed, S.stats.wpm);
  const target = S.parsed.targetSec;
  const vars = { time: fmtSec(total), target: target ? fmtSec(target) : '' };
  for (const [sel, key] of [['#hint-est', 'est.total'], ['#setup-est', 'est.script']]) {
    const est = $(sel);
    est.textContent = t(target ? `${key}Target` : key, vars);
    est.classList.toggle('over', !!target && total > target);
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

// Recognition status → i18n key
const STATUS = {
  listening: 'sr.listening',
  stopped: 'sr.stopped',
  network: 'sr.network',
  denied: 'sr.denied',
  'no-mic': 'sr.noMic',
  unsupported: 'sr.unsupported',
};
function onSpeechStatus(s) {
  const el = $('#sr-status');
  if (STATUS[s]) bind(el, STATUS[s]);
  else unbind(el, s);
  if (S.state === 'recording' && (s === 'network' || s === 'denied')) toast(t(s === 'network' ? 'toast.networkWheel' : 'toast.deniedWheel'));
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
  if (!S.sim && !S.stream) { setState('setup'); toast(t('toast.openMediaFirst')); return; }
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
      toast(t('toast.recNotStarted', { msg: e.message }));
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
    : Promise.resolve({ file: null, sim: true, stats: null });
  if (discarded) {
    saving
      .then((r) => { if (r.stats) S.stats = r.stats; toast(t('toast.discardSaved', { file: r.sim ? t('rv.simFile') : r.file })); })
      .catch((e) => toast(t('toast.discardNotSaved', { msg: e.message })));
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

function renderReviewSum() {
  const { meta, res, err } = S.lastReview;
  // Discarding never opens the review (it restarts the countdown), so only these two can end here
  const ended = { auto: t('rv.auto'), manual: t('rv.manual') }[meta.endedBy];
  const file = res?.sim ? t('rv.simFile') : res?.file ?? t('rv.notSaved');
  const bits = [file, fmtSec(meta.durationMs / 1000), ended, t('rv.missed', { n: meta.missed.length })];
  if (meta.manual.length) bits.push(t('rv.skipped', { n: meta.manual.length }));
  if (err) bits.push(t('rv.saveError', { msg: err.message }));
  // The server's finish note codes (E_NO_FFMPEG, E_FFMPEG_FAILED, E_GONE) → text
  if (res?.note) bits.push(codeText(res.note, res.noteDetail));
  if (res?.uploadFailed) bits.push(t('rv.uploadFailed'));
  $('#rv-sum').textContent = bits.join(' · ');
}

function showReview(meta, res, err) {
  const P = S.takeParsed;
  S.lastReview = { meta, res, err };
  renderReviewSum();

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
  const p = Math.min(1, (now - S.hold.start) / S.hold.ms);
  ring.hidden = false;
  ring.dataset.kind = S.hold.kind;
  ring.querySelector('.fg').style.strokeDashoffset = String(RING * (1 - p));
  if (p >= 1) {
    const { kind } = S.hold;
    S.hold = null;
    ACTIONS[kind]();
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
    bind($('#media-info'), 'media.error', { msg: e.message });
    return;
  }
  S.stream = stream;
  $('#pv').srcObject = stream;
  if (S.vad) S.vad.setStream(stream);
  else S.vad = new Vad(stream, S.settings.noiseFloor);
  S.vad.resume();
  const v = stream.getVideoTracks()[0]?.getSettings() || {};
  const mime = pickMime();
  bind($('#media-info'), 'media.info', { w: v.width, h: v.height, fps: Math.round(v.frameRate || 0), mime: mime || { key: 'media.noRecorder' } });
  bind($('#open-media'), 'setup.reopenMedia');
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
  if (all) unbind($('#sr-text'), all);
  else bind($('#sr-text'), 'sr.nothing');
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
    li.querySelector('.s').textContent = t('sr.quote', { text: sentence });
    li.querySelector('.n').textContent = t('sr.matched', { n: hit, m: toks.length });
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
  bind($('#sr-test'), 'sr.test');
}

// ── Language ────────────────────────────────────────────────
function renderLangToggle() {
  for (const b of document.querySelectorAll('#ui-lang button')) b.setAttribute('aria-pressed', String(b.dataset.lang === getLang()));
}

// Static text and bind()-ed elements re-translate in applyDom; text built here from several parts is rebuilt
function onLangChange() {
  S.settings.uiLang = getLang(); // setLang saved it; keep saveSettings from writing the old value back
  renderLangToggle();
  updateHint();
  if ($('#sr-check').childElementCount) renderTest();
  if (S.lastReview) renderReviewSum();
  editor?.relang();
}

// ── Actions (what each entry in shortcuts.js does) ──────────
const ACTIONS = {
  start: () => startCountdown(),
  stop: () => stopTake('manual'),
  discard: () => stopTake('discard'),
  cancel: () => cancelCountdown(),
  toReady: () => setState('ready'),
  next: () => stepPhrase(1),
  prev: () => stepPhrase(-1),
  step: (dir) => stepPhrase(dir),
  editor: () => openEditor(),
  setup: () => setState('setup'),
  fontUp: () => setFont(S.settings.fontSize + 2),
  fontDown: () => setFont(S.settings.fontSize - 2),
  fullscreen: () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else enterFullscreen();
  },
  save: () => editor.save(),
  close: () => editor.close(),
};

// ── Bindings ────────────────────────────────────────────────
const isUi = (el) => !!el.closest?.('button, a, input, select, textarea, label');

function bindUi() {
  $('#open-media').addEventListener('click', openMedia);
  $('#cam').addEventListener('change', () => { S.settings.camId = $('#cam').value; saveSettings(); openMedia(); });
  $('#mic').addEventListener('change', () => { S.settings.micId = $('#mic').value; saveSettings(); openMedia(); });
  $('#calib').addEventListener('click', async () => {
    if (!S.vad) { toast(t('toast.openMicFirst')); return; }
    const btn = $('#calib');
    btn.disabled = true;
    bind($('#floor'), 'setup.calibrating');
    const f = await S.vad.calibrate(3000);
    S.settings.noiseFloor = f;
    saveSettings();
    bind($('#floor'), 'setup.floor', { floor: f, th: (f + 10).toFixed(1) });
    btn.disabled = false;
  });
  $('#ui-lang').addEventListener('click', (e) => {
    const lang = e.target.closest('button')?.dataset.lang;
    if (lang && lang !== getLang()) setLang(lang);
  });
  document.addEventListener('langchange', onLangChange);
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
    bind($('#sr-test'), 'sr.stopTest');
  });
  $('#fs').addEventListener('input', () => setFont(Number($('#fs').value)));
  $('#setup-done').addEventListener('click', () => {
    if (!S.stream) { toast(t('toast.openMediaFirst')); return; }
    stopTest();
    setState('ready');
  });
  $('#setup-edit').addEventListener('click', openEditor);
  $('#hint').addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'edit') openEditor();
    if (act === 'setup') setState('setup');
  });
  $('#rv-open').addEventListener('click', async () => {
    try {
      const r = await fetch('/api/takes/open', { method: 'POST' });
      if (!r.ok) toast((await apiError(r)).message);
    } catch (e) {
      toast(e.message);
    }
  });
  $('#rv-setup').addEventListener('click', () => setState('setup'));
  $('#rv-back').addEventListener('click', () => setState('ready'));

  // Mouse and keyboard: look up the entry in shortcuts.js, run its action
  window.addEventListener('contextmenu', (e) => {
    if (menuBlocked(S.state)) e.preventDefault();
  });
  window.addEventListener('pointerdown', (e) => {
    S.vad?.resume();
    const m = matchPointerDown(S.state, e.button, isUi(e.target));
    if (m.hold) S.hold = { kind: m.hold.action, ms: m.hold.hold, start: performance.now() };
    else if (m.press) ACTIONS[m.press.action]();
    else if ('arm' in m) S.clickArmed = m.arm;
  });
  window.addEventListener('pointerup', (e) => {
    S.hold = null;
    // A click: pressed on empty space and released with the same button
    if (!S.clickArmed || S.clickArmed !== BUTTONS[e.button]) return;
    S.clickArmed = false;
    const hit = matchClick(S.state, e.button);
    if (hit) ACTIONS[hit.action]();
  });
  window.addEventListener('wheel', (e) => {
    const hit = matchWheel(S.state);
    if (!hit) return;
    if (hit.prevent) e.preventDefault();
    S.wheelAcc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
    const now = performance.now();
    if (Math.abs(S.wheelAcc) < WHEEL_STEP || now - S.wheelAt < WHEEL_COOLDOWN) return;
    const dir = Math.sign(S.wheelAcc);
    S.wheelAcc = 0;
    S.wheelAt = now;
    ACTIONS[hit.action](dir);
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
  const { hit, prevent } = matchKey(S.state, {
    key: e.key,
    ctrl: e.ctrlKey || e.metaKey,
    inField: !!e.target.closest?.('input, textarea, select'),
  });
  if (prevent) e.preventDefault();
  if (hit) ACTIONS[hit.action]();
}

async function boot() {
  document.documentElement.lang = htmlLang();
  applyDom();
  renderLangToggle();
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
    bind($('#hint-sim'), 'hint.sim');
    setState('ready');
  } else {
    setState('setup');
    if (!speechSupported) bind($('#sr-status'), STATUS.unsupported);
    // Camera was allowed before: open it right away
    try {
      const cam = await navigator.permissions.query({ name: 'camera' });
      if (cam.state === 'granted') openMedia();
    } catch { /* some browsers do not support this query */ }
  }
  requestAnimationFrame(frame);
}

boot();
