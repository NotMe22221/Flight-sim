import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { cubModelConfig, resolveCubLayout, airfoilUpper, USA35B } from './cubLayout';
import { LoftProfile } from './loft';
import { planformPoint } from './airfoil';

const D2R = Math.PI / 180;

describe('cubModelConfig: the shared PA-18-150 airframe numbers', () => {
  const cfg = cubModelConfig();
  const g = cfg.geometry;
  const wheels = cfg.gear.filter((w) => w.type === 'wheel');
  const tail = wheels.find((w) => /tail/i.test(w.name))!;
  const mains = wheels.filter((w) => w !== tail);

  it('reference geometry (owner\'s handbook: span 35 ft 2.5 in, 178.5 ft², chord 63 in, length 22 ft 7 in)', () => {
    expect(cfg.airframe).toBe('cub');
    expect(g.b).toBeCloseTo(10.73, 2);
    expect(g.S).toBeCloseTo(16.58, 2);
    expect(g.cbar).toBeCloseTo(1.6, 2);
    expect(g.lengthM).toBeCloseTo(6.88, 2);
    expect(g.heightM).toBeCloseTo(2.04, 2);
    expect(g.eyePoint).toEqual([0.05, 0, -0.6]);
  });

  it('propeller: 74 in two-blade fixed pitch, hub (1.80, 0, −0.05), clockwise from the cockpit', () => {
    const p = cfg.propeller!;
    expect(p.diameterM).toBeCloseTo(1.88, 2);
    expect(p.blades).toBe(2);
    expect(p.sense).toBe(1);
    expect(p.fixedPitch).toBe(true);
    expect(p.position).toEqual([1.8, 0, -0.05]);
  });

  it('gear: 8.00-6 mains at (0.50, ±0.92, 1.12), tail wheel (−4.40, 0, 0.15), three-point ≈ 11°', () => {
    expect(mains).toHaveLength(2);
    for (const m of mains) {
      expect(m.pos[0]).toBeCloseTo(0.5, 3);
      expect(Math.abs(m.pos[1])).toBeCloseTo(0.92, 3);
      expect(m.pos[2]).toBeCloseTo(1.12, 3);
      expect(m.tyreRadius).toBeCloseTo(0.28, 3);
    }
    expect(tail.pos).toEqual([-4.4, 0, 0.15]);
    expect(tail.tyreRadius).toBeCloseTo(0.08, 3);
    const pitch = Math.atan2(mains[0].pos[2] - tail.pos[2], mains[0].pos[0] - tail.pos[0]);
    expect(pitch / D2R).toBeGreaterThan(10.5);
    expect(pitch / D2R).toBeLessThan(12);
  });

  it('two 18 US gal wing-root tanks at (−0.20, ±0.80, −1.00)', () => {
    expect(cfg.tanks).toHaveLength(2);
    for (const t of cfg.tanks!) {
      expect(t.capacityKg).toBeCloseTo(18 * 3.785411784 * 0.72, 0);
      expect(t.pos[0]).toBeCloseTo(-0.2, 3);
      expect(Math.abs(t.pos[1])).toBeCloseTo(0.8, 3);
    }
  });
});

