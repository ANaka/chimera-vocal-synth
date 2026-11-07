//! The CSD comparison as one number, and the verdict on a change.
//!
//! Each term is a song-level measure both voices have: her median H1−H2 in a song against the
//! synth's in the same song, her share of voiced frames against the synth's, and so on. A term's
//! gap is the mean over songs of |synth − singer|, divided by the spread of her own values over
//! the training songs (median absolute deviation, scaled to a standard deviation; taken from all
//! her notes, so nothing the synth does can move it). A gap within
//! one spread is about as close as two of her own songs are to each other and costs nothing;
//! beyond that, the excess is the term's cost. The score is the weighted mean of the costs:
//! lower is better, and 0 means every term is within her own variation.
//!
//! Every fifth song (en005, en010, …, in both keys) is held out. The spreads and the verdict use
//! the training songs only; the held-out songs are scored with the same spreads, as a check that
//! a change carries over to songs it was not tuned on.
//!
//! `--against <score.json>` compares the training score with an earlier run's. A change is
//! better when the score falls by at least `MARGIN`, no term's cost rises by more than
//! `TERM_SLACK`, and no guard breaks. The verdict compares like for like: each term's cost is
//! recomputed for both runs over the songs both runs measure, so a song that stops being
//! measured (say, its vibrato no longer reads as vibrato) can't take its gap out of the
//! comparison. Within a song, a measure that the synth gave on a note before and doesn't now
//! breaks a guard, since it would otherwise leave the song's median quietly.

use super::{mean, median};
use serde_json::{Value, json};

pub const N_TERMS: usize = 13;

/// (name, weight). The weights give each group one share: spectrum, H1−H2, vibrato, voicing,
/// onsets and noise.
pub const TERMS: [(&str, f64); N_TERMS] = [
    ("level 0-.5k", 0.2),
    ("level .5-1k", 0.2),
    ("level 1-2k", 0.2),
    ("level 2-4k", 0.2),
    ("level 4-8k", 0.2),
    ("H1-H2", 1.0),
    ("vibrato share", 1.0 / 3.0),
    ("vibrato depth", 1.0 / 3.0),
    ("vibrato rate", 1.0 / 3.0),
    ("voiced share", 1.0),
    ("onset, vowel-initial", 0.5),
    ("onset, voiceless-initial", 0.5),
    ("aperiodicity", 1.0),
];

/// fewest training songs a spread is taken over
const MIN_SPREAD_SONGS: usize = 5;
/// fewest songs a gap is averaged over
const MIN_GAP_SONGS: usize = 3;
/// a change must lower the training score by this much to be better
pub const MARGIN: f64 = 0.01;
/// no term's cost may rise by more than this, whatever the score does
const TERM_SLACK: f64 = 0.25;
/// guards: largest rise in note MCD (dB) and synth pitch error (cents), largest fall in envelope
/// correlation
const MCD_SLACK: f64 = 0.1;
const PITCH_SLACK: f64 = 2.0;
const CORR_SLACK: f64 = 0.01;

/// What `coverage` counts per song: the notes compared, and the notes on which the synth gives each
/// guarded measure. Vibrato depth and rate are not counted: they exist only on notes with
/// vibrato, and the vibrato share term already scores how many have it.
pub const N_COVERAGE: usize = 13;
pub const COVERAGE: [&str; N_COVERAGE] = [
    "notes compared",
    "level 0-.5k",
    "level .5-1k",
    "level 1-2k",
    "level 2-4k",
    "level 4-8k",
    "H1-H2",
    "notes long enough for vibrato",
    "voiced share",
    "onset, vowel-initial",
    "onset, voiceless-initial",
    "aperiodicity",
    "pitch",
];
/// at most this many coverage losses are listed in a verdict
const MAX_LISTED: usize = 6;

/// Held out of tuning: every fifth song number, in both keys.
pub fn held_out(id: &str) -> bool {
    let digits: String = id.chars().filter(|c| c.is_ascii_digit()).collect();
    digits.parse::<u32>().is_ok_and(|n| n % 5 == 0)
}

