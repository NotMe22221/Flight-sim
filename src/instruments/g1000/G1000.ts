/**
 * G1000-style glass cockpit: one PFD and one MFD canvas that the integrator wraps in
 * `THREE.CanvasTexture`s. Each canvas holds a GDU bezel (softkeys, keys, knobs; `bezel: false`
 * leaves the bare 1024×768 screen) around a 1024×768 design-space screen. `update()` advances the
 * instrument dynamics every frame but redraws each display at most `pfdHz` / `mfdHz` times per
 * second, and only when what it shows changed (hash of the quantised readings and the UI state,
 * with a forced refresh every `maxIdleS`). It returns true when a canvas changed: set
 * `texture.needsUpdate` only then (see `changed`).
 *
 * Interaction (G1000 NXi): `handleInput()` takes softkey / key / knob / wheel / character inputs;
 * `bezelHitRegions` + `hitTest()` / `click()` / `wheel()` / `hover()` map canvas pixels onto the
 * bezel controls. Flight-plan edits go through the `planner` option (a `FlightPlanner`); radio,
 * autopilot, altimeter and transponder changes are requests delivered to `onCommand` (or queued
 * for `takeCommands()`).
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
import { BEZEL, type BezelControl, type BezelHit, type HitRegion, bezelRegions, controlInfo, controlKey, drawBezel, hitTest } from './bezel';
import { mfdSignature, pfdSignature } from './displaySignature';
import { G1000Fms, MFD_GROUPS } from './fms';
import type { G1000NavDb, G1000Planner, WindowDrawData } from './fmsCore';
import { createHsiGeometry } from './hsi';
import type { WindOption } from './infoBoxes';
import { type G1000Command, type G1000Display, type G1000Input, DUAL_KNOBS } from './input';
import { type MapAirport, type MapOrientation, MovingMap, clampMapRange, computeMapView, createMapView } from './map';
import { MFD_MAP_FULL, MFD_MAP_NARROW, MFD_SOFTKEYS, type MfdOverlays, type MfdState, drawMfd } from './mfd';
import { type BearingSource, resolveBearing, resolveCdi } from './navData';
import { type CdiSource, MFD, PFD } from './palette';
import { PFD_INSET, type PfdOverlays, type PfdState, createPfdState, drawPfd } from './pfd';

export interface G1000Options {
  /** backing-store width of each screen, px (default 1024); the canvas adds the bezel */
  width?: number;
  /** backing-store height of each screen, px (default 768) */
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
  /** draw the GDU bezel around each screen (default true): canvases become 1344×1008 per 1024×768 screen */
  bezel?: boolean;
  /** navigation database for D→, NRST and PROC (the simulator's `NavDb`) */
  nav?: G1000NavDb | null;
  /** flight planner edited by the FPL page, D→ and PROC (the simulator's `FlightPlanner`) */
  planner?: G1000Planner | null;
  /** receives radio / autopilot / altimeter / transponder requests; without it they queue for `takeCommands()` */
  onCommand?: (c: G1000Command) => void;
}

/** Nearest-airport entry: a plain lat/lon record or a nav-database `Airport`. */
export type NearestAirportInput = MapAirport | Pick<Airport, 'icao' | 'position' | 'type'>;

const DUE_EPS_S = 5e-4;
/** Commands kept when nobody drains the queue. */
const MAX_QUEUED_COMMANDS = 256;

