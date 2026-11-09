// Script → blocks / paragraphs / words / tokens. Takes the format users paste, as is:
//   Alex: text    or  Alex: (text starts on the next line)  → new block, speaker Alex
//   Alex — Why Us                                           → new block; "Why Us" is the block title (not read aloud, hidden while recording)
//   Both: Thanks!                                           → both speakers together
// Each line is a paragraph. A leading number such as "1." still shows; for matching it is an optional token (followed whether read or not).
// A line like "Upload: ..." (capitalised word + colon) is not a speaker: a speaker must appear at least once in the bare-colon / dash form, or at least twice.
// Lines starting with // are comments: dropped before anything else (not shown, not read, not counted).
// If the first remaining line is "Target: m:ss", it sets parsed.targetSec (the time limit shown on the page) and is dropped.
// "Target: …" anywhere else, or in another form, is ordinary text.

import { normalizeWords, isStop, isNumeric } from './normalize.js';

const COMMENT_RE = /^\/\//;
const TARGET_RE = /^target\s*[:：]\s*(\d{1,3}):([0-5]\d)$/i;
const LINE_RE = /^([A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*)?)\s*(?:[:：]\s*(.*)|\s+[—–-]+\s*(.*))$/;
const BOTH_RE = /^(both|all|together)$/i;
const PHRASE_END = /[,.:;?!]["”’)]*$/;
const SENTENCE_END = /[.?!:]["”’)]*$/;

function fnv(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function parseScript(text, aliasMap) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n').map((l) => (COMMENT_RE.test(l.trim()) ? '' : l.trim()));
  let targetSec = null;
  const first = lines.findIndex(Boolean);
  const tm = first >= 0 ? TARGET_RE.exec(lines[first]) : null;
  if (tm) {
    targetSec = Number(tm[1]) * 60 + Number(tm[2]);
    lines[first] = '';
  }

  const counts = new Map();
  const strong = new Set();
  for (const l of lines) {
    const m = LINE_RE.exec(l);
    if (!m) continue;
    counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    if (m[3] !== undefined || !m[2]) strong.add(m[1]);
  }
  const isSpeaker = (n) => BOTH_RE.test(n) || strong.has(n) || (counts.get(n) || 0) >= 2;

  const blocks = [];
  const paras = [];
  const words = [];
  let cur = null;
  const newBlock = (speaker, title) => {
    cur = { index: blocks.length, speaker, both: BOTH_RE.test(speaker), title: (title || '').trim(), paras: [] };
    blocks.push(cur);
  };
  const addPara = (s) => {
    const raw = s.split(/\s+/).filter(Boolean);
    if (!raw.length) return;
    if (!cur) newBlock('', '');
    const para = { index: paras.length, block: cur.index, wordStart: words.length, wordEnd: 0 };
    raw.forEach((w, k) => {
      words.push({
        index: words.length,
        text: w,
        block: cur.index,
        para: para.index,
        sentenceStart: k === 0 || SENTENCE_END.test(raw[k - 1]),
        optional: k === 0 && /^\d+[.)]$/.test(w),
      });
    });
    para.wordEnd = words.length;
    paras.push(para);
    cur.paras.push(para.index);
  };
  for (const l of lines) {
    if (!l) continue;
    const m = LINE_RE.exec(l);
    if (m && isSpeaker(m[1])) {
      newBlock(m[1], m[3]);
      if (m[2]) addPara(m[2]);
    } else addPara(l);
  }

  // Phrases: one wheel notch moves one phrase
  let phrase = 0;
  for (const p of paras) {
    for (let w = p.wordStart; w < p.wordEnd; w++) {
      words[w].phrase = phrase;
      if (PHRASE_END.test(words[w].text) && w < p.wordEnd - 1) phrase++;
    }
    phrase++;
  }

  // Rare words (proper nouns, names): a single match carries enough weight
  const speakerNames = new Set(blocks.map((b) => b.speaker.toLowerCase()).filter(Boolean));
  for (const w of words) {
    const bare = w.text.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    if (!bare || /^I($|['’])/.test(bare)) w.rare = false;
    else if (speakerNames.has(bare.toLowerCase())) w.rare = true;
    else if (/[A-Z]/.test(bare.slice(1))) w.rare = true;
    else w.rare = /^[A-Z]/.test(bare) && !w.sentenceStart;
  }

  const tokens = [];
  for (const p of paras) {
    const raw = words.slice(p.wordStart, p.wordEnd).map((w) => w.text);
    p.tokStart = tokens.length;
    for (const nt of normalizeWords(raw, aliasMap)) {
      const from = p.wordStart + nt.from;
      const to = p.wordStart + nt.to;
      const src = words.slice(from, to + 1);
      const optional = src.every((w) => w.optional);
      const rare = !optional && (isNumeric(nt.t) || src.some((w) => w.rare) || !!aliasMap?.canon.has(nt.t));
      // Optional numbering counts as a stop word: it matches if read, but never serves as an anchor (for ≈ 4 would pull the position past a word)
      const stop = optional || (!rare && isStop(nt.t));
      tokens.push({
        index: tokens.length,
        t: nt.t,
        from,
        to,
        block: words[from].block,
        para: p.index,
        phrase: words[from].phrase,
        optional,
        weight: stop ? 0.3 : rare ? 1.5 : 1,
      });
    }
    p.tokEnd = tokens.length;
  }

  // For each word, the cursor value at which it counts as "read"
  for (const tok of tokens) {
    for (let w = tok.from; w <= tok.to; w++) {
      words[w].readAt = tok.index + 1;
      if (words[w].tokFirst === undefined) words[w].tokFirst = tok.index;
    }
  }
  let next = 0;
  for (const w of words) {
    while (next < tokens.length && tokens[next].from <= w.index) next++;
    if (w.readAt === undefined) w.readAt = next;
  }

  for (const b of blocks) {
    const ps = b.paras.map((i) => paras[i]);
    b.tokStart = ps.length ? ps[0].tokStart : tokens.length;
    b.tokEnd = ps.length ? ps[ps.length - 1].tokEnd : b.tokStart;
  }
  // Blocks with no paragraphs (title only): place their range just before the next block that has tokens
  for (let i = blocks.length - 1, nextStart = tokens.length; i >= 0; i--) {
    if (!blocks[i].paras.length) blocks[i].tokStart = blocks[i].tokEnd = nextStart;
    else nextStart = blocks[i].tokStart;
  }

  const phraseStarts = tokens.filter((t, k) => k === 0 || t.phrase !== tokens[k - 1].phrase).map((t) => t.index);
  const speakers = [];
  for (const b of blocks) if (b.speaker && !b.both && !speakers.includes(b.speaker)) speakers.push(b.speaker);

  return { text, hash: fnv(text), targetSec, blocks, paras, words, tokens, phraseStarts, speakers };
}
