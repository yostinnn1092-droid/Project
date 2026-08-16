(function () {
"use strict";
const T = globalThis.THREE, PP = globalThis.PP;

// ═══════════════════════════════════════════════════════════════════ helpers
const clamp = (v,a,b)=> v<a?a:v>b?b:v;
const lerp  = (a,b,t)=> a+(b-a)*t;
const $     = id => document.getElementById(id);
const TAU   = Math.PI*2;

let _s = (Date.now()^0x9e3779b9)>>>0;
function rnd(){ _s^=_s<<13;_s>>>=0;_s^=_s>>17;_s^=_s<<5;_s>>>=0;return _s/4294967296; }
const rint = (a,b)=> a+Math.floor(rnd()*(b-a+1));
const pick = a => a[Math.floor(rnd()*a.length)];

// ═══════════════════════════════════════════════════════════════════ tuning
const CFG = {
  world: 230, grid: 150, sea: 0,
  // A day has to be long enough that walking to work is a fraction of it, not
  // several days of it. At 1500ms a single trip to a field took 3.9 days and
  // nobody ever reached a work site before needing to eat again.
  dayMs: 3000,            // one simulated day at 1x
  daysPerYear: 8,

  maxNpc: 340,
  npcSpawnFood: 26,       // food a village must bank to add a person

  faithPerBeliever: 0.085,
  depDrag: 0.55,

  devDecay: 0.020,
  depPerAnswer: 2.6,
  depDecay: 0.26,
  depMiracle: 2.2,

  prayGapBase: 7.0,
  prayGapDep: 3.4,
  prayMax: 5,
  prayLife: [16, 30],

  // The player loses people to apostasy; rivals never do. Measured at the old
  // rates, good play survived 900 days but trailed 46% to 83% — surviving is
  // not the same as winning, and the race has to price in that asymmetry.
  ascRate: 0.50,
  rivalAsc: 0.10,
};

// Personality. This table is the whole point of the rewrite: a refusal is not
// one number any more, it lands differently on every person who hears it.
//   gain/loss  — multiplier on faith gained from an answer / lost to a refusal
//   work       — productivity multiplier
//   fearMul    — how strongly danger registers
//   pray       — how likely they are to pray unprompted (which restores faith)
//   material   — how much their faith tracks food/safety instead of miracles
const TRAITS = {
  Devout:     { gain:1.50, loss:0.55, work:1.00, fearMul:0.90, pray:1.6, material:0.6, col:0x9fd8ff },
  Skeptic:    { gain:0.55, loss:1.60, work:1.10, fearMul:1.00, pray:0.4, material:1.3, col:0xb8c2cc },
  Zealot:     { gain:2.00, loss:2.00, work:0.90, fearMul:1.10, pray:2.0, material:0.4, col:0xffc46b },
  Stoic:      { gain:0.60, loss:0.50, work:1.15, fearMul:0.70, pray:0.6, material:0.9, col:0x9aaebd },
  Pragmatist: { gain:0.70, loss:0.90, work:1.20, fearMul:1.00, pray:0.3, material:1.9, col:0x8fd0a8 },
  Frightened: { gain:1.00, loss:1.30, work:0.85, fearMul:1.90, pray:1.2, material:1.4, col:0xd9a0d8 },
};
const TRAIT_NAMES = Object.keys(TRAITS);

const JOBS = ["farmer","hunter","builder","potter","weaver","smith","fisher","herder"];

const ERAS = [
  { n:"Stone",  at:0,   mul:1.00 },
  { n:"Bronze", at:70,  mul:1.16 },
  { n:"Iron",   at:150, mul:1.34 },
  { n:"Classical", at:250, mul:1.55 },
  { n:"Golden", at:380, mul:1.80 },
];

// ═══════════════════════════════════════════════════════════════════ names
const NA = ["Kel","Vor","Ash","Mir","Tor","Yen","Sel","Bran","Ith","Dov","Rhen","Oss","Cal",
            "Nim","Thal","Ered","Sarn","Vel","Orin","Hesp","Lun","Draz","Fen","Gar","Ume","Pell"];
const NB = ["a","o","is","en","ra","ik","us","ai","or","eth","im","ya","un","el"];
const NC = ["of the Reeds","the Elder","Cartwright","Fen-born","the Lame","Ashhand",
            "the Younger","Longwalk","Stillwater","Redbrow","", "", "", ""];
function personName(){ return pick(NA)+pick(NB)+(rnd()<0.28?" "+pick(NC):""); }
const VNA = ["Kelhollow","Vorreach","Ashfell","Miramere","Torgard","Yenstead","Selvale",
             "Branford","Ithcrest","Dovwick","Rhenmoor","Osshall","Calspire","Nimbank",
             "Thalrest","Eredwatch","Sarnmoor","Velahall","Orinford","Hespvale"];
let vni = 0;
const villageName = () => VNA[(vni++) % VNA.length] + (vni > VNA.length ? " " + Math.ceil(vni/VNA.length) : "");

// ═══════════════════════════════════════════════════════════════════ three
const cv = $("cv");
const renderer = new T.WebGLRenderer({ canvas: cv, antialias: false, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = T.PCFSoftShadowMap;
renderer.toneMapping = T.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.22;

const scene = new T.Scene();
scene.fog = new T.FogExp2(0x0a1424, 0.0055);

const cam = new T.PerspectiveCamera(42, 1, 0.5, 900);

// ── sky: a starfield dome, since the player is literally a star ────────────
function skyTexture() {
  const c = document.createElement("canvas"); c.width = 1024; c.height = 512;
  const x = c.getContext("2d");
  const g = x.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0.00, "#050a18");
  g.addColorStop(0.45, "#0a1630");
  g.addColorStop(0.72, "#14315c");
  g.addColorStop(1.00, "#1d4a7a");
  x.fillStyle = g; x.fillRect(0, 0, 1024, 512);
  // nebula wash
  for (let i = 0; i < 22; i++) {
    const cx = rnd()*1024, cy = rnd()*300, r = 60 + rnd()*180;
    const rg = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    const hue = rnd() < 0.5 ? "80,150,255" : "150,110,220";
    rg.addColorStop(0, "rgba("+hue+",0.10)"); rg.addColorStop(1, "rgba("+hue+",0)");
    x.fillStyle = rg; x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.fill();
  }
  for (let i = 0; i < 900; i++) {
    const sx = rnd()*1024, sy = rnd()*400, s = rnd();
    x.fillStyle = "rgba(255,255,255," + (0.15 + s*0.75).toFixed(2) + ")";
    x.fillRect(sx, sy, s > 0.94 ? 2 : 1, s > 0.94 ? 2 : 1);
  }
  const tex = new T.CanvasTexture(c);
  tex.mapping = T.EquirectangularReflectionMapping;
  tex.colorSpace = T.SRGBColorSpace;
  return tex;
}
const sky = skyTexture();
scene.background = sky;
const pmrem = new T.PMREMGenerator(renderer);
scene.environment = pmrem.fromEquirectangular(sky).texture;

// ── lights ────────────────────────────────────────────────────────────────
const sun = new T.DirectionalLight(0xbcd8ff, 3.0);
sun.position.set(70, 96, 46);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 20; sun.shadow.camera.far = 320;
const SH = 95;
sun.shadow.camera.left = -SH; sun.shadow.camera.right = SH;
sun.shadow.camera.top = SH;   sun.shadow.camera.bottom = -SH;
sun.shadow.bias = -0.0009;
scene.add(sun, sun.target);
scene.add(new T.HemisphereLight(0x8fc4ff, 0x243252, 1.15));

// ═══════════════════════════════════════════════════════════════════ terrain
const N = CFG.grid, WS = CFG.world;
let heights = new Float32Array(N * N);

function fbm2(x, y, tbl) {
  let v = 0, amp = 1, f = 1, norm = 0;
  for (let o = 0; o < 5; o++) {
    const xi = Math.floor(x*f), yi = Math.floor(y*f);
    const fx = x*f - xi, fy = y*f - yi;
    const g = (a,b) => tbl[(((b%16)+16)%16)*16 + (((a%16)+16)%16)];
    const sx = fx*fx*(3-2*fx), sy = fy*fy*(3-2*fy);
    v += amp * lerp(lerp(g(xi,yi), g(xi+1,yi), sx), lerp(g(xi,yi+1), g(xi+1,yi+1), sx), sy);
    norm += amp; amp *= 0.5; f *= 2.05;
  }
  return v / norm;
}

function buildTerrain() {
  const tbl = []; for (let i = 0; i < 256; i++) tbl.push(rnd());
  const tbl2 = []; for (let i = 0; i < 256; i++) tbl2.push(rnd());

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const u = i/(N-1), v = j/(N-1);
      // Island falloff so the playable land is a continent with real coast,
      // not a square that runs off the edge of the world.
      const dx = (u-0.5)*2.02, dy = (v-0.5)*2.02;
      const d = Math.hypot(dx, dy);
      const fall = clamp(1.28 - d*1.30, 0, 1);
      const e = fbm2(u*4.1, v*4.1, tbl);
      const ridge = Math.pow(fbm2(u*2.3+11, v*2.3+7, tbl2), 2.1);
      let h = (e*0.72 + ridge*0.52) * fall * 30 - 7.2;
      // flatten shallow land slightly so villages have somewhere to sit
      if (h > 0 && h < 5) h *= 0.72;
      heights[j*N+i] = h;
    }
  }
}

const hIdx = (i,j) => heights[clamp(j,0,N-1)*N + clamp(i,0,N-1)];
// World position -> terrain height, bilinear. Everything that stands on the
// ground goes through this so nothing ever floats or sinks.
function groundAt(x, z) {
  const u = (x/WS + 0.5)*(N-1), v = (z/WS + 0.5)*(N-1);
  const i = Math.floor(u), j = Math.floor(v);
  const fx = u-i, fy = v-j;
  return lerp(lerp(hIdx(i,j), hIdx(i+1,j), fx), lerp(hIdx(i,j+1), hIdx(i+1,j+1), fx), fy);
}
function slopeAt(x, z) {
  const d = WS/(N-1);
  return Math.abs(groundAt(x+d,z)-groundAt(x-d,z)) + Math.abs(groundAt(x,z+d)-groundAt(x,z-d));
}

let terrainMesh;
function makeTerrainMesh() {
  const geo = new T.PlaneGeometry(WS, WS, N-1, N-1);
  geo.rotateX(-Math.PI/2);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count*3);
  const c = new T.Color();

  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k), z = pos.getZ(k);
    const h = groundAt(x, z);
    pos.setY(k, h);
    const s = slopeAt(x, z);

    // Colour by height band and steepness. Snow on peaks, rock on cliffs,
    // grass in the middle, sand at the waterline.
    if (h < 0.35)      c.setHex(0x2e4a63).lerp(new T.Color(0x3f6b8a), clamp(h/0.35,0,1));
    else if (h < 1.6)  c.setHex(0x6e6a4e);
    else if (h < 11)   c.setHex(0x2f4a2c).lerp(new T.Color(0x496b33), clamp((h-1.6)/9,0,1));
    else if (h < 17)   c.setHex(0x50554a);
    else               c.setHex(0xc9d6e2);
    if (s > 2.4 && h > 1.0) c.lerp(new T.Color(0x4a4b50), clamp((s-2.4)/3.2, 0, 0.8));
    // subtle per-vertex noise so large flats are not one dead colour
    const n = 0.92 + fbm2(x*0.09, z*0.09, [0.2,0.7,0.4,0.9,0.1,0.6,0.35,0.85,
      0.5,0.25,0.75,0.15,0.65,0.45,0.95,0.05].concat(new Array(240).fill(0.5)))*0.16;
    col[k*3] = c.r*n; col[k*3+1] = c.g*n; col[k*3+2] = c.b*n;
  }
  geo.setAttribute("color", new T.BufferAttribute(col, 3));
  geo.computeVertexNormals();

  const mat = new T.MeshStandardMaterial({ vertexColors:true, roughness:0.95, metalness:0.0,
                                            envMapIntensity:0.35, flatShading:false });
  terrainMesh = new T.Mesh(geo, mat);
  terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);
}

