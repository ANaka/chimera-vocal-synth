//! The `chimera` binary end to end: a render writes a sound of the planned length, and the
//! calibrations reproduce the tables the engine embeds.

use chimera::math::js_round;
use chimera::phonetics::ipa::tokenize_ipa;
use chimera::phonetics::planner::{PlanOptions, plan_utterance};
use std::process::Command;

const PHONETICS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../chimera/src/phonetics");

fn chimera(args: &[&str]) -> String {
    let out = Command::new(env!("CARGO_BIN_EXE_chimera"))
        .args(args)
        .output()
        .expect("run chimera");
    assert!(
        out.status.success(),
        "chimera {args:?} failed:\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}

fn tmp(name: &str) -> String {
    format!("{}/{name}", env!("CARGO_TARGET_TMPDIR"))
}

#[test]
fn render_speech_writes_a_sounding_wav_of_the_planned_length() {
    let stem = tmp("hello");
    let stdout = chimera(&["render", "speech", &stem, "ˈhɛloʊ"]);
    assert!(
        stdout.starts_with(&format!("wrote {stem}.wav  1.10 s  peak ")),
        "{stdout}"
    );

    let b = std::fs::read(format!("{stem}.wav")).unwrap();
    assert_eq!(&b[0..4], b"RIFF");
    assert_eq!(&b[8..16], b"WAVEfmt ");
    let u16_at = |i: usize| u16::from_le_bytes([b[i], b[i + 1]]);
    let u32_at = |i: usize| u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
    assert_eq!(
        (u16_at(20), u16_at(22), u32_at(24), u16_at(34)),
        (1, 1, 48000, 16),
        "16-bit PCM mono 48 kHz"
    );
    let samples: Vec<i16> = b[44..]
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect();
    assert_eq!(u32_at(40) as usize, samples.len() * 2);

    // the tool renders until 0.35 s + 0.2 s after the plan's end (TS wrote 52 692 samples)
    let plan = plan_utterance(
        &tokenize_ipa("ˈhɛloʊ"),
        &PlanOptions {
            body: "male".into(),
            t0: 0.05,
            f0: Some(110.0),
            ..Default::default()
        },
    );
    let expected = js_round(48000.0 * (plan.end + 0.35 + 0.2)) as usize;
    assert_eq!(samples.len(), expected);
    assert_eq!(samples.len(), 52692);

    let peak = samples.iter().map(|s| s.unsigned_abs()).max().unwrap();
    assert!(peak > 3000, "peak {peak}");
    let loud = samples.iter().filter(|s| s.unsigned_abs() > 300).count();
    assert!(
        loud > samples.len() / 10,
        "only {loud} of {} samples above −40 dB",
        samples.len()
    );
}

#[test]
fn calibrate_consonants_reproduces_the_committed_table() {
    let out = tmp("consonantTargets.json");
    chimera(&["calibrate", "consonants", "--out", &out]);
    let got = std::fs::read_to_string(&out).unwrap();
    let want =
        std::fs::read_to_string(format!("{PHONETICS}/consonantTargets.generated.json")).unwrap();
    assert!(
        got == want,
        "calibrate consonants differs from the committed table"
    );
}

/// About 100 s in release. Not byte-identical: the Nelder–Mead fit runs 1 800 + 2 × 1 000
/// iterations on a flat minimum, which amplifies last-ulp differences between V8's libm and Rust's
/// (in the airway geometry and the transfer function) into ~1e-4 changes of the fitted posture.
/// Three entries round the other way at the third decimal: male /ə/ root, child /u/ lipAp (the TS
/// tool gives the committed values), and female /a/ (the TS tool at the port's base commit does
/// not reproduce its committed values either; Rust gives what TS gives today). Everything else,
/// layout and key order included, is identical.
#[test]
#[ignore = "slow (~100 s): cargo test -p chimera-cli --release -- --ignored"]
fn calibrate_vowels_reproduces_the_committed_table() {
    let out = tmp("vowelTargets.json");
    let _ = std::fs::remove_file(&out);
    chimera(&["calibrate", "vowels", "all", "--out", &out]);
    let got = std::fs::read_to_string(&out).unwrap();
    let want = std::fs::read_to_string(format!("{PHONETICS}/vowelTargets.generated.json")).unwrap();
    let (g, w): (Vec<&str>, Vec<&str>) = (got.lines().collect(), want.lines().collect());
    assert_eq!(g.len(), w.len(), "line count");
    let mut differing = Vec::new();
    for (i, (a, b)) in g.iter().zip(&w).enumerate() {
        if a == b {
            continue;
        }
        // only a posture value may differ, and only in the last digit or two
        let split = |l: &str| -> (String, f64) {
            let (k, v) = l
                .trim()
                .trim_end_matches(',')
                .split_once(": ")
                .unwrap_or_else(|| panic!("line {}: {a:?} vs {b:?}", i + 1));
            (
                k.to_string(),
                v.parse()
                    .unwrap_or_else(|_| panic!("line {}: {a:?} vs {b:?}", i + 1)),
            )
        };
        let ((ka, va), (kb, vb)) = (split(a), split(b));
        assert_eq!(ka, kb, "line {}", i + 1);
        assert!(
            [
                "\"tbX\"",
                "\"tbY\"",
                "\"jaw\"",
                "\"lipAp\"",
                "\"lipProt\"",
                "\"lipWidth\"",
                "\"root\"",
                "\"larynx\"",
                "\"ttX\"",
                "\"ttY\"",
                "\"ttCurl\""
            ]
            .contains(&ka.as_str()),
            "line {}: {a:?} vs {b:?}",
            i + 1
        );
        assert!((va - vb).abs() <= 0.0025, "line {}: {a:?} vs {b:?}", i + 1);
        differing.push(i + 1);
    }
    assert!(
        differing.len() <= 8,
        "{} posture values differ (lines {differing:?})",
        differing.len()
    );
}

#[test]
fn render_notes_artic_tracks_follow_the_sound_without_changing_it() {
    let melody = tmp("melody.json");
    std::fs::write(
        &melody,
        r#"{"bpm": 120, "t0": 0, "lyrics": "Take my hand", "notes": [[0, 1], [67, 1], [63, 0.5], [60, 1.5]]}"#,
    )
    .unwrap();
    let (plain, tracked, tracks) = (tmp("notes-plain"), tmp("notes-tracked"), tmp("notes-artic.json"));
    chimera(&["render", "notes", &melody, &plain, "female"]);
    let stdout = chimera(&["render", "notes", &melody, &tracked, "female", "--artic", &tracks]);
    let a = std::fs::read(format!("{plain}.wav")).unwrap();
    let b = std::fs::read(format!("{tracked}.wav")).unwrap();
    assert!(a == b, "--artic changed the sound");

    let j: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&tracks).unwrap()).unwrap();
    assert_eq!(j["rate"], 100);
    let keys: Vec<&str> = j["keys"].as_array().unwrap().iter().map(|k| k.as_str().unwrap()).collect();
    assert_eq!(keys.len(), 17);
    let frames = j["frames"].as_array().unwrap();
    // one frame at t = 0 and one per 480 samples rendered
    let samples = (a.len() - 44) / 2;
    assert_eq!(frames.len(), 1 + samples.div_ceil(480), "{stdout}");
    assert!(frames.iter().all(|f| f.as_array().unwrap().len() == 17));
    // the lips close for the /m/ of "my" (its note starts at 1 s) and open for its vowel
    let lip = keys.iter().position(|k| *k == "lipAp").unwrap();
    let ap = |i: usize| frames[i][lip].as_f64().unwrap();
    let closed = (85..105).map(ap).fold(f64::MAX, f64::min);
    let open = (105..125).map(ap).fold(f64::MIN, f64::max);
    assert!(closed < 0.1 && open > 0.5, "lipAp closed {closed}, open {open}");
}
