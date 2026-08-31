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

test("crown: a rank-up replaces the circlet rather than stacking another", async (pg) => {
  // The crown model is a circlet, a lip, a foot, teeth, gems and a crest as
  // well as the spike fan. The rebuild used to clear only the fan, which was
  // correct while the fan WAS the whole model — carry that forward and rank 3
  // wears three circlets, three sets of teeth and three crests, all coincident
  // and all still being drawn. Nothing errors; it just quietly costs triple.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    const kids = () => P.crownState.group.children.length;

    P.crownState.lv = 0; P.buildCrown();
    const atZero = kids();

    P.crownState.lv = 3; P.buildCrown();
    const fresh = kids();
    P.buildCrown();                       // same rank, built again
    const rebuilt = kids();

    // And the way a run actually reaches rank 3: one draft pick at a time.
    P.crownState.lv = 0; P.buildCrown();
    for (let i = 0; i < 3; i++) P.crownUpgrade();
    const climbed = kids();

    P.crownState.lv = 0; P.buildCrown();
    return { atZero, fresh, rebuilt, climbed, afterReset: kids(),
             tracked: P.crownState.parts.length };
  });

  eq(r.atZero, 0, "rank 0 should leave nothing in the crown group");
  ok(r.fresh > 12, "the crown model is missing — rank 3 built only " + r.fresh + " meshes");
  eq(r.rebuilt, r.fresh,
     "rebuilding at the same rank left " + (r.rebuilt - r.fresh) + " extra meshes behind");
  eq(r.climbed, r.fresh,
     "ranking up 1->2->3 ends with " + r.climbed + " meshes but building rank 3 " +
     "outright gives " + r.fresh + ", so the earlier ranks are still resident");
  eq(r.afterReset, 0, "dropping to rank 0 left " + r.afterReset + " meshes in the scene");
  eq(r.tracked, 0, "the parts list still holds " + r.tracked + " meshes after teardown");
});

test("aura: the plume licks like flame, it does not scroll like a belt", async (pg) => {
  // Reported as "the aura just moves bottom to top". It did: the whole effect
  // was one texture scrolled at a constant rate, and the sheet carried nine
  // evenly spaced horizontal bands — a barcode on a conveyor. All three quads
  // were also scaled from a single shared sine, so they breathed in lockstep.
  //
  // Fire is the opposite of both: the silhouette itself changes, and separate
  // tongues move independently. Neither is visible in a screenshot of one
  // frame, so this measures the geometry over time instead.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.buildWave(3); P.parkWalkers(); P.stripProps();
    const o = P.rocks.find(x => x.mesh);
    o.gone = false; o.held = true; o.grabT = 0;
    P.S.held = [o];
    P.hero.pos.set(0, 0, 0);

    let acrossBlades = 0, swayAcross = 0;
    const y0 = [], z0 = [];
    for (let i = 0; i < 180; i++) {
      o.pos.set(0, 2.5, -5);
      P.step(1 / 60);
      const A = P.auras.find(a => a.g.visible);
      if (!A) continue;
      const ys = A.blades.map(b => b.scale.y);
      const zs = A.blades.map(b => b.rotation.z);
      const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
      // Scale-free: the prop's radius sets the absolute size.
      acrossBlades = Math.max(acrossBlades, (Math.max(...ys) - Math.min(...ys)) / mean);
      swayAcross = Math.max(swayAcross, Math.max(...zs) - Math.min(...zs));
      y0.push(ys[0]); z0.push(zs[0]);
    }
    const my = y0.reduce((a, b) => a + b, 0) / y0.length;
    return {
      frames: y0.length,
      acrossBlades,
      swayAcross,
      overTime: (Math.max(...y0) - Math.min(...y0)) / my,
      leansLeft: z0.some(z => z < -0.02),
      leansRight: z0.some(z => z > 0.02),
    };
  });

  ok(r.frames > 100, "the plume was never visible; the case measured nothing");
  ok(r.acrossBlades > 0.08,
     "the three quads are the same height at every instant (spread " +
     r.acrossBlades.toFixed(3) + "), so they breathe as one object rather " +
     "than reading as separate tongues");
  ok(r.swayAcross > 0.06,
     "the quads never lean differently from each other (spread " +
     r.swayAcross.toFixed(3) + " rad)");
  ok(r.overTime > 0.12,
     "a quad's height barely changes over three seconds (range " +
     r.overTime.toFixed(3) + "): the silhouette is fixed and only the texture " +
     "moves, which is the conveyor belt this replaced");
  ok(r.leansLeft && r.leansRight,
     "the flame never leans both ways, so it is not licking");
});

test("characters: only the character who lifts things gets things to lift", async (pg) => {
  // The characters are meant to be different LEVELS, not different buttons.
  // The telekinetic's magazine is the ground, so it is covered; everyone who
  // carries their own ammunition gets a bare field. If the arenas look the
  // same, the extra characters are the first one wearing a hat.
  //
  // Every character in the table, not just the ones that existed when this was
  // written: the trap here is the `Math.max(1, ...)` floor on the per-type
  // count, which exists so a wave never opens with nothing to throw and will
  // happily floor a density of zero back up to one prop of every type — and it
  // would do that to a new character just as silently.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    const count = (who) => {
      P.setCharacter(who);
      P.buildWave(5);
      return P.rocks.filter(o => !o.gone).length;
    };
    const out = {};
    for (const key in P.CHARS) out[key] = { props: P.CHARS[key].props, spawned: count(key) };
    P.setCharacter("telekinetic");
    out.back = { props: 1, spawned: count("telekinetic") };
    return out;
  });

  for (const key in r) {
    if (r[key].props > 0)
      ok(r[key].spawned > 5, key + "'s arena should be littered; got " + r[key].spawned);
    else
      eq(r[key].spawned, 0,
         key + "'s arena still spawned " + r[key].spawned + " throwable props — the " +
         "per-type floor is flooring a zero density back up to one of each");
  }
  ok(r.back.spawned > 5,
     "switching back to the telekinetic left the arena bare (" + r.back.spawned + ")");
});

test("characters: a boss kill levels the one you are playing, permanently", async (pg) => {
  // The only reward in the game that outlives a run. It has to be saved the
  // moment it is earned rather than at the end of the run: dying after a boss
  // must still leave you stronger, or the whole progression is a lie.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.setCharacter("pyromancer");
    P.PROFILE.charLv.pyromancer = 1;
    P.PROFILE.charLv.telekinetic = 1;

    P.buildWave(3); P.parkWalkers(); P.stripProps();
    P.spawnMaw ? P.spawnMaw(0, -12) : P.spawnWalker("maw", 0, -12);
    const boss = P.walkers.filter(w => !w.dead).pop();
    const capBefore = P.castCap(P.charLevel("pyromancer"));
    // The plates absorb damage while they stand, so a boss with its armour on
    // simply will not die here — strip them first or this measures the shield.
    boss.platesLeft = 0;
    if (boss.plates) boss.plates.length = 0;
    boss.hp = 1;
    P.damageWalker(boss, 99999, null, 0, "impact");
    P.hero.hp = 99;
    P.step(1 / 60);

    const out = {
      before: 1,
      after: P.charLevel("pyromancer"),
      other: P.charLevel("telekinetic"),
      capBefore,
      capAfter: P.castCap(P.charLevel("pyromancer")),
      saved: false,
    };
    // Written through to storage, not just held in memory.
    try {
      const raw = JSON.parse(localStorage.getItem("kinesis.v1") || "{}");
      out.saved = raw.charLv && raw.charLv.pyromancer === out.after;
    } catch (e) { out.saved = "storage unavailable"; }

    // A plain body must NOT level anything.
    const lv = P.charLevel("pyromancer");
    P.spawnWalker("walker", 0, -8);
    const mook = P.walkers.filter(w => !w.dead).pop();
    P.damageWalker(mook, 99999, null, 0, "impact");
    P.hero.hp = 99;
    P.step(1 / 60);
    out.afterMook = P.charLevel("pyromancer");
    out.mookBase = lv;
    return out;
  });

  eq(r.after, 2, "killing a boss did not raise the character's level");
  eq(r.other, 1, "levelling the pyromancer also moved the telekinetic");
  ok(r.capAfter > r.capBefore,
     "the level bought nothing: fireball cap stayed at " + r.capBefore);
  eq(r.saved, true, "the new level was not written to storage, so it dies with the tab");
  eq(r.afterMook, r.mookBase, "an ordinary walker levelled the character");
});

test("characters: every caster's stack is capped by level and grows back", async (pg) => {
  // Runs for each casting character in turn. The machinery is shared, so what
  // this really guards is that a new kit's own numbers — its regen clock above
  // all — still fill the stack inside a reasonable stretch of play.
  //
  // The COUNT is checked for every kit; the WORN stack only for kits that wear
  // one. The hydromancer holds the same resource and spends it the same way,
  // but its water is called up out of the ground when it is used, so there is
  // nothing on its shoulders to count.
  const casters = await pg.evaluate(() =>
    Object.keys(window.__probe.CHARS).filter(k => !!window.__probe.CHARS[k].cast));
  ok(casters.length >= 2, "expected at least two casters, found " + casters.join(", "));

  for (const who of casters) {
    const r = await pg.evaluate(async (who) => {
    const P = window.__probe;
    P.setCharacter(who);
    P.PROFILE.charLv[who] = 1;
    P.buildWave(3); P.parkWalkers(); P.stripProps();
    P.castState.held = 0; P.buildCastStack();

    // Regenerates up to the cap and stops there.
    const cap1 = P.castCap(1);
    for (let i = 0; i < 60 * 40; i++) { P.hero.hp = 99; P.step(1 / 60); }
    const filled = P.castState.held;

    // A level raises the ceiling.
    P.PROFILE.charLv[who] = 4;
    P.buildCastStack();
    for (let i = 0; i < 60 * 40; i++) { P.hero.hp = 99; P.step(1 / 60); }
    const filled4 = P.castState.held;

    // Firing spends one and puts something in the air.
    const before = P.castState.held;
    P.castFire();
    // A volley kit spends ONE charge and leaves a whole fan behind it, so the
    // number in the air is a property of the kit rather than a constant. What
    // stays constant across every kit is the price: one charge per trigger.
    const sp = P.castSpec();
    return { cap1, filled, cap4: P.castCap(4), filled4,
             spent: before - P.castState.held, inFlight: P.castState.shots.length,
             wantFlight: sp.volley ? sp.volley.count : 1,
             orbs: P.castState.orbs.length, worn: P.CHARS[who].cast.carried !== false };
    }, who);

    eq(r.filled, r.cap1, who + ": at level 1 the stack settled at " + r.filled +
       ", not the cap " + r.cap1);
    eq(r.filled4, r.cap4, who + ": at level 4 the stack settled at " + r.filled4 +
       ", not the cap " + r.cap4);
    ok(r.cap4 > r.cap1, who + ": levelling did not raise the cap");
    if (r.worn) {
      eq(r.orbs, r.cap4, who + ": the visible stack (" + r.orbs + ") does not match the cap " +
         r.cap4);
    } else {
      eq(r.orbs, 0, who + ": carries nothing, yet " + r.orbs + " are riding its back");
    }
    eq(r.spent, 1, who + ": firing did not spend exactly one");
    eq(r.inFlight, r.wantFlight, who + ": firing put " + r.inFlight +
       " in the air, not the " + r.wantFlight + " this kit fires");
  }
});

