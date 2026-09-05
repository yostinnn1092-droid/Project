const T = THREE;

// ───────────────────────────────────────────────────────────── small maths
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;

/** Shortest signed angle from a to b, so turning never takes the long way. */
function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function moveAngle(from, to, maxStep) {
  const d = angleDelta(from, to);
  return from + clamp(d, -maxStep, maxStep);
}

/** Planar distance. Everything here happens on flat ground; y is decoration. */
function dist2(a, b) {
  const dx = a.x - b.x, dz = a.z - b.z;
  return Math.hypot(dx, dz);
}

// ───────────────────────────────────────────────────────────── hitstop
//
// The single cheapest thing that makes melee feel heavy. Without it a sword
// passes through a body at constant speed and reads as a cursor touching a
// sprite; with it the swing stops dead on contact and the weight is implied by
// the pause rather than by any animation.
//
// One global, not one per actor: two overlapping freezes must not multiply
// into a long stall, so a new request only EXTENDS an active one.
const Hitstop = {
  remaining: 0,
  freeze(seconds) { this.remaining = Math.max(this.remaining, seconds); },
  /** Returns the scale to apply to this frame's dt. */
  scale(dtReal) {
    if (this.remaining <= 0) return 1;
    this.remaining -= dtReal;          // unscaled, or the freeze outlives itself
    return CFG.hitstop.scale;
  },
  clear() { this.remaining = 0; },
};

// ───────────────────────────────────────────────────────────── damageable
//
// Health and poise. Poise, not health, decides staggering — so a fast weapon
// cannot lock a big monster in permanent flinch, and a heavy weapon is worth
// its slowness.
class Damageable {
  constructor(actor, maxHealth, maxPoise) {
    this.actor = actor;
    this.maxHealth = maxHealth;
    this.health = maxHealth;
    this.maxPoise = maxPoise;
    this.poise = maxPoise;
    this.poiseRegen = maxPoise * 0.5;
    this.poiseRegenDelay = 1.2;
    this._quiet = 0;
    this.invulnerable = false;
    // Armed by Subduable on anything that can be taken alive, and cleared the
    // moment one actually collapses. From then on a hit is a hit.
    this.preventDeath = false;
    this.onHit = [];
    this.onStagger = [];
    this.onDeath = [];
  }

  get dead() { return this.health <= 0; }

  tick(dt) {
    if (this.dead) return;
    this._quiet += dt;
    if (this._quiet >= this.poiseRegenDelay && this.poise < this.maxPoise)
      this.poise = Math.min(this.maxPoise, this.poise + this.poiseRegen * dt);
  }

  /**
   * Takes a blow. Returns true if it landed.
   *
   * Order matters here and is load-bearing: the collapse guard is applied
   * BEFORE any listener runs, because an earlier version let an overkill blow
   * take a creature from 20% to below zero and skip the collapse window
   * entirely — which quietly removed the naming mechanic from every fight the
   * player was winning decisively.
   */
  takeHit(blow) {
    if (this.dead || this.invulnerable) return false;

    this.health -= blow.damage;
    this._quiet = 0;

    if (this.health <= 0 && this.preventDeath)
      this.health = Math.max(1, this.maxHealth * 0.02);

    this.poise -= (blow.impact || 0);
    const staggered = this.poise <= 0;
    if (staggered) this.poise = this.maxPoise;

    Hitstop.freeze(staggered ? CFG.hitstop.onStagger : CFG.hitstop.onDamage);

    for (const fn of this.onHit) fn(blow);
    if (staggered && !this.dead) for (const fn of this.onStagger) fn(blow);
    if (this.health <= 0) this.die();
    return true;
  }

  heal(amount) {
    if (this.dead) return;
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  kill() {
    if (this.dead) return;
    this.health = 0;
    this.die();
  }

  /**
   * Fires once and once only. Subduable finishes a downed creature from INSIDE
   * the onHit loop, so without this guard the trailing health check in takeHit
   * raises death a second time — and a pack would rout twice, a familiar would
   * be removed from a roster it had already left.
   */
  die() {
    if (this._died) return;
    this._died = true;
    for (const fn of this.onDeath) fn();
  }

  /** A name makes it stronger — the reason to name a thing rather than recruit it. */
  scaleMaxHealth(multiplier) {
    const ratio = this.maxHealth > 0 ? this.health / this.maxHealth : 1;
    this.maxHealth *= multiplier;
    this.health = this.maxHealth * ratio;
  }
}

// ───────────────────────────────────────────────────────────── hit sweeps
//
// A swing is an oriented box in front of the attacker, tested every frame it is
// open. Sweeping rather than relying on a collision callback is the difference
// between a game and "my sword went through it and nothing happened", which is
// the single worst bug a melee game can have.
//
// Each opening remembers what it has already struck, so one swing hits a given
// body once however many frames it stays inside it — while a wide swing can
// still catch several bodies.
class Swing {
  constructor(owner) {
    this.owner = owner;
    this.open = false;
    this.blow = null;
    this.reach = 1.5;
    this.halfWidth = 0.6;
    this.hit = new Set();
    // What it can connect with. Settable because allegiance is not fixed: a
    // wolf that joins the player must stop being able to bite them.
    this.targets = 'all';
  }

  begin(blow, reach, halfWidth) {
    this.blow = blow;
    this.reach = reach;
    this.halfWidth = halfWidth;
    this.hit.clear();
    this.open = true;
  }

  close() { this.open = false; }

  /**
   * One frame of the active window. `candidates` is every actor in the world;
   * `allowed` decides which of them this swing is permitted to strike.
   */
  sweep(candidates, allowed) {
    if (!this.open || !this.blow) return;
    const o = this.owner;
    const cos = Math.cos(o.yaw), sin = Math.sin(o.yaw);

    for (const target of candidates) {
      if (target === o) continue;
      if (target.health.dead) continue;
      if (!allowed(target)) continue;
      if (this.hit.has(target)) continue;

      // Into the attacker's local space, where the box test is two compares.
      const dx = target.pos.x - o.pos.x, dz = target.pos.z - o.pos.z;
      const forward = dx * sin + dz * cos;
      const side = dx * cos - dz * sin;
      const r = target.radius;

      if (forward < -r || forward > this.reach + r) continue;
      if (Math.abs(side) > this.halfWidth + r) continue;

      this.hit.add(target);
      if (o.team === 'player') cam.kick(0.10 + (this.blow.impact || 0) / 260);
      const len = Math.hypot(dx, dz) || 1;
      target.health.takeHit({
        ...this.blow,
        source: o,
        dirX: dx / len,
        dirZ: dz / len,
      });
    }
  }
}
