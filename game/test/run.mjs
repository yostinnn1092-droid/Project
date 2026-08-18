// Regression suite for Kinesis.
//
// Every case here exists because the corresponding bug actually shipped during
// development and was caught by hand. The point of the file is that the next
// one is caught without anybody remembering to look.
//
//   node test/run.mjs            run everything
//   node test/run.mjs ring       run only cases whose name contains "ring"
//
// Exit code 0 = all passed, 1 = at least one failure.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const GAME = path.resolve(HERE, "..");

// Playwright is installed globally in this environment rather than as a project
// dependency, so resolve it from there before giving up.
let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  const globalDir = "/opt/node22/lib/node_modules";
  ({ chromium } = require(path.join(globalDir, "playwright")));
}

// Chromium ships with the image; never download one.
const CHROME = process.env.CHROME_PATH ||
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

// ── build a probe-instrumented page ─────────────────────────────────────────
const OUT = path.join(os.tmpdir(), "kinesis-test-" + process.pid + ".html");
execFileSync("node", ["build.mjs", OUT, "probe"], {
  cwd: GAME,
  env: { ...process.env, PROBE: path.join(HERE, "probe.js") },
  stdio: "pipe",
});

// ── tiny assertion kit ──────────────────────────────────────────────────────
const cases = [];
const test = (name, fn) => cases.push({ name, fn });
class Failed extends Error {}
function ok(cond, msg) { if (!cond) throw new Failed(msg); }
function eq(actual, expected, msg) {
  if (actual !== expected)
    throw new Failed(`${msg}\n      expected: ${expected}\n      actual:   ${actual}`);
}
function near(actual, expected, tol, msg) {
  if (Math.abs(actual - expected) > tol)
    throw new Failed(`${msg}\n      expected: ${expected} ±${tol}\n      actual:   ${actual}`);
}

// ═══════════════════════════════════════════════════════════════════ cases

test("boot: no page or console errors", async (pg, errs) => {
  ok(errs.length === 0, "errors during boot and first seconds:\n      " + errs.join("\n      "));
});

test("build: probe never leaks into a shipped file", async () => {
  const shipped = path.resolve(GAME, "..", "kinesis3d.html");
  const html = fs.readFileSync(shipped, "utf8");
  ok(!html.includes("__probe"),
     "the published kinesis3d.html contains probe hooks — it was built with `probe`");
});

test("waves: every wave builds and spawns bodies", async (pg) => {
  const r = await pg.evaluate(() => {
    const P = window.__probe, out = [];
    for (let n = 1; n <= 12; n++) {
      P.buildWave(n);
      out.push({ n, bodies: P.walkers.filter(w => !w.dead).length });
    }
    return out;
  });
  for (const w of r) ok(w.bodies > 0, `wave ${w.n} spawned nothing`);
});

test("waves: no wave exceeds the body ceiling", async (pg) => {
  const worst = await pg.evaluate(() => {
    const P = window.__probe; let m = 0;
    for (let n = 1; n <= 30; n++) {
      P.buildWave(n);
      m = Math.max(m, P.walkers.filter(w => !w.dead).length);
    }
    return { m, cap: P.CFG.maxWaveBodies };
  });
  ok(worst.m <= worst.cap,
     `a wave produced ${worst.m} bodies against a ceiling of ${worst.cap}; the ` +
     `separation pass is O(n^2) and this is what keeps it affordable`);
});

test("durability: no common archetype dies to a single rock", async (pg) => {
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    const rock = P.OBJECTS.rock.dmg;
    const weak = [];
    for (const k in P.ENEMIES) {
      const e = P.ENEMIES[k];
      if (k === "tank" || k === "spawner") continue;   // heavies, never one-tap anyway
      if (e.hp <= rock) weak.push(k + "(" + e.hp + "hp)");
    }
    return { rock, weak };
  });
  ok(r.weak.length === 0,
     `one rock does ${r.rock} damage and these die to it outright: ${r.weak.join(", ")}`);
});

test("archer: present from wave 3 onward", async (pg) => {
  // roster(), not counts(): only bosses are lifted into the opening group, so a
  // lone archer legitimately arrives in a later pulse about 40% of the time.
  // Asking counts() made this case a coin flip that happened to keep landing
  // heads. Eight passes per wave, because one is not evidence about anything
  // downstream of a shuffle.
  const r = await pg.evaluate(() => {
    const P = window.__probe, out = {};
    for (let n = 3; n <= 8; n++) {
      out[n] = 0;
      for (let pass = 0; pass < 8; pass++) {
        P.buildWave(n);
        if ((P.roster().archer || 0) > 0) out[n]++;
      }
    }
    return out;
  });
  for (const n of Object.keys(r))
    eq(r[n], 8, `wave ${n} contained no archer on some passes ` +
                `(an archetype nobody meets is not in the game)`);
});

test("archer: carries a bow silhouette", async (pg) => {
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.parkWalkers();
    P.spawnWalker("archer", P.hero.pos.x + 2, P.hero.pos.z - 9);
    const a = P.walkers[P.walkers.length - 1];
    return { hasNock: !!a.g.userData.nock };
  });
  ok(r.hasNock,
     "the archer has no lit nock: an archetype needs a silhouette, not only a statline");
});

test("archetypes: no two enemies are the same silhouette at the same size", async (pg) => {
  // The archer once shipped "with only a skin-tone difference and was invisible
  // at range". That was never only the archer: measured, NINE of the thirteen
  // archetypes are built from a byte-identical part list, and several sit
  // within a few percent of each other in scale. On a dark arena that is one
  // enemy wearing nine hats.
  //
  // Colour is deliberately NOT part of the signature. Hue is what failed the
  // archer, so a test that accepts hue as distinctness would bless the bug.
  // Scale IS allowed to distinguish — the crawler at 0.58 and the tank at 1.42
  // genuinely read differently across a room — but only when the gap is large.
  const r = await pg.evaluate(() => {
    const P = window.__probe, sigs = {};
    for (const t of Object.keys(P.ENEMIES)) {
      P.parkWalkers();
      P.spawnWalker(t, 0, -10);
      const w = P.walkers[P.walkers.length - 1];
      const kinds = {};
      w.g.traverse(o => {
        if (o.isMesh && o.geometry) {
          const k = o.geometry.type.replace("Geometry", "");
          kinds[k] = (kinds[k] || 0) + 1;
        }
      });
      // Part counts alone are too coarse: three quills swept back off the
      // skull and three fins running down the spine both read as "Cone3",
      // and they are plainly different shapes. Fold in the normalised
      // bounding box so WHERE the mass sits counts too. Divided by height,
      // so this still refuses to treat pure scaling as a silhouette.
      const box = new window.THREE.Box3().setFromObject(w.g);
      const sz = box.getSize(new window.THREE.Vector3());
      const prof = sz.y > 1e-3
        ? (sz.x / sz.y).toFixed(1) + "x" + (sz.z / sz.y).toFixed(1) : "flat";
      sigs[t] = { shape: Object.entries(kinds).sort().map(([k, v]) => k + v).join("/") + "|" + prof,
                  scale: P.ENEMIES[t].scale || 1 };
    }
    const clashes = [];
    const names = Object.keys(sigs);
    for (let i = 0; i < names.length; i++)
      for (let j = i + 1; j < names.length; j++) {
        const a = sigs[names[i]], b = sigs[names[j]];
        if (a.shape !== b.shape) continue;
        const ratio = Math.max(a.scale, b.scale) / Math.min(a.scale, b.scale);
        if (ratio < 1.25) clashes.push(`${names[i]}/${names[j]}`);
      }
    return { total: names.length, clashes };
  });
  eq(r.clashes.length, 0,
     `${r.clashes.length} archetype pairs share a part list AND a size, so they ` +
     `are the same silhouette in play: ${r.clashes.slice(0, 8).join(", ")}` +
     (r.clashes.length > 8 ? ` (+${r.clashes.length - 8} more)` : ""));
});

