(() => {
"use strict";
const T = THREE;

// ─────────────────────────────────────────────────────────── tuning
const CFG = {
  gravity:      -26,
  moveSpeed:    7.6,
  turnLerp:     11,
  grabRadius:   13,
  maxHeld:      7,

  // The carry wheel is a halo ABOVE the character. "Behind the character" is
  // the wrong place for it: the camera is also behind the character, so a
  // rearward wheel lands between the lens and the hero and fills the screen.
  // Overhead is the only offset that is clear of both the hero and the
  // crosshair from every yaw.
  wheelBack:    0.0,
  wheelHeight:  5.9,
  wheelSingle:  1.5,     // tight wheel in single-target mode
  wheelAoe:     2.5,     // wide wheel in burst mode
  wheelSpin:    1.7,
  liftSpring:   16,
  liftDamp:     7,

  throwSpeed:   40,
  killSpeed:    13,
  seekTurn:     3.0,     // rad/s the stone can bend toward its mark
  seekTime:     1.5,     // how long guidance lasts
  seekGrav:     0.25,    // gravity multiplier while guided

  throwCost:    0.085,   // focus spent PER STONE thrown; holding is free
  focusRegen:   0.34,
  gatherFloor:  0.15,    // need at least this much focus to gather

  modeCooldown: 10,

  jumpV:        11.5,    // launch speed; ~1.3s hang time under this gravity
  airControl:   0.55,    // fraction of ground steering kept mid-air
  dodgeHeight:  1.7,     // above this, a walker's swipe passes under you
  dashSpeed:    26,
  dashTime:     0.17,
  dashCd:       1.3,

  restitution:  0.34,
  arena:        34,
  zSpeed:       2.05,
  zReach:       1.7,
  zCooldown:    1.15,
  maxHealth:    5,
  aimCone:      0.972,
  singleMul:    1.4,     // precision bonus: one deliberate, heavy shot
  burstMul:     0.6,     // each burst projectile hits softer, but spreads
  weakMul:      2.0,     // head hit
  burstCone:    0.72,
  repulseR:     13,
  repulseCd:    8,    // how wide burst will spread to find separate marks
};

const el = id => document.getElementById(id);
const clamp = (v,a,b) => v<a?a:v>b?b:v;
const rand = (a,b) => a + Math.random()*(b-a);

// ─────────────────────────────────────────────────────────── renderer
const canvas = el("gl");
const renderer = new T.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
// Bloom re-renders the scene at reduced resolution several times, so the
// device pixel ratio is capped lower here than it was without it.
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = T.PCFSoftShadowMap;
renderer.toneMapping = T.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new T.Scene();
scene.background = new T.Color(0x0b1310);
scene.fog = new T.Fog(0x0b1310, 26, 72);
const camera = new T.PerspectiveCamera(62, 1, 0.1, 200);

// Threshold sits above the diffuse range, so only genuinely hot things —
// the psychic light, walker eyes, guided stones — actually bleed.
const composer = new PP.EffectComposer(renderer);
composer.addPass(new PP.RenderPass(scene, camera));
const bloom = new PP.UnrealBloomPass(new T.Vector2(1, 1), 0.68, 0.5, 0.82);
composer.addPass(bloom);
composer.addPass(new PP.OutputPass());

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  bloom.setSize(w, h);
  camera.aspect = w / h;
  camera.fov = w < h ? 74 : 62;
  camera.updateProjectionMatrix();
  el("rotate").classList.toggle("show", h > w * 1.15 && S.phase !== "menu");
}
addEventListener("resize", resize);
addEventListener("orientationchange", () => setTimeout(resize, 250));

// ─────────────────────────────────────────────────────────── lighting
scene.add(new T.HemisphereLight(0x53709a, 0x27301c, 1.25));
const sun = new T.DirectionalLight(0xc3d8f5, 2.1);   // moonlight through the canopy
sun.position.set(14, 22, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.02;
// Tighter frustum over the same map size = sharper contact shadows. The
// light follows the hero, so a wide arena still stays covered.
Object.assign(sun.shadow.camera, { left:-22, right:22, top:22, bottom:-22, near:1, far:60 });
scene.add(sun);

// Cool rim from behind: separates silhouettes from a very dark ground,
// which is what stops walkers vanishing into the backdrop at range.
const rim = new T.DirectionalLight(0x7fd0a0, 1.0);
rim.position.set(-12, 9, -14);
scene.add(rim);
const psi = new T.PointLight(0xe94fbf, 0, 24, 2);
scene.add(psi);

// ─────────────────────────────────────────────────────────── woods
const groundMat = new T.MeshStandardMaterial({ color: 0x33402a, roughness: 1.0 });
const ground = new T.Mesh(new T.CircleGeometry(CFG.arena + 26, 96), groundMat);
ground.rotation.x = -Math.PI/2; ground.receiveShadow = true;
scene.add(ground);

// A worn clearing floor, slightly lighter than the forest bed, so the
// playable circle reads as a place rather than an invisible rule.
const clearing = new T.Mesh(new T.CircleGeometry(CFG.arena, 72),
  new T.MeshStandardMaterial({ color: 0x46512f, roughness: 1.0 }));
clearing.rotation.x = -Math.PI/2; clearing.position.y = 0.015;
clearing.receiveShadow = true;
scene.add(clearing);

// Trees are instanced: ~200 trunks and 400 foliage blobs would be 600 draw
// calls as separate meshes, and 3 as instances.
const TREES = 210;
const trunkMat = new T.MeshStandardMaterial({ color: 0x3b2f26, roughness: 0.95 });
const foliaA   = new T.MeshStandardMaterial({ color: 0x24401f, roughness: 0.95, flatShading: true });
const foliaB   = new T.MeshStandardMaterial({ color: 0x2f5228, roughness: 0.95, flatShading: true });

const trunks = new T.InstancedMesh(new T.CylinderGeometry(0.26, 0.46, 1, 6), trunkMat, TREES);
const canopy1 = new T.InstancedMesh(new T.IcosahedronGeometry(1, 0), foliaA, TREES);
const canopy2 = new T.InstancedMesh(new T.IcosahedronGeometry(1, 0), foliaB, TREES);
trunks.castShadow = canopy1.castShadow = canopy2.castShadow = true;
trunks.receiveShadow = canopy1.receiveShadow = canopy2.receiveShadow = true;

const M = new T.Matrix4(), Q = new T.Quaternion(), Vp = new T.Vector3(), Vs = new T.Vector3();
for (let i = 0; i < TREES; i++) {
  // Ring the clearing, thickening outward, so the player is walled in by
  // woods without a single tree standing inside the fight.
  const a = rand(0, Math.PI*2);
  const d = CFG.arena + 2.5 + Math.pow(Math.random(), 0.65) * 23;
  const x = Math.cos(a)*d, z = Math.sin(a)*d;
  const h = rand(7, 15), lean = rand(-0.06, 0.06);

  Q.setFromEuler(new T.Euler(lean, rand(0, 6.28), lean));
  M.compose(Vp.set(x, h/2, z), Q, Vs.set(rand(0.8,1.3), h, rand(0.8,1.3)));
  trunks.setMatrixAt(i, M);

  const r1 = rand(1.9, 3.2);
  Q.setFromEuler(new T.Euler(rand(0,1), rand(0,6.28), rand(0,1)));
  M.compose(Vp.set(x, h*0.82, z), Q, Vs.set(r1, r1*rand(0.7,1.0), r1));
  canopy1.setMatrixAt(i, M);

  const r2 = r1 * rand(0.6, 0.85);
  Q.setFromEuler(new T.Euler(rand(0,1), rand(0,6.28), rand(0,1)));
  M.compose(Vp.set(x + rand(-1,1), h*0.62, z + rand(-1,1)), Q, Vs.set(r2, r2*0.8, r2));
  canopy2.setMatrixAt(i, M);
}
scene.add(trunks, canopy1, canopy2);

// Undergrowth inside the clearing: purely decorative and kept low, so it
// dresses the floor without ever blocking a stone or a walker.
const SCRUB = 64;
const scrubMat = new T.MeshStandardMaterial({ color: 0x1d3018, roughness: 1, flatShading: true });
const scrub = new T.InstancedMesh(new T.IcosahedronGeometry(1, 0), scrubMat, SCRUB);
scrub.receiveShadow = true;
for (let i = 0; i < SCRUB; i++) {
  const a = rand(0, Math.PI*2), d = Math.sqrt(Math.random()) * (CFG.arena - 2);
  const s = rand(0.5, 1.25);
  Q.setFromEuler(new T.Euler(0, rand(0,6.28), 0));
  // Wide and very flat: a tuft, not a boulder.
  M.compose(Vp.set(Math.cos(a)*d, 0.06, Math.sin(a)*d), Q, Vs.set(s*1.9, s*0.22, s*1.9));
  scrub.setMatrixAt(i, M);
}
scene.add(scrub);

// Solid cover inside the clearing. Until now the arena floor was empty and
// the treeline purely decorative, so there was nothing to slam anything
// INTO — which is half of what environmental combat means.
const obstacles = [];
const boleMat  = new T.MeshStandardMaterial({ color: 0x4a3b2c, roughness: 0.95 });
const stoneMat = new T.MeshStandardMaterial({ color: 0x8d9199, roughness: 0.9, flatShading: true });

function addObstacle(x, z, r, h, kind) {
  const mesh = kind === "stone"
    ? new T.Mesh(new T.DodecahedronGeometry(r*1.15, 0), stoneMat)
    : new T.Mesh(new T.CylinderGeometry(r*0.85, r*1.1, h, 7), boleMat);
  mesh.position.set(x, h/2, z);
  if (kind === "stone") { mesh.position.y = r*0.75; mesh.rotation.set(rand(0,1), rand(0,6), rand(0,1)); }
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  obstacles.push({ pos: new T.Vector3(x, 0, z), r, h, mesh });
}
// Cover has to be hittable without becoming a wall between the player and
// the fight. A first pass put 15 obstacles from 0.3x arena radius outward,
// including boulders the size of a house directly in the firing line; most
// throws hit scenery and the kill rate collapsed. Fewer, smaller, and held
// out past the middle where the player actually stands.
for (let i = 0; i < 6; i++) {
  const a = (i/6)*Math.PI*2 + rand(-0.35,0.35), d = rand(CFG.arena*0.58, CFG.arena*0.9);
  addObstacle(Math.cos(a)*d, Math.sin(a)*d, rand(0.6,0.85), rand(5,8), "tree");
}
for (let i = 0; i < 4; i++) {
  const a = (i/4)*Math.PI*2 + rand(-0.6,0.6), d = rand(CFG.arena*0.55, CFG.arena*0.85);
  addObstacle(Math.cos(a)*d, Math.sin(a)*d, rand(0.7,1.0), 1.9, "stone");
}

// Fallen logs, a few, for silhouette interest at ground level.
const logMat = new T.MeshStandardMaterial({ color: 0x342a22, roughness: 1 });
for (let i = 0; i < 7; i++) {
  const a = rand(0, Math.PI*2), d = rand(CFG.arena*0.45, CFG.arena-3);
  const L = new T.Mesh(new T.CylinderGeometry(0.34, 0.42, rand(3,6), 6), logMat);
  L.position.set(Math.cos(a)*d, 0.36, Math.sin(a)*d);
  L.rotation.set(Math.PI/2, 0, rand(0, 6.28));
  L.rotation.z = rand(0, 6.28);
  L.castShadow = L.receiveShadow = true;
  scene.add(L);
}

// Fireflies. Same trick as the old dust, but warm and drifting low, which
// is what sells "woods at night" more than any amount of tree geometry.
const moteN = 260, motePos = new Float32Array(moteN*3);
for (let i = 0; i < moteN; i++) {
  const a = rand(0, Math.PI*2), d = Math.sqrt(Math.random()) * (CFG.arena + 12);
  motePos[i*3]   = Math.cos(a)*d;
  motePos[i*3+1] = rand(0.5, 6);
  motePos[i*3+2] = Math.sin(a)*d;
}
const moteGeo = new T.BufferGeometry();
moteGeo.setAttribute("position", new T.BufferAttribute(motePos, 3));
const motes = new T.Points(moteGeo, new T.PointsMaterial({
  color: 0xd8e878, size: 0.13, transparent: true, opacity: 0.85,
  depthWrite: false, sizeAttenuation: true }));
scene.add(motes);

// ─────────────────────────────────────────────────────────── hero
const HERO = new T.Group();
scene.add(HERO);

const skin   = new T.MeshStandardMaterial({ color: 0xd8b49a, roughness: 0.8 });
const cloak  = new T.MeshStandardMaterial({ color: 0x232b33, roughness: 0.92, flatShading: true });
const under  = new T.MeshStandardMaterial({ color: 0x39424c, roughness: 0.9 });
const leather= new T.MeshStandardMaterial({ color: 0x4a3524, roughness: 0.85 });
const trim   = new T.MeshStandardMaterial({ color: 0xe94fbf, roughness: 0.35,
                                            emissive: 0xe94fbf, emissiveIntensity: 0.5 });

function part(geo, mat, x, y, z) {
  const m = new T.Mesh(geo, mat);
  m.position.set(x,y,z); m.castShadow = true;
  return m;
}

// Torso tapers: a cone frustum reads as a body under a cloak far better
// than a capsule, which always looks like a pill.
HERO.add(part(new T.CylinderGeometry(0.30, 0.40, 0.95, 8), under, 0, 1.32, 0));
// Cloak skirt, flared and faceted.
const cloakSkirt = part(new T.CylinderGeometry(0.42, 0.72, 0.95, 8, 1, true), cloak, 0, 1.12, 0);
cloakSkirt.material.side = T.DoubleSide;
HERO.add(cloakSkirt);
// Shoulder mantle.
HERO.add(part(new T.CylinderGeometry(0.50, 0.34, 0.34, 8), cloak, 0, 1.80, 0));

// Head with a hood: sphere for the skull, a wider faceted shell over it,
// leaving the face in shadow so the visor is the only feature that reads.
HERO.add(part(new T.SphereGeometry(0.235, 16, 12), skin, 0, 2.06, 0));
const hood = part(new T.SphereGeometry(0.31, 10, 8), cloak, 0, 2.10, -0.04);
hood.scale.set(1, 1.05, 1.12);
HERO.add(hood);
const visor = part(new T.BoxGeometry(0.34, 0.075, 0.06), trim, 0, 2.05, 0.235);
HERO.add(visor);

// Belt + chest strap in leather, with a glowing focus stone at the sternum.
HERO.add(part(new T.CylinderGeometry(0.41, 0.41, 0.11, 8), leather, 0, 1.02, 0));
const strap = part(new T.BoxGeometry(0.13, 0.66, 0.42), leather, -0.07, 1.45, 0);
strap.rotation.z = 0.28;
HERO.add(strap);
HERO.add(part(new T.OctahedronGeometry(0.10, 0), trim, 0.02, 1.62, 0.30));

function limb(parent, len, mat, px, py, pz, rad = 0.115, endMat) {
  const pivot = new T.Group();
  pivot.position.set(px,py,pz);
  pivot.add(part(new T.CapsuleGeometry(rad, len, 5, 9), mat, 0, -len/2-0.05, 0));
  // A blob at the end of the limb: hands and boots stop the arms looking
  // like sticks, which is most of what "unfinished model" reads as.
  if (endMat) {
    const end = part(new T.SphereGeometry(rad*1.5, 8, 6), endMat, 0, -len-0.1, 0);
    end.scale.set(1, 0.85, 1.15);
    pivot.add(end);
  }
  parent.add(pivot);
  return pivot;
}
const armL = limb(HERO, 0.52, under, -0.45, 1.74, 0, 0.105, skin);
const armR = limb(HERO, 0.52, under,  0.45, 1.74, 0, 0.105, skin);
const legL = limb(HERO, 0.58, under, -0.17, 0.95, 0, 0.125, leather);
const legR = limb(HERO, 0.58, under,  0.17, 0.95, 0, 0.125, leather);

const aura = new T.Mesh(new T.SphereGeometry(1.55,22,16),
  new T.MeshBasicMaterial({ color:0xe94fbf, transparent:true, opacity:0, side:T.BackSide }));
aura.position.y = 1.3;
HERO.add(aura);

const hero = { pos: new T.Vector3(0,0,0), yaw: 0, walk: 0, hp: CFG.maxHealth,
               vy: 0, grounded: true };

// Dash ghosts: a handful of reusable translucent bodies, faded along the
// dash path. Cloning the whole rig per frame would be far more expensive.
const ghostMat = new T.MeshBasicMaterial({ color: 0xe94fbf, transparent: true,
                                           opacity: 0, depthWrite: false });
const ghosts = [];
for (let i = 0; i < 6; i++) {
  const m = new T.Mesh(new T.CapsuleGeometry(0.36, 0.9, 4, 8), ghostMat.clone());
  m.visible = false;
  scene.add(m);
  ghosts.push({ mesh: m, life: 0 });
}
function pushGhost() {
  const gh = ghosts.find(x => x.life <= 0) || ghosts[0];
  gh.mesh.position.set(hero.pos.x, hero.pos.y + 1.4, hero.pos.z);
  gh.mesh.rotation.y = hero.yaw;
  gh.mesh.visible = true;
  gh.life = 0.34;
}

// ─────────────────────────────────────────────────────────── objects
// Everything throwable is described here rather than in code, so a new
// prop is a table entry and not a new branch in the physics loop.
//
//   dmg      damage at full throw speed; scales with actual impact speed
//   mass     heavier is slower to haul and harder to fling
//   pierce   how many bodies it passes through before stopping
//   knock    knockback multiplier applied on hit
//   explode  detonates on impact: {r, dmg}
//   puddle   leaves a damaging area: {r, dps, life}
//   speedMul multiplier on launch speed
const OBJECTS = {
  rock:   { name:"Rock",    dmg:100, mass:1.0, knock:1.0, count:10,
            size:[0.42,0.72], color:0xc9c2b4 },
  heavy:  { name:"Boulder", dmg:265, mass:3.4, knock:2.6, count:2,
            size:[1.00,1.30], color:0x8d8880 },
  plank:  { name:"Plank",   dmg:62,  mass:0.55, knock:2.0, pierce:3, count:3,
            size:[0.55,0.75], color:0x7a5330, shape:"plank", speedMul:1.15 },
  barrel: { name:"Barrel",  dmg:30,  mass:1.2, knock:1.0, count:4,
            size:[0.62,0.62], color:0xc4562e, shape:"barrel",
            explode:{ r:7.5, dmg:190 }, emissive:0x5a1a08 },
  chem:   { name:"Chem",    dmg:24,  mass:1.2, knock:0.8, count:2,
            size:[0.62,0.62], color:0x8ada4e, shape:"barrel",
            puddle:{ r:5.0, dps:70, life:7 }, emissive:0x2f6b18 },
  metal:  { name:"Girder",  dmg:150, mass:1.7, knock:1.6, pierce:2, count:3,
            size:[0.5,0.7], color:0xa9b6c6, shape:"plank", speedMul:1.4 },
};

const rockMat = new T.MeshStandardMaterial({ color:0xc9c2b4, roughness:0.85, flatShading:true });
const heldMat = new T.MeshStandardMaterial({ color:0xc98fb8, roughness:0.6, flatShading:true,
                                             emissive:0xe94fbf, emissiveIntensity:0.55 });
const seekMat = new T.MeshStandardMaterial({ color:0xffb0a0, roughness:0.5, flatShading:true,
                                             emissive:0xff5a3c, emissiveIntensity:0.85 });
const matCache = {};
function matFor(key, def) {
  if (!matCache[key]) matCache[key] = new T.MeshStandardMaterial({
    color: def.color, roughness: 0.85, flatShading: true,
    emissive: def.emissive || 0x000000, emissiveIntensity: def.emissive ? 0.7 : 0 });
  return matCache[key];
}

const rocks = [];

function geomFor(def, r) {
  if (def.shape === "plank")  return new T.BoxGeometry(r*0.45, r*0.42, r*3.4);
  if (def.shape === "barrel") return new T.CylinderGeometry(r, r, r*2.3, 9);
  const geo = new T.IcosahedronGeometry(r, 1);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const s2 = rand(0.82,1.2);
    p.setXYZ(i, p.getX(i)*s2, p.getY(i)*s2, p.getZ(i)*s2);
  }
  geo.computeVertexNormals();
  return geo;
}

// Move a spent or stranded prop back into play near the player. Keeps the
// object count bounded (good for the physics loop) while guaranteeing there
// is always something to pick up.
function recycleObject(o) {
  const a = rand(0, Math.PI*2), d = rand(7, CFG.grabRadius - 1.5);
  o.pos.set(hero.pos.x + Math.cos(a)*d, o.r + 6, hero.pos.z + Math.sin(a)*d);
  const lim = CFG.arena - 3;
  const hd = Math.hypot(o.pos.x, o.pos.z);
  if (hd > lim) { o.pos.x *= lim/hd; o.pos.z *= lim/hd; }
  o.vel.set(0, 0, 0);
  o.gone = false; o.held = false; o.pierced = 0; o.seekT = 0; o.seek = null;
  o.mesh.visible = true;
  o.mesh.material = matFor(o.key, o.def);
  o.restT = 0;
}

function spawnObject(key, x, z) {
  const def = OBJECTS[key];
  const r = rand(def.size[0], def.size[1]);
  const mesh = new T.Mesh(geomFor(def, r), matFor(key, def));
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  rocks.push({
    mesh, r, key, def,
    pos: new T.Vector3(x, r, z), vel: new T.Vector3(),
    spin: new T.Vector3(rand(-1,1), rand(-1,1), rand(-1,1)),
    m: def.mass * r*r*r * 3.4,
    held:false, slot:0, seek:null, seekT:0, pierced:0, gone:false, restT:0, mult:1,
    hostile:0, grabT:0, boostT:0, boostTo:0, launchDir:new T.Vector3(0,0,1),
  });
}

const zSkin  = new T.MeshStandardMaterial({ color:0x7d8f66, roughness:1.0, flatShading:true });
const zRot   = new T.MeshStandardMaterial({ color:0x76866a, roughness:1.0, flatShading:true });
const zRag   = new T.MeshStandardMaterial({ color:0x55503f, roughness:1.0, flatShading:true,
                                            side:T.DoubleSide });
const zEye   = new T.MeshBasicMaterial({ color:0xff6a30 });
const zJaw   = new T.MeshStandardMaterial({ color:0x8a3b32, roughness:0.9 });
// Archetypes are a table for the same reason objects are: a new enemy
// should be an entry, not a new branch in the AI loop.
//
//   armor    flat reduction applied BEFORE hp loss; heavy props punch it,
//            light ones bounce off — this is what makes prop choice matter
//   onDeath  "blast" detonates when killed
//   leap     closes distance in bursts instead of a steady walk
const ENEMIES = {
  walker:  { name:"Walker",  hp:100, speed:2.05, scale:1.00, bulk:1.00,
             skin:0x7d8f66, eye:0xff6a30, score:100 },
  runner:  { name:"Runner",  hp:55,  speed:4.70, scale:0.94, bulk:0.80,
             skin:0x93a86a, eye:0xffd23c, score:130 },
  crawler: { name:"Crawler", hp:45,  speed:3.10, scale:0.58, bulk:1.10,
             skin:0x6b7d55, eye:0xff9a30, score:120 },
  tank:    { name:"Tank",    hp:430, speed:1.25, scale:1.42, bulk:1.45,
             skin:0x5f6f4b, eye:0xff3c2a, armor:38, score:400 },
  armored: { name:"Armored", hp:170, speed:1.85, scale:1.10, bulk:1.20,
             skin:0x8d94a0, eye:0xff5a3c, armor:62, score:300 },
  exploder:{ name:"Exploder",hp:70,  speed:2.55, scale:1.05, bulk:1.25,
             skin:0xb06a3c, eye:0xffc23c, onDeath:"blast", score:180 },
  leaper:  { name:"Leaper",  hp:85,  speed:2.30, scale:0.98, bulk:0.88,
             skin:0x6f8f7a, eye:0x6affc0, leap:true, score:200 },
};

// Waves introduce a mechanic rather than a bigger number. Anything past the
// table repeats the last row with a scaling multiplier.
const WAVES = [
  { walker:5 },
  { walker:4, runner:3 },
  { walker:4, runner:2, crawler:3 },
  { walker:3, runner:3, exploder:2 },
  { walker:4, runner:3, armored:2 },
  { walker:4, leaper:3, exploder:2 },
  { walker:4, runner:4, armored:2, tank:1 },
  { walker:5, leaper:3, crawler:4, exploder:3 },
  { runner:6, armored:3, tank:1, leaper:2 },
  { walker:6, runner:4, armored:3, exploder:3, tank:2 },
  { boss:1, walker:4, runner:3 },
];

// The boss is a telekinesis problem, not a health bar: four plates must be
// stripped before the core can be touched, and it fights by throwing the
// same debris the player is using.
const BOSS = {
  name:"Warden", plateHp:230, plates:4, coreHp:1300,
  speed:1.05, reach:3.2, atkEvery:3.6, score:5000,
};

const walkers = [];

function spawnBoss(x, z) {
  const g = new T.Group();
  const skinM = new T.MeshStandardMaterial({ color:0x4d5a44, roughness:1, flatShading:true });
  const plateM= new T.MeshStandardMaterial({ color:0x6d7686, roughness:0.55, metalness:0.5,
                                             flatShading:true });
  const coreM = new T.MeshStandardMaterial({ color:0xff3c2a, emissive:0xff3c2a,
                                             emissiveIntensity:1.4, roughness:0.3 });
  g.add(part(new T.CylinderGeometry(1.15, 1.55, 3.1, 9), skinM, 0, 2.0, 0));
  g.add(part(new T.SphereGeometry(0.72, 14, 10), skinM, 0, 4.0, 0.1));
  g.add(part(new T.SphereGeometry(0.16, 8, 6),
        new T.MeshBasicMaterial({ color:0xff6a30 }), -0.3, 4.1, 0.62));
  g.add(part(new T.SphereGeometry(0.16, 8, 6),
        new T.MeshBasicMaterial({ color:0xff6a30 }),  0.3, 4.1, 0.62));
  const core = part(new T.OctahedronGeometry(0.62, 0), coreM, 0, 2.5, 0.95);
  g.add(core);
  const glow = new T.PointLight(0xff3c2a, 0, 14, 2);
  glow.position.set(0, 2.5, 1.0);
  g.add(glow);

  // Plates ring the core. Each is a separate body with its own health.
  const plates = [];
  for (let i = 0; i < BOSS.plates; i++) {
    const a = (i/BOSS.plates)*Math.PI*2;
    const pl = part(new T.BoxGeometry(1.15, 1.15, 0.34), plateM,
                    Math.cos(a)*1.15, 2.5 + Math.sin(a)*0.95, 0.92);
    pl.rotation.z = a;
    g.add(pl);
    plates.push({ mesh: pl, hp: BOSS.plateHp });
  }
  // Arms, long and heavy.
  const aL = limb(g, 1.5, skinM, -1.5, 3.3, 0, 0.3);
  const aR = limb(g, 1.5, skinM,  1.5, 3.3, 0, 0.3);
  aL.rotation.x = -0.4; aR.rotation.x = -0.4;
  const lL = limb(g, 1.5, skinM, -0.6, 1.0, 0, 0.34);
  const lR = limb(g, 1.5, skinM,  0.6, 1.0, 0, 0.34);

  g.position.set(x, 0, z);
  scene.add(g);
  walkers.push({ g, body:g, torso:g, aL, aR, lL, lR, pos:g.position,
    type:"boss", boss:true, core, glow, plates, platesLeft:BOSS.plates,
    E:{ name:"WARDEN", hp:BOSS.coreHp, speed:BOSS.speed, scale:2.1, skin:0x4d5a44,
        score:BOSS.score },
    r:2.0, walk:0, dead:false, cool:0, atkT:BOSS.atkEvery,
    hp:BOSS.coreHp, maxHp:BOSS.coreHp, flash:0, kb:new T.Vector3(),
    leapT:99, vy:0, air:false });
}

function spawnWalker(type, x, z) {
  if (type === "boss") return spawnBoss(x, z);
  const E = ENEMIES[type] || ENEMIES.walker;
  const g = new T.Group(), body = new T.Group();
  g.add(body);

  // Hunched forward from the hips — the stoop is what separates a walker
  // from a person at fifty metres, before any detail is legible.
  const torso = new T.Group();
  torso.position.y = 1.02;
  torso.rotation.x = 0.34;
  body.add(torso);

  const skinM = new T.MeshStandardMaterial({ color:E.skin, roughness:1, flatShading:true });
  const eyeM  = new T.MeshBasicMaterial({ color:E.eye });
  const B = E.bulk;
  torso.add(part(new T.CylinderGeometry(0.24*B, 0.33*B, 0.78, 7), zRot, 0, 0.34, 0));
  // Ragged shirt hanging off the frame, open at the bottom.
  const rag = part(new T.CylinderGeometry(0.36*B, 0.50*B, 0.72, 7, 1, true), zRag, 0, 0.20, 0);
  torso.add(rag);
  // Ribs showing through: two thin bands, cheap but grim.
  torso.add(part(new T.BoxGeometry(0.40*B, 0.045, 0.30), skinM, 0, 0.46, 0.06));
  torso.add(part(new T.BoxGeometry(0.36*B, 0.045, 0.28), skinM, 0, 0.36, 0.07));

  // Head lolls to one side.
  const neck = new T.Group();
  neck.position.set(0, 0.76, 0.04);
  neck.rotation.z = rand(-0.35, 0.35);
  neck.rotation.x = -0.2;
  torso.add(neck);
  const skull = part(new T.SphereGeometry(0.225, 12, 9), skinM, 0, 0.1, 0);
  skull.scale.set(0.92, 1.06, 1.05);
  neck.add(skull);
  neck.add(part(new T.BoxGeometry(0.22, 0.11, 0.13), zJaw, 0, -0.01, 0.17));  // slack jaw
  neck.add(part(new T.SphereGeometry(0.075, 8, 6), eyeM, -0.095, 0.14, 0.2));
  neck.add(part(new T.SphereGeometry(0.075, 8, 6), eyeM,  0.095, 0.14, 0.2));

  // Long reaching arms with clawed hands.
  function zLimb(parent, len, px, py, rad) {
    const pv = new T.Group();
    pv.position.set(px, py, 0);
    pv.add(part(new T.CapsuleGeometry(rad, len, 4, 7), skinM, 0, -len/2-0.04, 0));
    const hand = part(new T.ConeGeometry(rad*1.7, rad*3.2, 5), skinM, 0, -len-0.14, 0);
    hand.rotation.x = Math.PI;
    pv.add(hand);
    parent.add(pv);
    return pv;
  }
  const aL = zLimb(torso, 0.66, -0.34, 0.60, 0.085);
  const aR = zLimb(torso, 0.66,  0.34, 0.60, 0.085);
  aL.rotation.x = -1.6; aR.rotation.x = -1.6;
  aL.rotation.z =  0.16; aR.rotation.z = -0.16;

  const lL = zLimb(body, 0.62, -0.15, 1.00, 0.10);
  const lR = zLimb(body, 0.62,  0.15, 1.00, 0.10);

  // Elites appear once the waves get serious: same archetype, harder, worth
  // more — a reason to change target priority rather than a new model.
  const elite = S.wave >= 5 && Math.random() < 0.18;
  const EE = elite
    ? Object.assign({}, E, { hp:Math.round(E.hp*2.1), scale:E.scale*1.28,
                             armor:(E.armor||0)+18, score:E.score*3,
                             name:"Elite "+E.name })
    : E;

  g.position.set(x,0,z);
  g.scale.setScalar(EE.scale * rand(0.94, 1.06));
  if (elite) {
    const ring2 = new T.Mesh(new T.RingGeometry(0.9, 1.12, 20),
      new T.MeshBasicMaterial({ color:0xffd23c, transparent:true, opacity:0.55,
                                side:T.DoubleSide, depthWrite:false }));
    ring2.rotation.x = -Math.PI/2; ring2.position.y = 0.06;
    g.add(ring2);
  }
  // Without this the enemy exists, walks, damages and dies — entirely
  // invisibly. Dropped when the elite block was inserted; every test since
  // asserted on counts rather than on anything being on screen, so all of
  // them passed against a game with no visible enemies.
  scene.add(g);
  walkers.push({ g, body, torso, aL, aR, lL, lR, pos:g.position, elite,
                 type, E:EE, r:0.75*EE.scale,
                 walk:rand(0,6), dead:false, cool:0,
                 hp:EE.hp, maxHp:EE.hp, flash:0, kb:new T.Vector3(),
                 leapT:rand(1,3), vy:0, air:false,
                 thrown:0, tvel:new T.Vector3() });
}

// ─────────────────────────────────────────────────────────── upgrades
// Every upgrade writes into MOD, and the gameplay code reads MOD. Nothing
// here special-cases an upgrade by name, so adding one is a table entry.
const MOD = {
  singleDmg: 1, burstDmg: 1, allDmg: 1,
  maxHeld: 0, grabR: 0, focusRegen: 1, hpBonus: 0,
  berserk: false, gravity: false, voidwell: false,
  lightning: 0,          // kills between arcs; 0 = off
  blastR: 1,
};

const UPGRADES = [
  { id:"kinetic",  name:"Kinetic Mastery", tag:"Single",
    desc:"Single-target shots hit 45% harder.",
    take(){ MOD.singleDmg *= 1.45; } },
  { id:"swarm",    name:"Swarm",           tag:"Burst",
    desc:"Carry 3 more objects, and burst throws hit 20% harder.",
    take(){ MOD.maxHeld += 3; MOD.burstDmg *= 1.2; } },
  { id:"berserk",  name:"Berserker",       tag:"Risk",
    desc:"Below 2 health, everything you throw deals double damage.",
    take(){ MOD.berserk = true; } },
  { id:"gravity",  name:"Gravity",         tag:"Control",
    desc:"Impacts drag nearby enemies toward the point of contact.",
    take(){ MOD.gravity = true; } },
  { id:"voidwell", name:"Void",            tag:"Control",
    desc:"Every kill leaves a brief well that pulls the horde together.",
    take(){ MOD.voidwell = true; } },
  { id:"storm",    name:"Lightning",       tag:"Chain",
    desc:"Every 4th kill arcs to three more enemies.",
    take(){ MOD.lightning = MOD.lightning ? Math.max(2, MOD.lightning-1) : 4; } },
  { id:"reach",    name:"Long Reach",      tag:"Utility",
    desc:"Telekinesis reaches 5 metres further.",
    take(){ MOD.grabR += 5; } },
  { id:"flow",     name:"Flow State",      tag:"Utility",
    desc:"Focus recovers 55% faster.",
    take(){ MOD.focusRegen *= 1.55; } },
  { id:"hardened", name:"Hardened",        tag:"Defence",
    desc:"+2 maximum health, and refill now.",
    take(){ MOD.hpBonus += 2; hero.hp = CFG.maxHealth + MOD.hpBonus; } },
  { id:"ordnance", name:"Ordnance",        tag:"Explosive",
    desc:"Every explosion is 40% wider.",
    take(){ MOD.blastR *= 1.4; } },
  { id:"heft",     name:"Heft",            tag:"Power",
    desc:"All thrown objects deal 25% more damage.",
    take(){ MOD.allDmg *= 1.25; } },
];

const taken = [];

function offerDraft() {
  S.phase = "draft";
  // Three distinct picks, drawn without replacement.
  const pool = UPGRADES.slice();
  const picks = [];
  while (picks.length < 3 && pool.length) {
    picks.push(pool.splice(Math.floor(Math.random()*pool.length), 1)[0]);
  }
  el("card").classList.add("wide");
  el("card").innerHTML =
    '<h1 style="font-size:clamp(24px,5vh,38px)">Wave ' + S.wave + ' cleared</h1>' +
    '<p class="sub">Choose one</p><div id="draft"></div>';
  const box = el("draft");
  picks.forEach(u => {
    const b = document.createElement("button");
    b.className = "upg";
    b.innerHTML = '<span class="ut">' + u.tag + '</span><b>' + u.name + '</b><i>' + u.desc + '</i>';
    b.onclick = () => { u.take(); taken.push(u.id); SFX.pick(); startNextWave(); };
    box.appendChild(b);
  });
  el("overlay").classList.remove("hide");
  ["hud","touch","cross"].forEach(i => el(i).classList.add("hide"));
}

// ─────────────────────────────────────────────────────────── audio
// Synthesised on the fly. The page must stay a single self-contained file,
// so there are no sample assets — every sound here is an oscillator or a
// burst of noise shaped by a gain envelope.
let AC = null, master = null;
let noiseBuf = null;

function audioInit() {
  if (AC) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  AC = new Ctx();
  master = AC.createGain();
  master.gain.value = 0.55;
  master.connect(AC.destination);
  const n = AC.sampleRate * 0.5;
  noiseBuf = AC.createBuffer(1, n, AC.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random()*2 - 1;
}

function tone(freq, dur, type, vol, sweepTo) {
  if (!AC) return;
  const o = AC.createOscillator(), gn = AC.createGain();
  o.type = type || "sine";
  o.frequency.setValueAtTime(freq, AC.currentTime);
  if (sweepTo) o.frequency.exponentialRampToValueAtTime(Math.max(20,sweepTo), AC.currentTime+dur);
  gn.gain.setValueAtTime(0.0001, AC.currentTime);
  gn.gain.exponentialRampToValueAtTime(vol, AC.currentTime + 0.008);
  gn.gain.exponentialRampToValueAtTime(0.0001, AC.currentTime + dur);
  o.connect(gn); gn.connect(master);
  o.start(); o.stop(AC.currentTime + dur + 0.02);
}

function noise(dur, vol, cut, sweepTo) {
  if (!AC || !noiseBuf) return;
  const s = AC.createBufferSource(); s.buffer = noiseBuf;
  const f = AC.createBiquadFilter(); f.type = "lowpass";
  f.frequency.setValueAtTime(cut, AC.currentTime);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(Math.max(80,sweepTo), AC.currentTime+dur);
  const gn = AC.createGain();
  gn.gain.setValueAtTime(vol, AC.currentTime);
  gn.gain.exponentialRampToValueAtTime(0.0001, AC.currentTime + dur);
  s.connect(f); f.connect(gn); gn.connect(master);
  s.start(); s.stop(AC.currentTime + dur + 0.02);
}

// Pitch scales with 1/sqrt(mass) and duration with mass, which is roughly
// how real objects behave: a plank ticks, a boulder thuds. Everything that
// takes a mass argument defaults to 1 so old call sites still work.
const SFX = {
  gather: (m=1) => {
    const p = 1/Math.sqrt(m);
    tone(150*p, 0.28+0.12*m, "sine", 0.2, 560*p);
    noise(0.2, 0.045+0.02*m, 800*p, 2400*p);
  },
  throw:  (m=1) => {
    const p = 1/Math.sqrt(m);
    noise(0.14+0.06*m, 0.15+0.05*m, 1700*p, 260);
    tone(380*p, 0.11+0.05*m, "triangle", 0.12, 130*p);
  },
  impact: (m=1, hard=1) => {
    const p = 1/Math.sqrt(m);
    noise(0.11+0.07*m, Math.min(0.5, 0.26*hard*Math.sqrt(m)), 1400*p, 200);
    tone(95*p, 0.10+0.07*m, "square", 0.12*Math.sqrt(m), 42*p);
  },
  weak:   () => { tone(1150, 0.14, "square", 0.16, 1750); },
  kill:   () => { noise(0.22, 0.26, 700, 120); tone(70, 0.2, "sine", 0.16, 34); },
  boom:   () => { noise(0.62, 0.5, 2400, 90); tone(58, 0.5, "sine", 0.3, 24);
                  tone(140, 0.28, "square", 0.14, 40); },
  hurt:   () => { tone(230, 0.26, "sawtooth", 0.22, 70); noise(0.16, 0.14, 500, 150); },
  combo:  (n) => tone(520 + Math.min(n,8)*90, 0.14, "triangle", 0.18, 780 + n*70),
  pick:   () => tone(760, 0.1, "triangle", 0.16, 1150),
  wave:   () => { tone(300, 0.5, "sine", 0.2, 620); setTimeout(()=>tone(460,0.45,"sine",0.16,760), 130); },
};

// ─────────────────────────────────────────────────────────── combat
// Damage scales with how hard the thing was actually travelling, so a
// lobbed boulder and a hurled one are not the same hit.
const MIN_HIT_SPEED = 9;

const puddles = [];
const blastQ  = [];            // explosions wait here; see MAX_BLASTS
const MAX_BLASTS = 5;          // per frame, so a barrel farm cannot stall a phone

function addCombo(n) {
  S.combo += n;
  S.comboT = 2.6;
  if (S.combo >= 3) {
    const tier = S.combo >= 12 ? "UNSTOPPABLE" : S.combo >= 8 ? "RAMPAGE"
               : S.combo >= 5 ? "SLAUGHTER" : S.combo === 4 ? "QUAD" : "TRIPLE";
    banner(tier + "  x" + S.combo);
    SFX.combo(S.combo);
  }
  updateHUD();
}

function banner(txt) {
  const b = el("combo");
  b.textContent = txt;
  b.classList.remove("pop");
  void b.offsetWidth;          // restart the animation
  b.classList.add("pop");
}

function killWalker(w) {
  if (w.dead) return;
  w.dead = true;
  scene.remove(w.g);
  burst(w.pos, w.E.skin);
  // An Exploder is a delivery mechanism: killing one near a crowd is the
  // point, and killing one next to a barrel is better.
  if (w.E.onDeath === "blast") queueBlast(w.pos, { r:6.5, dmg:150 }, null);
  S.kills++;
  S.score += (w.E.score || 100) * Math.max(1, S.combo);
  if (MOD.voidwell) pullToward(w.pos, 8, 16);
  if (MOD.lightning && S.kills % MOD.lightning === 0) arcLightning(w.pos);
  S.shake = Math.min(0.9, S.shake + 0.35);
  SFX.kill();
  addCombo(1);
  updateHUD();
}

// A body thrown hard enough stops being an enemy and becomes ordnance.
// This is the piece that makes the environment a weapon rather than scenery:
// launched walkers damage whatever they land on, and each other.
const LAUNCH_MIN = 11;
const LAUNCH_MAX = 30;

function launchWalker(w, dir, power) {
  if (w.dead || w.boss) return;          // the Warden is not going anywhere
  // Loft has to stay bounded. A vertical component that scales with power
  // sends a hard-launched body straight over the heads of everything it was
  // aimed at — it clears the strike band in the first tenth of a second and
  // comes down in empty grass. Cap both axes so bodies travel as a flat
  // skipping-stone arc through the crowd instead of a mortar shell.
  const p = Math.min(LAUNCH_MAX, Math.abs(power));
  w.thrown = 1.6;
  w.tvel = w.tvel || new T.Vector3();
  w.tvel.set(dir.x*p, Math.min(8.5, 3.2 + p*0.22), dir.z*p);
  w.air = true;
}

function flyingHit(w, other, speed) {
  // Both parties take it — a body used as a projectile breaks on impact too.
  const dmg = Math.min(220, speed * 9);
  damageWalker(other, dmg, null, 0);
  damageWalker(w, dmg * 0.6, null, 0);
  sparks(w.pos, 0x8a5a4a, 8, 14);
  SFX.impact(2.2, 1.2);
  S.shake = Math.min(0.9, S.shake + 0.2);
  banner("ENVIRONMENTAL KILL");
}

// Shared by Gravity and Void: yank everything within reach toward a point.
function pullToward(pos, r, force) {
  for (const w of walkers) {
    if (w.dead) continue;
    const dx = pos.x-w.pos.x, dz = pos.z-w.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.2 && d < r) {
      const k = force * (1 - d/r) / d;
      w.kb.x += dx*k; w.kb.z += dz*k;
    }
  }
}

// Lightning hops to the nearest bodies, drawing a bolt at each hop.
function arcLightning(from) {
  let src = from.clone();
  const hit = [];
  for (let n = 0; n < 3; n++) {
    let best = null, bd = 16;
    for (const w of walkers) {
      if (w.dead || hit.includes(w)) continue;
      const d = Math.hypot(w.pos.x-src.x, w.pos.z-src.z);
      if (d < bd) { bd = d; best = w; }
    }
    if (!best) break;
    hit.push(best);
    bolt(src, best.pos);
    damageWalker(best, 95, null, 0);
    src = best.pos.clone();
  }
  if (hit.length) { SFX.weak(); banner("ARC x" + hit.length); }
}

// Tether pool. One reusable line per carry slot — a link the player can see
// is the clearest possible "this object is under my control" signal.
const tethers = [];
for (let i = 0; i < 12; i++) {
  const geo = new T.BufferGeometry().setFromPoints([new T.Vector3(), new T.Vector3()]);
  const m = new T.Line(geo, new T.LineBasicMaterial({
    color: 0xe94fbf, transparent: true, opacity: 0 }));
  m.frustumCulled = false;
  m.visible = false;
  scene.add(m);
  tethers.push(m);
}
function updateTethers() {
  const n = S.held.length;
  for (let i = 0; i < tethers.length; i++) {
    const t2 = tethers[i], o = S.held[i];
    if (!o) { t2.visible = false; continue; }
    const p = t2.geometry.attributes.position;
    p.setXYZ(0, hero.pos.x, hero.pos.y + 1.85, hero.pos.z);
    p.setXYZ(1, o.pos.x, o.pos.y, o.pos.z);
    p.needsUpdate = true;
    t2.visible = true;
    // Fresh grabs flare, then settle to a steady thread.
    t2.material.opacity = 0.2 + 0.5*Math.max(0, o.grabT||0) + 0.06*Math.sin(S.t*9 + i);
  }
}

const bolts = [];
function bolt(a, b2) {
  const geo = new T.BufferGeometry().setFromPoints([
    new T.Vector3(a.x, 1.4, a.z), new T.Vector3(b2.x, 1.4, b2.z)]);
  const m = new T.Line(geo, new T.LineBasicMaterial({ color:0x9ad8ff, transparent:true }));
  scene.add(m);
  bolts.push({ mesh:m, life:0.22 });
}

function damageWalker(w, amount, dir, knock) {
  if (w.dead) return;
  // Armour subtracts flat, with a small floor so nothing is fully immune.
  // A rock into a Tank is a chip; a boulder or a blast is a real hit.
  // A plated boss takes almost nothing on the body. The plates ARE the
  // fight; the core only opens once they are gone.
  if (w.boss && w.platesLeft > 0) {
    const pl = w.plates.find(p => p.hp > 0);
    if (pl) {
      pl.hp -= amount;
      if (pl.hp <= 0) {
        pl.mesh.visible = false;
        w.platesLeft--;
        sparks(w.pos, 0xaab4c4, 16, 20);
        SFX.boom();
        S.shake = Math.min(1, S.shake + 0.5);
        banner(w.platesLeft ? "PLATE DOWN · " + w.platesLeft + " LEFT" : "CORE EXPOSED");
      }
    }
    w.flash = 1;
    return;                      // body damage is absorbed entirely
  }
  const ar = w.E.armor || 0;
  if (ar) amount = Math.max(amount * 0.08, amount - ar);
  w.hp -= amount;
  w.flash = 1;
  if (dir && knock) w.kb.addScaledVector(dir, knock);
  if (w.hp <= 0) killWalker(w);
}

function sparks(pos, color, n, spread) {
  for (let i = 0; i < n; i++) {
    const m = new T.Mesh(gibGeo, new T.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0.8, transparent: true }));
    m.position.copy(pos);
    m.scale.setScalar(rand(0.3, 0.8));
    scene.add(m);
    gibs.push({ mesh:m,
      vel:new T.Vector3(rand(-1,1),rand(0.2,1.2),rand(-1,1)).normalize().multiplyScalar(rand(4,spread)),
      spin:new T.Vector3(rand(-9,9),rand(-9,9),rand(-9,9)),
      life:rand(0.3,0.8), max:0.8 });
  }
}