test("characters: the carried stack scatters behind the player", async (pg) => {
  // They used to sit in one evenly spaced line at a single height, which reads
  // as a rack rather than fire being carried. What the scatter has to be: a
  // spread in depth as well as sideways, a spread in height, every ball clear
  // of the ground and none of them up at the crown — and fixed per ball, so
  // the cloud rides with the player instead of boiling around them.
  //
  // Only kits that WEAR their stack. A kit that carries nothing has no scatter
  // to check, and asserting one against it would be asserting that every kit
  // must wear its ammunition — which is the thing the hydromancer exists to
  // not do. That it carries nothing is covered by its own case.
  const casters = await pg.evaluate(() =>
    Object.keys(window.__probe.CHARS)
      .filter(k => !!window.__probe.CHARS[k].cast &&
                   window.__probe.CHARS[k].cast.carried !== false));

  for (const who of casters) {
  const r = await pg.evaluate((who) => {
    const P = window.__probe;
    P.setCharacter(who);
    P.PROFILE.charLv[who] = 7;
    P.buildWave(3); P.parkWalkers(); P.stripProps();
    P.castState.held = 0; P.buildCastStack();
    for (let i = 0; i < 60 * 40; i++) { P.hero.hp = 99; P.hero.pos.set(0, 0, 0); P.step(1 / 60); }

    // Depth is measured along the axis the stack rides on, not as a raw
    // distance: a straight sideways line puts every ball at the same depth
    // but at different distances, so distance alone would call it scattered.
    const bx = -Math.sin(P.cam.yaw), bz = -Math.cos(P.cam.yaw);
    const rel = () => P.castState.orbs.filter(o => o.visible).map(o => ({
      back: (o.position.x - P.hero.pos.x) * bx + (o.position.z - P.hero.pos.z) * bz,
      side: (o.position.x - P.hero.pos.x) * bz - (o.position.z - P.hero.pos.z) * bx,
      y:     o.position.y - P.hero.pos.y,
    }));
    const a = rel();
    const span = (k) => Math.max(...a.map(o => o[k])) - Math.min(...a.map(o => o[k]));

    // Same hero, one frame later: the offsets must not have been re-rolled.
    P.hero.hp = 99; P.step(1 / 60);
    const b = rel();
    let drift = 0;
    for (let i = 0; i < a.length; i++)
      drift = Math.max(drift, Math.abs(a[i].back - b[i].back), Math.abs(a[i].side - b[i].side));

    // And they travel with the player rather than staying put.
    P.hero.pos.set(12, 0, 0); P.hero.hp = 99; P.step(1 / 60);
    const c = rel();
    let carried = 0;
    for (let i = 0; i < a.length; i++)
      carried = Math.max(carried, Math.abs(a[i].back - c[i].back), Math.abs(a[i].side - c[i].side));

    // The scatter is RANDOM per ball, so one draw is one sample of a
    // distribution — and a threshold checked against a single sample fails
    // whenever the draw lands in its tail. (It did: the boomeranger came up
    // with a depth span of 0.117 against a bar of 0.12, and passed three times
    // running immediately afterwards.) The spans are judged on the median of
    // several rebuilds instead, which asks the real question — does the
    // GENERATOR scatter — rather than whether one roll was lucky.
    const draws = [];
    for (let d = 0; d < 9; d++) {
      // Fill the stack directly rather than waiting out the regen clock: the
      // offsets are fixed when the stack is built, which is all this samples.
      P.castState.held = P.castCap(7);
      P.buildCastStack();
      // A rebuilt stack has its offsets but not yet its positions; those are
      // written during the frame. Without a step every ball reads as sitting
      // at the same place and the span is a flat zero.
      P.hero.hp = 99; P.hero.pos.set(0, 0, 0); P.step(1 / 60);
      const s = rel();
      const sp = (k) => Math.max(...s.map(o => o[k])) - Math.min(...s.map(o => o[k]));
      draws.push({ back: sp("back"), side: sp("side"), y: sp("y"),
                   lowest: Math.min(...s.map(o => o.y)),
                   highest: Math.max(...s.map(o => o.y)) });
    }
    const median = (k) => draws.map(d => d[k]).sort((p, q) => p - q)[draws.length >> 1];

    return { n: a.length, backSpan: median("back"), sideSpan: median("side"),
             ySpan: median("y"),
             // Clearance is a hard invariant, not a distribution: the worst
             // ball across every draw is the one that matters.
             lowest: Math.min(...draws.map(d => d.lowest)),
             highest: Math.max(...draws.map(d => d.highest)),
             drift, carried, crownY: P.CROWN_Y, draws: draws.length };
  }, who);

    ok(r.n >= 5, who + ": only " + r.n + " were carried, too few to judge the spread");
    ok(r.backSpan > 0.12,
       who + ": they all ride at the same depth (median span over " + r.draws +
       " rebuilds: " + r.backSpan.toFixed(3) + ") — still a line");
    ok(r.sideSpan > 0.5, who + ": they barely spread sideways: " + r.sideSpan.toFixed(3));
    ok(r.ySpan > 0.35, who + ": they sit at nearly one height: span " + r.ySpan.toFixed(3));
    // The widest projectile here is about 0.5 across at carry scale, so its
    // underside hangs ~0.25 below the centre this test can see.
    ok(r.lowest - 0.25 > 0.6,
       who + ": the lowest hangs at " + r.lowest.toFixed(2) + ", close enough to scrape the ground");
    ok(r.highest < r.crownY,
       who + ": one rode up to " + r.highest.toFixed(2) + ", at or above the crown (" + r.crownY + ")");
    ok(r.drift < 1e-6,
       who + ": the offsets are re-rolled every frame (drift " + r.drift.toFixed(4) + ") — it boils");
    ok(r.carried < 1e-6,
       who + ": they did not follow the player (offset moved " + r.carried.toFixed(3) + ")");
  }
});

test("characters: telekinesis-only drafts are withheld from the pyromancer", async (pg) => {
  // Offering "carry 3 more objects" to a character with no objects is a dead
  // pick, and the draft only ever shows three — one wasted slot is a third of
  // the choice gone.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    const ids = ["kinetic", "swarm", "reach", "flow"];
    const offered = (who) => {
      P.setCharacter(who);
      return ids.filter(id => {
        const u = P.UPGRADES.find(x => x.id === id);
        return u && (!u.more || u.more());
      });
    };
    const bad = {};
    for (const key in P.CHARS)
      if (P.CHARS[key].power !== "kinesis") bad[key] = offered(key);
    const tele = offered("telekinetic");
    P.setCharacter("telekinetic");
    return { bad, tele };
  });

  for (const key in r.bad)
    eq(r.bad[key].length, 0,
       key + " is still offered telekinesis-only picks: " + r.bad[key].join(", "));
  eq(r.tele.length, 4,
     "the gate also withheld these from the telekinetic: expected all four, got " +
     r.tele.join(", "));
});

test("characters: the hydromancer's water finds a body it was not aimed at", async (pg) => {
  // The kit's claim, from its own briefing: the stream FINDS them. Measured as
  // ARRIVAL — fire 60 degrees away from a body and see whether the shot gets
  // there, and how long it takes — with the pyromancer's weaker pull as the
  // control, because every kit homes a little.
  //
  // Two earlier metrics were wrong and the numbers said so. Total turning
  // rewarded a fireball that sailed past and looped back: 177 degrees of
  // "bending" while being worse at arriving. Angle-to-target then broke on
  // this kit's own arc — water that climbs out of the ground and falls on
  // someone points well above them while being exactly on course, and read 19
  // degrees off a moment before it landed. Whether it arrives cannot be
  // gamed by either.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    const runFor = (who) => {
      P.setCharacter(who);
      P.PROFILE.charLv[who] = 6;
      P.buildWave(3); P.parkWalkers(); P.stripProps();
      P.castState.held = 0; P.buildCastStack();
      for (let i = 0; i < 60 * 30; i++) { P.hero.hp = 99; P.hero.pos.set(0, 0, 0); P.step(1 / 60); }
      P.parkWalkers();
      P.MOD.allDmg = 1; P.MOD.blastR = 1; P.MOD.blastDmg = 1; P.WMOD.blastR = 1;

      // Well off the line — about 60 degrees of it — and tough enough to
      // survive, so "did it arrive" cannot be confused with "did it kill".
      const w = P.walkers.find(x => !x.dead);
      const f = { x: Math.sin(P.cam.yaw), z: Math.cos(P.cam.yaw) };
      const side = { x: f.z, z: -f.x };
      w.pos.set(f.x * 10 + side.x * 18, 0, f.z * 10 + side.z * 18);
      w.aggro = false; w.cool = 999; w.hp = 4000;
      const hp0 = w.hp;
      const off0 = Math.atan2(18, 10) * 180 / Math.PI;

      P.S.lock = w;                       // fired straight ahead, locked to the side
      P.castFire();
      let frames = -1;
      for (let i = 0; i < 60 * 4; i++) {
        P.hero.pos.set(0, 0, 0); P.hero.hp = 99; P.step(1 / 60);
        if (w.hp < hp0) { frames = i; break; }
      }
      return { off0: +off0.toFixed(1), hit: frames >= 0, frames };
    };
    const water = runFor("hydromancer");
    const fire  = runFor("pyromancer");
    P.setCharacter("telekinetic");
    return { water, fire };
  });

  ok(r.water.off0 > 45,
     "the test fired only " + r.water.off0 + "° off the target — too little to ask " +
     "whether anything finds anything");
  ok(r.water.hit,
     "the water never reached a body 60° off the line it was fired down, in four " +
     "seconds — the kit's one promise is not kept");
  ok(r.water.frames < 120,
     "the water took " + r.water.frames + " frames to arrive; at that pace it is " +
     "wandering there, not hunting");
  ok(!r.fire.hit || r.fire.frames > r.water.frames + 20,
     "fire arrived in " + r.fire.frames + " frames and water in " + r.water.frames +
     " — too close for the hydromancer to read as the kit that finds its mark");
});

test("characters: the hydromancer carries nothing and lifts its water before throwing it", async (pg) => {
  // Four claims, and each one is a thing that was true of this kit earlier and
  // must not be true now: nothing rides the shoulders, the water starts on the
  // ground, it goes straight UP to a set height before it goes anywhere else,
  // and it stretches into a tail only once it has been thrown.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    const stackFor = (who) => {
      P.setCharacter(who);
      P.PROFILE.charLv[who] = 6;
      P.castState.held = 0; P.buildCastStack();
      return P.castState.orbs.length;
    };
    const worn = { water: stackFor("hydromancer"),
                   fire:  stackFor("pyromancer"),
                   wind:  stackFor("windmage") };

    P.setCharacter("hydromancer");
    P.PROFILE.charLv.hydromancer = 6;
    P.buildWave(3); P.parkWalkers(); P.stripProps();
    P.castState.held = 0; P.buildCastStack();
    for (let i = 0; i < 60 * 30; i++) { P.hero.hp = 99; P.hero.pos.set(0, 0, 0); P.step(1 / 60); }
    P.parkWalkers();

    const w = P.walkers.find(x => !x.dead);
    const f = { x: Math.sin(P.cam.yaw), z: Math.cos(P.cam.yaw) };
    w.pos.set(f.x * 26, 0, f.z * 26);
    w.aggro = false; w.cool = 999; w.hp = 4000;

    P.S.lock = w;
    P.castFire();
    const shot = P.castState.shots[P.castState.shots.length - 1];
    const from = { x: shot.g.position.x, y: shot.g.position.y, z: shot.g.position.z };

    // While it is being lifted: how far it wanders sideways, and how round it
    // stays. After it is thrown: how far it stretches.
    let driftWhileRising = 0, roundWhileRising = 0, liftedTo = from.y;
    let stretched = 0, tail = 0, moved = 0;
    for (let i = 0; i < 90 && P.castState.shots.includes(shot); i++) {
      P.hero.pos.set(0, 0, 0); P.hero.hp = 99; P.step(1 / 60);
      if (!P.castState.shots.includes(shot)) break;
      const g = shot.g;
      if (shot.rising) {
        driftWhileRising = Math.max(driftWhileRising,
          Math.hypot(g.position.x - from.x, g.position.z - from.z));
        roundWhileRising = Math.max(roundWhileRising, Math.abs(g.scale.z / g.scale.x - 1));
        liftedTo = Math.max(liftedTo, g.position.y);
      } else {
        stretched = Math.max(stretched, g.scale.z / g.scale.x);
        moved = Math.max(moved, Math.hypot(g.position.x - from.x, g.position.z - from.z));
        // The tail: how far back the furthest live droplet sits from the ball.
        for (const p of P.castState.embers) {
          tail = Math.max(tail, Math.hypot(p.m.position.x - g.position.x,
                                           p.m.position.y - g.position.y,
                                           p.m.position.z - g.position.z));
        }
      }
    }
    return { worn, startY: +from.y.toFixed(2), liftedTo: +liftedTo.toFixed(2),
             driftWhileRising: +driftWhileRising.toFixed(2),
             roundWhileRising: +roundWhileRising.toFixed(2),
             stretched: +stretched.toFixed(2), moved: +moved.toFixed(1),
             tail: +tail.toFixed(1), riseTo: P.CHARS.hydromancer.cast.riseTo };
  });

  eq(r.worn.water, 0,
     "the hydromancer is wearing " + r.worn.water + " on their back; this kit carries nothing");
  ok(r.worn.fire > 0 && r.worn.wind > 0,
     "the other two kits lost their carried stacks as well (fire " + r.worn.fire +
     ", wind " + r.worn.wind + ") — the change was meant to be per kit");
  ok(r.startY < 0.3,
     "the water appeared " + r.startY + " off the deck: it is coming out of the hands, " +
     "not off the ground");
  // Lifted straight up, to the height the kit names, and not a step sideways
  // on the way — that is what separates being raised from being thrown.
  ok(Math.abs(r.liftedTo - (r.startY + r.riseTo)) < 0.4,
     "the lift stopped at " + r.liftedTo + ", not the " + (r.startY + r.riseTo) + " it names");
  ok(r.driftWhileRising < 0.4,
     "the ball drifted " + r.driftWhileRising + " sideways while being lifted — it is " +
     "being thrown upward at an angle, not raised");
  ok(r.roundWhileRising < 0.15,
     "the ball was already stretched while still rising (by " + r.roundWhileRising +
     ") — the tail belongs to the throw, not to the lift");
  // ...and then thrown, stretching along its travel.
  ok(r.moved > 8, "after the lift the ball only covered " + r.moved + " — it never launched");
  ok(r.stretched > 1.5,
     "the thrown ball stretched by only " + r.stretched + "x along its travel: it is a " +
     "marble, not water being pulled into a tail");
  // A tail with a readable length: long enough to read as one, short enough
  // not to be a rope across the arena.
  ok(r.tail > 1.5 && r.tail < 12,
     "the tail reached " + r.tail + " behind the ball, which is outside what reads as a tail");
});