function makeWater() {
  const g = new T.PlaneGeometry(WS*1.9, WS*1.9);
  g.rotateX(-Math.PI/2);
  const m = new T.MeshStandardMaterial({ color:0x0e2b4d, roughness:0.10, metalness:0.55,
                                          transparent:true, opacity:0.90, envMapIntensity:1.5 });
  const w = new T.Mesh(g, m);
  w.position.y = CFG.sea;
  scene.add(w);
  return w;
}

// ═══════════════════════════════════════════════════════════════════ props
// Trees and rocks as instanced meshes. A few thousand of each is free; the
// same geometry drawn individually would not be.
function scatterProps() {
  const treeGeo = new T.ConeGeometry(1.15, 3.4, 6);
  treeGeo.translate(0, 1.7, 0);
  const trunkGeo = new T.CylinderGeometry(0.17, 0.24, 1.0, 5);
  trunkGeo.translate(0, 0.5, 0);
  const rockGeo = new T.DodecahedronGeometry(0.72, 0);

  const treeMat  = new T.MeshStandardMaterial({ color:0x2c4a2a, roughness:0.92, flatShading:true });
  const trunkMat = new T.MeshStandardMaterial({ color:0x3a2c20, roughness:1.0 });
  const rockMat  = new T.MeshStandardMaterial({ color:0x5a5d63, roughness:0.9, flatShading:true });

  const spots = [];
  for (let k = 0; k < 5200; k++) {
    const x = (rnd()-0.5)*WS*0.96, z = (rnd()-0.5)*WS*0.96;
    const h = groundAt(x,z), s = slopeAt(x,z);
    if (h > 1.7 && h < 13.5 && s < 2.6) spots.push([x,h,z]);
  }
  // Thinned from 2400: at full density villages were buried in forest and the
  // people walking between them were invisible from any useful camera height.
  const nTree = Math.min(spots.length, 1250);
  const tI = new T.InstancedMesh(treeGeo, treeMat, nTree);
  const kI = new T.InstancedMesh(trunkGeo, trunkMat, nTree);
  const m4 = new T.Matrix4(), q = new T.Quaternion(), sc = new T.Vector3(), p = new T.Vector3();
  for (let i = 0; i < nTree; i++) {
    const [x,h,z] = spots[i];
    const s = 0.7 + rnd()*0.9;
    p.set(x,h,z); q.setFromAxisAngle(new T.Vector3(0,1,0), rnd()*TAU); sc.set(s,s*(0.8+rnd()*0.5),s);
    m4.compose(p,q,sc);
    tI.setMatrixAt(i, m4); kI.setMatrixAt(i, m4);
  }
  tI.castShadow = kI.castShadow = true;
  tI.instanceMatrix.needsUpdate = kI.instanceMatrix.needsUpdate = true;
  scene.add(tI, kI);

  const rocks = [];
  for (let k = 0; k < 1400; k++) {
    const x = (rnd()-0.5)*WS*0.96, z = (rnd()-0.5)*WS*0.96;
    const h = groundAt(x,z);
    if (h > 0.6) rocks.push([x,h,z]);
  }
  const rI = new T.InstancedMesh(rockGeo, rockMat, rocks.length);
  for (let i = 0; i < rocks.length; i++) {
    const [x,h,z] = rocks[i];
    const s = 0.35 + rnd()*0.9;
    p.set(x,h-0.1,z);
    q.setFromEuler(new T.Euler(rnd()*TAU, rnd()*TAU, rnd()*TAU));
    sc.set(s,s*0.75,s);
    m4.compose(p,q,sc); rI.setMatrixAt(i,m4);
  }
  rI.castShadow = rI.receiveShadow = true;
  rI.instanceMatrix.needsUpdate = true;
  scene.add(rI);
}