// Expanding shells, pooled — an explosion allocating meshes mid-chain is
// exactly how a chain reaction turns into a frame spike.
const shells = [];
for (let i = 0; i < 8; i++) {
  const m = new T.Mesh(new T.SphereGeometry(1, 14, 10),
    new T.MeshBasicMaterial({ color:0xffa542, transparent:true, opacity:0, depthWrite:false }));
  m.visible = false; scene.add(m);
  shells.push({ mesh:m, life:0, r:1 });
}
function shell(pos, r, color) {
  const s = shells.find(x => x.life <= 0) || shells[0];
  s.mesh.position.copy(pos);
  s.mesh.material.color.setHex(color);
  s.mesh.visible = true;
  s.life = 0.42; s.r = r;
}

function queueBlast(pos, ex, src) {
  blastQ.push({ pos: pos.clone(), ex, src });
}

function runBlast(b) {
  const { pos } = b;
  const ex = { r: b.ex.r * MOD.blastR, dmg: b.ex.dmg };
  shell(pos, ex.r, 0xffa542);
  sparks(pos, 0xff8a3c, 14, 22);
  SFX.boom();
  S.shake = Math.min(1.2, S.shake + 0.7);

  let killed = 0;
  for (const w of walkers) {
    if (w.dead) continue;
    const d = Math.hypot(w.pos.x-pos.x, w.pos.z-pos.z);
    if (d < ex.r) {
      const fall = 1 - d/ex.r;                       // linear falloff
      tmp.set(w.pos.x-pos.x, 0, w.pos.z-pos.z).normalize();
      const before = w.dead;
      damageWalker(w, ex.dmg*fall, tmp, 9*fall);
      // Blasts throw bodies outward, which is what turns one barrel into a
      // cascade: the launched walkers go on to hit cover and each other.
      if (!w.dead && fall > 0.35) launchWalker(w, tmp, 12 + 26*fall);
      if (!before && w.dead) killed++;
    }
  }
  // Shove loose props, and detonate any barrel caught in the blast — this
  // one line is the whole chain-reaction mechanic.
  for (const o of rocks) {
    if (o.held || o.gone) continue;
    const d = Math.hypot(o.pos.x-pos.x, o.pos.z-pos.z);
    if (d < ex.r) {
      tmp.set(o.pos.x-pos.x, 0.5, o.pos.z-pos.z).normalize();
      o.vel.addScaledVector(tmp, 26*(1-d/ex.r)/Math.max(0.5,o.def.mass));
      if (o.def.explode && o !== b.src) detonate(o);
    }
  }
  if (killed >= 2) banner("CHAIN x" + killed);
}

