/**
 * Show video: renders a duet show (`?show=<id>`) to an MP4, frame-exactly. A screen recording drops
 * frames whenever drawing a frame takes longer than showing it (SwiftShader always does); this
 * steps a fake clock instead, one output frame at a time, so every frame is drawn at its own time
 * however long it takes.
 *
 * The page runs on Playwright's fake clock (Date, timers, performance.now), with two patches of
 * our own: requestAnimationFrame callbacks queue until this tool flushes them, and the
 * AudioContext's clock (currentTime, getOutputTimestamp) is performance.now(), so the transport's
 * playhead moves exactly with the fake clock and never with the real audio. Time moves in steps of
 * at most 50 ms with a draw at each (the 3D view caps a draw's dt at 50 ms, so a longer step would
 * run the heads slow), and the screenshot is taken at the frame's own time. The page draws the
 * heads and the words at the mouth as it would live; the tool screenshots each frame and muxes the
 * frames with the show's own audio file (read from public/shows/<id>/ on disk), cut to the same
 * span.
 *
 * The page opens in capture mode (`&capture`, see DuetPage.tsx): only the heads, edge to edge, and
 * its transport on `window.__duet`. --ui keeps the title bar and the transport bar in the video.
 * Before the first frame the tool lets the 3D view's opening camera move finish (2 s, paused),
 * seeks the transport a second before --from and plays that second uncaptured, so the face's
 * springs are warm. It checks the playhead equals each sampled frame's time to half a frame, and
 * fails otherwise.
 *
 * Usage: bun tools/show-video.ts <show-id> <out.mp4> [--url http://127.0.0.1:5317] [--fps 30]
 *          [--size 1920x1080] [--from s] [--to s] [--ui] [--keep]
 * Needs a server for the app at --url (`bun run dev`) and ffmpeg/ffprobe (with libx264 and aac) on
 * the PATH; CHIMERA_CHROME names a browser to use in place of Playwright's own (as for e2e.ts and
 * layout-lint.ts). --keep keeps the PNG frames (their folder is printed); a failed mux keeps them
 * too, and prints the ffmpeg command to rerun. The browser is muted.
 */
import { chromium, type Page } from "playwright-core";
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { DuetHandle } from "../src/ui/components/DuetPage.tsx";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
/** a failure before the browser is up; after, failures throw, so the browser closes */
function die(msg: string): never {
  console.error(`show-video: ${msg}`);
  process.exit(1);
}
const [id, outArg] = argv;
if (!id || !outArg || id.startsWith("--") || outArg.startsWith("--")) die("usage: bun tools/show-video.ts <show-id> <out.mp4> [flags] (see the header)");

const url = arg("url") ?? "http://127.0.0.1:5317";
const fps = Number(arg("fps") ?? 30);
const [width, height] = (arg("size") ?? "1920x1080").split("x").map(Number);
const fromArg = Number(arg("from") ?? 0);
const toArg = arg("to") === undefined ? undefined : Number(arg("to"));
if (!(fps > 0 && fps <= 120)) die(`--fps ${arg("fps")}: want a number in (0, 120]`);
if (!(width > 0 && height > 0 && width % 2 === 0 && height % 2 === 0)) die(`--size ${arg("size")}: want WxH, both even (H.264 in yuv420p)`);
if (!(fromArg >= 0) || (toArg !== undefined && !(toArg > fromArg))) die("want 0 <= --from < --to");
const out = resolve(outArg);
try {
  accessSync(dirname(out), constants.W_OK);
} catch {
  die(`can't write to ${dirname(out)} (does it exist?)`);
}

// the show's audio, from the folder on disk (the page fetches the same file from the server)
const showDir = resolve(import.meta.dir, "../public/shows", id);
const showJson = join(showDir, "show.json");
if (!existsSync(showJson)) die(`no ${showJson}`);
const show = JSON.parse(readFileSync(showJson, "utf8")) as { audio?: string };
if (!show.audio) die(`${showJson} names no audio`);
const audio = join(showDir, show.audio);
if (!existsSync(audio)) die(`no ${audio}`);
for (const tool of ["ffmpeg", "ffprobe"]) if (spawnSync(tool, ["-version"]).status !== 0) die(`${tool} is not on the PATH`);
const encoders = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout ?? "";
for (const enc of ["libx264", "aac"]) if (!new RegExp(`^\\s*\\S+\\s+${enc}\\s`, "m").test(encoders)) die(`this ffmpeg has no ${enc} encoder`);

/**
 * Runs in the page before its scripts, after Playwright's clock: the manual animation frames, the
 * audio clock, and the page's transport (on `window.__duet` in capture mode). Serialized into the
 * page, so it uses nothing from outside itself but types.
 */
