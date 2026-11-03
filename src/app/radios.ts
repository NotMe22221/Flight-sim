/**
 * NAV/COM radio stack for the integrator: tuning state, station lookup (VOR/DME or ILS by
 * frequency, nearest within range) and per-frame NavRadioState computation.
 */
import type { Geodetic, NavRadioState, SimAction } from '../core/types';
import { computeNavRadio, emptyNavRadioState, stepNav, type NavDb, type NavRadioStateEx, type NavTuning, type TunedStation } from '../nav';

export interface RadioStackState {
  nav1: NavRadioStateEx;
  nav2: NavRadioStateEx;
  com1: { activeMHz: number; standbyMHz: number };
}

const LOOKUP_PERIOD_S = 0.5;

export class RadioStack {
  readonly tuning: [NavTuning, NavTuning] = [
    { activeKHz: 116800, standbyKHz: 109550, obsDeg: 0 },
    { activeKHz: 116200, standbyKHz: 113700, obsDeg: 0 },
  ];
  readonly state: RadioStackState;
  private stations: [TunedStation, TunedStation] = [undefined, undefined];
  private lookupTimer = Infinity;
  private lookupKHz: [number, number] = [0, 0];

  constructor(private readonly nav: NavDb) {
    this.state = {
      nav1: emptyNavRadioState(this.tuning[0]),
      nav2: emptyNavRadioState(this.tuning[1]),
      com1: { activeMHz: 121.8, standbyMHz: 120.5 },
    };
  }

  /** Tune NAV1 to an ILS/VOR frequency (kHz) and optionally set the course. */
  tuneNav(index: 0 | 1, kHz: number, courseDeg?: number): void {
    this.tuning[index].activeKHz = kHz;
    if (courseDeg !== undefined) this.tuning[index].obsDeg = ((courseDeg % 360) + 360) % 360;
    this.lookupTimer = Infinity;
  }

  /** Radio-related actions from the input layer. Returns true when handled. */
  handleAction(a: SimAction): boolean {
    const t1 = this.tuning[0];
    switch (a) {
      case 'nav1Swap': [t1.activeKHz, t1.standbyKHz] = [t1.standbyKHz, t1.activeKHz]; this.lookupTimer = Infinity; return true;
      case 'nav1Inc': t1.standbyKHz = stepNav(t1.standbyKHz, 1); return true;
      case 'nav1Dec': t1.standbyKHz = stepNav(t1.standbyKHz, -1); return true;
      case 'obs1Inc': t1.obsDeg = (t1.obsDeg + 1) % 360; return true;
      case 'obs1Dec': t1.obsDeg = (t1.obsDeg + 359) % 360; return true;
      case 'nav2Swap': { const t2 = this.tuning[1]; [t2.activeKHz, t2.standbyKHz] = [t2.standbyKHz, t2.activeKHz]; this.lookupTimer = Infinity; return true; }
      case 'com1Swap': { const c = this.state.com1; [c.activeMHz, c.standbyMHz] = [c.standbyMHz, c.activeMHz]; return true; }
      default: return false;
    }
  }

  update(dt: number, pos: Geodetic, magVarDeg: number): void {
    this.lookupTimer += dt;
    const retune = this.lookupKHz[0] !== this.tuning[0].activeKHz || this.lookupKHz[1] !== this.tuning[1].activeKHz;
    if (this.lookupTimer >= LOOKUP_PERIOD_S || retune) {
      this.lookupTimer = 0;
      for (const i of [0, 1] as const) {
        const khz = this.tuning[i].activeKHz;
        this.lookupKHz[i] = khz;
        const ils = this.nav.findIlsEntry(khz, pos);
        this.stations[i] = ils ? ils.geometry : this.nav.findNavaidByFrequency(khz, pos);
      }
    }
    computeNavRadio(pos, magVarDeg, this.stations[0], this.tuning[0], this.state.nav1);
    computeNavRadio(pos, magVarDeg, this.stations[1], this.tuning[1], this.state.nav2);
  }

  get nav1(): NavRadioState { return this.state.nav1; }
  get nav2(): NavRadioState { return this.state.nav2; }
}