function detonate(o) {
  if (o.gone) return;
  o.gone = true;                      // consumed; also stops re-entry
  o.mesh.visible = false;
  queueBlast(o.pos, o.def.explode, o);
}

function spill(o) {
  if (o.gone) return;
  o.gone = true;
  o.mesh.visible = false;
  const p = o.def.puddle;
  const m = new T.Mesh(new T.CircleGeometry(p.r, 24),
    new T.MeshBasicMaterial({ color:0x8ada4e, transparent:true, opacity:0.34, depthWrite:false }));
  m.rotation.x = -Math.PI/2;
  m.position.set(o.pos.x, 0.05, o.pos.z);
  scene.add(m);
  puddles.push({ mesh:m, pos:m.position.clone(), r:p.r, dps:p.dps, life:p.life, max:p.life });
  sparks(o.pos, 0x8ada4e, 10, 12);
}

// ─────────────────────────────────────────────────────────── gibs
const gibGeo = new T.TetrahedronGeometry(0.26,0);
const gibs = [];
function burst(pos, color) {
  for (let i = 0; i < 16; i++) {
    const m = new T.Mesh(gibGeo, new T.MeshStandardMaterial({ color, roughness:0.9, transparent:true }));
    m.position.copy(pos); m.position.y += 1;
    scene.add(m);
    gibs.push({ mesh:m,
      vel:new T.Vector3(rand(-1,1),rand(0.3,1.4),rand(-1,1)).normalize().multiplyScalar(rand(5,16)),
      spin:new T.Vector3(rand(-9,9),rand(-9,9),rand(-9,9)),
      life:rand(0.7,1.6), max:1.6 });
  }
}

