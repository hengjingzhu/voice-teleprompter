# Demo screenshots and videos

`npm run docs:media` makes the README screenshots and the demo videos from the source assets in `docs/media-src/`. It runs the real page in Chrome, records it, and adds the voice. Nothing is edited by hand.

## What it makes

For each UI language (`en`, `zh`). The spoken script is English in both.

| File | Committed | What it shows |
| --- | --- | --- |
| `docs/media/<lang>/setup.png` | yes | Sound check: camera preview, calibrated noise floor, both check lines green. |
| `docs/media/<lang>/ready.png` | yes | The prompter before a take, with the hint bar. |
| `docs/media/<lang>/recording.png` | yes | Mid-take, with the next-speaker cue. |
| `docs/media/<lang>/review.png` | yes | The review page after a whole take: summary, red and yellow words. |
| `docs/media/<lang>/editor.png` | yes | The editor with a new sentence, its preview and the estimate. |
| `docs/media/<lang>/<clip>-poster.png` | yes | One frame of each video, for when the video does not load. |
| `docs/media-out/<lang>/follow.mp4` | no | Click, 3-2-1, the prompter follows the voice across speaker changes. |
| `docs/media-out/<lang>/setup.mp4` | no | Open the camera, calibrate, test recognition, start prompting. |
| `docs/media-out/<lang>/controls.mp4` | no | Hold the right button 1 s (discard, new countdown), then hold the left button 1 s (stop and save). |
| `docs/media-out/<lang>/editor.mp4` | no | E opens the editor, a sentence is typed, Esc and the confirm dialog close it. Silent. |
| `docs/media-out/<lang>/hero.mp4` | no | The two speakers on the left, the prompter following them on the right. As long as `opening.mp4`. |
| `docs/media-out/<lang>/hero-vertical.mp4` | no | The same for phones, 1080×1920: the two speakers on top, the prompter below in a portrait window. As long as `opening.mp4`. |
| `docs/media-out/<lang>/<clip>-sheet.jpg` | no | Contact sheet: one frame per second, with its time. |

`docs/media-out/` is in `.gitignore`. The MP4s go to GitHub as attachments (below).

## Source assets

`docs/media-src/` is committed and stays under 10 MB.

| File | What it is |
| --- | --- |
| `demo-script.md` | The demo script. The same text as `examples/demo-two-speakers.md`. |
| `voice-full.flac` | The whole script read aloud by the two AI voices, mono 48 kHz. FLAC is lossless; `voice-full.wav` also works. |
| `timings.json` | Word times of the voice: `[{ word, startMs, endMs, script? }]`. `script` is the script's spelling when the transcriber wrote the word differently (`ChillerHub` → `ChillaHub.`). |
| `lines.json` | Each script line: `{ speaker, text, startMs, endMs }`. Either an array or `{ lines: [...], opening: { endMs } }`. |
| `opening.mp4` | A static webcam shot of both people saying the first lines of the script (0–18.3 s), lip-synced to the start of the voice. 1280×720. Its length sets the length of the hero clips. It is two generations joined where the speaker changes (9.5 s, a 0.2 s cross-dissolve), and its audio is the exact first 18.3 s of the voice, not the generations' own audio. |
| `idle-loop.mp4` | The same shot, both people silent. It loops. No audio. |

`opening-voice.wav` is not stored. The pipeline cuts it from the voice: 0 to `opening.endMs` in `lines.json`, else to the end of `opening.mp4`. It must be the exact start of the voice, because the opening clip and the prompter follow the same audio. An `opening-voice.wav` in the source folder is used as it is, and checked against the voice.

## Regenerate

```sh
npm install            # once: adds playwright-core (it uses your installed Chrome)
npm run docs:media     # both languages, all clips, about 7–8 minutes
```

Needs ffmpeg and ffprobe on `PATH` and Google Chrome.

Options (`node scripts/docs-media/build.mjs …`):

- `--lang en|zh`: one language.
- `--only follow,hero,hero-vertical,setup,controls,editor,screenshots`: some clips. `screenshots` = ready, recording, review and editor PNGs. `setup.png` comes with `setup`.
- `--src <dir>`: another source folder.
- `--font-en <file>`, `--font-zh <file>`: caption fonts. The defaults are `C:/Windows/Fonts/segoeui.ttf` and `C:/Windows/Fonts/msyh.ttc`. On macOS and Linux pass them, or set `DOCS_MEDIA_FONT_EN` and `DOCS_MEDIA_FONT_ZH`. The zh font needs Chinese glyphs.
- `--keep-tmp`: keep `docs/media-out/tmp/` (frames, the fake camera feed, and a `<clip>-log.json` per clip with every page state, input and camera frame).
- `--headed`: show Chrome (off-screen). Headless works for everything, the fake camera included.

