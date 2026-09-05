// What happens after the first pack.
//
// Without this the game ends in three minutes: beat one pack and stand in an
// empty field. The loop it adds is the smallest one the design can support and
// still be about something — hunt, choose whether to kill or to name, and face
// something bigger having spent will on that choice.
//
// Territories rather than waves, deliberately. A wave arrives at you and is
// survived; a territory sits somewhere and is GONE INTO, which is the posture
// the naming system needs — you go looking for a leader worth the risk.
const progression = {
  territory: 1,
  clearedAt: 0,
  pending: false,

  /** Wild means unbound and alive: a named pack is yours, not an obstacle. */
  wildLeft() {
    return world.actors.filter(a =>
      a instanceof Wolf && !a.health.dead && !a.familiar.bound).length;
  },

  tick(dt) {
    if (world.player.health.dead) return;
    const wild = this.wildLeft();

    if (!this.pending && wild === 0) {
      this.pending = true;
      // A beat before the next one, so clearing a territory has a moment of
      // quiet in it. Arriving instantly would make the field feel like a
      // spawner rather than a place.
      this.clearedAt = world.time + 4.0;
      this.say(`Territory ${this.territory} is yours.`);
      return;
    }
    if (!this.pending || world.time < this.clearedAt) return;

    this.pending = false;
    this.territory++;
    this.advance();
  },

  advance() {
    const t = this.territory;
    // Grows slowly. The interesting escalation is the leader being worth more
    // than the pack, not the pack being bigger.
    const count = Math.min(6, 2 + Math.floor(t / 2));
    const strength = 1 + (t - 1) * 0.22;

    // Placed away from wherever the player is standing, far enough that they
    // walk INTO it rather than being ambushed at the moment of arrival.
    const a = world.rnd() * Math.PI * 2;
    const away = 30 + world.rnd() * 12;
    let px = world.player.pos.x + Math.cos(a) * away;
    let pz = world.player.pos.z + Math.sin(a) * away;
    const edge = CFG.world.groundRadius - 12;
    const d = Math.hypot(px, pz);
    if (d > edge) { px *= edge / d; pz *= edge / d; }

    spawnPack(px, pz, count, strength);

    // Naming gets easier to afford as the roster grows, so the late game is a
    // question of WHO is worth a place rather than whether one can be paid for.
    if (t % 2 === 0) world.player.roster.capacity++;

    const dir = compass(px - world.player.pos.x, pz - world.player.pos.z);
    this.say(`Territory ${t}: a pack to the ${dir}.`);
  },

  // Routed through the same channel as everything else. Two independent
  // message slots is two messages on screen at once, and they landed on top of
  // each other and on the family panel underneath.
  say(text) { naming.say(text, 5.0); },
};

/**
 * Which way to walk. A message that says "a pack appeared" and leaves the
 * player turning on the spot to find it is a message that has not been sent.
 */
function compass(dx, dz) {
  const a = Math.atan2(dx, dz);
  const names = ['north', 'north-east', 'east', 'south-east',
                 'south', 'south-west', 'west', 'north-west'];
  return names[(Math.round(a / (Math.PI / 4)) + 8) % 8];
}
