// The regression suite.
//
// Every case here exists because the thing it checks is invisible: a rout that
// never ends, a pack member that cannot be killed, a naming window that
// overkill skips. None of them look wrong on screen until you are hours past
// the change that broke them.
//
//   node test/run.mjs            all
//   node test/run.mjs pack       substring filter, not a regex
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = '/tmp/claude-0/arena-test-' + process.pid + '.html';
execFileSync('node', ['build.mjs', OUT], { cwd: path.join(HERE, '..'), stdio: 'pipe' });

const filter = process.argv[2] || '';
const cases = [];
const test = (name, fn, check) => cases.push({ name, fn, check });

// ── the cases. Each runs in a FRESH page, because a wolf that died in one
//    case must not be a wolf that is already dead in the next. ──────────────

test('telegraph: the tell is long enough to react to', () => {
  const R = window.__rpg, W = R.WolfState;
  const w = R.wolves.find(x => !x.alpha);
  R.place(R.player, 0, 0); R.place(w, 0, 3.6);
  w.setTarget(R.player); w.state = W.Circle; w.nextAttackAt = 0;
  let tell = 0, seen = false;
  for (let i = 0; i < 600; i++) {
    R.step(1 / 60);
    if (w.state === W.Telegraph) { tell += 1 / 60; seen = true; }
    else if (seen) break;
  }
  return { tell: +tell.toFixed(3) };
}, r => [
  [r.tell >= 0.40, `the tell lasted ${r.tell}s — under 0.40 it cannot be answered on a touch screen`],
]);

test('telegraph: dodging on the tell avoids the bite, and NOT dodging does not', () => {
  const R = window.__rpg, W = R.WolfState;
  const bite = (dodge) => {
    const w = R.wolves.find(x => !x.alpha);
    w.health.health = w.health.maxHealth;
    R.player.health.health = R.player.health.maxHealth;
    R.place(R.player, 0, 0); R.place(w, 0, 3.6);
    w.setTarget(R.player); w.state = W.Circle; w.nextAttackAt = 0;
    const hp0 = R.player.health.health;
    let seen = false, did = false;
    for (let i = 0; i < 600; i++) {
      R.step(1 / 60);
      if (w.state === W.Telegraph) {
        seen = true;
        if (dodge && !did) { R.setMove(1, 0); R.press('dodge'); R.setMove(0, 0); did = true; }
      }
      if (seen && w.state === W.Recover) break;
    }
    return +(hp0 - R.player.health.health).toFixed(1);
  };
  return { dodged: bite(true), stood: bite(false) };
}, r => [
  // The pair is the point. "Dodging took no damage" alone is equally true of a
  // wolf that never connected, which is a test that passes forever having
  // measured nothing at all.
  [r.stood > 0, `the control took ${r.stood} damage — the wolf never connected, so this case proves nothing`],
  [r.dodged === 0, `dodging on the tell still cost ${r.dodged} damage`],
]);

test('subdue: wearing one down collapses it instead of killing it', () => {
  const R = window.__rpg;
  const w = R.wolves.find(x => !x.alpha);
  w.health.health = w.health.maxHealth * 0.2;
  w.health.takeHit({ damage: w.health.maxHealth * 0.1, impact: 0, knockback: 0, dirX: 0, dirZ: 1 });
  return { down: w.subdue.isDown, dead: w.health.dead, nameable: w.subdue.canBeNamed };
}, r => [
  [r.down, 'it did not collapse'],
  [!r.dead, 'it died instead of collapsing'],
  [r.nameable, 'it collapsed but cannot be named'],
]);

test('subdue: an overkill blow still collapses rather than skipping the window', () => {
  const R = window.__rpg;
  const w = R.wolves.find(x => !x.alpha);
  w.health.health = w.health.maxHealth * 0.2;
  // Far more than enough to kill outright. If the guard is applied after the
  // events rather than before, this silently removes the naming mechanic from
  // every fight the player is winning decisively.
  w.health.takeHit({ damage: w.health.maxHealth * 5, impact: 0, knockback: 0, dirX: 0, dirZ: 1 });
  return { down: w.subdue.isDown, dead: w.health.dead };
}, r => [
  [!r.dead, 'an overkill blow killed it outright and skipped the naming window'],
  [r.down, 'an overkill blow did not collapse it'],
]);

test('subdue: a greedy swing on a downed wolf kills it', () => {
  const R = window.__rpg;
  const w = R.wolves.find(x => !x.alpha);
  R.place(R.player, 0, 0); R.place(w, 0, 1.2);
  w.health.health = w.health.maxHealth * 0.2;
  w.health.takeHit({ damage: w.health.maxHealth * 0.1, impact: 0, knockback: 0, dirX: 0, dirZ: 1 });
  const down = w.subdue.isDown;
  R.press('attack'); R.run(1.2);
  return { down, dead: w.health.dead };
}, r => [
  [r.down, 'it never went down, so the case measured nothing'],
  [r.dead, 'hitting a downed wolf did not kill it — the tension of stopping is gone'],
]);

