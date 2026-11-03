/**
 * Starting flights from the UI: FLY (the World Map / main-menu selection) and Activities
 * landing challenges. Shows the flight loading screen, applies weather/time, spawns, adds the
 * arrival waypoint, and returns to the previous menu with an error toast on failure.
 * Also attributes landing scores to the running challenge (best scores in localStorage).
 */
import type { SimEvents, SpawnState } from '../core/types';
import type { UiHost } from './UiHost';
import type { ScreenId } from './screens/Screen';
import type { SelectionStore } from './selection';
import { ChallengeSession, landingChallenges, loadBestScores, recordBestScore, saveBestScores } from './activities';

export interface FlightLauncherDeps {
  host: UiHost;
  selection: SelectionStore;
  toast: (t: SimEvents['ui:toast']) => void;
  /** Show the flight loading screen; returns the history to restore on failure. */
  beginLoading: () => ScreenId[];
  /** The spawn resolved: show the flight. */
  enterFlight: () => void;
  /** The spawn failed: return to `saved`. */
  restore: (saved: ScreenId[]) => void;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class FlightLauncher {
  readonly challenge = new ChallengeSession();
  private busy = false;

  constructor(private readonly d: FlightLauncherDeps) {}

  /** True while a UI-initiated spawn is in progress (its 'flight:reset' must not re-route). */
  get flying(): boolean { return this.busy; }

  /** FLY with the current selection. Resolves true when the flight is live. */
  async fly(): Promise<boolean> {
    if (this.busy) return false;
    const { host, selection } = this.d;
    const sel = selection.sel;
    this.challenge.end();
    return this.run(async () => {
      const w = sel.weather;
      if (w.mode === 'preset') host.setWeatherPreset(w.presetId);
      else if (w.mode === 'custom') host.setCustomWeather(w.custom);
      host.setTime(selection.resolvedTimeUtcMs());
      await host.spawn(sel.spawn, sel.aircraftId, { fuelFraction: sel.fuelFraction, payloadKg: sel.payloadKg });
      // live weather needs the new position; the planner is cleared at spawn, so the arrival goes in afterwards
      if (w.mode === 'live') {
        host.requestLiveWeather().then((ok) => { if (!ok) this.d.toast({ text: 'Live weather unavailable — keeping the current weather', kind: 'warn' }); }, () => undefined);
      }
      const arr = sel.arrival;
      if (arr && host.addWaypoint && arr.icao !== sel.spawn.airport.icao) host.addWaypoint({ id: arr.icao, position: arr.position, type: 'airport' });
    }, 'Could not start the flight');
  }

  /** Activities → Start. No-op when the host has no startChallenge. */
  async startChallenge(id: string): Promise<boolean> {
    const start = this.d.host.startChallenge;
    if (this.busy || !start) return false;
    this.challenge.begin(id); // its 'flight:reset' fires before the promise resolves
    const ok = await this.run(() => start.call(this.d.host, id), 'Could not start the challenge');
    if (!ok) this.challenge.end();
    return ok;
  }

  onFlightReset(spawn: SpawnState): void { this.challenge.onFlightReset(spawn); }

  /** 'landing:scored' during a challenge: store a new best and congratulate. */
  recordScore(score: number): void {
    const id = this.challenge.activeId;
    if (!id) return;
    const r = recordBestScore(loadBestScores(), id, score, Date.now());
    if (!r.isNewBest) return;
    saveBestScores(r.scores);
    const title = landingChallenges().find((c) => c.id === id)?.title ?? id;
    this.d.toast({ text: `New best on ${title}: ${Math.round(score).toLocaleString('en-US')}`, kind: 'success', durationMs: 6000 });
  }

  private async run(start: () => Promise<void>, failText: string): Promise<boolean> {
    this.busy = true;
    const saved = this.d.beginLoading();
    try {
      await start();
      this.busy = false;
      this.d.enterFlight();
      return true;
    } catch (e) {
      this.busy = false;
      console.error('[ui] flight start failed', e);
      this.d.toast({ text: `${failText}: ${errText(e)}`, kind: 'error', durationMs: 7000 });
      this.d.restore(saved);
      return false;
    }
  }
}