// ═══════════════════════════════════════════════════════════════════ state
const G = {
  running:false, over:false, speed:1, day:0, acc:0,
  faith:60, devotion:0, dependency:0, ascension:0,
  villages:[], npcs:[], prayers:[], rivals:[],
  nextPray:5, nextEvent:14,
  answered:0, denied:0, expired:0, miracles:0, left:0,
  sel:null, fx:[],
};

// ═══════════════════════════════════════════════════════════════════ village
const bGeoHut  = new T.CylinderGeometry(0.9, 1.05, 1.1, 6);
const bGeoRoof = new T.ConeGeometry(1.35, 1.25, 6);
const bGeoHall = new T.BoxGeometry(2.6, 1.8, 3.6);
const bGeoShrine = new T.OctahedronGeometry(0.85, 0);
const matWall  = new T.MeshStandardMaterial({ color:0xa8977c, roughness:0.92 });
const matRoof  = new T.MeshStandardMaterial({ color:0x6b4630, roughness:0.9 });
const matHall  = new T.MeshStandardMaterial({ color:0x8f8672, roughness:0.85 });
const matShrine= new T.MeshStandardMaterial({ color:0x9fd8ff, emissive:0x2b6fa8,
                                               emissiveIntensity:1.5, roughness:0.3, metalness:0.4 });

function makeVillage(x, z, owner) {
  const g = new T.Group();
  g.position.set(x, groundAt(x,z), z);
  scene.add(g);

  const v = {
    name: villageName(), owner, g, x, z,
    food: 34, danger: 0, buildings: [], shrine: null,
    npcs: [], workSites: [], selfRel: 0.5, spawnAcc: 0,
  };

  // shrine at the centre — where people go to pray, and the visual anchor
  const sh = new T.Mesh(bGeoShrine, matShrine);
  sh.position.y = 1.5; sh.castShadow = true;
  g.add(sh); v.shrine = sh;

  addBuilding(v); addBuilding(v);
  // work sites are just points around the village that people walk to
  for (let i = 0; i < 8; i++) {
    const a = (i/8)*TAU + rnd()*0.5, r = 4 + rnd()*5;
    const wx = x + Math.cos(a)*r, wz = z + Math.sin(a)*r;
    if (groundAt(wx,wz) > 0.4) v.workSites.push(new T.Vector3(wx, groundAt(wx,wz), wz));
  }
  if (!v.workSites.length) v.workSites.push(new T.Vector3(x, groundAt(x,z), z));

  G.villages.push(v);
  return v;
}

function addBuilding(v) {
  if (v.buildings.length >= 14) return;
  let bx, bz, ok = false;
  for (let i = 0; i < 24 && !ok; i++) {
    const a = rnd()*TAU, r = 2.6 + rnd()*7.5;
    bx = v.x + Math.cos(a)*r; bz = v.z + Math.sin(a)*r;
    if (groundAt(bx,bz) > 0.5 && slopeAt(bx,bz) < 2.2) ok = true;
  }
  if (!ok) return;
  const grp = new T.Group();
  const wall = new T.Mesh(bGeoHut, matWall);  wall.position.y = 0.55;
  const roof = new T.Mesh(bGeoRoof, matRoof); roof.position.y = 1.6;
  wall.castShadow = roof.castShadow = true;
  wall.receiveShadow = true;
  grp.add(wall, roof);
  grp.position.set(bx - v.x, groundAt(bx,bz) - v.g.position.y, bz - v.z);
  grp.rotation.y = rnd()*TAU;
  v.g.add(grp);
  v.buildings.push({ grp, x:bx, z:bz });
}

// ═══════════════════════════════════════════════════════════════════ people
// One InstancedMesh for every person in the world. Colour carries state:
// trait hue normally, shifting toward red when afraid and toward grey as
// their faith in you dies.
// Scaled up from 0.26/0.52: at true human proportion against 3.4-unit trees a
// person was a couple of pixels and the whole point of the game — watching
// individuals decide things — was invisible.
const npcGeo = new T.CapsuleGeometry(0.34, 0.80, 3, 6);
npcGeo.translate(0, 0.74, 0);
const npcMat = new T.MeshStandardMaterial({ roughness:0.72, metalness:0.05 });
let npcMesh = null;
const _m4 = new T.Matrix4(), _q = new T.Quaternion(), _v3 = new T.Vector3(),
      _sc = new T.Vector3(1,1,1), _col = new T.Color();

function initNpcMesh() {
  npcMesh = new T.InstancedMesh(npcGeo, npcMat, CFG.maxNpc);
  npcMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
  npcMesh.castShadow = true;
  npcMesh.count = 0;
  scene.add(npcMesh);
}

const ST = { WORK:0, HOME:1, REST:2, FOOD:3, PRAY:4, FLEE:5, LEAVE:6 };

function spawnNpc(v) {
  if (G.npcs.length >= CFG.maxNpc) return null;
  const trait = pick(TRAIT_NAMES);
  const b = v.buildings.length ? pick(v.buildings) : null;
  const n = {
    name: personName(), trait, job: pick(JOBS), village: v,
    pos: new T.Vector3(v.x + (rnd()-0.5)*6, 0, v.z + (rnd()-0.5)*6),
    tgt: new T.Vector3(), heading: rnd()*TAU, speed: 2.6 + rnd()*0.8,
    home: b ? new T.Vector3(b.x, 0, b.z) : new T.Vector3(v.x, 0, v.z),
    faith: 0.45 + rnd()*0.30,
    hunger: rnd()*0.3, fear: 0, mood: 0,
    state: ST.WORK, stT: rnd()*3, think: rnd()*2,
    age: 0, alive: true, said: "",
  };
  n.pos.y = groundAt(n.pos.x, n.pos.z);
  pickTarget(n);
  G.npcs.push(n); v.npcs.push(n);
  return n;
}

