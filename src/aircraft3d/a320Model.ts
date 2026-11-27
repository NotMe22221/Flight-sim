/**
 * Procedural A320-family airliner (`AircraftConfig.airframe === 'a320'`): circular fuselage with the
 * cabin window rows and the cockpit window band painted on the livery (glass patches over the
 * cockpit windows), low swept wings with sharklets, flaps, ailerons and spoilers, two under-wing
 * turbofan nacelles with spinning fans, a conventional tail, retracting tricycle gear (twin
 * wheels), the lights and a two-seat cockpit with side-sticks, thrust levers and the glass panel.
 *
 * Model-local metres like the other airframes: nose −Z, up +Y, right wing +X, origin at the
 * empty CG. Sizes are the real aircraft's (37.6 m long, 34.1 m span, 3.95 m fuselage).
 */
import * as THREE from 'three';
import type { AircraftState, ControlInputs, GearState } from '../core/types';
import { bodyVecToThreeLocal } from './frames';
import { buildWingPanel, mirrorGeometryX, planformPoint, type AirfoilSpec, type WingSection } from './airfoil';
import { cropSections } from './wings';
import { attachToHinge } from './hinge';
import { buildLoft, buildLoftPatch, LoftProfile, type LoftStation } from './loft';
import type { AircraftModelConfig, LightLayout } from './layoutTypes';
import type { ModelMaterials, PaintScheme } from './materials';
import type { GearAssembly } from './gear';
import { applyPanelLighting, type CockpitAssembly, type PanelMesh, type PanelVariant } from './interior';
import type { LiveryScheme } from './textures';
import { applyIblScale } from '../sky/iblScale';

const D2R = Math.PI / 180;
const SUPERCRITICAL: AirfoilSpec = { thickness: 0.11, camber: 0.015, camberPos: 0.55 };
const TAIL_FOIL: AirfoilSpec = { thickness: 0.1, camber: 0, camberPos: 0.4 };

/** fuselage centreline height and radius (model y, m) */
const YC = 0.35, R = 1.98;

/** White airliner with a blue belly line and window rows; the cockpit window band is painted dark. */
export const A320_LIVERY: LiveryScheme = {
  base: '#f5f6f7',
  bands: [
    { f0: 0.0, f1: 0.2, color: '#c9ccd1' },      // grey belly
    { f0: 0.2, f1: 0.235, color: '#1c3f8c' },    // blue line
  ],
  lines: [
    // cockpit windscreen and side windows: dark band around the nose
    { y0: YC + 0.12, y1: YC + 1.12, slope: 0, color: '#1b2230', from: 0.68, to: 3.45 },
    { y0: YC + 0.12, y1: YC + 2.2, slope: 0, color: '#1b2230', from: 0.68, to: 1.88 },
  ],
  windows: [
    { y: YC + 0.52, w: 0.24, h: 0.34, pitch: 0.53, from: 5.2, to: 30.5, color: '#232a36', skip: [[4.6, 5.6], [10.9, 11.9], [12.6, 13.4], [29.2, 30.2]] },
  ],
  regColor: '#1c3f8c', regF: 0.62, capF: 0.18,
};

export const A320_PAINT: PaintScheme = { livery: A320_LIVERY, plain: 0xf0f1f3, trim: 0x1c3f8c, fallback: 0xf5f6f7 };

export interface A320Layout {
  airframe: 'a320';
  zNose: number; zTail: number;
  fuselage: { stations: LoftStation[] };
  eye: THREE.Vector3;
  lights: LightLayout;
  wing: { sections: WingSection[]; halfSpan: number; flapSpan: [number, number]; aileronSpan: [number, number]; hinge: number };
  engines: THREE.Vector3[];
  gear: { nose: { index: number; contact: THREE.Vector3; r: number } | null; mains: { index: number; contact: THREE.Vector3; r: number }[] };
  /** registration decal along the fuselage, m behind the nose */
  regZ: [number, number];
}