// ─────────────────────────────────────────────────────────── state
const S = {
  phase:"menu", wave:1, kills:0, focus:1, shake:0, t:0,
  combo:0, comboT:0, score:0, recycleT:0,
  held: [],
  mode: "single",          // "single" | "aoe"
  modeCd: 0,               // seconds left on the switch cooldown
  dashT: 0, dashCd: 0, dashDir: new T.Vector3(), repCd: 0,
  lock: null,              // walker currently under the crosshair
};
const cam = { yaw: Math.PI, pitch: 0.26, dist: 11.2 };

function clearAll() {
  rocks.forEach(o => { scene.remove(o.mesh); o.mesh.geometry.dispose(); });
  rocks.length = 0;
  walkers.forEach(w => scene.remove(w.g)); walkers.length = 0;
  gibs.forEach(x => scene.remove(x.mesh)); gibs.length = 0;
  puddles.forEach(p => scene.remove(p.mesh)); puddles.length = 0;
  shells.forEach(s => { s.life = 0; s.mesh.visible = false; });
  blastQ.length = 0;
  bolts.forEach(b2 => scene.remove(b2.mesh)); bolts.length = 0;
  tethers.forEach(t2 => { t2.visible = false; });
  S.held = []; S.lock = null; S.combo = 0; S.comboT = 0;
}

