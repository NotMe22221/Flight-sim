#!/usr/bin/env node
/**
 * Headless smoke test. Builds nothing: run `npm run build` first.
 *
 *   node scripts/smoke.mjs [--out screenshots] [--url http://localhost:4173/] [--no-server] [--keep-going]
 *
 * Starts `vite preview` (unless --no-server), opens the app in headless Chromium (SwiftShader
 * WebGL2), drives it through the automation hooks the app exposes on `window.__sim`, saves
 * screenshots, and fails on uncaught page errors or console errors.
 *
 * Automation contract (implemented by src/app/automation.ts):
 *   window.__sim.ready: boolean                      app booted and first frame rendered
 *   window.__sim.frameCount: number
 *   window.__sim.flyNow(opts?): Promise<void>         spawn at the default airport and enter flight
 *   window.__sim.setCamera(mode: string): void
 *   window.__sim.setTimeOfDay(localHour: number): void
 *   window.__sim.setWeather(preset: string): void
 *   window.__sim.setInputs(partial ControlInputs): void
 *   window.__sim.advance(seconds: number): Promise<void>   run sim time as fast as possible (no rendering waits)
 *   window.__sim.state(): AircraftState-like plain object
 *   window.__sim.terrainReady(): number               0..1
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes(name);
const outDir = opt('--out', 'screenshots');
const port = Number(opt('--port', '4173'));
const url = opt('--url', `http://localhost:${port}/`);
const keepGoing = flag('--keep-going');
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

const errors = [];
const warnings = [];
const report = { steps: [], errors, warnings };
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    const r = await fn();
    report.steps.push({ name, ok: true, ms: Date.now() - t0, result: r ?? null });
    console.log(`✓ ${name} (${Date.now() - t0} ms)`);
    return r;
  } catch (e) {
    report.steps.push({ name, ok: false, ms: Date.now() - t0, error: String(e && e.message || e) });
    console.log(`✗ ${name}: ${e && e.message || e}`);
    if (!keepGoing) throw e;
    return null;
  }
};

try {
  if (!flag('--no-server')) await startServer();
  const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack ?? ''}`));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') {
      // Network failures for blocked tile hosts are expected in CI containers; record as warnings.
      if (/Failed to load resource|net::ERR_|CORS|403|ERR_TUNNEL/i.test(t)) warnings.push(`console.error (network): ${t}`);
      else errors.push(`console.error: ${t}`);
    } else if (m.type() === 'warning') warnings.push(`console.warn: ${t}`);
  });

  await step('load page', async () => { await page.goto(url, { waitUntil: 'load', timeout: 60000 }); });
  await step('app ready', async () => {
    await page.waitForFunction(() => window.__sim && window.__sim.ready === true, null, { timeout: 60000 });
    await page.waitForFunction(() => window.__sim.frameCount > 5, null, { timeout: 30000 });
  });
  await step('screenshot main menu', async () => { await page.screenshot({ path: `${outDir}/01-main-menu.png` }); });
  await step('fly now', async () => { await page.evaluate(() => window.__sim.flyNow()); });
  await step('wait for terrain', async () => {
    await page.waitForFunction(() => window.__sim.terrainReady() > 0.6, null, { timeout: 60000 }).catch(() => {});
    return page.evaluate(() => window.__sim.terrainReady());
  });
  await step('screenshot cockpit on runway', async () => {
    await page.evaluate(() => { window.__sim.setTimePreset('morning'); window.__sim.setCamera('cockpit'); });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${outDir}/02-cockpit-runway.png` });
  });
  await step('screenshot external on runway', async () => {
    await page.evaluate(() => window.__sim.setCamera('external-orbit'));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${outDir}/03-external-runway.png` });
  });
  await step('takeoff and climb (sim)', async () => {
    await page.evaluate(() => window.__sim.flyScriptedTakeoff(45));
    const s = await page.evaluate(() => window.__sim.state());
    return { aglM: s.altitudeAglM, iasKt: s.aero.ias / 0.514444, onGround: s.onGround };
  });
  await step('screenshot chase in flight', async () => {
    await page.evaluate(() => window.__sim.setCamera('chase'));
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${outDir}/04-chase-climb.png` });
  });
  await step('screenshot cockpit in flight', async () => {
    await page.evaluate(() => window.__sim.setCamera('cockpit'));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${outDir}/05-cockpit-climb.png` });
  });
  await step('screenshot sunset broken clouds', async () => {
    await page.evaluate(() => { window.__sim.setWeather('broken'); window.__sim.setTimePreset('dusk'); window.__sim.setCamera('chase'); });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${outDir}/06-sunset-broken.png` });
  });
  await step('screenshot night', async () => {
    await page.evaluate(() => { window.__sim.setWeather('clear'); window.__sim.setTimePreset('night'); });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${outDir}/07-night.png` });
  });
  await step('fps sample', async () => page.evaluate(async () => {
    const f0 = window.__sim.frameCount, t0 = performance.now();
    await new Promise((r) => setTimeout(r, 6000));
    return { fps: Math.round(((window.__sim.frameCount - f0) * 10000) / (performance.now() - t0)) / 10, stats: window.__sim.stats() };
  }));
  await browser.close();
} catch (e) {
  errors.push(`smoke aborted: ${e && e.message || e}`);
} finally {
  if (server) server.kill('SIGTERM');
}

writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 2));
if (warnings.length) console.log(`${warnings.length} warnings (see ${outDir}/report.json)`);
if (errors.length) {
  console.error(`\n${errors.length} errors:\n` + errors.slice(0, 20).join('\n'));
  process.exit(1);
}
console.log('smoke OK');