export function resolveA320Layout(cfg: AircraftModelConfig): A320Layout {
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const st = (z: number, width: number, top: number, bottom: number, n = 2): LoftStation => ({ z, width, height: top - bottom, yCenter: (top + bottom) / 2, n });
  const zNose = -17.3, zTail = 20.3;
  const stations: LoftStation[] = [
    st(zNose, 0.25, YC - 0.2, YC - 0.45),
    st(-17.0, 1.3, YC + 0.12, YC - 0.95),
    st(-16.6, 2.1, YC + 0.42, YC - 1.3),
    st(-15.5, 3.0, YC + 1.45, YC - 1.65),
    st(-14.4, 3.55, YC + 1.8, YC - 1.85),
    st(-12.8, 3.9, YC + 1.96, YC - 1.97),
    st(-11.2, 3.95, YC + R, YC - R),
    st(8.5, 3.95, YC + R, YC - R),
    st(11.5, 3.75, YC + R, YC - 1.55),
    st(15.0, 2.7, YC + 1.88, YC - 0.55),
    st(18.4, 1.35, YC + 1.62, YC + 0.45),
    st(zTail, 0.3, YC + 1.35, YC + 1.0),
  ];
  // wing: root at the fuselage side, unswept inboard trailing edge, kink at 6.3 m, 5° dihedral
  const dih = Math.tan(5 * D2R);
  const rootY = YC - 1.32, sweep = Math.tan(27 * D2R);
  const halfSpan = cfg.geometry.b / 2 - 0.25;
  const leAt = (x: number) => -3.7 + (x - 1.9) * sweep;
  const wingSections: WingSection[] = [
    { x: 0.6, chord: 6.6, le: { x: 0, y: rootY, z: -3.9 } },
    { x: 1.9, chord: 6.4, le: { x: 0, y: rootY + 1.3 * dih, z: leAt(1.9) } },
    { x: 6.3, chord: 3.95, le: { x: 0, y: rootY + 5.7 * dih, z: leAt(6.3) } },
    { x: halfSpan, chord: 1.45, le: { x: 0, y: rootY + (halfSpan - 0.6) * dih, z: leAt(halfSpan) } },
  ];
  const engines = (cfg.engines ?? [[2.6, -5.75, 1.6], [2.6, 5.75, 1.6]]).map((p) => {
    const m = bodyVecToThreeLocal(p, new THREE.Vector3());
    return v(m.x, Math.min(m.y, rootY - 0.55), m.z);
  });
  const wheels = cfg.gear.map((g, index) => ({ g, index })).filter(({ g }) => g.type === 'wheel');
  const toGear = ({ g, index }: { g: (typeof cfg.gear)[number]; index: number }) => ({ index, contact: bodyVecToThreeLocal(g.pos, new THREE.Vector3()), r: g.tyreRadius });
  const noseW = wheels.find(({ g }) => g.pos[0] > 3) ?? null;
  const eye = bodyVecToThreeLocal(cfg.geometry.eyePoint, new THREE.Vector3());
  const tipY = rootY + (halfSpan - 0.6) * dih;
  return {
    airframe: 'a320', zNose, zTail, fuselage: { stations }, eye,
    wing: { sections: wingSections, halfSpan, flapSpan: [2.0, 12.0], aileronSpan: [12.4, 16.0], hinge: 0.74 },
    engines,
    gear: { nose: noseW ? toGear(noseW) : null, mains: wheels.filter((w) => w !== noseW).map(toGear) },
    lights: {
      navLeft: v(-halfSpan - 0.05, tipY + 0.05, leAt(halfSpan) + 0.3), navRight: v(halfSpan + 0.05, tipY + 0.05, leAt(halfSpan) + 0.3),
      navTail: v(0, YC + 1.18, zTail + 0.05), beacon: v(0, YC + R + 0.06, 1.0),
      strobeLeft: v(-halfSpan - 0.05, tipY + 0.05, leAt(halfSpan) + 1.2), strobeRight: v(halfSpan + 0.05, tipY + 0.05, leAt(halfSpan) + 1.2),
      landing: v(-2.4, rootY - 0.1, leAt(2.4) + 0.4), taxi: v(0, -2.25, -12.35),
    },
    regZ: [31.2, 34.6],
  };
}

// ─────────────────────────────── engines ───────────────────────────────