function pickTarget(n) {
  const v = n.village;
  if (n.state === ST.WORK)      n.tgt.copy(pick(v.workSites));
  else if (n.state === ST.FOOD) n.tgt.set(v.x, 0, v.z);
  else if (n.state === ST.PRAY) n.tgt.set(v.x + (rnd()-0.5)*2.4, 0, v.z + (rnd()-0.5)*2.4);
  else if (n.state === ST.LEAVE){
    // walk toward the nearest map edge and vanish
    const a = Math.atan2(n.pos.z, n.pos.x);
    n.tgt.set(Math.cos(a)*WS*0.62, 0, Math.sin(a)*WS*0.62);
  }
  else if (n.state === ST.FLEE) {
    const a = rnd()*TAU;
    n.tgt.set(n.pos.x + Math.cos(a)*14, 0, n.pos.z + Math.sin(a)*14);
  }
  else n.tgt.copy(n.home);
  n.tgt.y = groundAt(n.tgt.x, n.tgt.z);
}

// The decision function. This is what the brief asked for: nobody is told what
// to do. Each person weighs their own hunger, fear and belief and picks.
function decide(n) {
  const tr = TRAITS[n.trait];
  const v = n.village;

  // Losing faith is not the same as giving up on you. Doubt has to be
  // sustained across several reconsiderations before anyone actually walks.
  //
  // Instantaneous apostasy at faith<0.12 was the single biggest source of
  // instability in this sim: one bad stretch pushed a whole village past the
  // line on the same tick, production collapsed, and the survivors followed.
  // Measured across 8 seeds, good play survived only 4 times. Requiring doubt
  // to persist staggers departures and lets a village recover from a scare.
  if (n.faith < 0.10) n.doubt = (n.doubt || 0) + 1; else n.doubt = 0;
  if (n.doubt >= 5 && n.state !== ST.LEAVE) {
    n.state = ST.LEAVE;
    n.said = "I waited. Nothing came.";
    logLine("b", n.name + " (" + n.trait + ") stops believing and leaves " + v.name + ".");
    G.left++;
    pickTarget(n); return;
  }
  if (n.state === ST.LEAVE) return;

  const fear = n.fear * tr.fearMul;
  if (fear > 0.55) {
    // the devout pray when frightened; everyone else runs
    n.state = (rnd() < tr.pray*0.28 && n.faith > 0.5) ? ST.PRAY : ST.FLEE;
    n.said = n.state === ST.PRAY ? "Please. Please look at us." : "I'm not staying for this.";
  } else if (n.hunger > 0.50) {
    // Eat well before starving. The old 0.72 trigger sat above the 0.45 "go
    // home and rest" branch, so people idled hungry instead of eating and
    // parked themselves in the faith-draining middle band indefinitely.
    n.state = ST.FOOD;
    n.said = "There has to be something left in the stores.";
  } else if (rnd() < 0.055 * tr.pray && n.faith > 0.25) {
    n.state = ST.PRAY;
    n.said = "It costs nothing to ask.";
  } else {
    n.state = ST.WORK;
    n.said = n.job === "farmer" ? "The field won't turn itself."
           : n.job === "hunter" ? "Tracks by the treeline this morning."
           : "Work to do.";
  }
  pickTarget(n);
}

function stepNpc(n, dt) {
  const tr = TRAITS[n.trait], v = n.village;
  n.age += dt;
  n.think -= dt;
  if (n.think <= 0) { decide(n); n.think = 2.2 + rnd()*2.6; }

  // ── movement: steer toward target, follow the ground ────────────────────
  const dx = n.tgt.x - n.pos.x, dz = n.tgt.z - n.pos.z;
  const d = Math.hypot(dx, dz);
  if (d > 0.6) {
    const want = Math.atan2(dz, dx);
    // ease the heading so they turn instead of snapping
    let diff = ((want - n.heading + Math.PI*3) % TAU) - Math.PI;
    n.heading += diff * Math.min(1, dt*5);
    const sp = n.speed * (n.state === ST.FLEE ? 1.9 : 1) * (0.7 + n.faith*0.5);
    let nx = n.pos.x + Math.cos(n.heading)*sp*dt;
    let nz = n.pos.z + Math.sin(n.heading)*sp*dt;
    // nobody walks into the sea
    if (groundAt(nx, nz) > 0.25) { n.pos.x = nx; n.pos.z = nz; }
    else { n.heading += 1.6*dt; }
  } else {
    // arrived — do the thing
    if (n.state === ST.WORK) {
      // 0.40/sec against 0.16/day consumption. At the ~50% uptime the walk
      // cycle actually allows, that is roughly +0.44 food per person per day —
      // enough to bank toward a birth without the village exploding.
      // Faith barely touches output. It used to swing production 2.36x, which
      // closed a loop — faith down, food down, hunger up, faith down faster —
      // whose negative arm was six times its positive arm, so it only ever ran
      // one direction and every population died regardless of play. People work
      // because they are people; belief is a rounding error on the harvest.
      // Dependency is subtracted from output directly. Throttling faith income
      // alone was too indirect to matter once individual agents carried the
      // economy — measured across 8 seeds, answering everything and answering
      // selectively produced identical outcomes. A people who are always
      // rescued stop doing the rescuing, and that has to show up in the harvest.
      const dep = 1 - (G.dependency/100)*0.45;
      v.food += 0.40 * tr.work * dt * eraMul() * (0.90 + n.faith*0.25) * dep;
      n.hunger += 0.030 * dt;
    } else if (n.state === ST.FOOD) {
      // Eat down to genuinely fed, not just below the trigger, so a meal
      // actually reaches the band where belief recovers.
      if (v.food > 1) { v.food -= 0.7*dt; n.hunger = Math.max(0, n.hunger - 0.55*dt); }
      else n.hunger += 0.02*dt;
    } else if (n.state === ST.PRAY) {
      n.faith = clamp(n.faith + 0.020*dt*tr.pray, 0, 1);
      n.hunger += 0.018*dt;
    } else if (n.state === ST.REST || n.state === ST.HOME) {
      n.hunger += 0.016*dt;
    }
    if (n.state === ST.LEAVE) { removeNpc(n); return; }
  }
  n.pos.y = groundAt(n.pos.x, n.pos.z);

  // ── drives ──────────────────────────────────────────────────────────────
  n.hunger = clamp(n.hunger + 0.010*dt, 0, 1.4);
  n.fear   = clamp(n.fear - 0.10*dt + v.danger*0.16*dt, 0, 1);

  // ── belief drifts with material conditions ──────────────────────────────
  // A pragmatist's faith is basically a readout of whether they ate. A zealot
  // barely notices. This is where trait shows up without any prayer at all.
  //
  // The middle band must be exactly zero. It was -0.004/sec, and because
  // hunger sits in that band nearly all the time, every person in the world
  // bled faith continuously with nothing to offset it — whole populations
  // hit the apostasy threshold and walked off the map regardless of play.
  // Belief now only moves when something is actually wrong or actually right.
  const fed = n.hunger < 0.40, starving = n.hunger > 0.85, safe = n.fear < 0.35;
  let material = 0;
  if (starving)            material -= 0.030;
  else if (fed && safe)    material += 0.009;   // must not fully offset refusals
  if (n.fear > 0.5)        material -= 0.026;
  n.faith = clamp(n.faith + material * tr.material * dt, 0, 1);

  if (n.hunger >= 1.35) { // starved
    logLine("b", n.name + " starves in " + v.name + ".");
    removeNpc(n);
  }
}

