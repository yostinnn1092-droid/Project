(function () {
"use strict";
const T = globalThis.THREE;

// ═══════════════════════════════════════════════════════════════════ helpers
const clamp=(v,a,b)=>v<a?a:v>b?b:v, lerp=(a,b,t)=>a+(b-a)*t, $=id=>document.getElementById(id);
const TAU=Math.PI*2;

// A coarse pointer means thumbs, which changes the input scheme, the HUD and
// the performance budget. Resolved once here, at the very top, because the
// renderer is constructed further down and reads it — declaring it lower left
// it in the temporal dead zone and threw on every device, not just phones.
// Desktop keeps every keyboard and mouse path, so one build serves both.
const IS_TOUCH = (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches) ||
                 ("ontouchstart" in window && (navigator.maxTouchPoints|0) > 0);
let _s=(Date.now()^0x9e3779b9)>>>0;
function rnd(){_s^=_s<<13;_s>>>=0;_s^=_s>>17;_s^=_s<<5;_s>>>=0;return _s/4294967296;}
const rint=(a,b)=>a+Math.floor(rnd()*(b-a+1));
const pick=a=>a[Math.floor(rnd()*a.length)];
const chance=p=>rnd()<p;

// ═══════════════════════════════════════════════════════════════════ tuning
// One place for every number that decides whether the tower is brutal or
// merely annoying. The design line: enemies must be able to kill a careless
// player in about three hits at any depth, while a player who reads wind-ups
// and dodges should almost never be hit at all.
const CFG = {
  // player
  baseHp: 100, baseSta: 100, baseFoc: 60, baseAtk: 12, baseDef: 4,
  staRegen: 22, focRegen: 5.5, staDelay: 0.55,
  moveSpeed: 7.2, sprintMul: 1.0, jumpV: 9.4, gravity: 26,

  dodgeCost: 24, dodgeSpeed: 19, dodgeTime: 0.28, dodgeIFrames: 0.22, dodgeCd: 0.42,

  lightCost: 11, lightWind: 0.11, lightActive: 0.10, lightRecover: 0.20,
  lightRange: 3.0, lightArc: 1.5,
  boltCost: 13, boltCd: 0.42, boltSpeed: 34, boltDmg: 0.85,

  // floors
  roomsMin: 3, roomsMax: 5,
  floorHpScale: 0.155,     // compounding per floor
  floorDmgScale: 0.105,
  eliteFrom: 3, bossEvery: 5,

  // economy
  marksPerFloor: 3, marksBossBonus: 12,
};

// ═══════════════════════════════════════════════════════════════════ save
const SAVE_KEY = "threshold.record.v1";
const META_DEFS = [
  { id:"vitality",  name:"Constitution", max:8, cost:l=>4+l*3,  desc:"+12 maximum vitality per rank.",  fmt:l=>"+"+(l*12)+" VIT" },
  { id:"edge",      name:"Edge",         max:8, cost:l=>5+l*4,  desc:"+2 attack per rank.",             fmt:l=>"+"+(l*2)+" ATK" },
  { id:"hide",      name:"Hide",         max:6, cost:l=>5+l*4,  desc:"+1 defence per rank. Flat reduction, so it matters most early.", fmt:l=>"+"+l+" DEF" },
  { id:"wind",      name:"Second Wind",  max:5, cost:l=>6+l*5,  desc:"+8 stamina and faster recovery per rank.", fmt:l=>"+"+(l*8)+" STA" },
  { id:"wellspring",name:"Wellspring",   max:5, cost:l=>6+l*5,  desc:"+8 focus and faster regeneration per rank.", fmt:l=>"+"+(l*8)+" FOC" },
  { id:"reflex",    name:"Reflex",       max:4, cost:l=>9+l*7,  desc:"+0.03s dodge invulnerability per rank. Small numbers, enormous effect.", fmt:l=>"+"+(l*0.03).toFixed(2)+"s i-frames" },
  { id:"scavenger", name:"Scavenger",    max:5, cost:l=>7+l*5,  desc:"Rewards roll one extra candidate per rank, improving the odds of something rare.", fmt:l=>"+"+l+" reroll weight" },
  { id:"headstart", name:"Prior Credit", max:3, cost:l=>14+l*12,desc:"Begin each run already holding a random uncommon relic per rank.", fmt:l=>l+" starting relic"+(l===1?"":"s") },
];
const REC = { marks:0, best:0, runs:0, meta:{}, kills:0 };
function loadRecord() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (o && typeof o === "object") {
      REC.marks = o.marks|0; REC.best = o.best|0; REC.runs = o.runs|0; REC.kills = o.kills|0;
      REC.meta = (o.meta && typeof o.meta === "object") ? o.meta : {};
    }
  } catch (e) { /* corrupt or unavailable storage must never block play */ }
  for (const d of META_DEFS) if (!(d.id in REC.meta)) REC.meta[d.id] = 0;
}
function saveRecord() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(REC)); } catch (e) {}
}
const metaLv = id => REC.meta[id] | 0;

// ═══════════════════════════════════════════════════════════════════ three
const cv = $("cv");
const renderer = new T.WebGLRenderer({ canvas:cv, antialias:!IS_TOUCH,
                                       powerPreference:"high-performance" });
