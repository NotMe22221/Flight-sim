import { describe, expect, it } from 'vitest';
import type { AutopilotState } from '../core/types';
import { AP_DISCONNECT_FLASH_MS, ApAnnunciator, annunciationTitle, disconnectText, emptyAnnunciation } from './apAnnunciator';

const ap = (o: Partial<AutopilotState> = {}): AutopilotState => ({
  engaged: false, flightDirector: false, lateral: 'OFF', vertical: 'OFF', armedLateral: null, armedVertical: null,
  headingBugDeg: 0, altitudeTargetM: 0, verticalSpeedTargetMs: 0, iasTargetMs: 0, pitchTargetRad: 0, rollTargetRad: 0,
  fdPitchRad: 0, fdRollRad: 0, outPitch: 0, outRoll: 0, outYaw: 0, yawDamper: false, trimCommand: 0,
  lvl: false, disconnectReason: null, disconnectT: Number.NEGATIVE_INFINITY, altAlert: 'none', ...o,
});

describe('autopilot annunciator (flight info strip)', () => {
  it('shows active modes green, armed modes, AP or FD', () => {
    const a = new ApAnnunciator();
    const out = emptyAnnunciation();
    const st = ap({ engaged: true, flightDirector: true, lateral: 'HDG', vertical: 'VS', armedVertical: 'ALTS', armedLateral: 'LOC' });
    a.observe(st, 0);
    a.read(st, 0, out);
    expect(out).toMatchObject({ visible: true, status: 'AP', statusTone: 'ok', lateral: 'HDG', vertical: 'VS', armedLateral: 'LOC', armedVertical: 'ALTS' });
    a.read(ap({ flightDirector: true, lateral: 'ROL', vertical: 'PIT' }), 0, out);
    expect(out).toMatchObject({ visible: true, status: 'FD', statusTone: 'fd', lateral: 'ROL', vertical: 'PIT', armedLateral: '' });
    a.read(ap(), 0, out);
    expect(out.visible).toBe(false);
  });

  it("annunciates 'LVL' in both the lateral and the vertical field while LVL is active", () => {
    const a = new ApAnnunciator();
    const out = emptyAnnunciation();
    const st = ap({ engaged: true, flightDirector: true, lateral: 'ROL', vertical: 'PIT', armedVertical: 'ALTS', lvl: true });
    a.observe(st, 0);
    a.read(st, 0, out);
    expect(out.lateral).toBe('LVL');
    expect(out.vertical).toBe('LVL');
    expect(out.armedVertical).toBe('');
    expect(annunciationTitle(out)).toMatch(/^LVL/);
  });

  it('flashes AP for 5 s when disconnectT changes, red with the reason when the autopilot dropped out', () => {
    const a = new ApAnnunciator();
    const out = emptyAnnunciation();
    a.observe(ap({ engaged: true, lateral: 'HDG', vertical: 'ALT' }), 0);
    const off = ap({ disconnectReason: 'stall', disconnectT: 42.5 });
    expect(a.observe(off, 1000)).toBe(true);
    a.read(off, 1000, out);
    expect(out).toMatchObject({ visible: true, status: 'AP', statusTone: 'disc', reason: 'STALL', reasonLong: 'stall warning' });
    expect(annunciationTitle(out)).toBe('Autopilot disconnected: stall warning');
    // the same disconnect does not re-trigger
    expect(a.observe(off, 2000)).toBe(false);
    a.read(off, 1000 + AP_DISCONNECT_FLASH_MS - 1, out);
    expect(out.visible).toBe(true);
    a.read(off, 1000 + AP_DISCONNECT_FLASH_MS, out);
    expect(out.visible).toBe(false);
    expect(out.reason).toBe('');
  });

  it("a pilot disconnect flashes amber without a reason tag; re-engaging cancels the flash", () => {
    const a = new ApAnnunciator();
    const out = emptyAnnunciation();
    a.observe(ap({ engaged: true }), 0);
    const off = ap({ disconnectReason: 'pilot', disconnectT: 10 });
    a.observe(off, 100);
    a.read(off, 100, out);
    expect(out.statusTone).toBe('disc-pilot');
    expect(out.reason).toBe('');
    const on = ap({ engaged: true, disconnectReason: 'pilot', disconnectT: 10, lateral: 'ROL', vertical: 'PIT' });
    a.observe(on, 200);
    a.read(on, 200, out);
    expect(out.statusTone).toBe('ok');
  });

  it('never flashes for a disconnect from before it started watching (first frame, new flight, autopilot reset)', () => {
    const a = new ApAnnunciator();
    const old = ap({ disconnectReason: 'bank', disconnectT: 300 });
    expect(a.observe(old, 0)).toBe(false); // baseline
    expect(a.flashing(old, 0)).toBe(false);
    a.rebase();
    expect(a.observe(ap({ disconnectReason: 'overspeed', disconnectT: 12 }), 10)).toBe(false);
    // the autopilot's own reset back to "never"
    expect(a.observe(ap({ disconnectT: Number.NEGATIVE_INFINITY }), 20)).toBe(false);
    // an autopilot without the GFC 700 extras
    const plain = ap();
    delete plain.disconnectT;
    const b = new ApAnnunciator();
    expect(b.observe(plain, 0)).toBe(false);
    expect(b.observe({ ...plain, disconnectT: Number.NaN }, 1)).toBe(false);
    expect(b.observe({ ...plain, disconnectT: Number.NaN }, 2)).toBe(false);
  });

  it('a rebase cancels a running flash', () => {
    const a = new ApAnnunciator();
    a.observe(ap({ engaged: true }), 0);
    const off = ap({ disconnectReason: 'crash', disconnectT: 5 });
    a.observe(off, 10);
    expect(a.flashing(off, 20)).toBe(true);
    a.rebase();
    expect(a.flashing(off, 30)).toBe(false);
  });

  it('passes the altitude alerter through and describes it', () => {
    const a = new ApAnnunciator();
    const out = emptyAnnunciation();
    const st = ap({ engaged: true, vertical: 'VS', armedVertical: 'ALTS', altAlert: 'approach' });
    a.read(st, 0, out);
    expect(out.altAlert).toBe('approach');
    expect(annunciationTitle(out)).toContain('approaching the selected altitude');
    a.read({ ...st, vertical: 'ALT', armedVertical: null, altAlert: 'deviation' }, 0, out);
    expect(out.altAlert).toBe('deviation');
    a.read({ ...st, altAlert: undefined }, 0, out);
    expect(out.altAlert).toBe('none');
  });

  it('reason texts', () => {
    expect(disconnectText('power')).toEqual({ short: 'PWR', long: 'autopilot power lost', abnormal: true });
    expect(disconnectText('pilot').abnormal).toBe(false);
    expect(disconnectText(null)).toEqual({ short: '', long: 'disconnected', abnormal: false });
    expect(disconnectText('bogus' as never).abnormal).toBe(false);
  });
});