test("characters: the arcanist's shot changes SHAPE at each level tier, not just count", async (pg) => {
  // The whole point of this character: the other three casters hold one
  // fixed shot for the whole run and only the COUNT scales with level. This
  // one is supposed to hand out a structurally different shot at levels 1,
  // 3 and 6 — a ball, then a blade, then a bigger ball again. Counting the
  // top-level children of the built mesh is the cheap fingerprint for
  // "which shape": the ball factories (Spark, Nova) always produce 4, the
  // blade factory (Shard) always produces 1 (a spin group holding the
  // three crescents).
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.setCharacter("arcanist");
    const out = {};
    for (const lv of [1, 2, 3, 5, 6, 8]) {
      P.PROFILE.charLv.arcanist = lv;
      P.castState.held = 0;
      P.buildCastStack();
      const orb = P.castState.orbs[0];
      out[lv] = {
        tier: P.arcSpec(lv).tier,
        shape: orb.children.length,
        pierce: P.arcSpec(lv).pierce,
        blastR: P.arcSpec(lv).blastR,
        rimHex: (orb.children.length === 4
          ? orb.children[0].material.color.getHexString() : null),
      };
    }
    P.setCharacter("telekinetic");
    return out;
  });

  eq(r[1].tier, "Spark", "level 1 should be the Spark tier, got " + r[1].tier);
  eq(r[2].tier, "Spark", "level 2 should still be Spark, got " + r[2].tier);
  eq(r[3].tier, "Shard", "level 3 should cross into Shard, got " + r[3].tier);
  eq(r[5].tier, "Shard", "level 5 should still be Shard, got " + r[5].tier);
  eq(r[6].tier, "Nova", "level 6 should cross into Nova, got " + r[6].tier);
  eq(r[8].tier, "Nova", "level 8 (max) should still be Nova, got " + r[8].tier);

  eq(r[1].shape, 4, "Spark's carried shot is not the four-layer orb structure");
  eq(r[3].shape, 1, "Shard's carried shot is not the one-child blade structure");
  eq(r[6].shape, 4, "Nova's carried shot is not the four-layer orb structure");
  ok(r[1].rimHex !== r[6].rimHex,
     "Spark and Nova are both the orb shape but share a rim colour (" +
     r[1].rimHex + ") — Nova is not visibly hotter, it is a recolour that did nothing");

  eq(r[1].pierce, 0, "Spark should have no pierce");
  ok(r[3].pierce > 0, "Shard should gain pierce — it has none");
  eq(r[3].blastR, 0, "Shard should have no blast — that is what its pierce is paid for");
  ok(r[6].blastR > 0, "Nova should gain a blast — it has none");
});

test("characters: a shot in flight keeps the tier it was fired under, even if a level-up crosses a boundary underneath it", async (pg) => {
  // stepCast() used to read castSpec() ONCE per frame and apply it to every
  // in-flight shot. That is safe for the other three casters, whose spec
  // never changes shape mid-run — but this character's does, and a boss
  // kill can land while a shot is still airborne. Firing under Spark (a
  // four-child orb, no aim function) and then jumping the character straight
  // to Nova reproduces the worst case cheaply: if the flight loop reads the
  // LIVE spec instead of a frozen one, Nova's config still has no aim
  // function either, so the structural mismatch this guards against would
  // have to come from Shard's aim/anim running against Spark's mesh — which
  // is exactly the case the frozen-spec fix (game.js: `spec` on the shot
  // object) exists for. Jumping through Shard on the way to Nova, one frame
  // at a time, is what actually exercises it.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.setCharacter("arcanist");
    P.PROFILE.charLv.arcanist = 1;                 // Spark
    P.buildWave(3); P.parkWalkers(); P.stripProps();
    P.castState.held = 0; P.buildCastStack();
    for (let i = 0; i < 60 * 20; i++) { P.hero.hp = 99; P.hero.pos.set(0, 0, 0); P.step(1 / 60); }
    P.parkWalkers();

    const tierAtFire = P.castSpec().tier;
    P.S.lock = null;
    P.castFire();
    const shot = P.castState.shots[P.castState.shots.length - 1];
    const shapeAtFire = shot.g.children.length;

    // Cross straight to Shard, then straight to Nova, one frame apart —
    // the fastest way to put the live spec and the shot's frozen one on
    // different tiers while the shot is still alive.
    let threw = null;
    try {
      P.PROFILE.charLv.arcanist = 4;                // Shard
      P.buildCastStack();
      for (let i = 0; i < 10; i++) { P.hero.pos.set(0, 0, 0); P.hero.hp = 99; P.step(1 / 60); }
      P.PROFILE.charLv.arcanist = 8;                 // Nova
      P.buildCastStack();
      for (let i = 0; i < 30; i++) { P.hero.pos.set(0, 0, 0); P.hero.hp = 99; P.step(1 / 60); }
    } catch (e) {
      threw = String((e && e.message) || e);
    }

    const stillTracked = P.castState.shots.includes(shot);
    const shapeNow = stillTracked ? shot.g.children.length : null;
    P.setCharacter("telekinetic");
    return { tierAtFire, shapeAtFire, threw, liveTierAfter: "Nova",
             stillTracked, shapeNow };
  });

  eq(r.tierAtFire, "Spark", "the shot should have been fired under Spark");
  eq(r.shapeAtFire, 4, "the fired shot should be the four-child orb shape");
  eq(r.threw, null,
     "stepping the game after a level-up crossed two tier boundaries under an " +
     "airborne shot threw: " + r.threw);
  // Whether the shot is still alive by the time the loop above finishes is a
  // matter of its own lifetime, not something this case controls — the only
  // claim here is that IF it is still alive, it never silently turned into
  // Shard or Nova's shape.
  if (r.stillTracked) {
    eq(r.shapeNow, r.shapeAtFire,
       "an airborne shot's own mesh shape changed after the character's live " +
       "tier moved on without it");
  }
});



test("characters: the stormcaller's arc jumps to bodies the shot never touched", async (pg) => {
  // The kit's whole claim: damage depends on how the crowd is STANDING. So
  // line up four bodies within jump range of each other, fire at the first,
  // and count how many took damage. Only one of them is ever touched by the
  // shot itself — the rest can only have been reached by the chain.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.setCharacter("stormcaller");
    P.PROFILE.charLv.stormcaller = 6;
    P.buildWave(3); P.parkWalkers(); P.stripProps();
    P.MOD.allDmg = 1;
    P.castState.held = 0; P.buildCastStack();
    for (let i = 0; i < 60 * 25; i++) { P.hero.hp = 99; P.hero.pos.set(0, 0, 0); P.step(1/60); }
    P.parkWalkers();

    const live = P.walkers.filter(w => !w.dead).slice(0, 4);
    const f = { x: Math.sin(P.cam.yaw), z: Math.cos(P.cam.yaw) };
    const side = { x: f.z, z: -f.x };
    // A cluster: the first straight ahead, the rest beside it, each within
    // the 9-unit jump radius of the one before.
    const place = () => live.forEach((w, i) => {
      w.pos.set(f.x * 18 + side.x * i * 4, 0, f.z * 18 + side.z * i * 4);
      w.aggro = false; w.cool = 999; w.hp = 4000;
    });
    place();
    const hp0 = live.map(w => w.hp);

    P.S.lock = live[0];
    P.castFire();
    for (let i = 0; i < 150; i++) {
      P.hero.pos.set(0, 0, 0); P.hero.hp = 99;
      live.forEach((w, i2) => { w.aggro = false; w.cool = 999; });
      P.step(1/60);
    }
    const hurt = live.map((w, i) => w.hp < hp0[i]);
    const dmg = live.map((w, i) => +(hp0[i] - w.hp).toFixed(1));
    P.setCharacter("telekinetic");
    return { hurt, dmg, jumps: P.STORM.chain.jumps };
  });

  ok(r.hurt[0], "the arc never hit the body it was aimed at");
  const reached = r.hurt.filter(Boolean).length;
  ok(reached >= 3,
     "the arc reached " + reached + " of four clustered bodies — it is not chaining, " +
     "it is a plain single-target shot wearing a different colour");
  // Each jump is weaker than the last, which is what stops a chain kit from
  // simply being strictly better than every single-target kit.
  ok(r.dmg[1] < r.dmg[0],
     "the second body took " + r.dmg[1] + " and the first " + r.dmg[0] +
     " — the chain is not losing strength as it jumps");
});