function buildWave(n) {
  clearAll();

  // Scatter the catalogue rather than a pile of identical rocks, so what is
  // lying near you is itself a tactical fact.
  for (const key in OBJECTS) {
    const def = OBJECTS[key];
    const n2 = Math.max(1, Math.round(def.count * (1.4 + n*0.15)));
    for (let i = 0; i < n2; i++) {
      const a = rand(0,Math.PI*2);
      // Uniform over a disc is sqrt-distributed, which piles everything at
      // the rim. Bias inward instead so there is always something underfoot.
      const d = Math.pow(Math.random(), 0.8) * (CFG.arena*0.62);
      spawnObject(key, Math.cos(a)*d, Math.sin(a)*d);
    }
  }
  const comp = WAVES[Math.min(n, WAVES.length) - 1];
  const extra = Math.max(0, n - WAVES.length);        // past the table, scale up
  const list = [];
  for (const t in comp) {
    const c = comp[t] + Math.round(comp[t] * extra * 0.35);
    for (let i = 0; i < c; i++) list.push(t);
  }
  list.forEach((t, i) => {
    const a = (i/list.length)*Math.PI*2 + rand(-0.25,0.25), d = CFG.arena - rand(2,8);
    spawnWalker(t, Math.cos(a)*d, Math.sin(a)*d);
  });
  hero.pos.set(0,0,0); hero.yaw = Math.PI;
  hero.vy = 0; hero.grounded = true;
  S.dashT = 0; S.dashCd = 0;
  cam.yaw = Math.PI; cam.pitch = 0.26;
  S.focus = 1;
  el("wave").textContent = n;
  updateHUD();
}

function updateHUD() {
  const alive = walkers.filter(w => !w.dead);
  el("left").textContent = alive.length;
  const kinds = {};
  alive.forEach(w => { kinds[w.E.name] = (kinds[w.E.name]||0)+1; });
  const bw = walkers.find(w => w.boss && !w.dead);
  const bb = el("bossBar");
  if (bb) {
    bb.classList.toggle("show", !!bw);
    if (bw) {
      const plates = bw.plates.reduce((s,p) => s + Math.max(0,p.hp), 0);
      const pMax = BOSS.plates * BOSS.plateHp;
      el("bossPlate").style.width = (plates/pMax*100) + "%";
      el("bossCore").style.width  = (Math.max(0,bw.hp)/bw.maxHp*100) + "%";
      el("bossName").textContent = bw.platesLeft ? "WARDEN · ARMOURED" : "WARDEN · CORE EXPOSED";
      el("bossBar").classList.toggle("open", !bw.platesLeft);
    }
  }
  const th = el("threat");
  if (th) th.textContent = Object.keys(kinds).length
    ? Object.entries(kinds).map(([k,v]) => k[0]+v).join(" ") : "";
  let h = "";
  const maxHp = CFG.maxHealth + MOD.hpBonus;
  for (let i = 0; i < maxHp; i++) h += `<i class="${i < hero.hp ? "" : "off"}"></i>`;
  el("hp").innerHTML = h;
  el("carry").textContent = S.held.length;
  const sc = el("score"); if (sc) sc.textContent = S.score;
  const cv = el("comboVal"); if (cv) cv.textContent = "x" + Math.max(1, S.combo);
  const cw = el("comboWrap"); if (cw) cw.classList.toggle("hot", S.combo > 1);
}

let toastT = 0;
function toast(msg, ms = 1900) {
  const t = el("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove("show"), ms);
}

// ─────────────────────────────────────────────────────────── modes
function updateForceLabel() {
  // The button IS the state readout: FORCE while empty, SHOOT/THROW while
  // loaded, with the remaining count on it. Reverts on its own at zero.
  const n = S.held.length, btn = el("force");
  if (!n) {
    btn.innerHTML = "Force";
    btn.classList.remove("loaded");
  } else {
    btn.innerHTML = (S.mode === "single" ? "Shoot" : "Throw") +
                    '<b class="cnt">' + n + '</b>';
    btn.classList.add("loaded");
  }
}

function setMode(m, silent) {
  S.mode = m;
  el("modeName").textContent = m === "single" ? "Single" : "Burst";
  el("modeBtn").classList.toggle("aoe", m === "aoe");
  el("cross").classList.toggle("aoe", m === "aoe");
  updateForceLabel();
  if (!silent) toast(m === "single" ? "Single — one press, one guided shot"
                                    : "Burst — everything at once");
}

function switchMode() {
  if (S.modeCd > 0) { toast(`Switching in ${S.modeCd.toFixed(1)}s`, 900); return; }
  setMode(S.mode === "single" ? "aoe" : "single");
  S.modeCd = CFG.modeCooldown;
}

// ─────────────────────────────────────────────────────────── abilities
function doJump() {
  if (S.phase !== "play" || !hero.grounded) return;
  hero.vy = CFG.jumpV;
  hero.grounded = false;
}

function doRepulse() {
  if (S.phase !== "play" || S.repCd > 0) return;
  S.repCd = CFG.repulseCd;
  let n = 0;
  for (const w of walkers) {
    if (w.dead) continue;
    const dx = w.pos.x-hero.pos.x, dz = w.pos.z-hero.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < CFG.repulseR && d > 0.1) {
      const k = 26 * (1 - d/CFG.repulseR) / d;
      w.kb.x += dx*k; w.kb.z += dz*k;
      damageWalker(w, 45, null, 0);
      if (!w.dead && d < CFG.repulseR*0.55) {
        tmp.set(dx/d, 0, dz/d);
        launchWalker(w, tmp, 16);
      }
      n++;
    }
  }
  // Loose props are shoved too, which doubles as a way to clear your own feet.
  for (const o of rocks) {
    if (o.held || o.gone) continue;
    const dx = o.pos.x-hero.pos.x, dz = o.pos.z-hero.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < CFG.repulseR && d > 0.1) {
      const k = 17 * (1 - d/CFG.repulseR) / d;
      o.vel.x += dx*k; o.vel.z += dz*k; o.vel.y += 5;
    }
  }
  shell(new T.Vector3(hero.pos.x, 1.2, hero.pos.z), CFG.repulseR*0.8, 0xe94fbf);
  SFX.boom();
  S.shake = Math.min(0.8, S.shake + 0.4);
  if (n) banner("REPULSE x" + n);
}

function doDash() {
  if (S.phase !== "play" || S.dashCd > 0) return;
  // Dash along the stick if it is pushed, otherwise straight down the
  // crosshair — so a standing player still gets a forward blink.
  const moving = Math.hypot(input.mx, input.mz) > 0.15 ||
                 keys.has("KeyW") || keys.has("KeyA") || keys.has("KeyS") || keys.has("KeyD");
  if (moving) S.dashDir.copy(lastMove).normalize();
  else S.dashDir.set(Math.sin(cam.yaw), 0, Math.cos(cam.yaw)).normalize();
  if (!isFinite(S.dashDir.x) || S.dashDir.lengthSq() < 0.1)
    S.dashDir.set(Math.sin(cam.yaw), 0, Math.cos(cam.yaw));
  S.dashT = CFG.dashTime;
  S.dashCd = CFG.dashCd;
  pushGhost();
}

const lastMove = new T.Vector3(0, 0, 1);

// ─────────────────────────────────────────────────────────── input
const input = { mx:0, mz:0 };
const keys = new Set();
addEventListener("keydown", e => {
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === "Space") { e.preventDefault(); doJump(); }
  if (e.code === "KeyF" || e.code === "KeyE") { e.preventDefault(); pressForce(); }
  if (e.code === "ShiftLeft" || e.code === "ShiftRight") { e.preventDefault(); doDash(); }
  if (e.code === "KeyR") { e.preventDefault(); doRepulse(); }
  if (e.code === "KeyQ" || e.code === "Tab") { e.preventDefault(); switchMode(); }
});
addEventListener("keyup", e => keys.delete(e.code));

const stick = el("stick"), knob = el("knob");
let stickId = null, sc0 = {x:0,y:0};
stick.addEventListener("pointerdown", e => {
  stickId = e.pointerId;
  const r = stick.getBoundingClientRect();
  sc0 = { x:r.left+r.width/2, y:r.top+r.height/2 };
  stick.setPointerCapture(e.pointerId); e.preventDefault();
});
stick.addEventListener("pointermove", e => {
  if (e.pointerId !== stickId) return;
  const dx = e.clientX-sc0.x, dy = e.clientY-sc0.y;
  const max = 44, d = Math.hypot(dx,dy), k = d > max ? max/d : 1;
  knob.style.transform = `translate(${dx*k}px, ${dy*k}px)`;
  input.mx = (dx*k)/max; input.mz = (dy*k)/max;
  e.preventDefault();
});
function stickEnd(e) {
  if (e.pointerId !== stickId) return;
  stickId = null; input.mx = input.mz = 0;
  knob.style.transform = "translate(0,0)";
}
stick.addEventListener("pointerup", stickEnd);
stick.addEventListener("pointercancel", stickEnd);

// FORCE is now a TAP, not a hold: press once to gather, press again to throw.
// Holding costs nothing; only the throw spends focus.
el("force").addEventListener("pointerdown", e => { e.preventDefault(); pressForce(); });
el("modeBtn").addEventListener("pointerdown", e => { e.preventDefault(); switchMode(); });
el("jump").addEventListener("pointerdown", e => { e.preventDefault(); doJump(); });
el("dash").addEventListener("pointerdown", e => { e.preventDefault(); doDash(); });
el("rep").addEventListener("pointerdown", e => { e.preventDefault(); doRepulse(); });

