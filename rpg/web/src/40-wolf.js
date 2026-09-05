// A wolf. First monster on purpose: it is a pack animal, so it is also the
// first test of the leader-and-pack idea the naming system rests on.
//
// The behaviour is deliberately readable rather than clever. A wolf circles at
// a distance, picks a moment, TELEGRAPHS, and lunges. Every one of those beats
// exists so the player can LEARN it — an enemy that closes and bites on an
// invisible timer cannot be fought well, only survived. The crouch before a
// lunge is the contract: see it, and you have time to roll.
//
// The same code runs a wild wolf and a named one. A wild wolf hunts whatever it
// notices; a named one is handed a target and a place to be, and is otherwise
// identical — so taming a wolf gets you something that still fights like a wolf.
const WolfState = {
  Idle: 'idle', Chase: 'chase', Circle: 'circle', Telegraph: 'telegraph',
  Lunge: 'lunge', Recover: 'recover', Stagger: 'stagger', Routing: 'rout', Dead: 'dead',
};

class Wolf extends Actor {
  constructor(x, z, alpha, world) {
    const spec = alpha ? CFG.alpha : {};
    super({
      x, z, radius: CFG.wolf.radius * (alpha ? CFG.alpha.scale : 1), team: 'monster',
      health: alpha ? CFG.alpha.health : CFG.wolf.health,
      poise: alpha ? CFG.alpha.poise : CFG.wolf.poise,
      knockResist: alpha ? CFG.alpha.knockbackResist : 1,
    });
    this.world = world;
    this.alpha = !!alpha;
    this.mesh = buildWolfMesh(alpha);
    if (alpha) this.mesh.scale.setScalar(CFG.alpha.scale);

    this.damage = alpha ? CFG.alpha.damage : CFG.wolf.damage;
    this.telegraphFor = alpha ? CFG.alpha.telegraph : CFG.wolf.telegraph;
    this.cooldown = alpha ? CFG.alpha.attackCooldown : CFG.wolf.attackCooldown;
    this.noticeRange = alpha ? CFG.alpha.noticeRange : CFG.wolf.noticeRange;

    this.state = WolfState.Idle;
    this.target = null;
    this.home = null;
    this.leash = CFG.familiar.leash;
    this.wild = true;
    this.phase = 0;
    this.nextAttackAt = 0;
    this.circleDir = 1;
    this.circleUntil = 0;
    this.routFrom = new T.Vector3();
    this.routUntil = 0;
    this.nextLookAt = 0;
    this.lungeHeading = { x: 0, z: 1 };

    this.identity = new Identity(this, alpha);
    this.subdue = new Subduable(this);
    this.familiar = new Familiar(this);

    this.health.onStagger.push(() => this.enterStagger());
    this.health.onDeath.push(() => {
      this.state = WolfState.Dead;
      this.swing.close();
      this.mesh.rotation.z = 1.45;      // rolls onto its side
      this.mesh.position.y = 0.1;
    });
  }

  // ── the brain contract, so anything can point it at something ──────────
  setTarget(t) {
    if (this.target === t) return;
    this.target = t;
    // Never yank it out of a committed swing: a lunge that stops halfway
    // because orders changed looks like the animation broke.
    if (this.state === WolfState.Idle || this.state === WolfState.Chase ||
        this.state === WolfState.Circle)
      this.state = t ? WolfState.Chase : WolfState.Idle;
  }

  setHome(actor, leash) { this.home = actor; this.leash = Math.max(0.5, leash); }

  tame() {
    this.wild = false;
    this.target = null;
    if (this.state === WolfState.Chase || this.state === WolfState.Circle)
      this.state = WolfState.Idle;
  }

  /**
   * Break and run. Unlike every other order this interrupts a committed lunge —
   * panic is exactly the thing that should cut an attack already underway.
   */
  rout(fromX, fromZ, seconds) {
    if (this.state === WolfState.Dead) return;
    this.swing.close();
    this.target = null;
    this.routFrom.set(fromX, 0, fromZ);
    this.routUntil = this.world.time + Math.max(0.1, seconds);
    this.state = WolfState.Routing;
    this.phase = 0;
  }

  get engaged() {
    return !!this.target && this.state !== WolfState.Idle && this.state !== WolfState.Dead;
  }

