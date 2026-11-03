/**
 * Cessna 172S electrical system (POH §7): 28 V DC bus fed by a 60 A belt-driven alternator and a
 * 24 V 12.75 Ah lead-acid battery through the split master switch (BAT / ALT), with an avionics
 * master for the avionics bus.
 *
 * Model (per step, allocation-free):
 * - Battery: open-circuit voltage from state of charge (22.8 V empty … 25.2 V full); under load
 *   the terminal voltage sags by an ohmic part plus a saturating polarisation part, both growing as
 *   the battery runs down (so the bus reads ~24 V on battery alone, LOW VOLTS lit as in the POH
 *   pre-start check, and ~20 V while a good battery cranks); charge integrates the current (Ah).
 * - Alternator: field needs ALT on and bus power (BAT on, or the alternator already excited);
 *   regulated at 28.5 V while its current limit (60 A, reduced below ~1500 rpm) covers the loads
 *   plus battery charging; otherwise the bus sags to what the battery can hold up.
 * - Loads by switch state: base (engine instruments, annunciators), avionics, lights, pitot heat,
 *   fuel pump, starter (≈ 150 A while cranking).
 * Outputs feed the instruments (bus volts, battery amps, LOW VOLTS) and gate the starter.
 */
import { clamp } from '../core/math';
import type { ElectricalState } from '../core/types';

export type { ElectricalState };

export interface ElectricalSwitches {
  battery: boolean;
  alternator: boolean;
  avionics: boolean;
}

export interface ElectricalLoads {
  nav: boolean; beacon: boolean; strobe: boolean; landing: boolean; taxi: boolean;
  /** panel / instrument lighting dimmer 0..1 */
  panel: number;
  pitotHeat: boolean;
  fuelPump: boolean;
  starter: boolean;
}

export interface ElectricalSpec {
  capacityAh: number;
  internalOhm: number;
  alternatorMaxA: number;
  regulatorV: number;
  /** rpm at which the alternator reaches full output (linear from cut-in) */
  alternatorFullRpm: number;
  alternatorCutInRpm: number;
  /** below this the avionics/instruments drop out */
  dropOutV: number;
  lowVoltsV: number;
  loadsA: { base: number; avionics: number; nav: number; beacon: number; strobe: number; landing: number; taxi: number; panel: number; pitotHeat: number; fuelPump: number; starter: number };
}

/** C172S figures: POH §7 (battery, alternator, LOW VOLTS) and typical lamp/avionics currents. */
export const C172S_ELECTRICAL: ElectricalSpec = {
  capacityAh: 12.75,
  internalOhm: 0.025,
  alternatorMaxA: 60,
  regulatorV: 28.5,
  alternatorFullRpm: 1700,
  alternatorCutInRpm: 550,
  dropOutV: 18,
  lowVoltsV: 24.5,
  loadsA: { base: 2.5, avionics: 9, nav: 2.5, beacon: 1.5, strobe: 3, landing: 4.6, taxi: 4.6, panel: 1.2, pitotHeat: 7.5, fuelPump: 3, starter: 150 },
};

export const emptyElectricalState = (): ElectricalState => ({
  busVolts: 0, avionicsPowered: false, mainPowered: false, batteryAmps: 0, alternatorAmps: 0, loadAmps: 0, batteryCharge: 1, lowVoltage: false,
});

export class ElectricalSystem {
  readonly state: ElectricalState = emptyElectricalState();
  /** battery charge, Ah */
  private chargeAh: number;
  private excited = false;

  constructor(private readonly spec: ElectricalSpec = C172S_ELECTRICAL, charge = 1) {
    this.chargeAh = clamp(charge, 0, 1) * spec.capacityAh;
    this.state.batteryCharge = clamp(charge, 0, 1);
  }

  /** Battery open-circuit voltage at the current state of charge. */
  openCircuitVolts(): number { return 22.8 + 2.4 * (this.chargeAh / this.spec.capacityAh); }

  /** Terminal voltage drop for a discharge current (A, + = discharging) at state of charge soc. */
  private sag(amps: number, soc: number): number {
    const worn = 1 - soc;
    const R = this.spec.internalOhm * (1 + 2 * worn * worn);
    if (amps <= 0) return amps * R; // charging: terminal above open circuit
    return amps * R + 0.8 * (1 + worn) * (1 - Math.exp(-amps / 10));
  }