describe('resolveCubLayout', () => {
  const cfg = cubModelConfig();
  const L = resolveCubLayout(cfg);
  const profile = new LoftProfile(L.fuselage.stations);

  it('maps the body FRD config points into the model frame (nose −Z, up +Y, right +X)', () => {
    expect(L.airframe).toBe('cub');
    expect(L.prop.hub.z).toBeCloseTo(-1.8, 3);
    expect(L.prop.hub.y).toBeCloseTo(0.05, 3);
    expect(L.prop.diameter).toBeCloseTo(1.88, 3);
    expect(L.eye.toArray()).toEqual([0, 0.6, -0.05].map((x) => expect.closeTo(x, 6)));
    expect(L.gear.nose).toBeNull();
    expect(L.gear.tail!.contact.toArray()).toEqual([0, -0.15, 4.4].map((x) => expect.closeTo(x, 6)));
    expect(L.gear.mains.map((m) => Math.sign(m.contact.x)).sort()).toEqual([-1, 1]);
    for (const m of L.gear.mains) {
      expect(m.contact.y).toBeCloseTo(-1.12, 6);
      expect(m.contact.z).toBeCloseTo(-0.5, 6);
      expect(m.tyreRadius).toBeCloseTo(0.28, 6);
    }
    // structure contacts (tail post) are not wheels
    expect(L.gear.mains).toHaveLength(2);
  });

  it('length 6.88 m: spinner tip at x +1.92, rudder trailing edge at x −4.96', () => {
    const sp = L.prop.spinner!;
    const spinnerTip = L.prop.hub.z + sp.baseZ - sp.length;
    expect(spinnerTip).toBeCloseTo(-1.92, 2);
    const rudderTE = Math.max(...L.rudder.sections.map((s) => s.le.z + s.chord));
    expect(rudderTE).toBeCloseTo(4.96, 2);
    expect(rudderTE - spinnerTip).toBeCloseTo(6.88, 2);
    // the cowl ring sits just behind the spinner base, the blades ahead of the cowl
    expect(profile.zMin).toBeGreaterThan(L.prop.hub.z + sp.baseZ);
    expect(profile.zMin - (L.prop.hub.z + (L.prop.bladeZ ?? 0))).toBeGreaterThan(0.05);
  });

  it('wing: constant 1.60 m chord on the roof (LE x +0.42, TE −1.18, chord plane z −1.02), 1° dihedral, rounded tips at the span', () => {
    const s = L.wing.sections;
    const root = s[0], tip = s[s.length - 1];
    expect(root.chord).toBeCloseTo(1.6, 6);
    expect(root.le.z).toBeCloseTo(-0.42, 6);
    expect(root.le.z + root.chord).toBeCloseTo(1.18, 6);
    expect(root.le.y - root.x * Math.tan(D2R)).toBeCloseTo(1.02, 6);
    expect(Math.atan2(tip.le.y - root.le.y, tip.x - root.x) / D2R).toBeCloseTo(1, 4);
    expect(tip.x).toBeCloseTo(cfg.geometry.b / 2, 6);
    // the tip bow: chord shrinks monotonically to a rounded end, outermost point near 40 % chord
    const bowSections = s.filter((q) => q.x >= L.wing.tipStartX - 1e-9);
    for (let i = 1; i < bowSections.length; i++) expect(bowSections[i].chord).toBeLessThan(bowSections[i - 1].chord + 1e-9);
    expect(tip.chord).toBeLessThan(0.3);
    expect((tip.le.z + tip.chord / 2 - root.le.z) / root.chord).toBeGreaterThan(0.3);
    expect((tip.le.z + tip.chord / 2 - root.le.z) / root.chord).toBeLessThan(0.5);
    // flaps inboard of the ailerons, both inside the straight part of the span
    expect(L.wing.flapSpan[1]).toBeLessThan(L.wing.aileronSpan[0]);
    expect(L.wing.aileronSpan[1]).toBeLessThan(L.wing.tipStartX);
    // the wing's flat bottom sits on the roof: no gap between the root rib and the cabin top
    const top = profile.sectionAt(0.3, { z: 0, width: 0, height: 0, yCenter: 0, n: 2 });
    expect(top.yCenter + top.height / 2).toBeCloseTo(L.cabin.roofY, 2);
  });

  it('V struts: front and rear spar struts from the lower longeron to ≈ 55 % semi-span; jury struts part-way', () => {
    const { front, rear } = L.struts;
    for (const [a, b] of [front, rear]) {
      expect(a.y).toBeLessThan(L.cabin.bellyY + 0.15);
      expect(Math.abs(a.x)).toBeLessThan(L.cabin.width / 2);
      expect(b.x / L.wing.halfSpan).toBeCloseTo(0.55, 2);
      expect(b.y).toBeGreaterThan(L.cabin.roofY);
    }
    // a V in the side view: the fittings converge on the fuselage and spread to the spars
    expect(Math.abs(front[0].z - rear[0].z)).toBeLessThan(Math.abs(front[1].z - rear[1].z) / 3);
    expect(front[1].z).toBeLessThan(rear[1].z);
    expect(L.struts.juryAt).toBeGreaterThan(0.4);
    expect(L.struts.juryAt).toBeLessThan(0.8);
  });

  it('tail: braced stabiliser on the tail post, rudder hinge behind the fuselage, tall fin', () => {
    expect(L.hstab.hingeZ).toBeLessThan(L.rudder.hingeZ);
    expect(profile.zMax).toBeLessThan(L.rudder.hingeZ);
    const finTop = L.fin.rootY + L.fin.sections[L.fin.sections.length - 1].x;
    const rudderTop = L.rudder.bottomY + L.rudder.sections[L.rudder.sections.length - 1].x;
    expect(rudderTop - L.hstab.stab[0].le.y).toBeGreaterThan(0.8); // ≈ 0.9 m above the stabiliser
    expect(Math.abs(rudderTop - finTop)).toBeLessThan(0.05);
    expect(L.wires).toHaveLength(4);
    // the elevator's inboard corner clears the rudder at 25° either way
    const e0 = L.hstab.elevator[0];
    const rudderXAt = (z: number) => (z - L.rudder.hingeZ) * Math.tan(25 * D2R) + 0.02;
    expect(e0.x).toBeGreaterThan(rudderXAt(e0.le.z + e0.chord));
  });

  it('three-point attitude ≈ 11° nose up with the CG ≈ 1.0 m above the ground', () => {
    expect(L.threePointPitchRad / D2R).toBeCloseTo(11.2, 0);
    expect(L.cgAglM).toBeGreaterThan(0.95);
    expect(L.cgAglM).toBeLessThan(1.05);
  });

  it('the eye is inside the cabin, behind the 2:1 panel and above the seat, centred (tandem)', () => {
    const e = L.eye, sec = profile.sectionAt(e.z, { z: 0, width: 0, height: 0, yCenter: 0, n: 2 });
    expect(Math.abs(e.x)).toBeLessThan(sec.width / 2 - 0.2);
    expect(e.y).toBeLessThan(sec.yCenter + sec.height / 2 - 0.3);
    expect(e.y - L.cabin.floorY).toBeGreaterThan(0.8);
    expect(e.z).toBeGreaterThan(L.fuselage.firewallZ + 0.5);
    expect(e.z).toBeLessThan(L.fuselage.cabinEndZ - 0.6);
    const P = L.panel;
    expect(P.width / P.height).toBeCloseTo(2, 6);
    expect(e.z - P.center.z).toBeGreaterThan(0.55);
    expect(e.z - P.center.z).toBeLessThan(0.85);
    const top = P.center.y + (P.height / 2) * Math.cos(P.tiltRad);
    expect(e.y - top).toBeGreaterThan(0.1);
    expect(e.y - top).toBeLessThan(0.25);
    expect(top).toBeLessThan(L.glareshield.lipY);
    const panelSec = profile.sectionAt(P.center.z, { z: 0, width: 0, height: 0, yCenter: 0, n: 2 });
    expect(P.width).toBeLessThan(panelSec.width - 0.08);
    expect(L.cockpit.seats.front.y).toBeLessThan(e.y - 0.7);
    expect(L.cockpit.frontStick.pivot.z).toBeLessThan(e.z);
    expect(L.cockpit.frontStick.pivot.z).toBeGreaterThan(P.center.z);
  });

  it('over the cowl: a few degrees down in flight, hidden by the nose in the three-point attitude', () => {
    // the deck at the windshield base is the highest obstruction ahead of the eye
    const e = L.eye;
    const down = Math.atan2(e.y - L.cabin.deckY, e.z - L.fuselage.cowlEndZ);
    expect(down / D2R).toBeGreaterThan(6);
    expect(down / D2R).toBeLessThan(L.threePointPitchRad / D2R); // horizon hidden on the ground
  });

  it('lights: red left tip, green right tip, white tail, beacon on the fin, landing light in the left wing leading edge', () => {
    const l = L.lights, h = L.wing.halfSpan;
    expect(l.navLeft.x).toBeLessThan(-(h - 0.3));
    expect(l.navRight.x).toBeGreaterThan(h - 0.3);
    expect(l.navTail.z).toBeGreaterThan(4.2);
    expect(l.beacon.y).toBeGreaterThan(L.fin.rootY + 0.9);
    expect(l.landing.x).toBeLessThan(0);
    expect(l.landing.z).toBeLessThan(L.wing.sections[0].le.z);
    expect(Math.abs(l.landing.y - planformPoint(L.wing.sections, -l.landing.x, 0, new THREE.Vector3()).y)).toBeLessThan(0.03);
  });

  it('gear placement: V legs from the lower longeron, axle at contact + radius, tail wheel swivel above the tyre', () => {
    for (const m of L.gear.mains) {
      const s = Math.sign(m.contact.x);
      for (const p of [m.attach, m.rearAttach]) {
        expect(Math.sign(p.x)).toBe(s);
        expect(Math.abs(p.x)).toBeLessThan(L.cabin.width / 2);
        expect(Math.abs(p.y - L.cabin.bellyY)).toBeLessThan(0.1);
      }
      expect(m.attach.z).toBeLessThan(m.contact.z);
      expect(m.rearAttach.z).toBeGreaterThan(m.contact.z);
      expect(m.axleHinge.y).toBeLessThan(L.cabin.bellyY);
    }
    const t = L.gear.tail!;
    expect(t.attach.y).toBeGreaterThan(t.contact.y + 2 * t.tyreRadius);
    expect(t.springRoot.z).toBeLessThan(t.attach.z);
    expect(t.casters).toBe(true);
    expect(t.maxSteerRad).toBeCloseTo(25 * D2R, 6);
  });

  it('fuel caps sit on the upper surface; every number is finite', () => {
    const f = (L.details.fuelCap.z - L.wing.sections[0].le.z) / 1.6;
    expect(L.details.fuelCap.y).toBeCloseTo(1.02 + 0.8 * Math.tan(D2R) + airfoilUpper(USA35B, f) * 1.6, 6);
    const bad: string[] = [];
    const walk = (o: unknown, path: string): void => {
      if (typeof o === 'number') { if (!Number.isFinite(o)) bad.push(path); return; }
      if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
    };
    walk(L, 'L');
    expect(bad).toEqual([]);
  });

  it('follows a moved eye point and gear contact from the config (the airframe stays put)', () => {
    const c2 = cubModelConfig();
    c2.geometry.eyePoint = [0.1, 0, -0.65];
    c2.gear[0].pos = [0.55, -0.95, 1.15];
    const L2 = resolveCubLayout(c2);
    expect(L2.eye.y).toBeCloseTo(0.65, 6);
    expect(L2.cockpit.seats.front.y).toBeCloseTo(L.cockpit.seats.front.y + 0.05, 6);
    expect(L2.gear.mains[0].contact.toArray()).toEqual([-0.95, -1.15, -0.55].map((x) => expect.closeTo(x, 6)));
    expect(L2.wing.sections[0].le.y).toBeCloseTo(L.wing.sections[0].le.y, 9);
    expect(L2.fuselage.stations[5].z).toBeCloseTo(L.fuselage.stations[5].z, 9);
  });
});
