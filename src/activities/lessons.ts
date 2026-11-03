/**
 * Flight Training lessons (docs/research/01 §10.3), written for the C172S with POH numbers from
 * docs/research/02 §9–10: Vr 55, Vx 62, Vy 74 KIAS, ~730 fpm at Vy, Vfe 110 (10°) / 85 (full),
 * final approach 60–65 KIAS with flaps 30°. Headings in instructions are magnetic, as the
 * heading indicator shows them; spawn headings are true. Runway numbers come from public/data
 * (verified by lessons.test.ts).
 */
import { destinationPoint } from '../geo/wgs84';
import { magneticDeclinationAtYearDeg } from '../geo/magvar';
import { M_TO_FT, NM } from '../core/units';
import type { ActivityDef } from './activityTypes';
import type { RunwaySpec } from './objectives';
import { aimAlongM } from './runwayFrame';

/** KSFO 28R (public/data/airports.json: he ["28R", 37.613538, −122.35716, 4 m, 298°, 91 m]). */
export const KSFO_28R: RunwaySpec = {
  icao: 'KSFO', ident: '28R', lat: 37.613538, lon: -122.35716, elevM: 4, headingDeg: 298, lengthM: 3618, widthM: 61, displacedM: 91,
};

/** KHAF 30 (public/data/small/3_-13.json: he ["30", 37.5084, −122.495003, 11 m, 317°, 233 m]). */
export const KHAF_30: RunwaySpec = {
  icao: 'KHAF', ident: '30', lat: 37.5084, lon: -122.495003, elevM: 11, headingDeg: 317, lengthM: 1524, widthM: 46, displacedM: 233,
};

/** Half Moon Bay airport reference point (public/data). */
export const KHAF_POS = { lat: 37.513401, lon: -122.500999 } as const;

/** Declination epoch for spawn headings (WMM; ~0.1°/yr drift is irrelevant for a lesson). */
const DECL_YEAR = 2026.5;

// ─────────────────────────────── Basic flight controls ───────────────────────────────

const basicStart = destinationPoint({ lat: KHAF_POS.lat, lon: KHAF_POS.lon, alt: 0 }, 270, 8 * NM);
/** True heading that reads 090° on the heading indicator at the start point. */
const basicTrueHeading = 90 + magneticDeclinationAtYearDeg(basicStart.lat, basicStart.lon, 914, DECL_YEAR);