  setCharge(fraction: number): void { this.chargeAh = clamp(fraction, 0, 1) * this.spec.capacityAh; this.state.batteryCharge = clamp(fraction, 0, 1); }
  get charge(): number { return this.chargeAh / this.spec.capacityAh; }

  /**
   * Starter effectiveness 0..1 from the battery terminal voltage while cranking: a good battery
   * (~20 V) cranks briskly, a weak one slowly, a flat one not at all. The starter runs below the
   * avionics drop-out voltage, so the screens may flicker off while a weak battery cranks.
   */
  starterFactor(): number { return this.batteryOn ? clamp((this.state.busVolts - 12) / 8.5, 0, 1) : 0; }
  private batteryOn = false;

  step(dt: number, sw: ElectricalSwitches, loads: ElectricalLoads, engineRpm: number): ElectricalState {
    const sp = this.spec, st = this.state, L = sp.loadsA;
    this.batteryOn = sw.battery;
    // field excitation needs bus power; once the alternator is online it keeps itself excited
    if (!sw.alternator) this.excited = false;
    else if (sw.battery) this.excited = true;
    const altAvail = this.excited && engineRpm > sp.alternatorCutInRpm
      ? sp.alternatorMaxA * clamp((engineRpm - sp.alternatorCutInRpm) / (sp.alternatorFullRpm - sp.alternatorCutInRpm), 0, 1)
      : 0;
    if (!sw.battery && altAvail <= 0) {
      st.busVolts = 0; st.mainPowered = false; st.avionicsPowered = false;
      st.batteryAmps = 0; st.alternatorAmps = 0; st.loadAmps = 0; st.lowVoltage = false;
      st.batteryCharge = this.charge;
      return st;
    }
    let load = L.base + (loads.nav ? L.nav : 0) + (loads.beacon ? L.beacon : 0) + (loads.strobe ? L.strobe : 0)
      + (loads.landing ? L.landing : 0) + (loads.taxi ? L.taxi : 0) + clamp(loads.panel, 0, 1) * L.panel
      + (loads.pitotHeat ? L.pitotHeat : 0) + (loads.fuelPump ? L.fuelPump : 0)
      + (loads.starter && sw.battery ? L.starter : 0);
    // avionics draw only while the bus can power them (assume previous-step voltage)
    if (sw.avionics && st.busVolts > sp.dropOutV) load += L.avionics;
    const voc = this.openCircuitVolts();
    const soc = this.charge;
    const R = sp.internalOhm * (1 + 2 * (1 - soc) * (1 - soc));
    let bus: number, iBat: number, iAlt: number;
    // battery charge acceptance tapers near full
    const chargeLimit = 30 * clamp((1 - soc) * 4 + 0.05, 0, 1);
    if (altAvail > 0) {
      // regulated if the alternator covers the load plus what the battery takes at the setpoint
      const iChargeAtSet = sw.battery ? clamp((sp.regulatorV - voc) / R, 0, chargeLimit) : 0;
      if (altAvail >= load + iChargeAtSet) {
        bus = sp.regulatorV; iBat = iChargeAtSet; iAlt = load + iChargeAtSet;
      } else if (sw.battery) {
        // alternator at its limit; the battery supplies the rest
        iAlt = altAvail; iBat = altAvail - load; bus = Math.max(voc - this.sag(-iBat, soc), 0);
      } else {
        // alternator alone, overloaded: voltage collapses with the overload
        iAlt = altAvail; iBat = 0; bus = sp.regulatorV * clamp(altAvail / Math.max(load, 1e-3), 0, 1);
      }
    } else {
      iAlt = 0; iBat = -load; bus = Math.max(voc - this.sag(load, soc), 0);
    }
    if (this.chargeAh <= 0 && iBat < 0) bus = Math.min(bus, 6); // exhausted
    this.chargeAh = clamp(this.chargeAh + (iBat * dt) / 3600, 0, sp.capacityAh);
    st.busVolts = bus;
    st.mainPowered = bus > sp.dropOutV;
    st.avionicsPowered = sw.avionics && st.mainPowered;
    st.batteryAmps = sw.battery ? iBat : 0;
    st.alternatorAmps = iAlt;
    st.loadAmps = load;
    st.lowVoltage = st.mainPowered && bus < sp.lowVoltsV;
    st.batteryCharge = this.charge;
    return st;
  }

  serialize(): { chargeAh: number; excited: boolean } { return { chargeAh: this.chargeAh, excited: this.excited }; }
  deserialize(s: { chargeAh: number; excited: boolean }): void { this.chargeAh = s.chargeAh; this.excited = s.excited; }
}
