// Measure the things a still cannot answer.
//
// Every number here is one that decides whether the game is fair, and every one
// of them was a guess until this ran. This is the whole reason the browser
// version exists: the Unity build could only ever be compiled.
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = '/tmp/claude-0/arena-measure.html';
execFileSync('node', ['build.mjs', OUT], { cwd: path.join(HERE, '..'), stdio: 'pipe' });

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
});

async function fresh() {
  const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
  page.on('pageerror', e => { throw new Error('page error: ' + e.message); });
  await page.goto('file://' + OUT);
  await page.waitForFunction('window.__rpg !== undefined', { timeout: 15000 });
  // The render loop must not advance the world behind the measurement's back.
  await page.evaluate(() => window.__rpg.pause());
  return page;
}

const results = {};
async function measure(name, fn) {
  const page = await fresh();
  results[name] = await page.evaluate(fn);
  await page.close();
}

// ── 1. Is the telegraph long enough to answer? ─────────────────────────────
await measure('telegraph', () => {
  const R = window.__rpg, W = R.WolfState;
  const w = R.wolves.find(x => !x.alpha), a = R.wolves.find(x => x.alpha);
  const out = {};
  for (const [key, wolf] of [['wolf', w], ['alpha', a]]) {
    // Park it in front of the player and let it decide to attack.
    R.place(wolf, 0, 3.6);
    wolf.setTarget(R.player);
    wolf.state = W.Circle;
    let tell = 0, lunge = 0, sawTell = false;
    for (let i = 0; i < 60 * 12; i++) {
      R.step(1 / 60);
      if (wolf.state === W.Telegraph) { tell += 1 / 60; sawTell = true; }
      else if (sawTell && wolf.state === W.Lunge) lunge += 1 / 60;
      else if (sawTell && wolf.state === W.Recover) break;
    }
    out[key] = { tellSeconds: +tell.toFixed(3), lungeSeconds: +lunge.toFixed(3) };
  }
  out.dodgeDuration = R.CFG.player.dodgeDuration;
  out.dodgeIFrames = R.CFG.player.dodgeIFrames;
  return out;
});

// ── 2. Can a dodge on the tell actually beat the lunge? ────────────────────
await measure('dodgeBeatsLunge', () => {
  const R = window.__rpg, W = R.WolfState;
  const runs = [];
  // React at several points through the tell, including the last instant.
  for (const reactAt of [0.0, 0.25, 0.5, 0.75, 0.95]) {
    const page = R.world;
    const w = R.wolves.find(x => !x.alpha);
    w.health.health = w.health.maxHealth;
    R.player.health.health = R.player.health.maxHealth;
    R.place(R.player, 0, 0);
    R.place(w, 0, 3.6);
    w.setTarget(R.player); w.state = W.Circle; w.nextAttackAt = 0;

    let tellSeen = 0, dodged = false, hpBefore = R.player.health.health;
    for (let i = 0; i < 60 * 10; i++) {
      R.step(1 / 60);
      if (w.state === W.Telegraph) {
        tellSeen += 1 / 60;
        if (!dodged && tellSeen >= w.telegraphFor * reactAt) {
          // Roll sideways, which is what a player who read the tell does.
          R.setMove(1, 0);
          R.press('dodge');
          R.setMove(0, 0);
          dodged = true;
        }
      }
      if (dodged && w.state === W.Recover) break;
    }
    runs.push({ reactAt, hurt: +(hpBefore - R.player.health.health).toFixed(1) });
  }

  // THE CONTROL. Without it "dodging avoided all damage" is worthless: it is
  // equally consistent with the wolf never having connected at all, which is
  // exactly the kind of test that passes forever while measuring nothing.
  {
    const w = R.wolves.find(x => !x.alpha);
    w.health.health = w.health.maxHealth;
    R.player.health.health = R.player.health.maxHealth;
    R.place(R.player, 0, 0); R.place(w, 0, 3.6);
    w.setTarget(R.player); w.state = W.Circle; w.nextAttackAt = 0;
    const hp0 = R.player.health.health;
    let sawTell = false;
    for (let i = 0; i < 60 * 10; i++) {
      R.step(1 / 60);
      if (w.state === W.Telegraph) sawTell = true;
      if (sawTell && w.state === W.Recover) break;
    }
    runs.push({ reactAt: 'NO DODGE (control)', hurt: +(hp0 - R.player.health.health).toFixed(1) });
  }

  return runs;
});

// ── 3. What does the whole pack cost you? ─────────────────────────────────
await measure('packPressure', () => {
  const R = window.__rpg;
  R.place(R.player, 0, 20);          // walk into them and stand still
  const before = R.player.health.health;
  R.run(10);
  return {
    hpLostIn10s: +(before - R.player.health.health).toFixed(1),
    maxHp: R.player.health.maxHealth,
    survivedSeconds: R.player.health.dead ? '<10' : '>10',
    committedAtOnce: R.world.committed.size,
    maxCommitting: R.CFG.wolf.maxCommitting,
    packSize: R.wolves.length,
  };
});

// ── 3b. How long does a standing player actually last? ────────────────────
await measure('timeToDeath', () => {
  const R = window.__rpg;
  R.place(R.player, 0, 20);
  let t = 0, hits = 0;
  const before = R.player.health.health;
  while (t < 60 && !R.player.health.dead) { R.step(1 / 60); t += 1 / 60; }
  return {
    secondsStandingStill: R.player.health.dead ? +t.toFixed(1) : '>60',
    hitsPerSecond: +((before - Math.max(0, R.player.health.health)) / 12 / Math.max(t, 0.01)).toFixed(2),
  };
});