test("archer: draws, fires, and its arrow can hit", async (pg) => {
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.parkWalkers(); P.stripProps();
    P.spawnWalker("archer", P.hero.pos.x, P.hero.pos.z - 14);
    const a = P.walkers[P.walkers.length - 1];
    a.aggro = true;
    const hp0 = P.hero.hp;
    let drew = false;
    for (let t = 0; t < 26; t += 1 / 60) { P.step(1 / 60); if (a.drawT > 0) drew = true; }
    return { drew, hits: hp0 - P.hero.hp };
  });
  ok(r.drew, "the archer never drew its bow");
  ok(r.hits > 0, "the archer drew but never landed a hit in 26 simulated seconds");
});

test("archer: dashing beats an arrow", async (pg) => {
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.parkWalkers(); P.stripProps();
    P.hero.hp = 5; P.arrows.length = 0;
    P.spawnWalker("archer", P.hero.pos.x, P.hero.pos.z - 3);
    const a = P.walkers[P.walkers.length - 1];
    a.aggro = true; a.drawT = 0.0001; a.arrowT = -1;
    P.step(1 / 60);
    for (let t = 0; t < 1.2; t += 1 / 60) { P.S.dashT = 0.15; P.step(1 / 60); }
    return { hp: P.hero.hp };
  });
  eq(r.hp, 5, "dashing did not grant immunity to an arrow, but it does to everything else");
});

test("abilities: every special actually fires", async (pg) => {
  // Statlines are cheap to write and easy to leave unwired. Everything below
  // was measured to fire before it was asserted — including two measurements
  // that had to be redone, which is why the details matter:
  //   spawner  — count its OWN spawn type, not total bodies. A total baseline
  //              includes parked bodies that die during the run and masks the
  //              growth; the first version reported "never fired" while the
  //              spawner's own brood counter said five.
  //   exploder — "it died" is not "it detonated". Put a bystander inside the
  //              blast radius and check the bystander.
  const r = await pg.evaluate(() => {
    const P = window.__probe, out = {};
    // Props are stripped: buildWave scatters barrels and chem, and those kill
    // things. A subject that died to a barrel reports its ability as "never
    // fired" while the ability is perfectly fine — that cost three flaky runs
    // before it was pinned down. Anything that needs a prop spawns its own.
    const fresh = (type, d) => {
      P.buildWave(2); P.parkWalkers(); P.stripProps();
      for (const o of P.rocks) o.gone = true;
      P.hero.pos.set(0, 0, 0); P.hero.hp = 99; P.S.strain = 0; P.S.grabbed = 0;
      P.spawnWalker(type, 0, -d);
      return P.walkers[P.walkers.length - 1];
    };
    const run = s => { for (let i = 0; i < 60 * s; i++) { P.hero.pos.set(0,0,0); P.step(1/60); } };

    // Ask the spawner's OWN counter. Counting bodies on the field depends on
    // what else is alive and what died meanwhile — that made this flaky in
    // both directions: a false "never fired" AND a pass for the wrong reason.
    { const w = fresh("spawner", 12); run(25);
      out.spawner = (w.brood || 0) > 0;
      out.__spawnerAlive = !w.dead; }

    // The warper hurls a prop, and only finds one within 13 units. buildWave
    // scatters props at random, so sometimes there was nothing in reach and
    // the check failed on correct code. Put one where it can be found.
    { fresh("warper", 10); P.spawnObject("rock", 1.5, -10); let h = 0;
      for (let i = 0; i < 60*25; i++) { P.hero.pos.set(0,0,0); P.step(1/60);
        h = Math.max(h, P.rocks.filter(o => o.hostile > 0).length); }
      out.warper = h > 0; }

    { fresh("disruptor", 8); P.S.strain = 0; let peak = 0;
      for (let i = 0; i < 60*25; i++) { P.hero.pos.set(0,0,0); P.step(1/60);
        peak = Math.max(peak, P.S.strain); }
      out.disruptor = peak > 0.01; }

    { fresh("grabber", 3); let g = 0;
      for (let i = 0; i < 60*25; i++) { P.hero.pos.set(0,0,0); P.step(1/60);
        g = Math.max(g, P.S.grabbed || 0); }
      out.grabber = g > 0; }

    // Held at 12 units. The leap gate is `dist > 4 && dist < 20`, so a leaper
    // left to walk in closes inside 4 and then never leaps — this check was a
    // coin flip until it was pinned, and it lost the toss on its first
    // mutation run while the game code was untouched.
    { fresh("leaper", 12); const w = P.walkers[P.walkers.length-1]; let air = false;
      for (let i = 0; i < 60*25; i++) {
        P.hero.pos.set(0,0,0);
        if (!w.air) w.pos.set(0, w.pos.y, -12);
        P.step(1/60); if (w.air) air = true; }
      out.leaper = air; }

    { P.buildWave(2); P.parkWalkers(); P.stripProps(); P.hero.pos.set(0,0,0);
      P.spawnWalker("exploder", 0, -20); const ex = P.walkers[P.walkers.length-1];
      P.spawnWalker("tank", 1.5, -20);   const by = P.walkers[P.walkers.length-1];
      by.pos.set(1.5,0,-20); ex.pos.set(0,0,-20);
      const hp0 = by.hp;
      P.damageWalker(ex, 99999, null, 0, "impact");
      for (let i = 0; i < 60*3; i++) { by.pos.set(1.5,0,-20); P.step(1/60); }
      out.exploder = by.hp < hp0; }

    { const w = fresh("shield", 6), hp0 = w.hp;
      P.damageWalker(w, 200, new window.THREE.Vector3(0,0,1), 0, "impact");
      const front = hp0 - w.hp; w.hp = hp0;
      P.damageWalker(w, 200, new window.THREE.Vector3(0,0,-1), 0, "impact");
      out.shield = front < hp0 - w.hp; }

    // Tripwire, not a live bug: psy, disrupt and grab all drive the SAME
    // w.psyT field. No archetype or elite carries two of them today, so
    // nothing conflicts — but the moment one does, both abilities decrement
    // the timer every frame and fire at double rate. Fail here rather than
    // let that ship as a mystery.
    const clash = [];
    for (const [t, E] of Object.entries(P.ENEMIES)) {
      const n = (E.psy ? 1 : 0) + (E.disrupt ? 1 : 0) + (E.grab ? 1 : 0);
      if (n > 1) clash.push(t);
    }
    out.__timerClash = clash;
    return out;
  });

  ok(r.__spawnerAlive,
     "the spawner died during its own run, so nothing about spawning was tested");
  const dead = Object.entries(r)
    .filter(([k, v]) => !k.startsWith("__") && !v).map(([k]) => k);
  eq(dead.length, 0, "these abilities never fired: " + dead.join(", "));
  eq(r.__timerClash.length, 0,
     "these archetypes carry two abilities sharing w.psyT, so both fire at " +
     "double rate: " + r.__timerClash.join(", "));
});

