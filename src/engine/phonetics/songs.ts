/** Demo melodies for Sing mode: [MIDI note, beats] per syllable, in the adult female register. */
export interface DemoSong {
  name: string;
  bpm: number;
  lyrics: string;
  notes: [number, number][];
  /** octave shift per body */
  octave: { male: number; female: number; child: number };
}

export const DEMO_SONGS: DemoSong[] = [
  {
    // an original tune for this instrument
    name: "Made of air",
    bpm: 84,
    lyrics: "Breathe in, breathe out, I am made of air. Tongue and lips and throat, singing anywhere.",
    notes: [
      [64, 1], [60, 1], [62, 1], [57, 1],
      [57, 0.5], [60, 0.5], [64, 1], [62, 0.5], [60, 1.5],
      [65, 1], [64, 0.5], [62, 0.5], [60, 0.5], [62, 1.5],
      [64, 0.5], [62, 0.5], [60, 0.5], [59, 0.5], [57, 2],
    ],
    octave: { male: -1, female: 0, child: 0 },
  },
  {
    // traditional (public domain)
    name: "Twinkle, twinkle",
    bpm: 100,
    lyrics: "Twinkle twinkle little star, how I wonder what you are.",
    notes: [
      [60, 1], [60, 1], [67, 1], [67, 1], [69, 1], [69, 1], [67, 2],
      [65, 1], [65, 1], [64, 1], [64, 1], [62, 1], [62, 1], [60, 2],
    ],
    octave: { male: -1, female: 0, child: 0 },
  },
];
