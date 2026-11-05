/**
 * Web MIDI keyboards: note on/off (with velocity) from every connected input, including ones
 * plugged in later. All-notes-off and unplugging release whatever that input was holding.
 */
export type MidiStatus = "off" | "connecting" | "on" | "unsupported" | "denied";

export interface MidiHandlers {
  noteOn: (note: number, velocity: number) => void;
  noteOff: (note: number) => void;
  /** names of the connected inputs (on every change) */
  inputs: (names: string[]) => void;
}

export const midiSupported = (): boolean => typeof navigator !== "undefined" && typeof navigator.requestMIDIAccess === "function";

let access: MIDIAccess | null = null;
/** notes held per input id */
const held = new Map<string, Set<number>>();

export async function connectMidi(h: MidiHandlers): Promise<void> {
  if (access) return;
  const a = await navigator.requestMIDIAccess({ sysex: false });
  access = a;
  const releaseInput = (id: string) => {
    const notes = held.get(id);
    if (notes) for (const n of notes) h.noteOff(n);
    held.delete(id);
  };
  const attach = () => {
    const names: string[] = [];
    const live = new Set<string>();
    a.inputs.forEach((input) => {
      live.add(input.id);
      names.push(input.name || "MIDI keyboard");
      input.onmidimessage = (e: MIDIMessageEvent) => {
        const d = e.data;
        if (!d || d.length < 2) return;
        const kind = d[0] & 0xf0;
        const notes = held.get(input.id) ?? new Set<number>();
        held.set(input.id, notes);
        if (kind === 0x90 && d[2] > 0) {
          notes.add(d[1]);
          h.noteOn(d[1], d[2]);
        } else if (kind === 0x80 || (kind === 0x90 && d[2] === 0)) {
          if (notes.delete(d[1])) h.noteOff(d[1]);
        } else if (kind === 0xb0 && (d[1] === 123 || d[1] === 120)) releaseInput(input.id); // all notes / sound off
      };
    });
    for (const id of [...held.keys()]) if (!live.has(id)) releaseInput(id);
    h.inputs(names);
  };
  a.onstatechange = attach;
  attach();
}

export function disconnectMidi(h: Pick<MidiHandlers, "noteOff">): void {
  if (!access) return;
  access.inputs.forEach((input) => (input.onmidimessage = null));
  access.onstatechange = null;
  access = null;
  for (const notes of held.values()) for (const n of notes) h.noteOff(n);
  held.clear();
}
