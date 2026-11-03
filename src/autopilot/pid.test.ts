import { describe, expect, it } from 'vitest';
import { Pid } from './pid';

const run = (pid: Pid, sp: number, meas: number, seconds: number, hz = 120): number => {
  const n = Math.round(seconds * hz);
  for (let i = 0; i < n; i++) pid.update(sp, meas, 1 / hz);
  return pid.output;
};

describe('Pid', () => {
  it('is a plain PI controller inside the limits', () => {
    const pid = new Pid({ kp: 2, ki: 0.5, kd: 0, outMin: -10, outMax: 10 });
    run(pid, 1, 0, 2);
    // P = 2·1, I = 0.5·1·2 s = 1
    expect(pid.output).toBeCloseTo(3, 6);
    expect(pid.integral).toBeCloseTo(1, 6);
  });

  it('anti-windup: the integral does not grow while saturated and keeps the load it carried', () => {
    const pid = new Pid({ kp: 1, ki: 1, kd: 0, outMin: -1, outMax: 1, iLim: 5, tt: 1 });
    pid.resetToOutput(0.3, 0, 0); // integral carries a steady load of 0.3
    run(pid, 3, 0, 10); // P alone (3) saturates the output for 10 s
    expect(pid.output).toBe(1);
    expect(pid.integral).toBeCloseTo(0.3, 9);
    // error clears: back to the carried load, no reverse kick
    pid.update(0, 0, 1 / 120);
    expect(pid.output).toBeCloseTo(0.3, 9);
  });

  it('anti-windup: leaves saturation as soon as the error reverses (a naive integrator would stay pinned)', () => {
    const pid = new Pid({ kp: 0.2, ki: 1, kd: 0, outMin: -1, outMax: 1, iLim: 100, tt: 1 });
    run(pid, 2, 0, 20); // P = 0.4, the integral alone saturates the output
    expect(pid.output).toBe(1);
    expect(pid.integral).toBeLessThanOrEqual(1 + 1e-9); // bounded at the limit, not 40
    pid.update(-1, 0, 1 / 120);
    expect(pid.output).toBeLessThan(1);
    run(pid, -1, 0, 1);
    expect(pid.output).toBeLessThan(0.0);
  });

  it('back-calculation bleeds an integral that ends up outside moved limits, at the same rate for any frame rate', () => {
    const make = () => {
      const pid = new Pid({ kp: 0, ki: 1, kd: 0, outMin: -1, outMax: 1, iLim: 1, tt: 0.5 });
      run(pid, 0.8, 0, 1); // integral 0.8
      pid.setOutputLimits(-0.2, 0.2);
      return pid;
    };
    const a = make(), b = make();
    run(a, 0, 0, 0.5, 60);
    run(b, 0, 0, 0.5, 240);
    // exact exponential: 0.2 + 0.6·e^-1
    expect(a.integral).toBeCloseTo(0.2 + 0.6 * Math.exp(-1), 6);
    expect(b.integral).toBeCloseTo(a.integral, 6);
    expect(a.output).toBe(0.2);
    run(a, 0, 0, 5);
    expect(a.integral).toBeCloseTo(0.2, 4);
  });

  it('clamps the integral authority to ±iLim', () => {
    const pid = new Pid({ kp: 0, ki: 1, kd: 0, outMin: -10, outMax: 10, iLim: 0.15 });
    run(pid, -1, 0, 5);
    expect(pid.integral).toBeCloseTo(-0.15, 12);
  });

  it('bumpless transfer: resetToOutput makes the next update continue from the chosen output', () => {
    const pid = new Pid({ kp: 0.8, ki: 0.3, kd: 0.2, outMin: -1, outMax: 1, iLim: 1 });
    pid.resetToOutput(-0.22, 0.05, 0.02, 0.01);
    expect(pid.output).toBeCloseTo(-0.22, 12);
    pid.update(0.05, 0.02, 1 / 120, 0.01);
    expect(Math.abs(pid.output - -0.22)).toBeLessThan(1e-3);
  });

  it('derivative acts on the measurement: a setpoint step gives only the proportional jump', () => {
    const pid = new Pid({ kp: 1, ki: 0, kd: 5, outMin: -100, outMax: 100 });
    run(pid, 0, 0, 1);
    pid.update(1, 0, 1 / 120);
    expect(pid.output).toBeCloseTo(1, 12);
    // a measured rate is damped with −kd·rate
    pid.update(1, 0, 1 / 120, 0.1);
    expect(pid.output).toBeCloseTo(1 - 0.5, 12);
  });

  it('supports negative gains (FLC: too fast → nose up) with correct anti-windup direction', () => {
    const pid = new Pid({ kp: -1, ki: -1, kd: 0, outMin: -0.5, outMax: 0.5, iLim: 5, tt: 1 });
    run(pid, 0, 2, 10); // measurement above setpoint → positive output, saturated
    expect(pid.output).toBe(0.5);
    expect(pid.integral).toBeLessThanOrEqual(0.5 + 1e-9);
    pid.update(0, 0, 1 / 120);
    expect(pid.output).toBeLessThanOrEqual(0.5);
    run(pid, 0, -0.3, 1); // now slow → nose down; leaves the upper limit promptly
    expect(pid.output).toBeLessThan(0.5);
  });

  it('gainScale scales P and D but not the stored integral', () => {
    const pid = new Pid({ kp: 1, ki: 1, kd: 1, outMin: -10, outMax: 10 });
    run(pid, 1, 0, 1);
    const i = pid.integral;
    pid.gainScale = 2;
    pid.update(1, 0, 1 / 120, 0);
    expect(pid.output).toBeCloseTo(2 + i + 1 / 120, 9);
  });
});
