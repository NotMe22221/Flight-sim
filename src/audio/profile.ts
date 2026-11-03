/**
 * Aircraft-specific numbers the audio module needs, derived from `AircraftConfig` so the synth
 * follows whatever airframe is loaded. Defaults describe the C172S (Lycoming IO-360-L2A,
 * McCauley 2-blade 76 in prop; docs/research/06 §A2.1).
 */
import type { AircraftConfig } from '../core/types';
import { DEG } from '../core/units';

/** Inputs of the audio synthesis that depend on the aircraft. */
export interface AudioProfile {
  cylinders: number;
  strokes: 2 | 4;
  ratedRpm: number;
  idleRpm: number;
  /** below this rpm combustion cannot sustain itself */
  minFiringRpm: number;
  minMapInHg: number;
  maxMapInHg: number;
  propBlades: number;
  propDiameterM: number;
  /** reference static thrust that counts as "full blade loading", N */
  refThrustN: number;
  /** representative flap transit time per detent, s */
  flapTransitS: number;
  /** electric flap motor (whine while the flaps move); false for a manual flap handle. Undefined = true */
  electricFlaps?: boolean;
  /** main-gear tyre radius (wheel-rotation bumps), m */
  mainTyreRadiusM: number;
  /** angle of attack where the stall horn sounds at minimum / full intensity, rad */
  alphaWarnRad: number;
  alphaStallRad: number;
  /** jets have an overspeed clacker; the C172 has none */
  overspeedClacker: boolean;
}

/** C172S defaults. */
export const C172_AUDIO_PROFILE: Readonly<AudioProfile> = {
  cylinders: 4,
  strokes: 4,
  ratedRpm: 2700,
  idleRpm: 650,
  minFiringRpm: 120,
  minMapInHg: 9,
  maxMapInHg: 28.5,
  propBlades: 2,
  propDiameterM: 1.93,
  refThrustN: 2700,
  flapTransitS: 2.9,
  mainTyreRadiusM: 0.22,
  alphaWarnRad: 12 * DEG,
  alphaStallRad: 16 * DEG,
  overspeedClacker: false,
};

/**
 * Build an {@link AudioProfile} from an aircraft configuration. Fields the config does not
 * describe (stall-horn α band, reference thrust) fall back to sensible estimates.
 */
export function audioProfileFromConfig(cfg: AircraftConfig): AudioProfile {
  const p: AudioProfile = { ...C172_AUDIO_PROFILE };
  const eng = cfg.propulsion.engine;
  if (eng.type === 'piston') {
    p.cylinders = eng.cylinders;
    p.ratedRpm = eng.ratedRPM;
    p.idleRpm = eng.idleRPM;
    p.minFiringRpm = eng.minFiringRPM;
    p.minMapInHg = eng.minMAPinHg;
    p.maxMapInHg = eng.maxMAPinHg;
    // static thrust of a fixed-pitch prop ≈ 0.016 N per W of rated power (C172: 134 kW → ~2.2–2.7 kN)
    p.refThrustN = Math.max(500, eng.ratedPowerW * 0.02);
  } else {
    p.refThrustN = eng.ratedThrustN;
  }
  const prop = cfg.propulsion.propeller;
  if (prop) { p.propBlades = prop.blades; p.propDiameterM = prop.diameterM; }
  const tr = cfg.controls.flaps.transitS;
  if (tr.length) p.flapTransitS = tr.reduce((a, b) => a + b, 0) / tr.length;
  // the Super Cub's flaps are on a hand lever (about 1 s per notch): no motor
  p.electricFlaps = !(cfg.airframe === 'cub' || (tr.length > 0 && p.flapTransitS <= 1.2));
  const mains = cfg.gear.filter((g) => g.type === 'wheel' && g.brakeGroup !== 'none');
  if (mains.length) p.mainTyreRadiusM = mains[0].tyreRadius;
  p.overspeedClacker = cfg.category === 'jet' || cfg.category === 'airliner';
  // stall-horn band: the CL table's peak is the break; the warning (5–10 kt early) is ≈ 4° earlier
  const aStall = clMaxAlpha(cfg);
  if (aStall !== null && aStall > 6 * DEG && aStall < 30 * DEG) {
    p.alphaStallRad = aStall;
    p.alphaWarnRad = aStall - 4 * DEG;
  }
  return p;
}

/** α of the maximum of the pre-stall CL column, or null when the table is unusable. */
function clMaxAlpha(cfg: AircraftConfig): number | null {
  const t = cfg.aero.CL.table;
  const nc = t.cols.length;
  if (!t.rows.length || !nc || t.data.length !== t.rows.length * nc) return null;
  let best = -Infinity, at: number | null = null;
  for (let i = 0; i < t.rows.length; i++) {
    const cl = t.data[i * nc];
    if (cl > best) { best = cl; at = t.rows[i]; }
  }
  return at;
}
