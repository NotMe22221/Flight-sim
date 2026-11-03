import { describe, expect, it } from 'vitest';
import { clampPanelPosition } from './flight/FloatingPanel';

describe('clampPanelPosition', () => {
  it('centres a panel that is nearly as wide as a phone instead of leaving it flush with the edge', () => {
    // 374 px panel (max-width 100vw − 16px) on a 390 px screen, default x 16 → 8 px each side
    expect(clampPanelPosition(16, 70, 374, 390, 844)).toEqual({ x: 8, y: 70 });
    expect(clampPanelPosition(-50, 70, 374, 390, 844).x).toBe(8);
  });
  it('keeps desktop panels inside with a margin and the header reachable', () => {
    expect(clampPanelPosition(1200, 900, 380, 1280, 720)).toEqual({ x: 1280 - 380 - 8, y: 680 });
    expect(clampPanelPosition(-20, -5, 380, 1280, 720)).toEqual({ x: 8, y: 0 });
    expect(clampPanelPosition(300, 200, 380, 1280, 720)).toEqual({ x: 300, y: 200 });
  });
  it('a panel wider than the screen starts at the left edge', () => {
    expect(clampPanelPosition(100, 10, 500, 390, 844).x).toBe(0);
  });
});
