# UI redesign: the vector display (issue #2)

The approved mockups are in `docs/mockups/` (open `index.html`). This plan says how to build them into the app on top of the Rust engine. The look is settled; this is about how to get there without breaking the instrument.

## What the mockups fix

- **Look.** WarGames NORAD screens: thin glowing lines on pure black, no filled panels, crisp glow (not bloom-heavy), no scanlines or curvature, no terminal-style typing.
- **Colour roles.** Blue is the body and structure. Amber is sound (pressure, flow, spectra). Green, red, pink and white are four control slots: each screen maps its own four controls onto them, OP-1 style, and draws what they move in the same colour.
- **Type.** Hershey Simplex single-stroke capitals everywhere. IPA glyphs Hershey lacks are drawn as strokes.
- **Layout.** A wall of screens: a tall left screen (the face, or the creature) and a right column of instrument screens that changes per mode.
- **Anatomy.** Outlines from the engine's geometry; the airway's cross-section lines lit by pressure; airflow streaks; turbulence dots; fading afterglow of the tongue, jaw and lips; four big slot readouts under the chin.

## Rendering

**Canvas 2D, with a cheap shared glow.** Every renderer today is Canvas 2D (`useCanvasLoop`, `AnatomyRenderer`), so the drawings stay Canvas 2D and the glow becomes one shared step:

1. Draw sharp lines and text with `globalCompositeOperation = "lighter"`, so crossings add up like a beam.
2. Copy the canvas down to 1/4 and 1/16 size, blur each small copy by about 1 px, and add both back on top with `"lighter"` (alpha about 0.9 and 0.6). The small blurs cost a sixteenth and a 256th of a full-size blur, which is what made the app lag before.
3. Skip the frame when nothing changed (a dirty flag per screen), so idle screens cost nothing.

A hook, `usePhosphor(draw)`, replaces `useCanvasLoop` for the vector screens: DPR, resize, the rAF loop, the glow pass, the dirty flag, and a small kit (`beam(path, colour, width)`, `label(text, …)` in the Hershey font, `ipa(glyph, …)`).

**DOM for chrome.** Screen frames, titles, chips, tabs, text fields and encoders are DOM, in the Hershey font with CSS glow (`text-shadow`, `box-shadow`). They stay accessible and need no canvas work.

**WebGL only if measured.** If the full Play screen can't hold 60 fps on the target machine (integrated GPU, 2× DPR), move the line drawing to one shared WebGL2 context. Nothing above needs to change for that except the hook's internals.

**Budget.** Under 8 ms of main-thread time per frame for the Play screen at 2× DPR, measured with the e2e harness and a Chromium trace, before and after.

## Layout

- `App` becomes a top bar plus a grid: the tall left screen and a right column. Each mode defines its right column (as in the mockups).
- Below about 1100 px wide, the screens stack in one column: the left screen first, then the rest in reading order. Phones get the same stack.
- A `Screen` component draws the frame, title and subtitle; `focus` brightens the frame of the screen the encoders are bound to.

## Controls

- **Encoders replace sliders.** `Encoder` is a dial with a big numeral in its slot colour. It is `role="slider"` with `aria-valuetext`, takes vertical drag, the wheel, arrow keys and page up/down, and can be bound to MIDI CC later.
- **Pages of four.** An encoder screen shows four and pages through the rest:
  - Play: VOICE (pitch, breath, pressed, vibrato), TONE (breathy, rough, fry, glide), MOUTH (lip round, lip open, protrude, jaw), THROAT (tongue root, tip curl, velum, larynx), LARYNX (twang, false folds).
  - Sing: vibrato depth, rate, breathy, ring. Beatbox: tempo, swing, mic, bass note. Bestiary: the creature's params, four per page.
- **Chips** replace toggles and segmented buttons: a framed caps label, lit when on. Mode and body tabs are chips in the top bar.
- **View options** (pressure, airflow, measurements, grid) become chips in the face screen's corner.
- **Start prompt** becomes a framed overlay on the left screen with one lit chip ("BREATHE IN AND START").

## Screens per mode

| Mode | Left | Right column |
|---|---|---|
| Play | face (`AnatomyView`) | tube, vocal folds, spectrum, vowels, voice encoders, keys |
| Speak | face | say (text field, chips, transcription), gestural score, consonant chart, tube, vocal folds |
| Sing | face | piano roll, lyrics chips, spectrum with the ring zone, song encoders, keys |
| Beatbox | face with the hit's big symbol | step sequencer, waterfall spectrogram, pads, transport encoders + presets |
| Bestiary | creature (`CreatureView`) | creature gallery, waterfall spectrogram, calls, creature encoders, unrolled airway |

The mockup generator (`docs/mockups/gen/`) is the reference implementation for each drawing: the same geometry, colours and layout rules, written against the live data the app already has (`HumanFrame`, telemetry, transfer functions, plans, creature visuals).

## Phases

Each phase is a commit on `t3/ui-mockup-inspiration`, pushed, with the app working at every step.

1. **Foundations.** Hershey fonts in `public/fonts`, colour tokens (CSS and `colors.ts`), `Screen`, `Chip`, `Encoder`, `usePhosphor`, the app shell and top bar, the start overlay. Restyle everything else coarsely (black, frames, Hershey) so no screen looks broken.
2. **Play.** The face renderer in outlines (afterglow, turbulence, slots), tube, vocal folds, spectrum, vowel chart, encoders, keys.
3. **Speak, Sing, Beatbox, Bestiary.** Independent, so they can be built in parallel, each owning its own components and CSS file.
4. **Finish.** Performance check against the budget, the narrow layout, keyboard and screen-reader pass, e2e test names, a PR.

## Testing

- `bun run typecheck`, `bun test tests`, `cargo test --workspace` (the engine doesn't change).
- `tools/e2e.ts`: loads every mode, plays, checks for console errors, saves screenshots. Update it for the new button names.
- Compare each mode's screenshot with its mockup.
- Frame-time measurement from the e2e harness (rAF deltas and long tasks), Play and Beatbox, at 1× and 2× DPR.

## Risks and open questions

- **Software rendering.** Headless Chromium has no GPU, so e2e frame times will be pessimistic; the budget is for the real machine.
- **IPA in canvases.** The Hershey font has no IPA, so the chart, transcriptions and slots need the stroke glyphs (from `docs/mockups/gen/speak-ipa.ts` and `lib.ts`).
- **Bestiary keys.** The mockup dropped the on-screen keys for that mode. The computer keyboard and MIDI still play it; touch users would lose it. A thin keys strip may be needed.
- **Encoders on touch.** Vertical drag on a small dial is fiddly on a phone; the stacked layout may need wider dials.