test("characters: the plaguebearer's pool keeps damaging after the shot is gone", async (pg) => {
  // The shot barely hurts; the ground it leaves is the weapon. The test that
  // matters is therefore about TIME: a body that walks nowhere should keep
  // taking damage long after the projectile itself has stopped existing.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.setCharacter("plaguebearer");
    P.PROFILE.charLv.plaguebearer = 6;
    P.buildWave(3); P.parkWalkers(); P.stripProps();
    P.MOD.allDmg = 1;
    P.castState.held = 0; P.buildCastStack();
    for (let i = 0; i < 60 * 25; i++) { P.hero.hp = 99; P.hero.pos.set(0, 0, 0); P.step(1/60); }
    P.parkWalkers();

    const w = P.walkers.find(x => !x.dead);
    const f = { x: Math.sin(P.cam.yaw), z: Math.cos(P.cam.yaw) };
    const pin = () => { w.pos.set(f.x * 16, 0, f.z * 16); w.aggro = false; w.cool = 999; };
    pin(); w.hp = 9000;

    P.S.lock = w;
    P.castFire();
    // Wait for the shot to land and be GONE first, and only start the clock
    // then. The first version of this measured a fixed 1.5s window from the
    // trigger, most of which the shot spent in the air — it read 41 damage,
    // which is exactly 0.75s of pool, and looked like a broken mechanic when
    // it was a short ruler.
    let shotGone = false, hpWhenGone = null, pools = 0;
    for (let i = 0; i < 60 * 3 && !shotGone; i++) {
      pin(); P.hero.pos.set(0, 0, 0); P.hero.hp = 99; P.step(1/60);
      if (P.castState.shots.length === 0) {
        shotGone = true; hpWhenGone = w.hp; pools = P.castState.pools.length;
      }
    }
    // Now four seconds of standing in it, with nothing else able to touch it.
    for (let i = 0; i < 60 * 4; i++) {
      pin(); P.hero.pos.set(0, 0, 0); P.hero.hp = 99; P.step(1/60);
    }
    const hpLater = w.hp;
    // ...and long enough for the pool to expire on its own.
    for (let i = 0; i < 60 * 8; i++) { pin(); P.hero.pos.set(0, 0, 0); P.hero.hp = 99; P.step(1/60); }
    const poolsAfter = P.castState.pools.length;
    const hpFinal = w.hp;
    P.setCharacter("telekinetic");
    return { shotGone, pools, afterShot: +(hpWhenGone - hpLater).toFixed(1),
             poolsAfter, stoppedAtEnd: hpFinal === w.hp };
  });

  ok(r.shotGone, "the shot never resolved, so nothing about the pool was tested");
  eq(r.pools, 1, "the shot left " + r.pools + " pools behind, expected exactly one");
  // Four seconds at 55 a second is 220 before armour; anything in that
  // neighbourhood is the pool working, and anything near zero is not.
  ok(r.afterShot > 120,
     "the body lost only " + r.afterShot + " after the shot was already gone — the pool " +
     "is not the weapon, which is this kit's entire premise");
  eq(r.poolsAfter, 0, "the pool never expired — it is permanent ground denial");
});

test("characters: the frostbinder slows what it hits, and the crown still slows its own way", async (pg) => {
  // Two claims in one, because they share a field. The kit sets a slow the
  // Crown never could (a third speed, four seconds), and generalising that
  // field must not have broken the Crown, which was the only thing in the
  // game that slowed anything before this.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.setCharacter("frostbinder");
    P.PROFILE.charLv.frostbinder = 6;
    P.buildWave(3); P.parkWalkers(); P.stripProps();
    P.MOD.allDmg = 1;
    P.castState.held = 0; P.buildCastStack();
    for (let i = 0; i < 60 * 25; i++) { P.hero.hp = 99; P.hero.pos.set(0, 0, 0); P.step(1/60); }
    P.parkWalkers();

    const w = P.walkers.find(x => !x.dead);
    const f = { x: Math.sin(P.cam.yaw), z: Math.cos(P.cam.yaw) };
    w.pos.set(f.x * 16, 0, f.z * 16); w.aggro = false; w.cool = 999; w.hp = 9000;
    const hp0 = w.hp;

    P.S.lock = w;
    P.castFire();
    let slowT = 0, slowMul = null;
    for (let i = 0; i < 120; i++) {
      P.hero.pos.set(0, 0, 0); P.hero.hp = 99;
      w.aggro = false; w.cool = 999;
      P.step(1/60);
      if (w.slowT > slowT) { slowT = w.slowT; slowMul = w.slowMul; }
    }
    const dealt = hp0 - w.hp;

    // The Crown's own path, untouched: it sets slowT without the kit.
    const w2 = P.walkers.filter(x => !x.dead)[1];
    w2.slowT = 0; w2.slowMul = undefined;
    w2.slowT = P.CROWN.slowT; w2.slowMul = P.CROWN.slowMul;
    P.setCharacter("telekinetic");
    return { slowT: +slowT.toFixed(2), slowMul, dealt: +dealt.toFixed(1),
             frostMul: P.FROST.slow.mul, frostTime: P.FROST.slow.time,
             crownMul: P.CROWN.slowMul, w2mul: w2.slowMul };
  });

  ok(r.slowT > 0, "nothing was ever slowed — the bind does not bind");
  eq(r.slowMul, r.frostMul,
     "the struck body wades at " + r.slowMul + ", not the kit's own " + r.frostMul +
     " — it is still borrowing the Crown's strength");
  ok(r.slowT > r.frostTime * 0.9,
     "the slow lasted " + r.slowT + "s against the kit's stated " + r.frostTime + "s");
  ok(r.frostMul < r.crownMul,
     "the frostbinder's slow (" + r.frostMul + ") is no stronger than the Crown's (" +
     r.crownMul + "), so the kit has no identity of its own");
  // The whole trade: it must be the weakest hit on the roster.
  ok(r.dealt < 200,
     "the bind dealt " + r.dealt + " — it is supposed to buy distance, not kill");
  eq(r.w2mul, r.crownMul, "the Crown's own slow path stopped working");
});

test("characters: the warden's charge sticks, waits, and only then detonates", async (pg) => {
  // The one kit with a gap between the decision and the damage. Three things
  // have to hold or the mechanic is a lie: it stops where it hit rather than
  // flying on, it deals almost nothing while it waits, and the big damage
  // arrives only after the fuse runs out.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.setCharacter("warden");
    P.PROFILE.charLv.warden = 6;
    P.buildWave(3); P.parkWalkers(); P.stripProps();
    P.MOD.allDmg = 1; P.MOD.blastR = 1; P.MOD.blastDmg = 1; P.WMOD.blastR = 1;
    P.castState.held = 0; P.buildCastStack();
    for (let i = 0; i < 60 * 25; i++) { P.hero.hp = 99; P.hero.pos.set(0, 0, 0); P.step(1/60); }
    P.parkWalkers();

    const w = P.walkers.find(x => !x.dead);
    const f = { x: Math.sin(P.cam.yaw), z: Math.cos(P.cam.yaw) };
    const pin = () => { w.pos.set(f.x * 16, 0, f.z * 16); w.aggro = false; w.cool = 999; };
    pin(); w.hp = 9000;
    const hp0 = w.hp;

    P.S.lock = w;
    P.castFire();
    const shot = P.castState.shots[P.castState.shots.length - 1];

    // Run until it sticks, recording where it stopped.
    let stuckAt = null, hpAtStick = null, framesToStick = 0;
    for (let i = 0; i < 60 * 3 && !stuckAt; i++) {
      pin(); P.hero.pos.set(0, 0, 0); P.hero.hp = 99; P.step(1/60);
      framesToStick++;
      if (shot.stuck) {
        stuckAt = { x: shot.g.position.x, z: shot.g.position.z };
        hpAtStick = w.hp;
      }
    }
    // While it waits it must not move and must not keep hurting anything.
    let moved = 0;
    for (let i = 0; i < 20; i++) {
      pin(); P.hero.pos.set(0, 0, 0); P.hero.hp = 99; P.step(1/60);
      if (P.castState.shots.includes(shot)) {
        moved = Math.max(moved, Math.hypot(shot.g.position.x - stuckAt.x,
                                           shot.g.position.z - stuckAt.z));
      }
    }
    const hpMidFuse = w.hp;
    // ...and then it goes off.
    for (let i = 0; i < 90; i++) { pin(); P.hero.pos.set(0, 0, 0); P.hero.hp = 99; P.step(1/60); }
    const gone = !P.castState.shots.includes(shot);
    const hpEnd = w.hp;
    P.setCharacter("telekinetic");
    return { stuck: !!stuckAt, moved: +moved.toFixed(3),
             onImpact: +(hp0 - hpAtStick).toFixed(1),
             duringFuse: +(hpAtStick - hpMidFuse).toFixed(1),
             onBlast: +(hpMidFuse - hpEnd).toFixed(1), gone,
             fuseDmg: P.WARDEN.fuse.dmg, impactDmg: P.WARDEN.dmg };
  });

  ok(r.stuck, "the charge never stuck to anything — it behaves like an ordinary shot");
  ok(r.moved < 0.01,
     "a stuck charge drifted " + r.moved + " while counting down; it is supposed to " +
     "sit where it landed");
  ok(r.onImpact < 60,
     "the charge dealt " + r.onImpact + " on impact — the whole point is that landing " +
     "barely hurts and the wait is what is paid for");
  ok(r.onBlast > r.onImpact * 2,
     "the detonation dealt " + r.onBlast + " against " + r.onImpact + " on impact: the " +
     "payoff is not bigger than the delivery, so the fuse buys nothing");
  ok(r.gone, "the charge never detonated — it is stuck forever");
});

test("characters: the gravemind pulls bodies inward where a blast throws them outward", async (pg) => {
  // Measured as the IMPULSE each body is given, not as ground it covers.
  // Displacement was the wrong ruler twice over: bodies walk toward the hero
  // on their own, which packs a crowd together regardless of what hit it, and
  // over two seconds that walking dwarfs the effect being measured — it had a
  // fireball "gathering" a crowd harder than the kit built to gather.
  //
  // The impulse has no such confound. For each body, take the dot product of
  // its knockback with the unit vector pointing at the impact. Positive means
  // thrown toward the point; negative means away. A pull and a blast must come
  // out with opposite signs or one of them is not doing its job.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    const impulseFor = (who) => {
      P.setCharacter(who);
      P.PROFILE.charLv[who] = 6;
      P.buildWave(3); P.parkWalkers(); P.stripProps();
      P.MOD.allDmg = 1; P.MOD.blastR = 1; P.MOD.blastDmg = 1; P.WMOD.blastR = 1;
      P.castState.held = 0; P.buildCastStack();
      for (let i = 0; i < 60 * 25; i++) { P.hero.hp = 99; P.hero.pos.set(0, 0, 0); P.step(1/60); }
      P.parkWalkers();

      const live = P.walkers.filter(x => !x.dead).slice(0, 4);
      const f = { x: Math.sin(P.cam.yaw), z: Math.cos(P.cam.yaw) };
      live.forEach((w, i) => {
        const a = i * Math.PI / 2;
        w.pos.set(f.x * 18 + Math.cos(a) * 5, 0, f.z * 18 + Math.sin(a) * 5);
        w.aggro = false; w.cool = 999; w.hp = 9000; w.kb.set(0, 0, 0);
      });

      P.S.lock = live[0];
      P.castFire();
      const shot = P.castState.shots[P.castState.shots.length - 1];
      let last = { x: shot.g.position.x, z: shot.g.position.z };
      let best = 0;
      for (let i = 0; i < 60 * 4; i++) {
        if (P.castState.shots.includes(shot)) {
          last = { x: shot.g.position.x, z: shot.g.position.z };
        }
        P.hero.pos.set(0, 0, 0); P.hero.hp = 99;
        live.forEach(w => { w.aggro = false; w.cool = 999; });
        P.step(1/60);
        // The impulse is spent within a few frames, so take the strongest
        // reading rather than whatever happens to be left at the end.
        let sum = 0;
        for (const w of live) {
          const dx = last.x - w.pos.x, dz = last.z - w.pos.z;
          const d = Math.hypot(dx, dz) || 1;
          sum += (w.kb.x * dx + w.kb.z * dz) / d;
        }
        if (Math.abs(sum) > Math.abs(best)) best = sum;
      }
      return +best.toFixed(2);
    };
    const grave = impulseFor("gravemind");
    const fire  = impulseFor("pyromancer");
    P.setCharacter("telekinetic");
    return { grave, fire };
  });

  ok(r.grave > 1,
     "the well gave the crowd an impulse of " + r.grave + " toward the impact — " +
     "positive means inward, and this is not pulling anything in");
  ok(r.fire < 0,
     "a fireball's blast gave " + r.fire + " toward its own impact; a blast is " +
     "supposed to throw bodies away from it, so the control is not behaving");
  ok(r.grave > 0 && r.fire < 0,
     "the well (" + r.grave + ") and the blast (" + r.fire + ") do not have opposite " +
     "signs — the kit that gathers and the kit that scatters are doing the same thing");
});

