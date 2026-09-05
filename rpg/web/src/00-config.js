// Tuning, all in one place, mirroring the serialized fields on the Unity side
// so the two versions stay comparable. Every number here is a first guess by
// someone who could not play it — the point of this build is to find out which
// ones are wrong.
const CFG = {
  player: {
    radius: 0.38,
    walkSpeed: 2.4,
    runSpeed: 5.4,
    accel: 16,
    turnSpeed: 12,          // radians/sec toward the desired facing
    health: 160,
    poise: 60,
    // How long a press is remembered. Too short and committed attacks feel
    // like they eat inputs; too long and the character keeps swinging after
    // the player has stopped asking.
    inputBuffer: 0.35,
    // Recovery is cancellable into a dodge from this fraction onward. That
    // escape valve is what keeps commitment fair rather than cruel.
    dodgeCancelAt: 0.25,
    dodgeDistance: 4.4,
    dodgeDuration: 0.40,
    dodgeIFrames: 0.26,
    dodgeCooldown: 0.15,
  },

  // The chain. Later steps hit harder and commit longer — that escalation is
  // the whole reason to risk the third swing.
  chain: [
    { name: 'Slash 1', windup: 0.16, active: 0.10, recovery: 0.26,
      damage: 20, impact: 12, knockback: 2.0, lunge: 1.5,
      reach: 1.55, halfWidth: 0.62 },
    { name: 'Slash 2', windup: 0.14, active: 0.10, recovery: 0.28,
      damage: 24, impact: 15, knockback: 2.4, lunge: 1.7,
      reach: 1.65, halfWidth: 0.70 },
    { name: 'Heavy',   windup: 0.30, active: 0.14, recovery: 0.48,
      damage: 42, impact: 34, knockback: 4.5, lunge: 2.2,
      reach: 1.90, halfWidth: 0.95 },
  ],

  wolf: {
    radius: 0.45,
    noticeRange: 14,
    loseRange: 22,
    chaseSpeed: 4.6,
    circleSpeed: 2.6,
    turnSpeed: 9,
    circleDistance: 4.0,
    lungeRange: 4.5,
    // The tell. Long enough to see and answer — this number is the difference
    // between a fair enemy and a cheap one, and it is the first thing to
    // measure rather than guess.
    telegraph: 0.45,
    lungeDuration: 0.30,
    lungeSpeed: 11,
    recovery: 0.65,
    damage: 12,
    impact: 10,
    knockback: 3,
    attackCooldown: 1.4,
    staggerDuration: 0.5,
    routSpeed: 6.5,
    reach: 0.95,
    halfWidth: 0.42,
    health: 110,
    poise: 26,
    reacquireEvery: 0.5,
    // How many monsters may be committed to an attack AT ONCE, across the whole
    // world. Measured, not guessed: with no limit, five wolves standing on a
    // motionless player did 168 damage in ten seconds against a 160 health
    // pool, so the opening encounter killed the player before they could learn
    // anything from it. Worse, it was illegible — five simultaneous tells are
    // not a tell, they are noise.
    //
    // A real pack takes turns. One commits while the rest circle and wait, so
    // the fight has a rhythm the player can read and answer, and the pack's
    // size becomes pressure rather than arithmetic.
    // ONE. Measured: at two, a standing player died in 7 seconds while needing
    // 15 seconds of uninterrupted offence to clear the pack — an opening fight
    // nobody could learn from. But the real argument is not the arithmetic.
    //
    // This design's core promise is "see the crouch and you have time". Two
    // crouches at once, from two directions, is a promise it cannot keep: you
    // can only answer one, so the second is unavoidable damage dressed up as a
    // tell. One at a time makes the pack a RHYTHM — it commits, you roll, you
    // punish, the next one steps up — and the other wolves stop being damage
    // and start being the thing that stops you running away.
    maxCommitting: 1,
  },

  // The leader is not merely a bigger wolf: it hits harder but tells for
  // longer, so it is more dangerous without being less fair.
  alpha: {
    scale: 1.32,
    health: 260,
    poise: 70,
    damage: 20,
    telegraph: 0.54,
    attackCooldown: 1.7,
    noticeRange: 17,
    knockbackResist: 0.45,
  },

  subdue: {
    // Fraction of health at which it breaks rather than dies.
    collapseAt: 0.15,
    // The window to stop, walk over and name it. Long enough to cross a few
    // metres, short enough that it is a scramble.
    downFor: 6.0,
    recoverTo: 0.30,
  },

  roster: {
    capacity: 3,
    maxWill: 100,
    willRegen: 1.5,
    wolfCost: 20,
    alphaCost: 55,
    wolfPower: 1.30,
    alphaPower: 1.50,
  },

  pack: {
    memberLeash: 3.5,
    hesitateDuration: 3.5,
    routDuration: 7.0,
  },

  familiar: {
    leash: 4.5,
    watchRadius: 12,
    chaseLimit: 20,
    rethinkEvery: 0.35,
  },

  hitstop: {
    onDamage: 0.07,
    onStagger: 0.12,
    // Not zero: a hair of motion reads as impact rather than as the game
    // hitching.
    scale: 0.06,
  },

  camera: {
    // Portrait on a phone is a narrow window on a wide fight, so the camera
    // sits further back there. Measured by rendering, not guessed: at 5m the
    // player filled a third of the screen and a circling wolf left frame.
    distance: 7.4,
    portraitDistance: 9.6,
    height: 1.85,
    shoulder: 0.55,
    minPitch: -0.50,
    maxPitch: 0.95,
    followLag: 0.10,
    sensitivity: 0.0032,
  },

  world: {
    groundRadius: 70,
    dummyAt: [0, 7],
    packAt: [3, 24],
  },
};
