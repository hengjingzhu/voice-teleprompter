// Chrome's Web Speech API (uses Google cloud recognition; needs a network connection).
// Continuous recognition ends on its own (silence, a network blip, or a time limit). While we still want to listen, reopen at once and tell the caller to widen the alignment window.
// Recognition always uses the system default mic, not the device picked on the page.

const SR = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
export const speechSupported = !!SR;

export class Speech {
  constructor({ lang = 'en-US', onResult, onStatus, onRestart } = {}) {
    this.lang = lang;
    this.onResult = onResult;
    this.onStatus = onStatus;
    this.onRestart = onRestart;
    this.want = false;
    this.rec = null;
    this.restarts = 0;
    this.backoff = 0;
  }

  start() {
    if (!SR) { this.onStatus?.('unsupported'); return; }
    this.want = true;
    this.backoff = 0;
    this.restarts = 0;
    this.open();
  }

  open() {
    const r = new SR();
    this.rec = r;
    this.base = 0;
    this.lastLength = 0;
    this.openedAt = performance.now();
    r.lang = this.lang;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 3;
    r.onstart = () => { if (r === this.rec) this.onStatus?.('listening'); };
    r.onresult = (e) => {
      if (r !== this.rec) return;
      const res = e.results;
      this.lastLength = res.length;
      if (res.length - 1 < this.base) return;
      const parts = [];
      for (let k = this.base; k < res.length; k++) parts.push(res[k][0].transcript.trim());
      const last = res[res.length - 1];
      const prefix = parts.slice(0, -1).join(' ');
      const texts = [parts.join(' ')];
      for (let a = 1; a < last.length; a++) texts.push(`${prefix} ${last[a].transcript.trim()}`.trim());
      this.onResult?.({ texts, latest: last[0].transcript.trim(), isFinal: last.isFinal });
    };
    r.onerror = (e) => {
      if (r !== this.rec) return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.want = false;
        this.onStatus?.('denied');
      } else if (e.error === 'network') this.onStatus?.('network');
      else if (e.error === 'audio-capture') this.onStatus?.('no-mic');
    };
    r.onend = () => {
      if (r !== this.rec) return;
      if (!this.want) { this.onStatus?.('stopped'); return; }
      // Ended less than 1.5 s after opening (most likely offline): back off so it does not max out the CPU
      const lived = performance.now() - this.openedAt;
      this.backoff = lived < 1500 ? Math.min(2000, Math.max(100, this.backoff * 2)) : 0;
      this.restarts++;
      this.onRestart?.();
      setTimeout(() => { if (this.want && this.rec === r) this.open(); }, this.backoff);
    };
    try {
      r.start();
    } catch {
      // The previous instance has not fully released the mic; a throwing start() fires no onend, so retry here
      setTimeout(() => { if (this.want && this.rec === r) this.open(); }, 300);
    }
  }

  /** Call when the countdown ends: anything recognised before (during the countdown) is ignored */
  markBase() {
    this.base = this.lastLength || 0;
  }

  stop() {
    this.want = false;
    const r = this.rec;
    this.rec = null;
    try { r?.abort(); } catch { /* already stopped */ }
  }
}
