import { beforeEach, describe, expect, it } from 'vitest';
import { type BindableAction, axisIndexOf } from './actions';
import type { BindingProfile } from './bindings';
import { GamepadSource, type PadInfo } from './gamepad';
import { HAT_DOWN, HAT_LEFT, HAT_RIGHT, HAT_UP, decodeHat, detectPlatform, parseGamepadId, resolvePreset } from './gamepadId';
import { type ProfileId, defaultProfile, joystickBindings } from './profiles';
import { FakeGamepad, type FakeDom, makeFakeDom } from './testing/dom';

describe('gamepad ids, hats and presets', () => {
  it('parses Chrome, Firefox and Safari id formats', () => {
    expect(parseGamepadId('Logitech Extreme 3D (Vendor: 046d Product: c215)')).toEqual({ vendor: '046d', product: 'c215', name: 'Logitech Extreme 3D', xinput: false });
    expect(parseGamepadId('046d-c215-Logitech Extreme 3D')).toMatchObject({ vendor: '046d', product: 'c215', name: 'Logitech Extreme 3D' });
    expect(parseGamepadId('46d-c215-Logicool Extreme 3D')).toMatchObject({ vendor: '046d', product: 'c215' });
    expect(parseGamepadId('Xbox 360 Controller (XInput STANDARD GAMEPAD)').xinput).toBe(true);
    expect(parseGamepadId('xinput').xinput).toBe(true);
  });

  it('decodes a POV hat axis including diagonals and the centred values', () => {
    const pos = (k: number): number => -1 + (k * 2) / 7;
    expect(decodeHat(pos(0))).toBe(HAT_UP);
    expect(decodeHat(pos(1))).toBe(HAT_UP | HAT_RIGHT);
    expect(decodeHat(pos(2))).toBe(HAT_RIGHT);
    expect(decodeHat(pos(4))).toBe(HAT_DOWN);
    expect(decodeHat(pos(6))).toBe(HAT_LEFT);
    expect(decodeHat(pos(7))).toBe(HAT_UP | HAT_LEFT);
    expect(decodeHat(3.2857)).toBe(0);
    expect(decodeHat(1.2857)).toBe(0);
    expect(decodeHat(0)).toBe(0);
  });

  it('resolves presets by VID:PID, mapping and platform', () => {
    const e3d = resolvePreset('046d-c215-Logitech Extreme 3D', '', 'windows');
    expect(e3d.preset.id).toBe('extreme-3d-pro');
    expect(e3d.deviceKey).toBe('hid:046d:c215');
    expect(e3d.layout?.throttle).toBe(6);
    expect(resolvePreset('046d-c215-Logitech Extreme 3D', '', 'linux').layout?.throttle).toBe(3);
    expect(resolvePreset('Thrustmaster T.16000M (Vendor: 044f Product: b10a)', '').preset.id).toBe('t16000m');
    expect(resolvePreset('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', 'standard').preset.id).toBe('dualsense');
    expect(resolvePreset('Xbox 360 Controller (XInput STANDARD GAMEPAD)', 'standard').preset.id).toBe('generic-gamepad');
    expect(resolvePreset('Some Stick (Vendor: 1234 Product: 5678)', '').preset.id).toBe('generic-joystick');
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
  });
});

