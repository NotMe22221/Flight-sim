#!/usr/bin/env node
/**
 * Performance probe. Builds nothing: run `npm run build` first.
 *
 *   node scripts/perf.mjs [--out perf] [--url http://localhost:4173/] [--no-server] [--port 4173]
 *                         [--seconds 6] [--size 1280x720] [--osm <tile url template>]
 *
 * Opens the app in headless Chromium, flies a fixed set of scenarios through the `window.__sim`
 * automation hooks and records, per scenario, the simulator's own CPU timings (input, physics,
 * world, sky, instruments, render submission; exponential averages from Simulator.timings), the
 * frame rate, draw calls and triangles per frame, live geometries/textures/programs and the JS
 * heap. Writes `<out>/perf.json` and `<out>/perf.md` (a table) plus one screenshot per scenario.
 *
 * Headless Chromium renders with SwiftShader (on the CPU), so fps here is far below a real GPU:
 * compare scenarios with each other and runs with runs, not with a target frame rate. The CPU
 * timings, draw calls, triangles and memory are meaningful as they are.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes(name);
const outDir = opt('--out', 'perf');
const port = Number(opt('--port', '4173'));
const osm = opt('--osm', '');
const base = opt('--url', `http://localhost:${port}/`);
const url = osm ? `${base}${base.includes('?') ? '&' : '?'}osm=${encodeURIComponent(osm)}` : base;
const seconds = Number(opt('--seconds', '6'));
const [vw, vh] = opt('--size', '1280x720').split('x').map(Number);
mkdirSync(outDir, { recursive: true });

let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.error('playwright is not available (install it with `npm i -D playwright && npx playwright install chromium`).');
  process.exit(2);
}

let server = null;
async function startServer() {
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('vite preview did not start in 20 s')), 20000);
    const onData = (d) => { if (String(d).includes(String(port))) { clearTimeout(t); resolve(); } };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
    server.on('exit', (c) => { clearTimeout(t); reject(new Error(`vite preview exited with ${c}`)); });
  });
}

/** Scenario setup, run in the page. Each returns once the view is set; sampling follows. */
const SCENARIOS = [
  { id: 'runway-cockpit', label: 'Runway, cockpit (steam), morning', setup: () => { window.__sim.setTimePreset('morning'); window.__sim.setWeather('clear'); window.__sim.setCamera('cockpit'); } },
  { id: 'runway-chase', label: 'Runway, chase, morning', setup: () => { window.__sim.setCamera('chase'); } },
  { id: 'climb-chase', label: 'Climbing out, chase', setup: async () => { await window.__sim.flyScriptedTakeoff(40); window.__sim.setCamera('chase'); } },
  { id: 'climb-cockpit-g1000', label: 'Climbing out, cockpit (G1000)', setup: () => { window.__sim.sim.setPanel?.('g1000'); window.__sim.setCamera('cockpit'); } },
  { id: 'scattered-chase', label: 'Scattered clouds, chase, noon', setup: () => { window.__sim.sim.setPanel?.('steam'); window.__sim.setTimePreset('noon'); window.__sim.setWeather('scattered'); window.__sim.setCamera('chase'); } },
  { id: 'overcast-cockpit', label: 'Overcast, cockpit', setup: () => { window.__sim.setWeather('overcast'); window.__sim.setCamera('cockpit'); } },
  { id: 'night-chase', label: 'Night, clear, chase (lights on)', setup: () => { window.__sim.setWeather('clear'); window.__sim.setTimePreset('night'); window.__sim.setCamera('chase'); } },
];