  tick(dt, actors) {
    if (this.state === WolfState.Dead) return;
    this.integrate(dt);
    if (this.subdue.isDown) { this.subdue.tick(dt); this.speed = 0; this.syncMesh(); return; }
    this.subdue.tick(dt);
    this.familiar.tick(dt, actors);

    switch (this.state) {
      case WolfState.Routing: this.tickRout(dt); break;
      case WolfState.Telegraph: this.tickTelegraph(dt); break;
      case WolfState.Lunge: this.tickLunge(dt, actors); break;
      case WolfState.Recover: this.tickRecover(dt); break;
      case WolfState.Stagger: this.tickStagger(dt); break;
      default: this.tickFree(dt); break;
    }

    this.syncMesh();
    // The crouch, drawn rather than described. A tell you cannot see is not one.
    const crouch = this.state === WolfState.Telegraph
      ? -0.22 * Math.min(1, this.phase / Math.max(0.01, this.telegraphFor)) : 0;
    this.mesh.position.y = this.pos.y + crouch;
    this.mesh.rotation.x = crouch * 0.9;
  }

  tickFree(dt) {
    if (!this.target || this.target.health.dead) {
      this.target = null;
      // A wild wolf keeps its nose up. Without this, every way of clearing a
      // target is permanent — and worst of all, a pack that routed would stand
      // in its territory for the rest of the game, which would make scattering
      // a pack strictly better than killing its leader.
      if (this.wild) this.reacquire();
      if (!this.target) { this.goHome(dt); return; }
    }

    const d = dist2(this.pos, this.target.pos);

    if (this.state === WolfState.Idle) {
      if (d <= this.noticeRange) this.state = WolfState.Chase;
      else { this.goHome(dt); return; }
    }

    // A wild wolf gives up when the quarry is far enough away. A named one
    // keeps its target until its handler withdraws it, because it was sent
    // deliberately.
    if (this.wild && d > CFG.wolf.loseRange) { this.state = WolfState.Idle; return; }

    this.faceToward(this.target.pos.x, this.target.pos.z, dt, CFG.wolf.turnSpeed);

    if (this.state === WolfState.Chase) {
      if (d > CFG.wolf.circleDistance) {
        this.stepToward(this.target.pos, CFG.wolf.chaseSpeed, dt);
      } else {
        this.state = WolfState.Circle;
        this.pickCircle();
      }
      return;
    }

    // Circle: strafe around, drifting in or out to hold spacing. The sideways
    // motion is what makes a pack feel like it is working the player rather
    // than queueing up to be hit.
    if (d > CFG.wolf.circleDistance * 1.6) { this.state = WolfState.Chase; return; }
    const tx = (this.target.pos.x - this.pos.x) / (d || 1);
    const tz = (this.target.pos.z - this.pos.z) / (d || 1);
    const ax = -tz * this.circleDir, az = tx * this.circleDir;
    const correction = clamp(d - CFG.wolf.circleDistance, -1, 1);
    let vx = ax + tx * correction, vz = az + tz * correction;
    const len = Math.hypot(vx, vz) || 1;
    this.move(vx / len * CFG.wolf.circleSpeed, vz / len * CFG.wolf.circleSpeed, dt);

    if (this.world.time >= this.circleUntil) this.pickCircle();
    if (d <= CFG.wolf.lungeRange && this.world.time >= this.nextAttackAt &&
        this.world.claimCommit(this)) {
      this.state = WolfState.Telegraph;
      this.phase = 0;
    }
  }

  tickTelegraph(dt) {
    this.phase += dt;
    this.speed = 0;
    // Keeps facing through the tell, so the lunge goes where it can be SEEN to
    // be going.
    if (this.target) this.faceToward(this.target.pos.x, this.target.pos.z, dt, CFG.wolf.turnSpeed);
    if (this.phase < this.telegraphFor) return;

    // Committed to the heading chosen at the end of the tell. A lunge that
    // tracks mid-flight cannot be dodged, which would make the tell a lie.
    this.lungeHeading = { x: Math.sin(this.yaw), z: Math.cos(this.yaw) };
    this.state = WolfState.Lunge;
    this.phase = 0;
    this.swing.begin(
      { damage: this.damage, impact: CFG.wolf.impact, knockback: CFG.wolf.knockback },
      CFG.wolf.reach, CFG.wolf.halfWidth);
  }

