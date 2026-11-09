# Script format

The script is `script.md`, a plain text file. The parser is `parseScript()` in [`public/parse.js`](../public/parse.js). Annotated examples: [`examples/format-reference.md`](../examples/format-reference.md), [`examples/solo.md`](../examples/solo.md), [`examples/three-speakers.md`](../examples/three-speakers.md). `npm test` parses every file in `examples/`.

```text
Target: 1:30
// A note for you. Not shown, not read.

Alex: Hi, I'm Alex.
Sam:
I'm Sam.
Each line is its own paragraph.

Alex — How it works
1. Click once to start.
2. Hold the left button to stop.

Both: Thanks for watching!
```

## Order of processing

1. Line endings become `\n`. Every line is trimmed.
2. Comment lines are dropped.
3. If the first remaining line is a `Target:` directive, it is read and dropped.
4. Speaker names are collected from the whole script.
5. Lines become blocks and paragraphs; words become tokens.

Markdown is not interpreted. `#`, `**` and `-` bullets are shown as typed.

## Comments

A line whose first characters (after leading spaces) are `//` is a comment. It is not shown, not read and not counted. `//` in the middle of a line is ordinary text.

```text
// a comment
   // also a comment
Visit our site // this "//" is shown as text
```

## Target

The first line that is not empty and not a comment can set a time limit as minutes and seconds. The page then shows "Estimate m:ss / m:ss" and turns it red when the estimate is longer. Without it, no limit is shown.

The line must match `^target\s*[:：]\s*(\d{1,3}):([0-5]\d)$`, ignoring case: the word `target`, an ASCII or full-width colon, 1 to 3 digits of minutes, an ASCII colon, and two digits of seconds (00–59). Nothing may follow.

| Line | Limit |
| --- | --- |
| `Target: 1:30` | 90 s |
| `target: 0:45`, `TARGET:0:45`, `Target : 0:45` | 45 s |
| `Target：1:30` (full-width colon after the word) | 90 s |
| `Target: 01:30` | 90 s |
| `Target: 10:00` | 600 s |

These are not directives. They stay in the script as spoken text (or as a speaker line, see below):

| Line | Why |
| --- | --- |
| `Target: 90` | no `m:ss` |
| `Target: 1:75` | seconds over 59 |
| `Target: 1:5` | one digit of seconds |
| `Target: 1.30` | dot instead of colon |
| `Target: 1：30` | full-width colon between minutes and seconds |
| `Target: 1:30 min`, `Target: 1:30.` | text after the time |
| `Target: 1:30:00` | hours are not supported |
| `Target: one minute` | not digits |
| `Target 1:30` | no colon after the word |
| `Target: 1:30` on any later line | only the first non-comment line counts |

## Speaker lines

A speaker line starts a new **block**. It has one of three forms:

| Form | Example | Meaning |
| --- | --- | --- |
| `Name: text` | `Alex: Hi, I'm Alex.` | New block for Alex. The text is its first paragraph. |
| `Name:` | `Sam:` | New block for Sam. The text starts on the next line. |
| `Name — Title` | `Alex — How it works` | New block for Alex with a title. The text starts on the next line. |

The pattern is `LINE_RE`:

```
^([A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*)?)\s*(?:[:：]\s*(.*)|\s+[—–-]+\s*(.*))$
```

- The name is one or two words of ASCII letters, each starting with a capital: `Alex`, `Mary Ann`, `ALEX`.
- Not names: `alex`, `Mary-Ann`, `O'Brien`, `José`, `Dr. Lee`, `Ana2`, `Mary Ann Lee`. Such lines are ordinary text.
- The colon can be ASCII `:` or full-width `：`, with or without spaces around it.
- The dash form needs at least one space before the dash. The dash can be `—`, `–` or `-`, also repeated (`--`). The space after it is optional. `Alex—Title` is ordinary text.
- Names are case-sensitive. `Alex` and `ALEX` are two different names.

### When a line counts as a speaker

A line that matches the pattern starts a block only when its name is a speaker. A name is a speaker when at least one of these holds:

1. It is `Both`, `All` or `Together` (any case after the capital: `BOTH` works, `both` does not match the pattern).
2. It appears at least once in the bare `Name:` form or the dash form.
3. It starts at least two lines in the script, in any form.

Otherwise the whole line, including `Name:`, is spoken text in the current block. This keeps lines like `Upload: put your script in script.md.` as text.

Consequences:

- A speaker with only one line must use the bare form, with the text on the next line:

  ```text
  Guest:
  Hello there.
  ```

  `Guest: Hello there.` on its own is read as text.
- The dash form always counts. A spoken line like `Note - remember this` becomes a block for a speaker `Note` titled `remember this`. To keep it as text, remove the space before the dash: `Note- remember this`.

### Text without a speaker

Lines before the first speaker line form a block with no speaker. It has no name tag, uses the neutral grey, and shows as "(no speaker)" in the editor. A script with no speaker lines at all is one such block (see [`examples/solo.md`](../examples/solo.md)).

## Titles