export class G1000 {
  readonly pfdCanvas: CanvasSurface;
  readonly mfdCanvas: CanvasSurface;
  readonly model: InstrumentModel;
  /** screen backing-store size, px */
  readonly width: number;
  readonly height: number;
  /** whether the canvases include the bezel */
  readonly bezel: boolean;
  /** where the screen sits inside each canvas, canvas px */
  readonly screenRect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  /** clickable bezel controls of each canvas, canvas px (see `hitTest`) */
  readonly bezelHitRegions: { readonly pfd: readonly HitRegion[]; readonly mfd: readonly HitRegion[] };
  /** the interactive layer (pages, windows, softkey menus) */
  readonly fms: G1000Fms;
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
  private readonly insetMap = new MovingMap();
  private readonly tmpView = createMapView();
  private readonly sig = new Signature();
  private readonly commands: G1000Command[] = [];
  private readonly onCommand: ((c: G1000Command) => void) | null;
  private readonly hoverCtl: { pfd: BezelControl | null; mfd: BezelControl | null } = { pfd: null, mfd: null };
  private readonly bezelDirty = { pfd: true, mfd: true };
  private readonly pfdOv: PfdOverlays;
  private readonly mfdOv: MfdOverlays;
  private readonly unit: { x: number; y: number };
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
    this.bezel = options.bezel ?? true;
    const sx = this.width / PFD.width, sy = this.height / PFD.height;
    const cw = this.bezel ? Math.round(BEZEL.width * sx) : this.width, ch = this.bezel ? Math.round(BEZEL.height * sy) : this.height;
    this.unit = { x: cw / (this.bezel ? BEZEL.width : PFD.width), y: ch / (this.bezel ? BEZEL.height : PFD.height) };
    this.screenRect = Object.freeze(this.bezel
      ? { x: BEZEL.screenX * this.unit.x, y: BEZEL.screenY * this.unit.y, w: PFD.width * this.unit.x, h: PFD.height * this.unit.y }
      : { x: 0, y: 0, w: cw, h: ch });
    const make = options.createCanvas ?? createCanvas;
    this.pfdCanvas = make(cw, ch);
    this.mfdCanvas = make(cw, ch);
    this.pfdCtx = get2d(this.pfdCanvas, OPAQUE_CTX);
    this.mfdCtx = get2d(this.mfdCanvas, OPAQUE_CTX);
    const regions = Object.freeze(bezelRegions(cw, ch, this.bezel));
    this.bezelHitRegions = Object.freeze({ pfd: regions, mfd: regions });
    this.ownsModel = !options.model;
    this.model = options.model ?? new InstrumentModel();
    this.vspeeds = options.vspeeds ?? C172S_VSPEEDS;
    this.pfdHz = options.pfdHz ?? 30;
    this.mfdHz = options.mfdHz ?? 15;
    this.skipUnchanged = options.skipUnchanged ?? true;
    this.maxIdleS = options.maxIdleS ?? 1;
    this.onCommand = options.onCommand ?? null;
    this.mfd = {
      rangeNm: snapMapRange(clampMapRange(options.rangeNm ?? 10)), orientation: 'north-up', airports: [],
      cdiSource: this.pfd.cdiSource, com1: this.pfd.com1, com2: this.pfd.com2,
      declutter: 0, softkeys: [...MFD_SOFTKEYS], softkeyMask: 0, title: 'MAP - NAVIGATION MAP',
    };
    this.fms = new G1000Fms({
      pfd: this.pfd, mfd: this.mfd, timer: this.model, nav: options.nav ?? null, planner: options.planner ?? null,
      emit: (c) => this.deliver(c), onChange: () => this.touch(),
    });
    const r = this.model.readings;
    const pfdData: WindowDrawData = { ctx: this.fms, r, compact: true }, mfdData: WindowDrawData = { ctx: this.fms, r, compact: false };
    this.pfdOv = { windows: this.fms.pfdWindows, data: pfdData, insetMap: this.insetMap, airports: this.mfd.airports };
    this.mfdOv = { page: null, popups: this.fms.mfdPopups, data: mfdData, groups: MFD_GROUPS, group: 0, pageIndex: 0 };
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
    this.fms.update(s, r, d);
    this.pfdAcc += d; this.mfdAcc += d; this.pfdIdle += d; this.mfdIdle += d;
    const g = s.aircraft.geo;

