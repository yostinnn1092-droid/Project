// Input, for a thumb first and a keyboard second.
//
// The phone is the target here, so the touch layer is not a port of the
// keyboard one — it is the primary design, and the keyboard is the convenience.
const input = { moveX: 0, moveZ: 0, run: false };
const el = id => document.getElementById(id);

// ───────────────────────────────────────────────────────────── keyboard
const keys = new Set();
addEventListener('keydown', e => {
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === 'Space') { e.preventDefault(); world.player.requestDodge(input.moveX, input.moveZ); }
  if (e.code === 'KeyF') { e.preventDefault(); naming.confirm(); }
  if (e.code === 'Tab') { e.preventDefault(); naming.cycle(); }
  if (e.code === 'KeyQ') { e.preventDefault(); orderFamily(); }
  if (e.code === 'KeyR' && world.player.health.dead) location.reload();
});
addEventListener('keyup', e => keys.delete(e.code));

function readKeyboard() {
  if (touchActive) return;
  let x = 0, z = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) z += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) z -= 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
  input.run = keys.has('ShiftLeft') || keys.has('ShiftRight');
  // Camera-relative, so "up" always means away from the camera. Anything else
  // and a third-person game becomes a puzzle about which way you are facing.
  const c = Math.cos(cam.yaw), s = Math.sin(cam.yaw);
  input.moveX = -(x * c + z * s);
  input.moveZ = -(-x * s + z * c);
}

canvas.addEventListener('mousedown', e => {
  if (e.button === 0) world.player.requestAttack();
});

// Mouse look, only while the button is held — no pointer lock, because losing
// the cursor on a laptop trackpad is more annoying than dragging.
let looking = false, lastX = 0, lastY = 0;
canvas.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'mouse') return;
  looking = true; lastX = e.clientX; lastY = e.clientY;
});
addEventListener('pointerup', () => { looking = false; });
addEventListener('pointermove', e => {
  if (!looking || e.pointerType !== 'mouse') return;
  cam.turn(e.clientX - lastX, e.clientY - lastY);
  lastX = e.clientX; lastY = e.clientY;
});

// ───────────────────────────────────────────────────────────── touch
let touchActive = false;

// The stick. Its centre is wherever the thumb lands rather than the middle of
// the pad: a fixed centre means every grab starts with a jerk, because a thumb
// never lands exactly where the art says it should.
(() => {
  const stick = el('stick'), knob = el('knob');
  let id = null, cx = 0, cy = 0;
  const MAX = 46;

  stick.addEventListener('pointerdown', e => {
    id = e.pointerId; touchActive = true;
    const r = stick.getBoundingClientRect();
    cx = r.left + r.width / 2; cy = r.top + r.height / 2;
    stick.setPointerCapture(id);
    e.preventDefault();
  });

  stick.addEventListener('pointermove', e => {
    if (e.pointerId !== id) return;
    const dx = e.clientX - cx, dy = e.clientY - cy;
    const d = Math.hypot(dx, dy);
    const k = d > MAX ? MAX / d : 1;
    knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    const nx = (dx * k) / MAX, ny = (dy * k) / MAX;
    const c = Math.cos(cam.yaw), s = Math.sin(cam.yaw);
    input.moveX = -(nx * c + -ny * s);
    input.moveZ = -(-nx * s + -ny * c);
    // Push past three quarters and you are running. One control, two speeds —
    // a separate sprint button is a thumb the player does not have.
    input.run = Math.hypot(nx, ny) > 0.75;
    e.preventDefault();
  });

  const end = e => {
    if (e.pointerId !== id) return;
    id = null;
    input.moveX = input.moveZ = 0; input.run = false;
    knob.style.transform = 'translate(0,0)';
  };
  stick.addEventListener('pointerup', end);
  stick.addEventListener('pointercancel', end);
})();

function tap(id, fn) {
  const b = el(id);
  b.addEventListener('pointerdown', e => {
    e.preventDefault();
    touchActive = true;
    b.classList.add('on');
    fn();
  });
  const off = () => b.classList.remove('on');
  b.addEventListener('pointerup', off);
  b.addEventListener('pointercancel', off);
  b.addEventListener('pointerleave', off);
}

// The intro card. Dismissed for good on the first press — it is instruction,
// not a menu, and nobody wants to read it twice.
(() => {
  const intro = el('intro'), begin = el('begin');
  if (!intro) return;
  const dismiss = () => {
    intro.classList.add('gone');
    setTimeout(() => intro.remove(), 500);
  };
  begin.addEventListener('click', dismiss);
  intro.addEventListener('pointerdown', e => { if (e.target === intro) dismiss(); });
  addEventListener('keydown', e => {
    if (intro.isConnected && (e.code === 'Space' || e.code === 'Enter')) dismiss();
  });
})();

tap('bAttack', () => world.player.requestAttack());
tap('bDodge', () => world.player.requestDodge(input.moveX, input.moveZ));
tap('bName', () => naming.confirm());
tap('bCycle', () => naming.cycle());
tap('bOrder', () => orderFamily());

/**
 * Death is a full restart rather than a respawn. Everything named is lost with
 * you, which is the only thing that makes spending will on a name a risk.
 */
el('restart').addEventListener('click', () => location.reload());

function orderFamily() {
  const r = world.player.roster;
  if (r.family.length === 0) return;
  const order = r.cycleOrder();
  const said = { follow: 'Heel.', hold: 'Hold this ground.', attack: 'Take it.' };
  naming.say(said[order] || order);
}

// Camera drag anywhere on the right of the screen that is not a button. Giving
// the camera a dedicated pad would cost a third thumb.
(() => {
  let id = null, lx = 0, ly = 0;
  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' || id !== null) return;
    touchActive = true;
    id = e.pointerId; lx = e.clientX; ly = e.clientY;
  });
  canvas.addEventListener('pointermove', e => {
    if (e.pointerId !== id) return;
    cam.turn(e.clientX - lx, e.clientY - ly);
    lx = e.clientX; ly = e.clientY;
    e.preventDefault();
  });
  const end = e => { if (e.pointerId === id) id = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
})();
