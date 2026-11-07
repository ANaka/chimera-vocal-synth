//! The editor: a WKWebView attached as a subview of the host's NSView (macOS).
//!
//! - The page and the state it polls come from a custom protocol (`chimera://localhost/…`), so
//!   no files or ports are involved and the UI pulls state at its own frame rate.
//! - Commands go the other way through `window.ipc.postMessage` (JSON).
//! - Both handlers run on the host's main thread.

use std::borrow::Cow;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use nih_plug::prelude::*;
use raw_window_handle::{AppKitWindowHandle, HandleError, HasWindowHandle, RawWindowHandle, WindowHandle};
use serde::Deserialize;
use wry::dpi::{LogicalPosition, LogicalSize};
use wry::http::{Request, Response};
use wry::{Rect, WebView, WebViewBuilder};

use crate::{ChimeraParams, Shared};

const PAGE: &str = include_str!("../ui/index.html");
const SIZE: (u32, u32) = (760, 520);

pub struct WebEditor {
    params: Arc<ChimeraParams>,
    shared: Arc<Shared>,
}

impl WebEditor {
    pub fn new(params: Arc<ChimeraParams>, shared: Arc<Shared>) -> Self {
        Self { params, shared }
    }
}

/// The host's NSView, as a window handle wry can attach to.
struct HostView(NonNull<c_void>);

impl HasWindowHandle for HostView {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let raw = RawWindowHandle::AppKit(AppKitWindowHandle::new(self.0));
        // SAFETY: the host keeps its view alive while the editor is open (we drop the webview first)
        Ok(unsafe { WindowHandle::borrow_raw(raw) })
    }
}

/// The open editor. Dropped (on the main thread) when the host closes the window; wry then
/// removes the webview from the host's view.
struct Open(#[allow(dead_code)] WebView);
// SAFETY: nih-plug creates and drops the editor handle on the GUI thread only.
unsafe impl Send for Open {}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Command {
    /// a parameter gesture from the page: begin, set (normalized 0–1), end
    Param { id: String, phase: String, value: Option<f32> },
    Lyrics { text: String },
    Note { midi: u8, on: bool },
}

fn state_json(params: &ChimeraParams, shared: &Shared) -> String {
    let p = |param: &FloatParam| {
        let v = param.unmodulated_normalized_value();
        serde_json::json!({ "value": v, "text": param.normalized_value_to_string(v, true) })
    };
    serde_json::json!({
        "params": { "gain": p(&params.gain), "vibrato": p(&params.vibrato) },
        "lyrics": *params.lyrics.read().unwrap(),
        "syllables": *shared.texts.lock().unwrap(),
        "cursor": shared.cursor.load(Ordering::Relaxed),
        "sung": shared.sung.load(Ordering::Relaxed),
        "note": shared.note.load(Ordering::Relaxed),
        "level": shared.level.load(),
        "load": shared.load.swap(0.0),
        "sampleRate": shared.sample_rate.load(),
        "block": shared.block.load(Ordering::Relaxed),
        "faulted": shared.faulted.load(Ordering::Relaxed),
    })
    .to_string()
}

fn respond(mime: &str, body: Vec<u8>) -> Response<Cow<'static, [u8]>> {
    Response::builder().header("Content-Type", mime).header("Cache-Control", "no-store").body(Cow::Owned(body)).unwrap()
}

impl Editor for WebEditor {
    fn spawn(&self, parent: ParentWindowHandle, context: Arc<dyn GuiContext>) -> Box<dyn std::any::Any + Send> {
        let ParentWindowHandle::AppKitNsView(view) = parent else { return Box::new(()) };
        let Some(view) = NonNull::new(view) else { return Box::new(()) };

        let (params, shared) = (self.params.clone(), self.shared.clone());
        let protocol = move |_id: wry::WebViewId, req: Request<Vec<u8>>| match req.uri().path() {
            "/state" => respond("application/json", state_json(&params, &shared).into_bytes()),
            _ => respond("text/html; charset=utf-8", PAGE.as_bytes().to_vec()),
        };

        let (params, shared) = (self.params.clone(), self.shared.clone());
        let ipc = move |req: Request<String>| {
            let Ok(cmd) = serde_json::from_str::<Command>(req.body()) else { return };
            match cmd {
                Command::Param { id, phase, value } => {
                    let param = match id.as_str() {
                        "gain" => &params.gain,
                        "vibrato" => &params.vibrato,
                        _ => return,
                    };
                    let setter = ParamSetter::new(context.as_ref());
                    match (phase.as_str(), value) {
                        ("begin", _) => setter.begin_set_parameter(param),
                        ("set", Some(v)) => setter.set_parameter_normalized(param, v.clamp(0.0, 1.0)),
                        ("end", _) => setter.end_set_parameter(param),
                        _ => {}
                    }
                }
                Command::Lyrics { text } => shared.set_lyrics(&params, &text),
                Command::Note { midi, on } => shared.ui_notes.lock().unwrap().push((midi.min(127), on)),
            }
        };

        let built = WebViewBuilder::new()
            .with_bounds(Rect { position: LogicalPosition::new(0, 0).into(), size: LogicalSize::new(SIZE.0, SIZE.1).into() })
            .with_custom_protocol("chimera".into(), protocol)
            .with_ipc_handler(ipc)
            .with_devtools(true)
            .with_url("chimera://localhost/")
            .build_as_child(&HostView(view));
        match built {
            Ok(webview) => Box::new(Open(webview)),
            Err(err) => {
                nih_error!("CHIMERA: could not create the webview: {err}");
                Box::new(())
            }
        }
    }

    fn size(&self) -> (u32, u32) {
        SIZE
    }

    fn set_scale_factor(&self, _factor: f32) -> bool {
        false // macOS scales for us
    }

    // the page polls the parameters, so host-side changes need no push
    fn param_value_changed(&self, _id: &str, _normalized_value: f32) {}
    fn param_modulation_changed(&self, _id: &str, _modulation_offset: f32) {}
    fn param_values_changed(&self) {}
}