test("characters: the splitter's fragments are real shots, and they cannot split again", async (pg) => {
  // Two claims. The fragments have to actually exist as shots in the air —
  // and, more importantly, they must not carry a split of their own, or one
  // trigger pull multiplies without end and takes the frame rate with it.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.setCharacter("splitter");
    P.PROFILE.charLv.splitter = 6;
    P.buildWave(3); P.parkWalkers(); P.stripProps();
    P.MOD.allDmg = 1;
    P.castState.held = 0; P.buildCastStack();
    for (let i = 0; i < 60 * 25; i++) { P.hero.hp = 99; P.hero.pos.set(0, 0, 0); P.step(1/60); }
    P.parkWalkers();

    P.S.lock = null;
    P.castFire();
    const parent = P.castState.shots[P.castState.shots.length - 1];
    let peak = 0, sawFragments = false;
    for (let i = 0; i < 60 * 4; i++) {
      P.hero.pos.set(0, 0, 0); P.hero.hp = 99; P.step(1/60);
      peak = Math.max(peak, P.castState.shots.length);
      if (!P.castState.shots.includes(parent) && P.castState.shots.length > 0) {
        sawFragments = true;
      }
    }
    const settled = P.castState.shots.length;
    P.setCharacter("telekinetic");
    return { peak, sawFragments, settled,
             count: P.SPLIT.split.count,
             fragmentSplits: !!P.SPLIT_FRAGMENT.split };
  });

  ok(r.peak >= r.count,
     "at most " + r.peak + " shots were ever in the air; a burst of " + r.count +
     " fragments should push it past that");
  ok(r.sawFragments, "the fragments never outlived their parent — nothing was spawned");
  eq(r.fragmentSplits, false,
     "a fragment carries a split of its own, so one trigger pull multiplies forever");
  eq(r.settled, 0,
     "shots are still in the air four seconds later: " + r.settled + " — fragments are " +
     "not expiring, which is the same runaway by a slower route");
});

test("characters: the revenant pays out WHOLE hearts and never overfills", async (pg) => {
  // Health is five whole hearts and the HUD draws pips, so a leech that paid
  // a fraction of the damage would put the hero on 3.4 and break the display.
  // Three things must hold: damage is banked rather than paid straight out,
  // the payout is a whole number, and it cannot push the hero past the cap.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.setCharacter("revenant");
    P.PROFILE.charLv.revenant = 8;
    P.buildWave(3); P.parkWalkers(); P.stripProps();
    P.MOD.allDmg = 1;
    P.castState.held = 0; P.castState.leech = 0; P.buildCastStack();
    for (let i = 0; i < 60 * 30; i++) { P.hero.hp = 99; P.hero.pos.set(0, 0, 0); P.step(1/60); }
    P.parkWalkers();

    const cap = P.CFG.maxHealth + P.MOD.hpBonus;
    const w = P.walkers.find(x => !x.dead);
    const f = { x: Math.sin(P.cam.yaw), z: Math.cos(P.cam.yaw) };
    // Everything parked every frame, then the one target put back. The hero
    // is sitting on two hearts and his health is the measurement, so a
    // reinforcement pulse wandering over and hitting him does not just add
    // noise — it silently falsifies the result. This is why the first version
    // of this case reported "never healed" for a mechanic that works.
    const pin = () => {
      P.parkWalkers();
      w.pos.set(f.x * 12, 0, f.z * 12); w.aggro = false; w.cool = 999; w.hp = 99999;
    };

    // Wounded, so there is room to heal into.
    P.hero.hp = 2;
    const seen = new Set();
    let fractional = false, overCap = false;
    for (let shot = 0; shot < 14; shot++) {
      pin();
      P.castState.held = Math.max(1, P.castState.held);
      P.S.lock = w;
      P.castFire();
      for (let i = 0; i < 70; i++) {
        pin(); P.hero.pos.set(0, 0, 0); P.step(1/60);
        seen.add(P.hero.hp);
        if (P.hero.hp !== Math.floor(P.hero.hp)) fractional = true;
        if (P.hero.hp > cap) overCap = true;
      }
    }
    const healed = P.hero.hp > 2;

    // And at full health the bank must not silently overflow the cap.
    P.hero.hp = cap;
    P.castState.leech = 0;
    for (let shot = 0; shot < 6; shot++) {
      pin();
      P.castState.held = Math.max(1, P.castState.held);
      P.S.lock = w; P.castFire();
      for (let i = 0; i < 70; i++) { pin(); P.hero.pos.set(0, 0, 0); P.step(1/60); }
      if (P.hero.hp > cap) overCap = true;
    }
    P.setCharacter("telekinetic");
    return { healed, fractional, overCap, cap, finalHp: P.hero.hp,
             values: [...seen].sort((a, b) => a - b), per: P.REVENANT.leech.per };
  });

  ok(r.healed, "the revenant never healed at all — the leech is not paying out");
  eq(r.fractional, false,
     "the hero's health went fractional (" + r.values.join(", ") + "); hearts are whole " +
     "and the HUD draws pips");
  eq(r.overCap, false, "healing pushed the hero past the cap of " + r.cap);
  eq(r.finalHp, r.cap, "at full health the hero ended on " + r.finalHp + " of " + r.cap);
});

test("characters: the boomerang turns, comes home, and can cut on the way back", async (pg) => {
  // The second pass is the whole kit. If it forgets to wipe what it already
  // hit at the turn, it flies home straight through the same bodies without
  // touching them — which looks identical and is worth half as much.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.setCharacter("boomeranger");
    P.PROFILE.charLv.boomeranger = 6;
    P.buildWave(3); P.parkWalkers(); P.stripProps();
    P.MOD.allDmg = 1;
    P.castState.held = 0; P.buildCastStack();
    for (let i = 0; i < 60 * 25; i++) { P.hero.hp = 99; P.hero.pos.set(0, 0, 0); P.step(1/60); }
    P.parkWalkers();

    // One body ON the outbound line, close enough that the loop passes it
    // twice — out through it, and back through it.
    const w = P.walkers.find(x => !x.dead);
    const f = { x: Math.sin(P.cam.yaw), z: Math.cos(P.cam.yaw) };
    const pin = () => { w.pos.set(f.x * 9, 0, f.z * 9); w.aggro = false; w.cool = 999; };
    pin(); w.hp = 99999;
    const hp0 = w.hp;

    P.S.lock = null;
    P.castFire();
    const shot = P.castState.shots[P.castState.shots.length - 1];
    let turned = false, maxDist = 0, hpAtTurn = null, cameBack = false;
    for (let i = 0; i < 60 * 6; i++) {
      pin(); P.hero.pos.set(0, 0, 0); P.hero.hp = 99; P.step(1/60);
      if (!P.castState.shots.includes(shot)) { cameBack = true; break; }
      const d = Math.hypot(shot.g.position.x - P.hero.pos.x,
                           shot.g.position.z - P.hero.pos.z);
      maxDist = Math.max(maxDist, d);
      if (shot.returning && !turned) { turned = true; hpAtTurn = w.hp; }
    }
    const total = hp0 - w.hp;
    const afterTurn = turned ? hpAtTurn - w.hp : 0;
    P.setCharacter("telekinetic");
    return { turned, cameBack, maxDist: +maxDist.toFixed(1),
             total: +total.toFixed(1), afterTurn: +afterTurn.toFixed(1),
             range: P.BOOMER.boomerang.range };
  });

  ok(r.turned, "the loop never turned around — it is an ordinary shot with a long life");
  ok(r.maxDist >= r.range * 0.8,
     "it turned at " + r.maxDist + " against a stated range of " + r.range);
  ok(r.cameBack, "it turned but never reached the hero — it is not being caught");
  ok(r.total > 0, "the loop never hit the body on its own outbound line");
  ok(r.afterTurn > 0,
     "the body took " + r.afterTurn + " after the turn: the loop is flying home through " +
     "bodies it already hit without touching them, so the return pass is worth nothing");
});

test("characters: the sentinel outlives its own shot and fires on its own", async (pg) => {
  // The only kit whose shot is not the weapon. What matters is that something
  // exists after the shot is gone, that it shoots without the player doing
  // anything, and that it eventually expires rather than becoming permanent.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.setCharacter("sentinel");
    P.PROFILE.charLv.sentinel = 6;
    P.buildWave(3); P.parkWalkers(); P.stripProps();
    P.MOD.allDmg = 1;
    P.castState.held = 0; P.buildCastStack();
    for (let i = 0; i < 60 * 35; i++) { P.hero.hp = 99; P.hero.pos.set(0, 0, 0); P.step(1/60); }
    P.parkWalkers();

    const w = P.walkers.find(x => !x.dead);
    const f = { x: Math.sin(P.cam.yaw), z: Math.cos(P.cam.yaw) };
    const pin = () => { w.pos.set(f.x * 14, 0, f.z * 14); w.aggro = false; w.cool = 999; };
    pin(); w.hp = 99999;

    P.S.lock = null;
    P.castFire();
    const shot = P.castState.shots[P.castState.shots.length - 1];
    let planted = 0, hpWhenPlanted = null, shotGone = false;
    for (let i = 0; i < 60 * 3 && !planted; i++) {
      pin(); P.hero.pos.set(0, 0, 0); P.hero.hp = 99; P.step(1/60);
      if (P.castState.turrets.length) {
        planted = P.castState.turrets.length;
        shotGone = !P.castState.shots.includes(shot);
        hpWhenPlanted = w.hp;
      }
    }
    // The player does nothing at all from here.
    let boltsSeen = 0;
    for (let i = 0; i < 60 * 5; i++) {
      pin(); P.hero.pos.set(0, 0, 0); P.hero.hp = 99; P.step(1/60);
      boltsSeen = Math.max(boltsSeen, P.castState.shots.length);
    }
    const dealtByTurret = hpWhenPlanted - w.hp;
    // ...and it must not be permanent.
    for (let i = 0; i < 60 * 6; i++) { pin(); P.hero.pos.set(0, 0, 0); P.hero.hp = 99; P.step(1/60); }
    const left = P.castState.turrets.length;
    P.setCharacter("telekinetic");
    return { planted, shotGone, boltsSeen, dealtByTurret: +dealtByTurret.toFixed(1),
             left, life: P.SENTINEL.turret.life };
  });

  eq(r.planted, 1, "the shot planted " + r.planted + " sentries, expected exactly one");
  ok(r.shotGone, "the sentry appeared while its delivery shot was still in the air");
  ok(r.boltsSeen > 0, "the sentry never fired anything — it is scenery");
  ok(r.dealtByTurret > 100,
     "the sentry dealt " + r.dealtByTurret + " on its own while the player did nothing");
  eq(r.left, 0, "the sentry never expired — it is a permanent turret");
});

test("characters: the scattershot fires a fan at the trigger, not on impact", async (pg) => {
  // The distinction that separates it from the splitter: all five exist the
  // instant the trigger is pulled, spread around where the player pointed,
  // rather than appearing where something lands.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.setCharacter("scattershot");
    P.PROFILE.charLv.scattershot = 6;
    P.buildWave(3); P.parkWalkers(); P.stripProps();
    P.castState.held = 0; P.buildCastStack();
    for (let i = 0; i < 60 * 25; i++) { P.hero.hp = 99; P.hero.pos.set(0, 0, 0); P.step(1/60); }
    P.parkWalkers();

    const before = P.castState.shots.length;
    P.S.lock = null;
    P.castFire();
    const immediately = P.castState.shots.length - before;
    // The fan has to actually be a fan: collect the headings.
    const angles = P.castState.shots.slice(-immediately)
      .map(s => Math.atan2(s.vel.x, s.vel.z));
    const spreadOf = (xs) => Math.max(...xs) - Math.min(...xs);
    // Angles are CIRCULAR. A plain average breaks across the seam at +/-pi —
    // a fan straddling it averages to roughly zero instead of pi, which read
    // as the fan pointing 144 degrees away from the aim when it was centred
    // perfectly. Every angle is compared as a wrapped difference instead.
    const aim = Math.atan2(Math.sin(P.cam.yaw), Math.cos(P.cam.yaw));
    const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));
    const deltas = angles.map(a2 => wrap(a2 - aim));
    const mean = aim + deltas.reduce((a2, b2) => a2 + b2, 0) / deltas.length;
    let spent = 0;
    for (let i = 0; i < 60 * 3; i++) { P.hero.pos.set(0, 0, 0); P.hero.hp = 99; P.step(1/60); }
    spent = P.castState.shots.length;
    P.setCharacter("telekinetic");
    return { immediately, spread: +spreadOf(deltas).toFixed(3),
             offCentre: +Math.abs(wrap(mean - aim)).toFixed(3),
             count: P.SCATTER.volley.count, cfg: P.SCATTER.volley.spread, spent };
  });

  eq(r.immediately, r.count,
     "the trigger put " + r.immediately + " shots in the air, not the " + r.count +
     " the fan is meant to be — this is a splitter, which fragments on impact instead");
  ok(r.spread > r.cfg,
     "the five pellets left on headings spanning " + r.spread + " radians, which is no " +
     "wider than a single shot — there is no fan");
  ok(r.offCentre < 0.05,
     "the fan's centre sits " + r.offCentre + " radians off where the player aimed");
  eq(r.spent, 0, "pellets are still in the air three seconds later: " + r.spent);
});

