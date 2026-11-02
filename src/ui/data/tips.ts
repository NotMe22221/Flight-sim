/** Loading-screen tips. Keep each under ~110 characters. */
export const LOADING_TIPS: string[] = [
  'Ctrl+E starts the engine automatically. The checklist panel walks you through the real procedure.',
  'Trim for speed: a trimmed Cessna 172 holds its airspeed hands-off. Use the trim keys often.',
  'Full throttle on the takeoff roll needs about a quarter of right rudder to stay on the centreline.',
  'Rotate the C172 at about 55 KIAS and climb at 74 KIAS (Vy) for the best rate of climb.',
  'Power-off stall speed is 48 KIAS with full flaps and 55 KIAS clean. Listen for the horn.',
  'Move the pointer to the top edge of the screen to open the toolbar: ATC, cameras, checklist, map.',
  'The World Map lets you spawn on any runway (engine running) or at parking, cold and dark.',
  'Press B to set the altimeter to the local QNH before takeoff and when descending for landing.',
  'The autopilot (Z) can hold heading, altitude, vertical speed and fly an ILS approach with APR.',
  'Esc pauses the flight. Pause/Break toggles Active Pause with the world frozen around you.',
  'Weather presets go from Clear Skies to Storm; Custom lets you stack three cloud layers.',
  'Time of day can be changed in flight from the Weather & Time panel; try golden hour over the Bay.',
  'Drone camera: W/A/S/D move, R/F up and down, the mouse looks. The aircraft keeps flying.',
  'Landing score weights: centreline 30 %, touchdown rate 35 %, aim point 15 %, stopping 20 %.',
  'Lean the mixture in cruise above 3,000 ft for best power and range.',
  'Assistance presets: All Assists, Middle Ground, True to Life, each tunable per item in Settings.',
  'Hold the right mouse button to look around the cockpit; the scroll wheel zooms.',
  'Flaps 10° for a short-field takeoff; retract once above 60 KIAS and clear of obstacles.',
];

export function randomTip(exclude?: string): string {
  const pool = LOADING_TIPS.filter((t) => t !== exclude);
  return pool[Math.floor(Math.random() * pool.length)] ?? LOADING_TIPS[0];
}