`Name — Title` gives the block a title. The title is shown above the block in small grey type, in the editor, and on the review page. It is never read and never matched. It is hidden during the countdown and the recording, but keeps its space so the text does not jump.

`Alex —` with nothing after the dash starts a block without a title. A title line followed directly by another speaker line makes a block with no words; it takes no time.

## Both, All, Together

`Both:`, `All:` and `Together:` start a block that everyone reads together.

- The name tag and cue use the neutral grey `#555`.
- These names are not in the list of speakers, so the sound check does not test them.
- In the estimate the whole block counts 1 s (`BOTH_SEC`), whatever its length.
- No reading speed is measured from them.

## Paragraphs and phrases

Each non-empty line is a paragraph. Blank lines have no meaning: a block holds every line until the next speaker line. Words are split on spaces and shown as typed.

A **phrase** ends after a word ending in `,` `.` `:` `;` `?` or `!` (closing `"` `”` `’` or `)` may follow), and at the end of each line. One wheel step, or one arrow key, moves one phrase. Moving back first goes to the start of the current phrase, then to the phrase before.

A **sentence** ends after `.` `?` `!` or `:`. This decides which capitalised words count as names: a capitalised word that does not start a sentence is matched as a name. See [matching.md](matching.md#2-tokens-and-weights).

## Leading numbers

A first word of a line that is digits followed by `.` or `)` (`1.`, `12)`) is shown but optional. The prompter follows whether it is read aloud or not. It never counts as missed and is not counted in the estimate. `(1)`, `#1` or `1:` are not optional numbers. A leading `1.` forms its own phrase.

After `1)` the next capitalised word counts as a name, because `)` does not end a sentence. After `1.` it does not.

## Speaker colours

`speakerColors()` in [`public/prompter.js`](../public/prompter.js) gives each speaker a colour in order of first appearance:

| Order | Colour |
| --- | --- |
| 1st | `#1f6fb5` blue |
| 2nd | `#c2410c` orange |
| 3rd | `#7c3aed` purple |
| 4th | `#047857` green |
| 5th and later | the same four again, in order |

`Both`, `All`, `Together` and blocks without a speaker use `#555`. Colours mark only names: the name tags, the cue, the sound check list, the editor and the review page. The prompter text itself stays grey and black.

## English only

Recognition offers en-US, en-AU and en-GB. Normalisation keeps only `a–z` and `0–9`: accented letters split a word (`café` is matched as `caf`), and text in other scripts produces no tokens. It is shown but never followed, and it takes no time in the estimate.

## The estimate

`estimate()` in [`public/estimate.js`](../public/estimate.js):

```
total = 1.5 s + sum over blocks + 2 s
block = spoken tokens ÷ the speaker's wpm × 60
        Both / All / Together block: 1 s
        block with no words: 0 s
```

- 1.5 s (`LEAD_SEC`) is the time before the first word. 2 s (`TAIL_SEC`) is the wait before the automatic stop. The goal is the length of the recorded file.
- Spoken tokens are the normalised tokens without optional numbers. A number is one token: `3 million` is 1, `45%` is 2 (`45`, `percent`), `cross-border` is 2.
- The speed is the speaker's median from `stats.json`, else `DEFAULT_WPM` = 130. A block without a speaker always uses 130.
- The page shows the total in the hint bar and on the sound check page. The editor also shows the seconds of each block and each speaker's speed.

Example, with no measured speeds (130 wpm for everyone):

```text
Alex: Hi, I'm Alex.                     3 tokens → 1.4 s
Sam: I'm Sam.                           2 tokens → 0.9 s
Alex: We make short videos together.    5 tokens → 2.3 s
Sam: This one is about the prompter.    6 tokens → 2.8 s
Both: Thanks for watching!              Both block → 1 s
```

Total: 1.5 + 8.4 + 2 = 11.9 s, shown as 0:12. With Alex at 120 wpm and Sam at 150 wpm in `stats.json` it is 11.7 s.

## A reliable ending

The take stops by itself 2 s after the last line is heard, if the script ends the right way (rule 1 in [matching.md](matching.md#9-end-detection)). For that:

- Put the last line in its own block, for example `Both: Thanks for watching!`.
- Keep it to at most 3 words that are not stop words. `Thanks for watching!` has two: `thanks` and `watching`.
- Use words that are not in the block before it, and preferably nowhere else. The rule fires as soon as the text reaches the second-to-last block and those words are heard.
- Use words the recognizer gets right. They must be heard exactly, among the last 4 recognised words. `Thank you` works: `aliases.json` maps it to `thanks`. Brand names often fail.

A script without speaker lines is one block, so this rule cannot apply. Such a take stops 2 s after the last word is matched, or after 3.5 s of quiet within 3 words of the end. To use the rule anyway, end with a block like `All: Thanks for watching!`.

No take stops by itself in its first 10 s.

## Other tips

- The sound check tests each speaker's first line with words. It turns green at 80% of that line's words. A short first line per speaker is easier to check.
- Names the recognizer keeps mishearing go in `aliases.json`. See [recording-and-files.md](recording-and-files.md#aliasesjson).