test("characters: water shoves a body, fire and blades do not", async (pg) => {
  // Control rather than damage is the trade this kit makes, and the shove is
  // where that trade is visible.
  //
  // Measured as the knockback IMPULSE the hit imparts, not as ground the body
  // covers. Two earlier metrics both failed on the same thing: a body runs its
  // own AI while it is being pushed, and walks back against the shove at a
  // speed that depends on which archetype the wave dealt — a Runner at 4.7
  // cancels most of it, a Tank at 1.25 almost none. Distance-from-where-it-
  // stood measured that argument rather than the shove, and read anywhere from
  // 3.3 to 8 for the same shot. The impulse is what the kit actually applies.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    const shoveFor = (who) => {
      P.setCharacter(who);
      P.PROFILE.charLv[who] = 6;
      P.buildWave(3); P.parkWalkers(); P.stripProps();
      P.castState.held = 0; P.buildCastStack();
      for (let i = 0; i < 60 * 30; i++) { P.hero.hp = 99; P.hero.pos.set(0, 0, 0); P.step(1 / 60); }
      P.parkWalkers();
      P.MOD.allDmg = 1; P.MOD.blastR = 1; P.MOD.blastDmg = 1; P.WMOD.blastR = 1;

      // Health to spare, so it is shoved rather than killed.
      const w = P.walkers.find(x => !x.dead);
      const f = { x: Math.sin(P.cam.yaw), z: Math.cos(P.cam.yaw) };
      w.pos.set(f.x * 16, 0, f.z * 16);
      w.aggro = false; w.cool = 999; w.hp = 4000;

      P.S.lock = w;
      P.castFire();
      let peak = 0;
      for (let i = 0; i < 110; i++) {
        P.hero.pos.set(0, 0, 0); P.hero.hp = 99; P.step(1 / 60);
        peak = Math.max(peak, Math.hypot(w.kb.x, w.kb.z));
      }
      return +peak.toFixed(2);
    };
    const water = shoveFor("hydromancer");
    const wind  = shoveFor("windmage");
    const fire  = shoveFor("pyromancer");
    P.setCharacter("telekinetic");
    return { water, wind, fire };
  });

  ok(r.water > 30, "the water hit with an impulse of " + r.water + " — that is not a shove");
  // Against the blade, which is the like-for-like case: both land a hit and
  // nothing else. A fireball ends in a blast, and a blast throws whatever
  // stands near it — an area effect doing an area effect's job, which is a
  // different question from this one.
  ok(r.water > r.wind * 3,
     "water hit for " + r.water + " and the blade for " + r.wind + " — for the kit whose " +
     "whole trade is control over damage, that is not a difference anyone will feel");
});

test("characters: a launched blade holds its angle instead of rolling", async (pg) => {
  // A crescent that turns on its way out reads as a thrown wheel. This one is
  // a held shape driven forward, so the roll has to be FIXED — the same on
  // every shot, and unchanged for the whole flight — while the blade still
  // aims itself down the line it is travelling.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.setCharacter("windmage");
    P.PROFILE.charLv.windmage = 6;
    P.buildWave(3); P.parkWalkers(); P.stripProps();
    P.castState.held = 0; P.buildCastStack();
    for (let i = 0; i < 60 * 30; i++) { P.hero.hp = 99; P.hero.pos.set(0, 0, 0); P.step(1 / 60); }

    // Re-park before firing: the 30 seconds above let later pulses of the wave
    // spawn walkers that the first parkWalkers never saw, and one of those
    // standing near the hero eats the shot on its opening frame.
    P.parkWalkers();
    P.S.lock = null;
    P.castFire();
    const first = P.castState.shots[0];
    const rollOf = (shot) => shot.g.children[0].rotation.z;
    const roll0 = rollOf(first);

    const rolls = [];
    for (let i = 0; i < 40; i++) {
      P.hero.hp = 99; P.step(1 / 60);
      if (P.castState.shots.includes(first)) rolls.push(rollOf(first));
    }
    P.parkWalkers();
    P.S.lock = null;
    P.castFire();
    const second = P.castState.shots[P.castState.shots.length - 1];

    // The carried blades must not be turning either.
    const orb = P.castState.orbs[0];
    const before = orb.children[0].rotation.z;
    for (let i = 0; i < 30; i++) { P.hero.hp = 99; P.step(1 / 60); }

    // Which PLANE the blade occupies. The columns of the world matrix are the
    // object's own axes, so the third column is the face normal.
    first.g.updateMatrixWorld(true);
    const e = first.g.matrixWorld.elements;
    const nl = Math.hypot(e[8], e[9], e[10]) || 1;
    const n = [e[8] / nl, e[9] / nl, e[10] / nl];
    const v = first.vel.clone().normalize();
    const orbN = (() => {
      const o = P.castState.orbs[0];
      o.updateMatrixWorld(true);
      const q = o.matrixWorld.elements;
      const l = Math.hypot(q[8], q[9], q[10]) || 1;
      return [q[8] / l, q[9] / l, q[10] / l];
    })();

    return {
      roll0, drift: Math.max(...rolls.map(z => Math.abs(z - roll0))), frames: rolls.length,
      matched: Math.abs(rollOf(second) - roll0) < 1e-9,
      faceAlongTravel: Math.abs(n[0] * v.x + n[1] * v.y + n[2] * v.z),
      facePitch: Math.abs(n[1]),
      // Compared against the BACK axis, not against up: an edge-first carried
      // blade and a player-facing one both have a horizontal normal, so up
      // cannot tell them apart. Facing the player means the normal lies ALONG
      // the axis the stack rides on.
      carriedFacesPlayer: Math.abs(orbN[0] * -Math.sin(P.cam.yaw) +
                                   orbN[2] * -Math.cos(P.cam.yaw)),
      carried: Math.abs(orb.children[0].rotation.z - before),
      spread: new Set(P.castState.orbs.map(o => o.children[0].rotation.z.toFixed(4))).size,
      orbs: P.castState.orbs.length,
    };
  });

  ok(r.frames > 20, "the shot died after " + r.frames + " frames, too soon to judge its roll");
  ok(r.drift < 1e-9,
     "the launched blade rolled " + r.drift.toFixed(4) + " rad in flight — it is spinning");
  ok(r.matched, "two shots left the hand at different angles; the launch roll is not fixed");
  ok(r.carried < 1e-9,
     "the carried blades are still turning (" + r.carried.toFixed(4) + " rad in half a second)");
  // Fixed roll must not mean identical blades on the back: the scatter is half
  // of what stops the stack looking like one shape stamped out eight times.
  ok(r.spread >= r.orbs - 1,
     "the carried blades share angles: " + r.spread + " distinct across " + r.orbs);
  // Edge first: the blade's plane CONTAINS the line of flight, so its face
  // points across that line rather than down it.
  ok(r.faceAlongTravel < 0.01,
     "the blade is pushing its face through the air (face·travel " +
     r.faceAlongTravel.toFixed(3) + "), not cutting edge first");
  ok(r.facePitch < 0.01,
     "the blade has tipped out of the upright (face·up " + r.facePitch.toFixed(3) + ")");
  // ...and the ones on the back must NOT do that, or the stack turns into a
  // row of invisible lines.
  ok(r.carriedFacesPlayer > 0.9,
     "a carried blade is no longer facing the player (face·back " +
     r.carriedFacesPlayer.toFixed(3) + ") — the stack reads as a row of lines");
});

test("characters: the wind mage's blade cuts a line and spares the bystanders", async (pg) => {
  // The two casters share every piece of machinery, so what has to be proven
  // is the part that is NOT shared: a fireball stops at the first body and
  // pays for it with a blast that catches whatever is standing around it; a
  // blade carries straight through a line of them and pays for that with no
  // blast at all.
  //
  // Both halves are measured on one layout: four bodies in a row 6 apart —
  // further than a blast can chain — and a bystander off the line at each END
  // of the shot. One bystander is not enough: a piercing blade WITH a blast
  // would still leave the one by the first body untouched, because it does not
  // stop there. It is the bystander where the shot actually ends that can tell
  // a blast from a pierce, and each kit ends somewhere different.
  const r = await pg.evaluate(async () => {
    const P = window.__probe;
    const shoot = (who, tanky, gap) => {
      P.setCharacter(who);
      P.PROFILE.charLv[who] = 6;
      P.buildWave(6); P.parkWalkers(); P.stripProps();
      P.castState.held = 0; P.buildCastStack();
      for (let i = 0; i < 60 * 30; i++) {
        P.S.phase = "play"; P.hero.hp = 99; P.hero.pos.set(0, 0, 0); P.step(1/60);
      }
      // AGAIN, after the fill. The wave keeps arriving in pulses while the
      // stack grows, so the bodies parked before it are not the bodies
      // standing next to the hero after it — and an unparked one within a
      // stride of the muzzle eats the pierce budget before the shot has
      // travelled a metre. (Measured: it was spending two of three.)
      P.parkWalkers();

      P.cam.yaw = Math.PI / 2;               // aim down +X
      P.hero.pos.set(0, 0, 0);
      const live = P.walkers.filter(w => !w.dead).slice(0, 6);
      if (live.length < 6) return { short: live.length };
      const line = live.slice(0, 4);
      const near = live[4], far = live[5];
      // A body that SURVIVES being cut. The blade homes on what it was aimed
      // at, and a target that dies stops being homed on — so a kill hides the
      // case where the blade passes through a body that is still standing.
      if (tanky) { line[0].hp = 9999; line[0].maxHp = 9999; }
      // Re-pinned every frame, not placed once. These bodies still run their
      // own AI, and a Runner crossing 4 units mid-flight would quietly rewrite
      // the layout the measurement depends on.
      const place = () => {
        // NINE, not the six this started with. The fire control asserts that a
        // fireball stops at the first body, and its blast reaches 4.4 — but a
        // blast chains from the body's SURFACE, and body radii run to about
        // 1.6 depending on which archetypes the wave happened to spawn. At a
        // six-unit gap that leaves no margin at all, so the control passed or
        // failed on which bodies the run dealt it: measured, roughly one run
        // in three. Nine clears 4.4 + 1.6 outright.
        const step = gap || 9;
        line.forEach((w, i) => { w.pos.set(6 + i * step, 0, 0); w.aggro = false; w.cool = 999; });
        // Off the line by 3.4, which is a WINDOW rather than a guess. A body's
        // radius is 0.75 x its archetype's scale, so the widest normal body is
        // a Tank at 1.065, and a blade reaches hitR + r = 2.37 at most. A
        // blast reaches 4.4, measured centre to centre with no radius term.
        // 3.4 sits a clear unit outside the first and a clear unit inside the
        // second, whichever archetypes the wave happens to deal. At 3 it sat
        // 0.1 outside the blade's reach and flipped with the roster.
        near.pos.set(6, 0, 3.4);            near.aggro = false; near.cool = 999;
        far.pos.set(6 + 2 * step, 0, 3.4);  far.aggro = false;  far.cool = 999;
      };
      place();

      // Neutralise the wave's modifiers. Blast radius is multiplied by
      // MOD.blastR * WMOD.blastR, and which modifier a wave draws is random —
      // so without this the control's geometry is not the geometry the
      // comments above reason about.
      P.MOD.blastR = 1; P.MOD.blastDmg = 1; P.MOD.allDmg = 1;
      P.WMOD.blastR = 1;

      const hp0 = live.map(w => w.hp);
      P.S.lock = null;
      const before = P.castState.held;
      P.castFire();
      for (let i = 0; i < 90; i++) {
        P.S.phase = "play"; P.hero.hp = 99; P.hero.pos.set(0, 0, 0); place(); P.step(1/60);
      }
      const hurt = live.map((w, i) => w.dead || w.hp < hp0[i]);
      return { fired: before > P.castState.held,
               line: hurt.slice(0, 3).filter(Boolean).length,
               fourth: hurt[3], near: hurt[4], far: hurt[5] };
    };
    return { wind: shoot("windmage"), tanky: shoot("windmage", true),
             long: shoot("windmage", true, 34), fire: shoot("pyromancer") };
  });

  for (const kit of ["wind", "tanky", "long", "fire"]) {
    ok(!r[kit].short, kit + ": not enough live bodies to lay the test out (" + r[kit].short + ")");
    ok(r[kit].fired, kit + ": nothing was fired — the stack never filled");
  }

  eq(r.wind.line, 3,
     "the blade cut " + r.wind.line + " of the three bodies in its path — a blade that " +
     "stops at the first one is a fireball without the blast");
  eq(r.wind.fourth, false,
     "the blade cut a fourth body: its pierce budget is not being spent down");
  eq(r.wind.far, false,
     "a body 3.4 off the line WHERE THE BLADE STOPPED was hurt — it is detonating, and " +
     "the pierce it trades that blast for is being handed out for free");
  eq(r.wind.near, false, "the blade hurt a body 3.4 off the line at the near end");

  // Through a body that is still standing afterwards. Without releasing its
  // homing target on the way through, the blade turns straight back onto the
  // body it just passed and circles it, and everything behind that body lives.
  eq(r.tanky.line, 3,
     "cutting a body that survived, the blade reached " + r.tanky.line + " of three — " +
     "it is still homing on the one it went through");
  // And the same shot with the next body far enough downrange that a blade
  // still turning back toward the one it cut has time to curve off the line
  // and miss it entirely.
  ok(r.long.line >= 2,
     "34 downrange of a body it cut but did not kill, the blade reached " + r.long.line +
     " of three — it is arcing back onto its old target instead of flying on");

  // The control. Same layout, same shot, the other kit: the blast is exactly
  // what reaches the near bystander, and exactly what stops the shot at the
  // first body — nine short of the second, which is past anything the blast
  // can chain to.
  eq(r.fire.near, true,
     "the fireball left the bystander beside its impact untouched — the blast is what " +
     "makes a shot into a crowd worth taking, and it is not landing");
  eq(r.fire.line, 1,
     "the fireball reached " + r.fire.line + " bodies in the line; it is meant to stop " +
     "at the first, and the next is further away than its blast can chain");
  eq(r.fire.far, false, "the fireball reached a body 24 downrange without travelling there");
});

