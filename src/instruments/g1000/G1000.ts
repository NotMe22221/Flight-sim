/**
 * G1000-style glass cockpit: one PFD and one MFD canvas (1024×768 design space each) that the
 * integrator wraps in `THREE.CanvasTexture`s. `update()` advances the instrument dynamics every
 * frame but redraws each display at most `pfdHz` / `mfdHz` times per second, and only when what
 * it shows changed (hash of the quantised readings, with a forced refresh every `maxIdleS`).
 * It returns true when a canvas changed: set `texture.needsUpdate` only then (see `changed`).
 */
import type { Airport, SimSnapshot } from '../../core/types';
import type { CanvasSurface, Ctx2D } from '../canvas';
import { OPAQUE_CTX, get2d, releaseSurface } from '../canvas';
import { C172S_VSPEEDS, type VSpeeds } from '../c172';
import { createCanvas } from '../panelTexture';
import type { ComState } from '../radioStack';
import { InstrumentModel } from '../readings';
import { snapMapRange, stepMapRange } from '../scales';
import { Signature } from '../signature';
import { mfdSignature, pfdSignature } from './displaySignature';
import { createHsiGeometry } from './hsi';
import type { WindOption } from './infoBoxes';
import { type MapAirport, type MapOrientation, MovingMap, clampMapRange, computeMapView } from './map';
import { type MfdState, drawMfd } from './mfd';
import { type BearingSource, resolveBearing, resolveCdi } from './navData';
import { type CdiSource, MFD, PFD } from './palette';
import { type PfdState, createPfdState, drawPfd } from './pfd';

export interface G1000Options {
  /** backing-store width of each display, px (default 1024) */
  width?: number;
  /** backing-store height of each display, px (default 768) */
  height?: number;
  /** canvas factory; defaults to `createCanvas` (DOM canvas, else OffscreenCanvas) */
  createCanvas?: (width: number, height: number) => CanvasSurface;
  /**
   * Share an `InstrumentModel` (e.g. with the steam panel). When given, the caller must call
   * `model.update()` each frame before `G1000.update()`; the G1000 then never steps it.
   */
  model?: InstrumentModel;
  vspeeds?: VSpeeds;
  /** PFD redraw cap, Hz (default 30) */
  pfdHz?: number;
  /** MFD redraw cap, Hz (default 15) */
  mfdHz?: number;
  /** skip redraws when nothing visible changed (default true) */
  skipUnchanged?: boolean;
  /** redraw at least this often even when nothing changed, s (default 1) */
  maxIdleS?: number;
  /** initial map range, nm (default 10) */
  rangeNm?: number;
}

/** Nearest-airport entry: a plain lat/lon record or a nav-database `Airport`. */
export type NearestAirportInput = MapAirport | Pick<Airport, 'icao' | 'position' | 'type'>;

const CDI_CYCLE: readonly CdiSource[] = ['GPS', 'NAV1', 'NAV2'];
const DUE_EPS_S = 5e-4;

export class G1000 {
  readonly pfdCanvas: CanvasSurface;
  readonly mfdCanvas: CanvasSurface;
  readonly model: InstrumentModel;
  readonly width: number;
  readonly height: number;
  /** Which display was redrawn by the last `update()`. */
  readonly changed = { pfd: false, mfd: false };
  /** Screen geometry of the HSI as last drawn (design units). */
  readonly hsiGeometry = createHsiGeometry();
  pfdHz: number;
  mfdHz: number;
  skipUnchanged: boolean;
  maxIdleS: number;
  readonly vspeeds: VSpeeds;

  private readonly pfdCtx: Ctx2D;
  private readonly mfdCtx: Ctx2D;
  private readonly ownsModel: boolean;
  private readonly pfd: PfdState = createPfdState();
  private readonly mfd: MfdState;
  private readonly map = new MovingMap();
  private readonly sig = new Signature();
  private pfdAcc = Infinity;
  private mfdAcc = Infinity;
  private pfdIdle = 0;
  private mfdIdle = 0;
  private lastPfdSig = -1;
  private lastMfdSig = -1;
  private version = 0;
  private disposed = false;

