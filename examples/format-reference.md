Target: 1:30
// ↑ Optional. The first line can set a time limit as minutes:seconds. The page then shows
//   "estimate / limit" and turns red when the script is longer. Without it, no limit is shown.

// Lines that start with // are comments. They are not shown and not read.
// Comments must start at the beginning of a line; // in the middle of a line is normal text.

// "Name: text" starts a block for that speaker. The text can follow on the same line.
Alex: Hi, I'm Alex.

// "Name:" alone starts a block; the text goes on the next lines.
Sam:
I'm Sam.
Each line is its own paragraph.

// "Name — Title" starts a block with a title. Space, dash, space. The title is shown,
// but never read and hidden while recording.
Alex — How it works
The prompter listens and moves the text as we read.

// A number at the start of a line is shown, but you can read it or skip it.
Sam:
1. Click once to start.
2. Hold the left button to stop.
3. Hold the right button to start again.

// Numbers can be written as digits or words; both are understood when read.
Alex:
It works with 3 people, 45% of a script, or twenty two lines.

// "Upload:" at the start of a line is not a speaker unless that name is used as a speaker
// elsewhere (bare "Name:" or "Name — Title", or at least twice).
Sam:
Upload: put your script in script.md.

// "Both:", "All:" or "Together:" is read together. Keep the last line short:
// the take stops by itself 2 seconds after its words are heard.
Both: Thanks for watching!
