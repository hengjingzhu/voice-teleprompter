// The script and recognition results go through the same normalisation, so the two can be compared:
// lowercase, strip punctuation, drop apostrophes (I've → ive), numbers to digits (fifteen → 15, $1,500 → 1500 dollars,
// two million → 2000000), proper names merged via aliases.json (type script → typescript).
// Shared by the browser and node --test; does not touch the DOM.

const SMALL = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES = { thousand: 1e3, million: 1e6, billion: 1e9 };

export const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'by', 'with', 'from', 'into',
  'is', 'are', 'was', 'be', 'it', 'its', 'we', 'i', 'im', 'our', 'us', 'you', 'they', 'them', 'their',
  'he', 'she', 'his', 'her', 'my', 'me', 'that', 'this', 'as', 'so', 'just', 'like', 'up', 'each',
  'every', 'about', 'than', 'can', 'still', 'all', 'has', 'have', 'do', 'does', 'there',
]);

// Recognition often swaps the words within each group; count them as a partial match
const EQUIV = [['to', 'too', '2'], ['for', '4']];
const EQUIV_OF = new Map(EQUIV.flatMap((g, k) => g.map((w) => [w, k])));

export const isNumeric = (t) => /^\d+$/.test(t);
export const isStop = (t) => STOP_WORDS.has(t);

/** One raw word → several pieces (aliases and numbers not merged yet) */
function piecesOf(raw, src) {
  let s = String(raw).replace(/[’‘ʼ`´]/g, "'").toLowerCase();
  s = s.replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  const money = /^(us)?\$\d/.test(s);
  const pct = /\d%/.test(s);
  s = s.replace(/'/g, '');
  const out = [];
  for (const part of s.split(/[^a-z0-9]+/)) if (part) out.push({ w: part, from: src, to: src });
  if (money) {
    if (out[0]?.w === 'us') out.shift();
    out.push({ w: 'dollars', from: src, to: src });
  }
  if (pct) out.push({ w: 'percent', from: src, to: src });
  return out;
}

export function buildAliasMap(aliases = {}) {
  const map = new Map();
  const canon = new Set();
  let maxLen = 1;
  for (const [c, list] of Object.entries(aliases)) {
    canon.add(c);
    for (const a of [c, ...list]) {
      const key = piecesOf(a, 0).map((p) => p.w).join(' ');
      if (!key) continue;
      map.set(key, c);
      maxLen = Math.max(maxLen, key.split(' ').length);
    }
  }
  return { map, canon, maxLen };
}

function applyAliases(pieces, aliasMap) {
  if (!aliasMap) return pieces;
  const out = [];
  for (let i = 0; i < pieces.length;) {
    let hit = 0;
    for (let L = Math.min(aliasMap.maxLen, pieces.length - i); L >= 1; L--) {
      const key = pieces.slice(i, i + L).map((p) => p.w).join(' ');
      const c = aliasMap.map.get(key);
      if (c) {
        out.push({ w: c, from: pieces[i].from, to: pieces[i + L - 1].to });
        hit = L;
        break;
      }
    }
    if (hit) i += hit;
    else out.push(pieces[i++]);
  }
  return out;
}

function kindOf(w) {
  if (/^\d+$/.test(w)) return 'digits';
  if (w in SMALL) return SMALL[w] > 0 && SMALL[w] < 10 ? 'unit' : 'teen';
  if (w in TENS) return 'tens';
  if (w === 'hundred') return 'hundred';
  if (w in SCALES) return 'scale';
  return null;
}

/** Merge runs of number words such as fifty four / 3 million / five hundred and twelve into one token */
function combineNumbers(pieces) {
  const out = [];
  for (let i = 0; i < pieces.length;) {
    const k0 = kindOf(pieces[i].w);
    if (!k0 || k0 === 'hundred' || k0 === 'scale') {
      out.push(pieces[i++]);
      continue;
    }
    let total = 0;
    let current = 0;
    let last = null;
    let lastScale = Infinity;
    let j = i;
    for (; j < pieces.length; j++) {
      const w = pieces[j].w;
      const k = kindOf(w);
      if (w === 'and') {
        const nk = j + 1 < pieces.length ? kindOf(pieces[j + 1].w) : null;
        if ((last === 'hundred' || last === 'scale') && (nk === 'unit' || nk === 'teen' || nk === 'tens')) continue;
        break;
      }
      if (k === 'digits') {
        if (last !== null) break;
        current = Number(w);
      } else if (k === 'unit') {
        if (!(last === null || last === 'tens' || last === 'hundred' || last === 'scale')) break;
        current += SMALL[w];
      } else if (k === 'teen' || k === 'tens') {
        if (!(last === null || last === 'hundred' || last === 'scale')) break;
        current += k === 'teen' ? SMALL[w] : TENS[w];
      } else if (k === 'hundred') {
        if (!(last === 'unit' || last === 'teen' || last === 'digits') || current >= 100) break;
        current *= 100;
      } else if (k === 'scale') {
        if (last === null || last === 'scale' || SCALES[w] >= lastScale || current === 0) break;
        total += current * SCALES[w];
        current = 0;
        lastScale = SCALES[w];
      } else break;
      last = k;
    }
    out.push({ w: String(total + current), from: pieces[i].from, to: pieces[j - 1].to });
    i = j;
  }
  return out;
}

/** Raw word array → [{ t, from, to }]; from/to are raw word indices (inclusive) */
export function normalizeWords(rawWords, aliasMap) {
  const pieces = rawWords.flatMap((w, i) => piecesOf(w, i));
  return combineNumbers(applyAliases(pieces, aliasMap)).map((p) => ({ t: p.w, from: p.from, to: p.to }));
}

export function normalizeText(text, aliasMap) {
  return normalizeWords(String(text).split(/\s+/).filter(Boolean), aliasMap).map((x) => x.t);
}

function lev(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** 0..1: identical 1, common confusion 0.8, singular/plural or close spelling 0.7, otherwise 0 */
export function similarity(a, b) {
  if (a === b) return 1;
  const ga = EQUIV_OF.get(a);
  if (ga !== undefined && ga === EQUIV_OF.get(b)) return 0.8;
  if (isNumeric(a) || isNumeric(b)) return 0;
  const min = Math.min(a.length, b.length);
  const max = Math.max(a.length, b.length);
  if (min >= 3 && max - min <= 2 && (a.startsWith(b) || b.startsWith(a))) return 0.7;
  if (min >= 4 && 1 - lev(a, b) / max >= 0.75) return 0.7;
  return 0;
}
