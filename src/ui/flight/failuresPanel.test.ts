import { afterEach, describe, expect, it } from 'vitest';
import type { FailureId, SimSnapshot } from '../../core/types';
import { buttonByText, installFakeDom, type FakeDomHandle } from '../testing/fakeDom';
import type { UiHost } from '../UiHost';
import { FailuresPanel } from './FailuresPanel';

let dom: FakeDomHandle | null = null;
afterEach(() => { dom?.uninstall(); dom = null; });

function fakeHost() {
  const failed = new Set<FailureId>();
  let random = false;
  const host = {
    setFailure: (id: FailureId, on: boolean) => { if (on) failed.add(id); else failed.delete(id); },
    setRandomFailures: (on: boolean) => { random = on; },
    randomFailures: () => random,
  } as unknown as UiHost;
  return { host, failed, isRandom: () => random };
}

describe('FailuresPanel', () => {
  it('switches fail and repair systems, repair all clears them, and state from the sim is shown', () => {
    dom = installFakeDom();
    const { host, failed, isRandom } = fakeHost();
    const box = document.createElement('div');
    document.body.appendChild(box);
    const panel = new FailuresPanel(box as unknown as HTMLElement, host);
    const switches = (box as unknown as { querySelectorAll(s: string): { click(): void; classList: { contains(c: string): boolean } }[] }).querySelectorAll('button.toggle');
    expect(switches.length).toBe(8); // seven systems + random
    switches[1].click(); // vacuum
    expect([...failed]).toEqual(['vacuum']);
    switches[7].click();
    expect(isRandom()).toBe(true);
    // a random failure the sim applied shows up on the next update
    panel.update({ failures: { pitot: true, vacuum: true } } as unknown as SimSnapshot);
    expect(switches[2].classList.contains('on')).toBe(true);
    buttonByText(box as never, 'Repair all').click();
    expect(failed.size).toBe(0);
  });

  it('explains when the host has no failures', () => {
    dom = installFakeDom();
    const box = document.createElement('div');
    new FailuresPanel(box as unknown as HTMLElement, {} as UiHost);
    expect((box as unknown as { textContent: string }).textContent).toContain('not available');
  });
});
