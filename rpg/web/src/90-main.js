// Boot and the loop.
spawnWorld();
const cam = new OrbitCamera(world.player);

let last = performance.now();
let running = true;

function frame(now) {
  requestAnimationFrame(frame);
  if (!running) return;

  // Real elapsed time, clamped. A tab that was in the background for a minute
  // must not deliver a minute-long step, or every wolf teleports into your face.
  let dtReal = Math.min(0.05, (now - last) / 1000);
  last = now;

  // Hitstop scales the world's clock, not the frame's, so the freeze itself
  // ends on schedule while everything inside it crawls.
  readKeyboard();
  step(dtReal * Hitstop.scale(dtReal));
  drawHud();
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

document.addEventListener('visibilitychange', () => {
  running = !document.hidden;
  last = performance.now();
});

// Everything a test needs, and nothing the game needs it for. Exposed here so
// no part of the game has to be shaped by being testable.
window.__rpg = {
  world, naming, step, CFG, Hitstop,
  WolfState, PlayerState, Order,
  get player() { return world.player; },
  get wolves() { return world.actors.filter(a => a instanceof Wolf); },
  get leader() { return world.leader; },
  /** Advance n fixed steps, so a measurement never depends on frame rate. */
  run(seconds, dt = 1 / 60) {
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) step(dt);
    return world.time;
  },
  press(what) {
    if (what === 'attack') world.player.requestAttack();
    if (what === 'dodge') world.player.requestDodge(input.moveX, input.moveZ);
    if (what === 'name') naming.confirm();
  },
  setMove(x, z, run = false) { input.moveX = x; input.moveZ = z; input.run = run; },
  place(actor, x, z) { actor.pos.x = x; actor.pos.z = z; actor.syncMesh(); },
  pause() { running = false; },
  // Reached through the world so a test never has to guess at scope.
  get progression() { return progression; },
};
