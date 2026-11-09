# How the prompter follows the voice

The prompter keeps a **cursor**: the index of the next token not yet read. Each recognition event can move it forward. A separate **display position** decides what is highlighted and where the text scrolls. It equals the cursor, except during inertia scrolling.

The code: [`public/normalize.js`](../public/normalize.js), [`public/parse.js`](../public/parse.js), [`public/matcher.js`](../public/matcher.js), and the wiring in [`public/app.js`](../public/app.js) (`onSpeech()`, `frame()`, `checkEnd()`).

## 1. Normalisation

The script and the recognition text go through the same normalisation, so they can be compared word for word. `normalizeWords(rawWords, aliasMap)` returns tokens `{ t, from, to }`; `from` and `to` are the raw word indices a token came from.

For each raw word (`piecesOf()`):

- Curly apostrophes and similar marks (`’ ‘ ʼ ` ´`) become `'`. Then everything is lower case.
- A comma between digits followed by exactly three digits is a thousands separator and is removed: `3,000,000` → `3000000`.
- Apostrophes are removed: `I've` → `ive`, `don't` → `dont`.
- The word is split on anything that is not `a–z` or `0–9`: `cross-border` → `cross`, `border`.
- A word that starts with `$` or `US$` followed by a digit gets `dollars` appended: `$2,500` → `2500`, `dollars`.
- A word with a digit followed by `%` gets `percent` appended: `45%` → `45`, `percent`.

Then aliases are applied (`applyAliases()`), then numbers are combined (`combineNumbers()`).

### Aliases

`aliases.json` maps a canonical token to the ways the recognizer writes it:

```json
{ "chillahub": ["chiller hub", "chilla hub"], "thanks": ["thank you", "thank"] }
```

`buildAliasMap()` normalises every variant (and the key itself) into a lookup key. Variants can have several words; the longest match wins (`maxLen` words at most). The matched pieces become one token with the canonical text. So `we built chiller hub` and `we built ChillaHub.` both become `we built chillahub`.

The page loads `aliases.json` once, at boot. Reload the page after editing it.

### Numbers

`combineNumbers()` merges a run of number words and digits into one token:

| Text | Tokens |
| --- | --- |
| `twenty years`, `20 years` | `20`, `years` |
| `three million`, `3 million`, `3,000,000` | `3000000` |
| `two thousand five hundred dollars`, `$2,500` | `2500`, `dollars` |
| `five hundred and twelve` | `512` |
| `forty five percent`, `45%` | `45`, `percent` |
| `from 6 to 62` | `from`, `6`, `to`, `62` |
| `one two` | `1`, `2` |

Rules: digits can only start a run. A unit (1–9) can follow nothing, a tens word, `hundred` or a scale word. A teen or tens word can follow nothing, `hundred` or a scale. `hundred` follows a unit, a teen or digits. Scales (`thousand`, `million`, `billion`) must get smaller along the run. `and` is kept inside a run only between `hundred` or a scale and a following unit, teen or tens word. A run cannot start with `hundred` or a scale, so `a hundred` stays `a`, `hundred`.

Not handled: decimals (`1.5` → `1`, `5`), ordinals (`1st` and `first` do not match), and years read in pairs (`nineteen eighty four` → `19`, `84`).

### Similarity

`similarity(a, b)` returns:

| Value | When |
| --- | --- |
| 1 | identical tokens |
| 0.8 | both in one confusion group: `to` / `too` / `2`, or `for` / `4` |
| 0 | otherwise, if either is a number |
| 0.7 | the shorter has ≥ 3 letters, the lengths differ by ≤ 2, and one starts with the other (`store` / `stores`) |
| 0.7 | both have ≥ 4 letters and `1 − edit distance / longer length ≥ 0.75` (`competitors` / `competitor`) |
| 0 | otherwise |

## 2. Tokens and weights

`parseScript()` normalises each paragraph and gives every token a weight. A heavier token is a better anchor.

| Weight | Tokens |
| --- | --- |
| 1.5 (rare) | Numbers. Words that are a speaker name (this includes `both`, `all` or `together` when the script uses them as speakers). Words with a capital letter after the first letter (`ChillaHub`, `TikTok`, `eBay`, `AI`). Capitalised words that do not start a sentence (`Amazon` mid-sentence). Alias keys (`thanks`, `percent`, `dollars`, …). |
| 1 (normal) | Every other word. |
| 0.3 (stop) | The 56 words in `STOP_WORDS` (`a`, `the`, `and`, `of`, `to`, `we`, `i`, `im`, …), unless the token is rare. |
| 0.3 (optional) | A number like `1.` or `1)` at the start of a line. |

`I`, `I'm`, `I've` are never rare. A word starts a sentence when it is the first word of a line or the previous word ends with `.`, `?`, `!` or `:` (closing quotes and brackets allowed).

Optional tokens match when read and cost nothing when skipped. They never count as missed, never count in the estimate, and never serve as an anchor: matching `for` to a skipped `4.` would pull the position past a word.

## 3. Local alignment: `alignTail()`

On each recognition event `app.js` `onSpeech()` takes the last 24 raw words of each recognition alternative, normalises them, and keeps the last 8 tokens: the **tail**. Chrome returns up to 3 alternatives (`maxAlternatives = 3`), so there can be up to 3 tails. Each is aligned; the highest score wins.

`alignTail(tokens, cursor, tail, ahead, dist)` is a local alignment (Smith–Waterman style) of the tail against a window of the script:

- The window runs from `cursor − tail length − 4` to `cursor + ahead`. The part behind the cursor lets a tail that overlaps already-read words still align.
- Scores never drop below 0, so an alignment can start anywhere.

| Step | Score |
| --- | --- |
| Exact match | + the token's weight |
| Near match (similarity 0.7 or 0.8) | + similarity × min(weight, 1). Only exact matches earn the rare bonus. |
| Substitution that does not match | − `MIS` = 0.5 |
| Extra recognised word | − `INS` = 0.35 |
| Skipped script word | − `gapCost()`: 0 optional, 0.15 stop, 0.45 normal, 0.6 rare |

A candidate end is a cell that ends with a match. Its score is adjusted:

```
score = cell score − INS × (tail words after the match) − dist × max(0, end − cursor)
```

The first penalty makes the alignment end at the newest words: the end is the word just read. The second is the distance penalty, `DIST` = 0.03 per token beyond the cursor. For the same words, the nearer copy wins.

The result is `{ end, score, content, rare, matched }`. `content` counts matched tokens with weight ≥ 1, `rare` those with weight > 1, and `matched` lists their indices.

## 4. Windows: normal, wide, far

`matcher.update(tails, now, { wide, far })` picks the window:

| Mode | When (`app.js`) | Ahead | Distance penalty |
| --- | --- | --- | --- |
| normal | otherwise | 25 tokens | 0.03 |
| `wide` | for 3 s after a recognition restart, and for 1.5 s after any inertia scrolling | 40 tokens | 0.03 |
| `far` | no advance for more than `FAR_AFTER` = 2000 ms | 60 tokens | 0.01 (`DIST / 3`) |

`wide` exists because a restart drops a few words: the first tail of a new session is short, and the reader is already further on. `far` covers a stretch where recognition returned garbage and the reader moved well ahead.

## 5. Acceptance

`update()` accepts the best alignment when one of these holds (`ahead` = `end − cursor`):

1. `content ≥ 2` and `score ≥ 1.5`, anywhere in the window;
2. `rare ≥ 1`, `score ≥ 1.2` and `ahead ≤ 3`;
3. `content ≥ 1`, `score ≥ 0.9` and `ahead ≤ 1`.

So a single stop word never moves the cursor, a single normal word moves it only to the next token or so, and a single name or number can move it a few tokens. Two content words can move it anywhere in the window.

Accepted matched tokens are marked in `matched[]`, also when they are behind the cursor. Then the cursor moves to `end + 1`. Every token passed gets the current time in `times[]`.

## 6. The unique-word rescue: `freshUnique()`

In `far` mode only, `update()` also looks at the last 3 words of each tail, newest first. If one of them occurs exactly once in the whole script, and that token lies ahead of the cursor, the reader is assumed to have reached it:

- normal words count only within 15 tokens of the cursor;
- rare words (names, numbers) count within 40 tokens;
- the token must have weight ≥ 1 and not be optional.

The rescue wins when the alignment was not accepted, or when it ends before the unique word. Only that one token is marked matched; the tokens passed on the way count as missed.

Why the two limits: in garbled recognition, common words that happen to occur once in the script would otherwise yank the cursor twenty-odd words ahead. Names and numbers are rarely produced by accident.

## 7. Never backwards

The cursor only moves forward. If the best alignment ends at or behind the cursor, nothing moves. Stutters, repeated words and re-read sentences therefore never drag the position back. The design assumes that after a misread you discard the take (hold the right button) and start again.

Only the wheel and the arrow keys move back. `matcher.set()` marks tokens it jumps over forward as `manual` (shown yellow on the review page, no time recorded). Moving back just resets the cursor.

## 8. Inertia scrolling

Recognition sometimes goes quiet while someone is clearly talking. `app.js` `frame()` then moves the display position on its own:

- It starts when the VAD says someone is speaking and nothing matched for `INERTIA_AFTER` = 700 ms.
- It moves at the current block's speaker speed: `stats.json` median, or `DEFAULT_WPM` = 130 wpm, as tokens per second.
- It runs for at most `INERTIA_MAX` = 3000 ms in total, then waits in place. The budget resets when the matcher advances or the wheel moves.
- It never runs more than `INERTIA_LEAD` = 15 tokens ahead of the cursor, or past the end.
- While it runs, the next alignments use the `wide` window.

Inertia changes only the display. The cursor stays where recognition put it. When recognition advances again, the display jumps to the cursor, which may be a step back if inertia overshot.

## 9. End detection

No automatic stop happens in the first `MIN_TAKE` = 10000 ms of a take. After that, three rules can end it with `endedBy: "auto"`:

1. **Last line heard** (`endHeard()`, checked on each recognition event). The cursor has reached the second-to-last block that has words, the last block has 1 to 3 tokens with weight ≥ 1, and all of them are among the last 4 tokens of a tail. The cursor jumps to the end (`matcher.jump()`; unmatched words count as missed) and the take stops `END_HOLD` = 2000 ms later.
2. **Cursor at the end** (`checkEnd()`, every frame). The cursor passed the last token. The take stops 2000 ms later.
3. **Quiet near the end** (`checkEnd()`). The cursor is within 3 tokens of the end, the VAD has heard no speech and the cursor has not advanced for `END_QUIET` = 3500 ms. The take stops at once.

Rule 1 exists because the last block is often recognised as garbage, and in real takes the cursor lagged 20–30 words behind when the reader said "Thanks". The last block's words must not occur in the second-to-last block, or rule 1 fires too early. Rule 3 takes the smaller of the two quiet times: with a badly calibrated noise floor the VAD may always say "not speaking".

Rule 1 needs at least two blocks. A script without speaker lines is a single block, so it ends by rules 2 and 3. Tips for writing a reliable ending: [script-format.md](script-format.md#a-reliable-ending).

## Speeds and the estimate

`measureWpm(parsed, times)` measures each speaker's speed in a take from `tokenTimes`:

- A block's duration runs from its first timed token to the first timed token of the next block. Pauses between sentences and speaker changes are included. An earlier version left out pauses over 1.5 s and underestimated real takes by 13 to 26 s.
- Skipped: `Both`, `All`, `Together` and unnamed blocks, the last block (no next block), blocks under 1 s, and blocks where fewer than 80% of tokens have a time (most were wheel-skipped).
- Speed = spoken tokens ÷ minutes, summed over the speaker's blocks, rounded to 0.1.

The server keeps the last 5 values per speaker and uses the median ([architecture.md](architecture.md#speed-statistics)). The estimate formula is in [script-format.md](script-format.md#the-estimate).

## What the tests simulate

[`test/simulate.mjs`](../test/simulate.mjs) `simulate(parsed, opts)` pretends to read the script aloud. It emits the ever-growing session text that Chrome produces, one event per word, each with `truth`: the number of tokens really read at that moment.

| Option | Default | Effect |
| --- | --- | --- |
| `wpm` | 140 | Reading speed. 250 ms extra after a sentence, 600 ms between blocks. |
| `subs` | `DEFAULT_SUBS` | Mishearings and rewritten numbers: ChillaHub → "chiller hub", TikTok → "tick tock", eBay → "e bay", 45% → "forty five percent", 3 → "three". |
| `restartEvery`, `drop` | 40, 3 | A recognition restart every 40 words. The next 3 words are lost and the session text starts again. |
| `speakNumbering` | false | Read `1.` aloud as "1". |
| `extra` | `{}` | An extra word after a given word: a stutter. |
| `garble` | null | Word range `[from, to)` replaced by unrelated words, as with a strong accent. |
| `timings`, `delay` | null, 350 | Follow word timestamps of a voice track; each word is reported 350 ms after it ends. |

[`test/matcher.test.mjs`](../test/matcher.test.mjs) feeds the events to a matcher the way `app.js` does (`wide` for 3 s after a restart, `far` after 2 s without progress). It runs on `test/fixtures/sample-two.md`, every `examples/*.md`, and your `script.md` when it exists. Every run asserts that the cursor never moves backwards and is never more than 1 token ahead of `truth`. The first four also check that the cursor ends at the last word heard (a restart can drop the final words).

| Test | Simulation | Passes when |
| --- | --- | --- |
| read exactly | no mishearings, no restarts | at most 3 tokens behind; 90% of moments within 1 |
| mishearings and restarts | defaults | at most 8 behind; 85% within 2 |
| more restarts | 5 words dropped every 25 | at most 10 behind; 75% within 2 |
| numbering read aloud | `speakNumbering` | at most 8 behind; 85% within 2 |
| 20 words of noise | `garble` at 40% of the script, no restarts; skipped for scripts under 60 words | reaches the last token; 10 to 20 events after the noise, at most 3 tokens behind |

Other tests in the same file: a stutter does not pull the cursor to a later copy of the word; a single stop word does not jump; a sentence not in the script does not move the cursor; wheel moves are marked manual; `endHeard()` waits for the second-to-last block; the timed simulation and the sound check simulation.

### Real-take replays

Three more tests replay the recognition logs of two real takes, recorded with a laptop's built-in microphone by two speakers whose accented passages came out as noise. The logs are private and not in the repo. Put `real-take01.json` and `real-take02.json` in `test/private/` to run them; without them the tests skip with "private real-take data not present (test/private/)".

They check that take 01 follows all the way to "Thanks", that take 02's ending is recognised although its last block came out as noise and the live run stuck there, and that take 01's measured speeds give an estimate within 6 s of its real length.

A replay file has `scriptSnapshot`, `durationMs`, `tokenTimes` and `events` (`t`, `text`, `final`). A take JSON holds the same data, with the events under `transcriptEvents`. New takes also store `tail`: the exact tokens used for alignment, so a replay sees what the live run saw. The two private logs predate that field, so their replay rebuilds the tail from the final results and the latest text, and sees less than the live run did.

## Known weak spots

- **Strong accents.** Recognition returns fluent but wrong words. No alignment passes and the cursor waits. Inertia covers at most 3 s and 15 tokens. After 2 s the window widens to 60 tokens and the unique-word rescue may catch up. Otherwise the reader has to use the wheel. The review page shows long red runs.
- **It does not know who speaks.** It matches words, not voices. The script order decides whose turn it is. Two people talking at once produce mixed text.
- **Off-script talk** rarely moves the cursor, but it can if it shares two content words with the next lines.
- **Re-reading** never moves the text back. Use the wheel, or discard and start again.
- **Repeated text.** When the same words occur twice within the window, the nearer copy wins. The unique-word rescue ignores words that occur more than once.
- **Lines of stop words only** (`And so are we.`) cannot move the cursor by themselves. They are passed when the next content words match.
- **Numbers and spelling.** See the limits in [Numbers](#numbers). Letters outside `a–z` split words (`café` → `caf`). Text in other scripts produces no tokens at all: it is shown but never followed.
- **Two microphones.** Recognition always uses the system default microphone. The VAD and the recording use the one picked on the sound check page. If they differ, inertia and the quiet stop listen to a different microphone than recognition.
- **Internet.** Without a connection recognition stops; the wheel and the keys still work.
