// Pretends someone is reading the script: emits word by word the ever-growing recognition text
// Chrome produces, with misheard names, rewritten numbers and recognition sessions that restart
// now and then (dropping a few words each time). Shared by the unit tests and the ?sim= mode.

export const DEFAULT_SUBS = {
  chillahub: 'chiller hub',
  tiktok: 'tick tock',
  ebay: 'e bay',
  '45%': 'forty five percent',
  '3': 'three',
};

const bareOf = (text) => text.toLowerCase().replace(/[’']/g, "'").replace(/^[^a-z0-9$%]+|[^a-z0-9$%]+$/g, '');
const keyOf = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Matches each script word to a word of a voice track, so the simulation can follow real timing.
 * timings: [{ word, startMs, endMs }] in reading order (e.g. word timestamps of a TTS track).
 * Returns per script word { start, end } in ms, or null where the word was not found
 * (those get times interpolated from their neighbours by the caller).
 */
export function alignTimings(words, timings) {
  const a = words.map((w) => keyOf(w.text));
  const b = timings.map((x) => keyOf(x.word));
  const n = a.length;
  const m = b.length;
  // Longest common subsequence on normalised words
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = a[i] && a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const out = new Array(n).fill(null);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] && a[i] === b[j]) { out[i] = { start: timings[j].startMs, end: timings[j].endMs }; i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }
  return out;
}

/** Fills the gaps alignTimings left, by spreading them evenly between the known neighbours. */
function fillTimes(times, words) {
  const known = times.map((x, i) => (x ? i : -1)).filter((i) => i >= 0);
  if (!known.length) throw new Error('none of the script words were found in the timings');
  const out = times.slice();
  for (let i = 0; i < out.length; i++) {
    if (out[i]) continue;
    const prev = [...known].reverse().find((k) => k < i);
    const next = known.find((k) => k > i);
    const t0 = prev != null ? out[prev].end : out[next].start - 300 * (next - i);
    const t1 = next != null ? times[next].start : t0 + 300 * (i - prev);
    const span = (next ?? i + 1) - (prev ?? i - 1);
    const at = t0 + ((t1 - t0) * (i - (prev ?? i - 1))) / span;
    out[i] = { start: at, end: at, filled: true };
  }
  return out;
}

/**
 * Simulated recognition for the sound check page: each speaker reads their own first sentence,
 * one after the other. Times come from `timings` when given (relative to the first word), else from wpm.
 * @returns {{ events: Array<{t:number,text:string,final:boolean}>, speech: number[][] }}
 */