/// One song's inputs to the score.
pub struct SongScore {
    pub id: String,
    /// per term, the singer's value over all her notes: the spreads are taken from these
    pub singer_all: [f64; N_TERMS],
    /// per term (singer, synth) over the notes compared; NaN where that side has no value
    pub pairs: [(f64, f64); N_TERMS],
    /// per `COVERAGE` entry, how many notes
    pub coverage: [u64; N_COVERAGE],
    pub notes: usize,
    pub misaligned: usize,
    pub dropped: u64,
    /// mean note MCD (dB)
    pub mcd: f64,
    pub env_corr: f64,
    /// the synth's median |cents| off the score
    pub synth_pitch: f64,
}

fn mad_sd(xs: &[f64]) -> f64 {
    let m = median(xs);
    1.4826 * median(&xs.iter().map(|x| (x - m).abs()).collect::<Vec<_>>())
}

/// The singer's spread of each term over these songs; NaN with too few songs or none at all.
fn spreads(train: &[&SongScore]) -> [f64; N_TERMS] {
    std::array::from_fn(|k| {
        let h: Vec<f64> = train
            .iter()
            .map(|s| s.singer_all[k])
            .filter(|v| v.is_finite())
            .collect();
        let sd = mad_sd(&h);
        if h.len() >= MIN_SPREAD_SONGS && sd > 0.0 {
            sd
        } else {
            f64::NAN
        }
    })
}

fn r3(x: f64) -> Value {
    if x.is_finite() {
        json!((x * 1000.0).round() / 1000.0)
    } else {
        Value::Null
    }
}

fn r4(x: f64) -> Value {
    if x.is_finite() {
        json!((x * 10000.0).round() / 10000.0)
    } else {
        Value::Null
    }
}

/// A term's cost from its per-song gaps |synth − singer|: the mean gap in units, less one unit.
/// NaN with too few songs or no unit (`f64::max` would turn that into a cost of 0).
fn term_cost(gaps: &[f64], unit: f64) -> f64 {
    let z = if gaps.len() >= MIN_GAP_SONGS {
        mean(gaps) / unit
    } else {
        f64::NAN
    };
    if z.is_finite() {
        (z - 1.0).max(0.0)
    } else {
        f64::NAN
    }
}

/// A number, or null when it isn't finite (full precision: the verdict recomputes from these).
fn fin(x: f64) -> Value {
    if x.is_finite() { json!(x) } else { Value::Null }
}

/// Score and guards of a set of songs, with the spreads of the training songs.
fn score_set(songs: &[&SongScore], spread: &[f64; N_TERMS]) -> Value {
    let mut terms = Vec::new();
    let (mut cost, mut weight) = (0.0, 0.0);
    for (k, (name, w)) in TERMS.iter().enumerate() {
        let pairs: Vec<(f64, f64)> = songs
            .iter()
            .map(|s| s.pairs[k])
            .filter(|(h, s)| h.is_finite() && s.is_finite())
            .collect();
        let gaps: Vec<f64> = pairs.iter().map(|(h, s)| (s - h).abs()).collect();
        let gap = if gaps.len() >= MIN_GAP_SONGS {
            mean(&gaps)
        } else {
            f64::NAN
        };
        let z = gap / spread[k];
        let excess = term_cost(&gaps, spread[k]);
        if excess.is_finite() {
            cost += w * excess;
            weight += w;
        }
        terms.push(json!({
            "name": name, "weight": r3(*w), "songs": pairs.len(),
            "singer": r4(median(&pairs.iter().map(|p| p.0).collect::<Vec<_>>())),
            "synth": r4(median(&pairs.iter().map(|p| p.1).collect::<Vec<_>>())),
            "gap": r4(gap), "spread": r4(spread[k]), "z": r3(z), "cost": r3(excess),
        }));
    }
    let total = |f: &dyn Fn(&SongScore) -> u64| songs.iter().map(|s| f(s)).sum::<u64>();
    let avg = |f: &dyn Fn(&SongScore) -> f64| mean(&songs.iter().map(|s| f(s)).collect::<Vec<_>>());
    json!({
        "songs": songs.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
        "coverageNames": COVERAGE,
        "score": r3(if weight > 0.0 { cost / weight } else { f64::NAN }),
        "terms": terms,
        "coverage": songs.iter().map(|s| (s.id.clone(), json!(s.coverage))).collect::<serde_json::Map<_, _>>(),
        "pairs": songs.iter().map(|s| (s.id.clone(), json!(s.pairs.iter().map(|(h, y)| json!([fin(*h), fin(*y)])).collect::<Vec<_>>()))).collect::<serde_json::Map<_, _>>(),
        "guards": {
            "notes": total(&|s| s.notes as u64),
            "notesMisaligned": total(&|s| s.misaligned as u64),
            "droppedGestures": total(&|s| s.dropped),
            "noteMcdDb": r3(avg(&|s| s.mcd)),
            "envelopeCorr": r3(avg(&|s| s.env_corr)),
            "synthPitchAbsCents": r3(avg(&|s| s.synth_pitch)),
        },
    })
}