let lookId = null, lp = {x:0,y:0};
canvas.addEventListener("pointerdown", e => {
  if (lookId !== null) return;
  lookId = e.pointerId; lp = { x:e.clientX, y:e.clientY };
});
addEventListener("pointermove", e => {
  if (e.pointerId !== lookId) return;
  cam.yaw  -= (e.clientX-lp.x)*0.005;
  cam.pitch = clamp(cam.pitch + (e.clientY-lp.y)*0.004, -0.2, 1.0);
  lp = { x:e.clientX, y:e.clientY };
});
function lookEnd(e) { if (e.pointerId === lookId) lookId = null; }
addEventListener("pointerup", lookEnd);
addEventListener("pointercancel", lookEnd);

// ─────────────────────────────────────────────────────────── power
function pressForce() {
  if (S.phase !== "play") return;
  if (S.held.length) {
    if (S.mode === "single") shootOne();
    else burstAll();
    return;
  }
  gather();
}

function gather() {
  if (S.focus < CFG.gatherFloor) { toast("Not enough focus"); return; }
  const near = rocks
    .filter(o => !o.held && !o.gone && o.seekT <= 0 && o.pos.distanceTo(hero.pos) < CFG.grabRadius + MOD.grabR)
    .sort((a,b) => a.pos.distanceTo(hero.pos) - b.pos.distanceTo(hero.pos))
    .slice(0, CFG.maxHeld + MOD.maxHeld);
  if (!near.length) { toast("No stones in reach"); return; }
  let heaviest = 0;
  near.forEach((o,i) => {
    o.held = true; o.slot = i; o.mesh.material = heldMat;
    // Snap it off the floor so the grab reads as a yank rather than a fade.
    // Kept small and capped: the carry spring has to stay dominant, and an
    // earlier value of 7/mass flung light props clean over the treeline.
    o.vel.y += Math.min(3.2, 2.0 / Math.max(0.7, o.def.mass));
    o.grabT = 0.5;
    sparks(tmp.set(o.pos.x, o.pos.y*0.4, o.pos.z), 0xe94fbf, 4, 7);
    heaviest = Math.max(heaviest, o.def.mass);
  });
  S.held = near;
  SFX.gather(heaviest);
  S.shake = Math.min(0.4, S.shake + 0.06*heaviest);
  updateHUD();
  updateForceLabel();
}

const aimDir = new T.Vector3();

function shootOne() {
  if (S.focus < CFG.throwCost) { toast("No focus"); return; }
  S.focus = Math.max(0, S.focus - CFG.throwCost);
  const o = S.held.shift();
  // Re-index the survivors so the wheel stays evenly spaced as it empties,
  // instead of leaving a growing gap where the fired stones used to sit.
  S.held.forEach((s, i) => { s.slot = i; });
  launchSeeker(o);
  SFX.throw(o.def.mass);
  updateHUD();
  updateForceLabel();
}

function burstAll() {
  const n = S.held.length;
  if (!n) return;
  if (S.focus <= 0.02) { toast("No focus left"); return; }
  S.focus = Math.max(0, S.focus - CFG.throwCost * n);
  aimDir.set(Math.sin(cam.yaw), 0, Math.cos(cam.yaw)).normalize();

  // Burst assigns a DIFFERENT mark per stone across a wide forward arc.
  // Single concentrates one heavy shot; burst spreads seven light ones over
  // seven bodies. That is the whole distinction between the modes.
  const marks = walkers.filter(w => !w.dead).map(w => {
    tmp.set(w.pos.x-hero.pos.x, 0, w.pos.z-hero.pos.z);
    const d = tmp.length() || 1;
    return { w, d, dot: tmp.divideScalar(d).dot(aimDir) };
  }).filter(m => m.dot > CFG.burstCone).sort((a,b) => a.d - b.d);

  S.held.forEach((o,i) => {
    o.held = false;
    o.mult = CFG.burstMul * MOD.burstDmg;
    o.boostT = 0.12; o.boostTo = CFG.throwSpeed*(o.def.speedMul||1);
    const mark = marks.length ? marks[i % marks.length] : null;
    if (mark) {
      o.mesh.material = seekMat;
      o.seek = mark.w; o.seekT = CFG.seekTime;
      tmp.set(mark.w.pos.x-hero.pos.x, 0, mark.w.pos.z-hero.pos.z).normalize();
      o.vel.copy(tmp).multiplyScalar(CFG.throwSpeed*(o.def.speedMul||1))
        .add(new T.Vector3(0, rand(1.0,2.2), 0));
    } else {
      o.mesh.material = matFor(o.key, o.def);
      const spread = (i - (n-1)/2) * 0.16;
      o.vel.set(Math.sin(cam.yaw+spread), 0, Math.cos(cam.yaw+spread))
        .multiplyScalar(CFG.throwSpeed*(o.def.speedMul||1))
        .add(new T.Vector3(0, rand(1.0,2.6), 0));
    }
  });
  S.held = [];
  S.shake = Math.min(0.6, S.shake + 0.35);
  SFX.throw(S.held.length ? 1.4 : 1);
  updateHUD();
  updateForceLabel();
}

function launchSeeker(o) {
  o.held = false;
  o.mesh.material = seekMat;
  o.seek = S.lock && !S.lock.dead ? S.lock : nearestInCone();
  o.seekT = o.seek ? CFG.seekTime : 0;
  aimDir.set(Math.sin(cam.yaw), 0, Math.cos(cam.yaw)).normalize();
  o.mult = CFG.singleMul * MOD.singleDmg;
  // Leave the hand under full speed and keep accelerating for a beat. The
  // object moves on the same frame the button is pressed — no input delay —
  // but it visibly winds up instead of popping to terminal velocity.
  const full = CFG.throwSpeed*(o.def.speedMul||1);
  o.launchDir = aimDir.clone();
  o.boostT = 0.16;
  o.boostTo = full;
  o.vel.copy(aimDir).multiplyScalar(full*0.55).add(new T.Vector3(0, 1.4, 0));
  S.shake = Math.min(0.4, S.shake + 0.1);
}

const tmp = new T.Vector3(), tmp2 = new T.Vector3(), tmp3 = new T.Vector3();

function nearestInCone() {
  aimDir.set(Math.sin(cam.yaw), 0, Math.cos(cam.yaw));
  let best = null, bestD = Infinity;
  for (const w of walkers) {
    if (w.dead) continue;
    tmp.set(w.pos.x-hero.pos.x, 0, w.pos.z-hero.pos.z);
    const d = tmp.length();
    if (d < 1e-3) continue;
    if (tmp.divideScalar(d).dot(aimDir) > CFG.aimCone && d < bestD) { best = w; bestD = d; }
  }
  return best;
}

