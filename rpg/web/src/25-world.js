// ───────────────────────────────────────────────────── renderer and stage
const canvas = document.getElementById('gl');
const renderer = new T.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setClearColor(0x7d8794);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = T.PCFSoftShadowMap;

const scene = new T.Scene();
// Fog does real work here: it hides the edge of a finite ground plane and it
// makes twenty-four metres READ as a distance, which matters because the whole
// first encounter is about closing one.
// Fog does real work: it hides the edge of a finite ground plane and makes
// twenty-four metres READ as a distance, which matters because the whole first
// encounter is about closing one. It starts well beyond the pack, though —
// an earlier setting began at 26m and left the wolves greyed out at the exact
// moment the player is meant to be sizing them up.
scene.background = new T.Color(0x7d8794);
scene.fog = new T.Fog(0x7d8794, 42, 135);

const camera = new T.PerspectiveCamera(58, 1, 0.1, 400);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  // Capped: a phone at devicePixelRatio 3 is rendering nine times the pixels
  // for a difference nobody can see, and it is the difference between a smooth
  // fight and a slideshow.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ───────────────────────────────────────────────────────────── lighting
const sun = new T.DirectionalLight(0xfff2e0, 2.9);
sun.position.set(18, 26, -12);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 90;
const shadowSpan = 34;
sun.shadow.camera.left = -shadowSpan;
sun.shadow.camera.right = shadowSpan;
sun.shadow.camera.top = shadowSpan;
sun.shadow.camera.bottom = -shadowSpan;
sun.shadow.bias = -0.0012;
scene.add(sun, sun.target);

// Carries the shadowed side. Without a strong sky term everything not facing
// the sun goes to near-black, which is what made the first render unreadable.
scene.add(new T.HemisphereLight(0xaebfd2, 0x4a4a34, 1.9));
scene.add(new T.AmbientLight(0xffffff, 0.35));

// ───────────────────────────────────────────────────────────── the ground
const ground = new T.Mesh(
  new T.CircleGeometry(CFG.world.groundRadius, 64).rotateX(-Math.PI / 2),
  new T.MeshStandardMaterial({ color: 0x6a7551, roughness: 0.97, metalness: 0 })
);
ground.receiveShadow = true;
scene.add(ground);

// Scattered rocks, only so that movement has something to be measured against.
// A featureless plane makes running feel like standing still.
(() => {
  const rock = new T.MeshStandardMaterial({ color: 0x8a8b84, roughness: 0.9 });
  const geo = new T.IcosahedronGeometry(1, 0);
  const rocks = new T.InstancedMesh(geo, rock, 60);
  const m = new T.Matrix4(), q = new T.Quaternion(), s = new T.Vector3(), p = new T.Vector3();
  let seed = 20260905;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 60; i++) {
    const a = rnd() * Math.PI * 2;
    const r = 12 + rnd() * (CFG.world.groundRadius - 14);
    const sc = 0.3 + rnd() * 0.9;
    p.set(Math.cos(a) * r, sc * 0.32, Math.sin(a) * r);
    q.setFromEuler(new T.Euler(rnd() * 3, rnd() * 6, rnd() * 3));
    s.set(sc, sc * 0.66, sc);
    rocks.setMatrixAt(i, m.compose(p, q, s));
  }
  rocks.castShadow = true;
  rocks.receiveShadow = true;
  scene.add(rocks);
})();

// ───────────────────────────────────────────────────────────── body meshes
function mat(color, rough = 0.75) {
  return new T.MeshStandardMaterial({ color, roughness: rough, metalness: 0.05 });
}

function shadowed(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  return mesh;
}