#[derive(Debug, PartialEq)]
pub enum Verdict {
    Better,
    Worse,
    Same,
}

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or(f64::NAN)
}

/// The verdict on a change in score (like for like) once the guards are checked: the change is
/// taken in the thousandths `score.json` gives, so 1.001 → 0.991 is a fall of exactly 0.010.
fn decide(change: f64, mut why: Vec<String>) -> (Verdict, Vec<String>) {
    let milli = |x: f64| (x * 1000.0).round() as i64;
    let (d, margin) = (milli(change), milli(MARGIN));
    if !why.is_empty() {
        (Verdict::Worse, why)
    } else if d <= -margin {
        (Verdict::Better, why)
    } else if d >= margin {
        why.push(format!("score up by {:.3}", change));
        (Verdict::Worse, why)
    } else {
        (Verdict::Same, why)
    }
}

/// The training score of `new` against `old` (both as written to `score.json`): the verdict,
/// why when worse, and the change in score over the songs both runs measure.
pub fn verdict(old: &Value, new: &Value) -> Result<(Verdict, Vec<String>, f64), String> {
    let (o, n) = (&old["train"], &new["train"]);
    if o["songs"] != n["songs"] || old["body"] != new["body"] {
        return Err("the earlier score covers other songs or another body; score both runs with the same --songs and --body".into());
    }
    if old["units"] != new["units"] {
        return Err(
            "the singer's spreads differ between the runs; rescore the baseline with this build"
                .into(),
        );
    }
    let mut why = Vec::new();
    // (old, new) of a guard; a guard that had a value and lost it breaks
    let mut guard = |k: &str, broken: &dyn Fn(f64, f64) -> bool, what: &str| {
        let (a, b) = (num(&o["guards"][k]), num(&n["guards"][k]));
        if a.is_finite() && !b.is_finite() {
            why.push(format!("{what}: no value any more"));
        } else if a.is_finite() && broken(a, b) {
            why.push(format!("{what}: {a} → {b}"));
        }
    };
    guard("notesMisaligned", &|a, b| b > a, "more notes off time");
    guard("droppedGestures", &|a, b| b > a, "more dropped gestures");
    guard("noteMcdDb", &|a, b| b > a + MCD_SLACK, "note MCD up (dB)");
    guard(
        "envelopeCorr",
        &|a, b| b < a - CORR_SLACK,
        "envelope correlation down",
    );
    guard(
        "synthPitchAbsCents",
        &|a, b| b > a + PITCH_SLACK,
        "pitch error up (cents)",
    );
    // no song may lose a note from any guarded measure
    if o["coverageNames"] != n["coverageNames"] {
        return Err(
            "the earlier score counts other measures; rescore the baseline with this build".into(),
        );
    }
    let mut lost = Vec::new();
    if let (Some(co), Some(cn)) = (o["coverage"].as_object(), n["coverage"].as_object()) {
        for (song, a) in co {
            let (a, b) = (a.as_array(), cn.get(song).and_then(|b| b.as_array()));
            let (Some(a), Some(b)) = (a, b) else { continue };
            for (k, (x, y)) in a.iter().zip(b).enumerate() {
                let (x, y) = (x.as_u64().unwrap_or(0), y.as_u64().unwrap_or(0));
                if y < x {
                    lost.push(format!("{song} {}: {x} → {y} notes", COVERAGE[k]));
                }
            }
        }
    }
    if !lost.is_empty() {
        let more = lost.len().saturating_sub(MAX_LISTED);
        lost.truncate(MAX_LISTED);
        why.push(format!(
            "measured on fewer notes: {}{}",
            lost.join(", "),
            if more > 0 {
                format!(" and {more} more")
            } else {
                String::new()
            }
        ));
    }
    let empty = vec![];
    let (to, tn) = (
        o["terms"].as_array().unwrap_or(&empty),
        n["terms"].as_array().unwrap_or(&empty),
    );
    if to.len() != N_TERMS
        || tn.len() != N_TERMS
        || to.iter().zip(tn).any(|(a, b)| a["name"] != b["name"])
    {
        return Err(
            "the earlier score has other terms; rescore the baseline with this build".into(),
        );
    }
    // each term's cost in both runs over the songs both measure
    let songs: Vec<&str> = o["songs"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    let pair = |run: &Value, song: &str, k: usize| {
        let p = &run["pairs"][song][k];
        (num(&p[0]), num(&p[1]))
    };
    let (mut change, mut weight) = (0.0, 0.0);
    for (k, (name, w)) in TERMS.iter().enumerate() {
        let unit = num(&old["units"][k]);
        let (mut go, mut gn) = (Vec::new(), Vec::new());
        for song in &songs {
            let ((ho, so), (hn, sn)) = (pair(o, song, k), pair(n, song, k));
            if [ho, so, hn, sn].iter().all(|v| v.is_finite()) {
                go.push((so - ho).abs());
                gn.push((sn - hn).abs());
            }
        }
        let (co, cn) = (term_cost(&go, unit), term_cost(&gn, unit));
        if num(&to[k]["cost"]).is_finite() && !num(&tn[k]["cost"]).is_finite() {
            why.push(format!("{name} has no value any more"));
        } else if co.is_finite() && cn.is_finite() {
            if cn > co + TERM_SLACK {
                why.push(format!("{name} cost up: {co:.3} → {cn:.3}"));
            }
            change += w * (cn - co);
            weight += w;
        }
    }
    if weight == 0.0 {
        return Err("no term is measured in both runs".into());
    }
    let (v, why) = decide(change / weight, why);
    Ok((v, why, change / weight))
}

/// `score.json` and the report's score section for these songs, with the verdict against an
/// earlier `score.json` if one is given.
pub fn report(
    body: &str,
    songs: &[&SongScore],
    against: Option<&str>,
) -> Result<(Value, String, Option<String>), String> {
    let (held, train): (Vec<&SongScore>, Vec<&SongScore>) =
        songs.iter().copied().partition(|s| held_out(&s.id));
    if train.is_empty() {
        if against.is_some() {
            return Err("--against: this run has no training song to score".into());
        }
        let md = "## Score\n\nNo score: the run has no training song to take the singer's spreads from.\n\n";
        return Ok((json!({ "body": body, "train": null }), md.to_string(), None));
    }
    let spread = spreads(&train);
    let mut out = json!({
        "body": body,
        "units": spread.iter().map(|u| fin(*u)).collect::<Vec<_>>(),
        "train": score_set(&train, &spread),
    });
    if !held.is_empty() {
        out["heldout"] = score_set(&held, &spread);
    }
    let t = &out["train"];
    let fmt = |v: &Value, d: usize| v.as_f64().map_or("—".to_string(), |x| format!("{x:.d$}"));
    let mut md = format!(
        "## Score\n\nTraining songs ({}): **{}**. Held out ({}): {}. Lower is better; 0 means \
         every term is within the singer's own song-to-song spread (see docs/csd-comparison.md).\n\n\
         | term | weight | singer | synth | mean gap | her spread | gap/spread | cost | held-out cost |\n\
         |---|---|---|---|---|---|---|---|---|\n",
        train.len(),
        fmt(&t["score"], 3),
        held.len(),
        out.get("heldout")
            .map_or("—".to_string(), |h| fmt(&h["score"], 3)),
    );
    for (k, term) in t["terms"].as_array().unwrap().iter().enumerate() {
        let held_cost = out
            .get("heldout")
            .map_or("—".to_string(), |h| fmt(&h["terms"][k]["cost"], 2));
        md += &format!(
            "| {} | {} | {} | {} | {} | {} | {} | {} | {held_cost} |\n",
            term["name"].as_str().unwrap_or("?"),
            fmt(&term["weight"], 2),
            fmt(&term["singer"], 3),
            fmt(&term["synth"], 3),
            fmt(&term["gap"], 3),
            fmt(&term["spread"], 3),
            fmt(&term["z"], 2),
            fmt(&term["cost"], 2),
        );
    }
    let g = &t["guards"];
    md += &format!(
        "\nGuards (training songs): {} of {} notes off time, {} dropped gestures, note MCD {} dB, \
         envelope correlation {}, synth pitch error {} cents.\n\n",
        g["notesMisaligned"],
        g["notes"],
        g["droppedGestures"],
        fmt(&g["noteMcdDb"], 3),
        fmt(&g["envelopeCorr"], 3),
        fmt(&g["synthPitchAbsCents"], 2),
    );
    let mut line = None;
    if let Some(path) = against {
        let old: Value = serde_json::from_str(
            &std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?,
        )
        .map_err(|e| format!("{path}: {e}"))?;
        let (v, why, change) = verdict(&old, &out)?;
        let word = match v {
            Verdict::Better => "BETTER",
            Verdict::Worse => "WORSE",
            Verdict::Same => "NO CLEAR CHANGE",
        };
        let text = format!(
            "Verdict against {path}: {word} (training score {} → {}, {change:+.3} like for like){}",
            fmt(&old["train"]["score"], 3),
            fmt(&t["score"], 3),
            if why.is_empty() {
                String::new()
            } else {
                format!(": {}", why.join("; "))
            }
        );
        md += &format!("{text}\n\n");
        out["verdict"] =
            json!({ "against": path, "result": word, "change": r3(change), "reasons": why });
        line = Some(text);
    }
    Ok((out, md, line))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song(id: &str, singer: f64, synth: f64) -> SongScore {
        SongScore {
            id: id.into(),
            singer_all: [singer; N_TERMS],
            pairs: [(singer, synth); N_TERMS],
            coverage: [10; N_COVERAGE],
            notes: 10,
            misaligned: 0,
            dropped: 0,
            mcd: 9.0,
            env_corr: 0.8,
            synth_pitch: 5.0,
        }
    }

    #[test]
    fn a_bad_song_that_stops_being_measured_does_not_improve_the_score() {
        // nine songs one spread (3.7065) apart from her, one far off: a cost the outlier carries
        let mk = |worst_missing: bool| {
            let mut songs: Vec<SongScore> = (1..=9)
                .map(|i| song(&format!("en{i:03}a"), i as f64, i as f64 + 3.7))
                .collect();
            songs[0].pairs[5].1 = 1.0 + 60.0;
            if worst_missing {
                // its H1−H2 can no longer be measured on any note
                songs[0].pairs[5].1 = f64::NAN;
                songs[0].coverage[6] = 0;
            }
            let refs: Vec<&SongScore> = songs.iter().collect();
            report("female", &refs, None).unwrap().0
        };
        let (base, gone) = (mk(false), mk(true));
        assert!(num(&gone["train"]["score"]) < num(&base["train"]["score"]));
        let (v, why, _) = verdict(&base, &gone).unwrap();
        assert_eq!(v, Verdict::Worse);
        assert!(why[0].contains("en001a H1-H2: 10 → 0 notes"), "{why:?}");
        // losing pitch on a few notes of one song is caught the same way
        let mut fewer = base.clone();
        fewer["train"]["coverage"]["en002a"][12] = json!(7);
        let (v, why, _) = verdict(&base, &fewer).unwrap();
        assert_eq!(v, Verdict::Worse);
        assert!(why[0].contains("en002a pitch: 10 → 7 notes"), "{why:?}");
    }

    #[test]
    fn the_margin_is_exact_in_thousandths() {
        // 0.991 − 1.001 is −0.0099999… in floating point, and still a fall of 0.010
        assert_eq!(decide(0.991 - 1.001, vec![]).0, Verdict::Better);
        assert_eq!(decide(1.001 - 0.991, vec![]).0, Verdict::Worse);
        assert_eq!(decide(0.992 - 1.001, vec![]).0, Verdict::Same);
        assert_eq!(decide(-0.5, vec!["a guard".into()]).0, Verdict::Worse);
    }

    #[test]
    fn a_song_whose_vibrato_stops_reading_as_vibrato_takes_no_gap_with_it() {
        // vibrato rate (term 8) is far off in en001a; then its modulation leaves the vibrato
        // range, so it has no rate at all. Depth and rate keep no coverage (fewer notes with
        // vibrato can be right), so only the like-for-like comparison stops this from passing.
        let mk = |gone: bool| {
            let mut songs: Vec<SongScore> = (1..=9)
                .map(|i| song(&format!("en{i:03}a"), i as f64, i as f64 + 3.7))
                .collect();
            songs[0].pairs[8].1 = if gone { f64::NAN } else { 1.0 + 40.0 };
            let refs: Vec<&SongScore> = songs.iter().collect();
            report("female", &refs, None).unwrap().0
        };
        let (base, gone) = (mk(false), mk(true));
        assert!(num(&gone["train"]["score"]) < num(&base["train"]["score"]) - 0.01);
        let (v, _, change) = verdict(&base, &gone).unwrap();
        assert_eq!(v, Verdict::Same);
        assert_eq!(change, 0.0);
    }

    #[test]
    fn every_fifth_song_is_held_out_in_both_keys() {
        assert!(held_out("en005a") && held_out("en005b") && held_out("en050a"));
        assert!(!held_out("en001a") && !held_out("en049b") && !held_out("x"));
    }

    #[test]
    fn a_gap_costs_its_excess_over_one_singer_spread() {
        // eight training songs (en005 and en010 are held out); her values 0 1 2 3 5 6 7 8 have
        // median 4 and MAD 2.5, a spread of 3.7065, so a gap of two spreads costs 1
        let songs: Vec<SongScore> = (1..=10)
            .map(|i| {
                song(
                    &format!("en{i:03}a"),
                    (i - 1) as f64,
                    (i - 1) as f64 + 7.413,
                )
            })
            .collect();
        let refs: Vec<&SongScore> = songs.iter().collect();
        let (out, _, _) = report("female", &refs, None).unwrap();
        let t = &out["train"]["terms"][0];
        assert_eq!(out["train"]["songs"].as_array().unwrap().len(), 8);
        assert!((num(&t["spread"]) - 3.7065).abs() < 1e-3, "{t}");
        assert!((num(&t["z"]) - 2.0).abs() < 1e-3, "{t}");
        assert!((num(&out["train"]["score"]) - 1.0).abs() < 1e-3);
        // two held-out songs are too few to average a gap over
        assert!(out["heldout"]["score"].is_null());
        // within one spread costs nothing
        let close: Vec<SongScore> = (1..=9)
            .map(|i| song(&format!("en{i:03}a"), i as f64, i as f64 + 1.0))
            .collect();
        let refs: Vec<&SongScore> = close.iter().collect();
        let (out, _, _) = report("female", &refs, None).unwrap();
        assert_eq!(num(&out["train"]["score"]), 0.0);
    }

    fn scored(gap: f64, f: impl Fn(&mut SongScore)) -> Value {
        let mut songs: Vec<SongScore> = (1..=9)
            .map(|i| song(&format!("en{i:03}a"), i as f64, i as f64 + gap))
            .collect();
        songs.iter_mut().for_each(&f);
        let refs: Vec<&SongScore> = songs.iter().collect();
        report("female", &refs, None).unwrap().0
    }

    #[test]
    fn the_verdict_wants_a_lower_score_and_every_guard_kept() {
        let base = scored(8.0, |_| {});
        let (v, _, change) = verdict(&base, &scored(6.0, |_| {})).unwrap();
        assert_eq!(v, Verdict::Better);
        assert!(change < -0.01, "{change}");
        assert_eq!(
            verdict(&base, &scored(8.0, |_| {})).unwrap().0,
            Verdict::Same
        );
        assert_eq!(
            verdict(&base, &scored(9.0, |_| {})).unwrap().0,
            Verdict::Worse
        );
        // better on the score, but a note leaves its time: worse
        let (v, why, _) = verdict(&base, &scored(6.0, |s| s.misaligned = 1)).unwrap();
        assert_eq!(v, Verdict::Worse);
        assert!(why[0].contains("off time"), "{why:?}");
        let (v, _, _) = verdict(&base, &scored(6.0, |s| s.mcd = 9.5)).unwrap();
        assert_eq!(v, Verdict::Worse);
        // one term much worse while the rest improve: worse
        let one_worse = scored(6.0, |s| s.pairs[5].1 = s.pairs[5].0 + 30.0);
        let (v, why, _) = verdict(&base, &one_worse).unwrap();
        assert_eq!(v, Verdict::Worse);
        assert!(why[0].contains("H1-H2"), "{why:?}");
        // a guard that loses its value breaks
        let (v, why, _) = verdict(&base, &scored(6.0, |s| s.synth_pitch = f64::NAN)).unwrap();
        assert_eq!(v, Verdict::Worse);
        assert!(
            why[0].contains("pitch error up (cents): no value"),
            "{why:?}"
        );
        // different songs are not comparable
        let mut other = scored(6.0, |_| {});
        other["train"]["songs"] = json!(["en001a"]);
        assert!(verdict(&base, &other).is_err());
    }
}