export function simulateSetup(parsed, { timings = null, wpm = 140, gap = 1500, delay = 350 } = {}) {
  const firsts = [];
  for (const sp of parsed.speakers) {
    const b = parsed.blocks.find((x) => x.speaker === sp && x.paras.length);
    if (!b) continue;
    const p = parsed.paras[b.paras[0]];
    let end = p.wordEnd;
    for (let w = p.wordStart; w < p.wordEnd; w++) if (/[.?!]["”’)]*$/.test(parsed.words[w].text)) { end = w + 1; break; }
    firsts.push({ from: p.wordStart, to: end });
  }
  const times = timings ? fillTimes(alignTimings(parsed.words, timings), parsed.words) : null;
  const events = [];
  const speech = [];
  let t = 600;
  for (const f of firsts) {
    const base = times ? times[f.from].start : 0;
    const segStart = t;
    const said = [];
    for (let w = f.from; w < f.to; w++) {
      said.push(parsed.words[w].text);
      const at = times ? t + (times[w].end - base) + delay : t + (w - f.from + 1) * (60000 / wpm) + delay;
      events.push({ t: Math.round(at), text: said.join(' '), final: w === f.to - 1 });
    }
    const segEnd = Math.round(times ? t + (times[f.to - 1].end - base) : t + (f.to - f.from) * (60000 / wpm));
    speech.push([segStart, segEnd]);
    t = segEnd + gap;
  }
  return { events, speech };
}

/**
 * @returns {{ events: Array<{t:number,text?:string,final?:boolean,restart?:boolean,truth:number}>, speech: number[][] }}
 *   truth = the real reading position at that moment (tokens fully read); the tests compare against it
 */
export function simulate(parsed, opts = {}) {
  const {
    wpm = 140, restartEvery = 40, drop = 3, speakNumbering = false, subs = DEFAULT_SUBS, start = 600,
    extra = {}, // { word index: an extra word said after it }, to fake a stutter
    garble = null, // [from, to) word indexes: recognition is pure noise here (as with a strong accent)
    timings = null, // [{ word, startMs, endMs }]: follow a real voice track instead of a fixed wpm
    delay = 350, // with timings: recognition reports a word this long after it is spoken
  } = opts;
  if (timings) return simulateTimed(parsed, { ...opts, subs, restartEvery, drop, speakNumbering, extra, garble, timings, delay, start });
  const JUNK = ['your', 'content', 'was', 'that', 'you', 'have', 'irritate', 'so', 'they', 'must', 'force', 'if', 'had'];
  let junkAt = 0;
  const per = 60000 / wpm;
  const { words, tokens } = parsed;
  const doneAt = words.map((_, w) => tokens.filter((t) => t.to <= w).length);
  const events = [];
  const speech = [];
  let t = start;
  let session = [];
  let since = 0;
  let dropLeft = 0;
  let lastBlock = -1;
  let segStart = null;
  const say = (text, w) => {
    t += per;
    if (dropLeft > 0) { dropLeft--; return; }
    session.push(text);
    since++;
    events.push({ t: Math.round(t), text: session.join(' '), final: /[.?!]$/.test(words[w].text), truth: doneAt[w] });
    if (since >= restartEvery) {
      events.push({ t: Math.round(t) + 1, restart: true, truth: doneAt[w] });
      session = [];
      since = 0;
      dropLeft = drop;
    }
  };
  for (let w = 0; w < words.length; w++) {
    const word = words[w];
    if (word.block !== lastBlock) {
      if (segStart !== null) { speech.push([segStart, Math.round(t)]); t += 600; }
      segStart = Math.round(t);
      lastBlock = word.block;
    }
    if (word.optional && !speakNumbering) continue;
    const bare = bareOf(word.text);
    let spoken = word.optional ? String(parseInt(word.text, 10)) : bare in subs ? subs[bare] : word.text;
    if (garble && w >= garble[0] && w < garble[1]) spoken = JUNK[junkAt++ % JUNK.length];
    if (spoken) say(spoken, w);
    if (extra[w]) say(extra[w], w);
    if (/[.?!]$/.test(word.text)) t += 250;
  }
  speech.push([segStart, Math.round(t)]);
  return { events, speech };
}

/**
 * Same as simulate(), but every word is reported when the voice track says it ends (+ delay),
 * so the prompter moves in step with that audio. Mishearings, restarts and dropped words stay.
 * The returned audioOffsetMs is where the voice track's 0 s must sit, measured from the start of recording.
 */
function simulateTimed(parsed, { subs, restartEvery, drop, speakNumbering, extra, garble, timings, delay, start }) {
  const JUNK = ['your', 'content', 'was', 'that', 'you', 'have', 'irritate', 'so', 'they', 'must', 'force', 'if', 'had'];
  let junkAt = 0;
  const { words, tokens } = parsed;
  const times = fillTimes(alignTimings(words, timings), words);
  const first = words.findIndex((w) => !w.optional);
  const shift = start - times[first].start;
  const doneAt = words.map((_, w) => tokens.filter((t) => t.to <= w).length);
  const events = [];
  const speech = [];
  let session = [];
  let since = 0;
  let dropLeft = 0;
  const say = (text, w, at) => {
    if (dropLeft > 0) { dropLeft--; return; }
    session.push(text);
    since++;
    events.push({ t: Math.round(at), text: session.join(' '), final: /[.?!]$/.test(words[w].text), truth: doneAt[w] });
    if (since >= restartEvery) {
      events.push({ t: Math.round(at) + 1, restart: true, truth: doneAt[w] });
      session = [];
      since = 0;
      dropLeft = drop;
    }
  };
  for (const b of parsed.blocks) {
    if (b.tokEnd <= b.tokStart) continue;
    const ws = b.paras.flatMap((pi) => {
      const p = parsed.paras[pi];
      return Array.from({ length: p.wordEnd - p.wordStart }, (_, k) => p.wordStart + k);
    });
    speech.push([Math.round(times[ws[0]].start + shift), Math.round(times[ws.at(-1)].end + shift)]);
  }
  for (let w = 0; w < words.length; w++) {
    const word = words[w];
    if (word.optional && !speakNumbering) continue;
    const at = times[w].end + shift + delay;
    const bare = bareOf(word.text);
    let spoken = word.optional ? String(parseInt(word.text, 10)) : bare in subs ? subs[bare] : word.text;
    if (garble && w >= garble[0] && w < garble[1]) spoken = JUNK[junkAt++ % JUNK.length];
    if (spoken) say(spoken, w, at);
    if (extra[w]) say(extra[w], w, at + 1);
  }
  events.sort((x, y) => x.t - y.t);
  return { events, speech, audioOffsetMs: Math.round(shift) };
}
