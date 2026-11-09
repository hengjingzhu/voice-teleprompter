---
name: install-and-start
description: Install and start voice-teleprompter on this computer, then tell the user what to do on the page. Use when the user asks to set up, install, run, start or open the teleprompter.
---

# Install and start

1. Check the tools. Run each and note what is missing:
   - `node --version` — needs 22 or newer.
   - Google Chrome is installed (Windows: `C:\Program Files\Google\Chrome\Application\chrome.exe`, `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe` or `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`; macOS: `/Applications/Google Chrome.app`; Linux: `google-chrome --version`).
   - `ffmpeg -version` — optional.
2. If Node or Chrome is missing, stop and ask the user before installing. Tell them what you would run:
   - Windows: `winget install OpenJS.NodeJS.LTS`, `winget install Google.Chrome`, `winget install Gyan.FFmpeg`
   - macOS: `brew install node`, `brew install --cask google-chrome`, `brew install ffmpeg`
   - Linux: the distribution's package manager.

   If only ffmpeg is missing, say it is optional: recordings still save, but they stay in the browser's own format, and trimming a take needs ffmpeg.
3. If the repo is not on disk yet, clone it. In an empty folder: `git clone https://github.com/hengjingzhu/voice-teleprompter .`; otherwise clone into a new `voice-teleprompter` folder and work inside it.
4. Run `npm test`. It must pass. There is nothing to `npm install`.
5. Check whether port 5178 is already in use. If `http://localhost:5178/api/stats` answers with JSON (check with `curl --noproxy "*" http://localhost:5178/api/stats`: a proxy set in HTTP_PROXY can otherwise answer for localhost), the teleprompter is already running: reuse it, do not start a second one. If something else answers on 5178, start on another port (`PORT=5200 npm start`; PowerShell: `$env:PORT=5200; npm start`) and use that port below.
6. Start the server in the background with `npm start`. Wait for the line `Teleprompter running: open http://localhost:5178 in Chrome`.
7. Open the page in Chrome (Windows: `start chrome http://localhost:5178`; macOS: `open -a "Google Chrome" http://localhost:5178`; Linux: `google-chrome http://localhost:5178`). Not another browser: speech recognition needs Chrome. If you cannot keep a server running in the background or open a browser, ask the user to run `npm start` in a terminal and open the address themselves.
8. Tell the user, in their language, what to do next:
   - Allow the camera and microphone when Chrome asks.
   - On the Sound check page: open the camera, calibrate the noise floor (stay quiet for 3 seconds), and run the recognition test with each speaker reading their own first line of the script.
   - Their script is `script.md` in this folder. On first start it is a demo script. To use their own, they can paste it to you (the `new-script` skill) or press E on the page.
   - Click once to start a take. Hold the left mouse button for 1 second to stop and save. Hold the right button for 1 second to discard and start again.
   - Recordings go to the `takes` folder.
   - In full screen, Chrome uses Esc to leave full screen; press X to discard a take.
   - Later sessions should start in this folder, so the agent loads AGENTS.md and the skills.
9. Leave the server running. To stop it later, stop the process you started.
