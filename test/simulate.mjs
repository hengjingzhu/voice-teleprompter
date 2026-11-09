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

/**
 * @returns {{ events: Array<{t:number,text?:string,final?:boolean,restart?:boolean,truth:number}>, speech: number[][] }}
 *   truth = the real reading position at that moment (tokens fully read); the tests compare against it
 */
export function simulate(parsed, opts = {}) {
  const {
    wpm = 140, restartEvery = 40, drop = 3, speakNumbering = false, subs = DEFAULT_SUBS, start = 600,
    extra = {}, // { word index: an extra word said after it }, to fake a stutter
    garble = null, // [from, to) word indexes: recognition is pure noise here (as with a strong accent)
  } = opts;
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
