// Duration estimate and measured speaking rate. Goal: estimate ≈ length of the recorded file.
// estimate = 1.5 s lead-in + Σ(block token count ÷ that speaker's rate) + 1 s per Both block + 2 s before the auto-stop at the end.
// The rate includes pauses: it runs from a block's first word to the next block's first word, so pauses between sentences and speaker changes count.
// (The first version dropped pauses over 1.5 s. It estimated two real takes at 89 / 80 s; they ran 102 / 106 s.)
// The server keeps each speaker's last 5 samples and uses the median (stats.json).

export const DEFAULT_WPM = 130;
export const TARGET_SEC = 90;
const LEAD_SEC = 1.5;
const BOTH_SEC = 1;
const TAIL_SEC = 2;

export function spokenCount(parsed, b) {
  let n = 0;
  for (let k = b.tokStart; k < b.tokEnd; k++) if (!parsed.tokens[k].optional) n++;
  return n;
}

export function estimate(parsed, wpm = {}) {
  const per = parsed.blocks.map((b) => {
    const n = spokenCount(parsed, b);
    if (!n) return 0;
    return b.both ? BOTH_SEC : (n / (wpm[b.speaker] || DEFAULT_WPM)) * 60;
  });
  return { per, total: LEAD_SEC + per.reduce((a, b) => a + b, 0) + TAIL_SEC };
}

/**
 * times[k] = when recognition passed token k (ms from the start of recording); null if it was skipped manually.
 * Block duration = time of the next block's first word − time of this block's first word. A block is ignored when over 20% of its words have no time (wheel-skipped).
 */
export function measureWpm(parsed, times) {
  const acc = {};
  const blocks = parsed.blocks.filter((b) => b.tokEnd > b.tokStart);
  const firstTime = (b) => {
    for (let k = b.tokStart; k < b.tokEnd; k++) if (times[k] != null) return times[k];
    return null;
  };
  blocks.forEach((b, i) => {
    const next = blocks[i + 1];
    if (b.both || !b.speaker || !next) return;
    let timed = 0;
    for (let k = b.tokStart; k < b.tokEnd; k++) if (times[k] != null) timed++;
    const t0 = firstTime(b);
    const t1 = firstTime(next);
    if (t0 == null || t1 == null || t1 - t0 < 1000 || timed < 0.8 * (b.tokEnd - b.tokStart)) return;
    const a = (acc[b.speaker] ||= { n: 0, ms: 0 });
    a.n += spokenCount(parsed, b);
    a.ms += t1 - t0;
  });
  const out = {};
  for (const [s, a] of Object.entries(acc)) out[s] = Math.round((a.n / (a.ms / 60000)) * 10) / 10;
  return out;
}

export function fmtSec(s) {
  const r = Math.max(0, Math.round(s));
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`;
}