export const BASIC_FLIGHT: ActivityDef = {
  id: 'lesson-basic-flight',
  kind: 'lesson',
  title: 'Basic flight controls',
  description: 'Air start over the Pacific west of Half Moon Bay: straight and level, a 500 ft climb, a level-off, standard-rate turns each way, a descent and trimming for hands-off flight.',
  aircraft: 'c172',
  setup: { spawn: 'air', lat: basicStart.lat, lon: basicStart.lon, altFt: 3000, headingDeg: basicTrueHeading, iasKt: 100, flapsIndex: 0, gammaDeg: 0, weather: 'clear', time: 'morning' },
  passScore: 0,
  steps: [
    {
      id: 'level',
      title: 'Straight and level',
      instruction: {
        text: 'You have the controls: 3,000 ft, 100 KIAS, heading 090, 8 nm west of Half Moon Bay. Keep the wings level and hold 3,000 ft and heading 090 for 20 seconds.',
        speech: 'Welcome aboard. You have the controls. We are at three thousand feet and one hundred knots, eight miles west of Half Moon Bay. Keep the wings level, and hold three thousand feet and heading zero nine zero for twenty seconds.',
      },
      objectives: [{
        type: 'hold', label: 'Hold 3,000 ft ±100 and heading 090° ±10 for 20 s', forS: 20,
        all: [{ c: 'altitude', ft: 3000, tolFt: 100 }, { c: 'heading', deg: 90, tolDeg: 10 }, { c: 'bank', maxDeg: 10 }],
      }],
      hints: [{ text: 'Pick a point on the horizon and keep the nose on it. Small inputs.', speech: 'Pick a point on the horizon and keep the nose right there. Use small inputs.' }],
      success: { text: 'Nicely held.', speech: 'Nicely held.' },
    },
    {
      id: 'climb',
      title: 'Climb 500 ft',
      instruction: {
        text: 'Climb 500 ft to 3,500 ft: full power, then raise the nose gently. Aim for about 500 fpm and keep heading 090.',
        speech: 'Now climb five hundred feet, to three thousand five hundred. Smoothly add full power, then raise the nose gently. Aim for about five hundred feet per minute, and keep heading zero nine zero.',
      },
      objectives: [{
        type: 'reach', label: 'Climb to 3,500 ft at 200–1,200 fpm',
        all: [{ c: 'altitude', ft: 3500, tolFt: 60 }],
        during: [{ c: 'verticalSpeed', minFpm: 200, maxFpm: 1200 }, { c: 'heading', deg: 90, tolDeg: 15 }],
        progress: { metric: 'altitudeFt', to: 3500 },
      }],
    },
    {
      id: 'levelOff',
      title: 'Level off',
      instruction: {
        text: 'Level off at 3,500 ft: lower the nose to the horizon, let the speed build, then reduce power to about 2,300 rpm. Hold it for 10 seconds.',
        speech: 'Level off at three thousand five hundred. Lower the nose to the horizon, let the speed build, then reduce power to about two thousand three hundred r p m. Hold it there for ten seconds.',
      },
      objectives: [{
        type: 'hold', label: 'Hold 3,500 ft ±100, vertical speed ±200 fpm for 10 s', forS: 10,
        all: [{ c: 'altitude', ft: 3500, tolFt: 100 }, { c: 'verticalSpeed', minFpm: -200, maxFpm: 200 }],
      }],
      success: { text: 'Good level-off.', speech: 'Good level off.' },
    },
    {
      id: 'turnRight',
      title: 'Standard-rate turn right',
      instruction: {
        text: 'A standard-rate turn to the right, 90°: roll into about 15° of bank, hold 3,500 ft, and start rolling out 10° before heading 180.',
        speech: 'Now a standard rate turn to the right, ninety degrees. Roll into about fifteen degrees of bank and hold your altitude. Start rolling out about ten degrees before heading one eight zero.',
      },
      objectives: [{
        // toDeg: roll out on the heading the instruction names (the level-off before it does not hold a heading)
        type: 'turn', label: 'Turn right to heading 180 with 10–22° of bank, ±150 ft', byDeg: 90, toDeg: 180, bankMinDeg: 10, bankMaxDeg: 22, tolDeg: 10,
        during: [{ c: 'altitude', ft: 3500, tolFt: 150 }],
      }],
      hints: [{ text: 'Standard rate is 3° per second: at 100 knots that is about 15° of bank. Add a little back pressure to hold altitude.', speech: 'Standard rate is three degrees per second. At a hundred knots that is about fifteen degrees of bank. Add a little back pressure to hold your altitude.' }],
      success: { text: 'Wings level on 180. Well flown.', speech: 'Wings level. Well flown.' },
    },
    {
      id: 'turnLeft',
      title: 'Standard-rate turn left',
      instruction: {
        text: 'Now the same to the left: 90° back to heading 090 with about 15° of bank.',
        speech: 'Now the same to the left. Ninety degrees, back to heading zero nine zero, with about fifteen degrees of bank.',
      },
      objectives: [{
        type: 'turn', label: 'Turn left to heading 090 with 10–22° of bank, ±150 ft', byDeg: -90, toDeg: 90, bankMinDeg: 10, bankMaxDeg: 22, tolDeg: 10,
        during: [{ c: 'altitude', ft: 3500, tolFt: 150 }],
      }],
    },
    {
      id: 'descend',
      title: 'Descend to 3,000 ft',
      instruction: {
        text: 'Descend back to 3,000 ft: reduce power to about 1,800 rpm and let the nose drop slightly. Aim for about 500 fpm down.',
        speech: 'Descend back to three thousand feet. Reduce power to about one thousand eight hundred r p m and let the nose drop slightly. Aim for about five hundred feet per minute down.',
      },
      objectives: [{
        type: 'reach', label: 'Descend to 3,000 ft at 200–1,000 fpm',
        all: [{ c: 'altitude', ft: 3000, tolFt: 60 }],
        during: [{ c: 'verticalSpeed', minFpm: -1000, maxFpm: -200 }],
        progress: { metric: 'altitudeFt', to: 3000 },
      }],
    },
    {
      id: 'trim',
      title: 'Trim for hands-off flight',
      instruction: {
        text: 'Level off at 3,000 ft and trim: roll the trim wheel until the aircraft holds altitude with no pressure on the yoke. Hands off for 10 seconds.',
        speech: 'Level off at three thousand feet, and trim. Roll the trim wheel until the airplane holds altitude with no pressure on the yoke. Then hands off, for ten seconds.',
      },
      objectives: [{
        type: 'hold', label: 'Hands off: 3,000 ft ±100, ±150 fpm for 10 s', forS: 10,
        all: [{ c: 'altitude', ft: 3000, tolFt: 100 }, { c: 'verticalSpeed', minFpm: -150, maxFpm: 150 }, { c: 'controlsNeutral', maxPitch: 0.05 }],
      }],
      success: { text: 'Trimmed and hands off. That is the secret of smooth flying.', speech: 'Trimmed, and hands off. That is the secret of smooth flying.' },
    },
  ],
  debrief: {
    pass: { text: 'Lesson complete: you have the basic flight controls. Next up: the takeoff lesson.', speech: 'Lesson complete. You have mastered the basic flight controls. Next up, the takeoff lesson.' },
    fail: { text: 'Lesson incomplete. Have another go: small, smooth inputs.', speech: 'Lesson incomplete. Have another go, with small, smooth inputs.' },
  },
};