  constructor(options: G1000Options = {}) {
    this.width = Math.max(1, Math.round(options.width ?? PFD.width));
    this.height = Math.max(1, Math.round(options.height ?? PFD.height));
    const make = options.createCanvas ?? createCanvas;
    this.pfdCanvas = make(this.width, this.height);
    this.mfdCanvas = make(this.width, this.height);
    this.pfdCtx = get2d(this.pfdCanvas, OPAQUE_CTX);
    this.mfdCtx = get2d(this.mfdCanvas, OPAQUE_CTX);
    this.ownsModel = !options.model;
    this.model = options.model ?? new InstrumentModel();
    this.vspeeds = options.vspeeds ?? C172S_VSPEEDS;
    this.pfdHz = options.pfdHz ?? 30;
    this.mfdHz = options.mfdHz ?? 15;
    this.skipUnchanged = options.skipUnchanged ?? true;
    this.maxIdleS = options.maxIdleS ?? 1;
    this.mfd = {
      rangeNm: snapMapRange(clampMapRange(options.rangeNm ?? 10)), orientation: 'north-up', airports: [],
      cdiSource: this.pfd.cdiSource, com1: this.pfd.com1, com2: this.pfd.com2,
    };
  }

  /**
   * Advance by `dt` seconds and redraw what is due. Returns true when either canvas changed;
   * `changed.pfd` / `changed.mfd` tell which one.
   */
  update(s: SimSnapshot, dt: number): boolean {
    this.changed.pfd = false; this.changed.mfd = false;
    if (this.disposed) return false;
    const d = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 1) : 0;
    if (this.ownsModel) this.model.update(s, d);
    const r = this.model.readings;
    this.pfd.afcs.step(s.autopilot, d);
    this.pfdAcc += d; this.mfdAcc += d; this.pfdIdle += d; this.mfdIdle += d;