test("crown: each rank throws one more spike, and spikes land and slow", async (pg) => {
  // The Ice Crown is the Ring of Fire's opposite half: the Ring punishes what
  // closes, the Crown reaches out and picks a target. Ranks add SPIKES PER
  // VOLLEY, which is what the upgrade is supposed to look like.
  const r = await pg.evaluate(() => {
    const P = window.__probe, out = { ranks: [] };
    P.crownState.lv = 0; P.buildCrown();
    for (let lv = 1; lv <= 3; lv++) {
      P.crownUpgrade();
      P.buildWave(3); P.parkWalkers(); P.stripProps();
      P.hero.pos.set(0, 0, 0); P.hero.hp = 99;
      // Targets pinned in range and made unkillable, so the volley size is
      // measured rather than "however many survived long enough to be shot".
      const t = [];
      for (let i = 0; i < 4; i++) {
        P.spawnWalker("walker", (i - 1.5) * 2.5, -10);
        const w = P.walkers[P.walkers.length - 1];
        w.hp = w.maxHp = 1e6; t.push(w);
      }
      P.crownState.t = 0; P.crownState.spikes.length = 0;
      let peak = 0;
      for (let i = 0; i < 20; i++) {
        for (const w of t) w.pos.set(w.pos.x, 0, -10);
        P.hero.pos.set(0, 0, 0); P.step(1 / 60);
        peak = Math.max(peak, P.crownState.spikes.length);
      }
      out.ranks.push({ lv, shards: P.crownState.shards.length, volley: peak });
    }

    // A spike has to actually connect and actually slow.
    P.buildWave(3); P.parkWalkers(); P.stripProps();
    P.hero.pos.set(0, 0, 0);
    P.spawnWalker("walker", 0, -9);
    const w = P.walkers[P.walkers.length - 1];
    const hp0 = w.hp;
    P.crownState.t = 0;
    let slowed = false;
    for (let i = 0; i < 180; i++) {
      w.pos.set(0, 0, -9); P.hero.pos.set(0, 0, 0); P.step(1 / 60);
      if ((w.slowT || 0) > 0) slowed = true;
    }
    out.damage = hp0 - w.hp;
    out.slowed = slowed;

    // Offered in the draft, and gated at three like the Ring.
    const entry = P.UPGRADES.find(u => u.id === "crown");
    out.inTable = !!entry;
    // Reset first: the rank loop above left it at 3, and asking "is it offered"
    // there answers a different question than the one intended.
    P.crownState.lv = 0;
    out.offeredAtZero = !!entry && (!entry.more || entry.more());
    P.crownState.lv = 3;
    out.offeredAtMax = !!entry && (!entry.more || entry.more());
    return out;
  });

  eq(r.ranks.map(x => x.volley).join(","), "1,2,3",
     "ranks should throw 1, 2 then 3 spikes a volley; got " + r.ranks.map(x => x.volley).join(","));
  ok(r.ranks[2].shards > r.ranks[0].shards,
     "the crown should visibly gain shards with rank");
  ok(r.damage > 0, "a spike never damaged a pinned target nine units away");
  ok(r.slowed, "a struck body was never slowed, which is the Crown's whole identity");
  ok(r.inTable, "there is no Ice Crown entry in the upgrade table at all");
  ok(r.offeredAtZero, "the Ice Crown is never offered in the draft");
  ok(!r.offeredAtMax, "the Ice Crown is still offered at rank 3");
});

test("ring: each rank builds one more ring", async (pg) => {
  const r = await pg.evaluate(() => {
    const P = window.__probe, out = [];
    P.ringState.lv = 0; P.buildRingOrbs();
    for (let lv = 1; lv <= 3; lv++) {
      P.ringUpgrade();
      const radii = [...new Set(P.ringState.curtains.map(
        c => +c.mesh.geometry.parameters.radiusTop.toFixed(1)))];
      out.push({ lv, rings: P.RING.levels[lv].rings, distinctRadii: radii.length });
    }
    return out;
  });
  for (const x of r)
    ok(x.distinctRadii >= x.rings,
       `rank ${x.lv} should show ${x.rings} rings but built ${x.distinctRadii} distinct radii`);
});

test("ring: burns on every band and in the centre, not in the gaps", async (pg) => {
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.parkWalkers();
    P.ringState.lv = 0; P.buildRingOrbs();
    for (let i = 0; i < 3; i++) P.ringUpgrade();
    P.spawnWalker("walker", P.hero.pos.x + 40, P.hero.pos.z);
    const w = P.walkers[P.walkers.length - 1];
    w.hp = w.maxHp = 1e6;
    const sample = d => {
      const before = w.hp;
      for (let i = 0; i < 40; i++) {
        P.S.t += 1 / 60;
        w.pos.set(P.hero.pos.x + d, 0, P.hero.pos.z);
        P.stepRing(1 / 60);
      }
      return Math.round(before - w.hp);
    };
    const R = P.RING.radii;
    return {
      centre: sample(0.8),
      onRings: R.map(sample),
      gaps: [sample((R[0] + R[1]) / 2), sample((R[1] + R[2]) / 2)],
      outside: sample(R[2] + 4),
    };
  });
  ok(r.centre > 0, "the middle of the ring is a safe pocket: anything that closes is immune");
  for (const [i, d] of r.onRings.entries()) ok(d > 0, `ring ${i + 1} deals no damage`);
  for (const [i, d] of r.gaps.entries()) eq(d, 0, `the gap after ring ${i + 1} is not shelter`);
  eq(r.outside, 0, "the ring damages beyond its outermost band");
});

