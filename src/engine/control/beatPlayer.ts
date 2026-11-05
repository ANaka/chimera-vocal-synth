/**
 * Step sequencer for the beatboxer. Runs on the voice clock (in the AudioWorklet, or offline),
 * so hits are sample-accurate whatever the main thread is doing. Each step's gestures are built
 * when its hit comes within `horizon` of the clock: early enough for the slowest sound's set-up,
 * late enough that edits to the pattern are heard within a step or two.
 */
import { beatSound, BASS_NOTE, type BeatStep } from "../phonetics/beatbox.ts";
import type { Gesture } from "./score.ts";

const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class BeatPlayer {
  steps: (BeatStep | null)[] = [];
  bpm = 96;
  /** 0..0.6: off-beat sixteenths are delayed by swing × half a step */
  swing = 0;
  readonly stepsPerBeat = 4;
  playing = false;
  body = "male";
  /** schedule a step when its hit is this close (s); covers every sound's set-up time */
  readonly horizon = 0.2;
  private anchorTime = 0;
  private anchorStep = 0;
  private next = 0;

  get stepDur(): number {
    return 60 / this.bpm / this.stepsPerBeat;
  }

  private stepTime(n: number): number {
    const base = this.anchorTime + (n - this.anchorStep) * this.stepDur;
    return n % 2 === 1 ? base + this.swing * 0.5 * this.stepDur : base;
  }

  start(clock: number): void {
    this.playing = true;
    this.anchorTime = clock + this.horizon;
    this.anchorStep = 0;
    this.next = 0;
  }

  stop(): void {
    this.playing = false;
  }

  /** Change tempo without a jump: the next unscheduled step keeps its time. */
  setTempo(bpm: number, swing: number): void {
    const b = Math.min(200, Math.max(40, bpm));
    if (this.playing && b !== this.bpm) {
      this.anchorTime += (this.next - this.anchorStep) * this.stepDur;
      this.anchorStep = this.next;
    }
    this.bpm = b;
    this.swing = Math.min(0.6, Math.max(0, swing));
  }

  /** The voice clock restarted (new voice after a body change): keep the beat's phase. */
  rebase(delta: number): void {
    this.anchorTime += delta;
  }

  /** Step under the playhead at `clock` (−1 when stopped). */
  stepAt(clock: number): number {
    if (!this.playing || this.steps.length === 0) return -1;
    const n = Math.floor((clock - this.anchorTime) / this.stepDur) + this.anchorStep;
    return n < 0 ? -1 : n % this.steps.length;
  }

  /** Schedule every step whose hit falls within the horizon. */
  tick(clock: number, schedule: (gs: Gesture[]) => void): void {
    if (!this.playing || this.steps.length === 0) return;
    for (let guard = 0; guard < 64; guard++) {
      const hit = this.stepTime(this.next);
      if (hit > clock + this.horizon) break;
      const L = this.steps.length;
      const cell = this.steps[this.next % L];
      if (cell && hit >= clock) {
        // sustained sounds (hum, open hat) last until the next sound
        let rests = 0;
        while (rests < L - 1 && !this.steps[(this.next + 1 + rests) % L]) rests++;
        schedule(this.gestures(cell, hit, (1 + rests) * this.stepDur));
      }
      this.next++;
    }
  }

  /** Gestures for one sound whose acoustic hit lands at `hit` on the voice clock. */
  gestures(cell: BeatStep, hit: number, len = this.stepDur): Gesture[] {
    const s = beatSound(cell.id);
    if (!s) return [];
    const gs = s.build(this.body, { f0: midiToHz(cell.note ?? BASS_NOTE), len, accent: cell.accent ?? 1 });
    const off = hit - s.latency;
    for (const g of gs) {
      g.t0 += off;
      g.t1 += off;
    }
    return gs;
  }

  /** Set-up time a sound needs before its hit (s): when a pad press can sound at the earliest. */
  static leadIn(id: string, body = "male"): number {
    const s = beatSound(id);
    if (!s) return 0;
    let lead = 0;
    for (const g of s.build(body, { f0: 100, len: 0.15, accent: 1 })) lead = Math.max(lead, -(g.t0 - g.rampIn));
    return lead + s.latency;
  }
}
