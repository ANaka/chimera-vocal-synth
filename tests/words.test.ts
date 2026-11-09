/**
 * Words at the mouth: each spoken word's span in a speech plan, across diphthongs (planned as two
 * vowels) and phrase breaks.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { initEngine } from "./harness.ts";
import type { Trail } from "../src/ui/mouthWords.ts";

await initEngine();
const { EnglishG2P, planPhrases, tokenizeIpa } = await import("../src/wasm/engine.ts");
const { wordSpans } = await import("../src/ui/words.ts");
const { advanceTrail, wordSpot } = await import("../src/ui/mouthWords.ts");
const g2p = new EnglishG2P();
g2p.setDictionaryText(gunzipSync(readFileSync(new URL("../public/data/cmudict.txt.gz", import.meta.url))).toString());
const male = { female: 0, child: 0 };

describe("word spans", () => {
  test("a diphthong doesn't shift the words after it", () => {
    const phrases = g2p.toPhrases("I'll be here all week.");
    const plan = planPhrases(phrases, { body: male, t0: 0 });
    const words = wordSpans(phrases, plan);
    expect(words.map((w) => w.text)).toEqual(["i'll", "be", "here", "all", "week"]);
    // "I'll" is a, ɪ, ɫ in the plan: it ends where the ɫ ends, and "be" starts on the b
    const l = plan.segments.findIndex((s) => s.ipa === "ɫ");
    expect(words[0].t1).toBe(plan.segments[l].t1);
    expect(words[1].t0).toBe(plan.segments.find((s) => s.ipa === "b")!.t0);
    expect(words[4].t1).toBe(plan.segments[plan.segments.length - 1].t1);
    for (let i = 1; i < words.length; i++) expect(words[i].t0).toBeGreaterThanOrEqual(words[i - 1].t1 - 1e-9);
  });

  test("phrases follow one another, and IPA input is shown as IPA", () => {
    const phrases = [
      { segments: tokenizeIpa("haɪ ðɛə"), intonation: "statement" as const, pause: 0.3 },
      { segments: tokenizeIpa("goʊ"), intonation: "statement" as const, pause: 0.3 },
    ];
    const plan = planPhrases(phrases, { body: male, t0: 0 });
    const words = wordSpans(phrases, plan);
    expect(words.map((w) => w.text)).toEqual(["haɪ", "ðɛə", "goʊ"]);
    // the second phrase's word starts after the pause, on its own g
    expect(words[2].t0).toBe(plan.segments.find((s) => s.ipa === "g")!.t0);
    expect(words[2].t0).toBeGreaterThan(words[1].t1 + 0.2);
  });
});

describe("words said", () => {
  test("a token with no sound isn't a word, so the next word keeps its place", () => {
    const phrases = g2p.toPhrases("hello -- world");
    const ends = phrases.flatMap((p) => p.segments).filter((s) => s.wordEnd).length;
    expect(phrases.flatMap((p) => p.words)).toEqual(["hello", "world"]);
    expect(ends).toBe(2);
    const plan = planPhrases(phrases, { body: male, t0: 0 });
    expect(wordSpans(phrases, plan).map((w) => w.text)).toEqual(["hello", "world"]);
  });
});

describe("the trail at the mouth", () => {
  const word = (key: string) => ({ key, text: key });
  test("a word that comes back after a brief gap stays, a new one sends it off", () => {
    const t = { entries: [] as { word: { key: unknown; text: string }; left: number | null }[] };
    advanceTrail(t, word("a"), 0);
    advanceTrail(t, null, 0.02); // a frame between two notes of one syllable
    expect(t.entries[0].left).toBe(0.02);
    advanceTrail(t, word("a"), 0.04);
    expect(t.entries.map((e) => [e.word.key, e.left])).toEqual([["a", null]]);
    advanceTrail(t, word("b"), 0.1);
    expect(t.entries.map((e) => [e.word.key, e.left])).toEqual([["a", 0.1], ["b", null]]);
    // gone once it has flown off
    advanceTrail(t, word("b"), 1);
    expect(t.entries.map((e) => e.word.key)).toEqual(["b"]);
  });

  test("a word that comes back while flying off forgets where it left from", () => {
    const t: Trail = { entries: [] };
    advanceTrail(t, word("a"), 0);
    advanceTrail(t, null, 0.02);
    t.entries[0].spot = wordSpot(622, 1080, 547, 628, 27, 1, 549);
    advanceTrail(t, word("a"), 0.04);
    expect(t.entries.length).toBe(1);
    expect(t.entries[0].left).toBeNull();
    expect(t.entries[0].spot).toBeUndefined();
  });
});

describe("where the words at the mouth go", () => {
  // a duet pane at 1920×1080 (three heads side by side): the overlay is 622 px wide, the face at
  // 27 px per cm; the lips' midline is 509 px across at rest
  const W = 622, H = 1080;

  test("a face at rest has its words in front of the lips, clear of their outline", () => {
    const s = wordSpot(W, H, 509, 595, 27, 1, 506);
    expect([s.at, s.y]).toEqual(["front", 595]);
    expect(s.x).toBeCloseTo(509 + 1.2 * 27);
    expect(s.lo).toBe(s.x);
    expect(s.hi).toBeCloseTo(W - 14);
    // a corner of the mouth turned out past the midline pushes them on
    expect(wordSpot(W, H, 470, 595, 27, 1, 500).x).toBeCloseTo(500 + 0.6 * 27);
    // facing left: the same, mirrored
    const l = wordSpot(W, H, W - 509, 595, 27, -1, W - 506);
    expect(l.at).toBe("front");
    expect(l.x).toBeCloseTo(W - 509 - 1.2 * 27);
    expect(l.lo).toBe(14);
    expect(l.hi).toBe(l.x);
  });

  test("a face swung to the pane's edge has its words under the chin, not at the bottom of the pane", () => {
    // the duet's lead at 41.5 s in a show whose singer turns and nods: the lips' midline 547 px
    // across, 47 px from the edge; the words went to the bottom of the pane, 18 cm below the lips
    const s = wordSpot(W, H, 547, 628, 27, 1, 549);
    expect(s.at).toBe("chin");
    expect(s.x).toBeCloseTo(547 + 27);
    expect(s.y).toBeCloseTo(628 + 6.5 * 27);
    // a long word may reach back under the jaw, but not more than a cm behind the lips (the throat)
    expect([s.lo, s.hi]).toEqual([547 - 27, W - 8]);
    const l = wordSpot(W, H, W - 547, 628, 27, -1, W - 549);
    expect([l.at, l.x, l.lo, l.hi]).toEqual(["chin", W - 547 - 27, 8, W - 547 + 27]);
  });

  test("on a laptop's duet panes the turned face's words stay under the chin too", () => {
    // 1280×720: 409 px panes, 16.6-17.6 px per cm through the turn (see the 3D view's scale below);
    // the turn left 26 px in front of the lips
    const s = wordSpot(408.7, 635, 347.9, 420, 16.6, 1, 349);
    expect(s.at).toBe("chin");
    expect(s.y).toBeCloseTo(420 + 6.5 * 16.6);
  });

  test("on a phone's duet panes, where the words are taller than the room under the chin, they go below the neck", () => {
    // 375×812: 114 px panes, the lips at the pane's edge, 8.3 px per cm (the words' 26 px floor is
    // over 3 cm there)
    const s = wordSpot(114, 665, 117, 348, 8.3, 1, 116);
    expect([s.at, s.x, s.lo, s.hi]).toEqual(["neck", 117, 8, 106]);
    expect(s.y).toBeCloseTo(348 + 18 * 8.3);
    expect(wordSpot(114, 400, 117, 348, 8.3, 1, 116).y).toBe(400 - 14);
  });

  test("a face swaying at the limit doesn't flicker between front and under", () => {
    // words in front stay there down to 50 px of room, and come back at 60
    const at = (lx: number, was?: "front" | "chin") => wordSpot(W, H, lx, 595, 27, 1, lx, was).at;
    // ahead = 622 - (lx + 32.4) - 14
    expect([at(509), at(520), at(520, "front"), at(530, "front")]).toEqual(["front", "chin", "front", "chin"]);
    expect([at(520, "chin"), at(515, "chin")]).toEqual(["chin", "front"]);
  });

  test("a laptop's turned duet face keeps its words under the chin; a tablet's go below the neck", () => {
    // 1024×768: the lead's face measured 12.8-13.9 px per cm through its turn, after a seek too
    // (12.5-13.5 thresholds sent it below the neck at 12.9 and held it there); a tablet's three
    // duet panes measure 10.8-11.05 px per cm
    const at = (cm: number, was?: "front" | "chin" | "neck") => wordSpot(323, 635, 270, 356, cm, 1, 270, was).at;
    expect([at(12.8), at(12.8, "front"), at(12.0, "chin"), at(13.2, "neck")]).toEqual(["chin", "chin", "chin", "chin"]);
    expect([at(11.05), at(11.7, "chin"), at(12.2, "neck"), at(12.3, "neck")]).toEqual(["neck", "neck", "neck", "chin"]);
  });

  test("under the chin stays on the screen", () => {
    expect(wordSpot(W, 700, 547, 628, 27, 1).y).toBe(700 - 14);
    // lips swung past the pane's edge still leave the words 3 cm
    const s = wordSpot(W, H, 640, 600, 27, 1, 641);
    expect([s.at, s.lo, s.hi]).toEqual(["chin", W - 8 - 81, W - 8]);
    const l = wordSpot(W, H, -18, 600, 27, -1, -19);
    expect([l.at, l.lo, l.hi]).toEqual(["chin", 8, 8 + 81]);
  });

});

describe("the 3D view's scale at the lips", () => {
  test("a turned head doesn't shrink it", async () => {
    // it measured a cm along the camera's right in the head's own axes, so a turn foreshortened it
    // (31 % at this pose; the duet's lead went 17.6 → 12.9 px per cm at 1280×720) and the words
    // took the face for a phone's
    const THREE = await import("three");
    const { Anatomy3D } = await import("../src/ui/render/anatomy3d.ts");
    const r = new Anatomy3D();
    r.resize(622, 1080);
    r.camera.position.set(30, 5, 40);
    r.camera.lookAt(0, 0, 0);
    r.camera.updateMatrixWorld(true);
    const head = (r as unknown as { beams: { group: InstanceType<typeof THREE.Group> } }).beams.group;
    head.updateMatrixWorld(true);
    const rest = r.pxPerCmAt(8, -6, 0);
    head.quaternion.setFromEuler(new THREE.Euler(0, 0.6, 0.2, "YXZ"));
    head.updateMatrixWorld(true);
    // only the lips' depth changes it (perspective): 8 % here
    expect(r.pxPerCmAt(8, -6, 0) / rest).toBeGreaterThan(0.9);
    r.dispose();
  });
});
