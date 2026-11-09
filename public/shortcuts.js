// Every mouse and keyboard control, one entry each. app.js dispatches from this table (find the entry for the
// current state and input, then call its action), and the README tables are generated from it (npm run docs:tables),
// so the docs cannot drift from the behaviour.
//
//   states    the screens where the entry works (app.js state names)
//   key       KeyboardEvent.key values; 'Space' stands for ' ', and an upper-case letter matches either case.
//             Other modifier keys are ignored, except mod: 'ctrl' = Ctrl or Cmd must be held.
//   mouse     'left' | 'right' | 'wheel'. A left entry is a click on empty space (not on a button, link, label or field),
//             fired on release; press: true fires on press instead; hold = ms the button must stay down (the ring fills).
//   inFields  also works while typing in a text field (other keys typed into an input, textarea or select are left alone)
//   prevent   blocks the browser default when the entry fires
//   action    name in app.js's action map; labelKey = i18n key of the description
import { tl } from './i18n.js';

export const STATES = ['boot', 'setup', 'ready', 'countdown', 'recording', 'saving', 'review', 'editor'];
const NOT_EDITOR = STATES.filter((s) => s !== 'editor');

export const SHORTCUTS = [
  // Mouse
  { id: 'click-start', states: ['ready'], mouse: 'left', action: 'start', labelKey: 'sc.start' },
  { id: 'click-back', states: ['review'], mouse: 'left', action: 'toReady', labelKey: 'sc.toReady' },
  { id: 'wheel-step', states: ['ready', 'recording'], mouse: 'wheel', prevent: true, action: 'step', labelKey: 'sc.step' },
  { id: 'hold-stop', states: ['recording'], mouse: 'left', hold: 1000, action: 'stop', labelKey: 'sc.stop' },
  { id: 'hold-discard', states: ['recording'], mouse: 'right', hold: 1000, action: 'discard', labelKey: 'sc.discard' },
  { id: 'right-cancel', states: ['countdown'], mouse: 'right', press: true, action: 'cancel', labelKey: 'sc.cancel' },

  // Keyboard
  { id: 'key-start', states: ['ready', 'review'], key: ['Space'], action: 'start', labelKey: 'sc.start' },
  { id: 'key-stop', states: ['recording'], key: ['Space'], action: 'stop', labelKey: 'sc.stop' },
  { id: 'key-discard', states: ['recording'], key: ['X', 'Escape'], action: 'discard', labelKey: 'sc.discard' },
  { id: 'key-cancel', states: ['countdown'], key: ['X', 'Escape'], action: 'cancel', labelKey: 'sc.cancel' },
  { id: 'key-next', states: ['ready', 'recording'], key: ['ArrowRight', 'ArrowDown', 'PageDown'], action: 'next', labelKey: 'sc.next' },
  { id: 'key-prev', states: ['ready', 'recording'], key: ['ArrowLeft', 'ArrowUp', 'PageUp'], action: 'prev', labelKey: 'sc.prev' },
  // prevent: the editor takes the focus during this keydown, so without it the "e" is typed into the script
  { id: 'key-editor', states: ['ready', 'review', 'setup'], key: ['E'], prevent: true, action: 'editor', labelKey: 'sc.editor' },
  { id: 'key-setup', states: ['ready', 'review'], key: ['M'], action: 'setup', labelKey: 'sc.setup' },
  { id: 'key-bigger', states: NOT_EDITOR, key: ['+', '='], action: 'fontUp', labelKey: 'sc.fontUp' },
  { id: 'key-smaller', states: NOT_EDITOR, key: ['-', '_'], action: 'fontDown', labelKey: 'sc.fontDown' },
  { id: 'key-fullscreen', states: NOT_EDITOR, key: ['F'], action: 'fullscreen', labelKey: 'sc.fullscreen' },
  { id: 'editor-save', states: ['editor'], key: ['S'], mod: 'ctrl', inFields: true, prevent: true, action: 'save', labelKey: 'sc.save' },
  { id: 'editor-close', states: ['editor'], key: ['Escape'], inFields: true, prevent: true, action: 'close', labelKey: 'sc.close' },
];

