---
name: new-script
description: Load a new script into voice-teleprompter. Use when the user pastes or sends text they want to read on the teleprompter, or asks to change, format or check their script.
---

# Load a new script

The script is `script.md` in the repo folder. The open page reloads it by itself when the file changes. If a take is being recorded, the page waits and reloads it after the take.

1. Read `docs/script-format.md` for the full format. In short:
   - `Name: text` starts a speaker's block. `Name:` alone puts the text on the following lines.
   - `Name — Title` starts a block with a title (space, dash, space). The title is shown but not read.
   - `Both:` (also `All:` or `Together:`) is read together.
   - Each line is a paragraph. A leading `1.` is shown but does not need to be read.
   - A first line like `Target: 1:30` sets the time limit shown on the page. Without it, no limit is shown.
   - Lines that start with `//` are comments: not shown, not read.
   - The text must be English.
2. Keep every word exactly as the user wrote it. Only fix the format: speaker labels, line breaks, the Target line. If a speaker name is missing, ask; do not guess.
3. Before writing, check whether a take is being recorded: a `.part` file in `takes/` that is still growing. If so, wait.
4. If `script.md` exists, copy it to `backups/script-YYYYMMDD-HHMMSS.md`. Then write the new `script.md`.
5. Run `npm test`. The simulation tests also run on `script.md` and check that the prompter can follow it to the end. Report any failure.
6. Report back, in the user's language:
   - the spoken word count and the estimated length. The page shows the same estimate. It uses each speaker's measured speed from `stats.json`, or 130 words per minute when there is none.
   - whether it is over the Target;
   - suspected typos or inconsistencies, each quoted with a suggested fix. Do not apply them: the user reads the script word for word, so they decide.
