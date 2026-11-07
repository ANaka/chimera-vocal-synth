/**
 * Plays one decoded track and keeps the one playhead every head reads: what the listener hears
 * now, in seconds into the track. Its own AudioContext (the voice engine doesn't run here).
 *
 * Paused, the playhead is the saved position. Playing, it is that position plus the audible time
 * since the source started: the context's output timestamp where the browser has one (it already
 * allows for output latency), else currentTime less the reported latency. A seek bumps `epoch`
 * (so animation history can be reset) and restarts a fresh source. The context leaving "running"
 * (an iOS interruption, the page going to the background) pauses the transport where it was.
 */
export type TransportState = { playing: boolean; time: number; duration: number; epoch: number };

export class Transport {
  readonly ctx: AudioContext;
  private buffer: AudioBuffer | null = null;
  private src: AudioBufferSourceNode | null = null;
  private offset = 0;
  private startedAt = 0;
  private playing = false;
  private wasRunning = false;
  epoch = 0;
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.ctx = new AudioContext({ latencyHint: "playback" });
    this.ctx.onstatechange = () => {
      const running = this.ctx.state === "running";
      if (this.wasRunning && !running && this.playing) this.pause();
      this.wasRunning = running;
    };
  }

  async load(data: ArrayBuffer): Promise<void> {
    this.buffer = await this.ctx.decodeAudioData(data);
    this.emit();
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get state(): TransportState {
    return { playing: this.playing, time: this.time(), duration: this.duration, epoch: this.epoch };
  }

  subscribe(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private emit(): void {
    for (const f of this.listeners) f();
  }

  /** Call from the tap itself: iOS only lets a user gesture start audio. */
  play(): void {
    if (!this.buffer || this.playing) return;
    void this.ctx.resume();
    if (this.offset >= this.duration - 0.05) this.offset = 0;
    this.startSource();
    this.playing = true;
    this.emit();
  }

  pause(): void {
    if (!this.playing) return;
    this.offset = this.time();
    this.stopSource();
    this.playing = false;
    this.emit();
  }

  seek(t: number): void {
    this.offset = Math.min(this.duration, Math.max(0, t));
    this.epoch++;
    if (this.playing) {
      this.stopSource();
      this.startSource();
    }
    this.emit();
  }

  /** the audible playhead (s) */
  time(): number {
    if (!this.playing) return this.offset;
    return Math.min(this.duration, Math.max(0, this.offset + this.audibleNow() - this.startedAt));
  }

  dispose(): void {
    this.stopSource();
    this.listeners.clear();
    void this.ctx.close();
  }

  private startSource(): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.ctx.destination);
    src.onended = () => {
      if (this.src !== src) return;
      this.src = null;
      this.offset = this.duration;
      this.playing = false;
      this.emit();
    };
    this.src = src;
    this.startedAt = this.ctx.currentTime;
    src.start(this.startedAt, this.offset);
  }

  private stopSource(): void {
    const src = this.src;
    this.src = null;
    if (!src) return;
    src.onended = null;
    try {
      src.stop();
    } catch {
      // never started (the context was closed)
    }
    src.disconnect();
  }

  /** the context time being heard now */
  private audibleNow(): number {
    const c = this.ctx;
    const ts = typeof c.getOutputTimestamp === "function" ? c.getOutputTimestamp() : null;
    if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.contextTime > 0) {
      // the stamp is a moment ago; carry it to now, but never ahead of what has been rendered
      const t = ts.contextTime + Math.max(0, (performance.now() - ts.performanceTime) / 1000);
      return Math.min(t, c.currentTime);
    }
    return c.currentTime - (c.outputLatency || c.baseLatency || 0);
  }
}
