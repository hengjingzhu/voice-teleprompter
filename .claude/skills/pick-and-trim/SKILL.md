---
name: pick-and-trim
description: List the recorded takes of voice-teleprompter and cut the chosen one to a given length without cutting off the last word. Use when the user asks which take is best, wants to trim, cut or export a take, or needs a video under a time limit.
---

# Pick and trim a take

Takes are in `takes/`: `take-NN-YYYYMMDD-HHMMSS.mp4` plus a `.json` with the same name. Trimming needs ffmpeg and ffprobe. Name endings:
- `-x`: a discarded take.
- `-partial`: the upload broke off during the take. The complete copy is in the user's Downloads folder; use that one.
- `-recovered`: the page or server stopped mid-take; the server rescued what it had at the next start. It may end abruptly and has no `.json`.
- `.raw.webm` next to an `.mp4`: the browser's original file, kept after conversion.

1. List the takes. From each `.json` read:
   - `durationMs`
   - `endedBy`: `auto`, `manual` or `discard`
   - `missed`: script words the recognizer did not match. Most are mishearings, not reading mistakes.
   - `cursor` and `tokenCount`: how far the prompter got.
   - `manual`: words skipped with the wheel.

   Show a short table, newest first. Leave out `-x` takes unless asked.
2. If the user asks you to pick, prefer takes that ended `auto` and reached the end (`cursor` equals `tokenCount`). Say why. The user decides.
3. Before cutting, find where the speech really ends, so the last word is not cut off:

   `ffmpeg -hide_banner -ss <END_MINUS_8> -i <TAKE> -af silencedetect=noise=-45dB:d=0.15 -vn -f null -`

   Add the `-ss` value to the last `silence_start`: that is where the last word ends. Do not use the times in the take JSON for this. Recognition results arrive later than the speech.
4. Cut from the start without re-encoding, keeping at least 0.25 seconds after the last word:

   `ffmpeg -i <TAKE> -t <SECONDS> -c copy -movflags +faststart takes/<NAME>-final.mp4`

   If the user's limit is shorter than the speech, say so and ask. Options: cut earlier in the script, speed it up slightly, or record again.
5. Check the result. Read its duration with `ffprobe`. Look at a frame from the last 0.3 seconds (`ffmpeg -sseof -0.3 -i <OUT> -frames:v 1 last.jpg`) to confirm it is not black or frozen.
6. Report the output path, its duration, and where the last word ends.