// ── 3c. And how fast can the player answer? ───────────────────────────────
await measure('killSpeed', () => {
  const R = window.__rpg;
  const w = R.wolves.find(x => !x.alpha);
  R.place(R.player, 0, 0);
  w.setTarget(null); w.wild = false;          // a punching bag, to isolate offence
  const hp = w.health.health;
  let t = 0, swings = 0;
  while (t < 20 && !w.subdue.isDown) {
    if (R.player.state === R.PlayerState.Idle) { R.press('attack'); swings++; }
    R.place(w, 0, 1.3);                        // held in reach
    R.step(1 / 60); t += 1 / 60;
  }
  const packHp = R.wolves.reduce((a, x) => a + x.health.maxHealth, 0);
  return {
    secondsToDropOneWolf: +t.toFixed(2), swings,
    dps: +((hp - w.health.health) / Math.max(t, 0.01)).toFixed(1),
    wholePackHp: packHp,
  };
});

// ── 4. Is the collapse window winnable? ───────────────────────────────────
await measure('collapseWindow', () => {
  const R = window.__rpg;
  const w = R.wolves.find(x => !x.alpha);
  R.place(R.player, 0, 0);
  R.place(w, 0, 6);                   // six metres away when it breaks
  w.health.health = w.health.maxHealth * 0.2;
  w.health.takeHit({ damage: w.health.maxHealth * 0.10, impact: 0, knockback: 0, dirX: 0, dirZ: 1 });
  const collapsed = w.subdue.isDown;

  // Walk over at running speed and see how much of the window is left.
  R.setMove(0, 1, true);
  let steps = 0;
  while (steps < 60 * 10 && !R.naming.candidate) { R.step(1 / 60); steps++; }
  R.setMove(0, 0);
  const left = w.subdue.remaining;
  const named = (() => { R.press('name'); return w.identity.named; })();
  return {
    collapsed,
    secondsToReach: +(steps / 60).toFixed(2),
    windowLeft: +left.toFixed(2),
    windowTotal: R.CFG.subdue.downFor,
    named,
  };
});

// ── 5. Does a greedy swing actually cost you the wolf? ────────────────────
await measure('greedyKills', () => {
  const R = window.__rpg;
  const w = R.wolves.find(x => !x.alpha);
  R.place(R.player, 0, 0); R.place(w, 0, 1.2);
  w.health.health = w.health.maxHealth * 0.2;
  w.health.takeHit({ damage: w.health.maxHealth * 0.1, impact: 0, knockback: 0, dirX: 0, dirZ: 1 });
  const down = w.subdue.isDown;
  R.press('attack');
  R.run(1.2);
  return { collapsedFirst: down, deadAfterExtraSwing: w.health.dead };
});

// ── 6. Pack morale ────────────────────────────────────────────────────────
await measure('morale', () => {
  const R = window.__rpg, W = R.WolfState;
  const leader = R.leader;
  R.place(R.player, 0, 20);
  R.run(3);                            // get them engaged
  const engagedBefore = R.wolves.filter(w => w.engaged && !w.alpha).length;

  leader.health.health = leader.health.maxHealth * 0.2;
  leader.health.takeHit({ damage: leader.health.maxHealth * 0.1, impact: 0, knockback: 0, dirX: 0, dirZ: 1 });
  const leaderDown = leader.subdue.isDown;
  R.run(0.2);
  const hesitating = R.wolves.filter(w => !w.alpha && w.state === W.Routing).length;

  leader.health.kill();
  R.run(0.2);
  const routing = R.wolves.filter(w => !w.alpha && w.state === W.Routing).length;
  const distBefore = R.wolves.filter(w => !w.alpha)
    .map(w => Math.hypot(w.pos.x - R.player.pos.x, w.pos.z - R.player.pos.z));
  R.run(3);
  const distAfter = R.wolves.filter(w => !w.alpha)
    .map(w => Math.hypot(w.pos.x - R.player.pos.x, w.pos.z - R.player.pos.z));
  return {
    engagedBefore, leaderDown, hesitating, routing,
    fledMetres: +(distAfter.reduce((a, b) => a + b, 0) / distAfter.length -
                  distBefore.reduce((a, b) => a + b, 0) / distBefore.length).toFixed(1),
  };
});

// ── 7. Naming the leader takes the pack ───────────────────────────────────
await measure('leaderTakesPack', () => {
  const R = window.__rpg;
  const leader = R.leader;
  R.place(R.player, leader.pos.x, leader.pos.z - 1.5);
  leader.health.health = leader.health.maxHealth * 0.2;
  leader.health.takeHit({ damage: leader.health.maxHealth * 0.1, impact: 0, knockback: 0, dirX: 0, dirZ: 1 });
  R.run(0.1);
  const candidate = R.naming.candidate === leader;
  R.press('name');
  R.run(0.2);
  const members = R.wolves.filter(w => !w.alpha);
  return {
    candidate,
    leaderNamed: leader.identity.named,
    rosterCount: R.player.roster.family.length,
    membersBound: members.filter(m => m.familiar.bound).length,
    membersTame: members.filter(m => !m.wild).length,
    membersAnchoredToLeader: members.filter(m => m.familiar.anchor === leader).length,
    membersUnkillable: members.filter(m => m.health.preventDeath).length,
  };
});

console.log(JSON.stringify(results, null, 1));
await browser.close();