// ─────────────────────────────────────────────────────────── sim
function step(dt) {
  S.t += dt;

  S.focus = Math.min(1, S.focus + CFG.focusRegen*MOD.focusRegen*dt);
  el("focusFill").style.width = (S.focus*100) + "%";
  el("focusFill").classList.toggle("spent", S.focus < CFG.gatherFloor);

  if (S.modeCd > 0) {
    S.modeCd = Math.max(0, S.modeCd - dt);
    el("modeBtn").classList.add("cool");
    el("modeCd").style.transform = `scaleX(${S.modeCd / CFG.modeCooldown})`;
    if (S.modeCd === 0) el("modeBtn").classList.remove("cool");
  }

  // ---- movement
  let ix = input.mx, iz = input.mz;
  if (keys.has("KeyW") || keys.has("ArrowUp"))    iz -= 1;
  if (keys.has("KeyS") || keys.has("ArrowDown"))  iz += 1;
  if (keys.has("KeyA") || keys.has("ArrowLeft"))  ix -= 1;
  if (keys.has("KeyD") || keys.has("ArrowRight")) ix += 1;
  const mag = Math.min(1, Math.hypot(ix,iz));
  if (mag > 1e-4) { const l = Math.hypot(ix,iz); ix /= l; iz /= l; }

  const fwd = tmp.set(Math.sin(cam.yaw), 0, Math.cos(cam.yaw));
  const right = tmp2.set(-fwd.z, 0, fwd.x);   // forward x up
  const move = tmp3.set(0,0,0).addScaledVector(fwd, -iz).addScaledVector(right, ix);

  if (move.lengthSq() > 1e-6) {
    move.normalize();
    lastMove.copy(move);
    const ctl = hero.grounded ? 1 : CFG.airControl;
    hero.pos.addScaledVector(move, CFG.moveSpeed*mag*ctl*dt);
    const want = Math.atan2(move.x, move.z);
    let d = want - hero.yaw;
    while (d >  Math.PI) d -= Math.PI*2;
    while (d < -Math.PI) d += Math.PI*2;
    hero.yaw += d * Math.min(1, CFG.turnLerp*dt);
    if (hero.grounded) hero.walk += dt*10*mag;
  }

  // dash overrides normal steering for its brief window
  if (S.dashT > 0) {
    S.dashT -= dt;
    hero.pos.addScaledVector(S.dashDir, CFG.dashSpeed*dt);
    if (Math.random() < 0.5) pushGhost();
  }
  if (S.repCd > 0) {
    S.repCd = Math.max(0, S.repCd - dt);
    el("rep").classList.toggle("cool", S.repCd > 0);
    el("repCd").style.transform = `scaleY(${S.repCd / CFG.repulseCd})`;
  }
  if (S.dashCd > 0) {
    S.dashCd = Math.max(0, S.dashCd - dt);
    el("dash").classList.toggle("cool", S.dashCd > 0);
    el("dashCd").style.transform = `scaleY(${S.dashCd / CFG.dashCd})`;
  }

  // vertical
  hero.vy += CFG.gravity*dt;
  hero.pos.y += hero.vy*dt;
  if (hero.pos.y <= 0) { hero.pos.y = 0; hero.vy = 0; hero.grounded = true; }
  else hero.grounded = false;
  el("jump").classList.toggle("cool", !hero.grounded);

  for (const gh of ghosts) {
    if (gh.life <= 0) continue;
    gh.life -= dt;
    gh.mesh.material.opacity = Math.max(0, gh.life/0.34) * 0.4;
    if (gh.life <= 0) gh.mesh.visible = false;
  }
  const hd = Math.hypot(hero.pos.x, hero.pos.z);
  if (hd > CFG.arena-1) { hero.pos.x *= (CFG.arena-1)/hd; hero.pos.z *= (CFG.arena-1)/hd; }
  HERO.position.copy(hero.pos);
  HERO.rotation.y = hero.yaw;

  // Airborne: tuck the legs instead of running on nothing.
  const airT = hero.grounded ? 0 : 1;
  const sw = Math.sin(hero.walk) * (mag > 1e-3 && hero.grounded ? 0.7 : 0);
  const kk = Math.min(1, 10*dt);
  legL.rotation.x += ((airT ? -0.75 : sw)  - legL.rotation.x) * (airT ? kk : 1);
  legR.rotation.x += ((airT ?  0.35 : -sw) - legR.rotation.x) * (airT ? kk : 1);
  const channel = S.held.length > 0;
  const at = channel ? -2.25 : 0, k = Math.min(1, 9*dt);
  armL.rotation.x += (at-armL.rotation.x)*k;
  armR.rotation.x += (at-armR.rotation.x)*k;
  armL.rotation.z += ((channel?-0.45:0)-armL.rotation.z)*k;
  armR.rotation.z += ((channel? 0.45:0)-armR.rotation.z)*k;
  if (!channel) { armL.rotation.x += -sw*0.55; armR.rotation.x += sw*0.55; }

  aura.material.opacity += ((channel?0.17:0)-aura.material.opacity)*Math.min(1,7*dt);
  psi.position.set(hero.pos.x, hero.pos.y + 2.2, hero.pos.z);
  psi.intensity += ((channel?13:0)-psi.intensity)*Math.min(1,8*dt);
  visor.material.emissiveIntensity = channel ? 1.5 : 0.35;

  // ---- carry wheel, behind the character
  const back = new T.Vector3(-Math.sin(cam.yaw), 0, -Math.cos(cam.yaw));
  const wr = S.mode === "single" ? CFG.wheelSingle : CFG.wheelAoe;
  const cx0 = hero.pos.x + back.x*CFG.wheelBack;
  const cz0 = hero.pos.z + back.z*CFG.wheelBack;
  const rightV = new T.Vector3(-Math.cos(cam.yaw), 0, Math.sin(cam.yaw));
  const fwdV   = new T.Vector3(Math.sin(cam.yaw), 0, Math.cos(cam.yaw));

  // ---- rocks
  for (const o of rocks) {
    if (o.gone) continue;
    if (o.held) {
      const n = Math.max(1, S.held.length);
      const a = S.t*CFG.wheelSpin + (o.slot/n)*Math.PI*2;
      // Ring lies in the ground plane and floats overhead, so it reads as a
      // halo of orbiting debris. A vertical ring would swing stones down
      // through the aim line twice per revolution.
      tmp.set(cx0 + rightV.x*Math.cos(a)*wr + fwdV.x*Math.sin(a)*wr,
              CFG.wheelHeight + Math.sin(a*2)*0.35,
              cz0 + rightV.z*Math.cos(a)*wr + fwdV.z*Math.sin(a)*wr);
      // Divided by mass: a boulder swings wide and lags the wheel, a plank
      // snaps to it. The carry itself communicates what you picked up.
      o.vel.addScaledVector(tmp.sub(o.pos), (CFG.liftSpring/Math.max(0.6,o.def.mass))*dt);
      o.vel.multiplyScalar(1 - Math.min(1, CFG.liftDamp*dt));
      // Buzz under the field: light things jitter fast, heavy things wallow.
      // Costs nothing and sells "this is being held by force, not carried".
      const buzz = 0.9 / Math.max(0.5, o.def.mass);
      o.vel.x += Math.sin(S.t*23*buzz + o.slot)*buzz*0.9*dt*60*0.016;
      o.vel.z += Math.cos(S.t*19*buzz + o.slot*2)*buzz*0.9*dt*60*0.016;
      o.spin.set(2.2*buzz, 3.1*buzz, 1.4*buzz);
      if (o.grabT > 0) o.grabT -= dt;
    } else if (o.seekT > 0) {
      // Guided flight: bend the velocity toward the mark at a fixed turn
      // rate, keeping speed. Moderate rate, so a late lock can still miss.
      o.seekT -= dt;
      const target = o.seek && !o.seek.dead ? o.seek : null;
      if (target) {
        const speed = o.vel.length();
        tmp.set(target.pos.x - o.pos.x, (target.pos.y+1.2) - o.pos.y, target.pos.z - o.pos.z);
        if (tmp.lengthSq() > 1e-6) {
          tmp.normalize();
          tmp2.copy(o.vel).normalize();
          const dot = clamp(tmp2.dot(tmp), -1, 1);
          const ang = Math.acos(dot);
          if (ang > 1e-4) {
            tmp2.lerp(tmp, Math.min(1, (CFG.seekTurn*dt)/ang)).normalize();
            o.vel.copy(tmp2).multiplyScalar(speed);
          }
        }
        o.vel.y += CFG.gravity*CFG.seekGrav*dt;
      } else {
        o.seekT = 0;
        o.mesh.material = matFor(o.key, o.def);
      }
      if (o.seekT <= 0) o.mesh.material = matFor(o.key, o.def);
    } else {
      o.vel.y += CFG.gravity*dt;
    }
    // Launch ramp: push along the original throw direction until up to speed.
    if (o.boostT > 0) {
      o.boostT -= dt;
      const cur = o.vel.length();
      if (cur < o.boostTo) o.vel.addScaledVector(o.launchDir, (o.boostTo - cur) * 9 * dt);
    }
    o.pos.addScaledVector(o.vel, dt);

    if (o.pos.y < o.r) {
      o.pos.y = o.r;
      if (o.vel.y < 0) o.vel.y = -o.vel.y*CFG.restitution;
      o.vel.x *= 0.9; o.vel.z *= 0.9; o.spin.multiplyScalar(0.93);
      if (Math.abs(o.vel.y) < 0.7) o.vel.y = 0;
      if (o.seekT > 0) { o.seekT = 0; o.mesh.material = matFor(o.key, o.def); }
    }
    // prop vs solid cover
    for (const ob of obstacles) {
      if (o.pos.y > ob.h + o.r) continue;
      const dx = o.pos.x-ob.pos.x, dz = o.pos.z-ob.pos.z;
      const dd = Math.hypot(dx, dz), min2 = ob.r + o.r;
      if (dd > 0 && dd < min2) {
        const nx = dx/dd, nz = dz/dd;
        o.pos.x = ob.pos.x + nx*min2; o.pos.z = ob.pos.z + nz*min2;
        const dot = o.vel.x*nx + o.vel.z*nz;
        if (dot < 0) {
          const sp2 = o.vel.length();
          o.vel.x -= 2*dot*nx*0.55; o.vel.z -= 2*dot*nz*0.55;
          // Hitting cover hard is itself a detonation trigger.
          if (sp2 > MIN_HIT_SPEED*1.3) {
            if (o.def.explode) { detonate(o); break; }
            if (o.def.puddle)  { spill(o);    break; }
            sparks(o.pos, 0xb9b0a2, 5, 11);
            SFX.impact(o.def.mass, 0.7);
          }
        }
      }
    }
    if (o.gone) continue;

    const d = Math.hypot(o.pos.x, o.pos.z);
    if (d > CFG.arena-o.r) {
      const nx = o.pos.x/d, nz = o.pos.z/d;
      o.pos.x = nx*(CFG.arena-o.r); o.pos.z = nz*(CFG.arena-o.r);
      const dot = o.vel.x*nx + o.vel.z*nz;
      o.vel.x -= 2*dot*nx*CFG.restitution; o.vel.z -= 2*dot*nz*CFG.restitution;
    }
    // Debris the boss threw can hurt you until it slows down.
    if (o.hostile > 0) {
      o.hostile -= dt;
      const dh = Math.hypot(o.pos.x-hero.pos.x, o.pos.z-hero.pos.z);
      if (dh < 1.5 && Math.abs(o.pos.y - (hero.pos.y+1.2)) < 1.6 && o.vel.length() > 12) {
        o.hostile = 0;
        o.mesh.material = matFor(o.key, o.def);
        o.vel.multiplyScalar(0.2);
        hero.hp--;
        SFX.hurt();
        S.shake = Math.min(1, S.shake+0.5);
        el("dmg").classList.add("on");
        setTimeout(() => el("dmg").classList.remove("on"), 220);
        updateHUD();
        if (hero.hp <= 0) { gameOver(); return; }
      }
      if (o.hostile <= 0) o.mesh.material = matFor(o.key, o.def);
    }

    o.restT = o.vel.lengthSq() < 0.6 ? o.restT + dt : 0;

    o.mesh.position.copy(o.pos);
    o.mesh.rotation.x += o.spin.x*dt;
    o.mesh.rotation.y += o.spin.y*dt;
    o.mesh.rotation.z += o.spin.z*dt;
  }

  for (let i = 0; i < rocks.length; i++) {
    for (let j = i+1; j < rocks.length; j++) {
      const a = rocks[i], b = rocks[j];
      if (a.gone || b.gone) continue;
      if (a.seekT > 0 || b.seekT > 0) continue;   // guided stones pass through
      tmp.subVectors(b.pos, a.pos);
      const dd = tmp.length(), min = a.r+b.r;
      if (dd > 0 && dd < min) {
        tmp.divideScalar(dd);
        const push = (min-dd)*0.5;
        a.pos.addScaledVector(tmp,-push); b.pos.addScaledVector(tmp,push);
        tmp2.subVectors(b.vel,a.vel);
        const sep = tmp2.dot(tmp);

        // A hard knock sets off a volatile prop, whoever is carrying the
        // momentum. This is what lets a thrown rock pop a barrel across
        // the clearing rather than only barrels the player threw himself.
        const impact = Math.abs(sep);
        if (impact > MIN_HIT_SPEED) {
          if (a.def.explode) detonate(a); else if (a.def.puddle) spill(a);
          if (b.def.explode) detonate(b); else if (b.def.puddle) spill(b);
          if (a.gone || b.gone) continue;
        }
        if (sep < 0) {
          const imp = -(1+CFG.restitution)*sep/(1/a.m + 1/b.m);
          a.vel.addScaledVector(tmp,-imp/a.m);
          b.vel.addScaledVector(tmp, imp/b.m);
        }
      }
    }
  }

  // ---- walkers
  let alive = 0;
  for (const w of walkers) {
    if (w.dead) continue;
    alive++;
    w.cool = Math.max(0, w.cool - dt);

    tmp.set(hero.pos.x-w.pos.x, 0, hero.pos.z-w.pos.z);
    const dist = tmp.length();
    if (dist > 0.01) {
      tmp.divideScalar(dist);
      let spd = w.E.speed;
      // Leapers hold back, then cover ground in a burst — the threat is the
      // timing, not the top speed.
      if (w.E.leap) {
        w.leapT -= dt;
        if (w.leapT <= 0 && dist > 4 && dist < 20 && !w.air) {
          w.air = true; w.vy = 8.5; w.leapT = rand(2.2, 3.8);
        }
        if (w.air) spd = w.E.speed * 4.2;
      }
      // A body in flight is cargo, not a walker — it does not get to steer.
      if (w.thrown <= 0) w.pos.addScaledVector(tmp, spd*dt);
      w.g.rotation.y = Math.atan2(tmp.x, tmp.z);
    }

    if (w.boss) {
      // Core only lights, and only becomes vulnerable, once stripped.
      w.glow.intensity = w.platesLeft ? 0 : 5 + Math.sin(S.t*6)*2.5;
      w.core.material.emissiveIntensity = w.platesLeft ? 0.15 : 1.8;
      w.atkT -= dt;
      if (w.atkT <= 0 && dist < 30) {
        w.atkT = BOSS.atkEvery;
        // Pick up whatever is lying near it and throw that at the player.
        let pick = null, bd = 15;
        for (const o of rocks) {
          if (o.held || o.gone) continue;
          const d2 = o.pos.distanceTo(w.pos);
          if (d2 < bd && d2 > 1.5) { bd = d2; pick = o; }
        }
        if (pick) {
          tmp2.set(hero.pos.x-pick.pos.x, 2.2, hero.pos.z-pick.pos.z).normalize();
          pick.vel.copy(tmp2).multiplyScalar(34);
          pick.hostile = 1.8;
          pick.mesh.material = seekMat;
          SFX.throw();
          banner("INCOMING");
        } else {
          // Nothing to hand: slam instead.
          queueBlast(w.pos, { r:8, dmg:0 }, null);
          S.shake = Math.min(1, S.shake+0.6);
        }
      }
    }
    // Launched bodies fly on their own velocity and hurt what they meet.
    if (w.thrown > 0) {
      w.thrown -= dt;
      w.tvel.y += CFG.gravity*dt;
      w.g.rotation.z += dt*7;
      const sp3 = w.tvel.length();

      // A body at 30 m/s covers half a metre per frame and the bodies it is
      // aimed at are 1.5m across — a single integration step steps straight
      // over them at the wrong moment. Substep so the flight path is sampled
      // finely enough that contact is actually detected.
      const steps = Math.max(1, Math.min(6, Math.ceil(sp3*dt / 0.3)));
      const sdt = dt / steps;
      for (let s = 0; s < steps; s++) {
        w.pos.addScaledVector(w.tvel, sdt);

        if (sp3 > LAUNCH_MIN) {
          let stop = false;
          for (const ob of obstacles) {
            if (w.pos.y > ob.h) continue;
            const dd = Math.hypot(w.pos.x-ob.pos.x, w.pos.z-ob.pos.z);
            if (dd < ob.r + w.r) {
              w.tvel.multiplyScalar(-0.25);
              damageWalker(w, Math.min(260, sp3*11), null, 0);
              sparks(w.pos, 0x8a5a4a, 10, 16);
              SFX.impact(2.6, 1.3);
              S.shake = Math.min(1, S.shake + 0.3);
              banner("SLAMMED");
              stop = true;
              break;
            }
          }
          if (!stop) {
            for (const o2 of walkers) {
              if (o2 === w || o2.dead) continue;
              // y is the feet; a standing body occupies roughly two units
              // above it, so the strike band is one-sided, not symmetric.
              const dy = w.pos.y - o2.pos.y;
              if (dy < -1.2 || dy > 2.4) continue;
              if (Math.hypot(w.pos.x-o2.pos.x, w.pos.z-o2.pos.z) < w.r + o2.r) {
                flyingHit(w, o2, sp3);
                w.tvel.multiplyScalar(0.3);
                stop = true;
                break;
              }
            }
          }
          if (stop) break;
        }

        if (w.pos.y <= 0) {
          w.pos.y = 0;
          if (sp3 > LAUNCH_MIN) damageWalker(w, sp3*5, null, 0);
          w.thrown = 0; w.air = false; w.g.rotation.z = 0;
          break;
        }
      }
      if (w.dead) continue;
    } else if (w.air) {
      w.vy += CFG.gravity*dt;
      w.pos.y += w.vy*dt;
      if (w.pos.y <= 0) { w.pos.y = 0; w.vy = 0; w.air = false; }
    }
    if (w.kb.lengthSq() > 1e-4) {
      w.pos.addScaledVector(w.kb, dt);
      w.kb.multiplyScalar(Math.max(0, 1 - 7*dt));
    }
    if (w.flash > 0) {
      w.flash = Math.max(0, w.flash - dt*4);
      w.body.scale.setScalar(1 + w.flash*0.14);
    }
    w.walk += dt*5.5;
    w.body.rotation.z = Math.sin(w.walk)*0.11;
    w.body.position.y = Math.abs(Math.sin(w.walk))*0.075;
    w.torso.rotation.x = 0.34 + Math.sin(w.walk*0.5)*0.06;
    w.aL.rotation.x = -1.6 + Math.sin(w.walk*0.55)*0.14;
    w.aR.rotation.x = -1.6 - Math.sin(w.walk*0.55)*0.14;
    w.lL.rotation.x =  Math.sin(w.walk)*0.6;
    w.lR.rotation.x = -Math.sin(w.walk)*0.6;

    const reach = w.boss ? BOSS.reach : CFG.zReach * (w.E.scale || 1);
    if (dist < reach && w.cool <= 0 && hero.pos.y < CFG.dodgeHeight) {
      w.cool = CFG.zCooldown;
      hero.hp--;
      SFX.hurt();
      S.shake = Math.min(1, S.shake+0.45);
      el("dmg").classList.add("on");
      setTimeout(() => el("dmg").classList.remove("on"), 220);
      updateHUD();
      if (hero.hp <= 0) { gameOver(); return; }
    }

    for (const o of walkers) {
      if (o === w || o.dead) continue;
      tmp.set(o.pos.x-w.pos.x, 0, o.pos.z-w.pos.z);
      const d2 = tmp.length();
      if (d2 > 0 && d2 < 1.4) {
        tmp.divideScalar(d2).multiplyScalar((1.4-d2)*0.5);
        w.pos.sub(tmp); o.pos.add(tmp);
      }
    }

    for (const o of rocks) {
      if (o.held || o.gone) continue;
      tmp.set(o.pos.x-w.pos.x, o.pos.y-1.2, o.pos.z-w.pos.z);
      if (tmp.length() < o.r + w.r) {
        const sp = o.vel.length();

        if (o.def.explode) { detonate(o); break; }
        if (o.def.puddle)  { spill(o);    break; }

        if (sp > MIN_HIT_SPEED) {
          // Damage is proportional to how fast it was really going, capped
          // so a blast-launched prop cannot one-shot everything on the map.
          const scale = Math.min(1.6, sp / CFG.throwSpeed);
          // Head box scales with the archetype, so a Crawler's weak point is
          // genuinely harder to hit than a Tank's.
          const hy = o.pos.y / Math.max(0.4, w.E.scale);
          const weak = hy > 1.52 && hy < 2.25;
          let dmg = o.def.dmg * scale * (o.mult || 1) * MOD.allDmg;
          if (MOD.berserk && hero.hp <= 2) dmg *= 2;
          const hardness = Math.min(1.8, scale) * Math.sqrt(o.def.mass);
          if (weak) { dmg *= CFG.weakMul; banner("WEAK POINT"); SFX.weak(); }
          else SFX.impact(o.def.mass, Math.min(1.6, scale));
          tmp.y = 0; tmp.normalize();
          damageWalker(w, dmg, tmp, 4.5*(o.def.knock||1));
          // A heavy prop at speed does not shove a body, it throws it.
          const punch = scale * o.def.mass * (o.def.knock||1);
          if (punch > 2.4 && !w.dead) launchWalker(w, tmp, 9 + punch*3.2);
          if (MOD.gravity) pullToward(o.pos, 6.5, 13);
          sparks(tmp.set(o.pos.x, weak ? 1.9 : 1.3, o.pos.z),
                 weak ? 0xffd23c : 0xc9b08a,
                 Math.round((weak ? 12 : 7) * Math.min(2, o.def.mass)),
                 (weak ? 18 : 13) * Math.min(1.6, Math.sqrt(o.def.mass)));
          // A boulder should punch the camera harder than a plank.
          S.shake = Math.min(0.9, S.shake + 0.07*hardness);

          o.pierced++;
          if (o.pierced > (o.def.pierce || 0)) {
            o.vel.multiplyScalar(0.32);          // spent
            o.seekT = 0; o.mesh.material = matFor(o.key, o.def);
          } else {
            o.vel.multiplyScalar(0.86);          // punches through
          }
          break;
        } else {
          tmp.y = 0; tmp.normalize();
          w.pos.addScaledVector(tmp,-0.35);
          o.vel.multiplyScalar(0.6);
        }
      }
    }
  }

  for (let i = gibs.length-1; i >= 0; i--) {
    const g = gibs[i];
    g.vel.y += CFG.gravity*dt;
    g.mesh.position.addScaledVector(g.vel, dt);
    if (g.mesh.position.y < 0.15) { g.mesh.position.y = 0.15; g.vel.multiplyScalar(0.4); g.vel.y = Math.abs(g.vel.y)*0.3; }
    g.mesh.rotation.x += g.spin.x*dt; g.mesh.rotation.y += g.spin.y*dt;
    g.life -= dt;
    g.mesh.material.opacity = clamp(g.life/g.max,0,1);
    if (g.life <= 0) { scene.remove(g.mesh); g.mesh.material.dispose(); gibs.splice(i,1); }
  }

  // Resupply pass. A prop is a candidate once it has been consumed, or has
  // sat still well outside reach for a while — recycling the strays rather
  // than spawning more keeps the simulation size flat.
  S.recycleT -= dt;
  if (S.recycleT <= 0) {
    S.recycleT = 1.4;
    let inReach = 0;
    for (const o of rocks)
      if (!o.gone && !o.held && o.pos.distanceTo(hero.pos) < CFG.grabRadius) inReach++;
    if (inReach < 6) {
      let moved = 0;
      for (const o of rocks) {
        if (moved >= 3) break;
        if (o.held) continue;
        const far = o.pos.distanceTo(hero.pos) > CFG.grabRadius + 6;
        if (o.gone || (far && o.restT > 2)) { recycleObject(o); moved++; }
      }
    }
  }

  // Explosions are drained a few per frame. A dense barrel chain would
  // otherwise resolve entirely inside one tick and drop a frame.
  let budget = MAX_BLASTS;
  while (blastQ.length && budget-- > 0) runBlast(blastQ.shift());

  for (let i = puddles.length-1; i >= 0; i--) {
    const p = puddles[i];
    p.life -= dt;
    p.mesh.material.opacity = 0.34 * Math.max(0, p.life/p.max);
    p.mesh.scale.setScalar(0.6 + 0.4*Math.min(1, (p.max-p.life)*3));
    for (const w of walkers) {
      if (w.dead) continue;
      if (Math.hypot(w.pos.x-p.pos.x, w.pos.z-p.pos.z) < p.r) damageWalker(w, p.dps*dt, null, 0);
    }
    if (p.life <= 0) { scene.remove(p.mesh); p.mesh.material.dispose(); puddles.splice(i,1); }
  }

  for (let i = bolts.length-1; i >= 0; i--) {
    const bl = bolts[i];
    bl.life -= dt;
    bl.mesh.material.opacity = Math.max(0, bl.life/0.22);
    if (bl.life <= 0) { scene.remove(bl.mesh); bl.mesh.geometry.dispose(); bolts.splice(i,1); }
  }

  for (const s of shells) {
    if (s.life <= 0) continue;
    s.life -= dt;
    const k2 = 1 - s.life/0.42;
    s.mesh.scale.setScalar(s.r * (0.25 + k2*0.95));
    s.mesh.material.opacity = 0.55 * (1-k2);
    if (s.life <= 0) s.mesh.visible = false;
  }

  if (S.comboT > 0) {
    S.comboT -= dt;
    if (S.comboT <= 0 && S.combo) { S.combo = 0; updateHUD(); }
  }

  updateTethers();

  motes.rotation.y += dt*0.012;
  motes.position.y = Math.sin(S.t*0.25)*0.4;

  S.shake *= 0.88;

  // ---- crosshair lock
  S.lock = nearestInCone();
  el("cross").classList.toggle("lock", !!S.lock);
  el("cross").classList.toggle("armed", S.held.length > 0);

  // ---- camera
  const cd = cam.dist;
  const cx = hero.pos.x - Math.sin(cam.yaw)*Math.cos(cam.pitch)*cd;
  const cz = hero.pos.z - Math.cos(cam.yaw)*Math.cos(cam.pitch)*cd;
  const cy = 3.1 + hero.pos.y*0.6 + Math.sin(cam.pitch)*cd;
  camera.position.lerp(tmp.set(cx,cy,cz), Math.min(1,12*dt));
  if (S.shake > 0.001) {
    camera.position.x += rand(-S.shake,S.shake);
    camera.position.y += rand(-S.shake,S.shake);
  }
  camera.lookAt(hero.pos.x, 2.9 + hero.pos.y*0.6, hero.pos.z);
  sun.position.set(hero.pos.x+14, 22, hero.pos.z+10);
  sun.target.position.copy(hero.pos);
  sun.target.updateMatrixWorld();

  if (alive === 0 && S.phase === "play") { S.phase = "clear"; setTimeout(nextWave, 1200); }
}

