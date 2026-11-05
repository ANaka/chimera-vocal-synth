//! Segment sequence → gestural score. Timing and phonation are articulatory: aspiration is a
//! glottal opening gesture peaking at the release (VOT emerges), nasality is velum lowering with
//! anticipation, coarticulation comes from overlapping vowel gestures beneath consonant gestures.
//!
//! (Port in progress: the vowel table helpers below are final; `plan_utterance` and the rest
//! follow.)

use crate::anatomy::human::{ArticKey, ArticPatch};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::sync::OnceLock;

/// label of the end-of-breath-group abduction (a live note can drop it when the next one starts)
pub const EXHALE_LABEL: &str = "exhale";

const VOWEL_KEYS: [ArticKey; 9] = [ArticKey::TbX, ArticKey::TbY, ArticKey::Jaw, ArticKey::LipAp, ArticKey::LipProt, ArticKey::LipWidth, ArticKey::Root, ArticKey::Larynx, ArticKey::TtCurl];

/// One calibrated vowel of `vowelTargets.generated.json`.
#[derive(Clone, Debug, Deserialize)]
pub struct VowelTarget {
    pub artic: ArticPatch,
    #[serde(default)]
    pub formants: Vec<f64>,
}

/// body name → IPA → calibrated vowel
pub type VowelTable = BTreeMap<String, BTreeMap<String, VowelTarget>>;

/// The calibrated vowel table (parsed once).
pub fn vowel_table() -> &'static VowelTable {
    static T: OnceLock<VowelTable> = OnceLock::new();
    T.get_or_init(|| serde_json::from_str(include_str!("vowelTargets.generated.json")).expect("vowelTargets.generated.json"))
}

/// Diphthongs and r-coloured vowels expand to vowel sequences. American /eɪ oʊ/ glide toward
/// [i u] (Hillenbrand et al. 1995: /e/ F2 rises ~150 Hz, /o/ F1 falls with F2 steady); with
/// [ɪ ʊ] as targets they barely moved (/e/ and /ɪ/ share F2) and sounded like the steady
/// [eː oː] of Indian English. The other offglides undershoot toward [ɪ ʊ].
pub fn expand(ipa: &str) -> Option<&'static [&'static str]> {
    Some(match ipa {
        "aɪ" => &["a", "ɪ"],
        "aʊ" => &["a", "ʊ"],
        "ɔɪ" => &["ɔ", "ɪ"],
        "eɪ" => &["e", "i"],
        "oʊ" => &["o", "u"],
        "ɚ" => &["ɝ"],
        _ => return None,
    })
}

/// The two vowel targets of a diphthong ("aɪ" → ("a", "ɪ")), or None.
pub fn diphthong_parts(ipa: &str) -> Option<(&'static str, &'static str)> {
    match expand(ipa) {
        Some(p) if p.len() == 2 => Some((p[0], p[1])),
        _ => None,
    }
}

pub fn is_vowel(ipa: &str, body: &str) -> bool {
    vowel_table().get(body).is_some_and(|t| t.contains_key(ipa)) || expand(ipa).is_some()
}

pub fn vowel_artic(ipa: &str, body: &str) -> Option<ArticPatch> {
    let t = vowel_table();
    let v = t.get(body).and_then(|b| b.get(ipa)).or_else(|| t.get("male").and_then(|m| m.get(ipa)))?;
    let mut out = ArticPatch::default();
    for k in VOWEL_KEYS {
        if let Some(x) = v.artic.get(k) {
            out.set(k, x);
        }
    }
    // a rhotic's tip is raised and curled back, not resting behind the teeth: without its
    // calibrated position the tip stayed down and /ɝ/'s F3 sat ~15–20 % high (weakly rhotic)
    if v.artic.get(ArticKey::TtCurl).unwrap_or(0.0) > 0.05 {
        if let Some(x) = v.artic.get(ArticKey::TtX) {
            out.set(ArticKey::TtX, x);
        }
        if let Some(x) = v.artic.get(ArticKey::TtY) {
            out.set(ArticKey::TtY, x);
        }
    }
    Some(out)
}