test("boss: the Monolith closes and craters", async (pg) => {
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.parkWalkers();
    // Props stripped. With them in place this measurement swings between 5 and
    // 24 units purely on where the scatter landed — the boss gets stuck on a
    // barrel — and a threshold picked against that noise is a coin flip, not
    // an assertion. The hurl needs props, so it gets its own case below.
    P.stripProps();
    P.spawnMaw(P.hero.pos.x, P.hero.pos.z - 26);
    const b = P.walkers[P.walkers.length - 1];
    b.aggro = true;
    const d0 = Math.hypot(b.pos.x - P.hero.pos.x, b.pos.z - P.hero.pos.z);
    let minD = d0, craters = 0;
    for (let t = 0; t < 40; t += 1 / 30) {
      P.hero.hp = 99;
      const before = P.shocks.length;
      P.step(1 / 30);
      if (P.shocks.length > before) craters++;
      minD = Math.min(minD, Math.hypot(b.pos.x - P.hero.pos.x, b.pos.z - P.hero.pos.z));
    }
    return { closed: d0 - minD, craters, legs: !!b.lL, arms: !!b.aL };
  });
  ok(r.closed > 15,
     `an aggroed boss should walk the hero down; it closed only ` +
     `${r.closed.toFixed(1)} of the 26 units it started away`);
  ok(r.craters > 0, "the boss never cratered — the punch leaves a ring, hit or miss");
  // Legs only. The Monolith's hands are not on its arms — they fly — so aL/aR
  // are deliberately absent and the shared gait poses the legs alone.
  ok(r.legs, "the boss rig lost its leg slots, so the shared gait cannot walk it");
  ok(!r.arms, "the Monolith should have no arm limbs; its hands are detached");
});

test("boss: the Monolith hurls what is lying around", async (pg) => {
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    // Needs props, so this one deliberately does NOT strip them.
    P.buildWave(10);
    P.parkWalkers();
    const b = P.walkers.find(w => !w.dead && w.maw) ||
              (P.spawnMaw(P.hero.pos.x, P.hero.pos.z - 14),
               P.walkers[P.walkers.length - 1]);
    b.pos.set(P.hero.pos.x, 0, P.hero.pos.z - 14);
    b.aggro = true;
    let thrown = 0;
    for (let t = 0; t < 40; t += 1 / 30) {
      P.hero.hp = 99;
      P.step(1 / 30);
      thrown = Math.max(thrown, P.rocks.filter(o => o.hostile).length);
    }
    return { thrown, props: P.rocks.length };
  });
  ok(r.props > 0, "no props on the field, so this run could not have tested hurling");
  ok(r.thrown > 0, "the boss never threw anything in 40 simulated seconds");
});

test("monolith: the punch charges, flies, and craters where it lands", async (pg) => {
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.parkWalkers(); P.stripProps(); P.shocks.length = 0;
    P.hero.hp = 99; P.hero.pos.set(0, 0, 0);
    // Held at 20 units: inside punchRange (30) and far outside its melee reach
    // (5.4), so the only thing that can reach the hero is a fist.
    P.spawnMaw(0, -20);
    const b = P.walkers[P.walkers.length - 1];
    b.aggro = true;
    const seen = { charge: 0, punch: 0, ret: 0 };
    let reach = 0, craters = 0;
    for (let i = 0; i < 60 * 20; i++) {
      b.pos.set(0, 0, -20);
      const before = P.shocks.length;
      P.step(1 / 60);
      if (P.shocks.length > before) craters++;
      P.shocks.length = 0;
      for (const h of b.hands) {
        if (h.state === "charge") { seen.charge++; }
        if (h.state === "punch")  { seen.punch++;
          reach = Math.max(reach, Math.hypot(h.g.position.x, h.g.position.z + 20)); }
        if (h.state === "return") seen.ret++;
      }
    }
    return { ...seen, reach: +reach.toFixed(1), craters, hands: b.hands.length };
  });
  eq(r.hands, 2, "the Monolith should have two hands");
  ok(r.charge > 0, "no hand ever charged — the wind-up is the whole read");
  ok(r.punch > 0, "a hand charged but never launched");
  ok(r.ret > 0, "a hand launched and never came back, so it can only punch twice");
  ok(r.reach > 12,
     `the fist only travelled ${r.reach} units of the 20 it needed to reach the hero`);
  ok(r.craters > 0, "the fist never cratered where it landed");
});

test("monolith: dashing beats the fist", async (pg) => {
  // Isolating the fist takes care. The punch ALWAYS craters, and a crater ring
  // is beaten by JUMPING, not dashing — so a naive "dash and count damage" run
  // measures the ring and reports the fist as un-dodgeable, which is what the
  // first version of this case did.
  //
  // Lifting the hero above CFG.dodgeHeight does not work either: step() runs
  // gravity and puts them back on the floor before the ring is ever checked.
  // Nor does emptying the ring list after every step — the ring is created AND
  // checked inside the same step(), and its first tick sweeps r=2 to 2.43,
  // which is exactly where a fist that stopped on contact tends to be.
  //
  // So hero health cannot separate them at all, and the boss counts its own
  // fist hits instead. That is the only signal that means the fist and nothing
  // else.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    const run = (dash) => {
      P.parkWalkers(); P.stripProps(); P.shocks.length = 0;
      P.hero.hp = 999; P.hero.pos.set(0, 0, 0);
      P.spawnMaw(0, -20);
      const b = P.walkers[P.walkers.length - 1];
      b.aggro = true;
      for (let i = 0; i < 60 * 20; i++) {
        b.pos.set(0, 0, -20);
        if (dash) P.S.dashT = 0.15;
        P.step(1 / 60);
      }
      return b.punchHits;
    };
    return { standing: run(false), dashing: run(true) };
  });
  ok(r.standing > 0,
     "standing still in front of the Monolith was never punched, so this run " +
     "measures neither the fist nor the dodge");
  eq(r.dashing, 0,
     `dashing took ${r.dashing} fist hits; dashing is invulnerability everywhere ` +
     `else in this game and cannot be the one thing it fails against`);
});