test('subdue: the window is winnable from six metres', () => {
  const R = window.__rpg;
  const w = R.wolves.find(x => !x.alpha);
  R.place(R.player, 0, 0); R.place(w, 0, 6);
  w.health.health = w.health.maxHealth * 0.2;
  w.health.takeHit({ damage: w.health.maxHealth * 0.1, impact: 0, knockback: 0, dirX: 0, dirZ: 1 });
  R.setMove(0, 1, true);
  let steps = 0;
  while (steps < 600 && !R.naming.candidate) { R.step(1 / 60); steps++; }
  R.setMove(0, 0);
  const left = w.subdue.remaining;
  R.press('name');
  return { reached: steps / 60, left: +left.toFixed(2), named: w.identity.named };
}, r => [
  [r.left > 1.5, `only ${r.left}s of the window was left on arrival — too tight to be a decision`],
  [r.named, 'naming failed after reaching it in time'],
]);

test('naming: a named wolf joins, is stronger, and is not unkillable', () => {
  const R = window.__rpg;
  const w = R.wolves.find(x => !x.alpha);
  const maxBefore = w.health.maxHealth;
  R.place(R.player, 0, 0); R.place(w, 0, 1.2);
  w.health.health = w.health.maxHealth * 0.2;
  w.health.takeHit({ damage: w.health.maxHealth * 0.1, impact: 0, knockback: 0, dirX: 0, dirZ: 1 });
  R.run(0.05); R.press('name'); R.run(0.05);
  return {
    named: w.identity.named, bound: w.familiar.bound, tame: !w.wild,
    stronger: w.health.maxHealth > maxBefore,
    guard: w.health.preventDeath,
    roster: R.player.roster.family.length,
    willSpent: R.player.roster.will < R.CFG.roster.maxWill,
  };
}, r => [
  [r.named && r.bound, 'it was not taken in'],
  [r.tame, 'it is still wild, so it will keep hunting the person who named it'],
  [r.stronger, 'a name did not make it stronger — then naming is only recruiting'],
  [!r.guard, 'it kept the death guard and is quietly unkillable'],
  [r.roster === 1, `roster holds ${r.roster}`],
  [r.willSpent, 'naming cost no will'],
]);

test('pack: naming the leader brings the whole pack for one place', () => {
  const R = window.__rpg;
  const leader = R.leader;
  R.place(R.player, leader.pos.x, leader.pos.z - 1.4);
  leader.health.health = leader.health.maxHealth * 0.2;
  leader.health.takeHit({ damage: leader.health.maxHealth * 0.1, impact: 0, knockback: 0, dirX: 0, dirZ: 1 });
  R.run(0.05); R.press('name'); R.run(0.2);
  const members = R.wolves.filter(w => !w.alpha);
  return {
    named: leader.identity.named,
    roster: R.player.roster.family.length,
    members: members.length,
    bound: members.filter(m => m.familiar.bound).length,
    tame: members.filter(m => !m.wild).length,
    anchored: members.filter(m => m.familiar.anchor === leader).length,
    unkillable: members.filter(m => m.health.preventDeath).length,
    // Forced down before asking. Members are on their feet after the leader is
    // named, and canBeNamed requires being down — so simply counting it here
    // was true because of the posture, not because of the allegiance, and the
    // one-slot rule was never actually tested.
    renameableWhenDown: (() => {
      let n = 0;
      for (const m of members) {
        m.subdue.isDown = true;
        if (m.subdue.canBeNamed) n++;
        m.subdue.isDown = false;
      }
      return n;
    })(),
    // The real guarantee: a member that joined without ever collapsing must
    // still be killable BY BEING HIT. An earlier version called kill(), which
    // sets health to zero directly and never consults the death guard — so it
    // reported success whether the guard was on or off.
    memberDies: (() => {
      const m = members[0];
      if (!m) return true;
      m.health.takeHit({ damage: m.health.maxHealth * 10, impact: 0, knockback: 0, dirX: 0, dirZ: 1 });
      return m.health.dead;
    })(),
  };
}, r => [
  [r.named, 'the leader was not named, so the case measured nothing'],
  [r.roster === 1, `the pack took ${r.roster} roster places — a leader is meant to cost one`],
  [r.bound === r.members, `only ${r.bound}/${r.members} of the pack changed hands`],
  [r.tame === r.members, `${r.members - r.tame} of the pack are still wild and will hunt their own master`],
  [r.anchored === r.members, 'the pack is not anchored to its leader, so the hierarchy is not real'],
  [r.unkillable === 0, `${r.unkillable} pack members kept the death guard`],
  [r.memberDies, 'a pack member could not be killed — it joined without ever collapsing and kept the death guard'],
  [r.renameableWhenDown === 0, `${r.renameableWhenDown} pack members could still be named individually, which breaks the one-slot rule`],
]);

