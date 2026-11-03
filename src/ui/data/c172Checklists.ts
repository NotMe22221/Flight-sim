/**
 * Cessna 172S normal checklists (POH Section 4, condensed; doc 05 §8). Pure data.
 * `auto` names a predicate in flight/checklistAuto.ts that ticks the item when the sim
 * state already matches (flaps, parking brake, magnetos, engine running, ...).
 */
export type AutoCheckId =
  | 'parkingBrakeSet' | 'parkingBrakeReleased' | 'brakesApplied'
  | 'magnetosBoth' | 'magnetosOff' | 'engineRunning' | 'engineOff' | 'oilPressureOk'
  | 'mixtureRich' | 'mixtureCutoff' | 'mixtureLeaned'
  | 'throttleIdle' | 'throttleQuarter' | 'throttleFull' | 'throttleRunup' | 'throttleLow'
  | 'fuelBoth' | 'fuelLeftOrRight'
  | 'flapsUp' | 'flaps10' | 'flapsTakeoff' | 'flapsFull' | 'flaps20orLess'
  | 'beaconOn' | 'navLightsOn' | 'strobeOn' | 'strobeOff' | 'landingLightOn' | 'landingLightOff' | 'taxiLightOn'
  | 'autopilotOff' | 'trimTakeoff' | 'airborne' | 'onGround' | 'climbSpeed' | 'altimeterSet' | 'pitotHeatOn'
  | 'masterOn' | 'masterOff' | 'avionicsOn' | 'avionicsOff'
  /** Super Cub (cubChecklists.ts): carburettor heat, the last flap notch of a three-position handle, climb at Vy 61 */
  | 'carbHeatOn' | 'carbHeatOff' | 'flapsSecondNotch' | 'cubClimbSpeed';

export interface ChecklistItem { text: string; response: string; auto?: AutoCheckId; note?: string }
export interface ChecklistSection { id: string; title: string; phase: 'ground' | 'takeoff' | 'flight' | 'landing'; items: ChecklistItem[] }

const i = (text: string, response: string, auto?: AutoCheckId, note?: string): ChecklistItem => (auto ? { text, response, auto, ...(note ? { note } : {}) } : { text, response, ...(note ? { note } : {}) });

