#!/usr/bin/env node
/**
 * Long flight across floating-origin rebases: 18 minutes (~74 km) east from the Bay at 1,500 m on the
 * autopilot (HDG + ALT), sampled every second. Passes when the world re-centres at least three times
 * without a jump (position steps match the ground speed within 1 m, altitude steps under 1 m) and the
 * altitude hold keeps within 15 m (it drifted ~15 m per 10 km before the earth-curvature fix).
 * Run `npm run build` and a preview server first:  node scripts/long-flight-check.mjs http://localhost:4173/
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
  await s.spawnInAir(37.70, -122.25, 1500, 90, 110 * 0.514444);
  const a = s.autopilot; a.setHeadingBug(Math.round(s.fdm.state.headingMagRad * 57.3)); a.setAltitudeTarget(1500); a.engage(true); a.setLateral('HDG'); a.setVertical('ALT');
  s.setPaused(false);
  const R = 6371000, D = Math.PI / 180;
  const dist = (p1, p2) => { const dLat = (p2.lat - p1.lat) * D, dLon = (p2.lon - p1.lon) * D; const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1.lat * D) * Math.cos(p2.lat * D) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
  let prev = { ...s.fdm.state.geo }, prevV = s.fdm.state.groundSpeedMs, prevAlt = s.fdm.state.geo.alt, prevHdg = s.fdm.state.headingTrueRad, prevFrame = JSON.stringify(s.world.frame.info);
  const rebases = []; let maxStepErr = 0, maxAltStep = 0, maxHdgStep = 0, maxDv = 0, total = 0;
  for (let i = 0; i < 1100; i++) {
    s.advance(1);
    const st = s.fdm.state, g = st.geo;
    const d = dist(prev, g); total += d;
    const expected = (st.groundSpeedMs + prevV) / 2;
    maxStepErr = Math.max(maxStepErr, Math.abs(d - expected));
    maxAltStep = Math.max(maxAltStep, Math.abs(g.alt - prevAlt));
    maxHdgStep = Math.max(maxHdgStep, Math.abs(Math.atan2(Math.sin(st.headingTrueRad - prevHdg), Math.cos(st.headingTrueRad - prevHdg))) / D);
    maxDv = Math.max(maxDv, Math.abs(st.groundSpeedMs - prevV));
    const fr = JSON.stringify(s.world.frame.info);
    if (fr !== prevFrame) { rebases.push({ t: i + 1, km: +(total / 1000).toFixed(1), stepM: +d.toFixed(2), expectedM: +expected.toFixed(2), dAlt: +(g.alt - prevAlt).toFixed(3) }); prevFrame = fr; }
    prev = { ...g }; prevV = st.groundSpeedMs; prevAlt = g.alt; prevHdg = st.headingTrueRad;
  }
  return { km: +(total / 1000).toFixed(1), rebases, maxStepErrM: +maxStepErr.toFixed(3), maxAltStepM: +maxAltStep.toFixed(3), maxHdgStepDeg: +maxHdgStep.toFixed(3), maxDvMs: +maxDv.toFixed(3), altEnd: +(s.fdm.state.geo.alt).toFixed(1), crashed: s.fdm.state.crashed };
});
console.log(JSON.stringify(r));
const ok = r.rebases.length >= 3 && r.maxStepErrM < 1 && r.maxAltStepM < 1 && Math.abs(r.altEnd - 1500) < 15 && !r.crashed;
console.log(JSON.stringify({ ok, errs }));
await b.close();
process.exit(ok && !errs.length ? 0 : 1);