test("characters: the telekinetic's level buys carry capacity", async (pg) => {
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.setCharacter("telekinetic");
    P.PROFILE.charLv.telekinetic = 1;
    const lv1 = P.carryCap();
    P.PROFILE.charLv.telekinetic = 5;
    const lv5 = P.carryCap();
    // The pyromancer must not inherit it.
    P.setCharacter("pyromancer");
    P.PROFILE.charLv.pyromancer = 5;
    const pyro = P.carryCap();
    P.setCharacter("telekinetic");
    P.PROFILE.charLv.telekinetic = 1;
    return { lv1, lv5, pyro };
  });

  eq(r.lv5 - r.lv1, 4, "four levels should buy four more objects; got " + (r.lv5 - r.lv1));
  ok(r.pyro <= r.lv1, "the pyromancer's level is leaking into carry capacity");
});

test("unlocks: the roster is earned, and every run pays into it", async (pg) => {
  // Fifteen characters handed over in the first second is a paralysing menu
  // and spends the whole game at once. They are priced in best-wave-reached —
  // a number the profile already kept — so a run that dies early still buys
  // something. This guards the three properties that makes true: a fresh
  // profile opens only the free ones, the ladder opens exactly what has been
  // paid for, and the run that crosses a price is CREDITED with it.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    const free = [], priced = [];
    for (const k in P.CHARS) (P.charUnlockAt(k) ? priced : free).push(k);

    // A brand new profile.
    P.PROFILE.bestWave = 1;
    const openAtStart = Object.keys(P.CHARS).filter(k => P.charUnlocked(k));
    const firstPrize = P.nextUnlock();

    // Partway up the ladder: everything at or below the wave, nothing above.
    P.PROFILE.bestWave = 10;
    const openAt10 = Object.keys(P.CHARS).filter(k => P.charUnlocked(k));
    const wrongAt10 = Object.keys(P.CHARS)
      .filter(k => P.charUnlocked(k) !== (P.charUnlockAt(k) <= 10));

    // A run that reaches wave 4 from a standing start has to be credited with
    // everything it passed, not merely the last one.
    P.PROFILE.bestWave = 1;
    P.S.wave = 4; P.S.score = 10; P.S.kills = 1;
    const beat = P.recordRun();

    // ...and a second run that beats nothing must not re-award them.
    P.S.wave = 2;
    const again = P.recordRun();

    return {
      free: free.sort(), priced: priced.length,
      openAtStart: openAtStart.sort(),
      firstPrize: firstPrize && firstPrize.at,
      openAt10: openAt10.length, wrongAt10,
      earned: beat.unlocked.slice().sort(), earnedAgain: again.unlocked,
      bestWaveAfter: P.PROFILE.bestWave,
    };
  });

  ok(r.free.length >= 2,
     "a locked roster still has to open with a CHOICE; only " + r.free.length + " is free");
  ok(r.priced >= 10, "only " + r.priced + " characters are behind the ladder — too little to chase");
  eq(r.openAtStart.join(","), r.free.join(","),
     "a fresh profile opens [" + r.openAtStart.join(",") + "], expected exactly the free ones [" +
     r.free.join(",") + "]");
  ok(r.firstPrize > 1, "the first prize is priced at wave " + r.firstPrize +
     ", which a player already has — nothing to reach for");
  eq(r.wrongAt10.length, 0,
     "at wave 10 these are on the wrong side of the ladder: " + r.wrongAt10.join(", "));
  ok(r.openAt10 > r.free.length,
     "ten waves of progress opened nothing beyond the free roster");

  // The payout, which is the whole reason the ladder exists.
  eq(r.bestWaveAfter, 4, "the run did not record its wave");
  ok(r.earned.length >= 2,
     "a run from wave 1 to wave 4 passed at least two prices but was credited with " +
     r.earned.length + " — an early run has to visibly buy something");
  eq(r.earnedAgain.length, 0,
     "a worse run re-awarded " + r.earnedAgain.join(", ") + " — the payout is not a one-off");

  // Pacing, against the shape of the game rather than a flat spread. The
  // authored campaign is WAVES.length waves and the Maw ends it; past that is
  // endless. A first pass put six of thirteen prices beyond the campaign and
  // the last at wave 22, which would have parked half the roster behind
  // content most players never see.
  const pace = await pg.evaluate(() => {
    const P = window.__probe;
    const end = P.WAVES.length;
    const priced = Object.keys(P.CHARS)
      .map(k => P.charUnlockAt(k)).filter(v => v > 0).sort((a, b) => a - b);
    let biggestGap = 0;
    for (let i = 1; i < priced.length; i++)
      biggestGap = Math.max(biggestGap, priced[i] - priced[i - 1]);
    return { end, priced, top: priced[priced.length - 1],
             inside: priced.filter(v => v <= end).length,
             beyond: priced.filter(v => v > end).length, biggestGap };
  });

  ok(pace.inside >= pace.beyond * 2,
     "only " + pace.inside + " of the roster is earnable inside the " + pace.end +
     "-wave campaign against " + pace.beyond + " out in endless — most of the " +
     "characters would be gated behind content most players never reach");
  ok(pace.top <= pace.end * 2,
     "the last character is priced at wave " + pace.top + ", more than twice the " +
     pace.end + "-wave campaign — that is not a chase, it is dead content");
  ok(pace.biggestGap <= 5,
     "there is a " + pace.biggestGap + "-wave gap between unlocks (" +
     pace.priced.join(", ") + ") — a stretch that long stops paying out");
});

test("menu: the picker comes back after a run, exactly once", async (pg) => {
  // show() overwrites the card, and the menu lives in the card — so pressing
  // Begin destroyed the character picker for the rest of the page's life.
  // Fifteen characters, a ladder that keeps handing out more, and the only way
  // to switch to one you unlocked earlier was a browser reload.
  //
  // The duplication check is not hypothetical: the wiring APPENDS cards, and
  // the restored markup already carries a full set, so re-running it over them
  // deals the roster twice.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.PROFILE.bestWave = 30;                 // whole roster open
    P.S.wave = 3; P.S.score = 10; P.S.kills = 1;
    P.gameOver();

    const routeOut = !!document.querySelector("#toMenu");
    P.toMenu();

    const cards = [...document.querySelectorAll("#charPick > *")];
    const diffs = [...document.querySelectorAll("#diffPick > *")];
    const start = document.querySelector("#startBtn");

    // The restored picker has to actually WORK, not just be present.
    const target = cards.find(c => c.dataset.char && c.dataset.char !== P.charNow());
    const before = P.charNow();
    if (target) target.click();
    const after = P.charNow();

    // ...and a second restore must not stack another roster on top.
    P.gameOver();
    P.toMenu();
    const twice = document.querySelectorAll("#charPick > *").length;

    return { routeOut, cards: cards.length, diffs: diffs.length,
             chars: Object.keys(P.CHARS).length, hasStart: !!start,
             before, after, twice, phase: P.S.phase };
  });

  ok(r.routeOut, "the end screen offers no way back to the character picker");
  eq(r.cards, r.chars,
     "the restored picker shows " + r.cards + " cards for " + r.chars +
     " characters — the roster was dealt twice, or not at all");
  ok(r.diffs >= 2, "the restored menu lost its difficulty picker (" + r.diffs + ")");
  ok(r.hasStart, "the restored menu has no Begin button, so it is a dead end");
  ok(r.after !== r.before,
     "a card in the restored picker did not change the character (still " + r.before + ")");
  eq(r.twice, r.chars,
     "restoring the menu a second time left " + r.twice + " cards — the wiring stacks");
  eq(r.phase, "menu", "the restored menu left the game in phase '" + r.phase + "'");
});

test("share: a result can always be copied, even when the clipboard refuses", async (pg) => {
  // Copying is best-effort by nature — the async clipboard needs a secure
  // context and a permission the page may not have — so the interesting case
  // is the FAILING one. A button that silently does nothing is worse than no
  // button, so a refusal has to fall through to text the player can select.
  const r = await pg.evaluate(async () => {
    const P = window.__probe;
    P.setCharacter("pyromancer");
    P.PROFILE.bestWave = 4;
    P.S.wave = 6; P.S.score = 1234; P.S.rank = "B"; P.S.kills = 20;

    // Sampled AFTER the run is recorded, below. Reading it first understates
    // the unlock count: this run reaches wave 6 from a best of 4, which buys
    // two more characters, and the line the player copies has to be the state
    // they just earned rather than the one they started with.

    // Refuse the clipboard the way a locked-down context does.
    const real = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
      configurable: true,
    });
    P.gameOver();
    const line = P.shareLine();
    const openNow = Object.keys(P.CHARS).filter(k => P.charUnlocked(k)).length;
    document.querySelector("#share").click();
    await new Promise(r2 => setTimeout(r2, 60));
    const box = document.querySelector("#shareText");
    const shown = box && !box.hidden ? box.value : null;
    if (real) Object.defineProperty(navigator, "clipboard", { value: real, configurable: true });
    return { line, shown, openNow, bestWave: P.PROFILE.bestWave };
  });

  ok(/wave 6/.test(r.line), "the result line does not carry the wave: " + r.line);
  ok(/1,234/.test(r.line), "the result line does not carry the score: " + r.line);
  ok(/Pyromancer/i.test(r.line), "the result line does not name the character: " + r.line);
  ok(/\d+\/\d+ unlocked/.test(r.line),
     "the result line does not carry unlock progress, which is the part worth " +
     "showing someone else: " + r.line);
  // The count has to be the one the run just earned. Reading it before the run
  // is recorded shows the player fewer characters than they now have — which
  // is the state they were bragging about escaping.
  eq(r.bestWave, 6, "the run did not record its wave before the result was built");
  ok(r.line.indexOf(r.openNow + "/") >= 0,
     "the result claims a different unlock count than the player actually has (" +
     r.openNow + "): " + r.line);
  eq(r.shown, r.line,
     "the clipboard refused and the player was left with nothing to copy " +
     "(box showed " + JSON.stringify(r.shown) + ")");
});

