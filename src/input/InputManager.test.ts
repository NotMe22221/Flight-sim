import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SimAction } from '../core/types';
import { InputManager, type DeviceChangeEvent } from './InputManager';
import { BINDINGS_STORAGE_KEY } from './bindingStore';
import { FakeEvent, type FakeDom, makeFakeDom } from './testing/dom';

const DT = 1 / 60;

describe('InputManager', () => {
  let dom: FakeDom;
  let im: InputManager;
  const make = (): InputManager => new InputManager(dom.env.canvas, {
    window: dom.env.window, document: dom.env.document, navigator: dom.env.navigator, storage: dom.storage,
  });
  const run = (seconds: number, dt = DT): void => { for (let t = 0; t < seconds - 1e-9; t += dt) im.poll(dt); };
  const tap = (code: string, m?: { ctrl?: boolean; shift?: boolean; alt?: boolean }): SimAction[] => {
    dom.keyDown(code, m);
    const a = [...im.poll(DT).actions];
    dom.keyUp(code, m);
    im.poll(DT);
    return a;
  };

  beforeEach(() => { dom = makeFakeDom(); im = make(); });
  afterEach(() => { im.dispose(); });

  describe('keyboard flying', () => {
    it('arrow and numpad keys ramp pitch to full in 0.6 s and auto-centre in 0.3 s', () => {
      for (const code of ['ArrowUp', 'Numpad8']) {
        dom.keyDown(code);
        let frames = 0;
        while (im.controls.pitch > -1 && frames < 100) { im.poll(DT); frames++; }
        expect(Math.abs(frames * DT - 0.6)).toBeLessThanOrEqual(DT + 1e-9);
        expect(im.snapshot.axes.pitch).toBe(-1);
        dom.keyUp(code);
        frames = 0;
        while (im.controls.pitch !== 0 && frames < 100) { im.poll(DT); frames++; }
        expect(Math.abs(frames * DT - 0.3)).toBeLessThanOrEqual(2 * DT + 1e-9); // +1 frame: release is seen at the next poll
      }
    });

    it('throttle keys step 5 % per press, clamp, cut and full', () => {
      tap('F3');
      expect(im.controls.throttle).toBe(0.05);
      for (let i = 0; i < 25; i++) tap('F3');
      expect(im.controls.throttle).toBe(1);
      tap('F2');
      expect(im.controls.throttle).toBe(0.95);
      tap('F1');
      expect(im.controls.throttle).toBe(0);
      tap('F2');
      expect(im.controls.throttle).toBe(0);
      tap('F4');
      expect(im.controls.throttle).toBe(1);
      tap('F1');
      dom.keyDown('PageUp'); // hold: 5 % now, then 10 Hz after 300 ms
      run(1.0);
      dom.keyUp('PageUp');
      im.poll(DT);
      expect(im.controls.throttle).toBeCloseTo(0.05 + 0.05 * 7, 6);
    });

    it('Ctrl+E fires engineAutoStart, plain E does not (it is rudder)', () => {
      expect(tap('KeyE', { ctrl: true })).toEqual(['engineAutoStart']);
      dom.keyDown('KeyE');
      const actions = [...im.poll(DT).actions];
      expect(actions).toEqual([]);
      expect(im.controls.yaw).toBeGreaterThan(0);
      dom.keyUp('KeyE');
    });

    it('blur releases all keys and the brakes', () => {
      dom.keyDown('Period');
      dom.keyDown('ArrowLeft');
      run(0.5);
      expect(im.controls.brakeLeft).toBe(1);
      expect(im.snapshot.held.has('brakesHold')).toBe(true);
      dom.window.dispatchEvent(new FakeEvent('blur'));
      run(0.5);
      expect(im.snapshot.held.size).toBe(0);
      expect(im.controls.brakeLeft).toBe(0);
      expect(im.controls.roll).toBe(0);
    });

    it('captured flag suppresses keys; UI actions still apply', () => {
      im.setCaptured(true);
      expect(tap('KeyG')).toEqual([]);
      expect(im.controls.gearDown).toBe(true);
      im.applyAction('gearToggle');
      expect(im.controls.gearDown).toBe(false);
      expect([...im.poll(DT).actions]).toEqual(['gearToggle']);
      im.setCaptured(false);
      expect(tap('KeyG')).toEqual(['gearToggle']);
    });
  });

  describe('controls from actions', () => {
    it('flapsDown increments and clamps at the detent count', () => {
      im.setFlapDetents(4);
      for (let i = 0; i < 6; i++) tap('F7');
      expect(im.controls.flapsIndex).toBe(3);
      tap('F6');
      expect(im.controls.flapsIndex).toBe(2);
      im.setFlapDetents(2);
      expect(im.controls.flapsIndex).toBe(1);
      tap('F5');
      expect(im.controls.flapsIndex).toBe(0);
      tap('F8');
      expect(im.controls.flapsIndex).toBe(1);
    });

    it('gear, parking brake, lights, magnetos, heats, mixture, trims, spoilers', () => {
      const c = im.controls;
      im.applyAction('gearToggle'); expect(c.gearDown).toBe(false);
      expect(c.parkingBrake).toBe(true);
      tap('Period', { ctrl: true }); expect(c.parkingBrake).toBe(false);
      tap('KeyN', { alt: true }); expect(c.lights.nav).toBe(true);
      tap('KeyO'); expect(c.lights.strobe).toBe(true);
      tap('KeyL', { ctrl: true }); expect(c.lights.landing).toBe(true);
      tap('KeyJ', { alt: true }); expect(c.lights.taxi).toBe(true);
      tap('KeyH', { alt: true }); expect(c.lights.beacon).toBe(false); // default on → off
      tap('KeyL'); expect(c.lights).toMatchObject({ nav: true, beacon: true, strobe: true, landing: true, taxi: true });
      tap('KeyL'); expect(c.lights).toMatchObject({ nav: false, beacon: false, strobe: false, landing: false, taxi: false });
      expect(c.magnetos).toBe(3);
      tap('KeyM'); expect(c.magnetos).toBe(0);
      tap('KeyM'); expect(c.magnetos).toBe(1);
      tap('KeyM', { shift: true }); tap('KeyM', { shift: true }); expect(c.magnetos).toBe(3);
      tap('KeyH'); expect(c.carbHeat).toBe(true);
      tap('KeyH', { shift: true }); expect(c.pitotHeat).toBe(true);
      tap('F1', { ctrl: true, shift: true }); expect(c.mixture).toBe(0);
      tap('F3', { ctrl: true, shift: true }); expect(c.mixture).toBe(0.05);
      tap('Numpad1'); expect(c.pitchTrim).toBe(0.01);
      tap('BracketLeft'); tap('BracketLeft'); expect(c.pitchTrim).toBe(-0.01);
      tap('KeyE', { shift: true }); expect(c.rudderTrim).toBe(0.01);
      tap('ArrowLeft', { ctrl: true }); expect(c.aileronTrim).toBe(-0.01);
      tap('Slash'); expect(c.speedbrake).toBe(1);
      tap('F3', { ctrl: true }); expect(c.propeller).toBe(1);
      tap('F1', { ctrl: true }); expect(c.propeller).toBe(0);
    });

    it('starter is held while the key is down; brakes ramp in 0.25 s', () => {
      dom.keyDown('KeyG', { shift: true, alt: true });
      im.poll(DT);
      expect(im.controls.starter).toBe(true);
      expect(im.snapshot.held.has('starter')).toBe(true);
      dom.keyUp('KeyG');
      im.poll(DT); im.poll(DT);
      expect(im.controls.starter).toBe(false);
      dom.keyDown('NumpadDecimal');
      run(0.125);
      expect(im.controls.brakeLeft).toBeCloseTo(0.5, 1);
      run(0.15);
      expect(im.controls.brakeRight).toBe(1);
    });

    it('trim auto-repeats while held (10 Hz after 300 ms)', () => {
      dom.keyDown('Numpad7');
      run(0.95);
      expect(im.controls.pitchTrim).toBeCloseTo(-0.01 * 8, 6);
    });
  });

  describe('snapshot', () => {
    it('reuses one snapshot, actions array and held set', () => {
      const s1 = im.poll(DT);
      const a = s1.actions, h = s1.held;
      dom.keyDown('KeyG');
      const s2 = im.poll(DT);
      expect(s2).toBe(s1);
      expect(s2.actions).toBe(a);
      expect(s2.held).toBe(h);
      expect(s2.actions).toEqual(['gearToggle']);
      expect(im.poll(DT).actions).toEqual([]);
    });

    it('local actions are not reported; Alt+M toggles the mouse yoke', () => {
      expect(tap('KeyM', { alt: true })).toEqual([]);
      expect(im.snapshot.mouseYoke).toBe(true);
      dom.pointer('pointermove', { clientX: 400, clientY: 300 });
      dom.pointer('pointermove', { clientX: 650, clientY: 300 });
      im.poll(DT);
      expect(im.controls.roll).toBeGreaterThan(0.9);
      tap('KeyM', { alt: true });
      expect(im.snapshot.mouseYoke).toBe(false);
    });

    it('right-drag free-look deltas and wheel zoom reach the snapshot', () => {
      dom.pointer('pointerdown', { button: 2, buttons: 2, clientX: 10, clientY: 10 });
      dom.pointer('pointermove', { buttons: 2, clientX: 30, clientY: 15 });
      dom.wheel(-100);
      const s = im.poll(DT);
      expect([s.pointerDx, s.pointerDy]).toEqual([20, 5]);
      expect(s.axes.cameraZoom).toBeCloseTo(0.1, 6);
      expect(s.actions).toEqual(['zoomIn']);
      im.applyAction('cameraReset');
      expect(im.poll(DT).axes.cameraZoom).toBe(0);
    });
  });

  describe('gamepads and arbitration', () => {
    it('the last device to move owns an axis', () => {
      const pad = dom.addPad('Xbox 360 Controller (XInput STANDARD GAMEPAD)', 'standard');
      im.poll(DT);
      pad.setAxis(1, 0.6);
      im.poll(DT);
      expect(im.controls.pitch).toBeGreaterThan(0.3);
      dom.keyDown('ArrowUp');
      im.poll(DT);
      expect(im.controls.pitch).toBeLessThan(0);
      dom.keyUp('ArrowUp');
      run(0.5);
      expect(im.controls.pitch).toBe(0);
      pad.setAxis(1, 0.9);
      im.poll(DT);
      expect(im.controls.pitch).toBeGreaterThan(0.6);
    });

    it('a throttle slider owns the lever; keyboard steps resume after 2 s idle', () => {
      const stick = dom.addPad('046d-c215-Logitech Extreme 3D', '', 10, 12);
      stick.axes[9] = 3.2857;
      stick.axes[6] = 1; // slider at idle: first reading only primes, it does not move the throttle
      tap('F3');
      expect(im.controls.throttle).toBe(0.05);
      stick.setAxis(6, 0); // half
      im.poll(DT);
      expect(im.controls.throttle).toBeCloseTo(0.5, 6);
      tap('F3');
      expect(im.controls.throttle).toBeCloseTo(0.5, 6);
      run(2.1);
      tap('F3');
      expect(im.controls.throttle).toBeCloseTo(0.55, 6);
      stick.setAxis(6, -1);
      im.poll(DT);
      expect(im.controls.throttle).toBe(1);
    });

    it('reports connection and active-device changes', () => {
      const events: DeviceChangeEvent[] = [];
      const off = im.onDeviceChange((e) => events.push(e));
      const pad = dom.addPad('Xbox 360 Controller (XInput STANDARD GAMEPAD)', 'standard');
      im.poll(DT);
      pad.setButton(0, true);
      im.poll(DT);
      tap('KeyG');
      expect(events.map((e) => `${e.kind}:${e.device}`)).toEqual(['connected:gamepad', 'active:gamepad', 'active:keyboard']);
      off();
      dom.removePad(pad);
      expect(events.length).toBe(3);
    });

    it('labels prefer the active device', () => {
      expect(im.getBindingLabel('engineAutoStart')).toBe('Ctrl+E');
      expect(im.getBindingLabel('trimNoseDown')).toBe('Num 7');
      expect(im.getBindingLabels('trimNoseDown')).toEqual(['Num 7', '[']);
      expect(im.getBindingLabel('gearToggle')).toBe('G');
      expect(im.getBindingLabel('timeDawn')).toBe('');
      const pad = dom.addPad('Xbox 360 Controller (XInput STANDARD GAMEPAD)', 'standard');
      im.poll(DT);
      pad.setButton(3, true);
      im.poll(DT);
      expect(im.getBindingLabel('gearToggle')).toBe('Pad Y');
      expect(im.getBindingLabel('gearToggle', 'keyboard')).toBe('G');
      expect(im.getBindingLabel('engineAutoStart')).toBe('Ctrl+E'); // falls back to the keyboard
    });
  });

  describe('bindings management', () => {
    it('bindingsList has one row per SimAction with UI-compatible fields', () => {
      const rows = im.bindingsList();
      const gear = rows.find((r) => r.action === 'gearToggle');
      expect(gear).toMatchObject({ label: 'G', device: 'keyboard', group: 'Flaps, gear & brakes' });
      expect(rows.find((r) => r.action === 'timeDawn')?.device).toBe('none');
      expect(new Set(rows.map((r) => r.action)).size).toBe(rows.length);
      expect(im.controlsList().find((r) => r.id === 'axis:pitch:-1')?.labels).toEqual(['Num 8', '↑']);
    });

    it('startListening binds the next chord, displaces the old owner and persists', async () => {
      const p = im.startListening('gearToggle');
      dom.keyDown('ControlLeft', { ctrl: true }); // modifier-only: ignored
      dom.keyDown('KeyK', { ctrl: true });
      const r = await p;
      expect(r).toMatchObject({ action: 'gearToggle', label: 'Ctrl+K', device: 'keyboard', displaced: [] });
      dom.keyUp('KeyK', { ctrl: true });
      im.poll(DT);
      expect(tap('KeyK', { ctrl: true })).toEqual(['gearToggle']);
      expect(tap('KeyG')).toEqual([]);
      expect(dom.storage.map.has(BINDINGS_STORAGE_KEY)).toBe(true);
      // a new manager picks the binding up from storage
      im.dispose();
      im = make();
      expect(im.getBindingLabel('gearToggle')).toBe('Ctrl+K');
      // binding a used chord displaces its owner
      const p2 = im.startListening('pause');
      dom.keyDown('KeyK', { ctrl: true });
      expect((await p2)?.displaced.map((b) => ('action' in b ? b.action : ''))).toEqual(['gearToggle']);
      im.resetProfile();
      expect(dom.storage.map.has(BINDINGS_STORAGE_KEY)).toBe(false);
      expect(im.getBindingLabel('gearToggle')).toBe('G');
    });

    it('Escape cancels listening; a new listen cancels the previous one; gamepad buttons can be captured', async () => {
      const p = im.startListening('gearToggle');
      dom.keyDown('Escape');
      expect(await p).toBeNull();
      const p1 = im.startListening('gearToggle');
      const p2 = im.startListening('flapsDown', { device: 'gamepad' });
      expect(await p1).toBeNull();
      const pad = dom.addPad('Xbox 360 Controller (XInput STANDARD GAMEPAD)', 'standard');
      im.poll(DT); im.poll(DT);
      pad.setButton(1, true);
      im.poll(DT);
      expect(await p2).toMatchObject({ action: 'flapsDown', label: 'Pad B', device: 'gamepad' });
      expect([...im.poll(DT).actions]).toEqual([]); // still holding the captured button: no action yet
      pad.setButton(1, false);
      im.poll(DT);
      pad.setButton(1, true);
      expect([...im.poll(DT).actions]).toEqual(['flapsDown']);
    });

    it('holding the key just captured (OS repeat) does not fire the new action', async () => {
      const p = im.startListening('gearToggle');
      dom.keyDown('KeyK');
      expect((await p)?.label).toBe('K');
      dom.keyDown('KeyK', { repeat: true });
      dom.keyDown('KeyK', { repeat: true });
      expect([...im.poll(DT).actions]).toEqual([]);
      dom.keyUp('KeyK');
      im.poll(DT);
      expect(tap('KeyK')).toEqual(['gearToggle']);
    });

    it('a joystick profile chosen with no pad connected applies to HID devices only', () => {
      im.setProfile('joystick-generic');
      const pad = dom.addPad('Xbox 360 Controller (XInput STANDARD GAMEPAD)', 'standard');
      im.poll(DT);
      expect(im.gamepadProfile(pad.index)?.id).toBe('gamepad-xbox');
      const stick = dom.addPad('Some Stick (Vendor: 1234 Product: 5678)', '', 10, 12);
      im.poll(DT);
      expect(im.gamepadProfile(stick.index)?.id).toBe('joystick-generic');
      im.resetProfile('joystick-generic');
      expect(JSON.parse(dom.storage.map.get(BINDINGS_STORAGE_KEY) ?? '{"gamepads":{}}').gamepads).toEqual({});
    });

    it('keys bound directly to a lever axis move it at the lever rate (taps included)', () => {
      im.setProfile({ version: 1, id: 'x', name: 'x', device: 'keyboard', bindings: [
        { device: 'keyboard', code: 'KeyW', axis: 'throttle', dir: 1 },
        { device: 'keyboard', code: 'KeyS', axis: 'throttle', dir: -1 },
      ] });
      dom.keyDown('KeyW');
      run(1);
      expect(im.controls.throttle).toBeCloseTo(0.5, 6);
      dom.keyUp('KeyW');
      im.poll(DT);
      const t = im.controls.throttle;
      dom.tap('KeyS');
      im.poll(DT);
      expect(im.controls.throttle).toBeCloseTo(t - 0.5 * DT, 6);
      expect(im.snapshot.axes.throttle).toBe(im.controls.throttle);
    });

    it('setProfile switches layouts and resetProfile restores the default', () => {
      im.setProfile('msfs');
      dom.keyDown('ArrowUp');
      run(0.2);
      expect(im.controls.pitch).toBe(0);
      dom.keyUp('ArrowUp');
      im.resetProfile('default');
      dom.keyDown('ArrowUp');
      run(0.2);
      expect(im.controls.pitch).toBeLessThan(0);
      expect(im.conflicts()).toEqual([]);
    });

    it('dispose removes every listener', () => {
      im.enableTouch(dom.env.document.body);
      im.dispose();
      expect(dom.window.listenerCount()).toBe(0);
      expect(dom.document.listenerCount()).toBe(0);
      expect(dom.canvas.listenerCount()).toBe(0);
      expect(dom.document.body.children.length).toBe(1); // only the canvas remains
    });
  });
});
