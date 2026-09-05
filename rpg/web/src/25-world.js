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
//
// Overcast late afternoon on a northern moor. Committed to one time of day on
// purpose: a scene lit for "any time" is lit for none, and the long low sun is
// what gives primitives a readable silhouette and a shadow you can judge
// distance by.
renderer.toneMapping = T.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const sun = new T.DirectionalLight(0xfff3e2, 2.5);
sun.position.set(18, 22, -14);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 90;
const shadowSpan = 30;
sun.shadow.camera.left = -shadowSpan;
sun.shadow.camera.right = shadowSpan;
sun.shadow.camera.top = shadowSpan;
sun.shadow.camera.bottom = -shadowSpan;
sun.shadow.bias = -0.0009;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

// Carries the shadowed side. Without a strong sky term everything not facing
// the sun goes to near-black, which is what made the first build unreadable.
scene.add(new T.HemisphereLight(0xbcd0e4, 0x54522f, 1.55));
scene.add(new T.AmbientLight(0xffffff, 0.22));

// A cool fill from behind, so a body never dissolves into the ground it is
// standing on. Cheap: one more directional light, no shadows.
const rim = new T.DirectionalLight(0x9fb6d4, 0.55);
rim.position.set(-14, 9, 16);
scene.add(rim);

// ───────────────────────────────────────────────────────────── the sky
//
// A gradient dome rather than a flat clear colour. It costs one sphere and it
// is the single largest change to how the scene reads: a flat backdrop makes
// the ground look like a disc floating in paint, and a horizon that warms
// towards the sun makes it a place with weather in it.
// Measured by rendering: the first pass used a sand-coloured haze, and since
// everything at distance lerps toward the fog colour, the whole frame came out
// sepia. Cool and desaturated instead — the warmth belongs in the sunlit faces,
// not in the air.
const SKY_TOP = new T.Color(0x4d6b8c);
const SKY_MID = new T.Color(0x8fa4b4);
const SKY_LOW = new T.Color(0xbcc4c3);

