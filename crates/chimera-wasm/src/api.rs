//! The main thread's JSON calls: `chimera_call` takes `{"fn": name, ...args}` as UTF-8 JSON in a
//! buffer from `chimera_alloc`, and leaves the JSON result (or `{"error": message}`) in a buffer
//! read with `chimera_result_ptr`/`chimera_result_len`, valid until the next call. Nothing here
//! runs on the audio thread: these calls allocate.

use chimera::airway::frequency::{find_peaks, transfer_function};
use chimera::anatomy::human::{BodyName, HumanArtic, HumanFrame};
use chimera::math;
use chimera::voice::human_airway::HumanAirway;
use serde_json::{Value, json};
use std::cell::RefCell;

struct Model {
    body: BodyName,
    fs: f64,
    airway: HumanAirway,
}

#[derive(Default)]
struct State {
    result: Vec<u8>,
    models: Vec<Model>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

type Res = Result<Value, String>;

fn arg<T: serde::de::DeserializeOwned>(req: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(req.get(key).cloned().unwrap_or(Value::Null)).map_err(|e| format!("{key}: {e}"))
}

fn model<'a>(st: &'a mut State, req: &Value) -> Result<&'a mut Model, String> {
    let id: usize = arg(req, "model")?;
    st.models.get_mut(id).ok_or_else(|| format!("no model {id}"))
}

fn dispatch(st: &mut State, req: &Value) -> Res {
    let name = req.get("fn").and_then(Value::as_str).ok_or("missing fn")?;
    match name {
        "version" => Ok(json!({ "layout": crate::LAYOUT_VERSION, "crate": env!("CARGO_PKG_VERSION") })),
        // ---------------------------------------------------------------- the anatomy model
        "model" => {
            // the main-thread mirror of the worklet's airway: same topology and node counts
            let body = BodyName::parse(&arg::<String>(req, "body")?);
            let fs: f64 = arg(req, "sampleRate")?;
            let m = if fs > 60000.0 { 1.0 } else { 2.0 };
            let id = match st.models.iter().position(|x| x.body == body && x.fs == fs * m) {
                Some(i) => i,
                None => {
                    st.models.push(Model { body, fs: fs * m, airway: HumanAirway::new(fs * m, body.body()) });
                    st.models.len() - 1
                }
            };
            let a = &st.models[id].airway;
            Ok(json!({
                "model": id,
                "body": a.body,
                "nPh": a.n_ph,
                "nOr": a.n_or,
                "pharynxBranches": { "base": a.pharynx.branch_base, "n": a.pharynx.n },
                "oralBranches": { "base": a.oral.branch_base, "n": a.oral.n },
                "glottisPort": a.glottis_port,
            }))
        }
        "frame" => {
            let a: HumanArtic = arg(req, "artic")?;
            let m = model(st, req)?;
            let f: HumanFrame = m.airway.tract.compute_new(&a);
            serde_json::to_value(&f).map_err(|e| e.to_string())
        }
        "apply" => {
            let a: HumanArtic = arg(req, "artic")?;
            let m = model(st, req)?;
            m.airway.apply(&a, 0.0);
            let air = &m.airway;
            Ok(json!({ "phAreas": air.ph_areas, "orAreas": air.or_areas, "phLen": air.ph_len, "orLen": air.or_len }))
        }
        "transfer" => {
            // the vocal-tract transfer function the UI draws, and its formants: 360 log-spaced
            // frequencies 60 Hz–8 kHz, injected at the first pharynx node, the glottis port cut
            let a: HumanArtic = arg(req, "artic")?;
            let m = model(st, req)?;
            m.airway.apply(&a, 0.0);
            let el = m.airway.net.linear_elements();
            let freqs: Vec<f64> = (0..360).map(|i| 60.0 * math::pow(8000.0 / 60.0, i as f64 / 359.0)).collect();
            let h = transfer_function(&el, m.airway.pharynx.first_node(), &freqs, &[m.airway.glottis_port]);
            let db: Vec<f64> = h.mag.iter().map(|x| 20.0 * math::log10(x + 1e-12)).collect();
            let formants: Vec<f64> = find_peaks(&freqs, &h.mag, 150.0).iter().map(|p| p.freq).take(5).collect();
            Ok(json!({ "freqs": freqs, "db": db, "formants": formants }))
        }
        _ => Err(format!("unknown fn {name}")),
    }
}

/// Run one JSON call (see the module docs). Returns 0 on success, 1 if the result is an error.
///
/// # Safety
/// `ptr..ptr+len` must be readable (a buffer from `chimera_alloc`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn chimera_call(ptr: *const u8, len: usize) -> u32 {
    let bytes = unsafe { core::slice::from_raw_parts(ptr, len) };
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        let out = match serde_json::from_slice::<Value>(bytes) {
            Err(e) => Err(format!("bad request: {e}")),
            Ok(req) => dispatch(&mut st, &req),
        };
        let (code, v) = match out {
            Ok(v) => (0, v),
            Err(e) => (1, json!({ "error": e })),
        };
        st.result = serde_json::to_vec(&v).unwrap_or_else(|_| b"{\"error\":\"unserialisable result\"}".to_vec());
        code
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn chimera_result_ptr() -> *const u8 {
    STATE.with(|s| s.borrow().result.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn chimera_result_len() -> usize {
    STATE.with(|s| s.borrow().result.len())
}
