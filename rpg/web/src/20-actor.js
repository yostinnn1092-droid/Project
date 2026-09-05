// Everything in the world that can move and be hit. Bodies are cylinders on
// flat ground: there is no jumping and nothing to fall off, so height is
// decoration and every question the design asks is a planar one.
class Actor {
  constructor(opts) {
    this.pos = new T.Vector3(opts.x || 0, 0, opts.z || 0);
    this.yaw = opts.yaw || 0;
    this.radius = opts.radius || 0.4;
    this.mass = opts.mass || 1;
    this.health = new Damageable(this, opts.health || 100, opts.poise || 30);
    this.speed = 0;                    // for animation and readouts
    this.knock = new T.Vector3();
    this.knockResist = opts.knockResist == null ? 1 : opts.knockResist;
    this.mesh = null;
    this.dead = false;
    this.swing = new Swing(this);
    this.team = opts.team || 'monster';

    // A shove that lifts a body off the ground looks like a bug rather than a
    // hit, so knockback is planar and nothing here ever leaves y = 0.
    this.health.onHit.push(blow => {
      if (!blow.knockback) return;
      this.knock.x += blow.dirX * blow.knockback * this.knockResist;
      this.knock.z += blow.dirZ * blow.knockback * this.knockResist;
    });
    this.health.onDeath.push(() => { this.dead = true; });
  }

  get down() { return this.subdue ? this.subdue.isDown : false; }

  /** Planar move with the knockback bleed applied. */
  integrate(dt) {
    this.health.tick(dt);

    if (this.knock.lengthSq() > 1e-6) {
      this.pos.x += this.knock.x * dt;
      this.pos.z += this.knock.z * dt;
      const damp = 14 * dt;
      const len = Math.hypot(this.knock.x, this.knock.z);
      const next = Math.max(0, len - damp);
      const k = len > 0 ? next / len : 0;
      this.knock.x *= k; this.knock.z *= k;
    }

    // A soft wall, so a routing wolf cannot run to the horizon and a player
    // chasing one cannot follow it off the edge of the ground.
    const limit = CFG.world.groundRadius - 2;
    const d = Math.hypot(this.pos.x, this.pos.z);
    if (d > limit) {
      this.pos.x *= limit / d;
      this.pos.z *= limit / d;
    }
  }

  move(vx, vz, dt) {
    this.pos.x += vx * dt;
    this.pos.z += vz * dt;
    this.speed = Math.hypot(vx, vz);
  }

  faceToward(x, z, dt, turnSpeed) {
    const dx = x - this.pos.x, dz = z - this.pos.z;
    if (dx * dx + dz * dz < 1e-6) return;
    this.yaw = moveAngle(this.yaw, Math.atan2(dx, dz), turnSpeed * dt);
  }

  syncMesh() {
    if (!this.mesh) return;
    this.mesh.position.set(this.pos.x, this.pos.y, this.pos.z);
    this.mesh.rotation.y = this.yaw;
  }
}

/**
 * Keeps bodies out of each other. Without this a pack piles into one point and
 * reads as a single blob — the spacing is what makes four wolves look like
 * four wolves.
 */
function separate(actors) {
  for (let i = 0; i < actors.length; i++) {
    const a = actors[i];
    if (a.dead) continue;
    for (let j = i + 1; j < actors.length; j++) {
      const b = actors[j];
      if (b.dead) continue;
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
      const want = a.radius + b.radius;
      const d = Math.hypot(dx, dz);
      if (d >= want || d < 1e-5) continue;
      const push = (want - d) * 0.5;
      const nx = dx / d, nz = dz / d;
      // A downed body is furniture: it gets shoved rather than shoving, so a
      // player can stand over it to name it without being nudged away.
      const aFixed = a.down, bFixed = b.down;
      if (!aFixed) { a.pos.x -= nx * push; a.pos.z -= nz * push; }
      if (!bFixed) { b.pos.x += nx * push; b.pos.z += nz * push; }
    }
  }
}
