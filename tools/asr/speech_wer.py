"""Speech intelligibility of the engine, scored by Whisper: render each sentence with
`chimera render text` in the male and female voices, transcribe it with faster-whisper
(small.en, greedy, so the same audio gives the same words) and count word errors.

usage: speech_wer.py <outdir> [--against earlier/wer.json]

Writes <outdir>/wer.json and the renders. With --against it says whether the word error rate
rose by more than SLACK points, which a tuning loop treats as a speech regression.

Set up once with tools/asr/setup.sh (a Python env and the model in ~/.cache/chimera-asr).
The sentences are in sentences.tsv: Harvard sentences (IEEE 1969) and semantically
unpredictable ones, which Whisper can't guess from context.
"""

import json
import os
import re
import subprocess
import sys
import wave
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from faster_whisper import WhisperModel

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
CACHE = os.path.expanduser("~/.cache/chimera-asr/models")
BODIES = ("male", "female")
# word error rate (points) a change may add before it counts as a speech regression
SLACK = 3.0


def words(text):
    text = re.sub(r"[^a-z' ]+", " ", text.lower().replace("’", "'"))
    return [w.strip("'") for w in text.split() if w.strip("'")]


def edits(ref, hyp):
    d = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        prev, d[0] = d[0], i
        for j, h in enumerate(hyp, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (r != h))
    return d[len(hyp)]


def load16k(path):
    """Mono float32 at 16 kHz from a 16-bit PCM WAV (band-limited FFT resampling)."""
    with wave.open(path) as w:
        ch, rate = w.getnchannels(), w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float64) / 32768.0
    x = x.reshape(-1, ch).mean(axis=1)
    n = int(round(len(x) * 16000 / rate))
    return (np.fft.irfft(np.fft.rfft(x)[: n // 2 + 1], n) * (n / len(x))).astype(np.float32)


def main():
    args = sys.argv[1:]
    against = None
    if "--against" in args:
        i = args.index("--against")
        against = args[i + 1]
        del args[i : i + 2]
    out = args[0]
    os.makedirs(out, exist_ok=True)
    sentences = [line.rstrip("\n").split("\t") for line in open(os.path.join(HERE, "sentences.tsv"))]
    chimera = os.path.join(REPO, "target/release/chimera")
    jobs = [(kind, text, body, os.path.join(out, f"{kind}-{body}-{i + 1:02d}"))
            for i, (kind, text) in enumerate(sentences) for body in BODIES]

    def render(job):
        _, text, body, stem = job
        subprocess.run([chimera, "render", "text", stem, text, body], check=True, capture_output=True)

    with ThreadPoolExecutor(os.cpu_count()) as pool:
        list(pool.map(render, jobs))

    model = WhisperModel("small.en", device="cpu", compute_type="int8", cpu_threads=os.cpu_count(),
                         download_root=CACHE)
    rows, totals = [], {}
    for kind, text, body, stem in jobs:
        segs, _ = model.transcribe(load16k(stem + ".wav"), language="en", beam_size=1, temperature=0.0,
                                   condition_on_previous_text=False, vad_filter=False)
        heard = " ".join(s.text.strip() for s in segs)
        ref = words(text)
        e = edits(ref, words(heard))
        rows.append({"kind": kind, "body": body, "text": text, "heard": heard, "errors": e, "words": len(ref)})
        for key in (f"{kind}-{body}", "all"):
            t = totals.setdefault(key, [0, 0])
            t[0] += e
            t[1] += len(ref)
    wer = {k: round(100.0 * e / n, 2) for k, (e, n) in totals.items()}
    report = {"wer": wer, "sentences": rows}
    with open(os.path.join(out, "wer.json"), "w") as f:
        json.dump(report, f, indent=1)
    for r in rows:
        if r["errors"]:
            print(f"  {r['kind']:8s} {r['body']:6s} {r['errors']}/{r['words']}  {r['text']}  →  {r['heard']}")
    print("word error rate (%): " + ", ".join(f"{k} {v}" for k, v in sorted(wer.items())))
    if against:
        old = json.load(open(against))["wer"]["all"]
        new = wer["all"]
        verdict = "WORSE" if new > old + SLACK else "OK"
        print(f"speech verdict against {against}: {verdict} (word error rate {old} → {new} %, slack {SLACK})")


main()