/** The two turbofans' spinning fans (the propeller's role): N1 → fan rotation. */
export class TurbofanFans {
  readonly group = new THREE.Group();
  angle = 0;
  private readonly fans: THREE.Group[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  constructor(L: A320Layout, mats: ModelMaterials) {
    this.group.name = 'engines';
    const nacelleMat = mats.paintPlain;
    const inner = new THREE.MeshStandardMaterial({ color: 0x1a1b1d, roughness: 0.6, metalness: 0.5, side: THREE.DoubleSide });
    const fanMat = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.35, metalness: 0.85 });
    const coreMat = new THREE.MeshStandardMaterial({ color: 0x7d8288, roughness: 0.4, metalness: 0.8 });
    const spinnerMat = new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.3, metalness: 0.6 });
    this.materials.push(inner, fanMat, coreMat, spinnerMat);
    // nacelle outer skin: lathe profile from the inlet lip (y = 0) to the fan nozzle (y = 3.6)
    const lip: [number, number][] = [[0.86, 0.0], [0.95, 0.05], [1.05, 0.25], [1.12, 0.7], [1.14, 1.3], [1.1, 2.1], [1.0, 2.9], [0.88, 3.6]];
    const outerGeo = new THREE.LatheGeometry(lip.map(([r, y]) => new THREE.Vector2(r, y)), 40);
    // inner duct (dark, seen through the inlet)
    const ductGeo = new THREE.CylinderGeometry(0.86, 0.86, 0.9, 40, 1, true);
    // core cowl and exhaust plug behind the fan nozzle
    const corePts: [number, number][] = [[0.62, 3.4], [0.6, 3.9], [0.48, 4.4], [0.34, 4.65]];
    const coreGeo = new THREE.LatheGeometry(corePts.map(([r, y]) => new THREE.Vector2(r, y)), 28);
    const plugPts: [number, number][] = [[0.3, 4.5], [0.24, 4.85], [0.02, 5.1]];
    const plugGeo = new THREE.LatheGeometry(plugPts.map(([r, y]) => new THREE.Vector2(r, y)), 20);
    const spinnerPts: [number, number][] = [[0.02, -0.0], [0.18, 0.12], [0.3, 0.32], [0.33, 0.45]];
    const spinnerGeo = new THREE.LatheGeometry(spinnerPts.map(([r, y]) => new THREE.Vector2(r, y)), 24);
    const bladeGeo = new THREE.BoxGeometry(0.11, 0.53, 0.025);
    bladeGeo.translate(0, 0.33 + 0.265, 0);
    const pylonGeo = new THREE.BoxGeometry(0.34, 1, 1);
    this.geometries.push(outerGeo, ductGeo, coreGeo, plugGeo, spinnerGeo, bladeGeo, pylonGeo);
    for (const pos of L.engines) {
      const e = new THREE.Group();
      e.name = 'engine';
      // lathe axis +Y → aft (+Z); the inlet sits 2.2 m ahead of the reference point
      const axis = new THREE.Group();
      axis.rotation.x = Math.PI / 2;
      axis.position.set(pos.x, pos.y, pos.z - 1.9);
      const outer = new THREE.Mesh(outerGeo, nacelleMat); outer.name = 'nacelle';
      const duct = new THREE.Mesh(ductGeo, inner); duct.position.y = 0.45;
      const core = new THREE.Mesh(coreGeo, coreMat); const plug = new THREE.Mesh(plugGeo, inner);
      axis.add(outer, duct, core, plug);
      // fan: spinner + 22 blades, rotating about the engine axis
      const fan = new THREE.Group();
      fan.position.y = 0.55;
      const spinner = new THREE.Mesh(spinnerGeo, spinnerMat); spinner.position.y = -0.45;
      fan.add(spinner);
      for (let i = 0; i < 22; i++) {
        const b = new THREE.Mesh(bladeGeo, fanMat);
        // blades in the plane normal to the axis (local y = axis): radial along z, pitched about their own length
        const holder = new THREE.Group();
        holder.rotation.y = (i / 22) * Math.PI * 2;
        b.rotation.set(Math.PI / 2, 0.5, 0);
        holder.add(b);
        fan.add(holder);
      }
      axis.add(fan);
      this.fans.push(fan);
      // pylon from the nacelle top to the wing
      const pylon = new THREE.Mesh(pylonGeo, nacelleMat);
      pylon.scale.set(1, 0.9, 4.2);
      pylon.position.set(pos.x, pos.y + 1.2, pos.z + 0.4);
      pylon.rotation.x = -0.08;
      pylon.name = 'pylon';
      e.add(axis, pylon);
      this.group.add(e);
    }
  }

  /** rpm: the flight model's N1 × 5175 (fan speed at 100 % N1). */
  update(rpm: number, dt: number): void {
    const r = Number.isFinite(rpm) ? rpm : 0;
    // the real fan would alias: shown at a fraction of its speed, still clearly spinning
    const shown = r < 600 ? r : 600 + (r - 600) * 0.05;
    this.angle = (this.angle + (shown / 60) * 2 * Math.PI * (dt > 0 ? dt : 0)) % (2 * Math.PI);
    for (const f of this.fans) f.rotation.y = this.angle;
  }

  get bladesVisible(): boolean { return true; }
  get discVisible(): boolean { return false; }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}

// ─────────────────────────────── airframe ───────────────────────────────

export interface A320Parts {
  fuselage: THREE.Group;
  cabinShell: THREE.Group;
  profile: LoftProfile;
  wings: { group: THREE.Group; aileronLeft: THREE.Group; aileronRight: THREE.Group; flapLeft: THREE.Group; flapRight: THREE.Group; spoilers: THREE.Group[] };
  tail: { group: THREE.Group; elevator: THREE.Group; elevatorLeft: THREE.Group; rudder: THREE.Group };
}