// Browser defaults blocked even where no entry fires, so the page never scrolls or pops a menu under the prompter:
// these keys on every screen but the editor (unless typing in a field), and the right-click menu outside the sound check and the editor.
export const BLOCKED_KEYS = { states: NOT_EDITOR, key: ['Space', 'ArrowRight', 'ArrowDown', 'PageDown', 'ArrowLeft', 'ArrowUp', 'PageUp'] };
export const BLOCKED_MENU = { states: STATES.filter((s) => s !== 'setup' && s !== 'editor') };

export const BUTTONS = { 0: 'left', 2: 'right' };

const isClick = (s) => s.mouse === 'left' && !s.hold && !s.press;

export const keyName = (key) => (key === ' ' ? 'Space' : /^[a-z]$/.test(key) ? key.toUpperCase() : key);

/**
 * A keydown. ctrl = Ctrl or Cmd held; inField = the target is an input, textarea or select.
 * @returns {{ hit: object | null, prevent: boolean }} the entry to run, and whether to block the browser default
 */
export function matchKey(state, { key, ctrl = false, inField = false }) {
  const k = keyName(key);
  const hit = SHORTCUTS.find((s) => s.key?.includes(k) && s.states.includes(state) && (!s.mod || ctrl) && (s.inFields || !inField)) || null;
  const blocked = !inField && BLOCKED_KEYS.states.includes(state) && BLOCKED_KEYS.key.includes(k);
  return { hit, prevent: !!hit?.prevent || blocked };
}

/**
 * A pointerdown. onUi = it landed on a button, link, label or field.
 * @returns {{ hold?: object, press?: object, arm?: string | false }}
 *   hold: start this hold entry; press: run this entry now; arm: the button whose release may click (false: none);
 *   none of them: leave the pending click alone (a screen with holds ignores other buttons)
 */
export function matchPointerDown(state, button, onUi) {
  const b = BUTTONS[button];
  const here = SHORTCUTS.filter((s) => s.mouse && s.states.includes(state));
  const hold = here.find((s) => s.hold && s.mouse === b);
  if (hold) return { hold };
  if (here.some((s) => s.hold)) return {};
  const press = here.find((s) => s.press && s.mouse === b);
  if (press) return { press };
  return { arm: !onUi && here.some((s) => isClick(s) && s.mouse === b) ? b : false };
}

/** The click entry a release of this button fires in this state (the press must have armed it). */
export function matchClick(state, button) {
  const b = BUTTONS[button];
  return SHORTCUTS.find((s) => isClick(s) && s.mouse === b && s.states.includes(state)) || null;
}

export function matchWheel(state) {
  return SHORTCUTS.find((s) => s.mouse === 'wheel' && s.states.includes(state)) || null;
}

export const menuBlocked = (state) => BLOCKED_MENU.states.includes(state);

// ── Display (docs tables) ─────────────────────────────────────
const KEY_LABELS = { Escape: 'Esc', ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓', PageUp: 'Page Up', PageDown: 'Page Down' };

function keyLabel(lang, s, k) {
  const name = k === 'Space' ? tl(lang, 'key.Space') : KEY_LABELS[k] || k;
  return s.mod === 'ctrl' ? `Ctrl+${name}` : name;
}

function mouseLabel(lang, s) {
  if (s.mouse === 'wheel') return tl(lang, 'sc.in.wheel');
  if (s.hold) return tl(lang, s.mouse === 'left' ? 'sc.in.holdLeft' : 'sc.in.holdRight', { s: s.hold / 1000 });
  if (s.mouse === 'right') return tl(lang, 'sc.in.rightClick');
  return tl(lang, 'sc.in.click');
}

function whenLabel(lang, states) {
  if (NOT_EDITOR.every((s) => states.includes(s)) && !states.includes('editor')) return tl(lang, 'sc.when.always');
  return states.filter((s) => s !== 'boot' && s !== 'saving').map((s) => tl(lang, `state.${s}`)).join(tl(lang, 'sc.sep'));
}

/**
 * One display row per entry, in table order, for the README tables.
 * @returns {Array<{ id: string, kind: 'mouse' | 'key', keys: string[] | null, input: string, when: string, action: string }>}
 */
export function describeShortcuts(lang) {
  return SHORTCUTS.map((s) => {
    const keys = s.key ? s.key.map((k) => keyLabel(lang, s, k)) : null;
    return {
      id: s.id,
      kind: s.mouse ? 'mouse' : 'key',
      keys,
      input: keys ? keys.join(' / ') : mouseLabel(lang, s),
      when: whenLabel(lang, s.states),
      action: tl(lang, s.labelKey),
    };
  });
}
