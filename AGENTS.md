# voice-teleprompter — notes for coding agents

This file is for Claude Code, Codex and other coding agents. People usually hand you this repo and ask you to install it, start it, load a new script, or cut a recording. Follow these notes.

## What it is

A teleprompter that runs in Chrome. It listens to the speakers, scrolls the script as they read it, shows a `Name →` cue before the next speaker, and records the webcam. A small Node server (no dependencies) serves the page and saves the recordings.

## Layout

- `server.mjs` — local server on `http://localhost:5178` (`PORT` env var changes it). Listens on 127.0.0.1 only.
- `public/` — the page: `index.html`, `styles.css`, `app.js` (screens and controls), `parse.js` (script format), `matcher.js` (follows the voice), `normalize.js`, `estimate.js`, `prompter.js` (scrolling text), `editor.js`, `recorder.js`, `speech.js` (recognition), `vad.js` (voice activity), `i18n.js` (English and Chinese UI text), `shortcuts.js` (mouse and keyboard table).
- `examples/` — example scripts. `demo-two-speakers.md` is copied to `script.md` on first start.
- `script.md` — the user's own script. Not in git.
- `takes/` — recordings (`take-NN-YYYYMMDD-HHMMSS.mp4`) and a `.json` per take with the recognition log (not for `-recovered` takes). Not in git.
- `aliases.json` — names the recognizer keeps mishearing.
- `stats.json` — each speaker's measured reading speed. Not in git.
- `test/` — `npm test`. `test/private/` holds private real-take data and is not in git; those tests skip when it is missing.
- `scripts/` — `docs-tables.mjs` writes the controls tables in the READMEs from `public/shortcuts.js` (`npm run docs:tables`); `docs-media/` makes the screenshots and demo videos (`npm run docs:media`).
- `docs/` — how it works (architecture, matching, script format, files).

## Requirements

- Node.js 22 or newer.
- Google Chrome on a desktop computer. Speech recognition uses Chrome's Web Speech API, which sends the microphone audio to Google, so it needs internet.
- ffmpeg is optional. With it, recordings are converted to a standard MP4. Without it, the browser's own file is kept. The trim steps in the `pick-and-trim` skill need it.

## Commands

- Start: `npm start`. It keeps running; start it in the background and leave it running while the user records. Then open `http://localhost:5178` in Chrome.
- Test: `npm test`. Run it after any code change and after loading a new script (the simulation tests also run on `script.md` when it exists).
- Check a script: `npm run estimate` (or `npm run estimate -- path/to/file.md`) prints the speakers it found, the word count and the estimated length.

## Rules

1. Never commit or push `script.md`, `takes/`, `backups/`, `stats.json` or `test/private/`. They hold the user's own words and recordings.
2. When you load or format a script, never change the user's words. Fix only the format. List suspected typos and let the user decide.
3. Before you restart the server or touch the browser: check `takes/` for a `.part` file that is still growing. If there is one, a take is being recorded. Wait. Never reload the user's open tab yourself; ask them to reload it after their take.
4. Ask before installing anything (Node, ffmpeg, Chrome). Say what is missing and which command you would run (`winget` on Windows, `brew` on macOS, the package manager on Linux).
5. Scripts must be in English. The recognizer offers en-US, en-AU and en-GB.

## Skills

Task steps live in skills (`.agents/skills/` for Codex, `.claude/skills/` for Claude Code; the two copies are identical). If your agent did not load them (for example, the repo was cloned during this session), open the `SKILL.md` and follow it:

- `install-and-start` — check the tools, start the server, open the page, tell the user what to do next.
- `new-script` — turn pasted text into a script, check it, estimate its length.
- `pick-and-trim` — list the takes, cut the chosen one, check the last word is not cut off.
- `fix-mishearings` — find names the recognizer keeps getting wrong and add them to `aliases.json`.
