// The player.
//
// The design rests on one trade: ATTACKS COMMIT, BUT INPUT NEVER GETS EATEN.
//
//   * A swing cannot be cancelled once its windup starts. That commitment is
//     what gives a blow weight and what gives an enemy something to punish.
//   * Presses during a swing are BUFFERED and spent the moment the window
//     opens, so the player experiences a responsive game made of unresponsive
//     attacks.
//   * Recovery is cancellable into a dodge. That escape valve is what keeps
//     commitment fair instead of cruel.
//
// Remove any one of the three and the other two stop working.
const PlayerState = { Idle: 0, Windup: 1, Active: 2, Recovery: 3, Dodging: 4 };

class Player extends Actor {
  constructor(x, z) {
    super({
      x, z, radius: CFG.player.radius, team: 'player',
      health: CFG.player.health, poise: CFG.player.poise,
    });
    this.mesh = buildPlayerMesh();
    this.state = PlayerState.Idle;
    this.step = 0;              // where in the chain
    this.phase = 0;             // seconds into the current phase
    this.buffered = -1;         // time remaining on a remembered press
    this.chainGrace = 0;        // how long the chain stays open after recovery
    this.dodgeCooldown = 0;
    this.iframes = 0;
    this.dodgeDir = { x: 0, z: 1 };
    this.roster = new Roster(this);
    this.swing.targets = 'monster';

    this.health.onStagger.push(() => {
      // Being staggered drops whatever you were doing. Anything else and poise
      // would be a number with no consequence.
      if (this.state !== PlayerState.Dodging) this.abort();
    });
  }

  abort() {
    this.state = PlayerState.Idle;
    this.phase = 0;
    this.swing.close();
  }

  get busy() {
    return this.state === PlayerState.Windup || this.state === PlayerState.Active;
  }

  /** Called on a press. Never rejected outright — it is remembered instead. */
  requestAttack() { this.buffered = CFG.player.inputBuffer; }

  requestDodge(inputX, inputZ) {
    if (this.dodgeCooldown > 0 || this.health.dead) return;
    // The one thing that may interrupt a committed attack, and only from part
    // way through recovery. Earlier than that and commitment means nothing.
    if (this.state === PlayerState.Windup || this.state === PlayerState.Active) return;
    if (this.state === PlayerState.Recovery) {
      const spec = CFG.chain[this.step];
      if (this.phase < spec.recovery * CFG.player.dodgeCancelAt) return;
    }
    if (this.state === PlayerState.Dodging) return;

    const len = Math.hypot(inputX, inputZ);
    if (len > 0.1) {
      this.dodgeDir = { x: inputX / len, z: inputZ / len };
      this.yaw = Math.atan2(this.dodgeDir.x, this.dodgeDir.z);
    } else {
      // No stick: roll backwards, which is what a player who panicked meant.
      this.dodgeDir = { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) };
    }
    this.state = PlayerState.Dodging;
    this.phase = 0;
    this.iframes = CFG.player.dodgeIFrames;
    this.dodgeCooldown = CFG.player.dodgeDuration + CFG.player.dodgeCooldown;
    this.swing.close();
  }

  tick(dt, input, actors) {
    this.integrate(dt);
    if (this.health.dead) { this.speed = 0; return; }

    if (this.buffered > 0) this.buffered -= dt;
    if (this.dodgeCooldown > 0) this.dodgeCooldown -= dt;
    if (this.chainGrace > 0) this.chainGrace -= dt;
    if (this.iframes > 0) {
      this.iframes -= dt;
      this.health.invulnerable = true;
    } else {
      this.health.invulnerable = false;
    }

    switch (this.state) {
      case PlayerState.Idle: this.tickFree(dt, input); break;
      case PlayerState.Windup: this.tickWindup(dt); break;
      case PlayerState.Active: this.tickActive(dt, actors); break;
      case PlayerState.Recovery: this.tickRecovery(dt); break;
      case PlayerState.Dodging: this.tickDodge(dt); break;
    }

    this.syncMesh();
    this.poseArm();
  }

  /**
   * The swing, such as it is. Not animation so much as the minimum needed for
   * the attack's PHASES to be visible: a wind-up that draws back, an active
   * frame that has already crossed, a recovery that hangs there. Without it the
   * commitment the whole design rests on is invisible.
   */
  poseArm() {
    const arm = this.mesh.userData.arm;
    if (!arm) return;
    const spec = CFG.chain[this.step];
    let swing = 0;
    if (this.state === PlayerState.Windup) {
      swing = -0.9 * clamp(this.phase / Math.max(0.01, spec.windup), 0, 1);
    } else if (this.state === PlayerState.Active) {
      swing = lerp(-0.9, 1.5, clamp(this.phase / Math.max(0.01, spec.active), 0, 1));
    } else if (this.state === PlayerState.Recovery) {
      swing = lerp(1.5, 0, clamp(this.phase / Math.max(0.01, spec.recovery), 0, 1));
    } else if (this.state === PlayerState.Dodging) {
      swing = -0.4;
    }
    arm.rotation.set(-0.55 - swing * 0.35, 0.18 + swing, -0.30 - swing * 0.55);
  }

  tickFree(dt, input) {
    const len = Math.hypot(input.moveX, input.moveZ);
    if (len > 0.05) {
      const want = input.run ? CFG.player.runSpeed : CFG.player.walkSpeed;
      const target = want * Math.min(1, len);
      this.speed = lerp(this.speed, target, 1 - Math.exp(-CFG.player.accel * dt));
      const nx = input.moveX / len, nz = input.moveZ / len;
      this.yaw = moveAngle(this.yaw, Math.atan2(nx, nz), CFG.player.turnSpeed * dt);
      this.move(nx * this.speed, nz * this.speed, dt);
    } else {
      this.speed = lerp(this.speed, 0, 1 - Math.exp(-CFG.player.accel * dt));
    }

    // A press spends itself the moment there is a window for it.
    if (this.buffered > 0) {
      this.buffered = -1;
      this.step = this.chainGrace > 0 ? (this.step + 1) % CFG.chain.length : 0;
      this.state = PlayerState.Windup;
      this.phase = 0;
    }
  }

  tickWindup(dt) {
    const spec = CFG.chain[this.step];
    this.phase += dt;
    this.speed = 0;
    // Drifts forward through the tell. The lunge is what makes a swing feel
    // like it is going somewhere rather than being performed on the spot.
    const t = spec.windup > 0 ? this.phase / spec.windup : 1;
    const push = spec.lunge * (1 - t) * dt * 2.2;
    this.move(Math.sin(this.yaw) * push / Math.max(dt, 1e-6),
              Math.cos(this.yaw) * push / Math.max(dt, 1e-6), dt);
    if (this.phase >= spec.windup) {
      this.state = PlayerState.Active;
      this.phase = 0;
      this.swing.begin(
        { damage: spec.damage, impact: spec.impact, knockback: spec.knockback },
        spec.reach, spec.halfWidth);
    }
  }

  tickActive(dt, actors) {
    const spec = CFG.chain[this.step];
    this.phase += dt;
    this.swing.sweep(actors, t => t.team === 'monster');
    if (this.phase >= spec.active) {
      this.swing.close();
      this.state = PlayerState.Recovery;
      this.phase = 0;
    }
  }

  tickRecovery(dt) {
    const spec = CFG.chain[this.step];
    this.phase += dt;
    if (this.phase >= spec.recovery) {
      this.state = PlayerState.Idle;
      this.phase = 0;
      // The window in which another press continues the chain rather than
      // starting it over.
      this.chainGrace = 0.35;
    }
  }

  tickDodge(dt) {
    this.phase += dt;
    const d = CFG.player.dodgeDuration;
    // Fast at the start, slowing into the recovery — a roll, not a slide.
    const t = clamp(this.phase / d, 0, 1);
    const v = CFG.player.dodgeDistance / d * (1 - t * 0.7) * 1.55;
    this.move(this.dodgeDir.x * v, this.dodgeDir.z * v, dt);
    this.speed = v;
    if (this.phase >= d) {
      this.state = PlayerState.Idle;
      this.phase = 0;
    }
  }
}

