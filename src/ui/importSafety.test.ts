/**
 * DOM-dependent classes cannot run in Node, but importing them must never touch `document`,
 * `window` or `localStorage` at module load (the integrator lazy-loads src/ui and other modules'
 * tests may import its pure helpers).
 */
import { describe, expect, it } from 'vitest';

const MODULES = [
  './index', './UiManager', './UiHost', './dom', './icons', './routing', './selection', './settingsStore', './settingsModel',
  './bindingsModel', './activities', './worldMapModel', './searchDebounce', './timeOfDay', './flightLauncher', './landingReportModel',
  './screens/Screen', './screens/LoadingScreen', './screens/MainMenu', './screens/WorldMap', './screens/AircraftSelect',
  './screens/WeatherPanel', './screens/WeatherScreen', './screens/Settings', './screens/CreditsScreen', './screens/Activities',
  './screens/worldmap/AirportSearch', './screens/worldmap/AirportCard', './screens/worldmap/MapCanvas', './screens/worldmap/mapDraw',
  './screens/worldmap/FlightConditions',
  './screens/settings/GeneralTab', './screens/settings/GraphicsTab', './screens/settings/ControlsTab', './screens/settings/AudioTab', './screens/settings/DataTab',
  './flight/FlightUi', './flight/FlightPanels', './flight/Toolbar', './flight/FloatingPanel', './flight/AtcWindow', './flight/Checklist',
  './flight/VfrMap', './flight/NavLog', './flight/PauseMenu', './flight/Toasts', './flight/LandingReport', './flight/HelpOverlay',
  './flight/StatusBar', './flight/HudStrip', './apAnnunciator', './flight/checklistAuto',
  // activities: Flight training / Bush trips tabs, objectives panel, subtitles, debrief
  './activityModels', './subtitleQueue', './screens/activities/types', './screens/activities/ChallengesTab',
  './screens/activities/TrainingTab', './screens/activities/BushTripsTab', './flight/ObjectivesPanel', './flight/InstructorSubtitle',
  './flight/DebriefCard',
];

describe('import safety (Node, no DOM)', () => {
  it('has no DOM globals in this environment', () => {
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');
  });

  for (const m of MODULES) {
    it(`imports ${m} without touching the DOM`, async () => {
      const mod = (await import(m)) as Record<string, unknown>;
      expect(mod).toBeTypeOf('object');
    });
  }

  it('exports the UiManager class from the barrel', async () => {
    const mod = await import('./index');
    expect(mod.UiManager).toBeTypeOf('function');
    expect(mod.UiManager.prototype.update).toBeTypeOf('function');
    expect(mod.UiManager.prototype.handleAction).toBeTypeOf('function');
    expect(mod.UiManager.prototype.show).toBeTypeOf('function');
    expect(mod.UiManager.prototype.onStart).toBeTypeOf('function');
    expect(mod.UiManager.prototype.dispose).toBeTypeOf('function');
  });
});
