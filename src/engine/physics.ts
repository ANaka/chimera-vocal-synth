/**
 * Physical constants for airway acoustics, CGS units throughout
 * (cm, g, s; pressure in dyn/cm² = 0.1 Pa; volume velocity in cm³/s).
 */

/** Air density at body temperature, saturated (g/cm³). */
export const RHO = 1.14e-3;
/** Speed of sound in warm humid air (cm/s). */
export const C_SOUND = 35000;
/** Dynamic viscosity of air (poise = g/(cm·s)). */
export const MU = 1.86e-4;
/** Kinematic viscosity (cm²/s). */
export const NU = MU / RHO;
/** ρc² — bulk modulus of air (dyn/cm²). */
export const RHO_C2 = RHO * C_SOUND * C_SOUND;
/** 1 cm H2O in dyn/cm². */
export const CM_H2O = 980.665;

/** Soft-tissue wall parameters per unit area (Ishizaka, French & Flanagan 1975, cheek/neck). */
export interface WallParams {
  /** mass per unit area (g/cm²) */
  mass: number;
  /** resistance per unit area (dyn·s/cm³) */
  resistance: number;
  /** stiffness per unit area (dyn/cm³) */
  stiffness: number;
}

export const WALL_SOFT: WallParams = { mass: 1.5, resistance: 1600, stiffness: 3.0e5 };
/** Cartilaginous trachea: stiffer and lighter. */
export const WALL_TRACHEA: WallParams = { mass: 0.6, resistance: 1000, stiffness: 1.0e6 };
/** Nasal mucosa: lossy. */
export const WALL_NASAL: WallParams = { mass: 1.0, resistance: 3000, stiffness: 1.0e6 };

/** Critical Reynolds number for onset of turbulence noise. */
export const RE_CRIT = 1800;
