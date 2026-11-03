import { describe, expect, it } from 'vitest';
import { ENGINE_FSM, EngineStartFsm, type EnginePhase } from './EngineStartFsm';

const DT = 1 / 60;

/** Run the FSM for `seconds` with fixed inputs; returns the phase sequence (deduplicated). */
function run(f: EngineStartFsm, seconds: number, running: boolean, rpm: number | ((t: number) => number), starter: boolean | null): EnginePhase[] {
  const seq: EnginePhase[] = [];
  for (let t = 0; t < seconds - 1e-9; t += DT) {
    const p = f.update(DT, running, typeof rpm === 'number' ? rpm : rpm(t), starter);
    if (seq[seq.length - 1] !== p) seq.push(p);
  }
  return seq;
}

describe('EngineStartFsm', () => {
  it('starter → cranking immediately; combustion → catching for CATCH_S → running', () => {
    const f = new EngineStartFsm();
    f.update(DT, false, 0, false);
    expect(f.phase).toBe('off');
    f.update(DT, false, 50, true);
    expect(f.phase).toBe('cranking');
    expect(f.justEntered).toBe(true);
    run(f, 1.5, false, 200, true);
    expect(f.phase).toBe('cranking');
    // engine catches
    f.update(DT, true, 500, true);
    expect(f.phase).toBe('catching');
    run(f, ENGINE_FSM.CATCH_S - 3 * DT, true, 700, false);
    expect(f.phase).toBe('catching');
    expect(f.catchProgress).toBeGreaterThan(0.8);
    run(f, 4 * DT, true, 700, false);
    expect(f.phase).toBe('running');
    expect(f.catchProgress).toBe(1);
  });

  it('shutdown runs down until rpm < STOP_RPM, then off', () => {
    const f = new EngineStartFsm();
    f.update(DT, true, 2000, false); // spawn running: no start sequence
    expect(f.phase).toBe('running');
    // rpm decays 700 → 0 over ~2.3 s
    const seq = run(f, 3, false, (t) => Math.max(0, 700 - 300 * t), false);
    expect(seq).toEqual(['rundown', 'off']);
    expect(f.timeInPhase).toBeLessThan(1);
  });

  it('a windmilling prop ends the rundown after RUNDOWN_MAX_S', () => {
    const f = new EngineStartFsm();
    f.update(DT, true, 2300, false);
    run(f, ENGINE_FSM.RUNDOWN_MAX_S - 0.1, false, 900, false);
    expect(f.phase).toBe('rundown');
    run(f, 0.2, false, 900, false);
    expect(f.phase).toBe('off');
    // and steady windmilling is not mistaken for cranking when the starter is unknown
    run(f, 2, false, 900, null);
    expect(f.phase).toBe('off');
  });

  it('releasing the starter without a catch → rundown → off', () => {
    const f = new EngineStartFsm();
    f.update(DT, false, 0, false);
    run(f, 1, false, 220, true);
    expect(f.phase).toBe('cranking');
    const seq = run(f, 1.5, false, (t) => Math.max(0, 220 - 400 * t), false);
    expect(seq).toEqual(['rundown', 'off']);
  });

  it('infers cranking from an rpm spin-up when the starter state is unknown', () => {
    const f = new EngineStartFsm();
    f.update(DT, false, 0, null);
    const seq = run(f, 1, false, (t) => Math.min(200, 600 * t), null);
    expect(seq).toEqual(['off', 'cranking']);
    run(f, 1, false, 200, null); // steady cranking stays cranking
    expect(f.phase).toBe('cranking');
    f.update(DT, true, 600, null);
    expect(f.phase).toBe('catching');
  });

  it('restart during rundown goes straight back to catching', () => {
    const f = new EngineStartFsm();
    f.update(DT, true, 2000, null);
    f.update(DT, false, 1500, null);
    expect(f.phase).toBe('rundown');
    f.update(DT, true, 1500, null);
    expect(f.phase).toBe('catching');
  });

  it('a windmilling prop sagging into the cranking band and picking up again is not cranking (starter unknown)', () => {
    const f = new EngineStartFsm();
    f.update(DT, true, 2400, null); // cruise
    run(f, ENGINE_FSM.RUNDOWN_MAX_S + 0.5, false, 900, null); // engine failure: windmills at 900 rpm
    expect(f.phase).toBe('off');
    run(f, 4, false, (t) => Math.max(350, 900 - 150 * t), null); // slowing down: windmill sags to 350 rpm
    // nose down: the prop picks up through the cranking band (> CRANK_SPINUP_RPM_S) and settles at 440 rpm
    const seq = run(f, 3, false, (t) => Math.min(440, 350 + 120 * t), null);
    expect(seq).toEqual(['off']); // no phantom starter whine, and no way to get stuck in 'cranking'
    // a real start from rest is still recognised after the engine has stopped
    run(f, 2, false, (t) => Math.max(0, 440 - 400 * t), null);
    expect(run(f, 1, false, (t) => Math.min(200, 600 * t), null)).toEqual(['off', 'cranking']);
  });
});