test("boss: the Warden closes, throws, and its plates gate the core", async (pg) => {
  // The every-fifth-wave boss, and the only one that had no behaviour test at
  // all while its three siblings each turned out to be broken — the Gorger
  // walking around in pieces, the Choir killing the animation loop on sight,
  // the Hollow's damage gate. This one was hiding a NaN world position.
  const r = await pg.evaluate(() => {
    const P = window.__probe, out = {};
    out.onWave5 = P.walkers.length >= 0 &&
      (P.buildWave(5), P.walkers.filter(w => !w.dead && w.boss && !w.maw).length);

    // Closes and throws. Props deliberately kept: throwing needs something to
    // pick up, and the arena is where it finds one.
    P.buildWave(5); P.parkWalkers(); P.hero.pos.set(0, 0, 0);
    P.spawnWalker("boss", 0, -26);
    const w = P.walkers[P.walkers.length - 1];
    let minD = 26, hostile = 0;
    for (let i = 0; i < 60 * 40; i++) {
      P.hero.hp = 99; P.hero.pos.set(0, 0, 0); P.step(1 / 60);
      minD = Math.min(minD, Math.hypot(w.pos.x, w.pos.z));
      hostile = Math.max(hostile, P.rocks.filter(o => o.hostile > 0).length);
    }
    out.closed = 26 - minD;
    out.threw = hostile;
    out.survived = !w.dead;

    // Plates absorb everything until they are gone — the same contract the
    // Monolith has, and the reason the fight has two phases.
    P.parkWalkers(); P.spawnWalker("boss", 0, -14);
    const b = P.walkers[P.walkers.length - 1];
    const hp0 = b.hp, plates0 = b.platesLeft;
    P.damageWalker(b, 500, null, 0, "impact");
    out.plates0 = plates0;
    out.coreUntouched = b.hp === hp0;
    out.platesFell = b.platesLeft < plates0;
    return out;
  });
  eq(r.onWave5, 1, "wave 5 should bring exactly one Warden");
  ok(r.survived, "the Warden died during its own behaviour run, so this tested nothing");
  ok(r.closed > 15, `an aggroed Warden should walk the hero down; closed only ${r.closed.toFixed(1)} of 26`);
  ok(r.threw > 0, "the Warden never threw anything in 40 simulated seconds");
  ok(r.plates0 > 0, "the Warden spawned with no plates, so the gate below proves nothing");
  ok(r.coreUntouched, "damage reached the core while plates were still up");
  ok(r.platesFell, "damage did not break a plate either, so it went nowhere");
});

test("bosses: every tenth wave brings that tier's boss", async (pg) => {
  const r = await pg.evaluate(() => {
    const P = window.__probe, out = {}, misses = {};
    for (const n of [10, 20, 30, 40, 50]) {
      // Twelve passes, not one. The boss reaches the opening group only if
      // buildWave lifts it out of a RANDOM shuffle; while that lift covered
      // only two of the four boss types, wave 20 opened bossless about 40% of
      // the time and a single-pass check waved it through.
      for (let pass = 0; pass < 12; pass++) {
        P.S.wave = n; P.buildWave(n);
        const b = P.walkers.find(w => !w.dead && w.boss);
        if (b) out[n] = b.type; else misses[n] = (misses[n] || 0) + 1;
      }
    }
    return { out, misses };
  }).then(x => (Object.assign(x.out, { __misses: x.misses })));
  const misses = r.__misses; delete r.__misses;
  for (const n of Object.keys(misses))
    ok(false, `wave ${n} opened with no boss on ${misses[n]}/12 passes`);
  for (const n of Object.keys(r)) ok(r[n] !== "NONE", `wave ${n} has no boss`);
  ok(new Set([r[10], r[20], r[30]]).size === 3,
     `waves 10/20/30 must be three DIFFERENT bosses, got ${r[10]}/${r[20]}/${r[30]}`);
  eq(r[40], r[10], "the tier cycle should come back round at 40");
});

test("bosses: never more than one big body in a wave", async (pg) => {
  const r = await pg.evaluate(() => {
    const P = window.__probe, bad = [];
    // Many passes, because the offending multiplier comes from a RANDOM wave
    // modifier — a single build can pass while the bug is present.
    for (let pass = 0; pass < 12; pass++) {
      for (const n of [10, 15, 20, 25, 30, 40]) {
        P.S.wave = n; P.buildWave(n);
        const bosses = P.walkers.filter(w => !w.dead && w.boss).length;
        if (bosses > 1) bad.push(n + " spawned " + bosses);
      }
    }
    return bad;
  });
  ok(r.length === 0, "waves produced multiple bosses: " + r.slice(0, 5).join(", "));
});

test("rigs: a body stays attached to its own shoulders", async (pg) => {
  // The gait wrote the walk bob as an ABSOLUTE y, so any rig whose torso hangs
  // above the origin was yanked to the floor on its first stepped frame. The
  // Gorger built its body at y=4.9 and animated it at y=0, leaving its arms
  // hanging 7.9 units above the torso they belong to. Nothing threw, nothing
  // logged, and every boss case still passed — the boss was simply in pieces.
  const r = await pg.evaluate(() => {
    const P = window.__probe, out = {};
    for (const t of ["maw", "choir", "hollow", "boss"]) {
      P.parkWalkers(); P.stripProps();
      P.spawnWalker(t, P.hero.pos.x, P.hero.pos.z - 12);
      const w = P.walkers[P.walkers.length - 1];
      const built = w.body.position.y;
      for (let i = 0; i < 240; i++) P.step(1 / 60);
      out[t] = { built, after: w.body.position.y };
    }
    return out;
  });
  for (const t of Object.keys(r)) {
    // The bob itself is under a quarter unit; anything beyond that is the rig
    // coming apart rather than walking.
    near(r[t].after, r[t].built, 0.3,
         `"${t}" torso drifted from its build height — the rig is animating apart`);
  }
});

test("rigs: nothing animates itself to a NaN position", async (pg) => {
  // The Warden spent this whole project with `gait` and `spd` missing from its
  // walker record. The shared gait does `w.gait += ...`, and `undefined + n` is
  // NaN, which never recovers — it flowed into gaitBob, into body.position.y,
  // and because that rig's body IS its root group, into the Warden's WORLD Y.
  //
  // It survived undetected because it still walked and still threw: both read
  // x and z only. Nothing threw, nothing logged, and it is the one boss that
  // never had a test. The comment directly above the omission in game.js warns
  // about this exact class for two OTHER fields on the same record.
  //
  // Checked for every body, not just the Warden, because the failure is a
  // missing numeric field and any archetype can be given one.
  const r = await pg.evaluate(() => {
    const P = window.__probe, bad = [];
    const finite = v => typeof v === "number" && Number.isFinite(v);
    for (const t of [...Object.keys(P.ENEMIES), "boss", "maw", "choir", "hollow"]) {
      P.parkWalkers(); P.stripProps();
      P.spawnWalker(t, 0, -14);
      const w = P.walkers[P.walkers.length - 1];
      for (let i = 0; i < 120; i++) P.step(1 / 60);
      const checks = { walk: w.walk, gait: w.gait, spd: w.spd,
                       posX: w.pos.x, posY: w.pos.y, posZ: w.pos.z,
                       bodyY: w.body ? w.body.position.y : 0 };
      for (const [k, v] of Object.entries(checks))
        if (!finite(v)) bad.push(`${t}.${k}`);
    }
    return bad;
  });
  eq(r.length, 0,
     "these went non-finite while simply standing and animating, which silently " +
     "corrupts position and every distance that reads it: " + r.slice(0, 8).join(", "));
});

