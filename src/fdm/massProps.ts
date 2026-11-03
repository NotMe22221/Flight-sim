/** Composite mass, CG and inertia from the empty airframe, payload stations and fuel tanks. */
import type { AircraftConfig, Vec3 } from '../core/types';

export interface MassProperties {
  mass: number;
  /** CG relative to the empty CG, body axes, m */
  cg: Vec3;
  Ixx: number;
  Iyy: number;
  Izz: number;
  Ixz: number;
  /** inverse inertia tensor (row-major 3×3, Ixy = Iyz = 0) */
  inv: Float64Array;
}

/** Allocation-free: pass `out` to reuse it (the flight model recomputes this every step). */
export function computeMassProperties(cfg: AircraftConfig, stationKg: ArrayLike<number>, tankKg: ArrayLike<number>, out?: MassProperties): MassProperties {
  const m = cfg.mass;
  const ns = m.stations.length, nt = m.tanks.length;
  const ptM = (i: number) => (i < ns ? stationKg[i] ?? m.stations[i].massKg : tankKg[i - ns] ?? m.tanks[i - ns].contentsKg);
  const ptP = (i: number): Vec3 => (i < ns ? m.stations[i].pos : m.tanks[i - ns].pos);
  let mass = m.emptyMassKg;
  let cx = 0, cy = 0, cz = 0; // empty CG is the origin
  for (let i = 0; i < ns + nt; i++) { const pm = ptM(i), pp = ptP(i); mass += pm; cx += pm * pp[0]; cy += pm * pp[1]; cz += pm * pp[2]; }
  cx /= mass; cy /= mass; cz /= mass;
  // parallel-axis: empty inertia about its CG, shifted to the composite CG, plus point masses
  const e = m.emptyInertia;
  const me = m.emptyMassKg;
  let Ixx = e.Ixx + me * (cy * cy + cz * cz);
  let Iyy = e.Iyy + me * (cx * cx + cz * cz);
  let Izz = e.Izz + me * (cx * cx + cy * cy);
  let Ixz = e.Ixz + me * cx * cz; // Ixz defined as +∫xz dm with the tensor's −Ixz off-diagonal
  for (let i = 0; i < ns + nt; i++) {
    const pm = ptM(i), pp = ptP(i);
    const x = pp[0] - cx, y = pp[1] - cy, z = pp[2] - cz;
    Ixx += pm * (y * y + z * z);
    Iyy += pm * (x * x + z * z);
    Izz += pm * (x * x + y * y);
    Ixz += pm * x * z;
  }
  // tensor [[Ixx,0,−Ixz],[0,Iyy,0],[−Ixz,0,Izz]] → inverse
  const det = Ixx * Izz - Ixz * Ixz;
  const inv = out?.inv ?? new Float64Array(9);
  inv.fill(0);
  inv[0] = Izz / det; inv[2] = Ixz / det;
  inv[4] = 1 / Iyy;
  inv[6] = Ixz / det; inv[8] = Ixx / det;
  const res = out ?? { mass, cg: [cx, cy, cz] as Vec3, Ixx, Iyy, Izz, Ixz, inv };
  res.mass = mass; res.cg[0] = cx; res.cg[1] = cy; res.cg[2] = cz;
  res.Ixx = Ixx; res.Iyy = Iyy; res.Izz = Izz; res.Ixz = Ixz; res.inv = inv;
  return res;
}
