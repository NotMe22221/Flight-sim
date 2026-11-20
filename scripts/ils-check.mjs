#!/usr/bin/env node
/**
 * Coupled ILS approach in the G1000 172 (KSFO ILS 28R): from 12 nm, 1.5 nm left of the localizer on a
 * 30° intercept heading at 2,500 ft, NAV1 tuned right after the spawn (auto-course), APR armed.
 * Passes when the localizer and glideslope are captured and both are held within 0.15 dot below
 * 1,500 ft above the ground down to 400 ft. Run `npm run build` and a preview server first:
 *   node scripts/ils-check.mjs http://localhost:4173/
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const APP_URL = process.argv[2] ?? 'http://localhost:4173/';
const b = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 320, height: 200 } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(APP_URL, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__sim?.ready === true, null, { timeout: 60000 });
const r = await p.evaluate(async () => {
  const s = window.__sim.sim; await s.nav.load();
  s.selectAircraft('c172s-g1000'); s.setWeatherPreset('clear', 0);
  const ap = s.nav.getAirport('KSFO'); const end = s.runwayEndFor(ap, '28R'); const thr = end.threshold;
  // 12 nm out on the extended centreline, offset 1.5 nm left of course
  const hdg = end.headingDeg * Math.PI / 180, d = 12 * 1852, off = 1.5 * 1852;
  window.__end = { hdg: end.headingDeg, ils: end.ilsMHz };
  const lat = thr.lat + (-Math.cos(hdg) * d + Math.cos(hdg - Math.PI / 2) * off) / 111320;
  const lon = thr.lon + (-Math.sin(hdg) * d + Math.sin(hdg - Math.PI / 2) * off) / (111320 * Math.cos(thr.lat * Math.PI / 180));
  await s.spawnInAir(lat, lon, 2500 * 0.3048, end.headingDeg + 30, 95 * 0.514444);
  s.radios.tuneNav(0, Math.round((end.ilsMHz ?? 111.5) * 1000), Math.round(end.headingDeg - 13.5));
  s.autopilot.setNavSource?.('nav1');
  const a = s.autopilot; a.setHeadingBug(end.headingDeg + 30 - 13.5); a.setAltitudeTarget(2500 * 0.3048); a.engage(true); a.setLateral('HDG'); a.setVertical('ALT');
  a.press('APR');
  s.setPaused(false);
  const rows = [];
  for (let i = 0; i < 40; i++) {
    s.advance(10);
    const st = s.fdm.state, n1 = s.radios.state.nav1;
    rows.push({ t: (i + 1) * 10, lat: a.state.lateral, armL: a.state.armedLateral, ver: a.state.vertical, armV: a.state.armedVertical, ident: n1.ident, cdi: +n1.cdi.toFixed(2), gs: +n1.gsDeviation.toFixed(2), gsV: n1.gsValid, agl: Math.round(st.altitudeAglM / 0.3048), vs: Math.round(st.verticalSpeedMs * 196.85), ias: Math.round(st.aero.ias / 0.514444), hdg: Math.round(st.headingMagRad * 57.3), dme: +n1.dmeNm.toFixed(1), locI: +(a['locIntegral'] * 57.3).toFixed(2), trkMag: +((st.trackRad - (st.headingTrueRad - st.headingMagRad)) * 57.3).toFixed(1), obs: n1.obsDeg, bank: +(st.euler[0] * 57.3).toFixed(1), rollCmd: +(a.rollCommandRad * 57.3).toFixed(1) });
    if (st.altitudeAglM < 200 * 0.3048 || st.onGround || st.crashed) break;
  }
  return [{ end: window.__end }, ...rows];
});
const rows = r.slice(1);
for (const x of rows) console.log(JSON.stringify({ t: x.t, lat: x.lat, ver: x.ver, obs: x.obs, cdi: x.cdi, gs: x.gs, agl: x.agl, vs: x.vs }));
const low = rows.filter((x) => x.agl < 1500 && x.agl >= 400);
const ok = rows.some((x) => x.lat === 'APR') && rows.some((x) => x.ver === 'GS') && low.length > 0 && low.every((x) => Math.abs(x.cdi) * 2 < 0.15 && Math.abs(x.gs) * 2 < 0.15);
console.log(JSON.stringify({ ok, errs }));
await b.close();
process.exit(ok && !errs.length ? 0 : 1);