test("bosses: every boss survives being animated", async (pg, errs) => {
  // The other boss cases all poke damageWalker directly and never run a frame,
  // which is how THE CHOIR shipped unable to animate at all: the shared walker
  // gait poses lL/lR/aL/aR unconditionally and the Choir is a floating core
  // with neither, so it threw on its first frame and took the whole animation
  // loop down with it. Wave 20 was unplayable and nothing in the suite
  // noticed, because nothing stepped.
  const r = await pg.evaluate(() => {
    const P = window.__probe, out = {};
    for (const t of ["maw", "choir", "hollow", "boss"]) {
      P.parkWalkers(); P.stripProps();
      P.spawnWalker(t, P.hero.pos.x, P.hero.pos.z - 12);
      out[t] = null;
      // Long enough to cross a wind-up: the attack pose writes limbs on a
      // separate path from the gait, and that one was unguarded too.
      try { for (let i = 0; i < 600; i++) P.step(1 / 60); }
      catch (e) { out[t] = e.message; }
    }
    return out;
  });
  for (const t of Object.keys(r))
    ok(!r[t], `stepping "${t}" threw: ${r[t]}`);
  ok(errs.length === 0, "errors while animating bosses: " + errs.slice(0, 3).join(" | "));
});

test("choir: core is untouchable until the acolytes are gone", async (pg) => {
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.parkWalkers();
    P.S.wave = 20;
    P.spawnWalker("choir", P.hero.pos.x, P.hero.pos.z - 12);
    const b = P.walkers[P.walkers.length - 1];
    const hp0 = b.hp, n0 = b.acolytes.filter(a => a.alive).length;
    // Swing FEWER times than there are acolytes. Twenty hits of 500 against
    // 260hp acolytes kills all six and then legitimately opens the core — the
    // first version of this case failed on its own arithmetic, not on the game.
    for (let i = 0; i < 3; i++) P.damageWalker(b, 500, null, 0, "impact");
    const stillOrbiting = b.acolytes.filter(a => a.alive).length;
    const coreUntouched = b.hp === hp0 && stillOrbiting > 0;
    const killedSome = b.acolytes.filter(a => a.alive).length < n0;
    // finish the acolytes, then the core must take damage
    for (let i = 0; i < 200 && b.acolytes.some(a => a.alive); i++)
      P.damageWalker(b, 500, null, 0, "impact");
    const before = b.hp;
    P.damageWalker(b, 500, null, 0, "impact");
    return { coreUntouched, killedSome, stillOrbiting,
             coreOpenedAfter: b.hp < before, acolytes: n0 };
  });
  ok(r.acolytes > 0, "the choir spawned with no acolytes");
  ok(r.coreUntouched, "the core took damage while acolytes were still orbiting");
  ok(r.stillOrbiting > 0, "the case did not actually leave any acolyte alive to test with");
  ok(r.killedSome, "hits aimed at the core were wasted entirely rather than routed to an acolyte");
  ok(r.coreOpenedAfter, "the core never became vulnerable after the acolytes died");
});

test("choir: acolytes do not outlive the core", async (pg) => {
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.parkWalkers();
    P.S.wave = 20;
    P.spawnWalker("choir", P.hero.pos.x, P.hero.pos.z - 12);
    const b = P.walkers[P.walkers.length - 1];
    const groups = b.acolytes.map(a => a.g);
    for (let i = 0; i < 400 && !b.dead; i++) P.damageWalker(b, 900, null, 0, "impact");
    return { dead: b.dead, orphaned: groups.filter(g => g.parent).length };
  });
  ok(r.dead, "the choir never died");
  eq(r.orphaned, 0, "acolyte meshes were left in the scene after the core died");
});

test("hollow: only returned ordnance lands", async (pg) => {
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.parkWalkers();
    P.S.wave = 30;
    P.spawnWalker("hollow", P.hero.pos.x, P.hero.pos.z - 12);
    const b = P.walkers[P.walkers.length - 1];
    const h0 = b.hp;
    P.damageWalker(b, 1000, null, 0, "impact");
    const normal = h0 - b.hp;
    b.hp = h0;
    P.damageWalker(b, 1000, null, 0, "returned");
    const returned = h0 - b.hp;
    return { normal, returned, ratio: returned / Math.max(1, normal) };
  });
  ok(r.normal > 0, "the hollow is literally unkillable by normal means, which is a wall not a puzzle");
  ok(r.returned > r.normal * 20,
     `a returned prop should dwarf a normal hit; got ${Math.round(r.returned)} vs ${Math.round(r.normal)}`);
});

test("hollow: hurls, which is what arms the player", async (pg) => {
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.parkWalkers();
    P.S.wave = 30;
    P.spawnWalker("hollow", P.hero.pos.x, P.hero.pos.z - 14);
    const b = P.walkers[P.walkers.length - 1];
    b.aggro = true;
    let peak = 0;
    for (let t = 0; t < 20; t += 1 / 30) {
      P.hero.hp = 99; P.step(1 / 30);
      peak = Math.max(peak, P.rocks.filter(o => o.hostile > 0).length);
    }
    return { peak };
  });
  ok(r.peak > 0,
     "the hollow never threw anything, so the player is never handed the only thing that hurts it");
});

test("restart: a new run does not inherit the last run's build", async (pg) => {
  // The ring of fire keeps its rank in its own module state rather than in
  // MOD, so restart() rebuilt every other part of the build and left it
  // standing: a new run opened at wave 1 with a fully ranked triple ring. The
  // draft entry also gates on `ringState.lv < 3`, so a maxed ring then never
  // came back as an option for the rest of the session — the pick was both
  // free and gone.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.ringState.lv = 0;
    for (let i = 0; i < 3; i++) P.ringUpgrade();
    P.S.wave = 12; P.S.score = 5000; P.S.kills = 90;
    for (let i = 0; i < 3; i++) P.crownUpgrade();
    const before = { lv: P.ringState.lv, curtains: (P.ringState.curtains || []).length,
                     crownLv: P.crownState.lv };
    P.restart();
    return {
      before,
      lv: P.ringState.lv,
      curtains: (P.ringState.curtains || []).length,
      wave: P.S.wave,
      score: P.S.score,
      crownLv: P.crownState.lv,
      crownShards: P.crownState.shards.length,
      // The pool has to offer it again, which is the half that a rank check
      // alone would not catch.
      offered: P.UPGRADES.filter(u => u.id === "ring")
                         .every(u => !u.more || u.more()),
    };
  });
  eq(r.before.lv, 3, "the run under test never reached rank 3, so it proves nothing");
  eq(r.lv, 0, "the fire ring's rank survived a restart — the new run starts with it for free");
  eq(r.before.crownLv, 3, "the crown never reached rank 3, so it proves nothing");
  eq(r.crownLv, 0, "the Ice Crown's rank survived a restart, exactly as the ring once did");
  eq(r.crownShards, 0, "the Ice Crown's shards survived a restart");
  eq(r.curtains, 0, "the fire ring's meshes survived a restart");
  eq(r.wave, 1, "the wave counter survived a restart");
  eq(r.score, 0, "the score survived a restart");
  ok(r.offered, "the ring is no longer offered in the draft after a restart");
});