export function buildA320Airframe(L: A320Layout, mats: ModelMaterials): A320Parts {
  const profile = new LoftProfile(L.fuselage.stations);
  const fuselage = new THREE.Group();
  fuselage.name = 'fuselage';
  const skin = new THREE.Mesh(buildLoft(profile, { radialSegments: 48, lengthSubdivisions: 4, uRange: [L.zNose, L.zTail] }), mats.paint);
  skin.name = 'fuselageSkin';
  fuselage.add(skin);
  // wing-to-body fairing (belly)
  const fairing = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mats.paintPlain);
  fairing.scale.set(2.25, 1.05, 6.2);
  fairing.position.set(0, YC - 1.45, -0.4);
  fairing.name = 'bellyFairing';
  fuselage.add(fairing);
  // cockpit glass over the painted window band (hidden from inside, where the lining frames the openings)
  const cabinShell = new THREE.Group();
  cabinShell.name = 'cabinShell';
  for (const w of cockpitPanes(profile, L.eye.y)) {
    const m = new THREE.Mesh(buildLoftPatch(profile, { ...w, offset: 0.012 }), mats.glass); m.name = 'cockpitGlass';
    cabinShell.add(m);
  }
  fuselage.add(cabinShell);
  // antennas / probes: small details
  const ant = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.32, 0.22), mats.gasket);
  ant.position.set(0, YC + R + 0.14, -6); ant.rotation.x = 0.4;
  fuselage.add(ant);

  // ── wings ──
  const W = L.wing;
  const wings = new THREE.Group(); wings.name = 'wings';
  const mainR = buildWingPanel({ airfoil: SUPERCRITICAL, sections: W.sections, chordTo: W.hinge, capRoot: true, capTip: true, spanSubdivisions: 3 });
  wings.add(new THREE.Mesh(mainR, mats.paintPlain), new THREE.Mesh(mirrorGeometryX(mainR), mats.paintPlain));
  const fixed: [number, number][] = [[W.sections[0].x, W.flapSpan[0] - 0.02], [W.flapSpan[1] + 0.02, W.aileronSpan[0] - 0.02], [W.aileronSpan[1] + 0.02, W.halfSpan]];
  for (const [x0, x1] of fixed) {
    if (x1 - x0 < 0.05) continue;
    const g = buildWingPanel({ airfoil: SUPERCRITICAL, sections: cropSections(W.sections, x0, x1), chordFrom: W.hinge, capRoot: true, capTip: true });
    wings.add(new THREE.Mesh(g, mats.paintPlain), new THREE.Mesh(mirrorGeometryX(g), mats.paintPlain));
  }
  const hinged = (span: [number, number], name: string) => {
    const gR = buildWingPanel({ airfoil: SUPERCRITICAL, sections: cropSections(W.sections, span[0], span[1]), chordFrom: W.hinge, capRoot: true, capTip: true });
    const mR = new THREE.Mesh(gR, mats.paintPlain), mL = new THREE.Mesh(mirrorGeometryX(gR), mats.paintPlain);
    mR.name = `${name}Right`; mL.name = `${name}Left`;
    const p0 = planformPoint(W.sections, span[0], W.hinge, new THREE.Vector3());
    const p1 = planformPoint(W.sections, span[1], W.hinge, new THREE.Vector3());
    const hR = attachToHinge(mR, p0, p1, 'x');
    const hL = attachToHinge(mL, p0.clone().setX(-p0.x), p1.clone().setX(-p1.x), 'x');
    wings.add(hR.mount, hL.mount);
    return { right: hR.pivot, left: hL.pivot };
  };
  const flaps = hinged(W.flapSpan, 'flap');
  const ailerons = hinged(W.aileronSpan, 'aileron');
  // spoilers: five panels per wing ahead of the flaps, hinged at their leading edge
  const spoilers: THREE.Group[] = [];
  for (let i = 0; i < 5; i++) {
    const x0 = 3.0 + i * 1.75, x1 = x0 + 1.6;
    for (const side of [1, -1]) {
      const xm = (x0 + x1) / 2;
      const c0 = planformPoint(W.sections, xm, 0.6, new THREE.Vector3());
      const chordHere = planformPoint(W.sections, xm, 1, new THREE.Vector3()).z - planformPoint(W.sections, xm, 0, new THREE.Vector3()).z;
      const len = 0.13 * chordHere;
      const thick = SUPERCRITICAL.thickness * chordHere * 0.42;
      // each panel owns its geometry: attachToHinge moves the vertices into the hinge frame
      const geo = new THREE.BoxGeometry(x1 - x0, 0.03, len);
      geo.translate(side * xm, c0.y + thick, c0.z + len / 2);
      const m = new THREE.Mesh(geo, mats.paintPlain);
      m.name = 'spoiler';
      const a = planformPoint(W.sections, x0, 0.6, new THREE.Vector3()), b = planformPoint(W.sections, x1, 0.6, new THREE.Vector3());
      const pa = new THREE.Vector3(side * a.x, a.y + thick, a.z), pb = new THREE.Vector3(side * b.x, b.y + thick, b.z);
      const h = attachToHinge(m, pa, pb, 'x');
      wings.add(h.mount);
      spoilers.push(h.pivot);
    }
  }
  // sharklets: canted-up tip devices
  const tip = W.sections[W.sections.length - 1];
  const shark = buildWingPanel({ airfoil: TAIL_FOIL, sections: [
    { x: 0, chord: tip.chord * 0.95, le: { x: 0, y: 0, z: 0 } },
    { x: 2.4, chord: 0.55, le: { x: 0, y: 0, z: 1.1 } },
  ], capRoot: false, capTip: true });
  for (const side of [1, -1]) {
    const m = new THREE.Mesh(shark, mats.trim);
    m.rotation.z = side * (Math.PI / 2 - 0.35);
    m.position.set(side * (W.halfSpan - 0.02), tip.le.y, tip.le.z + 0.02);
    if (side < 0) m.scale.x = -1;
    m.name = 'sharklet';
    wings.add(m);
  }

  // ── tail ──
  const tail = new THREE.Group(); tail.name = 'tail';
  // horizontal stabiliser (root at the fuselage centreline, 6° dihedral, swept)
  const hsSweep = Math.tan(30 * D2R), hsDih = Math.tan(6 * D2R), hsY = YC + 0.55;
  const hs: WingSection[] = [
    { x: 0, chord: 4.2, le: { x: 0, y: hsY, z: 14.6 } },
    { x: 6.15, chord: 1.6, le: { x: 0, y: hsY + 6.15 * hsDih, z: 14.6 + 6.15 * hsSweep } },
  ];
  const hsMain = buildWingPanel({ airfoil: TAIL_FOIL, sections: hs, chordTo: 0.7, capTip: true });
  tail.add(new THREE.Mesh(hsMain, mats.paintPlain), new THREE.Mesh(mirrorGeometryX(hsMain), mats.paintPlain));
  const elevGeo = buildWingPanel({ airfoil: TAIL_FOIL, sections: cropSections(hs, 0.9, 6.15), chordFrom: 0.7, capRoot: true, capTip: true });
  const eR = new THREE.Mesh(elevGeo, mats.paintPlain), eL = new THREE.Mesh(mirrorGeometryX(elevGeo), mats.paintPlain);
  const ep0 = planformPoint(hs, 0.9, 0.7, new THREE.Vector3()), ep1 = planformPoint(hs, 6.15, 0.7, new THREE.Vector3());
  // one elevator pivot for both halves: hinge along the right side line (sweep is small enough)
  const elevR = attachToHinge(eR, ep0, ep1, 'x');
  const elevL = attachToHinge(eL, ep0.clone().setX(-ep0.x), ep1.clone().setX(-ep1.x), 'x');
  tail.add(elevR.mount, elevL.mount);
  // fin (sections along +X = height, then turned upright), painted in the trim colour
  const finSweep = Math.tan(34 * D2R), finRootY = YC + 1.55;
  const fin: WingSection[] = [
    { x: 0, chord: 6.0, le: { x: 0, y: 0, z: 13.3 } },
    { x: 5.9, chord: 2.0, le: { x: 0, y: 0, z: 13.3 + 5.9 * finSweep } },
  ];
  const toUp = (g: THREE.BufferGeometry) => { g.rotateZ(Math.PI / 2); g.translate(0, finRootY, 0); g.computeVertexNormals(); return g; };
  const finMain = toUp(buildWingPanel({ airfoil: TAIL_FOIL, sections: fin, chordTo: 0.7, capRoot: true, capTip: true }));
  const finMesh = new THREE.Mesh(finMain, mats.trim); finMesh.name = 'fin';
  tail.add(finMesh);
  const rudGeo = toUp(buildWingPanel({ airfoil: TAIL_FOIL, sections: cropSections(fin, 0.3, 5.9), chordFrom: 0.7, capRoot: true, capTip: true }));
  const rudMesh = new THREE.Mesh(rudGeo, mats.trim); rudMesh.name = 'rudder';
  const rp0 = planformPoint(fin, 0.3, 0.7, new THREE.Vector3()), rp1 = planformPoint(fin, 5.9, 0.7, new THREE.Vector3());
  const up = (p: THREE.Vector3) => new THREE.Vector3(-p.y, p.x + finRootY, p.z);
  const rud = attachToHinge(rudMesh, up(rp0), up(rp1), 'y');
  tail.add(rud.mount);

  return {
    fuselage, cabinShell, profile,
    wings: { group: wings, aileronLeft: ailerons.left, aileronRight: ailerons.right, flapLeft: flaps.left, flapRight: flaps.right, spoilers },
    tail: { group: tail, elevator: elevR.pivot, elevatorLeft: elevL.pivot, rudder: rud.pivot },
  };
}

