/**
 * Seasonal vegetation from the date and latitude, for the terrain and scenery shaders:
 *  - autumn: deciduous canopies turn orange and red, peaking mid-October (mid-April south of the
 *    equator), about ±4 weeks;
 *  - dormant: winter-brown grass and bare-looking forest, deepest mid-January (mid-July south),
 *    from about mid-November to mid-March.
 * Both apply in the temperate bands (≈30°–65° latitude); the tropics and the polar regions keep the
 * imagery as it is. The imagery itself is a summer composite, so "summer" is no change.
 */
export interface Season { autumn: number; dormant: number }

const DAY_MS = 86_400_000;

const smooth = (e0: number, e1: number, x: number) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
/** 1 at `centre` falling smoothly to 0 at ±`half` days, on a 365-day circle */
const bump = (day: number, centre: number, half: number) => {
  let d = Math.abs(day - centre) % 365;
  if (d > 182.5) d = 365 - d;
  return d >= half ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * d) / half);
};

export function seasonFor(utcMs: number, latDeg: number): Season {
  if (!Number.isFinite(utcMs) || !Number.isFinite(latDeg)) return { autumn: 0, dormant: 0 };
  const d = new Date(utcMs);
  const day = (utcMs - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY_MS; // 0 = 1 January
  const local = latDeg >= 0 ? day : (day + 182.5) % 365;
  const a = Math.abs(latDeg);
  const band = smooth(26, 36, a) * (1 - smooth(62, 70, a));
  // the bump is a little flat-topped: full colour for a couple of weeks around the peak
  return {
    autumn: band * Math.min(1, 1.3 * bump(local, 290, 32)),
    dormant: band * Math.min(1, 1.4 * bump(local, 15, 75)),
  };
}

/**
 * GLSL: `vec3 seasonalVegetation(vec3 albedo, float patchN, float autumn, float dormant)` recolours
 * green (vegetated) linear albedo, keeping its brightness; `patchN` (0…1, ground-fixed noise) varies the
 * autumn hues and leaves some canopies (conifers) green.
 */
export const SEASON_GLSL = /* glsl */ `
vec3 seasonalVegetation(vec3 albedo, float patchN, float autumn, float dormant) {
  if (autumn + dormant <= 0.0) return albedo;
  float lum = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
  float veg = clamp((albedo.g - max(albedo.r, albedo.b)) / max(lum, 1e-3) * 4.0, 0.0, 1.0);
  if (veg <= 0.0) return albedo;
  float canopy = 1.0 - smoothstep(0.03, 0.09, lum);
  // autumn: canopies from yellow-orange to red, a third of them evergreen
  vec3 hue = mix(vec3(1.0, 0.45, 0.07), vec3(0.9, 0.2, 0.06), smoothstep(0.55, 0.85, patchN));
  hue = mix(hue, vec3(0.95, 0.72, 0.12), smoothstep(0.6, 0.25, patchN) * 0.7);
  float deciduous = smoothstep(0.22, 0.42, patchN);
  vec3 autumnCol = hue * (lum / dot(hue, vec3(0.2126, 0.7152, 0.0722))) * 1.1;
  // open grassland only fades toward late-season gold
  vec3 gold = vec3(0.62, 0.55, 0.26) * (lum / 0.53);
  float wA = autumn * veg * canopy * deciduous;
  float wG = autumn * veg * (1.0 - canopy) * 0.35;
  // dormant: grass to straw, forest to grey-brown
  vec3 straw = mix(vec3(0.62, 0.50, 0.30), vec3(0.42, 0.36, 0.30), canopy);
  vec3 dormantCol = straw * (lum / dot(straw, vec3(0.2126, 0.7152, 0.0722))) * mix(1.15, 0.95, canopy);
  float wD = dormant * veg * mix(0.85, 0.6 * deciduous, canopy);
  vec3 col = mix(albedo, gold, clamp(wG, 0.0, 1.0));
  col = mix(col, autumnCol, clamp(wA, 0.0, 1.0));
  return clamp(mix(col, dormantCol, clamp(wD, 0.0, 1.0)), 0.0, 1.0);
}
`;