function pageHooks() {
  const w = window as unknown as { __showVideo: unknown; __duet?: DuetHandle };
  let queue = new Map<number, FrameRequestCallback>();
  let next = 0;
  const raf = (cb: FrameRequestCallback) => {
    queue.set(++next, cb);
    return next;
  };
  window.requestAnimationFrame = raf;
  window.cancelAnimationFrame = (h: number) => void queue.delete(h);

  // the audio clock is the page's (fake) clock; +1 s keeps contextTime > 0, as the transport needs
  const clock = () => performance.now() / 1000 + 1;
  const define = (proto: object, name: string, get: (this: BaseAudioContext) => unknown) => Object.defineProperty(proto, name, { configurable: true, get });
  const realState = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, "state")!.get!;
  define(BaseAudioContext.prototype, "currentTime", clock);
  define(BaseAudioContext.prototype, "state", function () {
    return realState.call(this) === "closed" ? "closed" : "running";
  });
  define(AudioContext.prototype, "baseLatency", () => 0);
  define(AudioContext.prototype, "outputLatency", () => 0);
  AudioContext.prototype.getOutputTimestamp = () => ({ contextTime: clock(), performanceTime: performance.now() });
  const realResume = AudioContext.prototype.resume;
  AudioContext.prototype.resume = function () {
    realResume.call(this).catch(() => {});
    return Promise.resolve();
  };

  const transport = () => {
    const t = w.__duet?.transport;
    if (!t) throw new Error("no window.__duet (the page isn't in capture mode, or hasn't loaded)");
    return t;
  };
  const hooks = {
    hooked: () => window.requestAnimationFrame === raf,
    ready: () => !!w.__duet && !!document.querySelector(".duet-head canvas"),
    /** one draw: let React commit what the timers just scheduled, then run the queued frames, at now */
    async frame(): Promise<string[]> {
      await new Promise<void>((r) => {
        const c = new MessageChannel();
        c.port1.onmessage = () => r();
        c.port2.postMessage(0);
      });
      const q = queue;
      queue = new Map();
      const t = performance.now();
      const errors: string[] = [];
      for (const cb of q.values()) {
        try {
          cb(t);
        } catch (e) {
          errors.push(e instanceof Error ? (e.stack ?? e.message) : String(e));
        }
      }
      return errors;
    },
    state: () => transport().state,
    seek: (t: number) => transport().seek(t),
    play: () => transport().play(),
  };
  w.__showVideo = hooks;
  return hooks;
}

type Hooks = ReturnType<typeof pageHooks>;
/** calls one of the page's hooks */
const hook =
  (page: Page) =>
  <K extends keyof Hooks>(name: K, ...args: Parameters<Hooks[K]>): Promise<Awaited<ReturnType<Hooks[K]>>> =>
    page.evaluate(
      ([k, a]) => ((window as unknown as { __showVideo: Record<string, (...x: unknown[]) => unknown> }).__showVideo[k] as (...x: unknown[]) => unknown)(...a),
      [name, args] as [string, unknown[]],
    ) as Promise<Awaited<ReturnType<Hooks[K]>>>;

