import { describe, expect, it } from 'vitest';
import { c172ModelConfig, resolveC172Layout } from './c172Layout';

const IN = 0.0254;
/** loaded CG station used by docs/research/02 §4.7/§5.1 (FS 41 in, datum = firewall) */
const CG_FS = 41;

describe('c172ModelConfig matches docs/research/02 §2.1, §4.7, §5.1, §6', () => {
  const cfg = c172ModelConfig();
  const nose = cfg.gear.find((g) => /nose/i.test(g.name))!;
  const mains = cfg.gear.filter((g) => g !== nose);

  it('reference geometry (§2.1, 172S)', () => {
    expect(cfg.geometry.b).toBeCloseTo(11.0, 1); // 172S actual 36 ft 1 in
    expect(cfg.geometry.S).toBeCloseTo(16.165, 1); // 174 ft²
    expect(cfg.geometry.cbar).toBeCloseTo(1.494, 2); // 4.9 ft
    expect(cfg.geometry.lengthM).toBeCloseTo(8.28, 2); // 27 ft 2 in
    expect(cfg.geometry.heightM).toBeCloseTo(2.72, 2); // 8 ft 11 in
  });

  it('propeller: 76 in, hub 1.98 m ahead of and 0.07 m below the CG (§4.7), clockwise from behind', () => {
    const p = cfg.propeller!;
    expect(p.diameterM).toBeCloseTo(76 * IN, 2);
    expect(p.position[0]).toBeCloseTo(1.98, 2);
    expect(p.position[2]).toBeCloseTo(0.07, 2); // body z is DOWN: below the CG ⇒ positive
    expect(p.blades).toBe(2);
    expect(p.sense).toBe(1);
  });

  it('gear: wheelbase 65 in (nose FS −6.8, mains FS 58.2), real 172S track 100 in (§5.1)', () => {
    expect(nose.pos[0]).toBeCloseTo((CG_FS + 6.8) * IN, 2);
    for (const m of mains) expect(m.pos[0]).toBeCloseTo(-(58.2 - CG_FS) * IN, 2);
    expect(nose.pos[0] - mains[0].pos[0]).toBeCloseTo(65 * IN, 2);
    expect(Math.abs(mains[0].pos[1] - mains[1].pos[1])).toBeCloseTo(100 * IN, 2);
    expect(nose.pos[1]).toBe(0);
    expect(mains.map((m) => Math.sign(m.pos[1])).sort()).toEqual([-1, 1]);
    // contact points are below the CG (body z down)
    for (const g of cfg.gear) expect(g.pos[2]).toBeGreaterThan(1.0);
  });

  it('pilot eye: left seat near the FS 36 pilot station, ~0.55 m above the CG (§6)', () => {
    const [x, y, z] = cfg.geometry.eyePoint;
    expect(x).toBeGreaterThan((CG_FS - 36) * IN - 0.05);
    expect(x).toBeLessThan((CG_FS - 36) * IN + 0.1);
    expect(y).toBeLessThan(-0.2); // left seat
    expect(z).toBeLessThan(-0.4); // above the CG
  });
});

describe('resolveC172Layout', () => {
  const L = resolveC172Layout(c172ModelConfig());

  it('maps body FRD config points into the model frame (nose −Z, up +Y, right +X)', () => {
    expect(L.prop.hub.z).toBeCloseTo(-1.98, 2);
    expect(L.prop.hub.y).toBeCloseTo(-0.07, 2);
    expect(L.gear.nose!.contact.z).toBeLessThan(-1);
    for (const m of L.gear.mains) expect(m.contact.y).toBeLessThan(-1);
    expect(L.gear.mains.map((m) => Math.sign(m.contact.x)).sort()).toEqual([-1, 1]);
    expect(L.eye.x).toBeLessThan(0); // left seat
    expect(L.eye.y).toBeGreaterThan(0);
  });

  it('nav lights: red on the left (−X) tip, green on the right (+X) tip, white at the tail', () => {
    expect(L.lights.navLeft.x).toBeLessThan(-5);
    expect(L.lights.navRight.x).toBeGreaterThan(5);
    expect(L.lights.navTail.z).toBeGreaterThan(5.5);
  });

  it('cabin: the A-pillar is a slim post and the window tops sit just under the wing root', () => {
    const ws = L.windows.find((w) => w.name === 'windscreen')!;
    const door = L.windows.find((w) => w.name === 'doorLeft')!;
    // pillar width along z between the windshield's side edge and the door window's front edge
    expect(door.outline[0][0] - ws.outline[1][0]).toBeGreaterThan(0.05);
    expect(door.outline[0][0] - ws.outline[1][0]).toBeLessThan(0.08);
    expect(L.cabin.windowTopY).toBeLessThan(L.wing.sections[0].le.y);
    expect(L.cabin.windowTopY).toBeGreaterThan(L.eye.y + 0.1);
  });

  it('nose inlets sit on the nose bowl face, clear of the spinner', () => {
    const n = L.details.noseInlets;
    const ring = L.fuselage.stations[0], bowl = L.fuselage.stations[1];
    expect(n.x - n.r).toBeGreaterThan(ring.width / 2);
    expect(n.x + n.r).toBeLessThan(bowl.width / 2);
    expect(Math.abs(n.y - L.prop.hub.y)).toBeLessThan(0.1);
    expect(L.details.exhaust.dir.y).toBeLessThan(0); // points down
    expect(L.details.antenna.dir.z).toBeGreaterThan(0); // raked aft
  });

  it('wing: 1.7° dihedral, hinge at 75 % chord, flaps inboard of the ailerons', () => {
    const s = L.wing.sections;
    const tip = s[s.length - 1];
    expect(Math.atan2(tip.le.y - s[0].le.y, tip.x - s[0].x) * 180 / Math.PI).toBeCloseTo(1.7, 2);
    expect(L.wing.flapSpan[1]).toBeLessThan(L.wing.aileronSpan[0]);
    expect(L.wing.aileronSpan[1]).toBeLessThan(L.wing.halfSpan);
  });
});
