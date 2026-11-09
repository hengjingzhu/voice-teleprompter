// Camera + mic, uploaded to the server every second while recording (appended to takes/<id>.part).
// The camera stream is opened once at sound check and never closed: on Windows the camera is exclusive, and reopening means another warm-up and exposure adjustment.
// Chunks go up strictly in order, each with its byte offset, so the file on the server never has a gap. A failed chunk is sent
// again (same chunk, same offset) with backoff. If it still fails, uploading stops for this take: the server keeps the start
// it has (saved as <id>-partial), all chunks are still in memory, and at finish the browser downloads a complete copy.

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
const RETRY_MS = [500, 1000, 2000, 4000]; // waits before each new attempt of the same chunk
const CHUNK_TIMEOUT_MS = 20000; // a hung request counts as failed; the server ignores a repeat of a chunk it already has

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    this.sent = 0; // bytes the server has confirmed, = the offset of the next chunk
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
    if (this.failed) return; // gave up on this take: never skip ahead, keep the rest in memory only
    if (await this.sendChunk(blob, this.sent)) this.sent += blob.size;
    else this.failed = true;
  }

  /** @returns {Promise<boolean>} true once the server holds this chunk at this offset */
  async sendChunk(blob, offset) {
    for (let attempt = 0; attempt <= RETRY_MS.length; attempt++) {
      if (attempt) await sleep(RETRY_MS[attempt - 1]);
      let r;
      try {
        r = await fetch(`/api/takes/${this.id}/chunk?offset=${offset}`, {
          method: 'POST',
          body: blob,
          signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS),
        });
      } catch {
        continue; // network error or timeout: send the same chunk again
      }
      if (r.ok) return true;
      if (r.status === 410) return false; // the server no longer has this take's .part (recovered at a restart)
      if (r.status === 409) {
        // The server says how big its file is: either an earlier attempt of this chunk got through, or there is a gap
        const { size } = await r.json().catch(() => ({}));
        return size === offset + blob.size;
      }
      if (r.status < 500) return false; // a request the server will never accept
    }
    return false;
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
      body: JSON.stringify({ ext: this.ext, mime: this.mime, discarded, uploadFailed: this.failed, meta }),
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
