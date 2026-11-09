// Volume detection (VAD): is anyone speaking? Inertia scrolling and the fallback end-of-take stop both rely on it.
// Threshold = noise floor calibrated at sound check + 10 dB. Above the threshold for 200 ms → speaking starts; below it for 350 ms → speaking stops.

export class Vad {
  constructor(stream, floorDb = -55) {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.buf = new Float32Array(1024);
    this.floorDb = floorDb;
    this.db = -100;
    this.speaking = false;
    this.loud = false;
    this.flipAt = 0;
    this.quietSince = 0;
    this.setStream(stream);
  }

  setStream(stream) {
    try { this.src?.disconnect(); } catch { /* never connected */ }
    this.src = this.ctx.createMediaStreamSource(stream);
    this.an = this.ctx.createAnalyser();
    this.an.fftSize = 1024;
    this.src.connect(this.an);
  }

  resume() {
    return this.ctx.resume();
  }

  get threshold() {
    return this.floorDb + 10;
  }

  poll(now) {
    this.an.getFloatTimeDomainData(this.buf);
    let s = 0;
    for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i];
    this.db = 20 * Math.log10(Math.sqrt(s / this.buf.length) + 1e-9);
    const loud = this.db > this.threshold;
    if (loud !== this.loud) { this.loud = loud; this.flipAt = now; }
    const held = now - this.flipAt;
    if (loud && !this.speaking && held > 200) this.speaking = true;
    if (!loud && this.speaking && held > 350) { this.speaking = false; this.quietSince = this.flipAt; }
    return this;
  }

  /** How many ms it has been quiet (0 while speaking) */
  quietFor(now) {
    return this.speaking ? 0 : now - this.quietSince;
  }

  /** Stay quiet for ms milliseconds; the median volume becomes the noise floor */
  calibrate(ms = 3000) {
    return new Promise((resolve) => {
      const vals = [];
      const t0 = performance.now();
      const tick = () => {
        this.an.getFloatTimeDomainData(this.buf);
        let s = 0;
        for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i];
        vals.push(20 * Math.log10(Math.sqrt(s / this.buf.length) + 1e-9));
        if (performance.now() - t0 < ms) setTimeout(tick, 50);
        else {
          vals.sort((a, b) => a - b);
          this.floorDb = Math.round(vals[vals.length >> 1] * 10) / 10;
          resolve(this.floorDb);
        }
      };
      tick();
    });
  }
}
