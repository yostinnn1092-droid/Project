// Test probe. Injected INSIDE the game's IIFE by build.mjs when it is run with
// the `probe` argument, which is the only way to reach module-private state
// without exporting it from the shipped file. Never present in a normal build —
// the suite asserts that separately.
window.__probe = {
  // state
  S, CFG, RING, ringState, MAW, ENEMIES, UPGRADES, OBJECTS, WAVES,
  hero, walkers, rocks, arrows, shocks, taken, renderer, camera, scene, cam,
  spawnQ, obstacles,

  // systems under test
  step, buildWave, spawnWalker, spawnMaw, damageWalker, restart, hurtHero, spawnObject,
  ringUpgrade, buildRingOrbs, stepRing, walkerHeading, auras, updateAuras,
  CHARS, PROFILE, PYRO, WIND, castState, setCharacter, charLevel, castCap,
  castFire, buildCastStack, levelCharacter, carryCap, isCaster, castSpec,
  charNow() { return CHAR.key; },
  CROWN, CROWN_Y, crownState, crownUpgrade, buildCrown, stepCrown,
  judgeFrame, setQuality,

  // observers
  qualityNow() { return quality; },
  qReset(t) { qStartedAt = t; fpsT0 = t; fpsFrames = 0; qBadRuns = 0; qGoodRuns = 0; },

  // ── helpers the suite leans on ────────────────────────────────────────────

  // Clear the field WITHOUT killing anything. Killing empties the wave, which
  // trips the wave-clear overlay and changes phase — every test that did this
  // by hand ended up measuring the draft screen instead of the game.
  parkWalkers() {
    for (const w of walkers) { w.pos.set(400, 0, 400); w.aggro = false; w.cool = 999; }
  },

  // Strip every environmental damage source. Barrels, chem and rolling props
  // kill zombies on their own; any test attributing kills to a specific system
  // has to remove them first or it is measuring the arena.
  stripProps() { for (const o of rocks) o.gone = true; },

  // Drive the simulation without waiting on the renderer. Software GL runs at
  // a few frames a second here, so wall-clock waits measure the test machine
  // rather than the game.
  run(seconds, h) {
    const dt = h || 1 / 60;
    for (let t = 0; t < seconds; t += dt) step(dt);
  },

  counts() {
    const c = {};
    for (const w of walkers) if (!w.dead) c[w.type] = (c[w.type] || 0) + 1;
    return c;
  },

  // The WHOLE wave, opening group plus everything still queued to arrive in a
  // later pulse. counts() alone sees only what is standing on the field the
  // instant the wave is built, which is ~60% of it — asking "does wave 3 have
  // an archer" with counts() is a coin flip, because only bosses are lifted
  // out of the shuffle into the opening group.
  roster() {
    const c = this.counts();
    for (const p of spawnQ) for (const t of p.types) c[t] = (c[t] || 0) + 1;
    return c;
  },
};