    const pfdPeriod = 1 / Math.max(this.pfdHz, 1e-3);
    if (this.pfdAcc + DUE_EPS_S >= pfdPeriod || this.bezelDirty.pfd) {
      this.pfdAcc = Number.isFinite(this.pfdAcc) ? Math.min(Math.max(this.pfdAcc - pfdPeriod, 0), pfdPeriod) : 0;
      const mv = r.heading.magVarDeg, st = this.pfd;
      resolveCdi(s, st.cdiSource, mv, st.cdi);
      resolveBearing(s, st.brg1.source, mv, st.brg1);
      resolveBearing(s, st.brg2.source, mv, st.brg2);
      pfdSignature(this.sig, s, r, st);
      this.sig.num(this.fms.version).num(this.version);
      if (this.fms.liveOn('pfd')) this.sig.num(g.lat, 8e-4).num(g.lon, 8e-4).num(r.gsKt, 1);
      if (st.insetOn) {
        const q = 0.5 / (Math.max(computeMapView(st.insetRangeNm, 'heading-up', 0, this.tmpView, PFD_INSET).pxPerNm, 1e-6) * 60);
        this.sig.num(g.lat, q).num(g.lon, q).num(s.aircraft.headingTrueRad, 0.008);
      }
      const sig = this.sig.value;
      if (!this.skipUnchanged || sig !== this.lastPfdSig || this.pfdIdle >= this.maxIdleS || this.bezelDirty.pfd) {
        if (this.bezelDirty.pfd) this.paintBezel(this.pfdCtx, 'pfd');
        this.toScreen(this.pfdCtx);
        this.pfdOv.airports = this.mfd.airports;
        drawPfd(this.pfdCtx, s, r, st, this.vspeeds, this.hsiGeometry, this.pfdOv);
        this.pfdCtx.restore();
        this.lastPfdSig = sig; this.pfdIdle = 0; this.changed.pfd = true;
      }
    }
    const mfdPeriod = 1 / Math.max(this.mfdHz, 1e-3);
    if (this.mfdAcc + DUE_EPS_S >= mfdPeriod || this.bezelDirty.mfd) {
      this.mfdAcc = Number.isFinite(this.mfdAcc) ? Math.min(Math.max(this.mfdAcc - mfdPeriod, 0), mfdPeriod) : 0;
      this.mfd.cdiSource = this.pfd.cdiSource;
      const page = this.fms.mfdPage();
      const view = computeMapView(this.mfd.rangeNm, this.mfd.orientation, 0, this.map.view, page ? MFD_MAP_NARROW : MFD_MAP_FULL);
      mfdSignature(this.sig, s, r, this.mfd, view.pxPerNm, this.version);
      this.sig.num(this.fms.version);
      if (this.fms.liveOn('mfd')) this.sig.num(g.lat, 8e-4).num(g.lon, 8e-4).num(r.gsKt, 1).num(s.plan ? s.plan.distanceToActiveM : 0, 100);
      const sig = this.sig.value;
      if (!this.skipUnchanged || sig !== this.lastMfdSig || this.mfdIdle >= this.maxIdleS || this.bezelDirty.mfd) {
        if (this.bezelDirty.mfd) this.paintBezel(this.mfdCtx, 'mfd');
        this.toScreen(this.mfdCtx);
        const ov = this.mfdOv;
        ov.page = page; ov.group = this.fms.mfdGroup; ov.pageIndex = this.fms.mfdPageIndex;
        drawMfd(this.mfdCtx, s, r, this.mfd, this.map, ov);
        this.mfdCtx.restore();
        this.lastMfdSig = sig; this.mfdIdle = 0; this.changed.mfd = true;
      }
    }
    return this.changed.pfd || this.changed.mfd;
  }

  // ───────────────────────────── interaction ─────────────────────────────

  /** Apply one input (softkey, key, knob turn / push, wheel, typed character). True when it did something. */
  handleInput(e: G1000Input): boolean { return this.fms.handle(e); }

  /** The bezel control under canvas point (x, y) of `display`, or null. */
  hitTest(display: G1000Display, x: number, y: number): BezelHit | null {
    return hitTest(display === 'pfd' ? this.bezelHitRegions.pfd : this.bezelHitRegions.mfd, x, y);
  }

  /** A click at canvas point (x, y): presses the softkey / key, or pushes the knob. */
  click(display: G1000Display, x: number, y: number): boolean {
    const h = this.hitTest(display, x, y);
    if (!h) return false;
    const c = h.control;
    if (c.kind === 'softkey') return this.handleInput({ type: 'softkey', display, index: c.index }) || true;
    if (c.kind === 'button') return this.handleInput({ type: 'button', display, id: c.id }) || true;
    return this.handleInput({ type: 'push', display, id: c.id }) || true;
  }

  /**
   * A wheel event at canvas point (x, y): turns the knob under it (the ring under the pointer;
   * `outer` forces the outer ring, e.g. with Shift held). True when a knob was hit (consume the event).
   */
  wheel(display: G1000Display, x: number, y: number, deltaY: number, opts: { deltaMode?: number; outer?: boolean } = {}): boolean {
    const h = this.hitTest(display, x, y);
    if (!h || h.control.kind !== 'knob') return false;
    const id = h.control.id;
    const ring = opts.outer && DUAL_KNOBS.has(id) ? 'outer' : h.ring;
    this.handleInput({ type: 'wheel', display, id, ring, deltaY, deltaMode: opts.deltaMode ?? 0 });
    return true;
  }

  /**
   * Hover feedback: highlights the control under (x, y) on the bezel and returns its tooltip, or
   * null (and clears the highlight) when there is none. Pass NaN to clear.
   */
  hover(display: G1000Display, x: number, y: number): { title: string; hint: string; control: BezelControl } | null {
    const h = Number.isFinite(x) && Number.isFinite(y) ? this.hitTest(display, x, y) : null;
    const c = h ? h.control : null, prev = this.hoverCtl[display];
    if ((c ? controlKey(c) : '') !== (prev ? controlKey(prev) : '')) {
      this.hoverCtl[display] = c;
      if (this.bezel) this.bezelDirty[display] = true;
    }
    if (!c) return null;
    const label = c.kind === 'softkey' ? (display === 'pfd' ? this.pfd.softkeys : this.mfd.softkeys)[c.index] ?? '' : '';
    return { ...controlInfo(c, label), control: c };
  }

  /** True while a window or page cursor is active: route keys through `keyboard()` (it returns false for keys it does not use). */
  get wantsKeyboard(): boolean { return this.fms.wantsKeyboard; }

  /**
   * A `KeyboardEvent.key` for the open window: Enter = ENT, Escape = CLR; letters, digits and
   * Backspace spell an ident where a field accepts typing. Returns false for keys it did not use
   * (let them through to the simulator's bindings).
   */
  keyboard(key: string, display?: G1000Display): boolean {
    const d = display ?? this.fms.keyDisplay();
    if (!d) return false;
    if (key === 'Enter') return this.handleInput({ type: 'button', display: d, id: 'ENT' });
    if (key === 'Escape') return this.handleInput({ type: 'button', display: d, id: 'CLR' });
    const typing = key === 'Backspace' || (key.length === 1 && /[a-z0-9]/i.test(key));
    if (!typing) return false;
    const ed = display ?? this.fms.editingDisplay();
    if (!ed) return false;
    return this.handleInput({ type: 'char', display: ed, char: key === 'Backspace' ? '\b' : key });
  }

  /** Requests queued while no `onCommand` callback is set (returned and cleared). */
  takeCommands(): G1000Command[] {
    const out = this.commands.slice();
    this.commands.length = 0;
    return out;
  }

  /** Late binding of the nav database / flight planner. */
  setNavDatabase(nav: G1000NavDb | null): void { this.fms.nav = nav; this.touch(); }
  setPlanner(planner: G1000Planner | null): void { this.fms.planner = planner; this.touch(); }

  // ───────────────────────────── settings ─────────────────────────────

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
  setCdiSource(src: CdiSource): void { this.fms.setCdiSource(src); }
  get cdiSource(): CdiSource { return this.pfd.cdiSource; }
  /** The PFD CDI softkey: GPS → NAV1 → NAV2 → GPS. */
  cycleCdiSource(): CdiSource {
    const src = this.pfd.cdiSource;
    this.setCdiSource(src === 'GPS' ? 'NAV1' : src === 'NAV1' ? 'NAV2' : 'GPS');
    return this.pfd.cdiSource;
  }

  /** Source of bearing pointer 1 (single line) or 2 (double line). */
  setBearingSource(which: 1 | 2, src: BearingSource): void {
    const b = which === 1 ? this.pfd.brg1 : this.pfd.brg2;
    b.source = src; b.label = src;
    this.touch();
  }

  setWindOption(o: WindOption): void { this.pfd.windOption = o; this.pfd.windOn = true; this.touch(); }
  setDmeSource(src: 'OFF' | 'NAV1' | 'NAV2'): void { this.pfd.dmeSource = src; this.touch(); }

  /** COM radios are not part of the SimSnapshot; mirror the radio stack into these. */
  get com1(): ComState { return this.pfd.com1; }
  get com2(): ComState { return this.pfd.com2; }
  get squawk(): number { return this.pfd.squawk; }
  set squawk(code: number) { this.pfd.squawk = code; this.touch(); }
  get xpdrMode(): string { return this.pfd.xpdrMode; }
  set xpdrMode(mode: string) { this.pfd.xpdrMode = mode; this.touch(); }

  /** PFD elapsed timer (TMR/REF). */
  startTimer(): void { this.model.startTimer(); }
  stopTimer(): void { this.model.stopTimer(); }
  resetTimer(): void { this.model.resetTimer(); }

  /** Flight reset: snap the instrument dynamics (when owned), forget AFCS flash history, close windows. */
  reset(s: SimSnapshot): void {
    if (this.ownsModel) this.model.reset(s);
    this.pfd.afcs.reset();
    this.fms.resetUi();
    this.invalidate();
  }

  /** Redraw both displays (and the bezels) on the next `update()` regardless of cadence and change detection. */
  invalidate(): void {
    this.pfdAcc = Infinity; this.mfdAcc = Infinity;
    this.lastPfdSig = -1; this.lastMfdSig = -1;
    this.bezelDirty.pfd = this.bezel; this.bezelDirty.mfd = this.bezel;
  }

  /** Release both canvases' backing stores; further updates return false. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    releaseSurface(this.pfdCanvas);
    releaseSurface(this.mfdCanvas);
  }

  private deliver(c: G1000Command): void {
    if (this.onCommand) { this.onCommand(c); return; }
    if (this.commands.length >= MAX_QUEUED_COMMANDS) this.commands.shift();
    this.commands.push(c);
  }

  private touch(): void { this.version = (this.version + 1) | 0; this.lastPfdSig = -1; this.lastMfdSig = -1; }

  private paintBezel(ctx: Ctx2D, display: G1000Display): void {
    this.bezelDirty[display] = false;
    if (!this.bezel) return;
    ctx.setTransform(this.unit.x, 0, 0, this.unit.y, 0, 0);
    drawBezel(ctx, display, this.hoverCtl[display]);
  }

  /** Transform + clip to the 1024×768 screen; the caller restores. */
  private toScreen(ctx: Ctx2D): void {
    const ox = this.bezel ? BEZEL.screenX * this.unit.x : 0, oy = this.bezel ? BEZEL.screenY * this.unit.y : 0;
    const kx = this.screenRect.w / PFD.width, ky = this.screenRect.h / PFD.height;
    ctx.setTransform(kx, 0, 0, ky, ox, oy);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, MFD.width, MFD.height); ctx.clip();
  }
}

// The simulator's plugin loader only sees this module's exports.
export { G1000Panel } from './panel';