function nextWave() {
  if (S.wave >= WAVES.length) {
    S.phase = "done";
    show(`<h1>Survived</h1><p class="sub">${WAVES.length} waves · ${S.kills} put down · ${S.score} points</p>
          <p class="rule">Nothing walked away from you.</p><button id="again">Again</button>`);
    el("again").onclick = restart;
    return;
  }
  offerDraft();
}

function startNextWave() {
  el("card").classList.remove("wide");
  S.wave++;
  el("overlay").classList.add("hide");
  ["hud","touch","cross"].forEach(i => el(i).classList.remove("hide"));
  buildWave(S.wave);
  hero.hp = Math.min(CFG.maxHealth + MOD.hpBonus, hero.hp+1);
  updateHUD();
  S.phase = "play";
  SFX.wave();
  toast("Wave " + S.wave);
}

function gameOver() {
  S.phase = "dead";
  show(`<h1>Overrun</h1><p class="sub">Wave ${S.wave} · ${S.kills} put down</p>
        <p class="rule">They got close enough to touch you.</p><button id="again">Try again</button>`);
  el("again").onclick = restart;
}

function show(html) {
  el("card").innerHTML = html;
  el("overlay").classList.remove("hide");
  ["hud","touch","cross"].forEach(i => el(i).classList.add("hide"));
}

function restart() {
  // A run's build does not carry into the next one.
  Object.assign(MOD, { singleDmg:1, burstDmg:1, allDmg:1, maxHeld:0, grabR:0,
    focusRegen:1, hpBonus:0, berserk:false, gravity:false, voidwell:false,
    lightning:0, blastR:1 });
  taken.length = 0;
  S.wave = 1; S.kills = 0; S.score = 0; hero.hp = CFG.maxHealth; S.modeCd = 0; start();
}

// Adaptive quality. Bloom re-renders the scene several times at reduced
// resolution, which a desktop GPU shrugs off and a weak phone does not.
// Rather than guess the target device, sample the real framerate for the
// first few seconds of play and drop the expensive pass if it cannot hold up.
let fxOn = true, fpsFrames = 0, fpsT0 = 0, fxJudged = false;

function dropEffects() {
  fxOn = false;
  fxJudged = true;
  renderer.setPixelRatio(1);
  resize();
  toast("Effects reduced to keep it smooth", 2600);
}

let last = performance.now();
function frame(now) {
  const dt = Math.min((now-last)/1000, 1/30);
  last = now;
  if (S.phase === "play" || S.phase === "clear") {
    step(dt);
    if (!fxJudged) {
      // WALL-CLOCK rate, deliberately not the simulation clock: dt is
      // clamped to 1/30, so measuring against it caps the computed rate at
      // 30 and would condemn every machine, fast or slow.
      if (!fpsT0) fpsT0 = now;
      fpsFrames++;
      const elapsed = (now - fpsT0) / 1000;
      if (elapsed > 3) {
        if (fpsFrames / elapsed < 40) dropEffects();
        else fxJudged = true;
      }
    }
  }
  if (fxOn) composer.render();
  else renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function start() {
  el("overlay").classList.add("hide");
  ["hud","touch","cross"].forEach(i => el(i).classList.remove("hide"));
  setMode("single", true);
  updateForceLabel();
  S.modeCd = 0;
  el("modeBtn").classList.remove("cool");
  buildWave(S.wave);
  S.phase = "play";
  last = performance.now();
  resize();
  toast("Tap FORCE to gather · then SHOOT one at a time", 3400);
}

// Browsers only allow audio to start from a gesture, so the first tap of
// the run is where the context is created.
el("startBtn").addEventListener("click", () => { audioInit(); start(); });
resize();
requestAnimationFrame(frame);
})();
