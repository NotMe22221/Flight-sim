/**
 * The activities UI driven end to end in Node: UiManager over a fake DOM, a fake simulator running
 * the real ActivityRunner and ProgressStore (testing/activityHarness.ts). Each test walks a flow a
 * player can take (start, pause menu, restart, abort, crash, debrief, next leg) and checks what is
 * left on screen and whether the simulator is left paused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonByText, domWrites, type FakeElement } from './testing/fakeDom';
import { makeHarness, quickLeg, quickLesson, type Harness } from './testing/activityHarness';

let t: Harness;
beforeEach(async () => { t = await makeHarness(); });
afterEach(() => t.dispose());

const visible = (el: FakeElement | null) => !!el && el.classList.contains('visible') && el.rendered;
const pauseMenu = () => t.q('.pause-menu')!.parentElement as FakeElement;
const debrief = () => t.q('.debrief-backdrop');
const subtitle = () => t.q('.instructor-subtitle');
const objectivesPanel = () => t.q('.objectives-panel');
const objectivesButton = () => t.q('.toolbar-btn[data-item="objectives"]')!.parentElement as FakeElement;

async function openActivities(tab: 'training' | 'bush'): Promise<void> {
  buttonByText(t.q('.main-menu')!, 'Activities').click();
  await t.run(50);
  t.q(`.act-modes .tab[data-tab="${tab}"]`)!.click();
  await t.run(50);
}

async function startQuickLesson(holdS = 1, steps = 1): Promise<void> {
  t.sim.lessons.set('lesson-basic-flight', quickLesson('lesson-basic-flight', holdS, steps));
  await openActivities('training');
  t.q('.lesson-card[data-lesson="lesson-basic-flight"]')!.click();
  await t.run(50);
  buttonByText(t.q('.activities .act-detail')!, 'Start').click();
  await t.run(200);
  expect(t.ui.current).toBe('flight');
  expect(t.sim.runner.phase).toBe('running');
}

describe('activities UI flows (fake DOM, real runner)', () => {
  it('starts a lesson from Flight training: objectives panel, toolbar button and the first instruction', async () => {
    await startQuickLesson(30);
    expect(visible(objectivesPanel())).toBe(true);
    expect(objectivesButton().style.display).toBe('');
    expect(visible(subtitle())).toBe(true);
    expect(subtitle()!.textContent).toContain('Instruction 1');
  });
});

const esc = async () => { t.ui.handleAction('toggleMenu'); await t.run(50); };
const toastTexts = () => t.root.querySelectorAll('.toast').map((e) => e.textContent);

describe('review: pause state after a debrief or a failed restart', () => {
  it('after a crash, Close on the debrief opens the Crashed menu and its Resume really resumes', async () => {
    await startQuickLesson(60);
    await t.run(500);
    t.sim.events.emit('aircraft:crash', { reason: 'impact' });
    await t.run(2500);
    expect(visible(debrief())).toBe(true);
    expect(t.sim.paused).toBe(true);
    buttonByText(t.q('.debrief')!, 'Close').click();
    await t.run(50);
    expect(visible(pauseMenu())).toBe(true);
    expect(t.q('.pause-title')!.textContent).toBe('Crashed');
    buttonByText(t.q('.pause-menu')!, 'Resume flight').click();
    await t.run(100);
    expect(visible(pauseMenu())).toBe(false);
    expect(t.sim.paused).toBe(false);
  });

  it('a debrief Retry whose spawn fails comes back to the pause menu, not to a silently paused flight', async () => {
    await startQuickLesson(1);
    await t.run(4000);
    expect(visible(debrief())).toBe(true);
    t.sim.spawnError = new Error('offline');
    buttonByText(t.q('.debrief')!, 'Retry').click();
    await t.run(300);
    expect(t.ui.current).toBe('flight');
    expect(toastTexts().some((x) => x.includes('offline'))).toBe(true);
    // either flying again or paused with the menu up; never paused with nothing to resume from
    expect(!t.sim.paused || visible(pauseMenu())).toBe(true);
    if (visible(pauseMenu())) {
      buttonByText(t.q('.pause-menu')!, 'Resume flight').click();
      await t.run(100);
      expect(t.sim.paused).toBe(false);
    }
  });

  it('a pause-menu Restart activity whose spawn fails comes back to the pause menu', async () => {
    await startQuickLesson(60);
    await t.run(500);
    await esc();
    expect(visible(pauseMenu())).toBe(true);
    t.sim.spawnError = new Error('offline');
    buttonByText(t.q('.pause-menu')!, 'Restart activity').click();
    await t.run(300);
    expect(t.ui.current).toBe('flight');
    expect(!t.sim.paused || visible(pauseMenu())).toBe(true);
  });
});

describe('review: nothing stale on screen', () => {
  it('the closing line does not come back after the debrief closes (the debrief carries it)', async () => {
    await startQuickLesson(1);
    await t.run(4000);
    expect(visible(debrief())).toBe(true);
    buttonByText(t.q('.debrief')!, 'Close').click();
    await t.run(200);
    expect(t.sim.paused).toBe(false);
    expect(visible(subtitle())).toBe(false);
  });

  it('a start of another lesson that fails leaves no dead activity in the objectives panel or toolbar', async () => {
    await startQuickLesson(60);
    await t.run(500);
    await esc();
    buttonByText(t.q('.pause-menu')!, 'Main menu').click();
    await t.run(50);
    t.sim.lessons.set('lesson-takeoff', quickLesson('lesson-takeoff', 60));
    await openActivities('training');
    t.q('.lesson-card[data-lesson="lesson-takeoff"]')!.click();
    await t.run(50);
    t.sim.spawnError = new Error('offline');
    buttonByText(t.q('.activities .act-detail')!, 'Start').click();
    await t.run(300);
    expect(t.sim.runner.phase).toBe('idle');
    // back to the flight from the menus
    t.ui.show('flight');
    await t.run(100);
    expect(objectivesButton().style.display).toBe('none');
    expect(visible(objectivesPanel())).toBe(false);
    expect(visible(subtitle())).toBe(false);
  });
});

describe('flows a player takes', () => {
  it('pause menu during a lesson: activity line, Restart step resumes and repeats the step instruction', async () => {
    await startQuickLesson(60, 2);
    await t.run(7000); // past the first instruction's display time
    await esc();
    expect(t.q('.pause-activity')!.textContent).toBe('Lesson · Basic flight controls · step 1 of 2');
    expect(byLabel('Restart activity')).toBe(true);
    buttonByText(t.q('.pause-menu')!, 'Restart step').click();
    await t.run(100);
    expect(visible(pauseMenu())).toBe(false);
    expect(t.sim.paused).toBe(false);
    expect(visible(subtitle())).toBe(true);
    expect(subtitle()!.textContent).toContain('Instruction 1');
  });

  it('Abort activity: free flight with no objectives, toolbar button, subtitle or route left', async () => {
    t.sim.legs.set(0, quickLeg(0, 600));
    await openActivities('bush');
    t.q('.leg-row[data-leg="0"]')!.click();
    await t.run(50);
    buttonByText(t.q('.activities .act-detail')!, 'Start').click();
    await t.run(200);
    expect(t.sim.route?.map((w) => w.id)).toEqual(['KHAF', 'CRYSTL', 'HOOVER', 'KRHV']);
    expect(t.q('.obj-kind')!.textContent).toBe('Bush trip');
    await esc();
    buttonByText(t.q('.pause-menu')!, 'Abort activity').click();
    await t.run(50);
    expect(visible(pauseMenu())).toBe(true);
    expect(t.q('.pause-note')!.textContent).toContain('Activity aborted');
    expect(byLabel('Restart flight')).toBe(true);
    expect(t.q('.pause-activity')!.style.display).toBe('none');
    buttonByText(t.q('.pause-menu')!, 'Resume flight').click();
    await t.run(100);
    expect(t.sim.paused).toBe(false);
    expect(t.sim.route).toBe(null);
    expect(objectivesButton().style.display).toBe('none');
    expect(visible(objectivesPanel())).toBe(false);
    expect(visible(subtitle())).toBe(false);
    await t.run(3000);
    expect(visible(debrief())).toBe(false);
    // the next pause menu is a plain one
    await esc();
    expect(t.q('.pause-note')!.style.display).toBe('none');
  });

  it('bush trip: locked legs cannot start; a completed leg unlocks Next leg in the debrief and in Activities', async () => {
    t.sim.legs.set(0, quickLeg(0, 1));
    t.sim.legs.set(1, quickLeg(1, 600));
    await openActivities('bush');
    // leg 2 is locked: Start disabled, Enter on the row does not start it
    t.q('.leg-row[data-leg="1"]')!.click();
    await t.run(50);
    const start = buttonByText(t.q('.activities .act-detail')!, 'Start');
    expect(start.disabled).toBe(true);
    start.click();
    t.q('.leg-row[data-leg="1"]')!.dispatchEvent(new (globalThis as unknown as { KeyboardEvent: new (t: string, i: object) => Event }).KeyboardEvent('keydown', { key: 'Enter' }) as never);
    await t.run(200);
    expect(t.sim.spawns).toBe(0);
    // fly leg 1
    t.q('.leg-row[data-leg="0"]')!.click();
    await t.run(50);
    buttonByText(t.q('.activities .act-detail')!, 'Start').click();
    await t.run(4000);
    expect(visible(debrief())).toBe(true);
    const next = buttonByText(t.q('.debrief')!, 'Next leg');
    expect(next.textContent).toContain('KRHV → KWVI');
    next.click();
    await t.run(300);
    expect(t.sim.runner.def?.trip).toEqual({ tripId: 'pacific-coast', legIndex: 1 });
    expect(t.sim.paused).toBe(false);
    expect(t.q('.obj-title')!.textContent).toContain('KRHV');
    expect(t.sim.route?.[0].id).toBe('KRHV');
    // Activities shows the progress
    await esc();
    buttonByText(t.q('.pause-menu')!, 'Main menu').click();
    await t.run(50);
    await openActivities('bush');
    expect(t.q('.trip-progress-text')!.textContent).toBe('1 / 8 legs');
    expect(t.q('.leg-row[data-leg="0"]')!.classList.contains('completed')).toBe(true);
    expect(t.q('.leg-row[data-leg="1"]')!.classList.contains('next')).toBe(true);
    expect(t.q('.leg-row[data-leg="2"]')!.classList.contains('locked')).toBe(true);
  });

  it('a double click on Start spawns once', async () => {
    t.sim.lessons.set('lesson-basic-flight', quickLesson('lesson-basic-flight', 60));
    await openActivities('training');
    const start = buttonByText(t.q('.activities .act-detail')!, 'Start');
    start.click();
    start.click();
    await t.run(300);
    expect(t.sim.spawns).toBe(1);
  });

  it('a flight changed under the activity (automation, far away) ends it with a toast and no debrief', async () => {
    await startQuickLesson(60);
    await t.run(500);
    t.sim.events.emit('flight:reset', { spawn: { geo: { lat: 47, lon: 8, alt: 500 }, headingRad: 0, speedMs: 0, onGround: true, engineRunning: true } });
    await t.run(2500);
    expect(t.sim.runner.phase).toBe('finished');
    expect(visible(debrief())).toBe(false);
    expect(toastTexts().some((x) => x.includes('the flight changed'))).toBe(true);
    expect(objectivesButton().style.display).toBe('none');
    expect(visible(subtitle())).toBe(false);
  });

  it('Esc closes the debrief and resumes; the pause menu then offers a plain Restart flight', async () => {
    await startQuickLesson(1);
    await t.run(4000);
    expect(visible(debrief())).toBe(true);
    await esc();
    expect(visible(debrief())).toBe(false);
    expect(t.sim.paused).toBe(false);
    await esc();
    expect(byLabel('Restart flight')).toBe(true);
    expect(t.q('.pause-activity')!.style.display).toBe('none');
    buttonByText(t.q('.pause-menu')!, 'Restart flight').click();
    await t.run(200);
    expect(t.sim.dispatched).toContain('resetFlight');
    expect(objectivesButton().style.display).toBe('none');
  });

  it('dispose leaves no window/document listeners and no timers behind', async () => {
    await startQuickLesson(1);
    await t.run(1500); // finished: the debrief timer is pending
    t.ui.dispose();
    await t.run(0);
    expect(t.dom.window.listenerCount()).toBe(0);
    expect(t.dom.document.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

function byLabel(label: string): boolean {
  return t.root.querySelectorAll('.pause-menu .btn-label').some((e) => e.textContent === label && e.rendered);
}

describe('review: z-order and placement in flight', () => {
  const panel = (id: string) => t.q(`.floating-panel[data-panel="${id}"]`)!;
  const toolbarClick = (id: string) => t.q(`.toolbar-btn[data-item="${id}"]`)!.click();

  it('a new activity brings its (already open) objectives panel in front of a panel opened later', async () => {
    await startQuickLesson(60);
    toolbarClick('checklist');
    await t.run(50);
    expect(panel('checklist').style.zIndex).toBe('1');
    expect(panel('objectives').style.zIndex).toBe('');
    // the lesson is replaced by another one: the objectives panel was never closed
    await esc();
    buttonByText(t.q('.pause-menu')!, 'Restart activity').click();
    await t.run(300);
    expect(t.sim.runner.phase).toBe('running');
    expect(panel('objectives').style.zIndex).toBe('1');
  });

  it('the checklist opens beside the objectives panel, not exactly on top of it', async () => {
    await startQuickLesson(60);
    toolbarClick('checklist');
    await t.run(50);
    expect(panel('objectives').style.left).toBe('16px');
    expect(panel('checklist').style.left).toBe('368px');
    // without an activity it is back in its own top-left place
    await esc();
    buttonByText(t.q('.pause-menu')!, 'Abort activity').click();
    buttonByText(t.q('.pause-menu')!, 'Resume flight').click();
    await t.run(50);
    toolbarClick('checklist');
    toolbarClick('checklist');
    await t.run(50);
    expect(panel('checklist').style.left).toBe('16px');
  });

  it('instructor lines sit above the floating panels, at the top in the cockpit view', async () => {
    t.sim.snap.camera.mode = 'cockpit';
    await startQuickLesson(60);
    expect(subtitle()!.parentElement!.classList.contains('ui-layer-flight')).toBe(true);
    expect(subtitle()!.classList.contains('top')).toBe(true);
    t.sim.snap.camera.mode = 'chase';
    await t.run(50);
    expect(subtitle()!.classList.contains('top')).toBe(false);
  });

  it('Restart step shows the step instruction at once (no stale hint in front of it)', async () => {
    await startQuickLesson(60);
    await t.run(7000);
    t.sim.events.emit('activity:instruction', { text: 'Too low: climb to 3,000 ft', important: false });
    await t.run(100);
    expect(subtitle()!.textContent).toContain('Too low');
    await esc();
    buttonByText(t.q('.pause-menu')!, 'Restart step').click();
    await t.run(100);
    expect(subtitle()!.textContent).toContain('Instruction 1');
  });
});

describe('review: keyboard focus', () => {
  it('after Abort activity the keyboard focus is on Resume flight, not on the hidden Abort button', async () => {
    await startQuickLesson(60);
    await esc();
    const abort = buttonByText(t.q('.pause-menu')!, 'Abort activity');
    abort.focus();
    abort.click();
    await t.run(50);
    const active = t.dom.document.activeElement;
    expect(active.tagName).toBe('BUTTON');
    expect(active.rendered).toBe(true);
    expect(active.textContent).toBe('Resume flight');
  });
});

describe('review: per-frame cost', () => {
  it('steady frames during an activity (objectives panel open, live bar polled) write almost nothing to the DOM', async () => {
    await startQuickLesson(600); // the hold's progress creeps up by 1/600 per second
    await t.run(8000); // the first instruction has gone
    domWrites.count = 0;
    await t.run(2000); // 40 frames
    expect(domWrites.count).toBeLessThan(8);
  });
});

describe('review: a new free flight replaces the activity', () => {
  it('New flight from the main menu during a lesson: quiet end, nothing of the lesson left in flight', async () => {
    await startQuickLesson(60);
    await t.run(500);
    await esc();
    buttonByText(t.q('.pause-menu')!, 'Main menu').click();
    await t.run(50);
    buttonByText(t.q('.main-menu')!, 'New flight').click();
    await t.run(3000);
    expect(t.ui.current).toBe('flight');
    expect(t.sim.runner.phase).toBe('finished');
    expect(t.sim.runner.result?.reason).toBe('Aborted');
    expect(t.sim.paused).toBe(false);
    expect(visible(debrief())).toBe(false);
    expect(visible(pauseMenu())).toBe(false);
    expect(toastTexts().filter((x) => /lesson|aborted/i.test(x))).toEqual([]);
    expect(objectivesButton().style.display).toBe('none');
    expect(visible(objectivesPanel())).toBe(false);
    expect(visible(subtitle())).toBe(false);
  });
});

describe('review: the pause menu does not jump under the pointer', () => {
  const items = () => t.root.querySelectorAll('.pause-menu .menu-list button').filter((b) => b.rendered).map((b) => b.textContent);
  it('after Abort activity the rows stay where they were (Abort greyed out) until the menu closes', async () => {
    await startQuickLesson(60);
    await esc();
    const before = items();
    expect(before).toEqual(['Resume flight', 'Restart step', 'Restart activity', 'Abort activity', 'World map', 'Settings', 'Main menu']);
    const abort = buttonByText(t.q('.pause-menu')!, 'Abort activity');
    abort.click();
    await t.run(50);
    // same rows in the same places: a double click on Abort lands on a disabled Abort, not on World map
    expect(items()).toEqual(['Resume flight', 'Restart step', 'Restart flight', 'Abort activity', 'World map', 'Settings', 'Main menu']);
    expect(abort.disabled).toBe(true);
    abort.click();
    await t.run(50);
    expect(t.ui.current).toBe('flight');
    expect(visible(pauseMenu())).toBe(true);
    // the next time the menu opens it is a plain one
    buttonByText(t.q('.pause-menu')!, 'Resume flight').click();
    await t.run(50);
    await esc();
    expect(items()).toEqual(['Resume flight', 'Restart flight', 'World map', 'Settings', 'Main menu']);
  });
});

describe('review: pause menu keeps the keyboard', () => {
  it('a press on a greyed-out item or the card itself does not take the focus away from the menu', async () => {
    await startQuickLesson(60);
    await esc();
    const abort = buttonByText(t.q('.pause-menu')!, 'Abort activity');
    abort.click();
    await t.run(50);
    // the second press of a double click lands on the disabled Abort: the browser would blur Resume
    const down = new (globalThis as unknown as { MouseEvent: new (t: string, i?: object) => { defaultPrevented: boolean } }).MouseEvent('mousedown', { bubbles: true });
    abort.dispatchEvent(down as never);
    expect(down.defaultPrevented).toBe(true);
    const onCard = new (globalThis as unknown as { MouseEvent: new (t: string, i?: object) => { defaultPrevented: boolean } }).MouseEvent('mousedown', { bubbles: true });
    t.q('.pause-title')!.dispatchEvent(onCard as never);
    expect(onCard.defaultPrevented).toBe(true);
    // an enabled item keeps its normal press
    const onResume = new (globalThis as unknown as { MouseEvent: new (t: string, i?: object) => { defaultPrevented: boolean } }).MouseEvent('mousedown', { bubbles: true });
    buttonByText(t.q('.pause-menu')!, 'Resume flight').dispatchEvent(onResume as never);
    expect(onResume.defaultPrevented).toBe(false);
  });
});