function buildPlayerMesh() {
  const g = new T.Group();
  const skin = mat(0x9aa2ae, 0.55);
  const body = shadowed(new T.Mesh(new T.CapsuleGeometry(0.27, 0.80, 6, 12), skin));
  body.position.y = 0.92;
  const shoulders = shadowed(new T.Mesh(new T.CapsuleGeometry(0.21, 0.46, 5, 10), mat(0x4d5361, 0.8)));
  shoulders.rotation.z = Math.PI / 2;
  shoulders.position.y = 1.30;
  const head = shadowed(new T.Mesh(new T.SphereGeometry(0.19, 14, 10), mat(0xc9b79b, 0.7)));
  head.position.y = 1.60;

  // Held out and angled up, not tucked in front. Rendered from behind, a blade
  // at the character's centre is simply invisible — the first pass hid the
  // sword completely, which is a poor thing to do in a game about swinging one.
  const arm = new T.Group();
  arm.position.set(0.30, 1.14, 0.06);
  arm.rotation.set(-0.55, 0.18, -0.30);
  const blade = shadowed(new T.Mesh(new T.BoxGeometry(0.065, 0.065, 1.12), mat(0xdfe4ec, 0.22)));
  blade.position.z = 0.62;
  const guard = shadowed(new T.Mesh(new T.BoxGeometry(0.30, 0.055, 0.075), mat(0x6d5a3c, 0.6)));
  const grip = shadowed(new T.Mesh(new T.CylinderGeometry(0.035, 0.035, 0.24, 8), mat(0x3a2b1c, 0.9)));
  grip.rotation.x = Math.PI / 2;
  grip.position.z = -0.13;
  arm.add(blade, guard, grip);

  g.add(body, shoulders, head, arm);
  g.userData.arm = arm;
  return g;
}

function buildWolfMesh(alpha) {
  const g = new T.Group();
  const coat = mat(alpha ? 0x5f2426 : 0x4b4d54, 0.9);
  const dark = mat(alpha ? 0x431719 : 0x36383e, 0.9);

  // Leaner and longer than the first pass, which rendered as a slug. A wolf
  // has to read as a wolf from behind, at speed, at eight metres — that is the
  // only angle the player ever sees one from.
  const body = shadowed(new T.Mesh(new T.CapsuleGeometry(0.235, 0.80, 6, 12), coat));
  body.rotation.x = Math.PI / 2;
  body.position.y = 0.60;

  const chest = shadowed(new T.Mesh(new T.SphereGeometry(0.27, 12, 9), coat));
  chest.scale.set(1, 0.9, 1.05);
  chest.position.set(0, 0.62, 0.30);

  const neck = shadowed(new T.Mesh(new T.CapsuleGeometry(0.15, 0.20, 5, 9), coat));
  neck.rotation.x = 1.15;
  neck.position.set(0, 0.68, 0.56);

  const head = shadowed(new T.Mesh(new T.BoxGeometry(0.26, 0.24, 0.30), coat));
  head.position.set(0, 0.72, 0.78);

  // A pale snout, purely so the direction it faces is readable at twenty
  // metres. The telegraph is a promise about where the lunge will GO, and a
  // promise you cannot see is not one.
  const snout = shadowed(new T.Mesh(new T.BoxGeometry(0.15, 0.13, 0.26), mat(0xd8d2c4, 0.8)));
  snout.position.set(0, 0.68, 1.00);

  const ears = new T.Group();
  for (const sx of [-1, 1]) {
    const ear = shadowed(new T.Mesh(new T.ConeGeometry(0.06, 0.15, 4), dark));
    ear.position.set(sx * 0.10, 0.89, 0.74);
    ears.add(ear);
  }

  const legs = new T.Group();
  // Four legs do more for the silhouette than any amount of body detail: they
  // are what separates an animal from a floating shape.
  for (const [lx, lz] of [[-0.16, 0.34], [0.16, 0.34], [-0.16, -0.34], [0.16, -0.34]]) {
    const leg = shadowed(new T.Mesh(new T.CylinderGeometry(0.055, 0.045, 0.52, 6), dark));
    leg.position.set(lx, 0.26, lz);
    legs.add(leg);
  }

  const tail = shadowed(new T.Mesh(new T.CapsuleGeometry(0.055, 0.34, 4, 8), coat));
  tail.rotation.x = -1.05;
  tail.position.set(0, 0.66, -0.66);

  g.add(body, chest, neck, head, snout, ears, legs, tail);

  if (alpha) {
    // The pack mechanic is unplayable if you cannot tell at a glance which one
    // is the leader — bigger and darker is not enough at distance, in a fight,
    // with several of them moving. Sat ON the shoulders rather than floating
    // above them, so it reads as part of the animal and not as a UI marker.
    const crest = shadowed(new T.Mesh(new T.BoxGeometry(0.075, 0.26, 0.38), mat(0xf0b829, 0.4)));
    crest.material.emissive = new T.Color(0x4a3200);
    crest.position.set(0, 0.86, 0.28);
    g.add(crest);
    g.userData.crest = crest;
  }

  g.userData.body = body;
  g.userData.legs = legs;
  g.userData.coat = coat;      // one material per wolf, so a flash is its own
  g.userData.baseCoat = coat.color.clone();
  return g;
}

