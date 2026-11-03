/**
 * Bootstrap: create the simulator, attach optional subsystems that exist in this build, and
 * start the render loop. The UI layer (when present) drives spawning; otherwise "Fly now".
 */
import { Simulator } from './app/Simulator';
import { installAutomation } from './app/automation';
import './style.css';

const container = document.getElementById('app')!;
const sim = new Simulator({ container, baseUrl: import.meta.env.BASE_URL });
const automation = installAutomation(sim);

async function boot(): Promise<void> {
  await sim.nav.load();
  sim.start();
  // Optional modules are loaded lazily so a missing or failing one never blocks flight.
  const opt = import.meta.glob(['./ui/UiManager.ts', './instruments/g1000/G1000.ts', './instruments/Hud.ts', './audio/AudioSystem.ts', './atc/AtcController.ts']);
  await Promise.all(Object.entries(opt).map(async ([path, load]) => {
    try {
      const mod = (await load()) as Record<string, unknown>;
      const { attachPlugin } = await import('./app/plugins');
      await attachPlugin(sim, path, mod, container);
    } catch (e) {
      console.warn(`[boot] optional module ${path} failed to load`, e);
    }
  }));
  automation.ready = true;
}

void boot();