describe('GamepadSource', () => {
  let dom: FakeDom;
  let src: GamepadSource;
  let now = 0;
  const edges: BindableAction[] = [];
  const held = new Set<BindableAction>();
  const events: Array<[PadInfo, boolean]> = [];
  const profileFor = (r: ReturnType<typeof resolvePreset>): BindingProfile => {
    if (r.layout && r.preset.profile === 'joystick-generic') return { ...defaultProfile('joystick-generic'), bindings: joystickBindings(r.layout) };
    return defaultProfile(r.preset.profile as ProfileId);
  };
  const poll = (dt = 1 / 60): number => { edges.length = 0; held.clear(); now += dt; return src.poll(dt, now, (a) => edges.push(a), (a) => held.add(a)); };
  const val = (axis: Parameters<typeof axisIndexOf>[0]): number => src.value(axisIndexOf(axis));

  beforeEach(() => {
    dom = makeFakeDom();
    src = new GamepadSource(dom.env.window, dom.env.navigator, profileFor);
    src.onConnection = (p, c) => events.push([p, c]);
    src.attach();
    events.length = 0;
    now = 0;
  });

  it('connects and disconnects via events and polling', () => {
    const pad = dom.addPad('Xbox 360 Controller (XInput STANDARD GAMEPAD)', 'standard');
    expect(events.map(([p, c]) => [p.presetId, c])).toEqual([['generic-gamepad', true]]);
    poll();
    expect(src.connected().length).toBe(1);
    dom.removePad(pad);
    expect(events[1][1]).toBe(false);
    expect(src.connected().length).toBe(0);
    // a pad that appears without an event is picked up by polling
    dom.navigator.pads[0] = new FakeGamepad('046d-c215-Logitech Extreme 3D', 0, '', 10, 12);
    poll();
    expect(src.connected()[0].presetId).toBe('extreme-3d-pro');
  });

  it('maps standard-mapping buttons to actions with edges, repeats and held levels', () => {
    const pad = dom.addPad('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', 'standard');
    poll();
    pad.setButton(5, true); // RB
    poll();
    expect(edges).toEqual(['flapsDown']);
    poll();
    expect(edges).toEqual([]);
    pad.setButton(5, false);
    pad.setButton(2, true); // X = brakes (held)
    poll();
    expect(edges).toEqual(['brakesHold']);
    expect(held.has('brakesHold')).toBe(true);
    pad.setButton(2, false);
    poll();
    poll();
    expect(held.has('brakesHold')).toBe(false);
    pad.setButton(3, true); poll(); expect(edges).toEqual(['gearToggle']);
    pad.setButton(10, true); poll(); expect(edges).toEqual(['parkingBrakeToggle']);
    pad.setButton(12, true); poll(); expect(edges).toEqual(['trimNoseDown']);
    pad.setButton(0, true); // A = throttleInc, repeats while held
    let n = 0;
    for (let i = 0; i < 60; i++) { poll(); n += edges.filter((a) => a === 'throttleInc').length; }
    expect(n).toBeGreaterThanOrEqual(7);
  });

  it('shapes sticks and triggers: left stick → roll/pitch, LT/RT → yaw', () => {
    const pad = dom.addPad('Xbox 360 Controller (XInput STANDARD GAMEPAD)', 'standard');
    poll();
    pad.setAxis(0, 0.05); // inside the 0.12 deadzone
    pad.setAxis(1, 1); // stick pulled back = nose up
    poll();
    expect(val('roll')).toBe(0);
    expect(val('pitch')).toBe(1);
    pad.setButton(7, 1); // RT full
    poll();
    expect(val('yaw')).toBe(1);
    pad.setButton(6, 1);
    poll();
    expect(val('yaw')).toBe(0);
    pad.setAxis(3, -1); // right stick up = look up
    poll();
    expect(val('lookPitch')).toBe(1);
  });

  it('joystick: inverted slider throttle maps both ends, twist is yaw, hat looks', () => {
    const pad = dom.addPad('046d-c215-Logitech Extreme 3D', '', 10, 12);
    pad.axes[9] = 3.2857; // hat centred
    poll();
    pad.setAxis(6, -1); // slider full forward
    poll();
    expect(val('throttle')).toBe(1);
    expect(src.lastChange(axisIndexOf('throttle'))).toBe(now);
    pad.setAxis(6, 1);
    poll();
    expect(val('throttle')).toBe(0);
    pad.setAxis(5, -1);
    poll();
    expect(val('yaw')).toBe(-1);
    pad.setAxis(9, -1); // hat up
    poll();
    expect(val('lookPitch')).toBe(1);
    pad.setButton(0, true); // trigger = brakes
    poll();
    expect(held.has('brakesHold')).toBe(true);
  });

  it('D-pad mode "look" turns the D-pad into look axes; "trim" restores trim actions on hats', () => {
    const pad = dom.addPad('Xbox 360 Controller (XInput STANDARD GAMEPAD)', 'standard');
    src.setDpadMode('look');
    poll();
    pad.setButton(14, true); // left
    poll();
    expect(val('lookYaw')).toBe(-1);
    expect(edges).toEqual([]);
    const stick = dom.addPad('046d-c215-Logitech Extreme 3D', '', 10, 12);
    stick.axes[9] = 3.2857;
    src.setDpadMode('trim');
    poll();
    stick.setAxis(9, -1 + (4 * 2) / 7); // hat down
    poll();
    expect(edges).toEqual(['trimNoseUp']);
  });

  it('first reading does not steal an axis; activity selects the active pad', () => {
    const pad = dom.addPad('046d-c215-Logitech Extreme 3D', '', 10, 12);
    pad.axes[6] = 0.2;
    pad.axes[9] = 3.2857;
    expect(poll()).toBe(-1);
    expect(src.lastChange(axisIndexOf('throttle'))).toBe(-Infinity);
    pad.setAxis(0, 0.9);
    expect(poll()).toBe(pad.index);
    expect(src.activePad).toBe(pad.index);
  });

  it('rumbles the active pad when supported', () => {
    const pad = dom.addPad('Xbox 360 Controller (XInput STANDARD GAMEPAD)', 'standard');
    poll();
    pad.setButton(0, true);
    poll();
    expect(src.rumble(0.8, 0.4, 120)).toBe(true);
    expect(pad.rumbles[0]).toEqual({ type: 'dual-rumble', params: { startDelay: 0, duration: 120, weakMagnitude: 0.4, strongMagnitude: 0.8 } });
    pad.vibrationActuator = null;
    expect(src.rumble(1, 1, 50)).toBe(false);
  });

  it('modifier buttons form a shift layer', () => {
    const custom: BindingProfile = {
      version: 1, id: 'c', name: 'c', device: 'gamepad',
      bindings: [{ device: 'gamepad', button: 0, action: 'flapsDown' }, { device: 'gamepad', button: 0, modifierButton: 4, action: 'gearToggle' }],
    };
    src = new GamepadSource(dom.env.window, dom.env.navigator, () => custom);
    const pad = dom.addPad('Xbox 360 Controller (XInput STANDARD GAMEPAD)', 'standard');
    poll();
    pad.setButton(4, true);
    pad.setButton(0, true);
    poll();
    expect(edges).toEqual(['gearToggle']);
    pad.setButton(0, false);
    pad.setButton(4, false);
    poll();
    pad.setButton(0, true);
    poll();
    expect(edges).toEqual(['flapsDown']);
  });

  it('the shift layer is decided when the button goes down (like Ctrl+E vs E)', () => {
    const custom: BindingProfile = {
      version: 1, id: 'c', name: 'c', device: 'gamepad',
      bindings: [{ device: 'gamepad', button: 0, action: 'flapsDown' }, { device: 'gamepad', button: 0, modifierButton: 4, action: 'gearToggle' }],
    };
    src = new GamepadSource(dom.env.window, dom.env.navigator, () => custom);
    const pad = dom.addPad('Xbox 360 Controller (XInput STANDARD GAMEPAD)', 'standard');
    poll();
    pad.setButton(4, true);
    poll();
    pad.setButton(0, true);
    poll();
    expect(edges).toEqual(['gearToggle']);
    pad.setButton(4, false); // modifier released first, A still held: no plain A
    poll();
    expect(edges).toEqual([]);
    pad.setButton(0, false);
    poll();
    pad.setButton(0, true); // plain A …
    poll();
    expect(edges).toEqual(['flapsDown']);
    pad.setButton(4, true); // … then LB while A is held: no LB+A
    poll();
    poll();
    expect(edges).toEqual([]);
  });

  it('a button held through a profile refresh does not steal another input\'s hold of the same action', () => {
    const custom: BindingProfile = {
      version: 1, id: 'c', name: 'c', device: 'gamepad',
      bindings: [{ device: 'gamepad', button: 0, action: 'brakesHold' }, { device: 'gamepad', button: 1, action: 'brakesHold' }],
    };
    src = new GamepadSource(dom.env.window, dom.env.navigator, () => custom);
    const pad = dom.addPad('Xbox 360 Controller (XInput STANDARD GAMEPAD)', 'standard');
    poll();
    pad.setButton(0, true);
    poll();
    src.refreshProfiles(); // e.g. after a rebind: button 0 is held but no longer counted
    pad.setButton(1, true);
    poll();
    pad.setButton(0, false); // releasing the primed button must not release button 1's hold
    poll();
    poll();
    expect(held.has('brakesHold')).toBe(true);
  });
});
