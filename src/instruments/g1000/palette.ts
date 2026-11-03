/**
 * G1000 colour palette (approximations — Garmin publishes none), fonts and the 1024×768 PFD
 * design-space layout from docs/research/05 §2.2.
 */
import { FontCache, FONT_COND, FONT_MONO } from '../canvas';

export const G = Object.freeze({
  sky: '#1565D8',
  skyTop: '#0A5CFF',
  ground: '#7A4A1D',
  groundTop: '#8B5A2B',
  cyan: '#00FFFF',
  magenta: '#FF00FF',
  green: '#00FF00',
  white: '#FFFFFF',
  yellow: '#FFFF00',
  red: '#FF0000',
  amber: '#FFB000',
  black: '#000000',
  grey: '#9a9a9a',
  darkGrey: '#3c3c3c',
  tapeBg: 'rgba(0,0,0,0.55)',
  boxBg: 'rgba(0,0,0,0.6)',
  softkeyBg: '#1C1C1C',
  bezel: '#101010',
  barBg: '#242424',
});

export const cond = new FontCache(FONT_COND);
export const condBold = new FontCache(FONT_COND, 'bold');
export const monoBold = new FontCache(FONT_MONO, 'bold');

/** PFD design-space layout (1024×768). */
export const PFD = Object.freeze({
  width: 1024, height: 768,
  topBarH: 42, afcsY: 42, afcsH: 28,
  softkeyY: 738, softkeyH: 30, softkeyCount: 12,
  // attitude
  attCx: 512, attCy: 330, attRollR: 300, attPxPerDeg: 4.0, attTop: 70, attBottom: 738, attLeft: 0, attRight: 1024,
  // airspeed tape
  asX: 60, asW: 90, tapeTop: 110, tapeBottom: 560, asPxPerKt: 7.5,
  // altitude tape
  altX: 836, altW: 90, altPxPerFt: 0.75,
  // VSI
  vsiX: 930, vsiW: 50, vsiPxPerFpm: 0.075,
  // HSI
  hsiCx: 512, hsiCy: 590, hsiR: 150,
  cdiDotSpacing: 26, cdiDotR: 4,
});

/** MFD design-space layout (1024×768). */
export const MFD = Object.freeze({
  width: 1024, height: 768,
  eisW: 150, topBarH: 42, dataFieldH: 24, softkeyY: 738, softkeyH: 30,
  mapX: 154, mapY: 66, mapW: 870, mapH: 672,
});

export type CdiSource = 'GPS' | 'NAV1' | 'NAV2';