const results = [];
const errors = [];
try {
  if (!flag('--no-server')) await startServer();
  const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info'] });
  const page = await browser.newPage({ viewport: { width: vw, height: vh } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__sim && window.__sim.ready === true, null, { timeout: 60000 });
  await page.evaluate(() => window.__sim.flyNow());
  await page.waitForFunction(() => window.__sim.terrainReady() > 0.6, null, { timeout: 90000 }).catch(() => {});

  for (const sc of SCENARIOS) {
    process.stdout.write(`${sc.id} … `);
    try {
      await page.evaluate(sc.setup);
      await page.waitForTimeout(2500); // let LOD, scenery and exposure settle
      const r = await page.evaluate(async (ms) => {
        const S = window.__sim;
        const calls = [], tris = [];
        const f0 = S.frameCount, t0 = performance.now();
        // sample draw calls per frame on every animation frame for `ms`
        await new Promise((done) => {
          const tick = () => {
            const info = S.stats().renderer;
            calls.push(info.calls); tris.push(info.triangles);
            if (performance.now() - t0 < ms) requestAnimationFrame(tick); else done();
          };
          requestAnimationFrame(tick);
        });
        const frames = S.frameCount - f0, el = performance.now() - t0;
        const st = S.stats();
        const gl = S.sim?.gfx?.renderer;
        const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
        return {
          fps: (frames * 1000) / el,
          timingsMs: st.timings,
          drawCalls: { avg: avg(calls), max: Math.max(0, ...calls) },
          triangles: { avg: avg(tris), max: Math.max(0, ...tris) },
          memory: st.memory,
          programs: gl?.info?.programs?.length ?? null,
          heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null,
          terrain: st.terrain,
          scenery: window.__scenery?.stats?.() ?? null,
        };
      }, seconds * 1000);
      await page.screenshot({ path: `${outDir}/${sc.id}.png` });
      results.push({ id: sc.id, label: sc.label, ...r });
      console.log(`${r.fps.toFixed(1)} fps, ${Math.round(r.drawCalls.avg)} calls, ${Math.round(r.triangles.avg / 1000)}k tris`);
    } catch (e) {
      errors.push(`${sc.id}: ${e && e.message || e}`);
      console.log(`failed: ${e && e.message || e}`);
    }
  }
  await browser.close();
} catch (e) {
  errors.push(`perf aborted: ${e && e.message || e}`);
} finally {
  if (server) server.kill('SIGTERM');
}

const ms = (v) => (typeof v === 'number' ? v.toFixed(2) : '–');
const rows = results.map((r) => {
  const t = r.timingsMs ?? {};
  const cpu = ['input', 'physics', 'world', 'sky', 'instruments', 'render'].reduce((a, k) => a + (t[k] ?? 0), 0);
  return `| ${r.label} | ${r.fps.toFixed(1)} | ${ms(t.physics)} | ${ms(t.world)} | ${ms(t.sky)} | ${ms(t.instruments)} | ${ms(t.render)} | ${ms(cpu)} | ${Math.round(r.drawCalls.avg)} / ${r.drawCalls.max} | ${Math.round(r.triangles.avg / 1000)}k | ${r.memory?.geometries ?? '–'} / ${r.memory?.textures ?? '–'} / ${r.programs ?? '–'} | ${r.heapMB ? r.heapMB.toFixed(0) : '–'} |`;
});
const md = [
  `# Performance probe (${vw}×${vh}, ${seconds} s per scenario${osm ? ', OSM scenery' : ''})`,
  '',
  'SwiftShader fps is relative only. CPU columns are the simulator\'s own per-frame timings in ms.',
  '',
  '| Scenario | fps | physics | world | sky | instruments | render submit | CPU total | draw calls avg / max | triangles | geometries / textures / programs | heap MB |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows,
  '',
  ...(errors.length ? ['Errors:', ...errors.map((e) => `- ${e}`)] : []),
].join('\n');
writeFileSync(`${outDir}/perf.json`, JSON.stringify({ size: [vw, vh], seconds, osm: osm || null, results, errors }, null, 2));
writeFileSync(`${outDir}/perf.md`, md + '\n');
console.log(`\n${md}`);
process.exit(errors.length && !results.length ? 1 : 0);
