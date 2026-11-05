//! CHIMERA: a physical-modelling voice engine. Every sound comes from a simulated airway.
//!
//! The crate is headless and deterministic: no I/O, no global mutable state, and all
//! transcendental math goes through [`math`] (pure-Rust libm), so native and wasm32 builds
//! render bit-identical samples. Voices are `Send` and allocate nothing while rendering.

pub mod math;
pub mod physics;

pub mod airway {
    pub mod decimator;
    pub mod network;
}

pub mod anatomy {
    pub mod geom;
    pub mod human;
}

pub mod sources {
    pub mod glottis;
}

pub mod control {
    pub mod articulators;
    pub mod score;
}

pub mod voice {
    pub mod human_airway;
    pub mod human_voice;
}