function removeNpc(n) {
  n.alive = false;
  const i = G.npcs.indexOf(n); if (i >= 0) G.npcs.splice(i,1);
  const j = n.village.npcs.indexOf(n); if (j >= 0) n.village.npcs.splice(j,1);
  for (let k = G.prayers.length-1; k >= 0; k--)
    if (G.prayers[k].npc === n) { G.prayers.splice(k,1); renderPrayers(); }
  if (G.sel === n) { G.sel = null; $("soul").style.display = "none"; }
}

function syncNpcMesh() {
  if (!npcMesh) return;
  const c = Math.min(G.npcs.length, CFG.maxNpc);
  npcMesh.count = c;
  for (let i = 0; i < c; i++) {
    const n = G.npcs[i];
    _v3.copy(n.pos);
    _q.setFromAxisAngle(new T.Vector3(0,1,0), -n.heading + Math.PI/2);
    const bob = n.state === ST.WORK || n.state === ST.FLEE
              ? 1 + Math.sin(n.age*9)*0.035 : 1;
    _sc.set(1, bob, 1);
    _m4.compose(_v3, _q, _sc);
    npcMesh.setMatrixAt(i, _m4);

    _col.setHex(TRAITS[n.trait].col);
    // faith drains the colour out of a person; fear pushes it red
    _col.lerp(new T.Color(0x4a4f57), (1 - n.faith) * 0.72);
    if (n.fear > 0.4) _col.lerp(new T.Color(0xff6a6a), (n.fear-0.4)*0.8);
    if (G.sel === n)  _col.setHex(0xffffff);
    npcMesh.setColorAt(i, _col);
  }
  npcMesh.instanceMatrix.needsUpdate = true;
  if (npcMesh.instanceColor) npcMesh.instanceColor.needsUpdate = true;
}

// ═══════════════════════════════════════════════════════════════════ prayers
const KINDS = [
  { id:"famine", urg:true, cost:[18,32],
    t:["The stores at {v} are empty. {n} is asking for the fields to come back.",
       "{n} has not eaten in three days and is asking on behalf of the whole of {v}."],
    deny:(v,n)=>{ v.food = Math.max(0, v.food-14); for(const p of v.npcs) p.hunger += 0.22; } },
  { id:"beast",  urg:true, cost:[16,28],
    t:["Something is killing the herds outside {v}. {n} wants it gone.",
       "{n} says four are dead at the treeline and it has not left."],
    deny:(v,n)=>{ v.danger += 0.9; for(const p of v.npcs) p.fear = clamp(p.fear+0.4,0,1); } },
  { id:"plague", urg:true, cost:[28,48],
    t:["A sickness is moving through {v}. {n} is asking you to stop it.",
       "{n} has buried two children this week and is asking why."],
    deny:(v,n)=>{ for(const p of v.npcs) if(rnd()<0.35) p.hunger += 0.3; v.danger += 0.5; } },
  { id:"guide",  urg:false, cost:[20,36],
    t:["{n} wants to know how to work the ore they found near {v}.",
       "{n} is trying to build something that will not stand up, and is asking for help."],
    deny:(v,n)=>{ v.selfRel = clamp(v.selfRel+0.05,0,1); } },
  { id:"bless",  urg:false, cost:[10,18],
    t:["{n} had a child born living and would like you to know about it.",
       "{n} is getting married in {v} and has asked you to be present, somehow.",
       "{n} simply wants to be certain you are there."],
    deny:(v,n)=>{} },
  { id:"rain",   urg:false, cost:[18,30],
    t:["The wells at {v} are mud. {n} is asking for rain.",
       "{n} says nothing has fallen on {v} in two seasons."],
    deny:(v,n)=>{ v.food = Math.max(0, v.food-7); } },
];

function spawnPrayer() {
  const mine = G.villages.filter(v => v.owner === 0 && v.npcs.length);
  if (!mine.length) return;
  const v = pick(mine);
  // the person who prays is chosen by who is actually suffering
  let best = null, bw = -1;
  for (const n of v.npcs) {
    const w = n.hunger*1.4 + n.fear*1.5 + TRAITS[n.trait].pray*0.5 + rnd()*0.8;
    if (w > bw) { bw = w; best = n; }
  }
  if (!best) return;
  // Self-reliant villages solve some things instead of asking. This was 0.40,
  // which made "refuse everything" dominant: each refusal bought self-reliance,
  // self-reliance silenced the next prayer, and the whole thing snowballed into
  // permanent quiet. Refusal has to buy resilience, never immunity.
  if (rnd() < v.selfRel*0.20) { v.danger = Math.max(0, v.danger-0.25); return; }

  // Never queue the same trouble from the same village twice — two cards side
  // by side reading "a sickness is moving through Miramere" looks like a bug
  // and gives the player two copies of one decision.
  const avail = KINDS.filter(k => !G.prayers.some(p => p.v === v && p.kind.id === k.id));
  if (!avail.length) return;
  const kind = pick(avail);
  const cost = Math.round(lerp(kind.cost[0], kind.cost[1], rnd()) * eraMul());
  const p = { kind, v, npc: best, cost,
              text: pick(kind.t).replace("{v}", v.name).replace(/\{n\}/g, best.name),
              life: rint(CFG.prayLife[0], CFG.prayLife[1]) };
  p.maxLife = p.life;
  G.prayers.push(p);
  while (G.prayers.length > CFG.prayMax) resolveExpire(G.prayers.shift(), true);
  renderPrayers();
}

// An answer lands on the person who asked, hard, and on everyone who could see
// it, softly — each filtered through their own temperament.
function ripple(v, npc, delta, miracle) {
  for (const n of v.npcs) {
    const tr = TRAITS[n.trait];
    const near = n === npc ? 1 : 0.42;
    const mul = delta > 0 ? tr.gain : tr.loss;
    n.faith = clamp(n.faith + delta * near * mul * (miracle ? 1.9 : 1), 0, 1);
  }
}

