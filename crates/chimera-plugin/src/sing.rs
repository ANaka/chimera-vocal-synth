//! Live singing from MIDI notes: the lyrics are syllables with a cursor, and each note sings the
//! next syllable at its pitch. A port of the live part of `src/ui/singing.ts` (legato, melisma,
//! glide back to a key still held, velocity → breath, the coda on release).
//!
//! Spike: this runs on the audio thread and the planners allocate (see docs/rust-engine.md, "Open").

use chimera::anatomy::human::BodyMix;
use chimera::control::score::{ControlKey, Gesture};
use chimera::engine::Engine;
use chimera::phonetics::planner::EXHALE_LABEL;
use chimera::phonetics::sing::{LegatoFrom, MelismaOptions, NoteOnOptions, plan_melisma, plan_note_off, plan_note_on};
use chimera::phonetics::{Segment, Syllable};

/// gestures planned on arrival start this far ahead of the voice clock (as the browser does)
const LEAD: f64 = 0.006;

struct Sounding {
    midi: u8,
    /// the syllable whose vowel is sounding (a melisma keeps its parent's, for the coda)
    syl: Syllable,
    tag: f64,
}

pub struct Sing {
    syllables: Vec<Syllable>,
    /// the syllable the next note sings
    pub cursor: usize,
    /// the syllable being sung now, for the editor
    pub sung: Option<usize>,
    /// keys down, oldest first
    keys: Vec<u8>,
    sounding: Option<Sounding>,
    /// gesture tags: a note uses tag (articulation, breath) and tag + 1 (pitch, vibrato)
    next_tag: f64,
    /// endings (glide, coda) that may still be playing: tag, and tag + 1 for the breath-out
    tails: Vec<f64>,
    /// endings whose breath-out has not been dropped by a following note
    exhales_live: bool,
    pub body: BodyMix,
    pub vibrato: f64,
}

fn ah() -> Syllable {
    Syllable { text: "ah".into(), onset: vec![], nucleus: Segment { ipa: "ɑ".into(), stress: Some(1), ..Default::default() }, coda: vec![], melisma: None, word_end: true, phrase_end: false }
}

/// breath level for a MIDI velocity (1 at the on-screen keys' default of 96)
fn breath_for(velocity: f64) -> f64 {
    0.62 + 0.4 * (velocity / 96.0).clamp(0.0, 1.0) + 0.12 * ((velocity - 96.0) / 31.0).max(0.0)
}

impl Sing {
    pub fn new() -> Sing {
        Sing { syllables: vec![ah()], cursor: 0, sung: None, keys: Vec::with_capacity(128), sounding: None, next_tag: 2.0, tails: Vec::with_capacity(9), exhales_live: false, body: BodyMix::MALE, vibrato: 35.0 }
    }

    pub fn sounding_note(&self) -> Option<u8> {
        self.sounding.as_ref().map(|s| s.midi)
    }

    /// New lyrics: the cursor goes back to the first syllable.
    pub fn set_syllables(&mut self, syllables: Vec<Syllable>) {
        self.syllables = if syllables.is_empty() { vec![ah()] } else { syllables };
        self.cursor = 0;
    }

    fn take_tag(&mut self) -> f64 {
        let t = self.next_tag;
        self.next_tag += 2.0;
        t
    }

    /// The syllable a melisma at index i continues.
    fn parent_of(&self, i: usize) -> Syllable {
        (0..=i).rev().map(|k| &self.syllables[k]).find(|s| s.melisma != Some(true)).cloned().unwrap_or_else(ah)
    }

    fn start_note(&mut self, e: &mut Engine, syl: Syllable, midi: u8, velocity: f64) {
        let tag = self.take_tag();
        // earlier codas may finish, but their breath-out must not open the folds on this onset
        if self.exhales_live {
            for t in &self.tails {
                e.release(t + 1.0);
            }
        }
        self.exhales_live = false;
        let from = self.sounding.take();
        if let Some(f) = &from {
            e.release(f.tag);
            e.release(f.tag + 1.0);
        }
        let legato_from = from.map(|f| LegatoFrom { syl: f.syl, midi: f.midi as f64 });
        let mut gs = plan_note_on(&syl, midi as f64, &NoteOnOptions { body: self.body, vibrato: self.vibrato, tag, legato_from });
        let breath = breath_for(velocity);
        for g in gs.iter_mut() {
            if let Some(b) = g.targets.get(ControlKey::BREATH) {
                g.targets.set(ControlKey::BREATH, b * breath);
            }
        }
        e.schedule(&gs, LEAD, false);
        self.sounding = Some(Sounding { midi, syl, tag });
    }

    /// The held vowel moves to a new pitch (melisma, or back to a key still down).
    fn glide(&mut self, e: &mut Engine, midi: u8) {
        let vibrato = self.vibrato;
        let Some(s) = self.sounding.as_mut() else { return };
        e.release(s.tag + 1.0);
        e.schedule(&plan_melisma(midi as f64, &MelismaOptions { vibrato, tag: s.tag }), LEAD, false);
        s.midi = midi;
    }

    /// `velocity` in MIDI units (0–127).
    pub fn note_on(&mut self, e: &mut Engine, midi: u8, velocity: f64) {
        self.keys.retain(|&k| k != midi);
        self.keys.push(midi);
        let i = self.cursor % self.syllables.len();
        let syl = &self.syllables[i];
        if syl.melisma == Some(true) && self.sounding.is_some() {
            self.glide(e, midi);
        } else {
            // a melisma with nothing held: sing its vowel again, without the onset
            let syl = if syl.melisma == Some(true) { Syllable { onset: vec![], ..self.parent_of(i) } } else { syl.clone() };
            self.start_note(e, syl, midi, velocity);
        }
        self.sung = Some(i);
        self.cursor = (i + 1) % self.syllables.len();
    }

    pub fn note_off(&mut self, e: &mut Engine, midi: u8) {
        self.keys.retain(|&k| k != midi);
        if self.sounding.as_ref().is_none_or(|s| s.midi != midi) {
            return;
        }
        if let Some(&k) = self.keys.last() {
            self.glide(e, k);
            return;
        }
        let s = self.sounding.take().unwrap();
        e.release(s.tag);
        e.release(s.tag + 1.0);
        self.sung = None;
        // a melisma comes next: this vowel carries on there, and the coda waits for the chain's end
        if self.syllables.get(self.cursor).is_some_and(|n| n.melisma == Some(true)) {
            return;
        }
        let mut gs: Vec<Gesture> = plan_note_off(&s.syl, midi as f64, self.body);
        if gs.is_empty() {
            return;
        }
        let tag = self.take_tag();
        for g in gs.iter_mut() {
            g.tag = Some(if g.label.is_some_and(|l| l.as_str() == EXHALE_LABEL) { tag + 1.0 } else { tag });
        }
        e.schedule(&gs, LEAD, false);
        self.tails.push(tag);
        if self.tails.len() > 8 {
            self.tails.remove(0); // long finished by now
        }
        self.exhales_live = true;
    }

    /// Stop everything sung (transport stop, all-notes-off, reset).
    pub fn stop_all(&mut self, e: &mut Engine) {
        if let Some(s) = self.sounding.take() {
            e.release(s.tag);
            e.release(s.tag + 1.0);
        }
        for t in &self.tails {
            e.release(*t);
            e.release(t + 1.0);
        }
        self.tails.clear();
        self.exhales_live = false;
        self.keys.clear();
        self.sung = None;
    }
}