test("damage flash: only at low health, and on every damage route", async (pg) => {
  // The red vignette is a LOW-HEALTH warning, not a hit marker. It used to
  // fire on every hit at any health — the loudest signal in the game was also
  // its most common — and it was pasted at four call sites while several other
  // damage routes had none, so an arrow took a heart off you in silence.
  const r = await pg.evaluate(async () => {
    const P = window.__probe;
    const lit = () => document.getElementById("dmg").classList.contains("on");
    const clear = () => document.getElementById("dmg").classList.remove("on");
    const out = {};

    P.parkWalkers(); P.stripProps();

    clear(); P.hero.hp = 5; P.hurtHero();
    out.atFull = { lit: lit(), hp: P.hero.hp };

    clear(); P.hero.hp = 4; P.hurtHero();
    out.atThree = { lit: lit(), hp: P.hero.hp };

    // The hit that drops you TO the threshold must warn you — that is the
    // moment the warning exists for.
    clear(); P.hero.hp = 3; P.hurtHero();
    out.droppingToTwo = { lit: lit(), hp: P.hero.hp };

    clear(); P.hero.hp = 1; P.hurtHero();
    out.lastHeart = { lit: lit(), hp: P.hero.hp };

    // A route that never flashed before consolidation: an arrow.
    clear(); P.hero.hp = 2; P.arrows.length = 0;
    P.spawnWalker("archer", P.hero.pos.x, P.hero.pos.z - 8);
    const a = P.walkers[P.walkers.length - 1];
    a.aggro = true;
    let arrowLit = false;
    for (let i = 0; i < 60 * 20 && !arrowLit; i++) {
      P.S.dashT = 0;
      P.step(1 / 60);
      if (lit()) arrowLit = true;
    }
    out.arrowRoute = { lit: arrowLit, hp: P.hero.hp };
    return out;
  });

  eq(r.atFull.hp, 4, "hurtHero did not take a heart, so this case tested nothing");
  ok(!r.atFull.lit, "the screen flashed red at full health; it is a low-health warning");
  ok(!r.atThree.lit, "the screen flashed red at 3 hearts, above the warning threshold");
  ok(r.droppingToTwo.lit,
     "dropping to 2 hearts did not flash — that is exactly when the warning is for");
  ok(r.lastHeart.lit, "the killing hit did not flash");
  ok(r.arrowRoute.lit,
     "an arrow took a heart at low health without colouring the screen; the flash " +
     "must live on every damage route, not the four it happened to be pasted into");
});

test("props: a resting prop cannot pin a walker", async (pg) => {
  // Reported from play: the wave stalls, the threat counter still shows bodies,
  // and none of them ever arrive. Cause was the prop/walker resting-contact
  // branch shoving the WALKER back a flat 0.35 every frame — about seven times
  // its own per-frame step — so a body that walked into a prop was pinned
  // against it for the rest of the wave.
  //
  // A single planted prop does NOT reproduce it: the body slides around one
  // obstacle, and the first version of this case passed happily against the
  // broken code. It takes a real scattered arena, so this runs live waves and
  // looks for bodies that have stopped moving while still far from the hero.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    const frozen = [];
    // Waves 1-30, not 7-8. The reported stall was on wave 3 and the two-wave
    // window would never have seen it; re-introducing the pin bug lights this
    // sweep up from wave 4 onward. The whole sweep costs about a minute, which
    // is worth it for the one failure mode that makes a run unfinishable.
    for (let wave = 1; wave <= 30; wave++) {
      {
        P.buildWave(wave);
        P.hero.pos.set(0, 0, 0);
        const settle = () => { for (let i = 0; i < 60 * 30; i++) {
          P.hero.hp = 99; P.hero.pos.set(0,0,0); P.step(1/60); } };
        settle();
        const snap = P.walkers.filter(w => !w.dead)
                              .map(w => ({ w, x: w.pos.x, z: w.pos.z }));
        for (let i = 0; i < 60 * 6; i++) {
          P.hero.hp = 99; P.hero.pos.set(0,0,0); P.step(1/60); }
        for (const o of snap) {
          if (o.w.dead) continue;
          const moved = Math.hypot(o.w.pos.x - o.x, o.w.pos.z - o.z);
          const d = Math.hypot(o.w.pos.x, o.w.pos.z);
          // Standoff archetypes (archer 17, warper 15, spawner 12) hold at
          // range BY DESIGN and must not be counted as stuck.
          if (moved < 0.5 && d > 6 && o.w.AI.ring < 5)
            frozen.push(`${o.w.type}@${d.toFixed(1)} (wave ${wave})`);
        }
      }
    }
    return frozen;
  });
  eq(r.length, 0,
     "bodies stopped moving while far from the hero, so the wave can never be " +
     "cleared: " + r.slice(0, 5).join(", "));
});

test("aura: controlled props wear a plume, tinted by which control", async (pg) => {
  // The PLUME from the reference image, not the rim shell that briefly stood in
  // for it. Three quads per prop at sixty degrees, so one always broadly faces
  // the camera without a per-frame lookAt on twenty-four objects.
  //
  // Setup notes, both learned by getting them wrong: guidance is cleared the
  // moment a prop touches the ground, and again if its mark dies — so a guiding
  // prop needs a live target AND some air.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.buildWave(3); P.parkWalkers();
    const live = P.rocks.filter(o => !o.gone).slice(0, 3);
    P.S.held = [live[0]]; live[0].held = true; live[0].grabT = 1;
    live[1].seek = P.walkers.find(w => !w.dead);
    live[1].seekT = 6; live[1].pos.y = 4; live[1].vel.set(0, 2, -14);
    live[2].hostile = 6;
    for (let i = 0; i < 10; i++) { live[1].pos.y = 4; P.step(1 / 60); }

    const scene = P.walkers[0].g.parent;
    const blades = [], groups = new Set();
    scene.traverse(o => {
      if (o.isMesh && o.geometry && o.geometry.type === "PlaneGeometry" &&
          o.material && o.material.blending === 2 &&
          o.visible && o.parent && o.parent.visible && o.material.opacity > 0.1) {
        blades.push(o); groups.add(o.parent);
      }
    });
    return { plumes: groups.size, blades: blades.length,
             tints: [...new Set(blades.map(m => m.material.color.getHexString()))].sort(),
             scrolls: P.rocks.length > 0 };
  });
  eq(r.plumes, 3, "held, guiding and hostile props should each wear a plume");
  eq(r.blades, 9, "each plume is three quads at sixty degrees; got " + r.blades);
  eq(r.tints.join(","), "ffc890,ff7060,ffffff".split(",").sort().join(","),
     "the three control states must stay distinguishable by tint");
});

