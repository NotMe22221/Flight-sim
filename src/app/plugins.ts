/**
 * Attach optional subsystems (UI, G1000, HUD, audio, ATC) to the simulator by module path.
 * Each adapter only touches the module's documented public API.
 */
import type { Simulator } from './Simulator';

export async function attachPlugin(sim: Simulator, path: string, mod: Record<string, unknown>, container: HTMLElement): Promise<void> {
  void sim; void mod; void container;
  // Filled in as the modules land; see Simulator.plugins.
  if (import.meta.env.DEV) console.info(`[boot] optional module present: ${path}`);
}