  tickLunge(dt, actors) {
    this.phase += dt;
    this.move(this.lungeHeading.x * CFG.wolf.lungeSpeed,
              this.lungeHeading.z * CFG.wolf.lungeSpeed, dt);
    this.swing.sweep(actors, t => this.hostileTo(t));
    if (this.phase < CFG.wolf.lungeDuration) return;
    this.swing.close();
    this.state = WolfState.Recover;
    this.phase = 0;
    this.nextAttackAt = this.world.time + this.cooldown;
  }

  tickRecover(dt) {
    this.phase += dt;
    this.speed = 0;
    if (this.phase < CFG.wolf.recovery) return;
    this.state = this.target ? WolfState.Circle : WolfState.Idle;
    this.pickCircle();
  }

  tickStagger(dt) {
    this.phase += dt;
    this.speed = 0;
    if (this.phase < CFG.wolf.staggerDuration) return;
    this.state = this.target ? WolfState.Circle : WolfState.Idle;
    this.pickCircle();
  }

  tickRout(dt) {
    if (this.world.time >= this.routUntil) {
      // Composure returns, and whether it hunts again is then the ordinary
      // question of whether anything is still close enough to notice. So
      // scattering a pack buys the player the seconds to finish the leader or
      // to leave — not a permanent pacification.
      this.state = WolfState.Idle;
      return;
    }
    let ax = this.pos.x - this.routFrom.x, az = this.pos.z - this.routFrom.z;
    const len = Math.hypot(ax, az);
    if (len < 1e-4) { ax = -Math.sin(this.yaw); az = -Math.cos(this.yaw); }
    else { ax /= len; az /= len; }
    this.faceToward(this.pos.x + ax, this.pos.z + az, dt, CFG.wolf.turnSpeed);
    this.move(ax * CFG.wolf.routSpeed, az * CFG.wolf.routSpeed, dt);
  }

  enterStagger() {
    if (this.state === WolfState.Dead || this.subdue.isDown) return;
    this.swing.close();
    this.state = WolfState.Stagger;
    this.phase = 0;
  }

  /**
   * Nothing to fight. Walk back to whoever or whatever it belongs near. For a
   * familiar this is what following looks like; for a wild pack member it is
   * what keeps it beside its leader instead of wandering.
   */
  goHome(dt) {
    if (!this.home || this.home.health.dead) { this.speed = 0; return; }
    const d = dist2(this.pos, this.home.pos);
    if (d <= this.leash) { this.speed = 0; return; }
    this.faceToward(this.home.pos.x, this.home.pos.z, dt, CFG.wolf.turnSpeed);
    // Hurries when it has fallen a long way behind, so a follower does not
    // trail further and further during a long run.
    const speed = d > this.leash * 2.5 ? CFG.wolf.chaseSpeed : CFG.wolf.circleSpeed;
    this.stepToward(this.home.pos, speed, dt);
  }

  reacquire() {
    if (this.world.time < this.nextLookAt) return;
    this.nextLookAt = this.world.time + CFG.wolf.reacquireEvery;
    const p = this.world.player;
    if (!p || p.health.dead) return;
    // Gated on notice range rather than taken unconditionally, which is what
    // keeps a rout meaningful: run a wolf off and walk away, and it stays off.
    if (dist2(this.pos, p.pos) <= this.noticeRange) this.setTarget(p);
  }

  hostileTo(other) {
    if (other === this) return false;
    // Its weapons change sides with it. An unbound familiar is still wild, so
    // this reads the binding rather than the component.
    if (this.familiar.bound) return other.team === 'monster' && !other.familiar?.bound;
    return other.team === 'player' || (other.familiar && other.familiar.bound);
  }

  stepToward(p, speed, dt) {
    const dx = p.x - this.pos.x, dz = p.z - this.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    this.move(dx / len * speed, dz / len * speed, dt);
  }

  pickCircle() {
    this.circleDir = this.world.rnd() < 0.5 ? -1 : 1;
    this.circleUntil = this.world.time + 0.8 + this.world.rnd() * 1.2;
  }
}
