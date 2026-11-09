// Demo-video overlay. Injected by scripts/docs-media (Playwright addInitScript) while the demo videos are
// captured; it is never part of the app (public/ does not load it).
//   - A small card at the bottom right: a mouse whose left / right button lights up while pressed, a ring that
//     fills over 1 s while a button is held ("Hold 1 s"), and the last key pressed (Space, E, Esc …) for ~1 s.
//   - A soft dot where the pointer is, and a ripple where it clicks, outside the prompter states
//     (the app hides the cursor while counting down and recording).
// Driven by capture-phase pointer / key listeners on window that are passive and never stop the event.
// window.__DM_CFG (set before this runs): { hold: 'Hold 1 s', space: 'Space' }.
// window.__dmOverlay: { showKey(label), hidden(bool) } for the capture script.
(() => {
  if (window.__dmOverlay) return;
  const cfg = Object.assign({ hold: 'Hold 1 s', space: 'Space' }, window.__DM_CFG || {});
  const HOLD_MS = 1000;
  const SHOW_RING_AFTER = 160; // a click is not a hold
  const IDLE_HIDE = 1600;
  const KEY_SHOW = 1100;
  const CLICK_SHOW = 300; // a quick click still lights its button this long
  const RING = 2 * Math.PI * 13;
  const KEY_LABEL = { ' ': cfg.space, Escape: 'Esc', ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓', PageUp: 'Page Up', PageDown: 'Page Down', Enter: 'Enter' };

  const css = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
    .layer.off { display: none; }
    .card {
      position: absolute; right: 14px; bottom: 12px;
      display: flex; align-items: center; gap: 12px;
      padding: 9px 14px 9px 12px; min-height: 54px; box-sizing: border-box;
      background: #fff; border: 1px solid rgba(0,0,0,0.08); border-radius: 12px;
      box-shadow: 0 4px 14px rgba(0,0,0,0.10), 0 1px 3px rgba(0,0,0,0.08);
      color: #333; font-size: 15px; line-height: 1;
      opacity: 0; transform: translateY(4px); transition: opacity .22s ease, transform .22s ease;
    }
    .card.on { opacity: 1; transform: none; }
    .mouse { width: 25px; height: 36px; display: block; }
    .mouse .body { fill: #fff; stroke: #9a9a9a; stroke-width: 1.4; }
    .mouse .btn { fill: transparent; transition: fill .08s; }
    .mouse .btn.on { fill: #333; }
    .mouse .btn.r.on { fill: #e5484d; }
    .mouse .line { stroke: #9a9a9a; stroke-width: 1.2; }
    .hold { display: none; align-items: center; gap: 8px; }
    .hold.on { display: flex; }
    .ring { width: 30px; height: 30px; transform: rotate(-90deg); }
    .ring circle { fill: none; stroke-width: 3.5; }
    .ring .bg { stroke: #ececec; }
    .ring .fg { stroke: #333; stroke-dasharray: ${RING.toFixed(2)}; stroke-dashoffset: ${RING.toFixed(2)}; stroke-linecap: round; }
    .ring.r .fg { stroke: #e5484d; }
    .key { display: none; padding: 6px 9px 7px; min-width: 16px; text-align: center; border: 1px solid #cfcfcf; border-bottom-width: 2px; border-radius: 6px; background: #fafafa; font-weight: 600; font-size: 15px; color: #222; }
    .key.on { display: inline-block; }
    .dot { position: absolute; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%;
      background: rgba(17,17,17,0.28); border: 2px solid rgba(255,255,255,0.9); box-shadow: 0 0 0 1px rgba(0,0,0,0.25);
      opacity: 0; transition: opacity .25s, transform .12s; }
    .dot.on { opacity: 1; }
    .dot.down { transform: scale(0.82); background: rgba(17,17,17,0.45); }
    .ripple { position: absolute; width: 40px; height: 40px; margin: -20px 0 0 -20px; border-radius: 50%;
      border: 2px solid rgba(17,17,17,0.35); animation: rip .55s ease-out forwards; }
    @keyframes rip { from { transform: scale(0.3); opacity: 1; } to { transform: scale(1.15); opacity: 0; } }
  `;

  let root = null;
  let el = {};
  const state = { pressed: null, lastPress: null, lastInput: 0, keyAt: 0, pointerAt: 0, hidden: false };
  const noCursor = () => ['recording', 'countdown'].includes(document.body?.dataset.state);

  function build() {
    if (root) return;
    const host = document.createElement('div');
    host.id = 'dm-overlay-host';
    document.documentElement.append(host);
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${css}</style>
      <div class="layer">
        <div class="dot"></div>
        <div class="card">
          <svg class="mouse" viewBox="0 0 22 32" aria-hidden="true">
            <rect class="body" x="1.5" y="1.5" width="19" height="29" rx="9.5"/>
            <path class="btn l" d="M11 1.5 A9.5 9.5 0 0 0 1.5 11 V13 H11 Z"/>
            <path class="btn r" d="M11 1.5 A9.5 9.5 0 0 1 20.5 11 V13 H11 Z"/>
            <line class="line" x1="11" y1="1.5" x2="11" y2="13"/><line class="line" x1="1.5" y1="13" x2="20.5" y2="13"/>
          </svg>
          <span class="hold"><svg class="ring" viewBox="0 0 30 30"><circle class="bg" cx="15" cy="15" r="13"/><circle class="fg" cx="15" cy="15" r="13"/></svg><span class="htext"></span></span>
          <span class="key"></span>
        </div>
      </div>`;
    const q = (s) => root.querySelector(s);
    el = { layer: q('.layer'), card: q('.card'), l: q('.btn.l'), r: q('.btn.r'), hold: q('.hold'), ring: q('.ring'), fg: q('.ring .fg'), htext: q('.htext'), key: q('.key'), dot: q('.dot') };
    el.htext.textContent = cfg.hold;
    requestAnimationFrame(tick);
  }

  function moveDot(x, y) {
    el.dot.style.left = `${x}px`;
    el.dot.style.top = `${y}px`;
  }

  function ripple(x, y) {
    const r = document.createElement('div');
    r.className = 'ripple';
    r.style.left = `${x}px`;
    r.style.top = `${y}px`;
    el.layer.append(r);
    setTimeout(() => r.remove(), 700);
  }

  function tick(now) {
    const p = state.pressed;
    const t = performance.now();
    const lit = p || (state.lastPress && t - state.lastPress.at < CLICK_SHOW ? state.lastPress : null);
    el.l.classList.toggle('on', lit?.button === 0);
    el.r.classList.toggle('on', lit?.button === 2);
    const held = p ? t - p.at : 0;
    const showHold = !!p && held >= SHOW_RING_AFTER && (p.button === 0 || p.button === 2);
    el.hold.classList.toggle('on', showHold);
    if (showHold) {
      el.ring.classList.toggle('r', p.button === 2);
      el.fg.style.strokeDashoffset = String(RING * (1 - Math.min(1, held / HOLD_MS)));
    }
    el.key.classList.toggle('on', t - state.keyAt < KEY_SHOW);
    el.card.classList.toggle('on', !!p || t - state.lastInput < IDLE_HIDE);
    const dotOn = !noCursor() && (!!p || t - state.pointerAt < 900);
    el.dot.classList.toggle('on', dotOn);
    el.dot.classList.toggle('down', !!p && dotOn);
    requestAnimationFrame(tick);
  }

  const opts = { capture: true, passive: true };
  window.addEventListener('pointermove', (e) => {
    if (!root) return;
    moveDot(e.clientX, e.clientY);
    state.pointerAt = performance.now();
  }, opts);
  window.addEventListener('pointerdown', (e) => {
    if (!root) return;
    const now = performance.now();
    state.pressed = { button: e.button, at: now };
    state.lastPress = state.pressed;
    state.lastInput = now;
    state.pointerAt = now;
    moveDot(e.clientX, e.clientY);
    if (!noCursor()) ripple(e.clientX, e.clientY);
  }, opts);
  window.addEventListener('pointerup', () => {
    if (!root) return;
    state.pressed = null;
    state.lastInput = performance.now();
    state.pointerAt = performance.now();
  }, opts);
  function showKey(label) {
    if (!root) return;
    el.key.textContent = label;
    state.keyAt = performance.now();
    state.lastInput = state.keyAt;
  }
  window.addEventListener('keydown', (e) => {
    // Letters typed into a text field are typing, not shortcuts: not shown
    const inField = !!e.target?.closest?.('input, textarea, select');
    if (inField && e.key.length === 1 && !e.ctrlKey && !e.metaKey) return;
    if (['Shift', 'Control', 'Alt', 'Meta', 'Backspace'].includes(e.key)) return;
    const base = KEY_LABEL[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
    showKey(e.ctrlKey || e.metaKey ? `Ctrl+${base}` : base);
  }, opts);

  window.__dmOverlay = {
    showKey,
    hidden(on) {
      state.hidden = !!on;
      el.layer?.classList.toggle('off', state.hidden);
    },
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
