/** Design tokens shared by canvas renderers (CSS mirrors these as custom properties). */
export const C = {
  black: "#000000",
  console: "#2a3035",
  inset: "#20262a",
  line: "#3c444a",
  text: "#e8eaeb",
  textDim: "#9aa3a8",
  caliper: "#f2cf5b",
  caliperDim: "rgba(242, 207, 91, 0.45)",
  // MRI-like tissue intensities (T1-ish)
  fat: "#bdbdbd",
  skin: "#a8a8a8",
  muscle: "#5d5d5d",
  tongue: "#6b6b6b",
  brain: "#7c7c7c",
  marrow: "#b2b2b2",
  cortex: "#1c1c1c",
  cartilage: "#3e3e3e",
  mucosa: "#8f8f8f",
  tooth: "#101010",
};

/** fMRI-style "hot" scale for acoustic energy: black → red → orange → yellow → white. */
const HOT: [number, number, number, number][] = [
  [0.0, 0, 0, 0],
  [0.25, 138, 18, 0],
  [0.5, 240, 88, 28],
  [0.75, 255, 209, 92],
  [1.0, 255, 248, 230],
];

export function hot(t: number): [number, number, number] {
  if (!(t > 0)) return [0, 0, 0];
  if (t >= 1) return [255, 248, 230];
  for (let i = 1; i < HOT.length; i++) {
    if (t <= HOT[i][0]) {
      const a = HOT[i - 1], b = HOT[i];
      const u = (t - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
    }
  }
  return [255, 248, 230];
}

export const hotCss = (t: number, alpha = 1): string => {
  const [r, g, b] = hot(t);
  return `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${alpha})`;
};

/** Map acoustic pressure RMS (dyn/cm²) to 0..1 on a log scale. */
export const pressureLevel = (rms: number): number => {
  if (!(rms > 0)) return 0;
  const lo = Math.log10(40), hi = Math.log10(4000);
  return Math.max(0, Math.min(1, (Math.log10(rms) - lo) / (hi - lo)));
};
