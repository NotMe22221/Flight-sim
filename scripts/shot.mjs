#!/usr/bin/env node
/**
 * One-shot screenshot for visual iteration (run `npm run build` first).
 *
 *   node scripts/shot.mjs --out shot.png [--dist dist] [--camera cockpit] [--time morning] [--weather few]
 *        [--no-fly] [--click '#sel1,#sel2'] [--takeoff 40] [--look-yaw 0] [--look-pitch 0] [--width 1280] [--height 720] [--wait 4000]
 *
 * Boots the built app with `vite preview`, spawns at KSFO 28R, optionally flies a scripted
 * takeoff for N seconds, sets the camera/time/weather and saves one PNG.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const out = opt('--out', 'shot.png');
const port = Number(opt('--port', String(4300 + Math.floor(Math.random() * 500))));
// build privately with `npx vite build --outDir <dir>` and pass --dist <dir> when several people build at once
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort', '--outDir', opt('--dist', 'dist')], { stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('preview did not start')), 20000);
  const on = (d) => { if (String(d).includes(String(port))) { clearTimeout(t); res(); } };
  server.stdout.on('data', on); server.stderr.on('data', on);
});
const errors = [];
try {
  const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: Number(opt('--width', '1280')), height: Number(opt('--height', '720')) } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_/.test(m.text())) errors.push(m.text()); });
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__sim && window.__sim.ready, null, { timeout: 60000 });
  const noFly = args.includes('--no-fly');
  if (!noFly) {
    await page.evaluate(() => window.__sim.flyNow());
    await page.waitForFunction(() => window.__sim.terrainReady() > 0.5, null, { timeout: 30000 }).catch(() => {});
  }
  for (const sel of (opt('--click', '') || '').split(',').filter(Boolean)) {
    await page.click(sel, { timeout: 10000 }).catch((e) => errors.push(`click ${sel}: ${e.message}`));
    await page.waitForTimeout(800);
  }
  const takeoff = Number(opt('--takeoff', '0'));
  if (takeoff > 0) await page.evaluate((s) => window.__sim.flyScriptedTakeoff(s), takeoff);
  if (!noFly) await page.evaluate(([cam, time, wx]) => { window.__sim.setCamera(cam); window.__sim.setTimePreset(time); window.__sim.setWeather(wx); }, [opt('--camera', 'cockpit'), opt('--time', 'morning'), opt('--weather', 'few')]);
  const ly = Number(opt('--look-yaw', '0')), lp = Number(opt('--look-pitch', '0'));
  if (ly || lp) await page.evaluate(([y, p]) => window.__sim.look?.(y, p), [ly, lp]);
  await page.waitForTimeout(Number(opt('--wait', '4000')));
  await page.screenshot({ path: out });
  await browser.close();
} finally {
  server.kill('SIGTERM');
}
if (errors.length) { console.error('page errors:\n' + errors.join('\n')); process.exitCode = 1; }
console.log(`saved ${out}`);