function answer(p, miracle) {
  const cost = miracle ? Math.round(p.cost*2.1) : p.cost;
  if (G.faith < cost) return;
  G.faith -= cost;
  G.dependency = clamp(G.dependency + CFG.depPerAnswer*(miracle?CFG.depMiracle:1), 0, 100);
  p.v.selfRel = clamp(p.v.selfRel - 0.035*(miracle?2:1), 0, 1);
  ripple(p.v, p.npc, miracle ? 0.30 : 0.17, miracle);

  // the answer actually does something in the world
  if (p.kind.id === "famine" || p.kind.id === "rain") p.v.food += miracle ? 42 : 22;
  if (p.kind.id === "beast" || p.kind.id === "plague") {
    p.v.danger = 0;
    for (const n of p.v.npcs) n.fear = Math.max(0, n.fear - (miracle?1:0.6));
  }
  if (p.kind.id === "guide") p.v.selfRel = clamp(p.v.selfRel+0.02,0,1);
  if (miracle) { p.v.food += 10; addBuilding(p.v); }

  G.answered++; if (miracle) G.miracles++;
  pulse(p.v, miracle);
  logLine(miracle?"i":"g", (miracle?"You break the sky over ":"You answer ") + p.npc.name + " of " + p.v.name + ".");
  drop(p);
}

function refuse(p) {
  ripple(p.v, p.npc, -0.19, false);
  p.kind.deny(p.v, p.npc);
  p.v.selfRel = clamp(p.v.selfRel + 0.03, 0, 1);
  G.denied++;
  logLine("", "You say nothing to " + p.npc.name + ".");
  drop(p);
}

function resolveExpire(p, overflow) {
  // Neglect must cost more than refusal — a decision should always beat
  // letting someone wait, or the panel becomes something to ignore.
  ripple(p.v, p.npc, -0.26, false);
  p.kind.deny(p.v, p.npc);
  G.expired++;
  logLine("b", p.npc.name + " waited and you did not come.");
  if (!overflow) drop(p); else renderPrayers();
}

function drop(p) {
  const i = G.prayers.indexOf(p); if (i>=0) G.prayers.splice(i,1);
  renderPrayers();
}

// ═══════════════════════════════════════════════════════════════════ effects
const ringGeo = new T.RingGeometry(0.6, 1.0, 40);
ringGeo.rotateX(-Math.PI/2);
// depthTest off, and a radius that stays inside the village. A flat ring
// expanding to 26 units across terrain that rolls by several units rendered as
// a huge white crescent slicing through hillsides — it read as a rendering
// fault, not a blessing. Kept local, it reads as a halo over the settlement.
const ringMat = new T.MeshBasicMaterial({ color:0x9fd8ff, transparent:true, opacity:0.8,
                                           side:T.DoubleSide, depthWrite:false,
                                           depthTest:false });
function pulse(v, big) {
  const m = new T.Mesh(ringGeo, ringMat.clone());
  m.position.set(v.x, groundAt(v.x,v.z)+1.2, v.z);
  m.renderOrder = 5;
  scene.add(m);
  G.fx.push({ m, t:0, max: big?1.5:1.0, r: big?9:5 });
}
function stepFx(dt) {
  for (let i = G.fx.length-1; i >= 0; i--) {
    const f = G.fx[i]; f.t += dt;
    const k = f.t / f.max;
    if (k >= 1) { scene.remove(f.m); f.m.material.dispose(); G.fx.splice(i,1); continue; }
    const s = 1 + k*f.r;
    f.m.scale.set(s,1,s);
    f.m.material.opacity = 0.85*(1-k);
  }
}

// ═══════════════════════════════════════════════════════════════════ world sim
const eraMul = () => currentEra().mul;
function currentEra(){
  let e = ERAS[0];
  for (const x of ERAS) if (G.npcs.filter(n=>n.village.owner===0).length >= x.at) e = x;
  return e;
}
const myVillages = () => G.villages.filter(v=>v.owner===0);
const myPeople   = () => G.npcs.filter(n=>n.village.owner===0);

function avgFaith(){
  const p = myPeople(); if (!p.length) return 0;
  return p.reduce((s,n)=>s+n.faith,0)/p.length;
}

function dayTick() {
  G.day++;
  const era = currentEra();

  // Devotion is no longer a free-floating number — it IS the average of what
  // every living person privately believes. That is the whole rewrite.
  G.devotion = avgFaith()*100;
  G.dependency = clamp(G.dependency - CFG.depDecay, 0, 100);

  const drag = 1 - (G.dependency/100)*CFG.depDrag;
  let believers = 0;
  for (const n of myPeople()) believers += n.faith;
  G.faith += believers * CFG.faithPerBeliever * drag * era.mul;

  for (const v of G.villages) {
    v.danger = Math.max(0, v.danger - 0.10);
    v.selfRel = clamp(v.selfRel - 0.0015, 0, 1);
    v.food -= v.npcs.length * 0.16;
    if (v.food < 0) { v.food = 0; for (const n of v.npcs) n.hunger += 0.07; }

    // people are born when there is food to feed them
    v.spawnAcc += 0.04 * (v.food > CFG.npcSpawnFood ? 1 : 0) * era.mul;
    if (v.spawnAcc >= 1 && v.npcs.length < 26) {
      v.spawnAcc = 0; v.food -= 12;
      const n = spawnNpc(v);
      if (n && v.owner === 0 && rnd() < 0.25)
        logLine("", n.name + " is born in " + v.name + ".");
      if (v.npcs.length > v.buildings.length*2) addBuilding(v);
    }

    // villages throw off new villages
    if (v.npcs.length >= 14 && v.food > 60 && rnd() < (v.owner===0 ? 0.030 : 0.014)) {
      const a = rnd()*TAU, r = 26 + rnd()*22;
      const nx = v.x + Math.cos(a)*r, nz = v.z + Math.sin(a)*r;
      if (Math.abs(nx) < WS*0.44 && Math.abs(nz) < WS*0.44 &&
          groundAt(nx,nz) > 1.2 && slopeAt(nx,nz) < 2.0 &&
          G.villages.every(o => Math.hypot(o.x-nx,o.z-nz) > 20)) {
        const nv = makeVillage(nx, nz, v.owner);
        nv.selfRel = v.selfRel;
        v.food -= 40;
        for (let i = 0; i < 4; i++) {
          const mover = v.npcs[v.npcs.length-1-i];
          if (mover) { mover.village = nv; nv.npcs.push(mover);
                       v.npcs.splice(v.npcs.indexOf(mover),1);
                       mover.home.set(nv.x,0,nv.z); }
        }
        if (v.owner === 0) logLine("i", nv.name + " is founded out of " + v.name + ".");
      }
    }
  }

  // prayers
  for (let i = G.prayers.length-1; i>=0; i--)
    if (--G.prayers[i].life <= 0) resolveExpire(G.prayers[i], false);
  if (--G.nextPray <= 0) {
    spawnPrayer();
    const gap = Math.max(2.4, CFG.prayGapBase - (G.dependency/100)*CFG.prayGapDep
                              - myVillages().length*0.15);
    G.nextPray = Math.round(gap*lerp(0.7,1.35,rnd()));
  }

  // world events
  if (--G.nextEvent <= 0) {
    worldEvent();
    G.nextEvent = Math.round(15*lerp(0.7,1.5,rnd()));
  }

  // rivals
  for (const rv of G.rivals) {
    const rp = G.npcs.filter(n=>n.village.owner===rv.idx).length;
    rv.asc += (rp/60) * CFG.rivalAsc * era.mul;
  }

  G.ascension += (myPeople().length/60) * (G.devotion/100) * CFG.ascRate * era.mul;

  if (G.devotion <= 3 || !myPeople().length) return end(false);
  if (G.ascension >= 100) return end(true);
  for (const rv of G.rivals) if (rv.asc >= 100) return end(false, rv);
}

