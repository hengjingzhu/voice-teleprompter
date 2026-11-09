---
name: fix-mishearings
description: Find names and words the speech recognizer keeps mishearing in voice-teleprompter takes and add them to aliases.json. Use when the prompter gets stuck on the same name or word, or the review page shows the same words in red again and again.
---

# Fix mishearings

`aliases.json` maps a word in the script to the ways the recognizer mishears it, for example `{ "chillahub": ["chiller hub", "chilly hub"] }`. Keys and variants are lower case. A variant can be several words. The prompter treats each variant as the key.

1. Read the recent take files `takes/*.json`. Leave out `-x` (discarded) takes unless there are only a few takes. Useful fields:
   - `missedWords`: script words that were never matched.
   - `transcriptEvents`: what the recognizer heard, with `t` (milliseconds), `text` and `final`.
   - `scriptSnapshot`: the script as it was during that take.
2. Find script words that were missed in two or more takes. Names, brand names and unusual words matter most. Ignore short common words.
3. For each one, read the transcript around the time that word should have been read. Collect what was heard instead, for example "chiller hub" for "ChillaHub".
4. Show the user the proposed `aliases.json` entries as a short table: script word, heard as, in how many takes. Never add a common English word as a variant of another word: it would make the prompter jump.
5. After the user agrees, edit `aliases.json` and run `npm test`.
6. Tell the user to reload the page after their current take. The page reads `aliases.json` only when it loads.
