// Headless smoke test: builds nothing; expects `vite preview` or `vite dev` to be reachable at URL.
// Usage: node scripts/smoke.mjs [url] [outDir]
// Uses the globally installed Playwright + Chromium (see README).
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('playwright is not installed globally; run `npx playwright install chromium` and `npm i -D playwright`.');
  process.exit(2);
}

const url = process.argv[2] ?? 'http://localhost:4173/';
const outDir = process.argv[3] ?? 'screenshots';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });

await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
await page.waitForTimeout(4000);
await page.screenshot({ path: `${outDir}/01-initial.png` });

const ok = await page.evaluate(() => (window).__sim?.frameCount > 0);
console.log(`frames rendered: ${ok ? 'yes' : 'unknown'}`);
if (errors.length) {
  console.error('Errors:\n' + errors.join('\n'));
}
await browser.close();
process.exit(errors.length ? 1 : 0);
