// Render the arena and save stills. Never trust code-reading for a visual
// claim: look at it.
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const CHROME = process.env.CHROME_PATH ||
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = '/tmp/claude-0/arena-shot.html';
execFileSync('node', ['build.mjs', OUT], { cwd: path.join(HERE, '..'), stdio: 'pipe' });

// A phone in portrait is the actual target, so that is the default viewport.
const viewport = process.env.LANDSCAPE
  ? { width: 900, height: 460 }
  : { width: 412, height: 892 };

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-gpu-sandbox', '--no-sandbox'],
});
// hasTouch flips the CSS `pointer: coarse` query, which is what decides
// whether the on-screen controls exist at all. Rendering this without it would
// have "verified" a phone build while looking at the desktop one.
const page = await browser.newPage({
  viewport, deviceScaleFactor: 2,
  hasTouch: !!process.env.TOUCH, isMobile: !!process.env.TOUCH,
});
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto('file://' + OUT);
await page.waitForFunction('window.__rpg !== undefined', { timeout: 15000 });

const shots = JSON.parse(process.env.SHOTS || '[]');
if (shots.length === 0) shots.push({ name: 'start', script: '' });

for (const s of shots) {
  if (s.script) await page.evaluate(s.script);
  // Two frames so the render catches up with whatever the script changed.
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const file = `/tmp/claude-0/shot-${s.name}.png`;
  await page.screenshot({ path: file });
  console.log('shot', file);
}

const report = await page.evaluate(() => {
  const R = window.__rpg;
  return {
    time: +R.world.time.toFixed(2),
    actors: R.world.actors.length,
    player: { hp: R.player.health.health, state: R.player.state,
              x: +R.player.pos.x.toFixed(2), z: +R.player.pos.z.toFixed(2) },
    wolves: R.wolves.map(w => ({
      alpha: w.alpha, state: w.state, hp: Math.round(w.health.health),
      d: +Math.hypot(w.pos.x - R.player.pos.x, w.pos.z - R.player.pos.z).toFixed(1),
    })),
  };
});
console.log(JSON.stringify(report, null, 1));
if (errors.length) { console.log('ERRORS:'); errors.forEach(e => console.log(' ', e)); }
await browser.close();
process.exit(errors.length ? 1 : 0);