function buildDummyMesh() {
  const g = new T.Group();
  const post = shadowed(new T.Mesh(new T.CylinderGeometry(0.12, 0.14, 1.9, 10), mat(0x6b5334, 0.95)));
  post.position.y = 0.95;
  const torso = shadowed(new T.Mesh(new T.CapsuleGeometry(0.34, 0.5, 6, 12), mat(0x8d6f45, 0.95)));
  torso.position.y = 1.25;
  const arms = shadowed(new T.Mesh(new T.BoxGeometry(1.5, 0.16, 0.16), mat(0x6b5334, 0.95)));
  arms.position.y = 1.42;
  g.add(post, torso, arms);
  return g;
}

// ───────────────────────────────────────────────────── the condition bar
//
// The naming system asks the player to notice a creature is about to break and
// to STOP HITTING IT. Without a reading of how close it is, that is not a
// decision — it is luck, and the mechanic the whole design is built on becomes
// a surprise that happens to you.
//
// The gold tick is the point of the whole thing: it marks where the creature
// collapses instead of dying. Everything left of it is a wolf you can still
// take alive.
function buildConditionBar() {
  const g = new T.Group();
  const plane = (color, opacity) => {
    const m = new T.Sprite(new T.SpriteMaterial({
      color, transparent: true, opacity, depthTest: false, sizeAttenuation: true,
    }));
    // Anchored left so the fill shrinks from the right, the way a wound reads.
    m.center.set(0, 0.5);
    return m;
  };

  const back = plane(0x14181d, 0.72);
  back.scale.set(1.0, 0.10, 1);
  back.position.x = -0.5;

  const fill = plane(0xb8352c, 0.95);
  fill.scale.set(1.0, 0.10, 1);
  fill.position.set(-0.5, 0, 0);
  fill.renderOrder = 2;

  const tick = plane(0xf0b829, 1);
  tick.scale.set(0.035, 0.17, 1);
  tick.renderOrder = 3;

  back.renderOrder = 1;
  g.add(back, fill, tick);
  g.userData = { back, fill, tick };
  g.visible = false;
  return g;
}

/**
 * Drives one bar. Hidden at full health so an untouched wolf carries no UI, and
 * held visible once hurt — a bar that faded out mid-fight would hide exactly
 * the information the fight is about.
 */
function updateConditionBar(bar, health, collapseAt, down) {
  const pct = Math.max(0, health.health / health.maxHealth);
  if (pct >= 0.999 && !down) { bar.visible = false; return; }
  bar.visible = true;

  const width = 1.0;
  const { fill, tick } = bar.userData;
  fill.scale.x = Math.max(0.001, width * pct);
  // Turns gold as it enters the window, so the moment to stop is a colour
  // change and not a number anybody has to read mid-fight.
  fill.material.color.setHex(down ? 0xf0b829 : pct <= collapseAt * 1.6 ? 0xd98324 : 0xb8352c);
  tick.position.x = -0.5 + width * collapseAt;
}
