// Recognition results → script position.
// On each recognition event, take the last few recognised words (tail) and run a small local alignment within [a little before cursor, cursor + ahead].
// The alignment end is the word just read. Forward only: after a misread you hold right to discard and retake, so stutters and repeated words never drag the position back; only the wheel moves it back.

import { similarity } from './normalize.js';

const INS = 0.35; // extra word in the recognition
const MIS = 0.5; // substitution that does not match
const DIST = 0.03; // penalty per extra token jumped ahead; for the same word, the nearer one wins

const gapCost = (tok) => (tok.optional ? 0 : tok.weight < 1 ? 0.15 : tok.weight > 1 ? 0.6 : 0.45);

/**
 * @returns {{ end: number, score: number, content: number, rare: number, matched: number[] } | null}
 *   end = alignment end (index of the last matched token)
 */
export function alignTail(tokens, cursor, tail, ahead = 25, dist = DIST) {
  const n = tail.length;
  const lo = Math.max(0, cursor - n - 4);
  const hi = Math.min(tokens.length, cursor + ahead);
  const m = hi - lo;
  if (!n || m <= 0) return null;
  const W = m + 1;
  const S = new Float64Array((n + 1) * W);
  const B = new Uint8Array((n + 1) * W); // 0 start, 1 match, 2 substitution, 3 extra recognised word, 4 skipped script word
  let best = null;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const tok = tokens[lo + j - 1];
      const sim = similarity(tail[i - 1], tok.t);
      // Only an exact match (aliases included) earns the rare-word bonus; a near match counts as a normal word at most
      const gain = sim === 1 ? tok.weight : sim * Math.min(tok.weight, 1);
      const diag = S[(i - 1) * W + j - 1] + (sim > 0 ? gain : -MIS);
      const up = S[(i - 1) * W + j] - INS;
      const left = S[i * W + j - 1] - gapCost(tok);
      let v = 0;
      let b = 0;
      if (diag > v) { v = diag; b = sim > 0 ? 1 : 2; }
      if (up > v) { v = up; b = 3; }
      if (left > v) { v = left; b = 4; }
      S[i * W + j] = v;
      B[i * W + j] = b;
      if (b === 1) {
        const end = lo + j - 1;
        const adj = v - INS * (n - i) - dist * Math.max(0, end - cursor);
        if (!best || adj > best.score) best = { score: adj, i, j, end };
      }
    }
  }
  if (!best) return null;
  const matched = [];
  let content = 0;
  let rare = 0;
  for (let i = best.i, j = best.j; i > 0 && j > 0 && S[i * W + j] > 0;) {
    const b = B[i * W + j];
    if (b === 1) {
      const tok = tokens[lo + j - 1];
      matched.push(tok.index);
      if (tok.weight >= 1) content++;
      if (tok.weight > 1) rare++;
      i--; j--;
    } else if (b === 2) { i--; j--; }
    else if (b === 3) i--;
    else if (b === 4) j--;
    else break;
  }
  return { end: best.end, score: best.score, content, rare, matched };
}

/**
 * End detection: the cursor is in the second-to-last block and the last block's words are heard (Both: Thanks!) → the script is done.
 * The last block's words appear nowhere else in the script, so the cursor need not reach the end. In real takes the last block is often recognised as garbage and the cursor lags 20–30 words behind.
 * Applies only to a very short final block (≤ 3 content words).
 */
export function endHeard(parsed, cursor, tail) {
  const blocks = parsed.blocks.filter((b) => b.tokEnd > b.tokStart);
  const last = blocks[blocks.length - 1];
  const prev = blocks[blocks.length - 2];
  if (!last || !prev || cursor < prev.tokStart) return false;
  const words = parsed.tokens.slice(last.tokStart, last.tokEnd).filter((t) => t.weight >= 1).map((t) => t.t);
  if (!words.length || words.length > 3) return false;
  const recent = tail.slice(-4);
  return words.every((w) => recent.includes(w));
}

export function createMatcher(tokens) {
  const matched = new Uint8Array(tokens.length);
  const manual = new Uint8Array(tokens.length);
  const times = new Array(tokens.length).fill(null);
  let cursor = 0;
  const freq = new Map();
  for (const t of tokens) freq.set(t.t, (freq.get(t.t) || 0) + 1);

  /**
   * Is there, among the last 3 words of the recognition tail, a content word a short way ahead that appears only once in the whole script? If so, return its index (the last one heard).
   * Rare words (numbers, proper names) search 40 tokens ahead; normal words only 15. Common words in garbled recognition would otherwise yank the cursor twenty-odd words ahead
   */
  function freshUnique(tails) {
    for (const tail of tails) {
      const fresh = tail.slice(-3);
      for (let f = fresh.length - 1; f >= 0; f--) {
        if (freq.get(fresh[f]) !== 1) continue;
        for (let k = cursor; k < Math.min(tokens.length, cursor + 40); k++) {
          const tok = tokens[k];
          if (tok.t === fresh[f] && tok.weight >= 1 && !tok.optional && (tok.weight > 1 || k < cursor + 15)) return k;
        }
      }
    }
    return -1;
  }

  function passTo(c, now, isManual) {
    for (let k = cursor; k < c; k++) {
      if (isManual) manual[k] = 1;
      else if (times[k] === null) times[k] = now;
    }
    cursor = c;
  }

  return {
    get cursor() { return cursor; },
    matched,
    manual,
    times,
    /**
     * @param tails normalised recognition tails; may hold several candidates (maxAlternatives), the highest score wins
     * @param now ms from the start of recording
     * @param wide widen the forward search right after a recognition restart / during inertia scrolling
     * @param far nothing matched for several seconds (a whole stretch of recognition was garbage and the speaker is well ahead): search 60 tokens ahead, distance penalty cut to a third
     * @returns whether the cursor advanced
     */
    update(tails, now, { wide = false, far = false } = {}) {
      const ahead0 = far ? 60 : wide ? 40 : 25;
      const dist = far ? DIST / 3 : DIST;
      let best = null;
      for (const tail of tails) {
        const r = alignTail(tokens, cursor, tail, ahead0, dist);
        if (r && (!best || r.score > best.score)) best = r;
      }
      const ahead = best ? best.end - cursor : -1;
      const ok = !!best && ((best.content >= 2 && best.score >= 1.5)
        || (best.rare >= 1 && best.score >= 1.2 && ahead <= 3)
        || (best.content >= 1 && best.score >= 0.9 && ahead <= 1));
      // When stuck: if a word just heard appears only once in the whole script (e.g. numbers or rare words), assume the speaker has reached it
      const uniq = far ? freshUnique(tails) : -1;
      if (uniq >= 0 && (!ok || best.end < uniq)) {
        matched[uniq] = 1;
        passTo(uniq + 1, now, false);
        return true;
      }
      if (!ok) return false;
      for (const k of best.matched) matched[k] = 1;
      if (best.end + 1 <= cursor) return false;
      passTo(best.end + 1, now, false);
      return true;
    },
    /** Treat c as reached (e.g. the closing "Thanks" was heard): unmatched words in between still count as missed, not as manual skips */
    jump(c, now) {
      c = Math.max(0, Math.min(tokens.length, c));
      if (c > cursor) passTo(c, now, false);
    },
    /** Manual move by wheel / keyboard */
    set(c, now) {
      c = Math.max(0, Math.min(tokens.length, c));
      if (c > cursor) passTo(c, now, true);
      else cursor = c;
    },
    reset() {
      cursor = 0;
      matched.fill(0);
      manual.fill(0);
      times.fill(null);
    },
  };
}