test("tethers: no control threads are drawn to carried props", async (pg) => {
  // Removed on request. Asserted rather than trusted: the last pool removed
  // here left its call in clearAll behind and threw on every wave transition.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.buildWave(2);
    const scene = P.walkers[0].g.parent;
    const magenta = [];
    scene.traverse(o => {
      if (o.isLine && o.material && o.material.color &&
          o.material.color.getHex() === 0xe94fbf) magenta.push(o);
    });
    return { magentaLines: magenta.length, hasUpdater: typeof P.updateTethers };
  });
  eq(r.magentaLines, 0, "magenta control tethers are still in the scene");
  eq(r.hasUpdater, "undefined", "updateTethers still exists");
});

test("wounds: skin darkens as health drops, bosses excluded", async (pg) => {
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.parkWalkers();
    P.spawnWalker("walker", P.hero.pos.x + 6, P.hero.pos.z);
    const w = P.walkers[P.walkers.length - 1];
    // Drive the sim directly instead of sleeping. The tint is applied in the
    // walker step loop, so the old `await sleep(180)` was betting on the real
    // render loop landing a frame inside that window — measured at 1-2 frames
    // on an idle machine and zero under load, which is exactly how this case
    // went red while the code it covers was correct. It was the last
    // wall-clock-dependent case in the suite.
    const read = f => {
      w.hp = w.maxHp * f;
      for (let i = 0; i < 6; i++) P.step(1 / 60);
      return { hex: w.skinM.color.getHexString(), glow: w.skinM.emissiveIntensity };
    };
    const full = read(1.0), hurt = read(0.12);
    P.spawnMaw(P.hero.pos.x, P.hero.pos.z - 30);
    const boss = P.walkers[P.walkers.length - 1];
    return { full, hurt, bossHasSkinM: !!boss.skinM };
  });
  ok(r.full.hex !== r.hurt.hex,
     "a body at 12% health looks identical to a healthy one, so the execute window is invisible");
  ok(r.hurt.glow > r.full.glow, "the wound glow does not open as health drops");
  ok(!r.bossHasSkinM, "the boss got a wound tint; its plates already carry that information");
});

test("quality: warm-up ignores the loading window", async (pg) => {
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.setQuality("high");
    let now = 5e6; P.qReset(now);
    for (let i = 0; i < Math.round(4.5 * 8); i++) P.judgeFrame(now += 1000 / 8);
    return P.qualityNow();
  });
  eq(r, "high",
     "4.5s of 8fps demoted quality, but that window is shader compilation and the opening spawn");
});

test("quality: two bad windows required, and MED recovers", async (pg) => {
  const r = await pg.evaluate(() => {
    const P = window.__probe, out = {};
    const feed = (fps, secs, now) => {
      const dt = 1000 / fps;
      for (let i = 0; i < Math.round(secs * fps); i++) P.judgeFrame(now.v += dt);
    };
    P.setQuality("high");
    const now = { v: 6e6 }; P.qReset(now.v);
    feed(60, 8, now);                       // clear the warm-up healthily
    feed(20, 2.6, now); out.oneBadWindow = P.qualityNow();
    feed(20, 9, now);   out.sustainedBad  = P.qualityNow();
    feed(60, 16, now);  out.afterRecovery = P.qualityNow();
    return out;
  });
  eq(r.oneBadWindow, "high", "a single bad window demoted quality; one hitch should cost nothing");
  ok(r.sustainedBad !== "high", "sustained low frame rate never demoted");
  ok(r.afterRecovery !== "low" || r.sustainedBad === "low",
     "quality never recovered after the frame rate came back");
});

test("play: a live wave runs without errors", async (pg, errs) => {
  const before = errs.length;
  await pg.evaluate(() => {
    const P = window.__probe;
    P.buildWave(7);
    P.ringState.lv = 0; P.buildRingOrbs();
    for (let i = 0; i < 3; i++) P.ringUpgrade();
    for (let t = 0; t < 30; t += 1 / 30) { P.hero.hp = 99; P.step(1 / 30); }
  });
  const fresh = errs.slice(before);
  ok(fresh.length === 0, "errors during live play:\n      " + fresh.join("\n      "));
});

test("play: wave transitions do not throw", async (pg, errs) => {
  const before = errs.length;
  await pg.evaluate(() => {
    const P = window.__probe;
    // clearAll runs on every transition, and a stale reference in it once threw
    // a ReferenceError on every single wave change.
    for (let n = 1; n <= 12; n++) { P.buildWave(n); P.run(0.5); }
  });
  const fresh = errs.slice(before);
  ok(fresh.length === 0, "errors across wave transitions:\n      " + fresh.join("\n      "));
});

// ═══════════════════════════════════════════════════════════════════ runner
const filter = process.argv[2];
const selected = filter ? cases.filter(c => c.name.includes(filter)) : cases;

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader",
         "--disable-dev-shm-usage"],
});

let passed = 0, failed = 0;
const t0 = Date.now();
console.log(`\nkinesis regression — ${selected.length} case${selected.length === 1 ? "" : "s"}\n`);

// Loading the page is setup, not the thing under test. A 1.1MB bundle parsed
// against software GL occasionally blows the navigation timeout mid-suite —
// three consecutive cases went red that way and every one of them passed on
// its own. Retry the SETUP only, and never the assertions: a suite that cries
// red for its own reasons teaches you to stop reading red at all.
const SETUP_TRIES = 3;
async function openCase() {
  let last;
  for (let attempt = 1; attempt <= SETUP_TRIES; attempt++) {
    const pg = await browser.newPage({ viewport: { width: 900, height: 620 } });
    const errs = [];
    pg.on("pageerror", e => errs.push("PAGEERROR: " + e.message));
    pg.on("console", m => { if (m.type() === "error") errs.push("CONSOLE: " + m.text()); });
    try {
      await pg.goto("file://" + OUT, { timeout: 90000 });
      await pg.waitForFunction(() => window.__probe, null, { timeout: 90000 });
      await pg.evaluate(() => document.querySelector("#startBtn").click());
      // Let the opening frames settle; every case drives the sim itself after this.
      await pg.waitForTimeout(1200);
      return { pg, errs, attempt };
    } catch (e) {
      last = e;
      await pg.close();
    }
  }
  throw last;
}

for (const c of selected) {
  let open = null;
  try {
    open = await openCase();
    await c.fn(open.pg, open.errs);
    const retried = open.attempt > 1 ? `  (setup retried ${open.attempt - 1}×)` : "";
    console.log("  \x1b[32mPASS\x1b[0m  " + c.name + retried);
    passed++;
  } catch (e) {
    const why = e instanceof Failed ? e.message : (e.stack || String(e));
    console.log("  \x1b[31mFAIL\x1b[0m  " + c.name + "\n      " + why);
    failed++;
  } finally {
    if (open) await open.pg.close();
  }
}

await browser.close();
try { fs.unlinkSync(OUT); } catch {}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n  ${passed} passed, ${failed} failed  (${secs}s)\n`);
process.exit(failed ? 1 : 0);