    const pfdPeriod = 1 / Math.max(this.pfdHz, 1e-3);
    if (this.pfdAcc + DUE_EPS_S >= pfdPeriod) {
      this.pfdAcc = Number.isFinite(this.pfdAcc) ? Math.min(this.pfdAcc - pfdPeriod, pfdPeriod) : 0;
      const mv = r.heading.magVarDeg, st = this.pfd;
      resolveCdi(s, st.cdiSource, mv, st.cdi);
      resolveBearing(s, st.brg1.source, mv, st.brg1);
      resolveBearing(s, st.brg2.source, mv, st.brg2);
      const sig = pfdSignature(this.sig, s, r, st);
      if (!this.skipUnchanged || sig !== this.lastPfdSig || this.pfdIdle >= this.maxIdleS) {
        this.scaleToDesign(this.pfdCtx, PFD.width, PFD.height);
        drawPfd(this.pfdCtx, s, r, st, this.vspeeds, this.hsiGeometry);
        this.lastPfdSig = sig; this.pfdIdle = 0; this.changed.pfd = true;
      }
    }
    const mfdPeriod = 1 / Math.max(this.mfdHz, 1e-3);
    if (this.mfdAcc + DUE_EPS_S >= mfdPeriod) {
      this.mfdAcc = Number.isFinite(this.mfdAcc) ? Math.min(this.mfdAcc - mfdPeriod, mfdPeriod) : 0;
      this.mfd.cdiSource = this.pfd.cdiSource;
      const view = computeMapView(this.mfd.rangeNm, this.mfd.orientation, 0, this.map.view);
      const sig = mfdSignature(this.sig, s, r, this.mfd, view.pxPerNm, this.version);
      if (!this.skipUnchanged || sig !== this.lastMfdSig || this.mfdIdle >= this.maxIdleS) {
        this.scaleToDesign(this.mfdCtx, MFD.width, MFD.height);
        drawMfd(this.mfdCtx, s, r, this.mfd, this.map);
        this.lastMfdSig = sig; this.mfdIdle = 0; this.changed.mfd = true;
      }
    }
    return this.changed.pfd || this.changed.mfd;
  }

  /** Airports drawn on the map (call every few seconds with the nav database's nearest list). */
  setNearestAirports(list: readonly NearestAirportInput[]): void {
    const out: MapAirport[] = [];
    for (const a of list) {
      if ('position' in a) out.push({ icao: a.icao, lat: a.position.lat, lon: a.position.lon, type: a.type });
      else out.push({ icao: a.icao, lat: a.lat, lon: a.lon, type: a.type });
    }
    this.mfd.airports = out;
    this.touch();
  }

  /** Map range (radius of the outer ring), snapped to the G1000 steps 0.5…2 000 nm. */
  setRange(nm: number): void { this.mfd.rangeNm = snapMapRange(clampMapRange(nm)); this.touch(); }
  get rangeNm(): number { return this.mfd.rangeNm; }
  /** Step the map range: +1 zooms out, −1 zooms in. */
  zoom(dir: 1 | -1): void { this.mfd.rangeNm = stepMapRange(this.mfd.rangeNm, dir); this.touch(); }

  setMapOrientation(o: MapOrientation): void { this.mfd.orientation = o; this.touch(); }
  get mapOrientation(): MapOrientation { return this.mfd.orientation; }

  /** Navigation source for the HSI course pointer / CDI (and the autopilot's NAV annunciation). */
  setCdiSource(src: CdiSource): void { this.pfd.cdiSource = src; this.mfd.cdiSource = src; this.touch(); }
  get cdiSource(): CdiSource { return this.pfd.cdiSource; }
  /** The PFD CDI softkey: GPS → NAV1 → NAV2 → GPS. */
  cycleCdiSource(): CdiSource {
    const i = CDI_CYCLE.indexOf(this.pfd.cdiSource);
    this.setCdiSource(CDI_CYCLE[(i + 1) % CDI_CYCLE.length]);
    return this.pfd.cdiSource;
  }

  /** Source of bearing pointer 1 (single line) or 2 (double line). */
  setBearingSource(which: 1 | 2, src: BearingSource): void {
    const b = which === 1 ? this.pfd.brg1 : this.pfd.brg2;
    b.source = src; b.label = src;
    this.touch();
  }

  setWindOption(o: WindOption): void { this.pfd.windOption = o; this.touch(); }
  setDmeSource(src: 'OFF' | 'NAV1' | 'NAV2'): void { this.pfd.dmeSource = src; this.touch(); }

  /** COM radios are not part of the SimSnapshot; mutate these from the radio UI. */
  get com1(): ComState { return this.pfd.com1; }
  get com2(): ComState { return this.pfd.com2; }
  get squawk(): number { return this.pfd.squawk; }
  set squawk(code: number) { this.pfd.squawk = code; }
  get xpdrMode(): string { return this.pfd.xpdrMode; }
  set xpdrMode(mode: string) { this.pfd.xpdrMode = mode; }

  /** PFD elapsed timer (TMR/REF). */
  startTimer(): void { this.model.startTimer(); }
  stopTimer(): void { this.model.stopTimer(); }
  resetTimer(): void { this.model.resetTimer(); }

  /** Flight reset: snap the instrument dynamics (when owned) and forget AFCS flash history. */
  reset(s: SimSnapshot): void {
    if (this.ownsModel) this.model.reset(s);
    this.pfd.afcs.reset();
    this.invalidate();
  }

  /** Redraw both displays on the next `update()` regardless of cadence and change detection. */
  invalidate(): void {
    this.pfdAcc = Infinity; this.mfdAcc = Infinity;
    this.lastPfdSig = -1; this.lastMfdSig = -1;
  }

  /** Release both canvases' backing stores; further updates return false. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    releaseSurface(this.pfdCanvas);
    releaseSurface(this.mfdCanvas);
  }

  private touch(): void { this.version = (this.version + 1) | 0; this.lastPfdSig = -1; this.lastMfdSig = -1; }

  private scaleToDesign(ctx: Ctx2D, designW: number, designH: number): void {
    ctx.setTransform(this.width / designW, 0, 0, this.height / designH, 0, 0);
  }
}
