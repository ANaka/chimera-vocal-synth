//! How the human voice's source settings shape the glottis.
use chimera::voice::human_voice::{HumanVoice, SourcePatch};

#[test]
fn a_pressed_voice_still_closes_abruptly() {
    // a sung or spoken voice closes softly (tension 0.5-0.55), but the "Pressed" control's top end
    // keeps the abrupt closure of a pressed voice, and the closure sharpens with tension throughout
    let mut v = HumanVoice::with_defaults(48000.0);
    let mut sharpness = |tension: f64| {
        v.set_source(&SourcePatch { tension: Some(tension), ..Default::default() });
        v.glottis.params.closure_sharpness
    };
    assert!(sharpness(0.55) < 0.25);
    assert!(sharpness(1.0) > 0.9);
    let mut last = -1.0;
    for i in 0..=20 {
        let t = i as f64 / 20.0;
        let s = sharpness(t);
        assert!(s > last, "closure sharpness falls at tension {t}");
        last = s;
    }
}
