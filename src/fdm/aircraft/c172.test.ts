import { describe, expect, it } from 'vitest';
import { Table1D, Table2D } from '../../core/math';
import { C172S, fromStructural } from './c172';

describe('C172S config', () => {
  it('reference geometry and mass', () => {
    expect(C172S.geometry.S).toBeCloseTo(16.165, 3);
    expect(C172S.geometry.b).toBeCloseTo(10.912, 2);
    expect(C172S.geometry.cbar).toBeCloseTo(1.4935, 3);
    expect(C172S.mass.maxTakeoffKg).toBeCloseTo(1156.7, 0);
  });
  it('structural → body conversion: forward is +x, up is −z, relative to FS 41 / WL 36.5', () => {
    const prop = fromStructural(-37.7, 0, 26.6);
    expect(prop[0]).toBeCloseTo(1.999, 3);
    expect(prop[2]).toBeCloseTo(0.2515, 3);
    const arp = C172S.geometry.arpOffset;
    expect(arp[0]).toBeCloseTo(-0.0559, 3);
    expect(arp[2]).toBeCloseTo(-0.5817, 3);
    const [nose, left, right] = C172S.gear;
    expect(nose.pos[0]).toBeGreaterThan(1.2);
    expect(left.pos[1]).toBeCloseTo(-1.27, 3);
    expect(right.pos[1]).toBeCloseTo(1.27, 3);
    expect(left.pos[2]).toBeCloseTo(1.3208, 3);
  });
  it('tables are well-formed and hold the published values', () => {
    const cl = C172S.aero.CL.table;
    const t = new Table2D(cl.rows, cl.cols, cl.data);
    expect(t.at(0, 0)).toBeCloseTo(0.25, 6);
    expect(t.at(0.28, 0)).toBeCloseTo(1.57, 6);
    expect(t.at(0.2, 1)).toBeLessThan(t.at(0.2, 0));
    const cd = C172S.aero.CD.alphaFlapTable;
    const td = new Table2D(cd.rows, cd.cols, cd.data);
    expect(td.at(0, 0)).toBeCloseTo(0.0052, 6);
    expect(td.at(0, 30)).toBeCloseTo(0.0299, 6);
    const ct = new Table1D(C172S.propulsion.propeller!.Ct.xs, C172S.propulsion.propeller!.Ct.ys);
    expect(ct.at(0)).toBe(0.104);
    for (const spec of [C172S.aero.CL.dFlap, C172S.aero.CD.dFlap, C172S.aero.Cm.dFlap, C172S.aero.Cm.highAlphaScale]) {
      for (let i = 1; i < spec.xs.length; i++) expect(spec.xs[i]).toBeGreaterThan(spec.xs[i - 1]);
    }
    for (let i = 1; i < cd.rows.length; i++) expect(cd.rows[i]).toBeGreaterThan(cd.rows[i - 1]);
  });
});
