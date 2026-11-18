#!/usr/bin/env node
/**
 * Terrain clearance of every discovery flight start (src/activities/discovery.ts) against the real
 * streamed elevation: spawns each one in a running app and reports the height above the ground at the
 * start and the least clearance along the first 6 km of its heading. Run `npm run build` and a preview
 * server first:  node scripts/discovery-check.mjs http://localhost:4173/
 * A negative minClrM means the start flies into terrain: move it.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const URL = process.argv[2] ?? 'http://localhost:4173/';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/activities/discovery.ts', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('DISCOVERY_FLIGHTS: readonly DiscoveryFlight[] = [') + 'DISCOVERY_FLIGHTS: readonly DiscoveryFlight[] = '.length, src.indexOf('];', src.indexOf('DISCOVERY_FLIGHTS')) + 1);
const FLIGHTS = new Function(`return ${body}`)();
const b = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(URL, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__sim?.ready === true, null, { timeout: 60000 });
for (const d of FLIGHTS) {
  const r = await p.evaluate(async (d) => {
    const s = window.__sim.sim; await s.nav.load();
    s.selectAircraft(d.aircraft === 'c172' ? 'c172s' : d.aircraft);
    s.setWeatherPreset(d.weather, 0);
    await s.spawnInAir(d.lat, d.lon, d.altFt * 0.3048, d.headingDeg, d.iasKt * 0.514444);
    s.setPaused(true);
    await new Promise((res) => setTimeout(res, 12000));
    const a = s.fdm.state, w = s.world, hd = a.headingTrueRad;
    let minClr = Infinity, at = -1, samples = 0;
    for (let d = 0; d <= 6000; d += 100) {
      const n = a.posNED[0] + Math.cos(hd) * d, e = a.posNED[1] + Math.sin(hd) * d;
      const g = w.groundHeight(n, e); if (g === null) continue; samples++;
      const clr = -a.posNED[2] - g; if (clr < minClr) { minClr = clr; at = d; }
    }
    return { id: d.id, altFt: Math.round(a.geo.alt / 0.3048), aglM: Math.round(a.altitudeAglM), minClrM: Math.round(minClr), atM: at, samples };
  }, d);
  console.log(JSON.stringify(r));
}
console.log(JSON.stringify({ errs }));
await b.close();
process.exit(errs.length ? 1 : 0);
