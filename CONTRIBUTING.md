# Contributing

Thanks for helping. This page covers the tests, the docs rules and the few things that must never be committed. How the code works: [`docs/`](docs/README.md).

## Setup

You need Node.js 22 or newer and desktop Chrome. The server and the page have no dependencies and no build step: `npm start` and `npm test` work without `npm install`. `npm install` only adds `playwright-core`, which `npm run docs:media` needs.

Line endings are LF (`.gitattributes`).

## Tests

```sh
npm test
```

This runs `node --test "test/*.test.mjs"`:

| File | What it checks |
| --- | --- |
| `test/parse.test.mjs` | The script format rules. |
| `test/normalize.test.mjs` | Lower case, apostrophes, numbers, aliases, similarity. |
| `test/matcher.test.mjs` | Simulated reading of `test/fixtures/sample-two.md`, every `examples/*.md` and your `script.md`, plus real-take replays. See [docs/matching.md](docs/matching.md#what-the-tests-simulate). |
| `test/server.test.mjs` | The Host/Origin check, first start, chunk upload, finish naming, `.part` recovery. Each test starts its own server on a free port in a temporary folder. |
| `test/shortcuts.test.mjs` | `public/shortcuts.js` against the reference behaviour of every key and button. |
| `test/docs.test.mjs` | The UI text table and the READMEs (below). |
| `test/skills.test.mjs` | The agent skills (below). |

Some tests skip on purpose:

- The real-take replays need private recordings in `test/private/`. Without them they skip with "private real-take data not present (test/private/)".
- One recovery test needs ffmpeg. Without it, it skips with "ffmpeg not installed".
- The 20-words-of-noise simulation skips scripts under 60 words.

If `script.md` exists, the simulation also runs on it. A failure there can come from the script rather than the code. [docs/matching.md](docs/matching.md#known-weak-spots) explains what the prompter struggles with, and `npm run estimate` shows how the script was parsed.

GitHub Actions runs `npm test` with Node 22 on Ubuntu, macOS and Windows on every push and pull request (`.github/workflows/test.yml`).

## Trying it without a microphone

Start the server (`npm start`) and open:

- <http://localhost:5178/?sim=demo.json>: the prompter follows simulated recognition of the demo voice. No microphone, no recording. Start a take as usual. It only matches while `script.md` is the demo script (`examples/demo-two-speakers.md`); `run1.json` matches `test/fixtures/sample-two.md`. Make a fixture for any script with `npm run fixture -- <script.md> <name.json>`.
- <http://localhost:5178/?sim=demo.json&stage=setup>: starts on the sound check page. <b>Test recognition</b> plays the fixture's sentences. The camera opens if Chrome already has permission.

Fixtures live in `test/fixtures/`. To make one from another script:

```sh
npm run fixture -- examples/three-speakers.md three.json
npm run fixture -- <script> <name.json> --timings <words.json>   # follow a voice track's word timestamps
```

Then open `?sim=three.json`. A fixture made from your own `script.md` contains its words; do not commit it.

## UI text

All text the page shows lives in `public/i18n.js`, in `STRINGS.en` and `STRINGS.zh`.

- Add every new key to both languages, with the same `{placeholders}`.
- Show text with `t(key, vars)`, `bind(el, key, vars)` or a `data-i18n` attribute in `index.html`. Bound text re-translates when the language switches.
- No other file under `public/` may contain Chinese text. The only exception is the 中文 button in `index.html`.
- A new server error code `E_SOMETHING` in `server.mjs` needs an `err.E_SOMETHING` key.

`test/docs.test.mjs` checks the keys, placeholders and server codes, and that `server.mjs`, `public/*.js` and `index.html` (except the 中文 button) contain no Chinese text.

## Mouse and keyboard controls

Every control is one entry in `SHORTCUTS` in `public/shortcuts.js`. To add or change one:

1. Edit the entry. Its `action` must exist in `ACTIONS` in `public/app.js`. Its `labelKey` needs text in both languages.
2. Run `npm run docs:tables`. It rewrites the Controls tables in `README.md` and `README.zh-CN.md`.
3. If you change existing behaviour on purpose, update the reference handlers in `test/shortcuts.test.mjs`.

## Docs rules

- The Controls tables between `<!-- shortcuts:start -->` and `<!-- shortcuts:end -->` are generated. Do not edit them by hand; run `npm run docs:tables`.
- Quote UI labels as `<b>…</b>`, exactly as they appear in `public/i18n.js`: English labels in `README.md`, Chinese labels in `README.zh-CN.md`. A `{placeholder}` can stand for any value, and a trailing key hint (`E`, `Ctrl+S`, `Esc`) can be left out.
- Change both READMEs together.
- Every `docs/media/….png` a README references must exist.
- Write short factual sentences. Give numbers with the name of the constant they come from.

`test/docs.test.mjs` enforces the first, second and fourth rules for both READMEs.

## Agent skills

The four skills exist twice: `.agents/skills/` (Codex) and `.claude/skills/` (Claude Code). Edit the copy in `.agents/skills/<name>/SKILL.md`, then copy it over:

```sh
cp .agents/skills/<name>/SKILL.md .claude/skills/<name>/SKILL.md
```

`test/skills.test.mjs` checks that both folders hold the same four skills, that the copies are byte-identical, that each frontmatter has `name` (the folder name) and a `description` over 40 characters, that `CLAUDE.md` contains only `@AGENTS.md`, and that `AGENTS.md` mentions every skill. A new skill also goes into `SKILLS` in that test and into `AGENTS.md`.

## Never commit

- `script.md`, `takes/`, `backups/`, `stats.json`: the user's own words, recordings and speeds.
- `test/private/`: private real-take data.
- `docs/media-out/`: generated demo videos. They are uploaded to GitHub, not committed.

All of them are in `.gitignore`. Check `git status` before you commit anyway.

## Demo screenshots and videos

```sh
npm install
npm run docs:media
```

This needs Chrome and ffmpeg. On macOS and Linux also pass fonts for the captions (`--font-en`, `--font-zh`, or the `DOCS_MEDIA_FONT_*` variables). How it works: [docs/demo-media.md](docs/demo-media.md).

## Commits

Write a short English subject in the imperative, without a final period, for example `Fix server and upload bugs found before release`. Add a body when the reason is not obvious.

## Reporting bugs

Open an issue with the bug report form. It asks for your OS, Chrome version and recognition language. A screenshot of the review page and the take's `.json` help most. The take JSON contains your whole script and everything the recognizer heard, so remove private text before you attach it.
