// public/shortcuts.js drives app.js's mouse and keyboard handling. These tests pin it to the behaviour the handlers
// had before the table existed: the reference functions below are those old handlers, reduced to "what happens".
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  SHORTCUTS, STATES, BUTTONS, describeShortcuts,
  matchKey, matchPointerDown, matchClick, matchWheel, menuBlocked,
} from '../public/shortcuts.js';

// ── The old handlers (app.js before the table), with each guard inside the called function folded in ──
function oldKey(state, { key, ctrl, inField }) {
  if (state === 'editor') {
    if (ctrl && key.toLowerCase() === 's') return { action: 'save', prevent: true };
    if (key === 'Escape') return { action: 'close', prevent: true };
    return { action: null, prevent: false };
  }
  if (inField) return { action: null, prevent: false };
  const k = key;
  const live = ['ready', 'recording'].includes(state);
  if (k === ' ') {
    // startCountdown() only runs from ready / review
    return { action: state === 'recording' ? 'stop' : ['ready', 'review'].includes(state) ? 'start' : null, prevent: true };
  }
  if (['ArrowRight', 'ArrowDown', 'PageDown'].includes(k)) return { action: live ? 'next' : null, prevent: true };
  if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(k)) return { action: live ? 'prev' : null, prevent: true };
  if (k === 'x' || k === 'X' || k === 'Escape') {
    return { action: state === 'recording' ? 'discard' : state === 'countdown' ? 'cancel' : null, prevent: false };
  }
  // openEditor() only runs from ready / review / setup.
  // The one deliberate change: E now blocks its default where it opens the editor (before, the "e" was typed into the script).
  if (k === 'e' || k === 'E') {
    const opens = ['ready', 'review', 'setup'].includes(state);
    return { action: opens ? 'editor' : null, prevent: opens };
  }
  if (k === 'm' || k === 'M') return { action: ['ready', 'review'].includes(state) ? 'setup' : null, prevent: false };
  if (k === '+' || k === '=') return { action: 'fontUp', prevent: false };
  if (k === '-' || k === '_') return { action: 'fontDown', prevent: false };
  if (k === 'f' || k === 'F') return { action: 'fullscreen', prevent: false };
  return { action: null, prevent: false };
}

// pointerdown → hold kind / press action / new clickArmed (undefined = left as it was)
function oldDown(state, button, onUi) {
  if (state === 'recording') {
    if (button === 0) return { hold: 'stop' };
    if (button === 2) return { hold: 'discard' };
    return {};
  }
  if (state === 'countdown' && button === 2) return { press: 'cancel' };
  return { arm: button === 0 && !onUi && ['ready', 'review'].includes(state) };
}

// pointerup with clickArmed → action, clickArmed after
function oldUp(state, button, armed) {
  if (!armed || button !== 0) return { action: null, armed };
  return { action: state === 'ready' ? 'start' : state === 'review' ? 'toReady' : null, armed: false };
}

// The same, through the table (what app.js's handlers do with the match results)
function newUp(state, button, armed) {
  const a = armed ? 'left' : false;
  if (!a || a !== BUTTONS[button]) return { action: null, armed };
  return { action: matchClick(state, button)?.action ?? null, armed: false };
}

const KEYS = [' ', 'ArrowRight', 'ArrowDown', 'PageDown', 'ArrowLeft', 'ArrowUp', 'PageUp', 'x', 'X', 'Escape', 'e', 'E', 'm', 'M',
  '+', '=', '-', '_', 'f', 'F', 's', 'S', 'a', 'q', 'Enter', 'Tab', 'Shift', 'Control', 'Backspace', '1', 'Home', 'End'];

describe('shortcuts table', () => {
  test('every keydown does what the old handler did', () => {
    for (const state of STATES) {
      for (const key of KEYS) {
        for (const ctrl of [false, true]) {
          for (const inField of [false, true]) {
            const m = matchKey(state, { key, ctrl, inField });
            assert.deepEqual({ action: m.hit?.action ?? null, prevent: m.prevent }, oldKey(state, { key, ctrl, inField }), `${state} ${JSON.stringify(key)} ctrl=${ctrl} field=${inField}`);
          }
        }
      }
    }
  });

  test('every mouse press and release does what the old handlers did', () => {
    for (const state of STATES) {
      for (const button of [0, 1, 2, 3, 4]) {
        for (const onUi of [false, true]) {
          const m = matchPointerDown(state, button, onUi);
          const got = {};
          if (m.hold) { got.hold = m.hold.action; assert.equal(m.hold.hold, 1000); }
          if (m.press) got.press = m.press.action;
          if ('arm' in m) got.arm = !!m.arm;
          assert.deepEqual(got, oldDown(state, button, onUi), `down ${state} button=${button} ui=${onUi}`);
        }
        for (const armed of [false, true]) assert.deepEqual(newUp(state, button, armed), oldUp(state, button, armed), `up ${state} button=${button} armed=${armed}`);
      }
      assert.equal(!!matchWheel(state), ['ready', 'recording'].includes(state), `wheel ${state}`);
      if (matchWheel(state)) assert.equal(matchWheel(state).prevent, true);
      assert.equal(menuBlocked(state), !['setup', 'editor'].includes(state), `context menu ${state}`);
    }
  });

  test('entries are well formed and every action exists in app.js', () => {
    const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    const block = /const ACTIONS = \{([\s\S]*?)\n\};/.exec(src);
    assert.ok(block, 'app.js has an ACTIONS map');
    const actions = new Set([...block[1].matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]));
    const ids = new Set();
    for (const s of SHORTCUTS) {
      assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
      ids.add(s.id);
      assert.ok(actions.has(s.action), `${s.id}: action ${s.action} is not in app.js ACTIONS`);
      assert.ok(!!s.key !== !!s.mouse, `${s.id}: needs key or mouse, not both`);
      assert.ok(s.states.length && s.states.every((x) => STATES.includes(x)), `${s.id}: states`);
    }
  });

  test('describeShortcuts gives one row per entry in both languages', () => {
    for (const lang of ['en', 'zh']) {
      const rows = describeShortcuts(lang);
      assert.equal(rows.length, SHORTCUTS.length);
      for (const r of rows) for (const f of ['input', 'when', 'action']) assert.ok(r[f] && !/^[a-z]+\.[a-zA-Z.]+$/.test(r[f]), `${lang} ${r.id} ${f}: ${r[f]}`);
    }
    const en = Object.fromEntries(describeShortcuts('en').map((r) => [r.id, r]));
    assert.equal(en['hold-stop'].input, 'Hold the left button 1 s');
    assert.equal(en['key-start'].input, 'Space');
    assert.equal(en['editor-save'].input, 'Ctrl+S');
    assert.equal(en['key-bigger'].when, 'Any time, except in the editor');
    assert.equal(describeShortcuts('zh').find((r) => r.id === 'key-start').input, '空格');
  });
});
