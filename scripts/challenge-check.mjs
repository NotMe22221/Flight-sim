#!/usr/bin/env node
/**
 * Landing challenges against the real terrain and flight model: for each challenge in
 * src/activities/landingChallenges.ts, start it in a running app and report whether the air start
 * trimmed, its height above the ground, the least clearance between the glide path and the terrain
 * on the way to the threshold, and 20 s hands-off (bank, vertical speed, IAS). Run `npm run build`
 * and a preview server first:  node scripts/challenge-check.mjs http://localhost:4173/
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const APP_URL = process.argv[2] ?? 'http://localhost:4173/';
const src = readFileSync(new URL('../src/activities/landingChallenges.ts', import.meta.url), 'utf8');
const defs = [...src.matchAll(/\{ id: '([a-z0-9-]+)', title: '[^']*', category: '[^']*', icao: '([A-Z0-9]+)', runway: '([0-9LRC]+)'/g)].map((m) => ({ id: m[1], icao: m[2], runway: m[3] }));
const b = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 320, height: 200 } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(APP_URL, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__sim?.ready === true, null, { timeout: 60000 });
let bad = 0;
for (const def of defs) {
  const r = await p.evaluate(async ({ id, icao, runway }) => {
    const s = window.__sim.sim; await s.nav.load();
    await s.startChallenge(id);
    const a = s.fdm.state, w = s.world;
    // least clearance between the terrain and the straight line from the start to the threshold
    // (crossing it 15 m up): what the approach overflies
    const ap = s.nav.getAirport(icao);
    const rw = ap.runways.find((r) => r.ident.split('/').some((x) => x === runway) || r.ident === runway) ?? ap.runways.find((r) => r.ident.startsWith(runway.slice(0, 2)) || r.ident.includes(String((+runway.slice(0, 2) + 18 - 1) % 36 + 1).padStart(2, '0')));
    // the threshold of this end: the runway record's threshold is its first-named end
    const first = rw.ident.split('/')[0].replace(/[LRC]/g, '');
    const thr = first === runway.replace(/[LRC]/g, '') ? rw.threshold : rw.end;
    const f = w.frame, t3 = f.geodeticToThree(thr.lat, thr.lon, 0);
    const tn = -t3[2], te = t3[0], thrUp = (thr.alt || ap.elevationM) + 15;
    const g0 = a.altitudeAglM, n0 = a.posNED[0], e0 = a.posNED[1], h0 = -a.posNED[2];
    let minClr = Infinity;
    for (let k = 0; k <= 100; k++) {
      const q = k / 100, n = n0 + (tn - n0) * q, e = e0 + (te - e0) * q;
      const gh = w.groundHeight(n, e); if (gh === null) continue;
      // the last tenth (short final, near the threshold) is low by design
      if (q < 0.9) minClr = Math.min(minClr, h0 + (thrUp - h0) * q - gh);
    }
    s.setPaused(false);
    const hands = [];
    for (let i = 0; i < 5; i++) { s.advance(4); hands.push([Math.round(a.euler[0] * 57.3), Math.round(a.verticalSpeedMs * 196.85), Math.round(a.aero.ias / 0.514444)]); }
    return { id, trimOk: !!s.fdm.trimResult?.ok, aglM: Math.round(g0), minClrM: Math.round(minClr), crashed: a.crashed, bank_vsFpm_ias: hands };
  }, def);
  const ok = r.trimOk && r.aglM >= 100 && r.minClrM > 20 && !r.crashed && r.bank_vsFpm_ias.every((x) => x.every(Number.isFinite));
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${JSON.stringify(r)}`);
}
console.log(JSON.stringify({ errs, bad }));
await b.close();
process.exit(bad || errs.length ? 1 : 0);