// ───────────────────────────────────────────────────────────── the camera
//
// A spring arm that pulls in when something solid is behind the player. Kept
// deliberately simple: only the ground plane and the world edge can block it,
// because a camera that also collided with wolves would ram into the player's
// face every time one ran behind them.
class OrbitCamera {
  constructor(target) {
    this.target = target;
    this.yaw = Math.PI;
    this.pitch = 0.30;
    this.at = new T.Vector3(target.pos.x, CFG.camera.height, target.pos.z);
  }

  turn(dx, dy) {
    this.yaw -= dx * CFG.camera.sensitivity;
    this.pitch = clamp(this.pitch + dy * CFG.camera.sensitivity,
                       CFG.camera.minPitch, CFG.camera.maxPitch);
  }

  tick(dt) {
    const t = this.target;
    const k = 1 - Math.exp(-dt / Math.max(1e-4, CFG.camera.followLag));
    this.at.x = lerp(this.at.x, t.pos.x, k);
    this.at.z = lerp(this.at.z, t.pos.z, k);
    this.at.y = CFG.camera.height;

    const cp = Math.cos(this.pitch);
    const dir = new T.Vector3(
      Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cp);

    // Portrait sees far less to the sides, so it needs the extra metres.
    let dist = camera.aspect < 1 ? CFG.camera.portraitDistance : CFG.camera.distance;
    const eyeY = this.at.y + dir.y * dist;
    // Never let the camera go under the ground: the horizon flipping is far
    // more disorienting than a slightly tight angle.
    if (eyeY < 0.6) dist = Math.max(1.6, (0.6 - this.at.y) / Math.min(-0.001, dir.y));

    const side = new T.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
      .multiplyScalar(CFG.camera.shoulder);

    camera.position.set(
      this.at.x + dir.x * dist + side.x,
      Math.max(0.6, this.at.y + dir.y * dist),
      this.at.z + dir.z * dist + side.z);
    camera.lookAt(this.at.x + side.x * 0.5, this.at.y + 0.25, this.at.z + side.z * 0.5);

    // The shadow frustum follows the player, so a 34m box covers the fight
    // rather than the whole 140m field.
    sun.position.set(this.at.x + 18, 26, this.at.z - 12);
    sun.target.position.set(this.at.x, 0, this.at.z);
    sun.target.updateMatrixWorld();
  }
}
