//! Fast sung runs (scat): every vowel lands on its beat however short the note, and the pitch
//! moves on the onset consonant, so it has arrived when the vowel starts.
use chimera::control::score::ControlKey;
use chimera::phonetics::english::EnglishG2P;
use chimera::phonetics::sing::{SongOptions, SungNote, midi_to_hz, plan_song};
use chimera::phonetics::syllables::lyrics_to_syllables;
use chimera::phonetics::{Plan, PlannedSegment};

fn g2p() -> EnglishG2P {
    let mut g = EnglishG2P::new();
    g.load_dict("bah\tB AA1\nbee\tB IY1\nbop\tB AA1 P\ndee\tD IY1\ndoo\tD UW1\nscoo\tS K UW1\nskee\tS K IY1\nstrut\tS T R AH1 T\n");
    g
}

/// The melody alternates C4 and E4, `beats` long each.
fn sing(lyrics: &str, beats: f64, bpm: f64) -> (Vec<SungNote>, Vec<f64>, Plan) {
    let syl = lyrics_to_syllables(lyrics, &g2p());
    let notes: Vec<SungNote> = syl.iter().enumerate().map(|(i, s)| SungNote { midi: if i % 2 == 0 { 60.0 } else { 64.0 }, beats, syl: s.clone() }).collect();
    let times = (0..notes.len()).map(|i| 0.5 + i as f64 * beats * 60.0 / bpm).collect();
    let plan = plan_song(&notes, &SongOptions { body: "male".into(), bpm, t0: 0.5, vibrato: 0.0 });
    (notes, times, plan)
}

/// The first vowel segment of each syllable (a diphthong's second part follows its first).
fn vowel_onsets(segs: &[PlannedSegment]) -> Vec<f64> {
    segs.iter().enumerate().filter(|(i, s)| s.kind == "vowel" && (*i == 0 || segs[i - 1].kind != "vowel")).map(|(_, s)| s.t0).collect()
}

#[test]
fn fast_runs_land_on_the_beat() {
    for lyrics in ["scoo bah dee bop scoo bah dee bop", "skee dee bop bah skee dee bop bah", "bah bee doo bop bah bee doo bop", "strut strut strut strut"] {
        for (bpm, beats) in [(184.0, 0.25), (184.0, 1.0 / 3.0), (240.0, 0.25), (100.0, 0.5)] {
            if lyrics.starts_with("strut") && bpm == 240.0 {
                continue; // four consonants in a 62 ms note: see too_many_consonants_degrade_gently
            }
            let (_, times, plan) = sing(lyrics, beats, bpm);
            let got = vowel_onsets(&plan.segments);
            assert_eq!(got.len(), times.len(), "{lyrics:?} at {bpm} bpm");
            for (k, (g, want)) in got.iter().zip(&times).enumerate() {
                assert!((g - want).abs() < 1e-6, "{lyrics:?}, {beats} beats at {bpm} bpm: vowel {k} at {g:.4} s, its beat is {want:.4} s");
            }
            // and every vowel still sounds for a while
            for s in plan.segments.iter().filter(|s| s.kind == "vowel") {
                assert!(s.t1 - s.t0 >= 0.02 - 1e-9, "{lyrics:?}: a {:.3} s vowel", s.t1 - s.t0);
            }
        }
    }
}

#[test]
fn too_many_consonants_degrade_gently() {
    // "t | s t r" between vowels can't shrink below its floor in a 62 ms note: the vowels keep
    // their 20 ms and the run slips a few milliseconds a note instead of a whole note
    let (_, times, plan) = sing("strut strut strut strut", 0.25, 240.0);
    for (k, (g, want)) in vowel_onsets(&plan.segments).iter().zip(&times).enumerate() {
        assert!(g - want < 0.008 * k as f64 + 1e-6, "vowel {k} {:.1} ms late", (g - want) * 1000.0);
    }
}

#[test]
fn notes_with_room_keep_their_consonants() {
    // at a walking pace nothing is squeezed: the onset is the consonant's sung length
    let (_, _, plan) = sing("bah dee bah dee", 1.0, 100.0);
    let d = plan.segments.iter().find(|s| s.ipa == "d").unwrap();
    assert!(d.t1 - d.t0 > 0.04, "d squeezed to {:.3} s", d.t1 - d.t0);
}

#[test]
fn onset_consonants_carry_the_new_pitch() {
    let (notes, _, plan) = sing("bah dee bah dee", 1.0 / 3.0, 184.0);
    let d = plan.segments.iter().find(|s| s.ipa == "d").unwrap();
    let hz = midi_to_hz(notes[1].midi);
    let on_d = plan.gestures.iter().any(|g| (g.t0 - d.t0).abs() < 1e-9 && g.targets.get(ControlKey::F0) == Some(hz));
    assert!(on_d, "no pitch gesture for {hz:.1} Hz starting on the 'd' at {:.4} s", d.t0);
}