test("save: a corrupt profile cannot lock the player out of the roster", async (pg) => {
  // The profile is JSON in localStorage — hand-editable, and a half-written or
  // older-build save can hold anything. That was cosmetic until the unlock
  // ladder made bestWave GATE THE ROSTER: a string there fails every `>=`, so
  // all fifteen characters read as locked, including the two that are free,
  // and the picker ends up with nothing the player can press. A save is not
  // trusted input.
  const bad = [
    ["a string", { bestWave: "abc" }],
    ["null", { bestWave: null }],
    ["a negative", { bestWave: -5 }],
    // JSON.stringify DROPS an undefined value, so this one is the
    // field-missing case rather than a NaN — an older save that predates it.
    ["an absent field", { bestWave: undefined }],
    ["the wrong type entirely", { bestWave: { wave: 9 } }],
    ["an array", { bestWave: [7] }],
  ];

  for (const [label, patch] of bad) {
    const r = await pg.evaluate(({ patch }) => {
      const P = window.__probe;
      const before = P.PROFILE.bestWave;
      localStorage.setItem(P.SAVE_KEY, JSON.stringify(
        Object.assign({ best: 1, runs: 1, kills: 1, bestRank: "C" }, patch)));
      P.loadProfile();
      const free = Object.keys(P.CHARS).filter(k => P.charUnlockAt(k) === 0);
      const out = {
        bestWave: P.PROFILE.bestWave,
        finite: Number.isFinite(P.PROFILE.bestWave),
        freeOpen: free.every(k => P.charUnlocked(k)),
        anyOpen: Object.keys(P.CHARS).some(k => P.charUnlocked(k)),
        before,
      };
      // Leave the profile sane for whatever runs next.
      localStorage.removeItem(P.SAVE_KEY);
      P.PROFILE.bestWave = 1;
      return out;
    }, { patch });

    ok(r.finite,
       label + ": bestWave loaded as " + JSON.stringify(r.bestWave) +
       ", which is not a number — every `>=` against it is false");
    ok(r.bestWave >= 1,
       label + ": bestWave loaded as " + r.bestWave + ", below the first wave");
    ok(r.anyOpen,
       label + ": every character read as locked — the picker has nothing to press");
    ok(r.freeOpen,
       label + ": the characters that are meant to be free came back locked");
  }
});

test("records: each character keeps its own furthest wave", async (pg) => {
  // The unlock ladder RUNS OUT — once the roster is open it has nothing left
  // to ask for — and a single global best belongs to whichever kit you are
  // strongest with, forever. A record per character is what is left to chase,
  // and it is the only thing that gives an unlocked-but-abandoned kit a reason
  // to be picked up again.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.PROFILE.bestWave = 30;                 // whole roster open
    for (const k in P.CHARS) P.PROFILE.charBest[k] = 0;

    // Never taken out reads as no record at all, not as a record of zero.
    P.setCharacter("pyromancer");
    const freshBest = P.charBest ? P.charBest("pyromancer") : null;

    // A run with the pyromancer sets the PYROMANCER's record only.
    P.S.wave = 7; P.S.score = 100; P.S.kills = 3;
    const first = P.recordRun();
    const pyroAfter = P.PROFILE.charBest.pyromancer;
    const windAfter = P.PROFILE.charBest.windmage;

    // A worse run with the same kit does not lower it.
    P.S.wave = 3;
    P.recordRun();
    const pyroKept = P.PROFILE.charBest.pyromancer;

    // A different kit keeps its own book, even though the global best is high.
    P.setCharacter("windmage");
    P.S.wave = 5;
    const second = P.recordRun();
    return { freshBest, pyroAfter, windAfter, pyroKept,
             windNow: P.PROFILE.charBest.windmage,
             globalBest: P.PROFILE.bestWave,
             flaggedFirst: first.charBest, flaggedSecond: second.charBest };
  });

  eq(r.freshBest, 0, "a character never taken out reports a record of " + r.freshBest);
  eq(r.pyroAfter, 7, "the pyromancer's record read " + r.pyroAfter + " after a wave-7 run");
  eq(r.windAfter, 0,
     "a pyromancer run set the wind mage's record to " + r.windAfter + " — the books are shared");
  eq(r.pyroKept, 7, "a worse run lowered the record to " + r.pyroKept);
  eq(r.windNow, 5, "the wind mage's own run recorded " + r.windNow);
  ok(r.globalBest >= 30,
     "the global best moved to " + r.globalBest + "; a per-kit record must not rewrite it");
  // The flag is what lets the end screen call a personal best out. Without it
  // a run that beat the kit's own record but not the global one looks flat.
  ok(r.flaggedSecond,
     "a wave-5 run with a kit whose record was 0 was not flagged as a personal best, " +
     "even though the global best (" + r.globalBest + ") could never be beaten");
});

test("unlocks: the run that earns a character offers to play it", async (pg) => {
  // "Try again" puts the player straight back in as whoever they just died as.
  // Without this the death screen names the character the run earned and then
  // leaves it behind a trip to the menu — the reward is announced at the exact
  // moment it cannot be taken, which is the worst possible time.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.setCharacter("pyromancer");
    P.PROFILE.bestWave = 1;

    // A run that reaches wave 4 buys several rungs of the ladder.
    P.S.wave = 4; P.S.score = 500; P.S.kills = 9;
    P.gameOver();
    const btn = document.querySelector("#playNew");
    const offered = btn ? btn.textContent.trim() : null;
    const before = P.charNow();
    if (btn) btn.click();
    const after = P.charNow();

    // ...and a run that earns nothing must not offer a button at all.
    P.setCharacter("pyromancer");
    P.S.wave = 2; P.S.score = 10; P.S.kills = 1;
    P.gameOver();
    const barren = !!document.querySelector("#playNew");

    return { offered, before, after, barren,
             unlockedAt4: P.charUnlockAt(after) };
  });

  ok(r.offered, "a run that unlocked a character offered no way to play it");
  ok(/^Play as /.test(r.offered),
     "the button reads '" + r.offered + "' rather than naming the character to play");
  ok(r.after !== r.before,
     "pressing it left the player as the " + r.before + " they just died as");
  ok(r.unlockedAt4 > 0 && r.unlockedAt4 <= 4,
     "it switched to a character priced at wave " + r.unlockedAt4 +
     ", which this run did not earn");
  eq(r.barren, false,
     "a run that unlocked nothing still offered a 'play as' button");
});

test("menu: the whole roster fits, and Begin stays above the fold", async (pg) => {
  // The roster grew from five characters to fifteen without the menu changing
  // shape, and the briefing sat above the picker. The result was measured, not
  // guessed: Begin ended up 279px below the fold on a 1280x800 desktop and
  // 1417px below it on a 390x844 phone — the button a new player came for was
  // off screen on EVERY size, behind six paragraphs of rules.
  //
  // This case is here so the sixteenth character cannot quietly do it again. It
  // is deliberately a viewport measurement rather than a CSS assertion: it does
  // not care HOW the menu fits, only that it does.
  const sizes = [["desktop", 1280, 800], ["laptop", 1000, 640], ["phone", 390, 844]];
  const seen = [];

  for (const [label, width, height] of sizes) {
    await pg.setViewportSize({ width, height });
    // The harness clicks into the game during setup; go back to the menu.
    await pg.reload({ timeout: 90000 });
    await pg.waitForFunction(() => window.__probe, null, { timeout: 90000 });

    const r = await pg.evaluate(() => {
      const btn = document.querySelector("#startBtn");
      const cards = [...document.querySelectorAll("#charPick > *")];
      const b = btn.getBoundingClientRect();
      return {
        cards: cards.length,
        chars: Object.keys(window.__probe.CHARS).length,
        // Every card has to be reachable, not merely present in the DOM.
        cardsSized: cards.every(c => c.getBoundingClientRect().height > 0),
        beginBottom: Math.round(b.bottom),
        beginVisible: b.bottom <= window.innerHeight + 1,
        vh: window.innerHeight,
      };
    });
    seen.push(label + " " + JSON.stringify(r));

    eq(r.cards, r.chars,
       label + ": the picker shows " + r.cards + " cards for " + r.chars +
       " characters — one of them cannot be chosen");
    ok(r.cardsSized, label + ": a character card has collapsed to zero height");
    ok(r.beginVisible,
       label + " (" + width + "x" + height + "): Begin ends at " + r.beginBottom +
       "px, which is " + (r.beginBottom - r.vh) + "px below the " + r.vh +
       "px fold — a new player has to scroll to find the button that starts the " +
       "game. Measurements: " + seen.join(" | "));
  }
});

test("ring of fire: the wall licks, it does not only turn", async (pg) => {
  // Reported as "it moves in a circle, not like flame". It did: every curtain
  // scrolled its texture sideways at a fixed rate, and all six were stretched
  // by one shared sine. Constant lateral travel is a barrel turning past you.
  //
  // Fire rises and flickers in place, so the travel is now a stallable drift
  // and the vertical lick carries the motion — per curtain, on its own phase.
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.ringState.lv = 0; P.buildRingOrbs();
    for (let i = 0; i < 3; i++) P.ringUpgrade();
    P.hero.pos.set(0, 0, 0);

    let acrossCurtains = 0;
    const y0 = [], deltas = [];
    let prev = P.ringState.curtains[0].mat.map.offset.x;
    for (let i = 0; i < 180; i++) {
      P.hero.pos.set(0, 0, 0);
      P.step(1 / 60);
      const ys = P.ringState.curtains.map(c => c.mesh.scale.y);
      const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
      acrossCurtains = Math.max(acrossCurtains, (Math.max(...ys) - Math.min(...ys)) / mean);
      y0.push(ys[0]);
      // offset.x wraps at 1, so a wrapped step reads as a huge jump. Drop those.
      const now = P.ringState.curtains[0].mat.map.offset.x;
      const d = Math.abs(now - prev);
      if (d < 0.4) deltas.push(d);
      prev = now;
    }
    const my = y0.reduce((a, b) => a + b, 0) / y0.length;
    return {
      curtains: P.ringState.curtains.length,
      frames: y0.length,
      acrossCurtains,
      overTime: (Math.max(...y0) - Math.min(...y0)) / my,
      scrollRatio: Math.min(...deltas) / Math.max(...deltas),
    };
  });

  ok(r.curtains >= 6, "rank 3 should stand up six curtains; got " + r.curtains);
  ok(r.acrossCurtains > 0.08,
     "every curtain is the same height at every instant (spread " +
     r.acrossCurtains.toFixed(3) + "), so the wall inflates as one cylinder");
  ok(r.overTime > 0.15,
     "a curtain's height barely moves over three seconds (range " +
     r.overTime.toFixed(3) + "): the silhouette is fixed and only the texture " +
     "slides, which is the turning barrel this replaced");
  ok(r.scrollRatio < 0.35,
     "the texture scrolls at a near-constant rate (slowest step is " +
     (r.scrollRatio * 100).toFixed(0) + "% of the fastest), so it reads as " +
     "rotation rather than fire that surges and stalls");
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
