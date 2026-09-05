// The world: who is in it, and the single tick that advances everything.
const world = {
  time: 0,
  actors: [],
  player: null,
  packs: [],
  seed: 20260905 >>> 0,
  committed: new Set(),

  /**
   * Ask permission to commit to an attack. Self-pruning rather than requiring
   * every exit to release: there are six ways out of an attack — it lands, it
   * misses, the wolf is staggered, it routs, it is subdued, it dies — and a
   * token system that leaks one of them locks the whole pack up forever, in a
   * way that looks exactly like the AI having quietly stopped working.
   */
  claimCommit(actor) {
    for (const holder of this.committed) {
      const busy = holder.state === WolfState.Telegraph || holder.state === WolfState.Lunge;
      if (!busy || holder.health.dead || holder.subdue?.isDown) this.committed.delete(holder);
    }
    if (this.committed.has(actor)) return true;
    if (this.committed.size >= CFG.wolf.maxCommitting) return false;
    this.committed.add(actor);
    return true;
  },
  // Seeded, so a wolf's circling is reproducible between runs. A test that
  // measures a telegraph cannot afford the AI to wander differently each time.
  rnd() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  },
};

function spawnWorld() {
  const player = new Player(0, 0);
  world.player = player;
  world.actors.push(player);
  scene.add(player.mesh);

  // A dummy that cannot fight back, seven metres ahead. It is the first thing
  // you see on purpose: it isolates what a SWING feels like from what a FIGHT
  // feels like, and those are two different questions that get confused when
  // you only ever meet them together.
  const dummy = new Actor({
    x: CFG.world.dummyAt[0], z: CFG.world.dummyAt[1],
    radius: 0.42, health: 999999, poise: 999999, team: 'monster',
  });
  dummy.mesh = buildDummyMesh();
  // No knockback: an anvil that does not move is the better instrument, and a
  // dummy that slides away is one you spend the fight chasing.
  dummy.knockResist = 0;
  dummy.isDummy = true;
  world.actors.push(dummy);
  scene.add(dummy.mesh);

  const [px, pz] = CFG.world.packAt;
  const leader = new Wolf(px, pz, true, world);
  // Three, not four. This is the first fight in the game and the one the
  // player learns on; it should not also be the hardest thing in the slice.
  const offsets = [[-3.2, 1.1], [3.0, 0.4], [-0.6, 3.2]];
  const members = offsets.map(([ox, oz]) => new Wolf(px + ox, pz + oz, false, world));

  for (const w of [leader, ...members]) {
    world.actors.push(w);
    scene.add(w.mesh);
    // Facing the player, so the first thing you see is a pack looking back.
    w.yaw = Math.atan2(player.pos.x - w.pos.x, player.pos.z - w.pos.z);
    w.setTarget(player);
    w.state = WolfState.Idle;
  }
  world.packs.push(new Pack(leader, members));
  world.leader = leader;
}

// ───────────────────────────────────────────────────────── naming in reach
const naming = {
  reach: 3.0,
  candidate: null,
  prompt: '',
  // Cycled rather than typed. A text field is impossible here: the same key
  // presses that spell a name also drive the character, so typing "Fenrir"
  // would walk you off the body and the "f" would confirm it half-spelled.
  names: ['Fenrir', 'Garm', 'Skoll', 'Hati', 'Vargr', 'Amarok', 'Sif', 'Bran'],
  index: 0,
  flash: '',
  flashUntil: 0,

  get pending() { return this.names[this.index]; },
  cycle() { this.index = (this.index + 1) % this.names.length; },

  refresh() {
    const p = world.player;
    this.candidate = null;
    if (p.health.dead) { this.prompt = ''; return; }

    let best = null, bestD = Infinity;
    for (const a of world.actors) {
      if (!a.subdue || !a.subdue.canBeNamed) continue;
      const d = dist2(a.pos, p.pos);
      if (d > this.reach || d >= bestD) continue;
      bestD = d; best = a;
    }
    this.candidate = best;

    if (!best) { this.prompt = ''; return; }
    const refusal = p.roster.canName(best);
    const left = best.subdue.remaining.toFixed(1);
    this.prompt = refusal
      ? `${best.identity.display} is down — ${refusal}  (${left}s)`
      : `${best.identity.display} is down.  Name it  (${left}s)`;
  },

  confirm() {
    if (!this.candidate) return;
    const before = this.candidate;
    const { familiar, reason } = world.player.roster.name(before, this.pending);
    if (familiar) {
      const pack = world.packs.find(pk => pk.leader === before);
      this.say(pack
        ? `${before.identity.display} answers — and its pack comes with it.`
        : `${before.identity.display} is yours.`);
    } else {
      this.say(reason);
    }
  },

  say(text) { this.flash = text; this.flashUntil = world.time + 3.2; },
};

// ───────────────────────────────────────────────────────────── the tick
//
// Everything advances from here and nothing reads the wall clock, so a test can
// drive the whole game at any rate it likes and get the same answers a player
// would.
function step(dt) {
  world.time += dt;
  const p = world.player;

  p.roster.tick(dt);
  p.tick(dt, input, world.actors);

  for (const a of world.actors) {
    if (a === p) continue;
    if (a.tick) a.tick(dt, world.actors);
    else a.integrate(dt);
    a.syncMesh();
  }

  separate(world.actors);
  for (const a of world.actors) a.syncMesh();

  naming.refresh();
  cam.tick(dt);
}
