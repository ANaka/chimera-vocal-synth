/**
 * Reference vowel formants (Hz) used to calibrate articulatory vowel targets.
 * English vowels: Hillenbrand, Getty, Clark & Wheeler (1995) means (men / women / children).
 * Other cardinal-ish vowels: typical literature values (men), scaled for women/children.
 */
export interface VowelRef {
  ipa: string;
  /** example word / description */
  example: string;
  male: [number, number, number];
  female: [number, number, number];
  child: [number, number, number];
  round: boolean;
  /** 0 close … 1 open */
  height: number;
  /** 0 front … 1 back */
  back: number;
}

const scaleRef = (m: [number, number, number], k: [number, number, number]): [number, number, number] => [m[0] * k[0], m[1] * k[1], m[2] * k[2]];
const FEM: [number, number, number] = [1.17, 1.2, 1.15];
const CHI: [number, number, number] = [1.3, 1.33, 1.24];

function ref(ipa: string, example: string, male: [number, number, number], female: [number, number, number] | null, child: [number, number, number] | null, round: boolean, height: number, back: number): VowelRef {
  return { ipa, example, male, female: female ?? scaleRef(male, FEM), child: child ?? scaleRef(male, CHI), round, height, back };
}

export const VOWELS: VowelRef[] = [
  ref("i", "heed", [342, 2322, 3000], [437, 2761, 3372], [452, 3081, 3702], false, 0, 0),
  ref("ɪ", "hid", [427, 2034, 2684], [483, 2365, 3053], [511, 2552, 3403], false, 0.2, 0.15),
  ref("e", "hayed", [476, 2089, 2691], [536, 2530, 3047], [564, 2656, 3323], false, 0.3, 0.05),
  ref("ɛ", "head", [580, 1799, 2605], [731, 2058, 2979], [749, 2267, 3310], false, 0.55, 0.1),
  ref("æ", "had", [640, 1760, 2500], [669, 2349, 2972], [717, 2501, 3289], false, 0.8, 0.15),
  ref("a", "front open (Fr. patte)", [780, 1450, 2550], null, null, false, 1, 0.35),
  ref("ɑ", "hod", [768, 1333, 2522], [936, 1551, 2815], [1002, 1688, 2950], false, 1, 0.85),
  ref("ɒ", "Br. lot", [620, 880, 2500], null, null, true, 0.9, 1),
  ref("ɔ", "hawed", [652, 997, 2538], [781, 1136, 2824], [803, 1210, 2982], true, 0.65, 1),
  ref("o", "hoed", [497, 910, 2459], [555, 1035, 2828], [597, 1137, 2987], true, 0.35, 1),
  ref("ʊ", "hood", [469, 1122, 2434], [519, 1225, 2827], [568, 1490, 3072], true, 0.2, 0.85),
  ref("u", "who'd", [378, 997, 2343], [459, 1105, 2735], [494, 1345, 2988], true, 0, 1),
  ref("ʌ", "hud", [623, 1200, 2550], [753, 1426, 2933], [749, 1546, 3145], false, 0.6, 0.7),
  ref("ə", "sofa", [500, 1450, 2450], null, null, false, 0.5, 0.5),
  ref("ɐ", "near-open central", [640, 1350, 2500], null, null, false, 0.8, 0.5),
  ref("ɝ", "heard", [474, 1379, 1710], [523, 1588, 1929], [586, 1719, 2143], true, 0.45, 0.5),
  ref("y", "Fr. tu", [300, 1800, 2150], null, null, true, 0, 0),
  ref("ø", "Fr. peu", [390, 1550, 2250], null, null, true, 0.3, 0.1),
  ref("œ", "Fr. peur", [520, 1450, 2350], null, null, true, 0.55, 0.15),
  ref("ɨ", "close central", [330, 1600, 2400], null, null, false, 0, 0.5),
  ref("ɯ", "close back unrounded", [340, 1350, 2400], null, null, false, 0, 1),
  ref("ɤ", "close-mid back unrounded", [460, 1250, 2450], null, null, false, 0.35, 1),
];