const EVENTS = [
  { n:"A hard winter settles over the world.", f:()=>{ for(const v of myVillages()) v.food*=0.72; } },
  { n:"A generous spring.",                    f:()=>{ for(const v of myVillages()) v.food+=26; } },
  { n:"Something is moving in the deep forest.",f:()=>{ for(const v of myVillages()) if(rnd()<0.5) v.danger+=1.1; } },
  { n:"A still, uneventful year.",             f:()=>{ for(const v of myVillages()) v.danger=Math.max(0,v.danger-1); } },
];
function worldEvent(){ const e = pick(EVENTS); e.f(); logLine(e.n.includes("generous")||e.n.includes("still")?"g":"b", e.n); }

// ═══════════════════════════════════════════════════════════════════ camera
// Clash-of-Clans style: a fixed-ish tilt looking at a focus point on the
// ground, drag to pan that point, wheel to zoom, Q/E to swing the yaw.
const CAM = { fx:0, fz:0, dist:64, yaw:0.6, pitch:0.86, minD:16, maxD:150 };
function updateCam() {
  CAM.fx = clamp(CAM.fx, -WS*0.5, WS*0.5);
  CAM.fz = clamp(CAM.fz, -WS*0.5, WS*0.5);
  const gy = groundAt(CAM.fx, CAM.fz);
  const cy = Math.sin(CAM.pitch)*CAM.dist;
  const cr = Math.cos(CAM.pitch)*CAM.dist;
  cam.position.set(CAM.fx + Math.cos(CAM.yaw)*cr, gy + cy, CAM.fz + Math.sin(CAM.yaw)*cr);
  cam.lookAt(CAM.fx, gy + 2, CAM.fz);
  sun.target.position.set(CAM.fx, gy, CAM.fz);
  sun.position.set(CAM.fx + 70, gy + 96, CAM.fz + 46);
}

let drag = false, lastX = 0, lastY = 0, moved = 0;
cv.addEventListener("pointerdown", e => {
  drag = true; moved = 0; lastX = e.clientX; lastY = e.clientY;
  cv.classList.add("drag"); cv.setPointerCapture(e.pointerId);
});
cv.addEventListener("pointermove", e => {
  if (!drag) return;
  const dx = e.clientX-lastX, dy = e.clientY-lastY;
  lastX = e.clientX; lastY = e.clientY;
  moved += Math.abs(dx)+Math.abs(dy);
  const k = CAM.dist*0.0016;
  // pan in camera space so dragging always moves the world the way it looks
  const cs = Math.cos(CAM.yaw), sn = Math.sin(CAM.yaw);
  CAM.fx += (-dx*(-sn) - dy*(-cs))*k;
  CAM.fz += (-dx*( cs) - dy*(-sn))*k;
});
addEventListener("pointerup", e => { drag = false; cv.classList.remove("drag"); });
cv.addEventListener("wheel", e => {
  e.preventDefault();
  CAM.dist = clamp(CAM.dist * (1 + Math.sign(e.deltaY)*0.11), CAM.minD, CAM.maxD);
}, { passive:false });

// click (not drag) selects the nearest person under the cursor
cv.addEventListener("click", e => {
  if (moved > 6) return;
  const r = cv.getBoundingClientRect();
  const ndc = new T.Vector2(((e.clientX-r.left)/r.width)*2-1, -((e.clientY-r.top)/r.height)*2+1);
  const ray = new T.Raycaster(); ray.setFromCamera(ndc, cam);
  let best = null, bd = 2.2;
  for (const n of G.npcs) {
    const d = ray.ray.distanceToPoint(n.pos);
    if (d < bd) { bd = d; best = n; }
  }
  G.sel = best;
  updateSoul();
});

addEventListener("keydown", e => {
  if (e.key === "q" || e.key === "Q") CAM.yaw -= 0.12;
  if (e.key === "e" || e.key === "E") CAM.yaw += 0.12;
  if (e.key === " ") { e.preventDefault(); setSpeed(G.speed?0:1); }
  if (e.key === "1") setSpeed(1);
  if (e.key === "2") setSpeed(3);
});

