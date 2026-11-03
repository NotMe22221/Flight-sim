import { describe, expect, it } from 'vitest';
import { DrawPlanner, RangeList, tileId } from './drawPlan';
import type { SelectedNode } from './quadtree';

const node = (z: number, x: number, y: number, parentPatch = false): SelectedNode =>
  ({ z, x, y, key: `${z}/${x}/${y}`, level: 15 - z, parentPatch, distance: 0 });
const readySet = (keys: string[]) => {
  const s = new Set(keys);
  return (z: number, x: number, y: number): boolean => s.has(`${z}/${x}/${y}`);
};

describe('DrawPlanner', () => {
  it('draws ready nodes as themselves and parent patches as the parent quadrant', () => {
    const p = new DrawPlanner();
    const items = p.plan([node(15, 10, 20), node(15, 11, 21, true)], readySet(['15/10/20', '14/5/10']), 7);
    expect(items.length).toBe(2);
    expect(items[0]).toMatchObject({ z: 15, x: 10, y: 20, depth: 0, kind: 'self', node: 0 });
    // 15/11/21 is the SE quadrant (code 3) of 14/5/10
    expect(items[1]).toMatchObject({ z: 14, x: 5, y: 10, depth: 1, code: 3, kind: 'self', node: 1 });
    expect(p.exact).toBe(2);
    expect(p.holes).toBe(0);
  });

  it('falls back to the nearest ready ancestor restricted to the node area', () => {
    const p = new DrawPlanner();
    const items = p.plan([node(15, 13, 6)], readySet(['12/1/0', '11/0/0']), 7);
    expect(items.length).toBe(1);
    // 15/13/6 below 12/1/0: local offset (13 & 7, 6 & 7) = (5, 6) → Morton 0b111001 = 57
    expect(items[0]).toMatchObject({ z: 12, x: 1, y: 0, depth: 3, code: 57, kind: 'ancestor' });
  });

  it('prefers four ready children over a coarse ancestor (merge before the coarser tile arrives)', () => {
    const p = new DrawPlanner();
    const items = p.plan([node(14, 2, 2)], readySet(['15/4/4', '15/5/4', '15/4/5', '15/5/5', '10/0/0']), 7);
    expect(items.map((i) => `${i.z}/${i.x}/${i.y}:${i.kind}`)).toEqual(['15/4/4:child', '15/5/4:child', '15/4/5:child', '15/5/5:child']);
  });

  it('uses the node’s own tile when a parent patch’s parent is not ready', () => {
    const p = new DrawPlanner();
    const items = p.plan([node(15, 3, 3, true)], readySet(['15/3/3', '13/0/0']), 7);
    expect(items[0]).toMatchObject({ z: 15, x: 3, y: 3, depth: 0, kind: 'child' });
  });

  it('counts holes only when nothing at all is ready, and never searches below minZoom', () => {
    const p = new DrawPlanner();
    p.plan([node(15, 0, 0), node(15, 1, 0)], readySet(['6/0/0']), 7);
    expect(p.holes).toBe(2);
    p.plan([node(15, 0, 0)], readySet(['7/0/0']), 7);
    expect(p.holes).toBe(0);
  });
});

describe('RangeList', () => {
  it('sorts and merges touching ranges, keeps gaps', () => {
    const r = new RangeList();
    r.add(30, 10); r.add(0, 10); r.add(10, 5); r.add(50, 5); r.add(40, 2);
    r.normalize();
    expect(Array.from(r.data.subarray(0, 2 * r.n))).toEqual([0, 15, 30, 12, 50, 5]);
  });

  it('grows past its initial capacity', () => {
    const r = new RangeList();
    for (let i = 0; i < 100; i++) r.add(i * 10, 5);
    r.normalize();
    expect(r.n).toBe(100);
  });
});

describe('tileId', () => {
  it('is unique across zooms and neighbours', () => {
    const ids = new Set([tileId(15, 5246, 12684), tileId(15, 5247, 12684), tileId(15, 5246, 12685), tileId(14, 5246, 12684), tileId(22, 4194303, 4194303)]);
    expect(ids.size).toBe(5);
    expect(Number.isSafeInteger(tileId(31, 4194303, 4194303))).toBe(true);
  });
});
