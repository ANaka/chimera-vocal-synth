/**
 * Words at the mouth: each spoken word's span in a speech plan, across diphthongs (planned as two
 * vowels) and phrase breaks.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { initEngine } from "./harness.ts";

await initEngine();
const { EnglishG2P, planPhrases, tokenizeIpa } = await import("../src/wasm/engine.ts");
const { wordSpans } = await import("../src/ui/words.ts");
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