It also rewrites `test/fixtures/demo.json` from `demo-script.md` and `timings.json`. Commit that file with the screenshots.

To try the pipeline without real assets:

```sh
node scripts/docs-media/make-placeholders.mjs            # writes docs/media-out/placeholder-src/
node scripts/docs-media/build.mjs --src docs/media-out/placeholder-src
```

The placeholder voice is one beep per word. The placeholder videos are test patterns that say who is speaking and show their frame number.

At the end it prints a table: file, length, size, crf, A/V error, measured lag, and the onset check. Then it lists the contact sheets. Look at every one before you upload.

## What is real and what is simulated

Real: the page, its layout, its text in both languages, the countdown, the scrolling, the cue, the hold rings, the review page, the editor and its estimate. All of it is the app in `public/`, served by `createServer()` from a temporary folder.

Simulated, and why:

- **Speech recognition.** The page runs in sim mode (`?sim=demo.json`). The fixture holds what Chrome's recognizer would report, word by word, `delay` (350 ms) after the voice says each word, with the usual mishearings and recognition restarts. Real recognition needs a microphone, internet and Google's servers, and it never gives the same result twice. The sound check page replays the fixture's `setup` events. `simulateSetup(…, { keepGaps: true })` keeps the voice's own timing between the two first sentences, so the people in the camera preview speak exactly when the test hears them.
- **Camera and microphone.** Chrome's fake devices play a feed made for the clip: the idle loop while the camera opens and the noise floor is calibrated, then the opening clip from the moment <b>Test recognition</b> is clicked, then the idle loop. The microphone gets the same timeline, with quiet pink noise (about -60 dBFS) so the noise floor reads like a room. The device names in the dropdowns are replaced with ordinary ones ("HD Webcam"); the fake ones are file paths.
- **Camera permission.** The page is told the camera was never allowed, so it waits for <b>Open camera and microphone</b> as on a first visit.
- **The confirm dialog.** Chrome draws its own dialogs outside the page, so the screencast misses them. The editor clip shows a copy drawn from the real message, at the top centre, for the time the dialog was open.
- **No files are saved.** In sim mode a stopped take shows <b>Simulation, not saved</b>.

Added on top of the app, only in the videos:

- A badge at the bottom right (`scripts/docs-media/overlay.js`, injected by Playwright, never loaded by the app): the mouse button being pressed, a 1 s ring while a button is held, and the last key.
- A dot where the pointer is and a ripple where it clicks. Hidden during the countdown and the take, like the app's own cursor.
- A white 40 px band under the picture (`BAND` in `encode.mjs`) with the disclosure: "Demo · AI-generated people and voices · fictional names · simulated speech recognition" (zh: "演示 · 人物和声音由 AI 生成 · 名字为虚构 · 语音识别为模拟"). It sits under the picture so it covers no text and no faces. The videos are 1280×760; the hero is 1280×400. In `hero-vertical` the band is 64 px and the caption 24 px (`VERTICAL.caption` in `build.mjs`).

## How the timing works

Every clip is recorded with the CDP screencast at 1280×720 (JPEG quality 92), not Playwright's video recorder. Each frame has the time it was shown. The page logs every state change (a MutationObserver on `body[data-state]`), every pointer and key event, the cue and the camera frames, with page-side wall-clock times. The script logs its own actions too.

- **Video.** The frames between the clip's start and end go to ffmpeg's concat demuxer, each lasting until the next one. ffmpeg makes constant 30 fps H.264 (crf 22, yuv420p, faststart). A clip over 10 MB is encoded again at a higher crf (`MAX_BYTES` in `build.mjs`).
- **Voice in the prompter clips.** `voice-full` starts at the moment the take starts plus the fixture's `audioOffsetMs`, plus the measured render lag. The render lag is how long after a state change the screencast shows it, measured on the countdown digit (`COUNT_REGION` in `clips.mjs`). It is about 20–30 ms. Every new take starts the voice again from 0.
- **Sound check.** The camera's 0 s is the capture time of a camera frame minus its media time (`requestVideoFrameCallback`). The clicks run to a fixed plan after it: calibrate at 1.3 s, test at 5.4 s (`SETUP_PLAN` in `clips.mjs`). The feed is built to that plan before Chrome starts. Each click is aimed at its planned moment and lands within a few ms. The audio is placed at the camera's 0 s plus the camera's lag on screen (about 25–35 ms, measured per run).
- **Hero.** The opening clip and `voice-full` start with the same samples. So the right half shows the prompter from the moment the voice's 0 s plays in the follow recording. The hero is as long as `opening.mp4` less 40 ms; the follow recording runs until 0.8 s past its end. `follow.mp4` keeps its own length (it ends on a line end, 9–15.5 s after the click).
- **Hero vertical.** A second recording of the same simulated take, in a portrait viewport (below). It is timed the same way as the hero, on its own capture: render lag on the countdown digit, voice-full's 0 s = the opening clip's 0 s = the clip's 0 s. The audio is the opening clip's own.