scene.add(new T.Mesh(
  new T.SphereGeometry(260, 24, 16),
  new T.ShaderMaterial({
    side: T.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: SKY_TOP }, mid: { value: SKY_MID }, low: { value: SKY_LOW },
    },
    vertexShader: `
      varying float h;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        h = normalize(world.xyz).y;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: `
      uniform vec3 top, mid, low;
      varying float h;
      void main() {
        float t = clamp(h, 0.0, 1.0);
        // Two stops rather than one: a single lerp from zenith to horizon
        // reads as a colour ramp, and a band of haze low down reads as air.
        vec3 c = mix(low, mid, smoothstep(0.0, 0.22, t));
        c = mix(c, top, smoothstep(0.16, 0.75, t));
        gl_FragColor = vec4(c, 1.0);
      }`,
  })
));

// Matched to the haze at the bottom of the dome, so distance dissolves into
// the sky instead of stopping against it.
scene.fog = new T.Fog(0xbcc4c3, 58, 195);
renderer.setClearColor(0xbcc4c3);

// ───────────────────────────────────────────────────────────── the ground
//
// A flat colour reads as a green disc. The texture below is generated rather
// than loaded because the whole game has to stay one file with nothing to
// fetch — and mottling at two scales is what stops a plane from looking like
// a plane: coarse patches give the eye something to measure distance against,
// fine grain keeps it from banding up close.
function groundTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  let seed = 987654321;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

  g.fillStyle = '#6f7a52';
  g.fillRect(0, 0, S, S);

  // Coarse patches of drier and greener ground.
  for (let i = 0; i < 90; i++) {
    const r = 12 + rnd() * 46;
    g.fillStyle = rnd() < 0.5
      ? `rgba(122,124,78,${0.10 + rnd() * 0.16})`
      : `rgba(84,96,62,${0.10 + rnd() * 0.18})`;
    g.beginPath();
    g.arc(rnd() * S, rnd() * S, r, 0, Math.PI * 2);
    g.fill();
  }
  // Fine grain.
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = rnd() < 0.5
      ? `rgba(58,66,44,${0.05 + rnd() * 0.14})`
      : `rgba(148,148,104,${0.04 + rnd() * 0.12})`;
    g.fillRect(rnd() * S, rnd() * S, 1 + rnd() * 2, 1 + rnd() * 2);
  }

  const tex = new T.CanvasTexture(c);
  tex.wrapS = tex.wrapT = T.RepeatWrapping;
  tex.repeat.set(26, 26);
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  tex.colorSpace = T.SRGBColorSpace;
  return tex;
}

const ground = new T.Mesh(
  new T.CircleGeometry(CFG.world.groundRadius, 72).rotateX(-Math.PI / 2),
  new T.MeshStandardMaterial({ map: groundTexture(), roughness: 0.98, metalness: 0 })
);
ground.receiveShadow = true;
scene.add(ground);

// ───────────────────────────────────────────────── what grows on it
//
// All instanced: one draw call each, however many there are. Scatter is what
// turns a surface into a place, and it is also what makes RUNNING legible —
// on a bare plane a sprint reads as standing still.
(() => {
  let seed = 20260905;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const R = CFG.world.groundRadius;
  const m = new T.Matrix4(), q = new T.Quaternion(), sc = new T.Vector3(), p = new T.Vector3();
  const e = new T.Euler();

  const place = (mesh, i, x, y, z, ry, s, sy = s) => {
    p.set(x, y, z);
    q.setFromEuler(e.set(0, ry, 0));
    sc.set(s, sy, s);
    mesh.setMatrixAt(i, m.compose(p, q, sc));
  };

  // ── rocks ──
  // Small and low. The camera has no collision with scenery, and the first
  // pass allowed boulders up to 1.2m anywhere from 9m out — so one of them sat
  // between the camera and the player and filled a third of the screen. Keeping
  // them under knee height means the worst case is something the eye skips over
  // rather than a wall.
  const ROCKS = 150;
  const rocks = new T.InstancedMesh(
    new T.IcosahedronGeometry(1, 0),
    new T.MeshStandardMaterial({ color: 0x8b8b81, roughness: 0.95, flatShading: true }), ROCKS);
  for (let i = 0; i < ROCKS; i++) {
    const a = rnd() * Math.PI * 2, r = 6 + Math.sqrt(rnd()) * (R - 8);
    const s = 0.16 + rnd() * 0.5;
    p.set(Math.cos(a) * r, s * 0.26, Math.sin(a) * r);
    q.setFromEuler(e.set(rnd() * 3, rnd() * 6, rnd() * 3));
    sc.set(s, s * 0.52, s * (0.8 + rnd() * 0.5));
    rocks.setMatrixAt(i, m.compose(p, q, sc));
  }
  rocks.castShadow = true; rocks.receiveShadow = true;
  scene.add(rocks);

  // ── grass tufts: three crossed blades, so they read from any angle ──
  // Shorter, wider and far more of them — and CLUMPED. Scattered evenly at the
  // old density they read as isolated sticks stuck in a lawn, because that is
  // exactly what one every ten metres is. Grass grows in patches, and patches
  // are also what give the ground a texture the eye can measure speed against.
  // Thin. At 0.16 wide a blade is nearly square and reads at distance as a
  // scattering of green rectangles — litter rather than grass.
  const blade = new T.PlaneGeometry(0.055, 0.32).translate(0, 0.16, 0);
  const tuft = mergeRotated(blade, [0, Math.PI / 3, -Math.PI / 3]);
  const COUNT = 7000, CLUMPS = 230;
  const grass = new T.InstancedMesh(
    tuft,
    new T.MeshStandardMaterial({
      // Close to the ground it grows out of, so a clump reads as texture on the
      // surface rather than as objects sitting on top of it.
      color: 0x6d7a48, roughness: 1, side: T.DoubleSide,
    }), COUNT);
  let put = 0;
  for (let c = 0; c < CLUMPS && put < COUNT; c++) {
    const ca = rnd() * Math.PI * 2, cr = Math.sqrt(rnd()) * (R - 6);
    const cx = Math.cos(ca) * cr, cz = Math.sin(ca) * cr;
    // Tight clumps read as tussocks; wide ones read as a handful of sticks
    // thrown on the floor. Same blade count, a third of the radius.
    const spread = 0.35 + rnd() * 0.85;
    const n = Math.min(COUNT - put, 18 + Math.floor(rnd() * 34));
    for (let i = 0; i < n; i++, put++) {
      const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * spread;
      const sz = 0.65 + rnd() * 0.85;
      place(grass, put, cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r,
            rnd() * 6.3, sz, sz * (0.7 + rnd() * 0.7));
    }
  }
  // Unused instances are parked below the ground at zero scale, not left at the
  // identity matrix, which would stack a pile of tufts at the origin.
  for (; put < COUNT; put++) place(grass, put, 0, -50, 0, 0, 0.0001);
  // No shadows on grass: 1500 casters is the difference between a smooth fight
  // and a slideshow, and nobody has ever noticed a blade of grass's shadow.
  scene.add(grass);

  // ── trees, out at the edges: silhouette and a sense of enclosure ──
  const TREES = 42;
  const trunks = new T.InstancedMesh(
    new T.CylinderGeometry(0.13, 0.22, 3.4, 6).translate(0, 1.7, 0),
    new T.MeshStandardMaterial({ color: 0x4a3d30, roughness: 0.95 }), TREES);
  const crowns = new T.InstancedMesh(
    new T.ConeGeometry(1.5, 3.6, 7).translate(0, 4.3, 0),
    new T.MeshStandardMaterial({ color: 0x46543a, roughness: 0.95, flatShading: true }), TREES);
  for (let i = 0; i < TREES; i++) {
    // Ringed near the rim, so they frame the field without standing in a fight.
    // Brought inside the fog line. At 0.74R and beyond almost every tree sat
    // past where the haze starts, so the horizon read as empty.
    const a = rnd() * Math.PI * 2, r = R * (0.42 + rnd() * 0.54);
    const s = 0.75 + rnd() * 0.75;
    const x = Math.cos(a) * r, z = Math.sin(a) * r, ry = rnd() * 6.3;
    place(trunks, i, x, 0, z, ry, s, s * (0.85 + rnd() * 0.4));
    place(crowns, i, x, 0, z, ry, s, s * (0.85 + rnd() * 0.4));
  }
  trunks.castShadow = true; crowns.castShadow = true;
  scene.add(trunks, crowns);
})();

/**
 * Copies a geometry at several Y rotations into one buffer. Three crossed
 * quads make a tuft that reads as grass from any direction, and doing it here
 * means it is still ONE instanced draw call rather than three.
 */
function mergeRotated(geo, angles) {
  const src = geo.toNonIndexed();
  const pos = src.attributes.position.array;
  const nrm = src.attributes.normal.array;
  const uv = src.attributes.uv.array;
  const n = pos.length / 3;
  const P = new Float32Array(n * 3 * angles.length);
  const N = new Float32Array(n * 3 * angles.length);
  const U = new Float32Array(n * 2 * angles.length);
  angles.forEach((a, k) => {
    const c = Math.cos(a), s = Math.sin(a);
    for (let i = 0; i < n; i++) {
      const o = (k * n + i) * 3, j = i * 3;
      P[o] = pos[j] * c + pos[j + 2] * s;
      P[o + 1] = pos[j + 1];
      P[o + 2] = -pos[j] * s + pos[j + 2] * c;
      N[o] = nrm[j] * c + nrm[j + 2] * s;
      N[o + 1] = nrm[j + 1];
      N[o + 2] = -nrm[j] * s + nrm[j + 2] * c;
      U[(k * n + i) * 2] = uv[i * 2];
      U[(k * n + i) * 2 + 1] = uv[i * 2 + 1];
    }
  });
  const out = new T.BufferGeometry();
  out.setAttribute('position', new T.BufferAttribute(P, 3));
  out.setAttribute('normal', new T.BufferAttribute(N, 3));
  out.setAttribute('uv', new T.BufferAttribute(U, 2));
  return out;
}

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
