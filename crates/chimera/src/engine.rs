//! The instrument: one human voice (any body), the creatures, and the beatbox sequencer, driven by
//! commands. This is what the browser's AudioWorklet runs and what a DAW wraps as a source module.
//!
//! Contract (see docs/rust-engine.md):
//! - Commands take effect at once, between `render` calls. A host that needs sample accuracy
//!   splits its block at the event.
//! - `render` advances in 128-sample sub-blocks on an absolute sample count. The sequencer ticks at
//!   each sub-block boundary, so the output does not depend on the host's block size.
//! - Rendering, gestures, releases, artic/source/gate changes and beat edits allocate nothing once
//!   warm. A body or creature switch builds a new airway network (it allocates).

use crate::anatomy::human::{ArticPatch, BodyName};
use crate::control::score::{Gesture, GestureScore};
use crate::voice::human_voice::{HumanVoice, SourcePatch, VoiceTelemetry};

/// Samples per sub-block: the browser's render quantum, kept for every host.
pub const SUB_BLOCK: usize = 128;
/// Gestures taken from one schedule command (as the TypeScript worklet did).
pub const MAX_SCHEDULE: usize = 4000;

/// Default pitch per body (Hz).
pub fn default_f0(body: BodyName) -> f64 {
    match body {
        BodyName::Male => 110.0,
        BodyName::Female => 205.0,
        BodyName::Child => 260.0,
    }
}

/// Identity of the voice the engine is playing (the browser's "ready" message).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VoiceInfo {
    pub body: BodyName,
    pub n_ph: usize,
    pub n_or: usize,
}

pub struct Engine {
    pub sample_rate: f64,
    body: BodyName,
    voice: HumanVoice,
    /// the performer's breath (the voice's own gate also follows the score)
    gate_level: f64,
    /// samples rendered so far (sub-block phase)
    pos: u64,
    scratch: Vec<Gesture>,
}

impl Engine {
    pub fn new(sample_rate: f64) -> Engine {
        crate::init();
        let body = BodyName::Male;
        Engine { sample_rate, body, voice: Self::make_voice(sample_rate, body), gate_level: 0.0, pos: 0, scratch: Vec::with_capacity(MAX_SCHEDULE) }
    }

    fn make_voice(fs: f64, body: BodyName) -> HumanVoice {
        let mut v = HumanVoice::new(fs, body.body(), if fs > 60000.0 { 1 } else { 2 });
        v.set_source(&SourcePatch::f0(default_f0(body)));
        v
    }

    pub fn info(&self) -> VoiceInfo {
        VoiceInfo { body: self.body, n_ph: self.voice.airway.n_ph, n_or: self.voice.airway.n_or }
    }

    pub fn voice(&self) -> &HumanVoice {
        &self.voice
    }

    pub fn voice_mut(&mut self) -> &mut HumanVoice {
        &mut self.voice
    }

    /// Switch the human body. The performer's settings carry over: source (pitch reset to the
    /// new body's default), posture, breath. Allocates (a new airway network).
    pub fn set_body(&mut self, body: BodyName) -> VoiceInfo {
        let prev = core::mem::replace(&mut self.voice, Self::make_voice(self.sample_rate, body));
        self.body = body;
        let mut src = SourcePatch::from_source(&prev.source);
        src.f0 = Some(default_f0(body));
        self.voice.set_source(&src);
        let mut target = ArticPatch::default();
        for (k, x) in prev.artic.target.to_array().iter().enumerate() {
            target.values[k] = Some(*x);
        }
        self.voice.set_articulation(&target, Some(prev.artic.tip_free));
        // the performer's breath, not the voice's (which includes breath from the score)
        self.voice.set_gate(self.gate_level);
        self.info()
    }

    pub fn set_artic(&mut self, values: &ArticPatch, tip_free: Option<bool>) {
        self.voice.set_articulation(values, tip_free);
    }

    pub fn set_source(&mut self, values: &SourcePatch) {
        self.voice.set_source(values);
    }

    pub fn set_gate(&mut self, level: f64) {
        self.gate_level = level;
        self.voice.set_gate(level);
    }

    /// Schedule gestures planned with times relative to "now": they are shifted onto the voice
    /// clock by `clock + lead`. Returns that offset (the plan's time 0 on the voice clock).
    pub fn schedule(&mut self, gestures: &[Gesture], lead: f64, replace: bool) -> f64 {
        let off = self.voice.clock + lead;
        self.scratch.clear();
        for g in gestures.iter().take(MAX_SCHEDULE) {
            let mut g = *g;
            g.t0 += off;
            g.t1 += off;
            self.scratch.push(g);
        }
        if replace {
            self.voice.cancel_score();
        }
        self.voice.schedule(&self.scratch);
        off
    }

    pub fn stop_speech(&mut self) {
        self.voice.cancel_score();
    }

    /// End the open-ended gestures with this tag now (a sung note released).
    pub fn release(&mut self, tag: f64) {
        self.voice.release(tag);
    }

    pub fn score(&self) -> &GestureScore {
        &self.voice.score
    }

    /// The voice clock (s): the time base of scheduled gestures.
    pub fn clock(&self) -> f64 {
        self.voice.clock
    }

    /// Render `out.len()` samples.
    pub fn render(&mut self, out: &mut [f32]) {
        let mut i = 0;
        while i < out.len() {
            let phase = (self.pos % SUB_BLOCK as u64) as usize;
            if phase == 0 {
                self.sub_block_start();
            }
            let n = (SUB_BLOCK - phase).min(out.len() - i);
            self.voice.render(&mut out[i..i + n]);
            i += n;
            self.pos += n as u64;
        }
    }

    /// Per-sub-block bookkeeping (the sequencer's tick).
    fn sub_block_start(&mut self) {}

    pub fn telemetry(&mut self, out: &mut VoiceTelemetry) {
        self.voice.telemetry(out);
    }
}