// ═══════════════════════════════════════════════════════════════════ UI
function logLine(cls, msg) {
  const el = $("log");
  const d = document.createElement("div");
  if (cls) d.className = cls;
  d.innerHTML = '<span class="y">'+(Math.floor(G.day/CFG.daysPerYear)+1)+"</span><span>"+msg+"</span>";
  el.appendChild(d);
  while (el.children.length > 70) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

function renderPrayers() {
  const box = $("prayers");
  box.innerHTML = "";
  for (const p of G.prayers) {
    const d = document.createElement("div");
    d.className = "pr plate" + (p.kind.urg ? " urg" : "");
    const mc = Math.round(p.cost*2.1);
    d.innerHTML =
      '<div class="who"><b>'+p.npc.name+'</b><i>'+p.kind.id+'</i></div>'+
      '<div class="trait">'+p.npc.trait+' · '+p.npc.job+' · '+p.v.name+'</div>'+
      '<div class="txt">'+p.text+'</div>'+
      '<div class="row">'+
        '<button class="y" data-a="1">Answer<span class="c">'+p.cost+'</span></button>'+
        '<button class="y" data-a="2">Miracle<span class="c">'+mc+'</span></button>'+
        '<button class="n" data-a="0">Refuse<span class="c">faith</span></button>'+
      '</div><div class="fuse" style="width:'+(p.life/p.maxLife*100).toFixed(1)+'%"></div>';
    d.querySelectorAll("button").forEach(b => b.onclick = () => {
      const a = b.getAttribute("data-a");
      if (a === "0") refuse(p); else answer(p, a === "2");
    });
    box.appendChild(d);
  }
  afford();
}
function afford() {
  const cards = $("prayers").children;
  for (let i = 0; i < G.prayers.length && i < cards.length; i++) {
    const bs = cards[i].querySelectorAll("button");
    if (bs.length < 3) continue;
    bs[0].disabled = G.faith < G.prayers[i].cost;
    bs[1].disabled = G.faith < Math.round(G.prayers[i].cost*2.1);
  }
}
function fuses() {
  const cards = $("prayers").children;
  for (let i = 0; i < G.prayers.length && i < cards.length; i++) {
    const f = cards[i].querySelector(".fuse");
    if (f) f.style.width = (G.prayers[i].life/G.prayers[i].maxLife*100).toFixed(1)+"%";
  }
}

function updateSoul() {
  const el = $("soul");
  if (!G.sel || !G.sel.alive) { el.style.display = "none"; return; }
  const n = G.sel;
  const stName = ["working","going home","resting","looking for food","praying","fleeing","leaving"][n.state];
  el.style.display = "block";
  el.innerHTML =
    "<h4>"+n.name+"</h4>"+
    '<div class="tr">'+n.trait+" · "+n.job+" · "+n.village.name+"</div>"+
    '<div class="r"><span>Faith in you</span><b>'+Math.round(n.faith*100)+"%</b></div>"+
    '<div class="fb"><i style="width:'+(n.faith*100)+'%"></i></div>'+
    '<div class="r"><span>Hunger</span><b>'+Math.round(n.hunger*100)+"%</b></div>"+
    '<div class="r"><span>Fear</span><b>'+Math.round(n.fear*100)+"%</b></div>"+
    '<div class="r"><span>Right now</span><b>'+stName+"</b></div>"+
    '<div class="say">“'+(n.said||"...")+'”</div>';
}

let sig = "";
function updateHUD() {
  const era = currentEra(), ppl = myPeople().length, vs = myVillages().length;
  const drag2 = 1 - (G.dependency/100)*CFG.depDrag;
  let bel = 0; for (const n of myPeople()) bel += n.faith;
  const inc = bel*CFG.faithPerBeliever*drag2*era.mul;
  const s = [Math.floor(G.faith),Math.round(G.devotion),Math.round(G.dependency),
             ppl,vs,era.n,Math.floor(G.ascension),G.day].join("|");
  if (s === sig) return; sig = s;

  $("vF").textContent = Math.floor(G.faith);
  $("vFi").textContent = "+"+inc.toFixed(1)+" /day";
  $("vD").textContent = Math.round(G.devotion)+"%";
  $("bD").style.width = G.devotion+"%";
  $("bD").style.background = G.devotion<25?"var(--bad)":G.devotion<50?"var(--warn)":"var(--dev)";
  $("vP").textContent = Math.round(G.dependency)+"%";
  $("bP").style.width = G.dependency+"%";
  $("vN").textContent = ppl;
  $("vNs").textContent = vs+(vs===1?" settlement":" settlements");
  $("vE").textContent = era.n;
  $("vY").textContent = "Year "+(Math.floor(G.day/CFG.daysPerYear)+1);
  $("vA").textContent = Math.floor(G.ascension)+"%";
  $("bA").style.width = Math.min(100,G.ascension)+"%";
  afford();
}

function setSpeed(s) {
  G.speed = s;
  [["s0",0],["s1",1],["s2",3]].forEach(([id,v]) => {
    if (v===s) $(id).setAttribute("data-on",""); else $(id).removeAttribute("data-on");
  });
}
$("s0").onclick = ()=>setSpeed(0);
$("s1").onclick = ()=>setSpeed(1);
$("s2").onclick = ()=>setSpeed(3);
$("sh").onclick = ()=>{ $("ovI").classList.add("on"); setSpeed(0); };
$("go").onclick = ()=>{ $("ovI").classList.remove("on"); setSpeed(1); };

function end(won, rv) {
  if (G.over) return;
  G.over = true; G.running = false; setSpeed(0);
  const yrs = Math.floor(G.day/CFG.daysPerYear);
  const title = won ? "Ascension." : rv ? rv.name+" ascends." : "They stopped praying.";
  const body = won
    ? "Enough of them believed, for long enough, that the believing became structural. You are not watching this world any more. You are one of the things it is made of."
    : rv
    ? "Another constellation reached it first. The sky has only so many fixed points and yours was not one of them."
    : "One at a time, each for their own reasons, they stopped. A god with no believers is not a small god. It is not a god.";
  $("ec").innerHTML =
    '<h2 style="color:'+(won?"#d5f2ff":"#ff9db0")+'">'+title+"</h2>"+
    '<div class="lede">'+(won?"You are a god":"Your name is forgotten")+"</div>"+
    "<p class='s'>"+body+"</p><div class='rule'></div>"+
    "<p><span class='tag'>"+yrs+" years</span><span class='tag'>"+myPeople().length+" souls</span>"+
    "<span class='tag'>"+myVillages().length+" settlements</span>"+
    "<span class='tag'>"+Math.round(G.ascension)+"% ascension</span></p>"+
    "<p><span class='tag'>"+G.answered+" answered</span><span class='tag'>"+G.denied+" refused</span>"+
    "<span class='tag'>"+G.expired+" unheard</span><span class='tag'>"+G.miracles+" miracles</span>"+
    "<span class='tag'>"+G.left+" walked away</span></p>"+
    '<div style="margin-top:22px"><button class="btn" onclick="location.reload()">Again</button></div>';
  $("ovE").classList.add("on");
}

// ═══════════════════════════════════════════════════════════════════ boot
function findSpot(minD, from) {
  for (let i = 0; i < 900; i++) {
    const x = (rnd()-0.5)*WS*0.70, z = (rnd()-0.5)*WS*0.70;
    if (groundAt(x,z) < 2.2 || slopeAt(x,z) > 1.7) continue;
    if (from && Math.hypot(x-from.x, z-from.z) < minD) continue;
    if (G.villages.some(v => Math.hypot(v.x-x, v.z-z) < minD)) continue;
    return { x, z };
  }
  return null;
}

function boot() {
  buildTerrain();
  makeTerrainMesh();
  makeWater();
  scatterProps();
  initNpcMesh();

  // 10, not 7. At seven people a couple of unlucky early deaths is a
  // death sentence no play can recover from — small-number noise decided runs.
  const home = findSpot(0) || { x:0, z:0 };
  const v = makeVillage(home.x, home.z, 0);
  v.food = 60;
  for (let i = 0; i < 10; i++) spawnNpc(v);
  CAM.fx = home.x; CAM.fz = home.z;

  const RN = ["The Ashen Crown","Verrow the Patient","Sil, Who Counts"];
  for (let i = 0; i < 3; i++) {
    const s = findSpot(58, home);
    if (!s) break;
    const rv = { idx:i+1, name:RN[i], asc:0 };
    G.rivals.push(rv);
    const rvv = makeVillage(s.x, s.z, rv.idx);
    for (let k = 0; k < 5; k++) spawnNpc(rvv);
  }

  G.running = true;
  G.devotion = avgFaith()*100;
  logLine("i", "You open your eyes. Seven people are living below, and none of them know it.");
  $("load").style.display = "none";
  renderPrayers();
}

// ═══════════════════════════════════════════════════════════════════ loop
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  cam.aspect = w/h; cam.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

let last = performance.now(), soulT = 0;
function frame(now) {
  const dt = Math.min(0.05, (now-last)/1000);
  last = now;
  const sdt = dt * G.speed;

  if (G.running && G.speed > 0) {
    for (const n of G.npcs) stepNpc(n, sdt);
    G.acc += sdt*1000;
    let guard = 0;
    while (G.acc >= CFG.dayMs && guard++ < 6) { G.acc -= CFG.dayMs; dayTick(); }
    if (guard >= 6) G.acc = 0;
    fuses();
  }
  stepFx(dt);
  syncNpcMesh();
  updateCam();
  soulT -= dt;
  if (soulT <= 0) { updateSoul(); soulT = 0.25; }
  updateHUD();
  renderer.render(scene, cam);
  requestAnimationFrame(frame);
}

setTimeout(() => { boot(); requestAnimationFrame(frame); }, 40);

})();
