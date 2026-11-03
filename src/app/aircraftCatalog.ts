/** Selectable aircraft. The G1000 variant shares the airframe and flight model with the steam-gauge 172S. */
import type { AircraftConfig } from '../core/types';
import { C172S } from '../fdm/aircraft/c172';

export const C172S_G1000: AircraftConfig = { ...C172S, id: 'c172s-g1000', name: 'Cessna 172S Skyhawk G1000', panel: 'c172-g1000' };
export const AIRCRAFT: readonly AircraftConfig[] = [C172S, C172S_G1000];
