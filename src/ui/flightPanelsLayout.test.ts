import { describe, expect, it } from 'vitest';
import { topRowY } from './flight/FlightPanels';

/**
 * Review: in the external views the instruments HUD draws its flight strip (IAS · heading tape ·
 * ALT, 620·k px wide, 12·k..76·k px from the top, k = clamp(min(h/600, (w−24)/620), 0.45, 1.6)),
 * and panels placed at y 70 covered the bottom of the IAS / heading / ALT boxes (the objectives
 * panel opens by itself at every activity start).
 */
describe('top-row panel placement clears the HUD flight strip', () => {
  it('moves a panel under the strip when it overlaps it horizontally (1280x720: strip 268..1012, bottom 91)', () => {
    expect(topRowY(16, 340, 1280, 720)).toBe(101); // objectives over the IAS box
    expect(topRowY(Math.round(1280 / 2 - 210), 420, 1280, 720)).toBe(101); // weather under the heading tape
    expect(topRowY(1280 - 396, 380, 1280, 720)).toBe(101); // ATC over the ALT box
  });
  it('keeps y 70 where the strip is out of the way', () => {
    expect(topRowY(16, 340, 1920, 1080)).toBe(70); // strip starts at x 464
    expect(topRowY(16, 340, 390, 844)).toBe(70); // phone: the strip ends at y 45
  });
});
