/**
 * Piper PA-18-150 Super Cub normal checklists, condensed from the owner's handbook procedures in our
 * own words (tail-dragger technique: S-turns to see ahead, stick back on the ground, tail up with
 * forward stick, three-point landings). Pure data; `auto` names a predicate in flight/checklistAuto.ts.
 */
import type { AutoCheckId, ChecklistItem, ChecklistSection } from './c172Checklists';

const i = (text: string, response: string, auto?: AutoCheckId, note?: string): ChecklistItem => (auto ? { text, response, auto, ...(note ? { note } : {}) } : { text, response, ...(note ? { note } : {}) });

export const CUB_CHECKLISTS: ChecklistSection[] = [
  {
    id: 'before-start', title: 'Before starting engine', phase: 'ground', items: [
      i('Preflight inspection', 'COMPLETE', undefined, 'Fuel quantity in the wing-root sight gauges, oil, fabric, tail wheel springs'),
      i('Seat belt', 'FASTENED (front seat solo)'),
      i('Brakes', 'HOLD / PARKING BRAKE SET', 'parkingBrakeSet'),
      i('Fuel selector', 'ON', 'fuelBoth'),
      i('Radio switch', 'OFF', 'avionicsOff'),
      i('Master switch', 'OFF', 'masterOff'),
    ],
  },
  {
    id: 'start', title: 'Starting engine', phase: 'ground', items: [
      i('Carburettor heat', 'OFF (push in)', 'carbHeatOff'),
      i('Mixture', 'FULL RICH', 'mixtureRich'),
      i('Primer', '2–3 STROKES, LOCKED'),
      i('Throttle', 'OPEN 1/4 in', 'throttleQuarter'),
      i('Master switch', 'ON', 'masterOn'),
      i('Propeller area', 'CLEAR'),
      i('Magneto switch', 'BOTH, then START', 'engineRunning', 'Ctrl+E runs the whole start'),
      i('Oil pressure', 'RISING within 30 s', 'oilPressureOk'),
      i('Radio switch', 'ON', 'avionicsOn'),
    ],
  },
  {
    id: 'taxi', title: 'Taxi', phase: 'ground', items: [
      i('Parking brake', 'RELEASE', 'parkingBrakeReleased'),
      i('Stick', 'BACK (tail wheel on the ground)', undefined, 'Into a headwind: aileron into the wind; tailwind: stick forward, aileron away'),
      i('Taxi', 'S-TURNS to see ahead, walking pace', undefined, 'The nose hides the runway in the three-point attitude'),
      i('Brakes', 'CHECK (heel brakes)'),
    ],
  },
  {
    id: 'runup', title: 'Before take-off', phase: 'ground', items: [
      i('Brakes', 'HOLD', 'brakesApplied'),
      i('Throttle', '1,800 RPM', 'throttleRunup'),
      i('Magnetos', 'CHECK (drop under 175 RPM, smooth)'),
      i('Carburettor heat', 'CHECK, then OFF', 'carbHeatOff'),
      i('Oil temperature & pressure', 'GREEN'),
      i('Throttle', 'IDLE', 'throttleLow'),
      i('Fuel selector', 'ON', 'fuelBoth'),
      i('Trim', 'SET for take-off', 'trimTakeoff'),
      i('Flaps', 'UP (first notch for a short field)', 'flapsTakeoff'),
      i('Flight controls', 'FREE & CORRECT'),
      i('Altimeter', 'SET', 'altimeterSet'),
    ],
  },
  {
    id: 'takeoff', title: 'Take-off', phase: 'takeoff', items: [
      i('Throttle', 'FULL, smoothly', 'throttleFull'),
      i('Rudder', 'RIGHT as needed: keep straight', undefined, 'The torque swings the nose left, most of all as the tail comes up'),
      i('Tail', 'RAISE with forward stick (about 30 KIAS)'),
      i('Lift-off', 'ABOUT 40 KIAS, gently', 'airborne'),
      i('Climb', '61 KIAS (Vy)', 'cubClimbSpeed'),
      i('Flaps', 'UP above 200 ft', 'flapsUp'),
    ],
  },
  {
    id: 'cruise', title: 'Cruise', phase: 'flight', items: [
      i('Power', '2,300–2,450 RPM'),
      i('Mixture', 'LEAN above 3,000 ft', 'mixtureLeaned'),
      i('Trim', 'ADJUST'),
      i('Carburettor heat', 'ON at the first sign of icing (RPM drop)'),
    ],
  },
  {
    id: 'before-landing', title: 'Before landing', phase: 'landing', items: [
      i('Fuel selector', 'ON', 'fuelBoth'),
      i('Mixture', 'FULL RICH', 'mixtureRich'),
      i('Carburettor heat', 'ON before reducing power', 'carbHeatOn'),
      i('Approach speed', '60 KIAS'),
      i('Flaps', 'AS REQUIRED (below 61 KIAS)'),
    ],
  },
  {
    id: 'landing', title: 'Landing', phase: 'landing', items: [
      i('Flaps', 'FULL (second notch) for a short field', 'flapsSecondNotch'),
      i('Final', '50–55 KIAS'),
      i('Touchdown', 'THREE-POINT, stick full back', 'onGround'),
      i('Rudder', 'KEEP STRAIGHT until stopped', undefined, 'A tail-dragger is never done flying until it is tied down'),
    ],
  },
  {
    id: 'after-landing', title: 'After landing', phase: 'ground', items: [
      i('Flaps', 'UP', 'flapsUp'),
      i('Carburettor heat', 'OFF', 'carbHeatOff'),
      i('Stick', 'BACK while taxiing'),
    ],
  },
  {
    id: 'shutdown', title: 'Shutdown', phase: 'ground', items: [
      i('Parking brake', 'SET', 'parkingBrakeSet'),
      i('Radio switch', 'OFF', 'avionicsOff'),
      i('Mixture', 'IDLE CUT-OFF', 'mixtureCutoff'),
      i('Magneto switch', 'OFF', 'magnetosOff'),
      i('Master switch', 'OFF', 'masterOff'),
    ],
  },
];
