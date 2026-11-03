/**
 * Navigation module: airport/navaid database, VOR/ILS/DME/GPS radio geometry, flight plan
 * sequencing and radio-frequency helpers. No Three.js; everything runs in Node.
 */
export * from './navTypes';
export * from './loaders';
export * from './airportsData';
export * from './ils';
export * from './spatialGrid';
export * from './frequencies';
export * from './radio';
export * from './flightPlan';
export * from './approaches';
export * from './NavDatabase';
export { MagVarCache, magneticDeclinationDeg, magneticField, decimalYear } from '../geo/magvar';