test('pack: the leader going down makes the pack hesitate, dying makes it rout', () => {
  const R = window.__rpg, W = R.WolfState;
  const leader = R.leader;
  R.place(R.player, 0, 20); R.run(3);
  const engaged = R.wolves.filter(w => !w.alpha && w.engaged).length;
  leader.health.health = leader.health.maxHealth * 0.2;
  leader.health.takeHit({ damage: leader.health.maxHealth * 0.1, impact: 0, knockback: 0, dirX: 0, dirZ: 1 });
  R.run(0.2);
  const hesitating = R.wolves.filter(w => !w.alpha && w.state === W.Routing).length;
  const before = R.wolves.filter(w => !w.alpha)
    .map(w => Math.hypot(w.pos.x - R.player.pos.x, w.pos.z - R.player.pos.z));
  leader.health.kill();
  R.run(3);
  const after = R.wolves.filter(w => !w.alpha)
    .map(w => Math.hypot(w.pos.x - R.player.pos.x, w.pos.z - R.player.pos.z));
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  return { engaged, hesitating, fled: +(avg(after) - avg(before)).toFixed(1) };
}, r => [
  [r.engaged > 0, 'the pack never engaged, so the case measured nothing'],
  [r.hesitating > 0, 'the pack did not waver when its leader went down'],
  [r.fled > 6, `the pack only moved ${r.fled}m after losing its leader — that is not a rout`],
]);

test('pack: a routed wolf comes back if you stay, and stays gone if you leave', () => {
  const R = window.__rpg, W = R.WolfState;
  const w = R.wolves.find(x => !x.alpha);
  // Stay: it should recover its nerve and re-engage.
  R.place(R.player, 0, 0); R.place(w, 0, 5);
  w.setTarget(R.player); w.wild = true;
  w.rout(R.player.pos.x, R.player.pos.z, 0.6);
  R.run(0.7);
  R.place(w, 0, 5);                       // it ran; put it back within notice
  R.run(1.2);
  const cameBack = w.state !== W.Idle && w.state !== W.Routing;

  // Leave: out past notice range, it should stay pacified.
  const w2 = R.wolves.filter(x => !x.alpha)[1];
  R.place(R.player, 0, 0); R.place(w2, 0, 5);
  w2.setTarget(R.player); w2.wild = true;
  w2.rout(R.player.pos.x, R.player.pos.z, 0.6);
  R.run(0.7);
  R.place(R.player, 0, -60); R.place(w2, 0, 5);
  R.run(2.0);
  return { cameBack, stayedGone: w2.state === W.Idle };
}, r => [
  // Without re-acquisition, scattering a pack pacifies it permanently — which
  // makes routing strictly better than killing the leader, the exact opposite
  // of what the morale system is for.
  [r.cameBack, 'a routed wolf never re-engaged with the player standing right there — routing is a permanent win'],
  [r.stayedGone, 'a routed wolf came hunting again after the player left — the rout bought nothing'],
]);

test('pack: only one monster commits to an attack at a time', () => {
  const R = window.__rpg, W = R.WolfState;
  R.place(R.player, 0, 20);
  let worst = 0;
  for (let i = 0; i < 60 * 12; i++) {
    R.step(1 / 60);
    const n = R.wolves.filter(w => w.state === W.Telegraph || w.state === W.Lunge).length;
    if (n > worst) worst = n;
    if (R.player.health.dead) break;
  }
  return { worst, cap: R.CFG.wolf.maxCommitting };
}, r => [
  [r.worst > 0, 'nothing ever attacked, so the case measured nothing'],
  // Hard-coded ON PURPOSE. An earlier version asserted against
  // CFG.wolf.maxCommitting, so raising the cap raised the assertion with it and
  // the case could never fail — it was checking the config against itself.
  [r.worst <= 1, `${r.worst} monsters committed at once — simultaneous tells cannot be answered, so the tell stops being a contract`],
  [r.cap === 1, `the cap is configured at ${r.cap}; this case is written for one`],
]);

test('familiar: an unbound familiar does not hunt its own pack', () => {
  const R = window.__rpg;
  R.place(R.player, 0, -60);          // far outside everyone's notice
  // Targets must be CLEARED first. Every wolf spawns pointed at the player, and
  // the familiar layer only looks for something new when it holds nothing — so
  // an earlier version of this case never reached the code it was about, and
  // passed no matter what the familiar layer did.
  for (const w of R.wolves) { w.setTarget(null); w.wild = false; }
  R.run(3);
  const hunting = R.wolves.filter(w => w.target && w.target !== R.player).length;
  return {
    hunting, bound: R.wolves.filter(w => w.familiar.bound).length,
    cleared: R.wolves.length,
  };
}, r => [
  [r.bound === 0, 'a wild wolf is already bound, so the case measured nothing'],
  [r.hunting === 0, `${r.hunting} unbound wolves picked targets — the familiar layer is running before it has a master, so a pack would hunt itself`],
]);