// ─────────────────────────────── Takeoff ───────────────────────────────

export const TAKEOFF: ActivityDef = {
  id: 'lesson-takeoff',
  kind: 'lesson',
  title: 'Takeoff',
  description: 'Lined up on San Francisco 28R: before-takeoff checks, full power, keep the centreline, rotate at 55 KIAS, climb at Vy, flaps up above 500 ft and level at 1,500 ft.',
  aircraft: 'c172',
  setup: {
    spawn: 'runway', icao: KSFO_28R.icao, runway: KSFO_28R.ident, parkingBrake: true, weather: 'few', time: 'morning',
    anchor: { lat: KSFO_28R.lat, lon: KSFO_28R.lon },
  },
  passScore: 0,
  steps: [
    {
      id: 'checks',
      title: 'Before-takeoff checks',
      instruction: {
        text: 'Lined up on runway 28R at San Francisco. Before takeoff: release the parking brake, mixture full rich, flaps up or 10°.',
        speech: 'We are lined up on runway two eight right at San Francisco. Before takeoff: release the parking brake, check the mixture full rich, and set the flaps up, or ten degrees.',
      },
      objectives: [
        { type: 'reach', label: 'Parking brake released', all: [{ c: 'parkingBrake', set: false }] },
        { type: 'reach', label: 'Mixture full rich', all: [{ c: 'mixture', min: 0.95 }] },
        { type: 'reach', label: 'Flaps 0–10°', all: [{ c: 'flaps', maxDeg: 10 }] },
      ],
      success: { text: 'Checks complete.', speech: 'Checks complete.' },
    },
    {
      id: 'roll',
      title: 'Takeoff roll',
      instruction: {
        text: 'Smoothly apply full power. Keep the centreline with the rudder pedals and rotate at 55 KIAS.',
        speech: 'Smoothly apply full power. Keep the centerline with the rudder pedals, and rotate at fifty five knots.',
      },
      objectives: [
        { type: 'reach', label: 'Full power', all: [{ c: 'throttle', min: 0.95 }] },
        {
          type: 'maintain', label: 'Stay within 10 m of the centreline', all: [{ c: 'centreline', runway: KSFO_28R, maxM: 10 }],
          until: [{ c: 'agl', minFt: 20 }], failAfterS: 5, failText: 'Drifted off the centreline during the takeoff roll',
        },
        { type: 'rotate', label: 'Rotate at 55 KIAS', minKt: 48, maxKt: 65, targetKt: 55, strict: true },
      ],
      cues: [
        { when: [{ c: 'airspeed', minKt: 30 }, { c: 'onGround', value: true }], line: { text: 'Airspeed alive.', speech: 'Airspeed alive.' }, important: false },
        { when: [{ c: 'airspeed', minKt: 53 }, { c: 'onGround', value: true }], line: { text: '55 knots: rotate.', speech: 'Fifty five. Rotate.' } },
      ],
      success: { text: 'Positive climb.', speech: 'Positive climb.' },
    },
    {
      id: 'vy',
      title: 'Climb at Vy',
      instruction: {
        text: 'Climb at Vy, 74 KIAS: the best rate of climb. Use pitch to hold the speed.',
        speech: 'Climb at seventy four knots, the best rate of climb speed. Use pitch to hold the speed.',
      },
      objectives: [{
        type: 'maintain', label: 'Climb at 74 KIAS ±5 to 500 ft AGL',
        all: [{ c: 'airspeed', minKt: 69, maxKt: 79, lowHint: { text: 'Too slow: lower the nose', speech: 'Too slow. Lower the nose a little.' }, highHint: { text: 'Too fast: raise the nose', speech: 'Too fast. Raise the nose a little.' } }],
        until: [{ c: 'agl', minFt: 500 }], progress: { metric: 'aglFt', to: 500 },
      }],
    },
    {
      id: 'flapsUp',
      title: 'Flaps up',
      instruction: { text: 'Passing 500 ft: flaps up.', speech: 'Passing five hundred feet. Flaps up.' },
      objectives: [{ type: 'reach', label: 'Flaps up', all: [{ c: 'flaps', maxDeg: 0 }] }],
    },
    {
      id: 'climb1500',
      title: 'Climb to 1,500 ft',
      instruction: { text: 'Keep climbing at 74 KIAS to 1,500 ft.', speech: 'Keep climbing at seventy four knots, to one thousand five hundred feet.' },
      objectives: [{
        type: 'reach', label: 'Climb to 1,500 ft at 74 KIAS ±5',
        all: [{ c: 'altitude', ft: 1500, tolFt: 100 }],
        during: [{ c: 'airspeed', minKt: 69, maxKt: 79, lowHint: { text: 'Too slow: lower the nose', speech: 'Too slow. Lower the nose a little.' }, highHint: { text: 'Too fast: raise the nose', speech: 'Too fast. Raise the nose a little.' } }],
        progress: { metric: 'altitudeFt', to: 1500 },
      }],
    },
    {
      id: 'level1500',
      title: 'Level at 1,500 ft',
      instruction: {
        text: 'Level off at 1,500 ft: lower the nose to the horizon, let the speed build, then reduce power to about 2,300 rpm.',
        speech: 'Level off at one thousand five hundred feet. Lower the nose to the horizon, let the speed build, then reduce power to about two thousand three hundred r p m.',
      },
      objectives: [{
        type: 'hold', label: 'Hold 1,500 ft ±100, ±200 fpm for 10 s', forS: 10,
        all: [{ c: 'altitude', ft: 1500, tolFt: 100 }, { c: 'verticalSpeed', minFpm: -200, maxFpm: 200 }],
      }],
      success: { text: 'Level at 1,500 ft.', speech: 'Level at one thousand five hundred.' },
    },
  ],
  debrief: {
    pass: { text: 'Takeoff lesson complete. Next: bring it back down in the landing lesson.', speech: 'Takeoff lesson complete. Next, bring it back down in the landing lesson.' },
    fail: { text: 'Takeoff lesson incomplete. Keep it straight with the rudder and rotate at 55 knots.', speech: 'Takeoff lesson incomplete. Keep it straight with the rudder, and rotate at fifty five knots.' },
  },
};