**A/V error** in the table is the gap, in ms, between where the video shows a moment and where the audio has it: the median and the worst over all checks. For follow, controls, hero and hero-vertical it is checked at each countdown state change; for setup at each of the first 90 camera frames (lips against voice). One frame at 30 fps is 33 ms; the target is less than that. A single late screencast frame can go slightly over; the median stays well under.

**Onset check** finds where sound starts in the finished MP4 (ffmpeg `silencedetect`, -40 dB) and subtracts where the plan puts the voice's first sound (measured the same way on `voice-full`). 0 means the audio sits where the logs say it should. The word times in `timings.json` are not used for this: the transcriber's first word starts about 60 ms after the sound does (480 ms against 418 ms in the current voice).

Known limit: in `opening.mp4` each speaker's mouth opens 0.2–0.5 s before their voice. That is in the generated clip, not in the pipeline.

The sound check uses only the first two sentences of the opening, whatever its length. The feed cuts back to the idle loop 150 ms after the second speaker's sentence ends (from the fixture's `setup.speech`), and the microphone stops there too. A longer `opening.mp4` or `opening-voice.wav` changes nothing in `setup.mp4`.

## The vertical hero

`hero-vertical.mp4` is 1080×1920, 30 fps, H.264 and AAC, under 10 MB. It is for phones. It is attached to the GitHub release (`voice-teleprompter-demo-vertical-<lang>.mp4`), and both READMEs link it under the hero. Top to bottom:

1. `opening.mp4` scaled to 1080×608, with its audio as the soundtrack (as in the hero).
2. The prompter, 1080×1248. This is a second recording of the same simulated take, not a crop of the follow recording. The page runs in a 1080×1248 viewport (device scale factor 1), so it lays out for that window: more lines show below the reading line, and the reading line sits at 12% of the window's height.
3. The disclosure band, 64 px.

The prompter text is 54 px in this recording. It is set in `localStorage` `tp.settings.fontSize` before the page loads, only for this recording (`VERTICAL.fontSize` in `build.mjs`). On a phone the video is shown about 390 points wide, so 54 px of the video is about 19.5 points. The column is 15 em wide at every font size. So the line breaks do not change with the font size: 3–7 words a line, as at the app's default 52 px. What limits the size is the speaker names and the next-speaker cue, which hang left of the column. At 54 px the names start at x 64 and the "JESS →" cue at x 27. At 56 px the cue starts at x 8; at 64 px the names and the cue are cut off. The build prints these positions and warns when the names, the cue or the column leave the frame.

The layout is in `VERTICAL` (`build.mjs`). The vstack is the `top` option of `encodeClip` (`encode.mjs`), next to `left` (the hstack of the hero). The contact sheet has 6 frames a row.

## Upload the videos to GitHub

GitHub plays an MP4 in a README only from an attachment URL.

1. Open the README in GitHub's web editor (or any issue or pull request comment box).
2. Drag the MP4 from `docs/media-out/<lang>/` into the text. Each file must be under 10 MB.
3. GitHub uploads it and inserts a `https://github.com/user-attachments/assets/…` link.
4. Put that link on its own line in the README. GitHub shows a player.
5. Keep the poster PNG next to it as a fallback for viewers where video does not load.

An issue comment does not need to be posted: the link works as soon as the upload finishes. When the videos change, upload them again and replace the links.

Each README marks the place for each video with `<!-- media:<clip> -->`: `hero`, `setup`, `follow`, `controls`, `editor` from `docs/media-out/<lang>/`, and `opening`, which is `docs/media-src/opening.mp4` itself (the same file for both languages). Put each attachment link on the line right after its marker, and keep the marker so the link can be replaced later. `hero-vertical` has no marker: upload it with `gh release upload <tag> … --clobber` instead.

## Files

- `scripts/docs-media/build.mjs`: options, fixture, temporary server, the order of the clips, the hero length, the vertical layout, the summary.
- `scripts/docs-media/clips.mjs`: what happens in each clip, the sound check feed, the timing plans.
- `scripts/docs-media/capture.mjs`: Chrome, the page log, the screencast, input at planned moments.
- `scripts/docs-media/encode.mjs`: ffmpeg: clips, captions, posters, contact sheets, checks.
- `scripts/docs-media/overlay.js`: the mouse and key badge.
- `scripts/docs-media/make-placeholders.mjs`: placeholder assets.
