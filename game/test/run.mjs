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
  const r = await pg.evaluate(() => {
    const P = window.__probe, out = {};
    for (let n = 3; n <= 8; n++) { P.buildWave(n); out[n] = P.counts().archer || 0; }
    return out;
  });
  for (const n of Object.keys(r))
    ok(r[n] > 0, `wave ${n} contains no archer (an archetype nobody meets is not in the game)`);
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

test("boss: the Gorger closes, slams and throws", async (pg) => {
  const r = await pg.evaluate(() => {
    const P = window.__probe;
    P.parkWalkers();
    P.spawnMaw(P.hero.pos.x, P.hero.pos.z - 26);
    const b = P.walkers[P.walkers.length - 1];
    const d0 = Math.hypot(b.pos.x - P.hero.pos.x, b.pos.z - P.hero.pos.z);
    let minD = d0, shocks = 0, thrown = 0;
    for (let t = 0; t < 40; t += 1 / 30) {
      P.hero.hp = 99;
      const before = P.shocks.length;
      P.step(1 / 30);
      if (P.shocks.length > before) shocks++;
      minD = Math.min(minD, Math.hypot(b.pos.x - P.hero.pos.x, b.pos.z - P.hero.pos.z));
      thrown = Math.max(thrown, P.rocks.filter(o => o.hostile).length);
    }
    return { closed: d0 - minD, shocks, thrown, legs: !!b.lL, arms: !!b.aL };
  });
  ok(r.closed > 5, `the boss barely moved (closed ${r.closed.toFixed(1)} units in 40s)`);
  ok(r.shocks > 0, "the boss never slammed");
  ok(r.arms && r.legs, "the boss rig lost its limb slots, so the shared gait cannot drive it");
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

test("bosses: every boss survives being animated", async (pg, errs) => {
  // The other boss cases all poke damageWalker directly and never run a frame,
  // which is how two of the three shipped unable to animate at all: the shared
  // walker gait poses lL/lR/aL/aR unconditionally, THE CHOIR has neither legs
  // nor arms and THE HOLLOW has legs but no arms, so both threw on their first
  // frame and took the whole animation loop down with them. Wave 20 was
  // unplayable and nothing in the suite noticed, because nothing stepped.
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

test("wounds: skin darkens as health drops, bosses excluded", async (pg) => {
  const r = await pg.evaluate(async () => {
    const P = window.__probe;
    P.parkWalkers();
    P.spawnWalker("walker", P.hero.pos.x + 6, P.hero.pos.z);
    const w = P.walkers[P.walkers.length - 1];
    const read = async f => {
      w.hp = w.maxHp * f;
      await new Promise(r => setTimeout(r, 180));
      return { hex: w.skinM.color.getHexString(), glow: w.skinM.emissiveIntensity };
    };
    const full = await read(1.0), hurt = await read(0.12);
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
