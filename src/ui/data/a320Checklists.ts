/**
 * Airliner (A320-style) normal checklists, simplified for the sim and written in our own words:
 * the flows a pilot runs with the systems this aircraft has (engines, flaps, gear, spoilers,
 * autopilot / autothrust). Pure data; `auto` names a predicate in flight/checklistAuto.ts.
 */
import type { AutoCheckId, ChecklistItem, ChecklistSection } from './c172Checklists';

const i = (text: string, response: string, auto?: AutoCheckId, note?: string): ChecklistItem => (auto ? { text, response, auto, ...(note ? { note } : {}) } : { text, response, ...(note ? { note } : {}) });

export const A320_CHECKLISTS: ChecklistSection[] = [
  {
    id: 'before-start', title: 'Before start', phase: 'ground', items: [
      i('Parking brake', 'SET', 'parkingBrakeSet'),
      i('Batteries / external power', 'ON', 'masterOn'),
      i('Flight plan', 'ENTERED (EFB tablet, Tab)', undefined, 'Departure, destination and cruise altitude'),
      i('Weight & fuel', 'CHECKED (EFB tablet)'),
      i('Beacon', 'ON', 'beaconOn'),
      i('Thrust levers', 'IDLE', 'throttleIdle'),
    ],
  },
  {
    id: 'start', title: 'Engine start', phase: 'ground', items: [
      i('Engines', 'START (Ctrl+E)', 'engineRunning', 'N1 rises to about 20 % at idle'),
      i('Avionics', 'ON', 'avionicsOn'),
      i('Nav lights', 'ON', 'navLightsOn'),
    ],
  },
  {
    id: 'taxi', title: 'Taxi', phase: 'ground', items: [
      i('Flaps', 'SET 1+F or 2 for take-off', 'flapsTakeoff', 'F7 extends one detent'),
      i('Spoilers', 'ARMED (/ key)', undefined, 'They deploy on touchdown and on a rejected take-off'),
      i('Taxi light', 'ON', 'taxiLightOn'),
      i('Parking brake', 'RELEASE', 'parkingBrakeReleased'),
      i('Thrust', 'A LITTLE ABOVE IDLE, then idle', undefined, 'An airliner rolls at idle thrust; brake gently'),
    ],
  },
  {
    id: 'takeoff', title: 'Before take-off', phase: 'takeoff', items: [
      i('Strobes and landing lights', 'ON', 'strobeOn'),
      i('Autopilot', 'OFF', 'autopilotOff'),
      i('Thrust', 'TOGA (F4)', 'throttleFull', 'Rotate at about 140 kt with the stick gently back'),
      i('Positive climb', 'GEAR UP (G)', 'airborne'),
      i('Autothrust', 'ON (Alt+A) above 1,000 ft', undefined, 'It holds the selected speed; the thrust levers stay in climb'),
      i('Flaps', 'RETRACT on schedule (F6)', 'flapsUp'),
    ],
  },
  {
    id: 'climb', title: 'Climb and cruise', phase: 'flight', items: [
      i('Autopilot', 'ON (Z): HDG / NAV, ALT or V/S', undefined, 'The FCU at the top of the panel shows the selected values'),
      i('Altimeter', 'STD above the transition altitude (B)', 'altimeterSet'),
      i('Landing lights', 'OFF above 10,000 ft', 'landingLightOff'),
    ],
  },
  {
    id: 'approach', title: 'Approach', phase: 'landing', items: [
      i('ILS', 'TUNED, approach mode ARMED (Ctrl+A)'),
      i('Landing lights', 'ON', 'landingLightOn'),
      i('Spoilers', 'ARMED'),
      i('Gear', 'DOWN (G) by 2,000 ft', undefined, 'LDG GEAR DN in green on the E/WD'),
      i('Flaps', 'FULL by 1,000 ft (F8)', 'flapsFull', 'Approach speed about 135 kt'),
    ],
  },
  {
    id: 'landing', title: 'Landing', phase: 'landing', items: [
      i('Thrust', 'IDLE at 20 ft ("RETARD")', 'throttleIdle'),
      i('Flare', 'GENTLE, about 2° nose up', undefined, 'Below 50 ft the stick moves the elevator directly'),
      i('Reversers', 'HOLD F2 at idle after touchdown'),
      i('Brakes', 'AS REQUIRED', 'brakesApplied'),
    ],
  },
];