// ─────────────────────────────── Landing ───────────────────────────────

/** Along-track aim point and touchdown zone of KHAF 30, m past the pavement threshold. */
const HAF_AIM_M = aimAlongM(KHAF_30);
export const KHAF_30_TDZ = { fromM: KHAF_30.displacedM, toM: KHAF_30.displacedM + 450 } as const;
const FINAL_NM = 3;
const finalStart = destinationPoint({ lat: KHAF_30.lat, lon: KHAF_30.lon, alt: 0 }, KHAF_30.headingDeg + 180, FINAL_NM * NM);
/** On the 3° path to the aim point at the start of the final. */
const finalAltFt = (KHAF_30.elevM + (FINAL_NM * NM + HAF_AIM_M) * Math.tan((3 * Math.PI) / 180)) * M_TO_FT;

export const LANDING: ActivityDef = {
  id: 'lesson-landing',
  kind: 'lesson',
  title: 'Landing',
  description: 'A 3 nm final to Half Moon Bay runway 30: flaps 30° by 1 nm, 60–65 KIAS on the 3° glidepath, then flare and touch down in the touchdown zone. The landing scorer grades it.',
  aircraft: 'c172',
  // 63 KIAS: inside the 60-65 band's scoring dead band (a spawn at 65, its edge, scored the speed objective at zero)
  setup: { spawn: 'air', lat: finalStart.lat, lon: finalStart.lon, altFt: finalAltFt, headingDeg: KHAF_30.headingDeg, iasKt: 63, flapsIndex: 2, gammaDeg: -3, weather: 'few', time: 'morning' },
  passScore: 0,
  steps: [
    {
      id: 'final',
      title: 'Final approach',
      instruction: {
        text: 'Three-mile final for runway 30 at Half Moon Bay, flaps 20°. Set flaps 30° before 1 nm, hold 60–65 KIAS and stay on the 3° glidepath.',
        speech: 'You are on a three mile final for runway three zero at Half Moon Bay, with flaps twenty. Set flaps thirty before one mile, hold sixty to sixty five knots, and stay on the three degree glidepath.',
      },
      objectives: [
        {
          type: 'reach', label: 'Flaps 30° by 1 nm', all: [{ c: 'flaps', minDeg: 30 }],
          failIf: [{ c: 'runwayDistance', runway: KHAF_30, maxNm: 1 }], failText: 'Flaps were not at 30° by 1 nm',
        },
        {
          type: 'maintain', label: 'Hold 60–65 KIAS', all: [{ c: 'airspeed', minKt: 60, maxKt: 65 }],
          until: [{ c: 'agl', maxFt: 100 }], progress: { metric: 'aglFt', to: 100 },
        },
        {
          type: 'maintain', label: 'Stay on the 3° glidepath', all: [{ c: 'glidepath', runway: KHAF_30, angleDeg: 3, tolDeg: 0.7, minTolFt: 20 }],
          until: [{ c: 'agl', maxFt: 100 }], progress: { metric: 'aglFt', to: 100 },
        },
      ],
      cues: [
        { when: [{ c: 'runwayDistance', runway: KHAF_30, maxNm: 1.6 }, { c: 'flaps', maxDeg: 25 }], line: { text: 'Flaps 30 now.', speech: 'Flaps thirty, now.' } },
        { when: [{ c: 'runwayDistance', runway: KHAF_30, maxNm: 0.5 }], line: { text: 'Half a mile. Aim point in the windshield, speed 60–65.', speech: 'Half a mile. Keep the aim point steady in the windshield.' }, important: false },
      ],
    },
    {
      id: 'touchdown',
      title: 'Flare and touch down',
      instruction: {
        text: 'Over the threshold: power to idle, flare gently and hold the nose off. Touch down in the touchdown zone and brake to a stop.',
        speech: 'Over the threshold, power to idle. Flare gently, and hold the nose off. Touch down in the touchdown zone, then brake to a stop.',
      },
      objectives: [{
        type: 'landing', label: 'Touch down in the zone with a landing score ≥ 4,000', minScore: 4000, runway: `${KHAF_30.icao} ${KHAF_30.ident}`, zone: KHAF_30_TDZ,
      }],
      cues: [{ when: [{ c: 'agl', maxFt: 20 }, { c: 'onGround', value: false }], line: { text: 'Flare: ease back, hold it off.', speech: 'Flare. Ease back, and hold it off.' } }],
      success: { text: 'Down and stopped.', speech: 'Down and stopped.' },
    },
  ],
  debrief: {
    pass: { text: 'Landing lesson complete. You are ready for a bush trip.', speech: 'Landing lesson complete. You are ready for a bush trip.' },
    fail: { text: 'Landing lesson incomplete. Configure early, fly a stable approach and the landing follows.', speech: 'Landing lesson incomplete. Configure early, fly a stable approach, and the landing will follow.' },
  },
};

export const LESSONS: readonly ActivityDef[] = [BASIC_FLIGHT, TAKEOFF, LANDING];

export function lessonById(id: string): ActivityDef | undefined { return LESSONS.find((l) => l.id === id); }
