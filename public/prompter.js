// Prompter display: one centred column; the current line sits on the reading line (about 12% from the top, close to the camera).
// White background: the screen is the fill light on the face, so highlighting uses only shade (unread dark grey / current line black / read light grey), no colour blocks.
// Scrolling follows the line of the current word, not each word; a damped spring chases the target to avoid jitter.

const PALETTE = ['#1f6fb5', '#c2410c', '#7c3aed', '#047857'];
const NEUTRAL = '#555';

export function speakerColors(parsed) {
  const map = {};
  let k = 0;
  for (const b of parsed.blocks) {
    if (!b.speaker || b.both || map[b.speaker]) continue;
    map[b.speaker] = PALETTE[k++ % PALETTE.length];
  }
  return (speaker) => map[speaker] || NEUTRAL;
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export class Prompter {
  constructor(stage) {
    this.stage = stage;
    this.content = stage.querySelector('#content');
    this.cue = stage.querySelector('#cue');
    this.spans = [];
    this.lineOf = [];
    this.lineTop = [];
    this.y = 0;
    this.target = 0;
    this.last = { c: -1, word: -1 };
    this.snap = true;
  }

  render(parsed) {
    this.parsed = parsed;
    const color = speakerColors(parsed);
    this.content.textContent = '';
    this.spans = [];
    for (const b of parsed.blocks) {
      const sec = el('section', 'block');
      sec.style.setProperty('--spk', color(b.speaker));
      if (b.speaker) sec.append(el('div', 'who', b.speaker));
      if (b.title) sec.append(el('div', 'title', b.title));
      for (const pi of b.paras) {
        const p = parsed.paras[pi];
        const pe = el('p', 'p');
        for (let w = p.wordStart; w < p.wordEnd; w++) {
          const s = el('span', 'w', parsed.words[w].text);
          this.spans[w] = s;
          pe.append(s, ' ');
        }
        sec.append(pe);
      }
      this.content.append(sec);
    }
    this.snap = true;
    this.layout();
  }

  layout() {
    if (!this.parsed) return;
    const base = this.content.getBoundingClientRect().top;
    this.lineOf = [];
    this.lineTop = [];
    let line = -1;
    let prev = -Infinity;
    this.spans.forEach((s, w) => {
      const top = s.getBoundingClientRect().top - base;
      if (Math.abs(top - prev) > 4) { line++; prev = top; this.lineTop[line] = top; }
      this.lineOf[w] = line;
    });
    this.last = { c: -1, word: -1 };
  }

  setFontSize(px) {
    document.documentElement.style.setProperty('--fs', `${px}px`);
    requestAnimationFrame(() => { this.layout(); this.snap = true; });
  }

  get readY() {
    return window.innerHeight * 0.12;
  }

  /** p = display position (in tokens; may be fractional during inertia scrolling) */
  update(p) {
    const { words } = this.parsed;
    if (!words.length) return;
    const c = Math.floor(p + 1e-6);
    let cw = words.findIndex((w) => w.readAt > c);
    if (cw < 0) cw = words.length - 1;
    if (c === this.last.c && cw === this.last.word) return;
    const line = this.lineOf[cw];
    for (let w = 0; w < words.length; w++) {
      const read = words[w].readAt <= c;
      const s = this.spans[w];
      s.classList.toggle('read', read);
      s.classList.toggle('cur', !read && this.lineOf[w] === line);
    }
    this.target = this.lineTop[line] ?? 0;
    this.last = { c, word: cw };
  }

  tick(dt) {
    if (this.snap) { this.y = this.target; this.snap = false; }
    else this.y += (this.target - this.y) * (1 - Math.exp(-dt / 0.18));
    this.content.style.transform = `translate3d(0, ${(this.readY - this.y).toFixed(1)}px, 0)`;
  }

  setCue(text, color) {
    if (!text) { this.cue.classList.remove('on'); return; }
    if (this.cue.textContent !== text) this.cue.textContent = text;
    this.cue.style.color = color;
    this.cue.classList.add('on');
  }
}
