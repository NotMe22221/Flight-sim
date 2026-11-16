/**
 * Taxi routing on OSM taxiway centre lines: a graph built from the scenery's `taxiline` pavement
 * (lon/lat polylines with a width and, where OSM has it, a name), A* routes, and the hold-short
 * point of a runway. Pure (no Three.js), in a flat local frame around the airport reference (east,
 * north metres) — exact enough over the few kilometres of an airport.
 *
 * Graph building: polyline vertices become nodes; vertices closer than `mergeM` are merged (the
 * same OSM node on both sides of a scenery tile border, ways that share a junction node); a line
 * end that stops within `snapM` of another taxiway's segment is joined to it with a new node there
 * (T junctions drawn without a shared node, ends cut by tile clipping).
 */

const D2R = Math.PI / 180;
const R = 6378137;

export interface TaxiLineInput { line: readonly number[]; /** [lon, lat, …] */ ref?: string; widthM?: number }

export interface TaxiNode { id: number; e: number; n: number; edges: number[] }
export interface TaxiEdge { id: number; a: number; b: number; lengthM: number; ref: string }

export interface TaxiRoute {
  /** points along the route, local metres [e, n] */
  points: [number, number][];
  /** geodetic points */
  geo: { lat: number; lon: number }[];
  lengthM: number;
  /** taxiway names in order, consecutive duplicates and unnamed pieces removed */
  via: string[];
}

export interface RunwayRef { threshold: { lat: number; lon: number }; end: { lat: number; lon: number }; widthM: number }

export class TaxiGraph {
  readonly nodes: TaxiNode[] = [];
  readonly edges: TaxiEdge[] = [];
  private readonly kx: number;
  private readonly ky = R * D2R;
  private grid = new Map<string, number[]>();

  constructor(readonly lat0: number, readonly lon0: number, lines: readonly TaxiLineInput[], private readonly mergeM = 2.5, snapM = 6) {
    this.kx = R * D2R * Math.cos(lat0 * D2R);
    const polylines: { pts: number[]; ref: string }[] = [];
    for (const l of lines) {
      const ids: number[] = [];
      for (let i = 0; i + 1 < l.line.length; i += 2) {
        const [e, n] = this.toLocal(l.line[i + 1], l.line[i]);
        const id = this.nodeAt(e, n);
        if (ids[ids.length - 1] !== id) ids.push(id);
      }
      if (ids.length >= 2) polylines.push({ pts: ids, ref: (l.ref ?? '').trim() });
    }
    for (const p of polylines) for (let i = 1; i < p.pts.length; i++) this.addEdge(p.pts[i - 1], p.pts[i], p.ref);
    // join dangling ends to a nearby segment of another taxiway (T junctions without a shared node)
    const ends = this.nodes.filter((nd) => nd.edges.length === 1).map((nd) => nd.id);
    for (const id of ends) {
      const nd = this.nodes[id];
      let best: { edge: TaxiEdge; t: number; d: number } | null = null;
      for (const ed of this.edges) {
        if (ed.a === id || ed.b === id) continue;
        const A = this.nodes[ed.a], B = this.nodes[ed.b];
        const dx = B.e - A.e, dy = B.n - A.n, L2 = dx * dx + dy * dy;
        if (L2 < 1e-6) continue;
        const t = Math.max(0, Math.min(1, ((nd.e - A.e) * dx + (nd.n - A.n) * dy) / L2));
        const d = Math.hypot(A.e + dx * t - nd.e, A.n + dy * t - nd.n);
        if (d < snapM && (!best || d < best.d)) best = { edge: ed, t, d };
      }
      if (!best) continue;
      const { edge, t } = best;
      if (t < 0.02 || t > 0.98) { this.addEdge(id, t < 0.5 ? edge.a : edge.b, edge.ref); continue; }
      // split the segment at the foot point and connect the end to it
      const A = this.nodes[edge.a], B = this.nodes[edge.b];
      const mid = this.newNode(A.e + (B.e - A.e) * t, A.n + (B.n - A.n) * t);
      const oldB = edge.b;
      this.detach(edge);
      edge.b = mid; edge.lengthM = this.dist(edge.a, mid);
      this.nodes[edge.a].edges.push(edge.id); this.nodes[mid].edges.push(edge.id);
      this.addEdge(mid, oldB, edge.ref);
      this.addEdge(id, mid, edge.ref);
    }
  }

  toLocal(lat: number, lon: number): [number, number] { return [(lon - this.lon0) * this.kx, (lat - this.lat0) * this.ky]; }
  toGeo(e: number, n: number): { lat: number; lon: number } { return { lat: this.lat0 + n / this.ky, lon: this.lon0 + e / this.kx }; }

  /** Nearest point on any edge to a geodetic position: the edge, the parameter along it and the distance. */
  nearestEdge(lat: number, lon: number): { edge: TaxiEdge; t: number; d: number; e: number; n: number } | null {
    const [pe, pn] = this.toLocal(lat, lon);
    let best: { edge: TaxiEdge; t: number; d: number; e: number; n: number } | null = null;
    for (const ed of this.edges) {
      const A = this.nodes[ed.a], B = this.nodes[ed.b];
      const dx = B.e - A.e, dy = B.n - A.n, L2 = dx * dx + dy * dy || 1e-9;
      const t = Math.max(0, Math.min(1, ((pe - A.e) * dx + (pn - A.n) * dy) / L2));
      const e = A.e + dx * t, n = A.n + dy * t, d = Math.hypot(e - pe, n - pn);
      if (!best || d < best.d) best = { edge: ed, t, d, e, n };
    }
    return best;
  }