export const C172_CHECKLISTS: ChecklistSection[] = [
  {
    id: 'before-start', title: 'Before starting engine', phase: 'ground', items: [
      i('Preflight inspection', 'COMPLETE'),
      i('Passenger briefing', 'COMPLETE'),
      i('Seats, belts, harnesses', 'ADJUST & LOCK'),
      i('Brakes', 'TEST & SET', 'parkingBrakeSet'),
      i('Circuit breakers', 'CHECK IN'),
      i('Electrical equipment', 'OFF'),
      i('Avionics (BUS 1 & 2)', 'OFF', 'avionicsOff'),
      i('Fuel selector', 'BOTH', 'fuelBoth'),
      i('Fuel shutoff valve', 'ON (push full in)'),
    ],
  },
  {
    id: 'start', title: 'Starting engine', phase: 'ground', items: [
      i('Throttle', 'OPEN 1/4 in', 'throttleQuarter'),
      i('Mixture', 'IDLE CUT-OFF', 'mixtureCutoff'),
      i('Propeller area', 'CLEAR'),
      i('Master (ALT & BAT)', 'ON', 'masterOn'),
      i('Beacon', 'ON', 'beaconOn'),
      i('Aux fuel pump', 'ON'),
      i('Mixture', 'FULL RICH until fuel flow stable 3–5 s, then IDLE CUT-OFF'),
      i('Aux fuel pump', 'OFF'),
      i('Ignition', 'START (release when engine fires)', 'engineRunning', 'Ctrl+E auto-starts'),
      i('Mixture', 'ADVANCE smoothly to RICH when engine fires', 'mixtureRich'),
      i('Oil pressure', 'CHECK (rise within 30 s, 60 s cold)', 'oilPressureOk'),
      i('Nav lights', 'ON as required', 'navLightsOn'),
      i('Avionics (BUS 1 & 2)', 'ON', 'avionicsOn'),
      i('Radios', 'ON'),
      i('Flaps', 'RETRACT', 'flapsUp'),
    ],
  },
  {
    id: 'taxi', title: 'Before taxi / taxi', phase: 'ground', items: [
      i('Taxi light', 'ON', 'taxiLightOn'),
      i('Parking brake', 'RELEASE', 'parkingBrakeReleased'),
      i('Brakes', 'CHECK on roll', 'brakesApplied'),
      i('Flight instruments', 'CHECK (TC, AI, HI turning correctly)'),
      i('Autopilot', 'OFF', 'autopilotOff'),
    ],
  },
  {
    id: 'runup', title: 'Before takeoff (run-up)', phase: 'ground', items: [
      i('Parking brake', 'SET', 'parkingBrakeSet'),
      i('Seats, belts', 'CHECK'),
      i('Cabin doors', 'CLOSED & LATCHED'),
      i('Flight controls', 'FREE & CORRECT'),
      i('Flight instruments', 'CHECK & SET (altimeter QNH, HI to compass, HDG bug)', 'altimeterSet'),
      i('Fuel quantity', 'CHECK'),
      i('Mixture', 'RICH (lean above 3,000 ft DA)', 'mixtureRich'),
      i('Fuel selector', 'BOTH', 'fuelBoth'),
      i('Throttle', '1,800 RPM', 'throttleRunup'),
      i('Magnetos', 'CHECK (drop ≤ 150 RPM each, ≤ 50 RPM differential)', 'magnetosBoth'),
      i('Engine indications', 'CHECK green'),
      i('Ammeter / volts', 'CHECK'),
      i('Throttle', '1,000 RPM or less', 'throttleLow'),
      i('Throttle friction', 'ADJUST'),
      i('Radios / avionics', 'SET (COM, NAV, XPDR ALT)'),
      i('Autopilot', 'OFF', 'autopilotOff'),
      i('Elevator trim', 'SET for takeoff', 'trimTakeoff'),
      i('Flaps', '0–10°', 'flapsTakeoff'),
      i('Strobes', 'ON', 'strobeOn'),
      i('Brakes', 'RELEASE', 'parkingBrakeReleased'),
    ],
  },
  {
    id: 'takeoff', title: 'Normal takeoff', phase: 'takeoff', items: [
      i('Flaps', '0–10°', 'flapsTakeoff'),
      i('Throttle', 'FULL OPEN', 'throttleFull'),
      i('Mixture', 'RICH (above 3,000 ft lean for max RPM)', 'mixtureRich'),
      i('Elevator', 'LIFT NOSE WHEEL at 55 KIAS', 'airborne'),
      i('Climb', '70–80 KIAS', 'climbSpeed'),
      i('Flaps', 'RETRACT after obstacles', 'flapsUp'),
    ],
  },
  {
    id: 'short-takeoff', title: 'Short-field takeoff', phase: 'takeoff', items: [
      i('Flaps', '10°', 'flaps10'),
      i('Brakes', 'HOLD', 'brakesApplied'),
      i('Throttle', 'FULL', 'throttleFull'),
      i('Brakes', 'RELEASE', 'parkingBrakeReleased'),
      i('Rotate', '51 KIAS', 'airborne'),
      i('Climb', '56 KIAS until obstacles cleared'),
      i('Flaps', 'RETRACT after 60 KIAS', 'flapsUp'),
    ],
  },
  {
    id: 'climb', title: 'Enroute climb', phase: 'flight', items: [
      i('Airspeed', '70–85 KIAS (Vy 74)', 'climbSpeed'),
      i('Throttle', 'FULL', 'throttleFull'),
      i('Mixture', 'RICH below 3,000 ft, lean for max RPM above'),
    ],
  },
  {
    id: 'cruise', title: 'Cruise', phase: 'flight', items: [
      i('Power', '2,100–2,700 RPM (≤ 80 %)'),
      i('Elevator trim', 'ADJUST'),
      i('Mixture', 'LEAN (lean-assist / 50 °F rich of peak)', 'mixtureLeaned'),
      i('Fuel', 'Monitor, BOTH', 'fuelBoth'),
    ],
  },
  {
    id: 'descent', title: 'Descent', phase: 'flight', items: [
      i('Power', 'AS DESIRED'),
      i('Mixture', 'ADJUST (enrich as altitude decreases)'),
      i('Altimeter', 'SET QNH', 'altimeterSet'),
      i('Fuel selector', 'BOTH', 'fuelBoth'),
      i('Flaps', 'AS DESIRED (0–10° ≤ 110 KIAS, 10–30° ≤ 85 KIAS)'),
    ],
  },
  {
    id: 'before-landing', title: 'Before landing', phase: 'landing', items: [
      i('Seat backs', 'UPRIGHT'),
      i('Seats, belts', 'SECURE'),
      i('Fuel selector', 'BOTH', 'fuelBoth'),
      i('Mixture', 'RICH', 'mixtureRich'),
      i('Landing / taxi lights', 'ON', 'landingLightOn'),
      i('Autopilot', 'OFF', 'autopilotOff'),
    ],
  },
  {
    id: 'landing', title: 'Normal landing', phase: 'landing', items: [
      i('Airspeed', '65–75 KIAS flaps up'),
      i('Flaps', 'AS DESIRED'),
      i('Airspeed', '60–70 KIAS flaps FULL', 'flapsFull'),
      i('Trim', 'ADJUST'),
      i('Touchdown', 'MAIN WHEELS FIRST', 'onGround'),
      i('Landing roll', 'LOWER NOSE WHEEL GENTLY'),
      i('Braking', 'MINIMUM REQUIRED', 'brakesApplied', 'Short field: 61 KIAS, flaps FULL, heavy braking, retract flaps'),
    ],
  },
  {
    id: 'balked', title: 'Balked landing', phase: 'landing', items: [
      i('Throttle', 'FULL OPEN', 'throttleFull'),
      i('Flaps', 'RETRACT to 20°', 'flaps20orLess'),
      i('Climb', '55 KIAS'),
      i('Flaps', '10°, then UP above 60 KIAS / clear of obstacles', 'flapsUp'),
    ],
  },
  {
    id: 'after-landing', title: 'After landing', phase: 'ground', items: [
      i('Flaps', 'UP', 'flapsUp'),
      i('Strobes', 'OFF', 'strobeOff'),
      i('Landing light', 'OFF', 'landingLightOff'),
      i('Transponder', 'GND / STBY'),
      i('Mixture', 'LEAN for taxi', 'mixtureLeaned'),
    ],
  },
  {
    id: 'securing', title: 'Securing airplane', phase: 'ground', items: [
      i('Parking brake', 'SET', 'parkingBrakeSet'),
      i('Avionics', 'OFF', 'avionicsOff'),
      i('Electrical equipment, autopilot', 'OFF', 'autopilotOff'),
      i('Mixture', 'IDLE CUT-OFF (pull full out)', 'mixtureCutoff'),
      i('Ignition', 'OFF', 'magnetosOff'),
      i('Master', 'OFF', 'masterOff'),
      i('Control lock', 'INSTALL'),
      i('Fuel selector', 'LEFT or RIGHT (prevents cross-feeding)', 'fuelLeftOrRight'),
      i('Chocks / tie-downs', 'INSTALL'),
    ],
  },
];

/** Emergency reference for the assistance menu (not interactive). */
export const C172_EMERGENCY: ChecklistSection[] = [
  {
    id: 'engine-failure', title: 'Engine failure in flight', phase: 'flight', items: [
      i('Airspeed', '68 KIAS (best glide)'),
      i('Fuel shutoff valve', 'ON'),
      i('Fuel selector', 'BOTH', 'fuelBoth'),
      i('Aux fuel pump', 'ON'),
      i('Mixture', 'RICH', 'mixtureRich'),
      i('Ignition', 'BOTH (START if prop stopped)', 'magnetosBoth'),
    ],
  },
  {
    id: 'engine-fire-start', title: 'Engine fire during start', phase: 'ground', items: [
      i('Cranking', 'CONTINUE'),
      i('Mixture', 'IDLE CUT-OFF', 'mixtureCutoff'),
      i('Throttle', 'FULL OPEN', 'throttleFull'),
      i('Fuel shutoff valve', 'OFF'),
    ],
  },
];