/** Cockpit window openings along z (windscreen, side window). */
const COCKPIT_WINDOWS: [number, number][] = [[-16.62, -15.42], [-15.32, -13.85]];
/** window sill below / window top above the eye, m */
const SILL = 0.4, WIN_TOP = 0.42;
/** half-width of the windscreen centre post, rad of the loft parameter */
const CENTRE_POST = 0.025;

interface Pane { z0: number; z1: number; t0: number; t1: number }

/** Loft parameter of the window sill (`tS`) and of the side-window top (`tT`) over a z range. */
function windowT(profile: LoftProfile, eyeY: number, z0: number, z1: number): { tS: number; tT: number } {
  const zm = (z0 + z1) / 2;
  return { tS: profile.tAtHeight(zm, eyeY - SILL), tT: profile.tAtHeight(zm, eyeY + WIN_TOP) };
}

/** Glass panes: the two windscreen halves (up to the centre post on top) and the side windows. */
function cockpitPanes(profile: LoftProfile, eyeY: number): Pane[] {
  const [ws, sw] = COCKPIT_WINDOWS;
  const a = windowT(profile, eyeY, ws[0], ws[1]), b = windowT(profile, eyeY, sw[0], sw[1]);
  const P = Math.PI;
  return [
    { z0: ws[0], z1: ws[1], t0: a.tS, t1: P - CENTRE_POST }, { z0: ws[0], z1: ws[1], t0: P + CENTRE_POST, t1: 2 * P - a.tS },
    { z0: sw[0], z1: sw[1], t0: b.tS, t1: b.tT }, { z0: sw[0], z1: sw[1], t0: 2 * P - b.tT, t1: 2 * P - b.tS },
  ];
}