  /**
   * The hold-short node for departing on a runway end: a graph node 25-150 m from the runway's
   * centre line (beside it, not on it), as close to the threshold as possible, preferring the
   * runway's start (a full-length departure). Null when no taxiway reaches that runway.
   */
  holdShort(rwy: RunwayRef): TaxiNode | null {
    const [te, tn] = this.toLocal(rwy.threshold.lat, rwy.threshold.lon);
    const [ee, en] = this.toLocal(rwy.end.lat, rwy.end.lon);
    const L = Math.hypot(ee - te, en - tn) || 1;
    const ux = (ee - te) / L, uy = (en - tn) / L;
    const minLat = rwy.widthM / 2 + 15, maxLat = rwy.widthM / 2 + 150;
    let best: TaxiNode | null = null, bestCost = Infinity;
    for (const nd of this.nodes) {
      if (!nd.edges.length) continue;
      const rx = nd.e - te, ry = nd.n - tn;
      const along = rx * ux + ry * uy, lat = Math.abs(-rx * uy + ry * ux);
      if (lat < minLat || lat > maxLat || along < -150 || along > L * 0.5) continue;
      // close to the threshold first, then close to the runway edge
      const cost = Math.abs(along) + 0.5 * (lat - minLat);
      if (cost < bestCost) { bestCost = cost; best = nd; }
    }
    return best;
  }

  /**
   * A* route from a geodetic position to a node. The aircraft joins the nearest taxiway centre line
   * within `joinM` (aprons have no centre lines: from a stand the first leg crosses the apron); the
   * route starts at the aircraft.
   */
  route(fromLat: number, fromLon: number, to: TaxiNode, joinM = 600): TaxiRoute | null {
    const start = this.nearestEdge(fromLat, fromLon);
    if (!start || start.d > joinM) return null;
    const goal = to.id;
    const N = this.nodes.length;
    const g = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), prevEdge = new Int32Array(N).fill(-1);
    const open: number[] = [];
    const h = (id: number) => Math.hypot(this.nodes[id].e - to.e, this.nodes[id].n - to.n);
    // the join point sits on start.edge: both of its ends are reachable
    for (const end of [start.edge.a, start.edge.b]) {
      const c = Math.hypot(this.nodes[end].e - start.e, this.nodes[end].n - start.n);
      if (c < g[end]) { g[end] = c; prevEdge[end] = start.edge.id; open.push(end); }
    }
    const closed = new Uint8Array(N);
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (g[open[i]] + h(open[i]) < g[open[bi]] + h(open[bi])) bi = i;
      const cur = open.splice(bi, 1)[0];
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (cur === goal) break;
      for (const eid of this.nodes[cur].edges) {
        const ed = this.edges[eid];
        const nb = ed.a === cur ? ed.b : ed.a;
        const c = g[cur] + ed.lengthM;
        if (c < g[nb]) { g[nb] = c; prev[nb] = cur; prevEdge[nb] = eid; open.push(nb); }
      }
    }
    if (!Number.isFinite(g[goal])) return null;
    const ids: number[] = [], eds: number[] = [];
    for (let c = goal; c !== -1; c = prev[c]) { ids.push(c); eds.push(prevEdge[c]); }
    ids.reverse(); eds.reverse();
    const [pe, pn] = this.toLocal(fromLat, fromLon);
    const points: [number, number][] = [[pe, pn], [start.e, start.n], ...ids.map((id) => [this.nodes[id].e, this.nodes[id].n] as [number, number])];
    const via: string[] = [];
    for (const eid of eds) {
      const ref = eid >= 0 ? this.edges[eid].ref : '';
      if (ref && via[via.length - 1] !== ref) via.push(ref);
    }
    return { points, geo: points.map(([e, n]) => this.toGeo(e, n)), lengthM: g[goal] + start.d, via };
  }

  private dist(a: number, b: number): number { return Math.hypot(this.nodes[a].e - this.nodes[b].e, this.nodes[a].n - this.nodes[b].n); }
  private newNode(e: number, n: number): number {
    const id = this.nodes.length;
    this.nodes.push({ id, e, n, edges: [] });
    const k = `${Math.floor(e / this.mergeM)},${Math.floor(n / this.mergeM)}`;
    (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(id);
    return id;
  }
  private nodeAt(e: number, n: number): number {
    const cx = Math.floor(e / this.mergeM), cy = Math.floor(n / this.mergeM);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const id of this.grid.get(`${cx + dx},${cy + dy}`) ?? []) if (Math.hypot(this.nodes[id].e - e, this.nodes[id].n - n) < this.mergeM) return id;
    }
    return this.newNode(e, n);
  }
  private addEdge(a: number, b: number, ref: string): void {
    if (a === b || this.nodes[a].edges.some((eid) => { const x = this.edges[eid]; return (x.a === b || x.b === b); })) return;
    const id = this.edges.length;
    this.edges.push({ id, a, b, lengthM: this.dist(a, b), ref });
    this.nodes[a].edges.push(id); this.nodes[b].edges.push(id);
  }
  private detach(ed: TaxiEdge): void {
    for (const nid of [ed.a, ed.b]) { const l = this.nodes[nid].edges; const i = l.indexOf(ed.id); if (i >= 0) l.splice(i, 1); }
  }
}