// Phone GPUs are fill-rate bound long before they are triangle bound, so the
// first things to go are the pixel count and the shadow resolution, not the
// geometry. Antialiasing off as well — at phone DPI it buys almost nothing.
renderer.setPixelRatio(Math.min(devicePixelRatio||1, IS_TOUCH ? 1.5 : 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = IS_TOUCH ? T.PCFShadowMap : T.PCFSoftShadowMap;
renderer.toneMapping = T.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new T.Scene();
scene.fog = new T.FogExp2(0x0a0a10, 0.0105);   // was 0.021 — the room beyond the lamp was unreadable
const cam = new T.PerspectiveCamera(64, 1, 0.1, 400);

scene.add(new T.HemisphereLight(0x6b7488, 0x241c14, 1.15));  // was 0.55
const key = new T.DirectionalLight(0xffd7a0, 1.75);
key.position.set(14, 26, 10);
key.castShadow = true;
key.shadow.mapSize.set(IS_TOUCH?768:1536, IS_TOUCH?768:1536);
key.shadow.camera.near=1; key.shadow.camera.far=120;
key.shadow.camera.left=-46; key.shadow.camera.right=46;
key.shadow.camera.top=46; key.shadow.camera.bottom=-46;
key.shadow.bias = -0.0013;
scene.add(key, key.target);
// A lamp riding with the player so the tower reads as lit by you, not by the sun.
const lamp = new T.PointLight(0xffc477, 2.8, 42, 1.5);
scene.add(lamp);

// ═══════════════════════════════════════════════════════════════════ mats
const MAT = {
  floor:  new T.MeshStandardMaterial({ color:0x3a3a44, roughness:0.95 }),
  floor2: new T.MeshStandardMaterial({ color:0x2f2f39, roughness:0.95 }),
  wall:   new T.MeshStandardMaterial({ color:0x4a4a56, roughness:0.9 }),
  pillar: new T.MeshStandardMaterial({ color:0x565663, roughness:0.85 }),
  player: new T.MeshStandardMaterial({ color:0xd8d2c4, roughness:0.5, metalness:0.15 }),
  cloak:  new T.MeshStandardMaterial({ color:0x8a2f24, roughness:0.75 }),
  husk:   new T.MeshStandardMaterial({ color:0x6d5f4e, roughness:0.9 }),
  mote:   new T.MeshStandardMaterial({ color:0x4a6f9c, roughness:0.4, emissive:0x1a3a5c, emissiveIntensity:0.8 }),
  lash:   new T.MeshStandardMaterial({ color:0x8c3550, roughness:0.7 }),
  warden: new T.MeshStandardMaterial({ color:0x5a5a66, roughness:0.55, metalness:0.5 }),
  bell:   new T.MeshStandardMaterial({ color:0x8a6a2e, roughness:0.45, metalness:0.65 }),
  scribe: new T.MeshStandardMaterial({ color:0x9a8f74, roughness:0.8,
                                        emissive:0x2a2410, emissiveIntensity:0.5 }),
  // Half-transparent, because a thing that ignores walls must not look solid.
  proctor:new T.MeshStandardMaterial({ color:0xb8c8e0, roughness:0.3, transparent:true,
                                        opacity:0.55, emissive:0x35507a, emissiveIntensity:1.1 }),
  inkblot:new T.MeshStandardMaterial({ color:0x14121a, roughness:0.25, metalness:0.2 }),
  docent: new T.MeshStandardMaterial({ color:0x7a3a3a, roughness:0.75 }),
  boss:   new T.MeshStandardMaterial({ color:0x2b2b34, roughness:0.6, metalness:0.35,
                                        emissive:0x401505, emissiveIntensity:0.7 }),
  shield: new T.MeshStandardMaterial({ color:0x88aadd, transparent:true, opacity:0.30,
                                        side:T.DoubleSide, emissive:0x3a6ea8, emissiveIntensity:1.0 }),
  tell:   new T.MeshBasicMaterial({ color:0xff3b30, transparent:true, opacity:0.34,
                                     side:T.DoubleSide, depthWrite:false }),
  hazard: new T.MeshStandardMaterial({ color:0x7a2410, roughness:0.8, emissive:0xd03000,
                                        emissiveIntensity:0.9 }),
  exit:   new T.MeshStandardMaterial({ color:0xe0a13c, emissive:0xe0a13c, emissiveIntensity:1.6,
                                        roughness:0.3 }),
  chest:  new T.MeshStandardMaterial({ color:0x6b5326, roughness:0.6, metalness:0.4 }),
};

// ═══════════════════════════════════════════════════════════════════ state
const G = {
  phase:"menu",          // menu | playing | reward | dead | paused
  floor:1, runTime:0, marksRun:0,
  root:null,             // per-floor scene group
  walls:[], hazards:[], enemies:[], projectiles:[], pickups:[], fx:[],
  exit:null, objective:null,
  keys:{}, mouse:{l:false,r:false},
  locked:false,
  touch:{ moveId:null, lookId:null, mx:0, my:0, vx:0, vy:0,
          ox:0, oy:0, lookX:0, lookY:0, atk:false },
};

// ═══════════════════════════════════════════════════════════════════ player
const P = {
  g:null, mesh:null,
  pos:new T.Vector3(), vel:new T.Vector3(), yaw:0, pitch:0.30,
  grounded:true,
  hp:0,hpMax:0, sta:0,staMax:0, foc:0,focMax:0,
  atk:0, def:0, crit:0.05, lv:1, xp:0, xpNext:22,
  dodgeT:0, iframe:0, dodgeCd:0, staIdle:0,
  atkT:0, atkPhase:"", boltCd:0, combo:0, comboT:0,
  facing:new T.Vector3(0,0,-1),
  relics:[], equip:{ weapon:null, armour:null, charm:null },
  skills:[], hurtT:0,
};

function recomputeStats(keepRatio) {
  const hpR = keepRatio && P.hpMax ? P.hp/P.hpMax : 1;
  const spR = keepRatio && P.staMax ? P.sta/P.staMax : 1;
  const mpR = keepRatio && P.focMax ? P.foc/P.focMax : 1;

  let hp = CFG.baseHp + metaLv("vitality")*12 + (P.lv-1)*9;
  let sta= CFG.baseSta + metaLv("wind")*8;
  let foc= CFG.baseFoc + metaLv("wellspring")*8 + (P.lv-1)*3;
  let atk= CFG.baseAtk + metaLv("edge")*2 + (P.lv-1)*2.1;
  let def= CFG.baseDef + metaLv("hide") + (P.lv-1)*0.55;
  let crit = 0.05;

  for (const r of P.relics) {
    if (r.mods.hp)   hp  += r.mods.hp;
    if (r.mods.sta)  sta += r.mods.sta;
    if (r.mods.foc)  foc += r.mods.foc;
    if (r.mods.atk)  atk += r.mods.atk;
    if (r.mods.def)  def += r.mods.def;
    if (r.mods.crit) crit+= r.mods.crit;
  }
  P.hpMax=Math.round(hp); P.staMax=Math.round(sta); P.focMax=Math.round(foc);
  P.atk=+atk.toFixed(1); P.def=+def.toFixed(1); P.crit=crit;
  P.hp=Math.round(P.hpMax*hpR); P.sta=P.staMax*spR; P.foc=P.focMax*mpR;
}

function buildPlayerMesh() {
  const g = new T.Group();
  const body = new T.Mesh(new T.CapsuleGeometry(0.36,0.86,4,10), MAT.player);
  body.position.y = 0.93; body.castShadow = true;
  const head = new T.Mesh(new T.SphereGeometry(0.25,12,10), MAT.player);
  head.position.y = 1.66; head.castShadow = true;
  // A short cape gives the character a readable facing from behind, which a
  // capsule alone does not.
  const cape = new T.Mesh(new T.BoxGeometry(0.62,0.82,0.07), MAT.cloak);
  cape.position.set(0,1.06,0.30); cape.castShadow = true;
  const blade = new T.Mesh(new T.BoxGeometry(0.09,1.16,0.16), MAT.player);
  blade.position.set(0.42,1.0,-0.12);
  g.add(body,head,cape,blade);
  g.userData.blade = blade;
  scene.add(g);
  P.g = g; P.mesh = body;
}

// ═══════════════════════════════════════════════════════════════════ skills
// Four slots, each a resource cost plus a cooldown. Kept deliberately small in
// number so every one is worth learning rather than a hotbar to forget.
const SKILLS = {
  cinder: { name:"Cinder Step", ic:"✦", cd:6.5, cost:{foc:16},
    desc:"Blink forward, leaving a burning line that damages anything crossing it.",
    use(){ const d=P.facing.clone().setY(0).normalize();
      const from=P.pos.clone();
      P.pos.addScaledVector(d, 6.2); resolveWalls(P.pos, 0.42);
      P.iframe=Math.max(P.iframe,0.20);
      const mid=from.clone().lerp(P.pos,0.5);
      spawnHazard(mid.x, mid.z, 1.7, 2.4, 9+P.atk*0.5, true);
      flash(mid, 0xff7a30, 2.4);
    } },
  bulwark:{ name:"Bulwark", ic:"❖", cd:13, cost:{sta:22},
    desc:"Halve incoming damage for four seconds. Does not stop you being surrounded.",
    use(){ P.buffs.bulwark=4.0; toast("Bulwark","good"); } },
  sunder: { name:"Sunder", ic:"⚔", cd:8.5, cost:{sta:26},
    desc:"A heavy overhead. Triple damage and it breaks a Warden's guard outright.",
    use(){ P.atkT=0.42; P.atkPhase="wind"; P.heavy=true; } },
  siphon: { name:"Siphon", ic:"◈", cd:11, cost:{foc:24},
    desc:"Drain the nearest three enemies, returning a third of the damage as vitality.",
    use(){
      const near=G.enemies.filter(e=>e.alive&&e.pos.distanceTo(P.pos)<13)
        .sort((a,b)=>a.pos.distanceTo(P.pos)-b.pos.distanceTo(P.pos)).slice(0,3);
      let heal=0;
      for(const e of near){ const d=P.atk*1.15; damageEnemy(e,d,false); heal+=d*0.34;
                            beam(P.pos,e.pos,0xb072e0); }
      if(near.length){ P.hp=Math.min(P.hpMax,P.hp+heal); toast("Siphoned "+Math.round(heal),"good"); }
    } },
  nova:   { name:"Nova", ic:"✸", cd:15, cost:{foc:30},
    desc:"A ring of force. Heavy damage all around you and everything is knocked back.",
    use(){
      for(const e of G.enemies){ if(!e.alive) continue;
        const d=e.pos.distanceTo(P.pos);
        if(d<8.5){ damageEnemy(e, P.atk*2.1*(1-d/12), false);
                   const k=e.pos.clone().sub(P.pos).setY(0).normalize().multiplyScalar(7);
                   e.knock.copy(k); } }
      ring(P.pos, 0xffc973, 8.5);
    } },
  tether: { name:"Tether", ic:"➶", cd:9, cost:{foc:18},
    desc:"Haul the farthest enemy in reach to your feet. Good for pulling a Mote out of the back line.",
    use(){
      const far=G.enemies.filter(e=>e.alive&&e.pos.distanceTo(P.pos)<22)
        .sort((a,b)=>b.pos.distanceTo(P.pos)-a.pos.distanceTo(P.pos))[0];
      if(!far) return;
      beam(P.pos,far.pos,0x4a8fd4);
      const d=P.pos.clone().sub(far.pos).setY(0).normalize().multiplyScalar(
        far.pos.distanceTo(P.pos)-2.2);
      far.pos.add(d); far.stun=Math.max(far.stun,0.6);
    } },
};
const SKILL_IDS = Object.keys(SKILLS);

// ═══════════════════════════════════════════════════════════════════ loot
const RARITY = [
  { k:1, n:"Common",  w:56, mul:1.00 },
  { k:2, n:"Marked",  w:27, mul:1.55 },
  { k:3, n:"Sealed",  w:13, mul:2.30 },
  { k:4, n:"Radiant", w:4,  mul:3.40 },
];
const RELIC_POOL = [
  { n:"Ash Ration",      t:"charm",  base:{hp:16},          fl:"Chalky. Keeps." },
  { n:"Splitcore Edge",  t:"weapon", base:{atk:3.2},        fl:"It was already broken when you found it." },
  { n:"Scale Weave",     t:"armour", base:{def:1.6},        fl:"Someone's, once." },
  { n:"Long Lung",       t:"charm",  base:{sta:15},         fl:"Breathe out first." },
  { n:"Cold Filament",   t:"charm",  base:{foc:14},         fl:"Hums when a floor is about to change." },
  { n:"Notched Fang",    t:"weapon", base:{atk:2.1,crit:0.05}, fl:"Bites better than it cuts." },
  { n:"Ninth Plate",     t:"armour", base:{def:1.1,hp:12},  fl:"Stamped with a number that is not nine." },
  { n:"Quick Sigil",     t:"charm",  base:{sta:10,foc:9},   fl:"Reacts to being watched." },
  { n:"Widow Iron",      t:"weapon", base:{atk:4.4},        fl:"Heavy in a way that is not weight." },
  { n:"Grave Lacquer",   t:"armour", base:{def:2.3},        fl:"Still tacky." },
];
function rollRarity(bonus) {
  const rolls = 1 + (bonus|0);
  let best = RARITY[0];
  for (let i = 0; i < rolls; i++) {
    let tw = RARITY.reduce((s,r)=>s+r.w,0), x = rnd()*tw, got = RARITY[0];
    for (const r of RARITY) { x -= r.w; if (x <= 0) { got = r; break; } }
    if (got.k > best.k) best = got;
  }
  return best;
}
function rollRelic(floor, rarBonus) {
  const base = pick(RELIC_POOL), rar = rollRarity(rarBonus);
  const scale = rar.mul * (1 + floor*0.055);
  const mods = {};
  for (const k in base.base) {
    mods[k] = k === "crit" ? +(base.base[k]*rar.mul).toFixed(3)
                           : +(base.base[k]*scale).toFixed(1);
  }
  return { name:base.n, slot:base.t, rarity:rar, mods, flavour:base.fl };
}
const modText = m => Object.entries(m).map(([k,v]) =>
  k === "crit" ? "+"+Math.round(v*100)+"% CRT" : "+"+v+" "+k.toUpperCase()).join("  ");

// ═══════════════════════════════════════════════════════════════════ floor gen
// Rooms on a loose grid, joined by corridors. Not a maze — the tower is an
// examination hall, and every room should be a fight you can see coming.
function clearFloor() {
  if (G.root) { scene.remove(G.root); disposeGroup(G.root); }
  G.root = new T.Group(); scene.add(G.root);
  G.walls.length=0; G.hazards.length=0; G.enemies.length=0;
  G.projectiles.length=0; G.pickups.length=0; G.fx.length=0;
  G.exit=null;
}
function disposeGroup(o) {
  o.traverse(c=>{ if(c.geometry) c.geometry.dispose();
                  if(c.material && c.material._own) c.material.dispose(); });
}
function addWall(x,z,w,d,h) {
  const m = new T.Mesh(new T.BoxGeometry(w,h||4,d), MAT.wall);
  m.position.set(x,(h||4)/2,z); m.castShadow=true; m.receiveShadow=true;
  G.root.add(m);
  G.walls.push({ x, z, hw:w/2, hd:d/2 });
}
function addFloorTile(x,z,w,d,alt) {
  const m = new T.Mesh(new T.BoxGeometry(w,0.4,d), alt?MAT.floor2:MAT.floor);
  m.position.set(x,-0.2,z); m.receiveShadow=true;
  G.root.add(m);
}

function generateFloor(n) {
  clearFloor();
  const isBoss = n % CFG.bossEvery === 0;
  const rooms = [];

  if (isBoss) {
    rooms.push({ x:0, z:0, w:42, d:42 });
  } else {
    const count = rint(CFG.roomsMin, CFG.roomsMax);
    let cx = 0, cz = 0;
    for (let i = 0; i < count; i++) {
      const w = rint(18,28), d = rint(18,28);
      rooms.push({ x:cx, z:cz, w, d });
      // step to the next room in a cardinal direction, far enough to need a corridor
      const dir = pick([[1,0],[0,1],[-1,0],[0,-1]]);
      cx += dir[0]*(w/2 + 17 + rnd()*6);
      cz += dir[1]*(d/2 + 17 + rnd()*6);
    }
  }

  // ── watertight layout via a tilemap ─────────────────────────────────────
  // The first version carved doorways by deleting any wall a corridor crossed.
  // Because a wall spans an entire room side, that deleted the whole side and
  // the rooms leaked into empty void: a flood fill from the spawn ran
  // unbounded and reached neither the exit nor any enemy on 4 of 5 floors.
  //
  // Marking walkable cells and then walling every walkable cell that borders
  // a non-walkable one cannot produce a gap by construction, and doorways fall
  // out of it for free where corridors meet rooms.
  const CELL = 2.0;
  const walk = new Set();
  const ck = (i,j) => i+","+j;
  const markRect = (cx,cz,w,d) => {
    const i0 = Math.floor((cx-w/2)/CELL), i1 = Math.ceil((cx+w/2)/CELL);
    const j0 = Math.floor((cz-d/2)/CELL), j1 = Math.ceil((cz+d/2)/CELL);
    for (let i=i0;i<=i1;i++) for (let j=j0;j<=j1;j++) walk.add(ck(i,j));
  };
  for (const r of rooms) { addFloorTile(r.x,r.z,r.w,r.d,false); markRect(r.x,r.z,r.w,r.d); }
  for (let i = 1; i < rooms.length; i++) {
    const a = rooms[i-1], b = rooms[i];
    // L-shaped corridor: run along x, then along z, so diagonal steps still connect
    const midX = b.x, midZ = a.z;
    addFloorTile((a.x+midX)/2, a.z, Math.abs(midX-a.x)+5, 5, true);
    addFloorTile(b.x, (midZ+b.z)/2, 5, Math.abs(b.z-midZ)+5, true);
    markRect((a.x+midX)/2, a.z, Math.abs(midX-a.x)+5, 5);
    markRect(b.x, (midZ+b.z)/2, 5, Math.abs(b.z-midZ)+5);
  }

  // wall every empty cell that touches a walkable one
  const wallCells = new Set();
  for (const k of walk) {
    const [i,j] = k.split(",").map(Number);
    for (const d of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
      const nk = ck(i+d[0], j+d[1]);
      if (!walk.has(nk)) wallCells.add(nk);
    }
  }
  for (const k of wallCells) {
    const [i,j] = k.split(",").map(Number);
    const x = i*CELL, z = j*CELL;
    const m = new T.Mesh(new T.BoxGeometry(CELL,4,CELL), MAT.wall);
    m.position.set(x,2,z); m.castShadow = true; m.receiveShadow = true;
    G.root.add(m);
    G.walls.push({ x, z, hw:CELL/2, hd:CELL/2 });
  }

  // player starts at the centre of room 0, which is walkable by construction
  P.pos.set(rooms[0].x, 0, rooms[0].z);
  P.vel.set(0,0,0);

  // pillars for cover — positioning is a mechanic, so give it something to use.
  // Never within 6 units of the spawn: a pillar placed on the player trapped
  // them inside solid geometry and the floor was unplayable from frame one.
  if (!isBoss) for (const r of rooms) {
    const np = rint(1,3);
    for (let i = 0; i < np; i++) {
      const px = r.x + (rnd()-0.5)*(r.w-8), pz = r.z + (rnd()-0.5)*(r.d-8);
      if (Math.hypot(px-P.pos.x, pz-P.pos.z) < 6) continue;
      const m = new T.Mesh(new T.CylinderGeometry(1.0,1.15,4,8), MAT.pillar);
      m.position.set(px,2,pz); m.castShadow=true; G.root.add(m);
      G.walls.push({ x:px, z:pz, hw:1.05, hd:1.05 });
    }
  }

  // hazards from floor 2 — the tower's own contribution to the fight
  if (!isBoss && n >= 2) {
    const nh = Math.min(6, 1 + Math.floor(n/2));
    for (let i = 0; i < nh; i++) {
      const r = pick(rooms);
      spawnHazard(r.x + (rnd()-0.5)*(r.w-6), r.z + (rnd()-0.5)*(r.d-6),
                  1.5+rnd()*1.4, Infinity, 7 + n*1.4, false);
    }
  }

  // enemies
  if (isBoss) {
    spawnBoss(rooms[0].x, rooms[0].z - 12, n);
  } else {
    const budget = 3 + Math.floor(n*1.35);
    let spent = 0, guard = 0;
    while (spent < budget && guard++ < 60) {
      const r = pick(rooms.slice(rooms.length>1?1:0));  // never in the entry room
      const ex = r.x + (rnd()-0.5)*(r.w-6), ez = r.z + (rnd()-0.5)*(r.d-6);
      if (Math.hypot(ex-P.pos.x, ez-P.pos.z) < 12) continue;
      let kind = "husk";
      const roll = rnd();
      if (n >= CFG.eliteFrom && roll < 0.11) kind = "warden";
      else if (n >= 4 && roll < 0.21) kind = "proctor";
      else if (n >= 2 && roll < 0.31) kind = "bell";
      else if (n >= 2 && roll < 0.41) kind = "scribe";
      else if (n >= 3 && roll < 0.51) kind = "docent";
      else if (roll < 0.65) kind = "mote";
      else if (roll < 0.82) kind = "lash";
      spawnEnemy(kind, ex, ez, n);
      spent += kind === "warden" ? 3
             : (kind === "bell" || kind === "proctor" || kind === "docent") ? 2 : 1;
    }
  }

  // Inkblots are placed rather than budgeted: they never advance on you, so
  // they are closer to a trap than to a combatant. Scattered through the rooms
  // you have to cross, and never near the entry point, since waking one the
  // instant a floor loads teaches nothing.
  if (!isBoss && n >= 3) {
    const nb = Math.min(5, 1 + Math.floor(n/3));
    for (let i = 0; i < nb; i++) {
      const r = pick(rooms);
      const bx = r.x + (rnd()-0.5)*(r.w-6), bz = r.z + (rnd()-0.5)*(r.d-6);
      if (Math.hypot(bx-P.pos.x, bz-P.pos.z) < 14) continue;
      spawnEnemy("inkblot", bx, bz, n);
    }
  }

  // exit
  const last = rooms[rooms.length-1];
  const ex = new T.Mesh(new T.TorusGeometry(1.5,0.24,8,24), MAT.exit);
  ex.position.set(last.x, 1.6, last.z); ex.rotation.x = Math.PI/2;
  G.root.add(ex);
  const exLight = new T.PointLight(0xe0a13c, 0, 14);
  exLight.position.copy(ex.position); G.root.add(exLight);
  G.exit = { mesh:ex, light:exLight, x:last.x, z:last.z, open:false };

  // a chest in a random room, sometimes
  if (!isBoss && chance(0.55)) {
    const r = pick(rooms);
    spawnChest(r.x + (rnd()-0.5)*(r.w-8), r.z + (rnd()-0.5)*(r.d-8));
  }

  G.objective = makeObjective(n, isBoss, rooms);
  updateObjectiveUI();
}

// ═══════════════════════════════════════════════════════════════════ objectives
function makeObjective(n, isBoss, rooms) {
  if (isBoss) return { type:"boss", text:"Break the Proxy", done:false,
                       prog:()=> { const b=G.enemies.find(e=>e.boss);
                                   return b&&b.alive ? "Phase "+b.phase+" / 3" : "down"; } };
  const kinds = ["purge","endure","pylons"];
  const t = n === 1 ? "purge" : pick(kinds);
  if (t === "purge")
    return { type:"purge", text:"Clear every hostile", done:false,
             prog:()=> (G.enemies.filter(e=>e.alive).length)+" remaining" };
  if (t === "endure") {
    const secs = 26 + n*2.2;
    return { type:"endure", text:"Endure the interval", done:false, t:secs, tMax:secs,
             prog:function(){ return Math.max(0,Math.ceil(this.t))+"s"; } };
  }
  // pylons: destroy N objects while enemies keep spawning
  const need = 3;
  const pyl = [];
  for (let i = 0; i < need; i++) {
    const r = pick(rooms);
    const m = new T.Mesh(new T.OctahedronGeometry(0.9,0), MAT.mote);
    m.position.set(r.x+(rnd()-0.5)*(r.w-7), 1.2, r.z+(rnd()-0.5)*(r.d-7));
    G.root.add(m);
    pyl.push({ mesh:m, pos:m.position, hp:34+n*7, alive:true });
  }
  return { type:"pylons", text:"Sever the anchors", done:false, pylons:pyl,
           prog:function(){ return this.pylons.filter(p=>p.alive).length+" of "+need+" left"; } };
}

function checkObjective(dt) {
  const o = G.objective; if (!o || o.done) return;
  if (o.type === "purge" || o.type === "boss") {
    if (!G.enemies.some(e=>e.alive)) completeObjective();
  } else if (o.type === "endure") {
    o.t -= dt;
    // keep pressure on: trickle spawns while the clock runs
    o.spawnT = (o.spawnT||0) - dt;
    if (o.spawnT <= 0 && G.enemies.filter(e=>e.alive).length < 9) {
      o.spawnT = 3.4;
      const a = rnd()*TAU, r = 15+rnd()*7;
      spawnEnemy(chance(0.4)?"lash":"husk", P.pos.x+Math.cos(a)*r, P.pos.z+Math.sin(a)*r, G.floor);
    }
    if (o.t <= 0) completeObjective();
  } else if (o.type === "pylons") {
    if (!o.pylons.some(p=>p.alive)) completeObjective();
  }
  updateObjectiveUI();
}
function completeObjective() {
  const o = G.objective; if (o.done) return;
  o.done = true;
  G.exit.open = true;
  G.exit.light.intensity = 2.6;
  toast("The way out opens","gold");
  $("obj").classList.add("done");
}

// ═══════════════════════════════════════════════════════════════════ enemies
const EDEF = {
  husk:  { hp:38, dmg:13, spd:3.0, reach:2.1, wind:0.62, rec:0.72, xp:6,  r:0.48, h:1.7,
           mat:"husk",   name:"Husk" },
  lash:  { hp:24, dmg:16, spd:6.1, reach:2.0, wind:0.36, rec:0.50, xp:8,  r:0.40, h:1.5,
           mat:"lash",   name:"Lash" },
  mote:  { hp:26, dmg:11, spd:2.4, reach:15,  wind:0.80, rec:1.05, xp:8,  r:0.44, h:1.3,
           mat:"mote",   name:"Mote", ranged:true },
  warden:{ hp:120,dmg:24, spd:2.4, reach:2.6, wind:0.95, rec:0.95, xp:26, r:0.70, h:2.1,
           mat:"warden", name:"Warden", shielded:true },

  // Two archetypes drafted through the local OmniRoute gateway and kept for the
  // mechanics they add rather than the names. Neither duplicates an existing
  // behaviour: the Bellwether punishes standing anywhere near it and leaves you
  // slowed rather than damaged, and the Scribe covers ground a single Mote bolt
  // cannot, so cover stops being optional.
  bell:  { hp:74, dmg:9,  spd:2.2, reach:6.8, wind:1.10, rec:1.25, xp:17, r:0.56, h:1.95,
           mat:"bell",   name:"Bellwether", aoe:true, slow:2.0 },
  scribe:{ hp:34, dmg:9,  spd:2.0, reach:16,  wind:0.92, rec:1.15, xp:13, r:0.46, h:1.65,
           mat:"scribe", name:"Scribe", ranged:true, volley:3, spread:0.30 },

  // The remaining three from the same draft. Each needed a mechanic the game
  // did not already own, or it would have been a reskin of something above.
  //   Proctor — walks through walls and its shot does too, so cover is not a
  //             solution to it. The only answer is to close the distance.
  //   Inkblot — dormant and flat on the ground until you are almost on top of
  //             it, then erupts. Punishes moving through a room without looking.
  //   Docent  — lays persistent wax on the ground where you are standing,
  //             taking space away rather than dealing damage directly.
  proctor:{ hp:46, dmg:15, spd:1.9, reach:19,  wind:1.25, rec:1.30, xp:21, r:0.50, h:2.0,
            mat:"proctor", name:"Proctor", ranged:true, ghost:true, aggroR:26 },
  inkblot:{ hp:30, dmg:21, spd:0,   reach:3.4, wind:0.50, rec:1.40, xp:14, r:0.62, h:0.7,
            mat:"inkblot", name:"Inkblot", aoe:true, ambush:true, aggroR:5.2 },
  docent: { hp:62, dmg:7,  spd:2.6, reach:13,  wind:1.00, rec:1.20, xp:18, r:0.54, h:1.8,
            mat:"docent",  name:"Docent", ranged:true, wax:true },
};

function spawnEnemy(kind, x, z, floor) {
  const d = EDEF[kind];
  const hpS = Math.pow(1+CFG.floorHpScale, floor-1);
  const dmS = Math.pow(1+CFG.floorDmgScale, floor-1);
  const g = new T.Group();
  const body = new T.Mesh(new T.CapsuleGeometry(d.r, d.h-d.r*2, 4, 9), MAT[d.mat]);
  body.position.y = d.h/2; body.castShadow = true;
  g.add(body);
  // Telegraph disc: sits at the feet, only visible during wind-up. This is the
  // single most important piece of readability in the game.
  const tell = new T.Mesh(new T.RingGeometry(0.1, 1, 24), MAT.tell.clone());
  tell.rotation.x = -Math.PI/2; tell.position.y = 0.06; tell.visible = false;
  tell.material._own = true;
  g.add(tell);
  let shield = null;
  if (d.shielded) {
    shield = new T.Mesh(new T.CircleGeometry(1.15, 16), MAT.shield.clone());
    shield.material._own = true;
    shield.position.set(0, d.h/2, -0.85);
    g.add(shield);
  }
  G.root.add(g);

  const e = {
    kind, def:d, g, body, tell, shield, boss:false,
    pos:new T.Vector3(x,0,z), vel:new T.Vector3(), knock:new T.Vector3(),
    hp: Math.round(d.hp*hpS), hpMax: Math.round(d.hp*hpS),
    dmg: d.dmg*dmS, alive:true,
    state:"idle", t:0, cd:rnd()*1.2, stun:0, hitFlash:0, guardBroken:0,
    facing:0, aggro:false,
  };
  g.position.copy(e.pos);
  G.enemies.push(e);
  return e;
}

const BOSS = {
  name:"The Proxy", hp:520, dmgBase:22,
  phases:[
    { at:1.00, spd:3.0, atk:"sweep",  cd:2.4 },
    { at:0.62, spd:4.1, atk:"charge", cd:1.9 },
    { at:0.30, spd:4.6, atk:"burst",  cd:1.5 },
  ],
};
function spawnBoss(x,z,floor) {
  const hpS = Math.pow(1+CFG.floorHpScale, floor-1);
  const g = new T.Group();
  const body = new T.Mesh(new T.CapsuleGeometry(1.05,1.9,4,12), MAT.boss);
  body.position.y=1.6; body.castShadow=true;
  const crown = new T.Mesh(new T.TorusGeometry(0.9,0.13,6,16), MAT.exit);
  crown.position.y=3.0; crown.rotation.x=Math.PI/2;
  g.add(body,crown);
  const tell = new T.Mesh(new T.RingGeometry(0.1,1,32), MAT.tell.clone());
  tell.rotation.x=-Math.PI/2; tell.position.y=0.07; tell.visible=false;
  tell.material._own=true; g.add(tell);
  G.root.add(g);
  const e = {
    kind:"boss", def:{ name:BOSS.name, r:1.05, h:3.4, reach:4.2, xp:120 },
    g, body, tell, shield:null, boss:true, crown,
    pos:new T.Vector3(x,0,z), vel:new T.Vector3(), knock:new T.Vector3(),
    hp:Math.round(BOSS.hp*hpS), hpMax:Math.round(BOSS.hp*hpS),
    dmg:BOSS.dmgBase*Math.pow(1+CFG.floorDmgScale,floor-1),
    alive:true, state:"idle", t:0, cd:2.0, stun:0, hitFlash:0, phase:1,
    facing:0, aggro:true, guardBroken:0,
  };
  g.position.copy(e.pos);
  G.enemies.push(e);
  toast(BOSS.name+" is present","bad");
  return e;
}

// ═══════════════════════════════════════════════════════════════════ combat
function damageEnemy(e, amount, canCrit) {
  if (!e.alive) return 0;
  let dmg = amount;
  let crit = false;
  if (canCrit && chance(P.crit)) { dmg *= 1.9; crit = true; }
  // A Warden's guard faces where it is looking. Hit it from the front and you
  // accomplish almost nothing; the answer is to go around, not to hit harder.
  if (e.def.shielded && e.guardBroken <= 0) {
    const toP = P.pos.clone().sub(e.pos).setY(0).normalize();
    const face = new T.Vector3(Math.sin(e.facing),0,Math.cos(e.facing));
    if (toP.dot(face) > 0.25) { dmg *= 0.12; popText(e.pos,"GUARDED","#88aadd"); }
  }
  dmg = Math.max(1, dmg);
  e.hp -= dmg;
  e.hitFlash = 0.12;
  popText(e.pos, Math.round(dmg)+(crit?"!":""), crit?"#ffc973":"#ffffff");
  if (e.hp <= 0) killEnemy(e);
  return dmg;
}
function killEnemy(e) {
  e.alive = false;
  G.root.remove(e.g); disposeGroup(e.g);
  gainXp(e.def.xp * (e.boss?1:1));
  REC.kills++;
  if (e.boss) { toast("The Proxy is broken","gold"); G.marksRun += CFG.marksBossBonus; }
  // loot: enemies sometimes drop, elites usually do
  const p = e.boss ? 1 : e.def.shielded ? 0.55 : 0.13;
  if (chance(p)) spawnPickup(e.pos.x, e.pos.z, "relic");
  else if (chance(0.22)) spawnPickup(e.pos.x, e.pos.z, "vit");
}

function gainXp(n) {
  P.xp += n;
  while (P.xp >= P.xpNext) {
    P.xp -= P.xpNext; P.lv++; P.xpNext = Math.round(P.xpNext*1.35+8);
    recomputeStats(true);
    P.hp = Math.min(P.hpMax, P.hp + 26);
    toast("Level "+P.lv,"good");
  }
}

function damagePlayer(amount, fromPos) {
  if (P.iframe > 0) { popText(P.pos,"MISS","#9de08a"); return; }
  let dmg = amount * (P.buffs.bulwark>0 ? 0.5 : 1);
  dmg = Math.max(1, dmg - P.def);
  P.hp -= dmg;
  P.hurtT = 0.3;
  $("hurt").style.opacity = String(clamp(dmg/38,0.25,0.95));
  setTimeout(()=>{ $("hurt").style.opacity="0"; }, 130);
  popText(P.pos, "-"+Math.round(dmg), "#ff6b6b");
  if (fromPos) {
    const k = P.pos.clone().sub(fromPos).setY(0).normalize().multiplyScalar(3.4);
    P.vel.x += k.x; P.vel.z += k.z;
  }
  if (P.hp <= 0) die();
}

function playerMelee() {
  const heavy = P.heavy;
  const range = CFG.lightRange * (heavy?1.35:1);
  const arc = CFG.lightArc * (heavy?1.25:1);
  const mul = heavy ? 3.0 : (1 + P.combo*0.14);
  let hit = 0;
  for (const e of G.enemies) {
    if (!e.alive) continue;
    const to = e.pos.clone().sub(P.pos).setY(0);
    const d = to.length();
    if (d > range + e.def.r) continue;
    to.normalize();
    if (to.dot(P.facing) < Math.cos(arc/2)) continue;
    if (heavy && e.def.shielded) { e.guardBroken = 5.0; popText(e.pos,"GUARD BROKEN","#ffc973"); }
    damageEnemy(e, P.atk*mul, true);
    e.knock.copy(to.multiplyScalar(heavy?6:2.6));
    hit++;
  }
  // pylons are struck by the same swing
  if (G.objective && G.objective.type==="pylons") {
    for (const p of G.objective.pylons) {
      if (!p.alive) continue;
      const to = p.pos.clone().sub(P.pos).setY(0);
      if (to.length() > range+1) continue;
      p.hp -= P.atk*mul;
      popText(p.pos, Math.round(P.atk*mul)+"", "#ffffff");
      if (p.hp <= 0) { p.alive=false; G.root.remove(p.mesh); toast("Anchor severed","good"); }
      hit++;
    }
  }
  if (hit) { P.combo = Math.min(4, P.combo+1); P.comboT = 1.6; }
  P.heavy = false;
}

function spawnBolt(from, dir, dmg, hostile, speed, ghost) {
  const m = new T.Mesh(new T.SphereGeometry(hostile?0.26:0.18, 8, 6),
    hostile ? MAT.hazard : MAT.exit);
  m.position.copy(from); m.position.y = 1.1;
  G.root.add(m);
  G.projectiles.push({ mesh:m, pos:m.position, dir:dir.clone().normalize(),
                       spd:speed||CFG.boltSpeed, dmg, hostile, ghost:!!ghost, life:3.2 });
}

function spawnHazard(x,z,r,life,dps,friendly,slow) {
  const m = new T.Mesh(new T.CircleGeometry(r,20), MAT.hazard.clone());
  m.material._own = true; m.material.transparent = true; m.material.opacity = 0.72;
  // Wax is a different colour from fire so the player can tell at a glance
  // whether a patch will burn them or merely bog them down.
  if (slow) m.material.color.setHex(0x9a2f5a), m.material.emissive.setHex(0x5c1030);
  m.rotation.x = -Math.PI/2; m.position.set(x,0.05,z);
  G.root.add(m);
  G.hazards.push({ mesh:m, x, z, r, life, dps, friendly, slow:slow||0, tick:0 });
}

function spawnPickup(x,z,type) {
  const geo = type==="relic" ? new T.OctahedronGeometry(0.42,0) : new T.SphereGeometry(0.30,8,6);
  const m = new T.Mesh(geo, type==="relic"?MAT.exit:MAT.hazard);
  m.position.set(x,0.9,z); G.root.add(m);
  G.pickups.push({ mesh:m, pos:m.position, type, t:0,
                   relic: type==="relic" ? rollRelic(G.floor, metaLv("scavenger")) : null });
}
function spawnChest(x,z) {
  const m = new T.Mesh(new T.BoxGeometry(1.2,0.85,0.9), MAT.chest);
  m.position.set(x,0.42,z); m.castShadow=true; G.root.add(m);
  G.pickups.push({ mesh:m, pos:m.position, type:"chest", t:0 });
}

// ═══════════════════════════════════════════════════════════════════ fx
function popText(pos, text, col) {
  G.fx.push({ kind:"text", pos:pos.clone(), text, col, t:0, life:0.85,
              off:(rnd()-0.5)*0.7 });
}
function flash(pos,col,r){ ring(pos,col,r); }
function ring(pos,col,r) {
  const m = new T.Mesh(new T.RingGeometry(0.3,0.5,28),
    new T.MeshBasicMaterial({color:col,transparent:true,opacity:0.85,side:T.DoubleSide,
                             depthWrite:false}));
  m.material._own = true;
  m.rotation.x=-Math.PI/2; m.position.set(pos.x,0.12,pos.z);
  G.root.add(m);
  G.fx.push({ kind:"ring", mesh:m, t:0, life:0.5, r });
}
function beam(a,b,col) {
  const m = new T.Mesh(new T.BoxGeometry(0.09,0.09,a.distanceTo(b)),
    new T.MeshBasicMaterial({color:col,transparent:true,opacity:0.8,depthWrite:false}));
  m.material._own = true;
  m.position.copy(a).lerp(b,0.5); m.position.y=1.1;
  m.lookAt(b.x,1.1,b.z);
  G.root.add(m);
  G.fx.push({ kind:"beam", mesh:m, t:0, life:0.22 });
}

// ═══════════════════════════════════════════════════════════════════ physics
function resolveWalls(pos, radius) {
  for (const w of G.walls) {
    const dx = pos.x - w.x, dz = pos.z - w.z;
    const px = w.hw + radius - Math.abs(dx);
    const pz = w.hd + radius - Math.abs(dz);
    if (px > 0 && pz > 0) {
      // push out along the shallower axis
      if (px < pz) pos.x += px * Math.sign(dx || 1);
      else         pos.z += pz * Math.sign(dz || 1);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════ input
addEventListener("keydown", e => {
  G.keys[e.code] = true;
  if (e.code === "Tab") { e.preventDefault(); $("inv").classList.toggle("on"); renderInv(); }
  if (e.code === "Escape") togglePause();
  if (G.phase === "playing") {
    const idx = ["Digit1","Digit2","Digit3","Digit4"].indexOf(e.code);
    if (idx >= 0) useSkill(idx);
    if (e.code === "Space" && P.grounded) { P.vel.y = CFG.jumpV; P.grounded = false; }
    if ((e.code === "ShiftLeft"||e.code === "ShiftRight")) tryDodge();
  }
});
addEventListener("keyup", e => { G.keys[e.code] = false; });

cv.addEventListener("mousedown", e => {
  if (!G.locked) return;
  if (e.button === 0) G.mouse.l = true;
  if (e.button === 2) G.mouse.r = true;
});
addEventListener("mouseup", e => {
  if (e.button === 0) G.mouse.l = false;
  if (e.button === 2) G.mouse.r = false;
});
cv.addEventListener("contextmenu", e => e.preventDefault());
cv.addEventListener("click", () => {
  if (!IS_TOUCH && G.phase === "playing" && !G.locked) cv.requestPointerLock();
});
document.addEventListener("pointerlockchange", () => { G.locked = document.pointerLockElement === cv; });
document.addEventListener("mousemove", e => {
  if (!G.locked) return;
  P.yaw   -= e.movementX * 0.0022;
  P.pitch  = clamp(P.pitch + e.movementY * 0.0019, -0.22, 1.15);
});

function tryDodge() {
  if (P.dodgeCd > 0 || P.sta < CFG.dodgeCost || P.dodgeT > 0) return;
  P.sta -= CFG.dodgeCost; P.staIdle = CFG.staDelay;
  P.dodgeT = CFG.dodgeTime;
  P.iframe = CFG.dodgeIFrames + metaLv("reflex")*0.03;
  P.dodgeCd = CFG.dodgeCd;
  const mv = moveIntent();
  P.dodgeDir = (mv.lengthSq() > 0.01) ? mv.clone().normalize() : P.facing.clone();
}
function moveIntent() {
  const f = new T.Vector3(Math.sin(P.yaw),0,Math.cos(P.yaw));
  const r = new T.Vector3(f.z,0,-f.x);
  const v = new T.Vector3();
  if (G.keys.KeyW) v.sub(f);
  if (G.keys.KeyS) v.add(f);
  if (G.keys.KeyA) v.sub(r);
  if (G.keys.KeyD) v.add(r);
  // Virtual stick adds into the same vector, so every downstream system —
  // dodge direction, movement, animation — stays input-agnostic.
  const t = G.touch;
  if (t.vx || t.vy) { v.addScaledVector(f, t.vy); v.addScaledVector(r, t.vx); }
  return v;
}

// ── aim assist ────────────────────────────────────────────────────────────
// A thumb cannot aim a melee arc the way a mouse can. On touch, committing to
// a strike snaps the character toward the nearest enemy inside a generous
// cone. It never turns you around, so it assists intent rather than replacing
// it, and it is off entirely on desktop where the mouse is already precise.
function assistAim() {
  if (!IS_TOUCH) return;
  let best = null, bestScore = -1;
  for (const e of G.enemies) {
    if (!e.alive) continue;
    const to = e.pos.clone().sub(P.pos).setY(0);
    const d = to.length();
    if (d > CFG.lightRange + 3.2) continue;
    to.normalize();
    const dot = to.dot(P.facing);
    if (dot < 0.25) continue;                 // behind you stays behind you
    const score = dot * 2 - d * 0.12;
    if (score > bestScore) { bestScore = score; best = to; }
  }
  if (best) {
    const want = Math.atan2(-best.x, -best.z);
    // ease rather than snap so the camera does not jerk
    let diff = ((want - P.yaw + Math.PI*3) % TAU) - Math.PI;
    P.yaw += diff * 0.65;
    P.facing.set(-Math.sin(P.yaw),0,-Math.cos(P.yaw)).normalize();
  }
}
// ═══════════════════════════════════════════════════════════════════ touch
function initTouch() {
  if (!IS_TOUCH) return;
  document.body.classList.add("touch");

  const stick = $("stick"), knob = $("knob"), t = G.touch;
  const RAD = 52;                      // travel of the knob before it clamps

  // The left half is the movement stick, the right half is the camera. Both
  // are floating: the control appears where the thumb lands. Fixed pads mean
  // hunting for a spot you cannot see while something is winding up at you.
  const isLeft = x => x < innerWidth * 0.45;

  function onStart(e) {
    for (const p of e.changedTouches) {
      const overButton = p.target.closest && p.target.closest(".tb,.tsk,#tPause,#tGear");
      if (overButton) continue;
      if (isLeft(p.clientX) && t.moveId === null) {
        t.moveId = p.identifier; t.ox = p.clientX; t.oy = p.clientY;
        stick.style.left = (p.clientX - 66) + "px";
        stick.style.top  = (p.clientY - 66) + "px";
        stick.classList.add("on");
      } else if (!isLeft(p.clientX) && t.lookId === null) {
        t.lookId = p.identifier; t.lookX = p.clientX; t.lookY = p.clientY;
      }
    }
  }
  function onMove(e) {
    for (const p of e.changedTouches) {
      if (p.identifier === t.moveId) {
        let dx = p.clientX - t.ox, dy = p.clientY - t.oy;
        const len = Math.hypot(dx,dy);
        if (len > RAD) { dx *= RAD/len; dy *= RAD/len; }
        knob.style.left = (38 + dx*0.85) + "px";
        knob.style.top  = (38 + dy*0.85) + "px";
        // dead zone stops a resting thumb from drifting the character
        const mag = Math.min(1, len/RAD);
        const dead = mag < 0.18 ? 0 : (mag-0.18)/0.82;
        const nx = len ? dx/Math.max(len,1) : 0, ny = len ? dy/Math.max(len,1) : 0;
        t.vx =  nx * dead;
        t.vy = -ny * dead;   // screen-up is forward
      } else if (p.identifier === t.lookId) {
        P.yaw   -= (p.clientX - t.lookX) * 0.0060;
        P.pitch  = clamp(P.pitch + (p.clientY - t.lookY) * 0.0045, -0.22, 1.15);
        t.lookX = p.clientX; t.lookY = p.clientY;
      }
    }
  }
  function onEnd(e) {
    for (const p of e.changedTouches) {
      if (p.identifier === t.moveId) {
        t.moveId = null; t.vx = 0; t.vy = 0;
        stick.classList.remove("on");
        knob.style.left = "38px"; knob.style.top = "38px";
      } else if (p.identifier === t.lookId) t.lookId = null;
    }
  }
  addEventListener("touchstart", onStart, { passive:true });
  addEventListener("touchmove",  onMove,  { passive:true });
  addEventListener("touchend",   onEnd,   { passive:true });
  addEventListener("touchcancel",onEnd,   { passive:true });

  // action buttons — held rather than tapped, so attack can be sustained
  const hold = (el, down, up) => {
    el.addEventListener("touchstart", e => { e.preventDefault(); el.classList.add("held"); down(); },
                        { passive:false });
    const off = e => { e.preventDefault(); el.classList.remove("held"); if (up) up(); };
    el.addEventListener("touchend", off, { passive:false });
    el.addEventListener("touchcancel", off, { passive:false });
  };
  // A tap can begin and end inside a single frame, in which case a flag that
  // is only true "while held" is never observed and the swing never happens.
  // The latch keeps the intent alive for a few frames so a quick tap always
  // lands exactly one strike, while holding still auto-repeats.
  hold($("tAtk"), ()=>{ t.atk = true; t.latch = 0.16; }, ()=>{ t.atk = false; });
  hold($("tDodge"), ()=>{ tryDodge(); });
  hold($("tBolt"),  ()=>{
    if (P.boltCd <= 0 && P.foc >= CFG.boltCost) {
      assistAim();
      P.foc -= CFG.boltCost; P.boltCd = CFG.boltCd;
      spawnBolt(P.pos, P.facing, P.atk*CFG.boltDmg, false);
    }
  });
  $("tPause").addEventListener("touchstart", e => { e.preventDefault(); togglePause(); },
                               { passive:false });
  $("tGear").addEventListener("touchstart", e => { e.preventDefault();
                               $("inv").classList.toggle("on"); renderInv(); }, { passive:false });

  buildTouchSkills();
  checkOrientation();
  addEventListener("resize", checkOrientation);
  addEventListener("orientationchange", () => setTimeout(checkOrientation, 260));
}

function buildTouchSkills() {
  const box = $("tSkills"); if (!box) return;
  box.innerHTML = "";
  for (let i = 0; i < 4; i++) {
    const d = document.createElement("div");
    d.className = "tsk empty";
    d.innerHTML = '<span class="ic">·</span><div class="cd" style="display:none"></div>';
    d.addEventListener("touchstart", e => { e.preventDefault(); useSkill(i); }, { passive:false });
    box.appendChild(d);
  }
}
function syncTouchSkills() {
  const box = $("tSkills"); if (!box) return;
  for (let i = 0; i < 4; i++) {
    const el = box.children[i], s = P.skills[i]; if (!el) continue;
    const icon = el.querySelector(".ic"), cd = el.querySelector(".cd");
    if (!s) { el.className = "tsk empty"; icon.textContent = "·"; cd.style.display="none"; continue; }
    const def = SKILLS[s.id];
    icon.textContent = def.ic;
    const poor = (def.cost.sta && P.sta < def.cost.sta) || (def.cost.foc && P.foc < def.cost.foc);
    el.className = "tsk" + (s.cd<=0 && !poor ? " ready" : "");
    if (s.cd > 0) { cd.style.display="flex"; cd.textContent = s.cd.toFixed(0); }
    else cd.style.display = "none";
  }
  const bcd = $("tBolt") && $("tBolt").querySelector(".cd");
  if (bcd) {
    if (P.boltCd > 0) { bcd.style.display="flex"; bcd.textContent = P.boltCd.toFixed(1); }
    else bcd.style.display="none";
  }
  const dg = $("tDodge");
  if (dg) dg.classList.toggle("poor", P.sta < CFG.dodgeCost);
}

function checkOrientation() {
  // Portrait cannot fit a stick, an action cluster and a readable HUD at once.
  const portrait = innerHeight > innerWidth;
  document.body.classList.toggle("portrait", portrait);
  if (portrait && G.phase === "playing") { G.phase = "paused"; }
  else if (!portrait && G.phase === "paused" && !$("ovPause").classList.contains("on"))
    G.phase = "playing";
}

function useSkill(i) {
  const s = P.skills[i]; if (!s) return;
  const def = SKILLS[s.id];
  if (s.cd > 0) return;
  if (def.cost.sta && P.sta < def.cost.sta) return;
  if (def.cost.foc && P.foc < def.cost.foc) return;
  if (def.cost.sta) { P.sta -= def.cost.sta; P.staIdle = CFG.staDelay; }
  if (def.cost.foc) P.foc -= def.cost.foc;
  s.cd = def.cd;
  def.use();
}

// ═══════════════════════════════════════════════════════════════════ update
function updatePlayer(dt) {
  P.buffs = P.buffs || {};
  for (const k in P.buffs) { P.buffs[k] -= dt; if (P.buffs[k] <= 0) delete P.buffs[k]; }

  if (G.touch.latch > 0) G.touch.latch -= dt;
  P.slow = Math.max(0,(P.slow||0)-dt);
  P.dodgeCd = Math.max(0,P.dodgeCd-dt);
  P.iframe  = Math.max(0,P.iframe-dt);
  P.boltCd  = Math.max(0,P.boltCd-dt);
  P.comboT -= dt; if (P.comboT <= 0) P.combo = 0;
  for (const s of P.skills) s.cd = Math.max(0, s.cd-dt);

  // facing follows the camera, flattened
  P.facing.set(-Math.sin(P.yaw),0,-Math.cos(P.yaw)).normalize();

  // ── movement ────────────────────────────────────────────────────────────
  if (P.dodgeT > 0) {
    P.dodgeT -= dt;
    P.pos.addScaledVector(P.dodgeDir, CFG.dodgeSpeed*dt);
  } else {
    const mv = moveIntent();
    if (mv.lengthSq() > 0.01) {
      mv.normalize();
      // Slowed, never rooted. A Bellwether should make escaping expensive, not
      // take the controls away — being unable to act while something winds up
      // is the difference between hard and cheap.
      const spd = CFG.moveSpeed * (P.atkT>0?0.42:1) * (P.slow>0 ? 0.55 : 1);
      P.vel.x = lerp(P.vel.x, mv.x*spd, 1-Math.pow(0.0015,dt));
      P.vel.z = lerp(P.vel.z, mv.z*spd, 1-Math.pow(0.0015,dt));
    } else {
      P.vel.x = lerp(P.vel.x,0,1-Math.pow(0.0004,dt));
      P.vel.z = lerp(P.vel.z,0,1-Math.pow(0.0004,dt));
    }
    P.pos.x += P.vel.x*dt; P.pos.z += P.vel.z*dt;
  }
  // gravity
  P.vel.y -= CFG.gravity*dt;
  P.pos.y += P.vel.y*dt;
  if (P.pos.y <= 0) { P.pos.y = 0; P.vel.y = 0; P.grounded = true; }
  resolveWalls(P.pos, 0.42);

  // ── resources ───────────────────────────────────────────────────────────
  P.staIdle = Math.max(0,P.staIdle-dt);
  if (P.staIdle <= 0)
    P.sta = Math.min(P.staMax, P.sta + (CFG.staRegen + metaLv("wind")*2.5)*dt);
  P.foc = Math.min(P.focMax, P.foc + (CFG.focRegen + metaLv("wellspring")*0.9)*dt);

  // ── attacks ─────────────────────────────────────────────────────────────
  if (P.atkT > 0) {
    P.atkT -= dt;
    if (P.atkPhase === "wind" && P.atkT <= CFG.lightActive+CFG.lightRecover) {
      P.atkPhase = "active"; playerMelee();
    } else if (P.atkPhase === "active" && P.atkT <= CFG.lightRecover) {
      P.atkPhase = "recover";
    }
    if (P.atkT <= 0) P.atkPhase = "";
  } else if ((G.mouse.l || G.touch.atk || G.touch.latch > 0) && P.sta >= CFG.lightCost) {
    G.touch.latch = 0;
    assistAim();
    P.sta -= CFG.lightCost; P.staIdle = CFG.staDelay;
    P.atkT = CFG.lightWind+CFG.lightActive+CFG.lightRecover;
    P.atkPhase = "wind";
  }
  if (G.mouse.r && P.boltCd <= 0 && P.foc >= CFG.boltCost) {
    P.foc -= CFG.boltCost; P.boltCd = CFG.boltCd;
    spawnBolt(P.pos, P.facing, P.atk*CFG.boltDmg, false);
  }

  // ── mesh ────────────────────────────────────────────────────────────────
  P.g.position.copy(P.pos);
  P.g.rotation.y = P.yaw + Math.PI;
  const bl = P.g.userData.blade;
  if (bl) {
    const swinging = P.atkPhase === "wind" || P.atkPhase === "active";
    bl.rotation.x = swinging ? lerp(-1.5, 1.1, 1-P.atkT/0.41) : Math.sin(performance.now()*0.002)*0.06;
  }
  P.mesh.material = P.iframe > 0 ? MAT.mote : MAT.player;

  lamp.position.set(P.pos.x, 3.2, P.pos.z);
}

function updateEnemies(dt) {
  for (const e of G.enemies) {
    if (!e.alive) continue;
    e.hitFlash = Math.max(0,e.hitFlash-dt);
    e.stun = Math.max(0,e.stun-dt);
    e.guardBroken = Math.max(0,e.guardBroken-dt);
    e.cd -= dt; e.t -= dt;

    const toP = P.pos.clone().sub(e.pos).setY(0);
    const dist = toP.length();
    toP.normalize();

    // aggro on proximity, then never lets go — no stealth in an exam
    if (!e.aggro && dist < (e.def.aggroR || 17)) e.aggro = true;

    // knockback decays
    if (e.knock.lengthSq() > 0.01) {
      e.pos.addScaledVector(e.knock, dt);
      e.knock.multiplyScalar(Math.pow(0.02,dt));
    }

    if (e.stun <= 0 && e.aggro) {
      if (e.boss) updateBoss(e, dt, toP, dist);
      else if (e.state === "idle") {
        // approach, or hold range if ranged
        const want = e.def.ranged ? 11 : e.def.reach*0.9;
        const move = e.def.ranged
          ? (dist > want+2 ? 1 : dist < want-2.5 ? -1 : 0)
          : (dist > want ? 1 : 0);
        if (move !== 0) e.pos.addScaledVector(toP, e.def.spd*move*dt);
        // Motes strafe so they are not a stationary target
        if (e.def.ranged && move === 0)
          e.pos.addScaledVector(new T.Vector3(-toP.z,0,toP.x), e.def.spd*0.8*dt);
        e.facing = Math.atan2(toP.x, toP.z);
        if (dist <= e.def.reach && e.cd <= 0) {
          e.state = "wind"; e.t = e.def.wind;
          e.tell.visible = true;
        }
      } else if (e.state === "wind") {
        e.facing = Math.atan2(toP.x, toP.z);
        const k = 1 - e.t/e.def.wind;
        e.tell.scale.setScalar(lerp(0.4, e.def.ranged?1.2:e.def.reach*0.85, k));
        e.tell.material.opacity = 0.20 + k*0.35;
        if (e.t <= 0) {
          e.tell.visible = false;
          e.state = "recover"; e.t = e.def.rec; e.cd = e.def.rec + 0.3 + rnd()*0.5;
          if (e.def.ranged) {
            // A volley fans out, so strafing sideways no longer clears it and
            // the answer becomes a pillar or a dodge through the gap.
            const n = e.def.volley || 1;
            for (let k = 0; k < n; k++) {
              const off = (k - (n-1)/2) * (e.def.spread || 0);
              const dir = new T.Vector3(
                toP.x*Math.cos(off) - toP.z*Math.sin(off), 0,
                toP.x*Math.sin(off) + toP.z*Math.cos(off));
              spawnBolt(e.pos, dir, e.dmg, true, 15, e.def.ghost);
            }
          } else if (e.def.wax) {
            // Laid at the player's feet, so it does not chase you — it takes
            // away the ground you are standing on and makes you give it up.
            spawnHazard(P.pos.x, P.pos.z, 2.6, 7.5, e.dmg*0.8, false, 1.6);
          } else if (e.def.aoe) {
            // Rings out to its full reach — there is no safe melee spacing, you
            // either interrupt it or you leave.
            ring(e.pos, 0xffc973, e.def.reach);
            if (dist <= e.def.reach) {
              damagePlayer(e.dmg, e.pos);
              P.slow = Math.max(P.slow || 0, e.def.slow);
            }
          } else if (dist <= e.def.reach + 0.9) {
            damagePlayer(e.dmg, e.pos);
          }
        }
      } else if (e.state === "recover") {
        if (e.t <= 0) e.state = "idle";
      }
    }

    // A Proctor drifts through masonry; everything else is solid.
    if (!e.def.ghost) resolveWalls(e.pos, e.def.r);
    // separation so a pack does not collapse into one point
    for (const o of G.enemies) {
      if (o === e || !o.alive) continue;
      const d = e.pos.distanceTo(o.pos), min = e.def.r + o.def.r + 0.25;
      if (d < min && d > 0.001) {
        const push = e.pos.clone().sub(o.pos).setY(0).normalize().multiplyScalar((min-d)*0.5);
        e.pos.add(push);
      }
    }

    e.g.position.copy(e.pos);
    e.g.rotation.y = e.facing;
    // An Inkblot lies flat until it wakes, so it reads as a stain on the
    // floor rather than a monster standing in the open.
    if (e.def.ambush) e.body.scale.y = e.aggro ? 1 : 0.22;
    e.body.material = e.hitFlash > 0 ? MAT.exit : MAT[e.def.mat || "boss"];
    if (e.shield) e.shield.visible = e.guardBroken <= 0;
  }
  // sweep the dead
  for (let i = G.enemies.length-1; i >= 0; i--) if (!G.enemies[i].alive) G.enemies.splice(i,1);
}

function updateBoss(e, dt, toP, dist) {
  // phase by health — each phase is a different attack, not more HP
  const frac = e.hp/e.hpMax;
  let ph = 1;
  for (let i = 0; i < BOSS.phases.length; i++) if (frac <= BOSS.phases[i].at) ph = i+1;
  if (ph !== e.phase) {
    e.phase = ph;
    e.stun = 0.8; e.tell.visible = false; e.state = "idle";
    ring(e.pos, 0xff3b30, 9);
    toast("The Proxy changes shape — phase "+ph, "bad");
  }
  const P_ = BOSS.phases[e.phase-1];
  e.crown.rotation.z += dt*(1+e.phase);

  if (e.state === "idle") {
    if (dist > 3.2) e.pos.addScaledVector(toP, P_.spd*dt);
    e.facing = Math.atan2(toP.x, toP.z);
    if (e.cd <= 0) {
      e.state = "wind"; e.t = P_.atk==="charge"?0.7:P_.atk==="burst"?0.85:1.0;
      e.windMax = e.t; e.tell.visible = true;
      e.attack = P_.atk;
    }
  } else if (e.state === "wind") {
    if (e.attack !== "charge") e.facing = Math.atan2(toP.x, toP.z);
    const k = 1-e.t/e.windMax;
    const size = e.attack==="sweep"?6.5:e.attack==="burst"?10:3.2;
    e.tell.scale.setScalar(lerp(0.5,size,k));
    e.tell.material.opacity = 0.18+k*0.40;
    if (e.t <= 0) {
      e.tell.visible = false;
      e.state = "recover"; e.t = 0.85; e.cd = P_.cd;
      if (e.attack === "sweep") {
        if (dist < 6.8) damagePlayer(e.dmg, e.pos);
        ring(e.pos, 0xff3b30, 6.8);
      } else if (e.attack === "charge") {
        const dir = new T.Vector3(Math.sin(e.facing),0,Math.cos(e.facing));
        e.knock.copy(dir.multiplyScalar(26));
        e.chargeT = 0.5;
      } else {
        ring(e.pos, 0xff3b30, 10.5);
        if (dist < 10.5) damagePlayer(e.dmg*1.25, e.pos);
        // burst also seeds hazards, so the arena shrinks as the fight goes on
        for (let i = 0; i < 3; i++) {
          const a = rnd()*TAU, r = 4+rnd()*7;
          spawnHazard(e.pos.x+Math.cos(a)*r, e.pos.z+Math.sin(a)*r, 2.0, 9, 11+G.floor, false);
        }
      }
    }
  } else if (e.state === "recover") {
    if (e.chargeT > 0) {
      e.chargeT -= dt;
      if (dist < 2.8) { damagePlayer(e.dmg*0.9, e.pos); e.chargeT = 0; }
    }
    if (e.t <= 0) e.state = "idle";
  }
}

function updateProjectiles(dt) {
  for (let i = G.projectiles.length-1; i >= 0; i--) {
    const p = G.projectiles[i];
    p.life -= dt;
    p.pos.addScaledVector(p.dir, p.spd*dt);
    let dead = p.life <= 0;
    // walls — a Proctor's glyph is not stopped by them, which is the whole
    // reason the archetype exists: cover cannot answer it.
    if (!p.ghost) for (const w of G.walls) {
      if (Math.abs(p.pos.x-w.x) < w.hw+0.2 && Math.abs(p.pos.z-w.z) < w.hd+0.2) { dead = true; break; }
    }
    if (!dead) {
      if (p.hostile) {
        if (p.pos.distanceTo(P.pos) < 1.0) { damagePlayer(p.dmg, p.pos); dead = true; }
      } else {
        for (const e of G.enemies) {
          if (!e.alive) continue;
          if (p.pos.distanceTo(e.pos) < e.def.r + 0.55) { damageEnemy(e, p.dmg, true); dead = true; break; }
        }
        if (!dead && G.objective && G.objective.type === "pylons") {
          for (const py of G.objective.pylons) {
            if (py.alive && p.pos.distanceTo(py.pos) < 1.2) {
              py.hp -= p.dmg; popText(py.pos, Math.round(p.dmg)+"", "#fff");
              if (py.hp <= 0) { py.alive=false; G.root.remove(py.mesh); toast("Anchor severed","good"); }
              dead = true; break;
            }
          }
        }
      }
    }
    if (dead) { G.root.remove(p.mesh); p.mesh.geometry.dispose(); G.projectiles.splice(i,1); }
  }
}

function updateHazards(dt) {
  for (let i = G.hazards.length-1; i >= 0; i--) {
    const h = G.hazards[i];
    h.life -= dt;
    h.tick -= dt;
    const inside = Math.hypot(P.pos.x-h.x, P.pos.z-h.z) < h.r;
    // Standing in wax keeps re-applying the slow, so the patch has to be left
    // rather than waited out.
    if (h.slow && inside && !h.friendly) P.slow = Math.max(P.slow||0, h.slow);
    if (h.tick <= 0) {
      h.tick = 0.5;
      if (!h.friendly && inside) damagePlayer(h.dps*0.5, null);
      if (h.friendly) for (const e of G.enemies) {
        if (e.alive && Math.hypot(e.pos.x-h.x, e.pos.z-h.z) < h.r) damageEnemy(e, h.dps*0.5, false);
      }
    }
    h.mesh.material.opacity = 0.45 + Math.sin(performance.now()*0.005)*0.16;
    if (h.life <= 0) { G.root.remove(h.mesh); h.mesh.geometry.dispose(); G.hazards.splice(i,1); }
  }
}

function updatePickups(dt) {
  for (let i = G.pickups.length-1; i >= 0; i--) {
    const p = G.pickups[i];
    p.t += dt;
    p.mesh.rotation.y += dt*1.6;
    if (p.type !== "chest") p.mesh.position.y = 0.9 + Math.sin(p.t*2.4)*0.14;
    if (p.pos.distanceTo(P.pos) < 1.5) {
      if (p.type === "vit") { P.hp = Math.min(P.hpMax, P.hp+22); toast("+22 vitality","good"); }
      else if (p.type === "relic") { takeRelic(p.relic); }
      else if (p.type === "chest") { openChest(); }
      G.root.remove(p.mesh); G.pickups.splice(i,1);
    }
  }
}

function updateFx(dt) {
  for (let i = G.fx.length-1; i >= 0; i--) {
    const f = G.fx[i]; f.t += dt;
    const k = f.t/f.life;
    if (k >= 1) {
      if (f.mesh) { G.root.remove(f.mesh); f.mesh.geometry.dispose(); f.mesh.material.dispose(); }
      G.fx.splice(i,1); continue;
    }
    if (f.kind === "ring") { const s = lerp(0.3,f.r,k); f.mesh.scale.setScalar(s);
                             f.mesh.material.opacity = 0.85*(1-k); }
    if (f.kind === "beam") f.mesh.material.opacity = 0.8*(1-k);
  }
}

// ═══════════════════════════════════════════════════════════════════ rewards
function takeRelic(r) {
  P.relics.push(r);
  const cur = P.equip[r.slot];
  // auto-equip if the slot is empty or the new piece is strictly better rarity
  if (!cur || r.rarity.k > cur.rarity.k) P.equip[r.slot] = r;
  recomputeStats(true);
  toast(r.rarity.n+" · "+r.name, r.rarity.k>=3?"gold":"good");
  renderInv();
}

function openChest() {
  // A chest is a choice, not a handout: three cards, one pick.
  offerRewards(3, true);
}

let rewardResolve = null;
function offerRewards(count, includeRisk) {
  const opts = [];
  for (let i = 0; i < count; i++) {
    const roll = rnd();
    if (roll < 0.52) {
      const r = rollRelic(G.floor, metaLv("scavenger"));
      opts.push({ kind:"relic", relic:r, title:r.name, rar:r.rarity,
                  type:r.slot.toUpperCase(), desc:r.flavour, stat:modText(r.mods) });
    } else if (roll < 0.78) {
      const unowned = SKILL_IDS.filter(id => !P.skills.some(s=>s.id===id));
      if (unowned.length && P.skills.length < 4) {
        const id = pick(unowned), s = SKILLS[id];
        opts.push({ kind:"skill", id, title:s.name, rar:RARITY[2],
                    type:"SKILL", desc:s.desc,
                    stat:(s.cost.sta?s.cost.sta+" STA":"")+(s.cost.foc?s.cost.foc+" FOC":"")+
                         " · "+s.cd+"s cooldown" });
      } else {
        opts.push({ kind:"heal", title:"Sutured", rar:RARITY[0], type:"RESTORE",
                    desc:"Close what is open. Restores 45 vitality now.", stat:"+45 VIT" });
      }
    } else {
      opts.push({ kind:"perm", title:pick(["Whetted","Toughened","Deep Lungs","Clear Head"]),
                  rar:RARITY[1], type:"RUN BONUS",
                  desc:"A lasting improvement for the rest of this run only.",
                  stat:"" });
    }
  }
  // the risky option: strictly better, with a real cost
  if (includeRisk && chance(0.55)) {
    const r = rollRelic(G.floor+6, metaLv("scavenger")+2);
    opts[rint(0,opts.length-1)] = {
      kind:"risk", relic:r, title:r.name, rar:r.rarity, type:"WAGERED",
      desc:r.flavour+" The Threshold takes something for this.",
      stat:modText(r.mods), risk:"Costs 30% of current vitality." };
  }
  showRewards(opts);
}

function showRewards(opts) {
  G.phase = "reward";
  document.exitPointerLock();
  const box = $("rCards"); box.innerHTML = "";
  for (const o of opts) {
    const d = document.createElement("div");
    d.className = "card r"+o.rar.k;
    d.innerHTML = '<div class="rar">'+o.rar.n+'</div><h3>'+o.title+'</h3>'+
      '<div class="ty">'+o.type+'</div><p>'+o.desc+'</p>'+
      (o.stat?'<div class="st">'+o.stat+'</div>':'')+
      (o.risk?'<div class="risk">'+o.risk+'</div>':'');
    // A touch device fires click after touchend, so binding click keeps one
    // handler working for both. relock() is a no-op on touch.
    d.onclick = () => { applyReward(o); $("reward").classList.remove("on");
                        G.phase="playing"; relock(); };
    box.appendChild(d);
  }
  $("reward").classList.add("on");
}

function applyReward(o) {
  if (o.kind === "relic") takeRelic(o.relic);
  else if (o.kind === "risk") {
    P.hp = Math.max(1, Math.round(P.hp*0.70));
    takeRelic(o.relic);
    toast("The Threshold takes its cut","bad");
  }
  else if (o.kind === "skill") { P.skills.push({ id:o.id, cd:0 }); renderSkills(); }
  else if (o.kind === "heal") { P.hp = Math.min(P.hpMax, P.hp+45); }
  else if (o.kind === "perm") {
    const which = pick(["atk","def","sta","foc"]);
    const relic = { name:o.title, slot:"charm", rarity:o.rar,
                    mods:{ [which]: which==="atk"?2.5:which==="def"?1.4:12 },
                    flavour:"Earned in transit." };
    P.relics.push(relic); recomputeStats(true);
  }
}

// ═══════════════════════════════════════════════════════════════════ flow
function startRun() {
  G.phase = "playing"; G.floor = 1; G.runTime = 0; G.marksRun = 0;
  P.lv = 1; P.xp = 0; P.xpNext = 22;
  P.relics = []; P.equip = { weapon:null, armour:null, charm:null };
  P.skills = []; P.buffs = {}; P.slow = 0;
  // first skill is free so the kit is never empty
  P.skills.push({ id:pick(["cinder","bulwark","sunder"]), cd:0 });
  // Prior Credit: start with relics already in hand
  for (let i = 0; i < metaLv("headstart"); i++) {
    const r = rollRelic(3, 1); takeRelic(r);
  }
  recomputeStats(false);
  P.hp = P.hpMax; P.sta = P.staMax; P.foc = P.focMax;
  REC.runs++;
  generateFloor(1);
  renderSkills(); renderInv();
  $("ovStart").classList.remove("on");
  $("ovDeath").classList.remove("on");
  $("obj").classList.remove("done");
  relock();
}

function nextFloor() {
  G.floor++;
  G.marksRun += CFG.marksPerFloor;
  if (G.floor > REC.best) REC.best = G.floor;
  saveRecord();
  generateFloor(G.floor);
  $("obj").classList.remove("done");
  // between floors, a choice
  offerRewards(3, chance(0.4));
  toast("Floor "+G.floor, "gold");
}

function die() {
  if (G.phase === "dead") return;
  G.phase = "dead";
  document.exitPointerLock();
  REC.marks += G.marksRun;
  if (G.floor > REC.best) REC.best = G.floor;
  saveRecord();
  $("deathCard").innerHTML =
    '<h2 style="color:var(--danger)">Assessment terminated</h2>'+
    '<div class="lede">Candidate expired on floor '+G.floor+'</div>'+
    "<p class='s'>The floor resets. It does not remember you. The record does.</p>"+
    '<div class="rule"></div>'+
    "<p><span class='tag'>Floor "+G.floor+"</span><span class='tag'>Level "+P.lv+"</span>"+
    "<span class='tag'>"+Math.floor(G.runTime)+"s</span>"+
    "<span class='tag' style='color:var(--amber2)'>+"+G.marksRun+" marks</span></p>"+
    "<p><span class='tag'>"+P.relics.length+" relics held</span>"+
    "<span class='tag'>"+P.skills.length+" skills</span>"+
    "<span class='tag'>best floor "+REC.best+"</span></p>"+
    '<div class="rule"></div>'+
    '<div><button class="btn" id="btnAgain">Re-enter</button>'+
    '<button class="btn ghost" id="btnRecord">Spend marks</button></div>';
  $("btnAgain").onclick = () => startRun();
  $("btnRecord").onclick = () => { $("ovDeath").classList.remove("on"); showMeta(true); };
  $("ovDeath").classList.add("on");
}

function togglePause() {
  if (G.phase === "playing") {
    G.phase = "paused"; document.exitPointerLock();
    $("pauseCard").innerHTML =
      "<h2>Held</h2><div class='lede'>Floor "+G.floor+"</div>"+
      "<p>The Threshold waits. It is patient in a way that is not reassuring.</p>"+
      '<div class="rule"></div>'+
      '<div><button class="btn" id="btnResume">Continue</button>'+
      '<button class="btn ghost" id="btnQuit">Abandon run</button></div>';
    $("btnResume").onclick = () => { $("ovPause").classList.remove("on");
                                     G.phase="playing"; relock(); };
    $("btnQuit").onclick = () => { $("ovPause").classList.remove("on"); die(); };
    $("ovPause").classList.add("on");
  } else if (G.phase === "paused") {
    $("ovPause").classList.remove("on"); G.phase = "playing"; relock();
  }
}

// ═══════════════════════════════════════════════════════════════════ meta UI
function showMeta(fromDeath) {
  const rows = META_DEFS.map(d => {
    const lv = metaLv(d.id), maxed = lv >= d.max, cost = d.cost(lv);
    const poor = !maxed && REC.marks < cost;
    return '<div class="node'+(maxed?" max":poor?" poor":"")+'" data-id="'+d.id+'">'+
      "<b>"+d.name+"</b><span>"+d.desc+"</span>"+
      '<div class="lv"><span>'+d.fmt(lv)+"</span><span>"+
      (maxed?"MAX":cost+" ◈")+"</span></div></div>";
  }).join("");
  $("metaCard").innerHTML =
    "<h2>The record</h2><div class='lede'>"+REC.marks+" marks unspent · best floor "+
      REC.best+" · "+REC.runs+" attempts</div>"+
    "<p>Marks are the only thing the Threshold cannot take back. Spend them on what you are, "+
      "not on what you are carrying.</p>"+
    '<div id="metaGrid">'+rows+"</div>"+
    '<div class="rule"></div>'+
    '<div><button class="btn" id="btnMetaBack">'+(fromDeath?"Re-enter":"Back")+"</button>"+
    '<button class="btn ghost" id="btnWipe">Erase record</button></div>';
  $("metaCard").querySelectorAll(".node").forEach(el => {
    el.onclick = () => {
      const d = META_DEFS.find(x=>x.id===el.dataset.id);
      const lv = metaLv(d.id); if (lv >= d.max) return;
      const cost = d.cost(lv); if (REC.marks < cost) return;
      REC.marks -= cost; REC.meta[d.id] = lv+1; saveRecord(); showMeta(fromDeath);
    };
  });
  $("btnMetaBack").onclick = () => {
    $("ovMeta").classList.remove("on");
    if (fromDeath) startRun(); else $("ovStart").classList.add("on");
  };
  $("btnWipe").onclick = () => {
    REC.marks=0; REC.best=0; REC.runs=0; REC.kills=0;
    for (const d of META_DEFS) REC.meta[d.id]=0;
    saveRecord(); showMeta(fromDeath);
  };
  $("ovStart").classList.remove("on");
  $("ovMeta").classList.add("on");
}

// ═══════════════════════════════════════════════════════════════════ HUD
function relock(){ if (!IS_TOUCH) cv.requestPointerLock(); }

function toast(msg, cls) {
  const el = document.createElement("div");
  el.className = "toast"+(cls?" "+cls:"");
  el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(()=>{ el.style.opacity="0"; el.style.transition="opacity .4s";
                   setTimeout(()=>el.remove(),420); }, 1500);
  while ($("toasts").children.length > 5) $("toasts").firstChild.remove();
}
function renderSkills() {
  syncTouchSkills();
  const box = $("skills"); box.innerHTML = "";
  for (let i = 0; i < 4; i++) {
    const s = P.skills[i];
    const d = document.createElement("div");
    d.className = "sk";
    if (s) {
      const def = SKILLS[s.id];
      d.innerHTML = '<span class="kb">'+(i+1)+'</span><span class="ic">'+def.ic+'</span>'+
        '<span class="cost">'+(def.cost.sta||def.cost.foc)+'</span>'+
        '<span class="nm">'+def.name+'</span>'+
        '<div class="cd" style="display:none"></div>';
    } else {
      d.innerHTML = '<span class="kb">'+(i+1)+'</span><span class="ic" style="opacity:.2">·</span>';
    }
    box.appendChild(d);
  }
}
function updateSkillsUI() {
  const kids = $("skills").children;
  for (let i = 0; i < 4; i++) {
    const s = P.skills[i], el = kids[i]; if (!el) continue;
    if (!s) continue;
    const def = SKILLS[s.id];
    const cd = el.querySelector(".cd");
    if (s.cd > 0) { cd.style.display="flex"; cd.textContent = s.cd.toFixed(1); }
    else cd.style.display = "none";
    const poor = (def.cost.sta && P.sta < def.cost.sta) || (def.cost.foc && P.foc < def.cost.foc);
    el.classList.toggle("ready", s.cd<=0 && !poor);
    el.classList.toggle("poor", !!poor);
  }
  syncTouchSkills();
}
function renderInv() {
  const slots = ["weapon","armour","charm"];
  $("invSlots").innerHTML = slots.map(s => {
    const it = P.equip[s];
    return '<div class="slot"><span class="sn">'+s+'</span><span class="si" '+
      (it?'style="color:var(--r'+it.rarity.k+')"':'')+'>'+
      (it? it.name : "—")+"</span></div>";
  }).join("");
  $("invList").innerHTML = P.relics.length
    ? P.relics.map((r,i) =>
        '<div class="slot" data-i="'+i+'" style="cursor:pointer">'+
        '<span class="si" style="color:var(--r'+r.rarity.k+')">'+r.name+"</span>"+
        '<span class="sn">'+modText(r.mods)+"</span></div>").join("")
    : '<div class="slot"><span class="sn">nothing</span></div>';
  $("invList").querySelectorAll("[data-i]").forEach(el => {
    el.onclick = () => { const r = P.relics[+el.dataset.i];
                         P.equip[r.slot] = r; recomputeStats(true); renderInv(); };
  });
}
function updateObjectiveUI() {
  const o = G.objective; if (!o) return;
  $("objFloor").textContent = "Floor "+G.floor+(G.floor%CFG.bossEvery===0?" · warden floor":"");
  $("objText").textContent = o.text;
  $("objProg").textContent = o.done ? "complete — find the way out" : o.prog();
}
function updateHUD() {
  $("hpFill").style.width = (P.hp/P.hpMax*100)+"%";
  $("hpGhost").style.width = (P.hp/P.hpMax*100)+"%";
  $("hpTxt").textContent = Math.max(0,Math.ceil(P.hp))+"/"+P.hpMax;
  $("spFill").style.width = (P.sta/P.staMax*100)+"%";
  $("spTxt").textContent = Math.ceil(P.sta)+"/"+P.staMax;
  $("mpFill").style.width = (P.foc/P.focMax*100)+"%";
  $("mpTxt").textContent = Math.ceil(P.foc)+"/"+P.focMax;
  $("sAtk").textContent = P.atk.toFixed(1);
  $("sDef").textContent = P.def.toFixed(1);
  $("sCrt").textContent = Math.round(P.crit*100)+"%";
  $("sLv").textContent = P.lv;
  $("rMarks").textContent = REC.marks+" (+"+G.marksRun+")";
  $("rBest").textContent = REC.best || "—";
  const m = Math.floor(G.runTime/60), s = Math.floor(G.runTime%60);
  $("rTime").textContent = m+":"+String(s).padStart(2,"0");
  updateSkillsUI();
}

// ═══════════════════════════════════════════════════════════════════ camera
function updateCamera(dt) {
  const dist = 9.2, height = 3.6;   // pulled back: the old framing filled the screen with the player
  const back = new T.Vector3(Math.sin(P.yaw),0,Math.cos(P.yaw));
  const want = P.pos.clone()
    .addScaledVector(back, dist*Math.cos(P.pitch))
    .add(new T.Vector3(0, height + dist*Math.sin(P.pitch), 0));
  // pull in if a wall is between camera and player
  for (const w of G.walls) {
    if (Math.abs(want.x-w.x) < w.hw+0.5 && Math.abs(want.z-w.z) < w.hd+0.5) {
      want.lerp(P.pos.clone().add(new T.Vector3(0,2.2,0)), 0.55); break;
    }
  }
  cam.position.lerp(want, 1-Math.pow(0.0009, dt));
  cam.lookAt(P.pos.x, P.pos.y+1.45, P.pos.z);
  key.target.position.copy(P.pos);
  key.position.set(P.pos.x+14, P.pos.y+26, P.pos.z+10);
}

// ═══════════════════════════════════════════════════════════════════ labels
// Floating damage numbers are drawn on a 2D overlay canvas rather than as
// sprites — cheaper, and they stay legible at every camera distance.
const ov = document.createElement("canvas");
ov.style.cssText = "position:fixed;inset:0;z-index:7;pointer-events:none";
document.body.appendChild(ov);
const ox = ov.getContext("2d");
function drawLabels() {
  ox.clearRect(0,0,ov.width,ov.height);
  const v = new T.Vector3();
  ox.textAlign = "center";
  for (const f of G.fx) {
    if (f.kind !== "text") continue;
    v.copy(f.pos); v.y += 1.5 + f.t*1.4;
    v.project(cam);
    if (v.z > 1) continue;
    const sx = (v.x*0.5+0.5)*ov.width/ (devicePixelRatio||1) + f.off*20;
    const sy = (-v.y*0.5+0.5)*ov.height/(devicePixelRatio||1);
    ox.globalAlpha = clamp(1-f.t/f.life,0,1);
    ox.font = "700 15px ui-sans-serif,system-ui";
    ox.lineWidth = 3; ox.strokeStyle = "#000a";
    ox.strokeText(f.text, sx, sy);
    ox.fillStyle = f.col;
    ox.fillText(f.text, sx, sy);
  }
  // enemy health pips
  for (const e of G.enemies) {
    if (!e.alive || e.hp >= e.hpMax) continue;
    v.copy(e.pos); v.y += e.def.h + 0.55; v.project(cam);
    if (v.z > 1) continue;
    const sx = (v.x*0.5+0.5)*ov.width/(devicePixelRatio||1);
    const sy = (-v.y*0.5+0.5)*ov.height/(devicePixelRatio||1);
    const w = e.boss ? 150 : 40;
    ox.globalAlpha = 1;
    ox.fillStyle = "#000a"; ox.fillRect(sx-w/2, sy, w, e.boss?7:4);
    ox.fillStyle = e.boss ? "#c4571f" : "#c9414a";
    ox.fillRect(sx-w/2, sy, w*clamp(e.hp/e.hpMax,0,1), e.boss?7:4);
    if (e.boss) {
      ox.fillStyle = "#e8e4da"; ox.font = "600 11px ui-sans-serif";
      ox.fillText(BOSS.name.toUpperCase()+" · PHASE "+e.phase, sx, sy-6);
    }
  }
  ox.globalAlpha = 1;
}

// ═══════════════════════════════════════════════════════════════════ boot
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w,h,false);
  cam.aspect = w/h; cam.updateProjectionMatrix();
  const dpr = devicePixelRatio||1;
  ov.width = w*dpr; ov.height = h*dpr;
  ov.style.width = w+"px"; ov.style.height = h+"px";
  ox.setTransform(dpr,0,0,dpr,0,0);
}
addEventListener("resize", resize);

loadRecord();
initTouch();
buildPlayerMesh();
recomputeStats(false);
resize();
renderSkills();
$("btnBegin").onclick = () => startRun();
$("btnMeta").onclick  = () => showMeta(false);
$("load").style.display = "none";

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.042, (now-last)/1000);
  last = now;
  if (G.phase === "playing") {
    G.runTime += dt;
    updatePlayer(dt);
    updateEnemies(dt);
    updateProjectiles(dt);
    updateHazards(dt);
    updatePickups(dt);
    checkObjective(dt);
    // exit
    if (G.exit && G.exit.open) {
      G.exit.mesh.rotation.z += dt*2;
      if (Math.hypot(P.pos.x-G.exit.x, P.pos.z-G.exit.z) < 2.2) nextFloor();
    }
  }
  updateFx(dt);
  updateCamera(dt);
  updateHUD();
  renderer.render(scene, cam);
  drawLabels();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

})();