test('familiar: a named wolf cannot bite its own master', () => {
  const R = window.__rpg;
  const w = R.wolves.find(x => !x.alpha);
  R.place(R.player, 0, 0); R.place(w, 0, 1.2);
  w.health.health = w.health.maxHealth * 0.2;
  w.health.takeHit({ damage: w.health.maxHealth * 0.1, impact: 0, knockback: 0, dirX: 0, dirZ: 1 });
  R.run(0.05); R.press('name'); R.run(0.05);
  const named = w.identity.named;
  // Force it to swing straight at the player and see whether anything lands.
  R.place(w, 0, 0.6);
  w.yaw = Math.atan2(R.player.pos.x - w.pos.x, R.player.pos.z - w.pos.z);
  const hp0 = R.player.health.health;
  w.swing.begin({ damage: 50, impact: 10, knockback: 0 }, 3, 2);
  for (let i = 0; i < 10; i++) { w.swing.sweep(R.world.actors, t => w.hostileTo(t)); R.step(1 / 60); }
  return { named, hurt: +(hp0 - R.player.health.health).toFixed(1) };
}, r => [
  [r.named, 'it was never named, so the case measured nothing'],
  [r.hurt === 0, `your own familiar did ${r.hurt} damage to you`],
]);

test('roster: capacity and will both refuse a name', () => {
  const R = window.__rpg;
  const w = R.wolves.find(x => !x.alpha);
  R.player.roster.will = 0;
  const noWill = R.player.roster.canName(w);
  R.player.roster.will = R.CFG.roster.maxWill;
  R.player.roster.family = [1, 2, 3];       // stand-ins; canName only counts them
  const noRoom = R.player.roster.canName(w);
  return { noWill: !!noWill, noRoom: !!noRoom, willText: noWill || '', roomText: noRoom || '' };
}, r => [
  [r.noWill && /will/i.test(r.willText), `an empty will pool did not refuse: ${JSON.stringify(r.willText)}`],
  [r.noRoom && /room/i.test(r.roomText), `a full roster did not refuse: ${JSON.stringify(r.roomText)}`],
]);

test('combat: the chain escalates and attacks commit', () => {
  const R = window.__rpg, S = R.PlayerState;
  const spec = R.CFG.chain;
  R.press('attack'); R.run(0.02);
  const startedWindup = R.player.state === S.Windup;
  // A second press mid-swing must not cancel it — it is remembered instead.
  const stepAt = R.player.step;
  R.press('attack'); R.run(0.02);
  const stillSameSwing = R.player.step === stepAt &&
    (R.player.state === S.Windup || R.player.state === S.Active);
  return {
    startedWindup, stillSameSwing,
    escalates: spec[2].damage > spec[1].damage && spec[1].damage > spec[0].damage,
    commitsLonger: spec[2].recovery > spec[0].recovery,
  };
}, r => [
  [r.startedWindup, 'pressing attack did not start a swing'],
  [r.stillSameSwing, 'a second press cancelled the swing in progress — attacks are not committing'],
  [r.escalates, 'the chain does not escalate, so there is no reason to risk the third swing'],
  [r.commitsLonger, 'the heavy swing does not commit longer than the light one'],
]);

// ── runner ────────────────────────────────────────────────────────────────
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
});

let passed = 0, failed = 0, skipped = 0;
for (const c of cases) {
  if (filter && !c.name.includes(filter)) { skipped++; continue; }
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto('file://' + OUT);
    await page.waitForFunction('window.__rpg !== undefined', { timeout: 15000 });
    await page.evaluate(() => window.__rpg.pause());
    const result = await page.evaluate(c.fn);
    const checks = c.check(result);
    const bad = checks.filter(([ok]) => !ok);
    if (errors.length) throw new Error('page error: ' + errors[0]);
    if (bad.length) {
      failed++;
      console.log(`FAIL  ${c.name}`);
      for (const [, why] of bad) console.log(`        ${why}`);
      console.log(`        state: ${JSON.stringify(result)}`);
    } else {
      passed++;
      console.log(`ok    ${c.name}`);
    }
  } catch (e) {
    failed++;
    console.log(`ERROR ${c.name}\n        ${e.message}`);
  }
  await page.close();
}
await browser.close();
console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} filtered out` : ''}`);
process.exit(failed ? 1 : 0);
