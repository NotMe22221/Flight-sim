/**
 * Ground queries in the floating-origin NED frame, consistent with the curved tile meshes
 * (docs/research/03 §4.3, §8): the ground point under a NED position is found along the
 * frame's own vertical by sampling the DEM at the point's geodetic position and converting
 * the ground point back to NED. Allocation-free; no Three.js.
 */
import type { Geodetic, Vec3 } from '../core/types';
import { ecefToGeodetic, type LocalFrame } from '../geo/wgs84';
import type { HeightField } from './heightfield';

const D2R = Math.PI / 180;

export class GroundQueries {
  private readonly geo: Geodetic = { lat: 0, lon: 0, alt: 0 };
  private readonly ecef: Vec3 = [0, 0, 0];
  private readonly ned: Vec3 = [0, 0, 0];
  private readonly enu: Vec3 = [0, 0, 0];

  constructor(private readonly heights: HeightField) {}

  /** Geodetic position of NED (north, east, down) in `frame`, written to the shared scratch. */
  private geodeticOf(frame: LocalFrame, north: number, east: number, down: number): Geodetic {
    const p = frame.nedToEcef(north, east, down, this.ecef);
    return ecefToGeodetic(p[0], p[1], p[2], this.geo);
  }

  /**
   * Local up coordinate (−D) of the ground under NED (north, east), or null when no tile
   * covers the point. Iterates along the frame's vertical: the geodetic normal at the point
   * differs from the frame's down by distance/R, so each step moves the sample by
   * |Δd|·sin(angle); two to three steps converge to < 1 mm.
   */
  groundUp(frame: LocalFrame, north: number, east: number): number | null {
    let d = 0;
    for (let it = 0; it < 4; it++) {
      const g = this.geodeticOf(frame, north, east, d);
      const h = this.heights.heightAt(g.lon, g.lat);
      if (h === null) return null;
      frame.geodeticToNED(g.lat, g.lon, h, this.ned);
      const dNew = this.ned[2];
      const done = Math.abs(dNew - d) < 1e-3;
      d = dNew;
      if (done) break;
    }
    return -d;
  }

  /**
   * Unit ground normal in the frame's NED axes under (north, east) — a flat surface at the
   * origin gives [0, 0, −1] — or null when no tile covers the point.
   */
  groundNormal(frame: LocalFrame, north: number, east: number, out: Vec3): Vec3 | null {
    const up = this.groundUp(frame, north, east);
    const g = this.geodeticOf(frame, north, east, up === null ? 0 : -up);
    const n = this.heights.normalENU(g.lon, g.lat, this.enu);
    if (!n) return null;
    const la = g.lat * D2R, lo = g.lon * D2R;
    const sl = Math.sin(la), cl = Math.cos(la), so = Math.sin(lo), co = Math.cos(lo);
    // point-local ENU → ECEF
    const vx = -so * n[0] - sl * co * n[1] + cl * co * n[2];
    const vy = co * n[0] - sl * so * n[1] + cl * so * n[2];
    const vz = cl * n[1] + sl * n[2];
    // ECEF → frame NED
    const nN = frame.north[0] * vx + frame.north[1] * vy + frame.north[2] * vz;
    const nE = frame.east[0] * vx + frame.east[1] * vy + frame.east[2] * vz;
    const nD = -(frame.up[0] * vx + frame.up[1] * vy + frame.up[2] * vz);
    const len = Math.hypot(nN, nE, nD) || 1;
    out[0] = nN / len; out[1] = nE / len; out[2] = nD / len;
    return out;
  }
}
