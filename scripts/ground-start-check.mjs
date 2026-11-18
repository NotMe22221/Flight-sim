#!/usr/bin/env node
/**
 * Runway starts against the real terrain and runway data: for every bush-trip departure runway
 * (src/activities/bushTrips.ts) and the lesson / default airports, spawn on the runway in a running
 * app and check the aircraft rests on its wheels (not sunk, not floating), sits on the centreline
 * near the threshold pointing down the runway, and stays put with the parking brake for 10 s.
 * Run `npm run build` and a preview server first:  node scripts/ground-start-check.mjs http://localhost:4173/
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const APP_URL = process.argv[2] ?? 'http://localhost:4173/';
const bush = readFileSync(new URL('../src/activities/bushTrips.ts', import.meta.url), 'utf8');
const coords = Object.fromEntries([...bush.matchAll(/ap\('([A-Z0-9]+)', '[^']*', (-?[\d.]+), (-?[\d.]+)/g)].map((m) => [m[1], { lat: +m[2], lon: +m[3] }]));
const starts = [...bush.matchAll(/from: '([A-Z0-9]+)', to: '[A-Z0-9]+', departureRunway: '([0-9LRC]+)'/g)].map((m) => ({ icao: m[1], runway: m[2], near: coords[m[1]] }));
starts.push({ icao: 'KSFO', runway: '28R' }, { icao: 'KHAF', runway: '12' }, { icao: 'KOAK', runway: '30' });
const b = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 320, height: 200 } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(APP_URL, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__sim?.ready === true, null, { timeout: 60000 });
let bad = 0;
for (const st of starts) {
  const r = await p.evaluate(async ({ icao, runway, near }) => {
    const s = window.__sim.sim; await s.nav.load();
    // small airports are in regional shards: load the field's region first (as the activity host does)
    if (!s.nav.getAirport(icao) && near) await s.nav.loadRegion({ lat: near.lat, lon: near.lon, alt: 0 }, 15);
    const ap0 = s.nav.getAirport(icao);
    if (!ap0) return { icao, runway, err: 'airport missing' };
    await s.nav.loadRegion(ap0.position, 20);
    const ap = s.nav.getAirport(icao);
    s.selectAircraft('c172s');
    await s.spawnAtRunway(ap, runway);
    const a = s.fdm.state;
    const used = s.spawnRunwayIdent;
    const end = s.runwayEndFor ? s.runwayEndFor(ap, runway) : null;
    const comp = a.gear.map((g) => +(g.compressionM ?? 0).toFixed(3));
    const onGround = a.gear.filter((g) => g.onGround).length;
    const hdgErr = end ? Math.abs((((a.headingTrueRad * 180 / Math.PI) - end.headingDeg + 540) % 360) - 180) : NaN;
    // lateral offset from the centreline, distance past the threshold
    let lat = NaN, along = NaN;
    if (end) {
      const f = s.world.frame, t = f.geodeticToThree(end.threshold.lat, end.threshold.lon, 0);
      const dn = a.posNED[0] - -t[2], de = a.posNED[1] - t[0], h = end.headingDeg * Math.PI / 180;
      along = dn * Math.cos(h) + de * Math.sin(h); lat = -dn * Math.sin(h) + de * Math.cos(h);
    }
    const p0 = [...a.posNED];
    s.input.controls.parkingBrake = true; s.setPaused(false); s.advance(10);
    const moved = Math.hypot(a.posNED[0] - p0[0], a.posNED[1] - p0[1]);
    return { icao, runway, used, onGround, comp, aglM: +a.altitudeAglM.toFixed(2), hdgErr: +hdgErr.toFixed(1), latM: +lat.toFixed(1), alongM: Math.round(along), moved: +moved.toFixed(2), crashed: a.crashed, vs: +a.verticalSpeedMs.toFixed(2) };
  }, st);
  const ok = !r.err && r.used && r.onGround >= 3 && r.aglM < 2 && r.comp.every((c) => c >= 0 && c < 0.25) && r.hdgErr < 2 && Math.abs(r.latM) < 5 && r.alongM >= 0 && r.alongM < 400 && r.moved < 0.5 && !r.crashed;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${JSON.stringify(r)}`);
}
console.log(JSON.stringify({ errs, bad }));
await b.close();
process.exit(bad || errs.length ? 1 : 0);
