// Camera + mic, uploaded to the server every second while recording (appended to takes/<id>.part).
// The camera stream is opened once at sound check and never closed: on Windows the camera is exclusive, and reopening means another warm-up and exposure adjustment.
// If an upload fails, all chunks are still in memory; at finish the browser downloads a complete copy.

const MIMES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,opus',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  return MIMES.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

export function openStream({ camId, micId } = {}) {
  return navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: camId ? { exact: camId } : undefined,
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    },
    audio: {
      deviceId: micId ? { exact: micId } : undefined,
      // A built-in mic about 80 cm from the speaker needs gain and noise suppression; nothing plays through speakers, so no echo cancellation
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
}

export class TakeRecorder {
  constructor(stream) {
    this.stream = stream;
    this.chunks = [];
    this.failed = false;
  }

  async start() {
    const r = await fetch('/api/takes', { method: 'POST' });
    if (!r.ok) throw new Error('服务器没建成这一条');
    this.id = (await r.json()).id;
    this.mime = pickMime();
    this.ext = this.mime.includes('mp4') ? 'mp4' : 'webm';
    this.rec = new MediaRecorder(this.stream, {
      mimeType: this.mime || undefined,
      videoBitsPerSecond: 8_000_000,
      audioBitsPerSecond: 160_000,
    });
    this.chain = Promise.resolve();
    this.rec.ondataavailable = (e) => {
      if (!e.data?.size) return;
      const blob = e.data;
      this.chunks.push(blob);
      this.chain = this.chain.then(() => this.upload(blob));
    };
    this.rec.start(1000);
  }

  async upload(blob) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(`/api/takes/${this.id}/chunk`, { method: 'POST', body: blob });
        if (r.ok) return;
      } catch { /* try once more */ }
    }
    this.failed = true;
  }

  stop() {
    return new Promise((resolve) => {
      this.rec.onstop = async () => {
        await this.chain;
        resolve();
      };
      this.rec.stop();
    });
  }

  async finish(meta, discarded) {
    if (this.failed) this.download();
    const r = await fetch(`/api/takes/${this.id}/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ext: this.ext, mime: this.mime, discarded, meta }),
    });
    const res = await r.json();
    if (!r.ok) throw new Error(res.error || '保存失败');
    this.chunks = [];
    return { ...res, uploadFailed: this.failed };
  }

  download() {
    const blob = new Blob(this.chunks, { type: this.mime || 'video/webm' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.id}.${this.ext}`;
    a.click();
  }
}