let frames: string | null = null;
let keepFrames = flag("keep");
/** the frames' folder goes unless kept; on any exit, Ctrl-C too (Playwright's handler exits 130) */
function cleanUp() {
  if (frames && !keepFrames) rmSync(frames, { recursive: true, force: true });
  frames = keepFrames ? frames : null;
}
process.on("exit", cleanUp);

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHIMERA_CHROME || undefined,
  args: ["--autoplay-policy=no-user-gesture-required", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"],
});
let failed = false;
try {
  frames = mkdtempSync(join(tmpdir(), "show-video-"));
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => m.type() === "error" && console.log(`  console: ${m.text()}`));
  // the clock first: our requestAnimationFrame must replace its fake one, not the other way round
  await page.clock.install();
  await page.addInitScript(pageHooks);
  const h = hook(page);
  // screenshots straight from the DevTools protocol: optimizeForSpeed (a quicker PNG) about halves
  // the time page.screenshot takes, which is most of each frame
  const cdp = await page.context().newCDPSession(page);

  const href = new URL(`?show=${id}&capture${flag("ui") ? "=ui" : ""}`, url).href;
  console.log(`loading ${href} at ${width}x${height}…`);
  await page.goto(href, { waitUntil: "load" });
  await page.waitForFunction(() => (window as unknown as { __showVideo: Hooks }).__showVideo.ready(), undefined, { timeout: 180_000 });
  if (!(await h("hooked"))) throw new Error("the page's requestAnimationFrame is not this tool's (the clock replaced it?)");
  const { duration } = await h("state");

  // from here on, time moves only when this tool moves it
  const fakeNow = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(fakeNow + 100);
  let cursor = 0; // ms of fake time since the pause
  /** moves time to `ms` in steps of at most 50 ms, drawing at each (and once, if it's there already) */
  const advanceTo = async (ms: number) => {
    do {
      const step = Math.min(50, ms - cursor);
      if (step > 0) await page.clock.runFor(step);
      cursor += Math.max(0, step);
      const errs = await h("frame");
      if (errs.length) throw new Error(`a frame threw:\n${errs.join("\n")}`);
    } while (cursor < ms);
    if (pageErrors.length) throw new Error(`the page threw:\n${pageErrors.join("\n")}`);
  };
  const frameMs = 1000 / fps;

  // the opening camera move (1.6 s) and the paused face come to rest
  for (let j = 1; j <= Math.ceil(2 * fps); j++) await advanceTo(Math.round(j * frameMs));

  const from = Math.min(fromArg, duration);
  const to = Math.min(toArg ?? duration, duration);
  if (!(to > from)) throw new Error(`nothing to render: --from ${from} --to ${to} (the song is ${duration.toFixed(2)} s)`);
  // only whole frames inside the span: a last frame past the audio's end would be cut by -shortest
  const n = Math.floor((to - from) * fps + 1e-9);
  if (n < 1) throw new Error(`--from ${from} --to ${to} is less than a frame`);

  // seek a second early, then play that second unrecorded
  const s0 = Math.max(0, from - 1);
  await h("seek", s0);
  await h("play");
  if (!(await h("state")).playing) throw new Error("play() didn't start the transport");
  const playAt = cursor;
  const lead = from - s0;
  const leadFrames = Math.floor(lead * fps + 1e-9);
  for (let j = 1; j <= leadFrames; j++) await advanceTo(playAt + Math.round(j * frameMs));

  console.log(`rendering ${n} frames (${from.toFixed(3)}–${to.toFixed(3)} s at ${fps} fps) to ${frames}`);
  const checkEvery = Math.max(1, Math.round(fps));
  let worst = 0;
  const t0 = performance.now();
  let lastReport = t0;
  let prevShot: Buffer | null = null;
  let repeats = 0;
  let capture = 0; // ms spent capturing, which is where Chrome composites and rasterizes the frame
  for (let k = 0; k < n; k++) {
    await advanceTo(playAt + Math.round((lead + k / fps) * 1000));
    if (k % checkEvery === 0 || k === n - 1) {
      const st = await h("state");
      const want = from + k / fps;
      const err = Math.abs(st.time - want);
      worst = Math.max(worst, err);
      if (!st.playing || err > 0.5 / fps) throw new Error(`frame ${k}: the playhead is ${st.time.toFixed(4)} s, want ${want.toFixed(4)} s (${st.playing ? "playing" : "stopped"})`);
    }
    const c0 = performance.now();
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true });
    const shot = Buffer.from(data, "base64");
    writeFileSync(join(frames, `${String(k + 1).padStart(6, "0")}.png`), shot);
    if (prevShot && shot.equals(prevShot)) repeats++;
    prevShot = shot;
    capture += performance.now() - c0;
    const now = performance.now();
    // a line that redraws on a terminal; one every 15 s into a log
    if (now - lastReport > (process.stdout.isTTY ? 1000 : 15000) || k === n - 1) {
      lastReport = now;
      const rate = (k + 1) / ((now - t0) / 1000);
      const line = `  frame ${k + 1}/${n}  ${rate.toFixed(2)} frames/s  eta ${((n - k - 1) / rate).toFixed(0)} s`;
      if (process.stdout.isTTY) process.stdout.write(`\r${line}   `);
      else console.log(line);
    }
  }
  const secs = (performance.now() - t0) / 1000;
  console.log(`\n${n} frames in ${secs.toFixed(1)} s: ${(n / secs).toFixed(2)} frames/s (${((n / fps) / secs).toFixed(3)}× real time); playhead within ${(worst * 1000).toFixed(2)} ms of each checked frame; ${((capture / secs) / 10).toFixed(0)}% of it capturing (which includes compositing and SwiftShader's drawing)`);
  // a still frame now and then is the song resting; all of them is a page that stopped drawing
  if (n > 2 && repeats >= n - 1) throw new Error("every frame is the same image: the page isn't drawing");
  await browser.close();

  const muxArgs = ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(frames, "%06d.png"), "-ss", from.toFixed(6), "-t", (n / fps).toFixed(6), "-i", audio,
    "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out];
  const mux = spawnSync("ffmpeg", muxArgs, { stdio: "inherit" });
  if (mux.status !== 0) {
    keepFrames = true;
    throw new Error(`ffmpeg failed (${mux.status}); the frames are kept, to mux again:\n  ffmpeg ${muxArgs.map((a) => (/^[\w./:+%-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ")}`);
  }
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets:format=duration", "-of", "default=nw=1:nk=1", out], { encoding: "utf8" });
  const [got, dur] = probe.stdout.trim().split("\n").map(Number);
  console.log(`${out}: ${dur.toFixed(3)} s, ${got} frames${got === n ? "" : ` (rendered ${n}!)`}`);
  if (got !== n) throw new Error(`the video has ${got} frames, not the ${n} rendered`);
} catch (e) {
  failed = true;
  console.error(`\nshow-video: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await browser.close().catch(() => {});
  if (keepFrames && frames) console.log(`frames kept in ${frames}`);
  cleanUp();
}
process.exit(failed ? 1 : 0);