// ─────────────────────────────── gear ───────────────────────────────

export class A320Gear implements GearAssembly {
  readonly group = new THREE.Group();
  readonly noseRoot: THREE.Group | null = null;
  readonly tailRoot: THREE.Group | null = null;
  private readonly carriers = new Map<number, THREE.Group>();
  private readonly wheels = new Map<number, THREE.Mesh>();
  private readonly wheelSets = new Map<number, THREE.Mesh[]>();
  private readonly legs: { index: number; root: THREE.Group; axis: 'x' | 'z'; sign: number; r: number }[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor(L: A320Layout, mats: ModelMaterials) {
    this.group.name = 'gear';
    const tyre = (r: number, w: number) => { const g = new THREE.CylinderGeometry(r, r, w, 24); g.rotateZ(Math.PI / 2); this.geometries.push(g); return g; };
    const hubGeo = (r: number, w: number) => { const g = new THREE.CylinderGeometry(r * 0.55, r * 0.55, w * 1.04, 16); g.rotateZ(Math.PI / 2); this.geometries.push(g); return g; };
    const strutGeo = new THREE.CylinderGeometry(0.11, 0.11, 1, 12); this.geometries.push(strutGeo);
    const build = (gear: { index: number; contact: THREE.Vector3; r: number }, nose: boolean) => {
      const axleY = gear.contact.y + gear.r;
      const attachY = nose ? YC - 1.35 : YC - 1.25;
      const root = new THREE.Group(); // retraction pivot at the attach point
      root.position.set(gear.contact.x, attachY, gear.contact.z);
      const steer = new THREE.Group();
      root.add(steer);
      const carrier = new THREE.Group(); // compresses upward
      steer.add(carrier);
      const len = attachY - axleY;
      const strut = new THREE.Mesh(strutGeo, mats.metal);
      strut.scale.set(nose ? 0.9 : 1.4, len, nose ? 0.9 : 1.4);
      strut.position.y = -len / 2;
      steer.add(strut);
      const w = nose ? 0.26 : 0.4;
      const tg = tyre(gear.r, w), hg = hubGeo(gear.r, w);
      const set: THREE.Mesh[] = [];
      for (const dx of nose ? [-0.2, 0.2] : [-0.48, 0.48]) {
        const t = new THREE.Mesh(tg, mats.rubber);
        t.position.set(dx, -len, 0);
        const h = new THREE.Mesh(hg, mats.hub);
        t.add(h);
        carrier.add(t);
        set.push(t);
      }
      const axle = new THREE.Mesh(strutGeo, mats.metal);
      axle.scale.set(0.5, nose ? 0.5 : 1.0, 0.5); axle.rotation.z = Math.PI / 2; axle.position.y = -len;
      carrier.add(axle);
      this.group.add(root);
      this.carriers.set(gear.index, carrier);
      this.wheels.set(gear.index, set[0]);
      this.wheelSets.set(gear.index, set);
      // nose gear folds forward (about x), mains inward (about z)
      this.legs.push({ index: gear.index, root, axis: nose ? 'x' : 'z', sign: nose ? 1 : -Math.sign(gear.contact.x), r: gear.r });
      if (nose) (this as { noseRoot: THREE.Group | null }).noseRoot = steer;
    };
    if (L.gear.nose) build(L.gear.nose, true);
    for (const m of L.gear.mains) build(m, false);
  }

  update(states: readonly GearState[], dt: number): void {
    for (const leg of this.legs) {
      const s = states[leg.index];
      if (!s) continue;
      const ext = Number.isFinite(s.extension) ? s.extension : 1;
      const fold = (1 - ext) * (leg.axis === 'x' ? 100 : 88) * D2R * leg.sign;
      if (leg.axis === 'x') leg.root.rotation.x = fold; else leg.root.rotation.z = fold;
      leg.root.visible = ext > 0.03;
      const carrier = this.carriers.get(leg.index)!;
      carrier.position.y = Math.min(0.5, Math.max(0, s.compressionM || 0));
      const spin = ((s.wheelSpeedMs || 0) / leg.r) * (dt > 0 ? dt : 0);
      for (const w of this.wheelSets.get(leg.index)!) w.rotation.x -= spin;
      if (this.noseRoot && leg.axis === 'x') this.noseRoot.rotation.y = -(s.steerRad || 0);
    }
  }

  carrierFor(index: number): THREE.Group | null { return this.carriers.get(index) ?? null; }
  wheelFor(index: number): THREE.Mesh | null { return this.wheels.get(index) ?? null; }
  dispose(): void { for (const g of this.geometries) g.dispose(); }
}

// ─────────────────────────────── cockpit ───────────────────────────────

/** Panel plane aspect: the airliner displays' 1536 × 640 canvas. */
const PANEL_ASPECT = 1536 / 640;

export class A320Cockpit implements CockpitAssembly {
  readonly group = new THREE.Group();
  readonly panelMesh: PanelMesh;
  readonly panelMeshG1000: PanelMesh;
  readonly yokeGroups: THREE.Group[] = [];
  private readonly levers: THREE.Group;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  constructor(L: A320Layout, profile: LoftProfile, mats: ModelMaterials) {
    this.group.name = 'cockpit';
    const E = L.eye;
    const grey = new THREE.MeshStandardMaterial({ color: 0x5f6873, roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide, emissive: new THREE.Color(0x14171c) });
    const dark = new THREE.MeshStandardMaterial({ color: 0x24282d, roughness: 0.8, metalness: 0.1, side: THREE.DoubleSide });
    const seatMat = new THREE.MeshStandardMaterial({ color: 0x3b4048, roughness: 0.9, metalness: 0 });
    this.materials.push(grey, dark, seatMat);
    // the cockpit sees the sky only through its windows (as the other cabins: CABIN_IBL_SHARE)
    applyIblScale(grey, 0.35); applyIblScale(dark, 0.12); applyIblScale(seatMat, 0.35);
    const add = (g: THREE.BufferGeometry, m: THREE.Material, name: string) => { this.geometries.push(g); const mesh = new THREE.Mesh(g, m); mesh.name = name; this.group.add(mesh); return mesh; };
    // lining: around the window band (below the sill, above the window tops) and the posts
    const z0 = -16.9, z1 = -12.3;
    const [ws, sw] = COCKPIT_WINDOWS;
    const a = windowT(profile, E.y, ws[0], ws[1]), b = windowT(profile, E.y, sw[0], sw[1]);
    const P = Math.PI;
    const lining = (z0_: number, z1_: number, t0: number, t1: number, m: THREE.Material, name: string) =>
      add(buildLoftPatch(profile, { z0: z0_, z1: z1_, t0, t1, offset: -0.05, inside: true }), m, name);
    // below the sill, all the way round the bottom (each segment at its window's sill)
    for (const [za, zb, tS] of [[z0, ws[0], a.tS], [ws[0], ws[1], a.tS], [ws[1], sw[0], b.tS], [sw[0], sw[1], b.tS], [sw[1], z1, b.tS]] as [number, number, number][]) {
      lining(za, zb, -tS, tS, grey, 'liningLower');
    }
    // nose ahead of the windscreen, roof from the windscreen top edge aft
    lining(z0, ws[0], a.tS, 2 * P - a.tS, dark, 'noseLining');
    lining(ws[1], z1, b.tT, 2 * P - b.tT, grey, 'liningUpper');
    // posts: windscreen centre post, windscreen / side window, behind the side windows
    lining(ws[0], ws[1], P - CENTRE_POST, P + CENTRE_POST, dark, 'post');
    for (const [za, zb] of [[ws[1], sw[0]], [sw[1], z1]] as [number, number][]) {
      lining(za, zb, b.tS, b.tT, dark, 'post');
      lining(za, zb, 2 * P - b.tT, 2 * P - b.tS, dark, 'post');
    }
    // inner glass (rain shader target)
    for (const w of cockpitPanes(profile, E.y)) add(buildLoftPatch(profile, { ...w, offset: -0.02, inside: true }), mats.glassInterior, 'glassInner');
    // rear bulkhead with the door
    const sec: LoftStation = { z: 0, width: 0, height: 0, yCenter: 0, n: 2 };
    profile.sectionAt(z1, sec);
    const wall = add(new THREE.CircleGeometry(1, 40), grey, 'bulkhead');
    wall.scale.set(sec.width / 2 - 0.05, sec.height / 2 - 0.05, 1); wall.position.set(0, sec.yCenter, z1 + 0.02); wall.rotation.y = Math.PI;
    const door = add(new THREE.PlaneGeometry(0.8, 1.9), dark, 'door');
    door.position.set(0, E.y - 0.45, z1 + 0.01); door.rotation.y = Math.PI;
    // floor
    const floor = add(new THREE.PlaneGeometry(3.2, 4.6), dark, 'floor');
    floor.rotation.x = -Math.PI / 2; floor.position.set(0, E.y - 1.12, (z1 + COCKPIT_WINDOWS[0][0]) / 2 + 0.3);

    // main instrument panel: tilted back, centred a little toward the captain
    const pw = 1.55, ph = pw / PANEL_ASPECT;
    const pz = E.z - 0.86, py = E.y - 0.58;
    this.panelMesh = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), mats.panel) as PanelMesh;
    this.panelMesh.name = 'panel';
    this.panelMesh.position.set(-0.2, py, pz);
    this.panelMesh.rotation.x = -0.2;
    this.group.add(this.panelMesh);
    this.panelMeshG1000 = new THREE.Mesh(new THREE.PlaneGeometry(0.01, 0.01), mats.panelG1000) as PanelMesh;
    this.panelMeshG1000.visible = false;
    this.group.add(this.panelMeshG1000);
    // panel surround and glareshield
    const surround = add(new THREE.BoxGeometry(2.7, ph + 0.18, 0.06), dark, 'panelFrame');
    surround.position.set(0, py - 0.01, pz - 0.04); surround.rotation.x = -0.2;
    const glare = add(new THREE.BoxGeometry(2.4, 0.05, 0.34), dark, 'glareshield');
    glare.position.set(0, py + ph / 2 + 0.03, pz - 0.14);
    // pedestal with the thrust levers
    const pedLen = E.z + 0.35 - (pz + 0.05);
    const ped = add(new THREE.BoxGeometry(0.42, 0.5, pedLen), dark, 'pedestal');
    ped.position.set(0, E.y - 1.2, pz + 0.05 + pedLen / 2);
    this.levers = new THREE.Group();
    this.levers.position.set(0, E.y - 0.95, E.z - 0.3);
    const leverGeo = new THREE.BoxGeometry(0.035, 0.24, 0.035); leverGeo.translate(0, 0.12, 0); this.geometries.push(leverGeo);
    const knobGeo = new THREE.BoxGeometry(0.07, 0.04, 0.05); this.geometries.push(knobGeo);
    for (const dx of [-0.06, 0.06]) {
      const l = new THREE.Mesh(leverGeo, mats.metal); l.position.x = dx;
      const k = new THREE.Mesh(knobGeo, mats.knobBlack); k.position.y = 0.24; l.add(k);
      this.levers.add(l);
    }
    this.group.add(this.levers);
    // side-sticks on the outboard consoles
    const stickGeo = new THREE.CylinderGeometry(0.018, 0.022, 0.16, 10); stickGeo.translate(0, 0.08, 0); this.geometries.push(stickGeo);
    const gripGeo = new THREE.CylinderGeometry(0.028, 0.024, 0.11, 10); gripGeo.translate(0, 0.2, 0); this.geometries.push(gripGeo);
    for (const x of [-1.05, 1.05]) {
      const cons = add(new THREE.BoxGeometry(0.32, 0.12, 0.9), dark, 'console');
      cons.position.set(x, E.y - 0.66, E.z + 0.05);
      const g = new THREE.Group();
      g.position.set(x, E.y - 0.6, E.z - 0.1);
      g.add(new THREE.Mesh(stickGeo, mats.knobBlack), new THREE.Mesh(gripGeo, mats.knobBlack));
      this.group.add(g);
      this.yokeGroups.push(g);
    }
    // seats
    for (const x of [-0.55, 0.55]) {
      const seat = add(new THREE.BoxGeometry(0.52, 0.12, 0.52), seatMat, 'seat');
      seat.position.set(x, E.y - 0.72, E.z + 0.25);
      const back = add(new THREE.BoxGeometry(0.52, 0.85, 0.12), seatMat, 'seatBack');
      back.position.set(x, E.y - 0.25, E.z + 0.55); back.rotation.x = -0.12;
    }
    // overhead panel
    const over = add(new THREE.BoxGeometry(1.1, 0.06, 1.0), dark, 'overhead');
    over.position.set(0, E.y + 0.55, E.z - 0.35); over.rotation.x = 0.35;
  }

  update(inputs: ControlInputs, _state?: AircraftState): void {
    const p = Number.isFinite(inputs.pitch) ? inputs.pitch : 0, r = Number.isFinite(inputs.roll) ? inputs.roll : 0;
    for (const g of this.yokeGroups) { g.rotation.x = p * 0.3; g.rotation.z = -r * 0.3; }
    const t = Number.isFinite(inputs.throttle) ? inputs.throttle : 0;
    this.levers.rotation.x = 0.3 - 0.9 * t;
  }

  setPanelLighting(daylight: number, panelLight: number): void {
    // the displays are self-lit: full brightness, dimmed a little at night with the panel lights off
    applyPanelLighting(this.panelMesh, this.panelMeshG1000, Math.max(daylight, 0.85), Math.max(panelLight, 0.85));
  }

  setPanelVariant(_v: PanelVariant): void { this.panelMesh.visible = true; this.panelMeshG1000.visible = false; }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.panelMesh.geometry.dispose();
    this.panelMeshG1000.geometry.dispose();
    for (const m of this.materials) m.dispose();
  }
}
