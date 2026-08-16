(function () {
"use strict";

// ═══════════════════════════════════════════════════════════════════ helpers
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp  = (a, b, t) => a + (b - a) * t;
const $     = id => document.getElementById(id);

// Deterministic RNG so a seed reproduces a world exactly. Math.random gives no
// way to replay a run that went strange, and this sim has enough moving parts
// that being able to replay one matters.
let _seed = (Date.now() ^ 0x9e3779b9) >>> 0;
function rnd() {
  _seed ^= _seed << 13; _seed >>>= 0;
  _seed ^= _seed >> 17;
  _seed ^= _seed << 5;  _seed >>>= 0;
  return _seed / 4294967296;
}
const rint  = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick  = arr => arr[Math.floor(rnd() * arr.length)];

// ═══════════════════════════════════════════════════════════════════ tuning
// Every number that shapes how the game feels lives here. The design rests on
// one tension: answering prayers buys Devotion with Dependency. Faith income
// scales with Devotion, so the greedy line is to answer everything — and that
// line loses, because Dependency both suppresses income and raises how often
// they pray. These constants are what make that trap real instead of cosmetic.
const CFG = {
  seasonMs:      1150,   // wall time per season at 1x
  seasonsPerYear: 4,

  faithPerPop:   0.052,  // × devotion × dependency-drag
  depDrag:       0.55,   // fraction of income Dependency can eat at 100%

  devStart:      78,
  devDecay:      0.028,  // devotion erodes on its own; you must keep earning it
  devPerAnswer:  4.2,
  devPerDeny:    5.6,    // refusing hurts MORE than answering helps — deliberate
  devPerDisaster: 7.0,
  devPerExpire:  6.4,

  depPerAnswer:  3.1,
  depDecay:      0.30,   // dependency fades if you leave them alone
  depMiracleMul: 2.2,

  selfRelStart:  0.55,
  selfRelGain:   0.055,  // denying a prayer teaches them
  selfRelLoss:   0.040,  // answering it un-teaches them
  selfRelDecay:  0.0012,

  prayBase:      7.4,    // seasons between prayers at zero dependency
  prayDepScale:  3.6,    // ...shrinking as dependency climbs
  prayMax:       6,      // queue cap; overflow expires oldest
  prayLifeMin:   14,
  prayLifeMax:   26,

  growthRate:    0.020,
  spreadPop:     78,     // pop at which a settlement throws off a colony
  spreadCost:    34,
  popCap:        260,

  // Tuned by A/B: at 0.35 a good run ended around season 270 (~5 min), which is
  // shorter than the strategy deserves. 0.24 stretches it to ~390. The rival
  // rate is raised at the same time so the race stays tight rather than the
  // player simply outrunning them with more time on the clock.
  ascRate:       0.24,   // × (pop/400) × devotion
  rivalAscBase:  0.145,  // re-lowered after the map opened up (see spreadChance)

  disasterBase:  13.0,   // seasons between world events
};

const ERAS = [
  { name: "Stone",   at: 0,    mul: 1.00 },
  { name: "Bronze",  at: 260,  mul: 1.16 },
  { name: "Iron",    at: 620,  mul: 1.34 },
  { name: "Classical", at: 1100, mul: 1.55 },
  { name: "Golden",  at: 1750, mul: 1.80 },
];

// ═══════════════════════════════════════════════════════════════════ hex grid
// Axial coordinates, pointy-top. Standard layout; the only subtlety is that
// pixel conversion has to agree with the hit-test, so both go through here.
const HEXW = 15, HEXH = 13;
const DIRS = [[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]];

const TERRAIN = {
  ocean:    { hab: 0.00, col: "#0d1b38", col2: "#122448", name: "Ocean" },
  coast:    { hab: 0.00, col: "#153055", col2: "#1b3d68", name: "Shallows" },
  plains:   { hab: 1.00, col: "#31432a", col2: "#3b5133", name: "Plains" },
  forest:   { hab: 0.80, col: "#20351f", col2: "#284127", name: "Forest" },
  hills:    { hab: 0.68, col: "#43412c", col2: "#4f4c34", name: "Hills" },
  desert:   { hab: 0.34, col: "#54452c", col2: "#635235", name: "Desert" },
  mountain: { hab: 0.16, col: "#3a3a44", col2: "#474751", name: "Mountains" },
};

let hexes = [];         // flat array
let hexAt = new Map();  // "q,r" -> hex

const key = (q, r) => q + "," + r;

function buildWorld() {
  hexes = []; hexAt = new Map();

  // Two independent noise fields: one for elevation (land vs sea, mountains),
  // one for moisture (forest vs desert). Classic, and it reads clearly at this
  // small a map where a fancier generator would just look like mush.
  const nA = [], nB = [];
  for (let i = 0; i < 64; i++) { nA.push(rnd()); nB.push(rnd()); }
  const sample = (tbl, x, y, f) => {
    const xi = Math.floor(x * f), yi = Math.floor(y * f);
    const fx = x * f - xi, fy = y * f - yi;
    const g = (a, b) => tbl[(((b % 8) + 8) % 8) * 8 + (((a % 8) + 8) % 8)];
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    return lerp(lerp(g(xi,yi), g(xi+1,yi), sx), lerp(g(xi,yi+1), g(xi+1,yi+1), sx), sy);
  };

  for (let r = 0; r < HEXH; r++) {
    for (let q = -Math.floor(r / 2); q < HEXW - Math.floor(r / 2); q++) {
      const cx = (q + r / 2) / HEXW, cy = r / HEXH;
      // Radial falloff keeps the landmass off the map edge, so colonies never
      // hug a hard border and the continent reads as an island world.
      // Measured across 40 seeds: the original 2.05/2.25 falloff produced only
      // 39.5% land, which on screen was a small continent adrift in dead blue.
      // 1.62/1.78 gives ~70% land — still a real coastline, but the board is
      // something you can actually expand into.
      const dx = (cx - 0.5) * 1.62, dy = (cy - 0.5) * 1.78;
      const edge = 1 - clamp(Math.hypot(dx, dy), 0, 1);
      const elev = sample(nA, cx, cy, 3.4) * 0.62 + sample(nA, cx, cy, 7.1) * 0.38;
      const moist = sample(nB, cx, cy, 4.2);
      const e = elev * 0.58 + edge * 0.62;

      let t;
      if      (e < 0.36) t = "ocean";
      else if (e < 0.41) t = "coast";
      else if (e > 0.88) t = "mountain";
      else if (e > 0.76) t = "hills";
      else if (moist > 0.62) t = "forest";
      else if (moist < 0.29) t = "desert";
      else t = "plains";

      const h = { q, r, t, town: null, seen: false };
      hexes.push(h); hexAt.set(key(q, r), h);
    }
  }
}

const neighbors = h => DIRS.map(d => hexAt.get(key(h.q + d[0], h.r + d[1]))).filter(Boolean);

// ═══════════════════════════════════════════════════════════════════ state
const G = {
  running: false, over: false, speed: 1,
  season: 0, acc: 0,
  faith: 55, devotion: CFG.devStart, dependency: 0,
  ascension: 0,
  towns: [], prayers: [], rivals: [],
  nextPray: 5, nextDisaster: 16,
  answered: 0, denied: 0, expired: 0, miracles: 0,
  sel: null, toastT: 0,
  fx: [],           // floating text / ripples
};

const NAMES_A = ["Kel","Vor","Ash","Mira","Tor","Yen","Sel","Bran","Ith","Dov","Rhen","Ossa",
                 "Cal","Nim","Thal","Ered","Sarn","Vela","Orin","Hesp","Lun","Draz"];
const NAMES_B = ["hollow","reach","fell","mere","gard","stead","vale","ford","crest","wick",
                 "moor","hall","spire","bank","rest","watch"];
const usedNames = new Set();
function townName() {
  for (let i = 0; i < 60; i++) {
    const n = pick(NAMES_A) + pick(NAMES_B);
    if (!usedNames.has(n)) { usedNames.add(n); return n; }
  }
  return "Hold" + rint(10, 99);
}

function makeTown(hex, owner, pop) {
  const t = {
    hex, owner,                     // owner: 0 = you, 1..n = rival index
    name: townName(),
    pop: pop || 30,
    selfRel: CFG.selfRelStart,
    food: 1.0,
    stress: 0,                      // unresolved trouble; drives disasters
    pulse: 0,
  };
  hex.town = t; G.towns.push(t);
  return t;
}

const RIVAL_NAMES = ["The Ashen Crown", "Verrow the Patient", "Sil, Who Counts"];
const RIVAL_COLS  = ["#c86adf", "#5fa8e8", "#e0764a"];

function startGame() {
  buildWorld();

  // Seed the player on the most habitable hex we can find near the middle, so
  // no run opens on a mountain with nowhere to expand.
  const land = hexes.filter(h => TERRAIN[h.t].hab > 0.6);
  if (!land.length) { buildWorld(); return startGame(); }
  land.sort((a, b) => {
    const ca = Math.abs(a.r - HEXH / 2) + Math.abs(a.q + a.r / 2 - HEXW / 2);
    const cb = Math.abs(b.r - HEXH / 2) + Math.abs(b.q + b.r / 2 - HEXW / 2);
    return ca - cb;
  });
  const home = land[0];
  makeTown(home, 0, 42);

  // Rivals start far away — being crowded at turn one is not a difficulty
  // curve, it is just a bad opening.
  const far = land.filter(h => hexDist(h, home) > 5);
  for (let i = 0; i < 3 && far.length; i++) {
    let best = null, bestD = -1;
    for (const h of far) {
      if (h.town) continue;
      let d = hexDist(h, home);
      for (const rv of G.rivals) d = Math.min(d, hexDist(h, rv.home) * 1.15);
      if (d > bestD) { bestD = d; best = h; }
    }
    if (!best) break;
    const rv = { idx: i + 1, name: RIVAL_NAMES[i], col: RIVAL_COLS[i], asc: 0, home: best,
                 aggression: 0.6 + rnd() * 0.8 };
    G.rivals.push(rv);
    makeTown(best, rv.idx, 34);
  }

  G.running = true;
  log("gold", "You open your eyes. Below, a people are already waiting.");
  log("", "They have not yet given you a name.");
}

function hexDist(a, b) {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}

// ═══════════════════════════════════════════════════════════════════ prayers
// A prayer is a decision, not a notification. Each one has a Faith price, a
// devotion swing, and a consequence for letting it lapse. The queue is capped
// so the player is always triaging rather than accumulating.
const PRAYER_KINDS = [
  { id:"famine",  w:1.0, urgent:true,  cost:[16,30],
    txt:["The harvest at {t} has failed. The grain stores are open and nearly empty.",
         "{t} has eaten its seed corn. There will be nothing to plant."],
    onDeny: t => { t.pop = Math.floor(t.pop * 0.86); t.stress += 1.1; } },

  { id:"beast",   w:0.9, urgent:true,  cost:[14,26],
    txt:["Something came out of the treeline near {t}. Four are dead and it has not left.",
         "The herds around {t} are being taken in the night. They are afraid to go out."],
    onDeny: t => { t.pop = Math.floor(t.pop * 0.91); t.stress += 0.8; } },

  { id:"plague",  w:0.62, urgent:true, cost:[26,44],
    txt:["A sickness has come to {t}. It moves faster than they can bury.",
         "{t} is coughing. The healers have stopped pretending they know what it is."],
    onDeny: t => { t.pop = Math.floor(t.pop * 0.79); t.stress += 1.5; } },

  { id:"drought", w:0.72, urgent:false, cost:[18,32],
    txt:["The wells at {t} are down to mud. They ask for rain.",
         "No rain has fallen on {t} for two seasons. They are rationing."],
    onDeny: t => { t.food *= 0.80; t.stress += 0.7; } },

  { id:"guide",   w:1.05, urgent:false, cost:[20,38],
    txt:["{t} wants to know how to bend iron. They have the ore and no idea what to do with it.",
         "The builders of {t} ask for a better way to raise a wall.",
         "{t} asks how to keep grain through a winter without it rotting."],
    onDeny: t => { t.selfRel += 0.03; } },        // they work it out themselves

  { id:"bless",   w:0.9, urgent:false, cost:[10,20],
    txt:["A child was born in {t} feet-first and living. They ask you to name the year for it.",
         "{t} is holding a marriage and would like you to be present, in whatever way you are.",
         "The elders of {t} ask only that you look at them once."],
    onDeny: t => {} },                             // pure devotion trade

  { id:"raid",    w:0.75, urgent:true,  cost:[24,42],
    txt:["Men with another god's mark are burning the outer fields of {t}.",
         "{t} sees banners on the ridge. They are not ours."],
    onDeny: t => { t.pop = Math.floor(t.pop * 0.88); t.stress += 1.2; } },
];

function spawnPrayer() {
  const mine = G.towns.filter(t => t.owner === 0);
  if (!mine.length) return;

  // Troubled and dependent settlements pray more. A self-reliant town mostly
  // handles its own problems, which is the reward for having refused it before.
  const weights = mine.map(t => 0.35 + t.stress * 0.9 + (1 - t.selfRel) * 1.3);
  let total = weights.reduce((a, b) => a + b, 0), roll = rnd() * total, town = mine[0];
  for (let i = 0; i < mine.length; i++) { roll -= weights[i]; if (roll <= 0) { town = mine[i]; break; } }

  // Self-reliant towns quietly solve things instead of praying.
  if (rnd() < town.selfRel * 0.42) {
    town.stress = Math.max(0, town.stress - 0.35);
    return;
  }

  let kt = 0, kroll;
  const kinds = PRAYER_KINDS;
  for (const k of kinds) kt += k.w;
  kroll = rnd() * kt;
  let kind = kinds[0];
  for (const k of kinds) { kroll -= k.w; if (kroll <= 0) { kind = k; break; } }

  const era = currentEra();
  const cost = Math.round(lerp(kind.cost[0], kind.cost[1], rnd()) * era.mul);
  const p = {
    kind, town, cost,
    text: pick(kind.txt).replace("{t}", town.name),
    life: rint(CFG.prayLifeMin, CFG.prayLifeMax),
    maxLife: 0, id: Math.random().toString(36).slice(2),
  };
  p.maxLife = p.life;
  G.prayers.push(p);

  // Overflow expires the oldest rather than silently dropping the new one, so
  // ignoring the panel always costs something visible.
  while (G.prayers.length > CFG.prayMax) {
    const old = G.prayers.shift();
    expirePrayer(old, true);
  }
  renderPrayers();
}

function answerPrayer(p, miracle) {
  const mul = miracle ? CFG.depMiracleMul : 1;
  const cost = miracle ? Math.round(p.cost * 2.1) : p.cost;
  if (G.faith < cost) return;

  G.faith -= cost;
  G.devotion   = clamp(G.devotion + CFG.devPerAnswer * (miracle ? 2.4 : 1), 0, 100);
  G.dependency = clamp(G.dependency + CFG.depPerAnswer * mul, 0, 100);
  p.town.selfRel = clamp(p.town.selfRel - CFG.selfRelLoss * mul, 0, 1);
  p.town.stress  = Math.max(0, p.town.stress - (miracle ? 2.4 : 1.3));
  p.town.pulse   = 1;
  G.answered++;
  if (miracle) { G.miracles++; p.town.pop = Math.floor(p.town.pop * 1.06); }

  fx(p.town, miracle ? "MIRACLE" : "answered", miracle ? "#f5d67a" : "#9de08a");
  log(miracle ? "gold" : "good",
      (miracle ? "You break the sky over " : "You answer ") + p.town.name + ".");
  removePrayer(p);
}

function denyPrayer(p) {
  G.devotion = clamp(G.devotion - CFG.devPerDeny, 0, 100);
  p.town.selfRel = clamp(p.town.selfRel + CFG.selfRelGain, 0, 1);
  p.kind.onDeny(p.town);
  G.denied++;
  fx(p.town, "silence", "#e08a8a");
  log("", "You say nothing to " + p.town.name + ".");
  removePrayer(p);
  checkDead();
}

function expirePrayer(p, overflow) {
  G.devotion = clamp(G.devotion - CFG.devPerExpire, 0, 100);
  p.kind.onDeny(p.town);
  p.town.stress += 0.5;
  G.expired++;
  fx(p.town, "unheard", "#ff6b6b");
  log("bad", (overflow ? "Drowned out: " : "Unanswered: ") + p.town.name +
             " waited and you did not come.");
  if (!overflow) removePrayer(p);
  checkDead();
}

function removePrayer(p) {
  const i = G.prayers.indexOf(p);
  if (i >= 0) G.prayers.splice(i, 1);
  renderPrayers();
}

// ═══════════════════════════════════════════════════════════════════ sim
function currentEra() {
  let e = ERAS[0];
  const pop = totalPop(0);
  for (const x of ERAS) if (pop >= x.at) e = x;
  return e;
}
const totalPop = owner => G.towns.reduce((s, t) => s + (t.owner === owner ? t.pop : 0), 0);
const myTowns  = () => G.towns.filter(t => t.owner === 0);

function step() {
  G.season++;
  const era = currentEra();

  // ── faith income ────────────────────────────────────────────────────────
  const drag = 1 - (G.dependency / 100) * CFG.depDrag;
  const income = totalPop(0) * CFG.faithPerPop * (G.devotion / 100) * drag * era.mul;
  G.faith += income;

  // ── devotion & dependency drift ─────────────────────────────────────────
  // Both decay toward neutral. Devotion decaying means standing still loses;
  // dependency decaying means restraint actually pays back over time.
  G.devotion   = clamp(G.devotion - CFG.devDecay, 0, 100);
  G.dependency = clamp(G.dependency - CFG.depDecay, 0, 100);

  // ── settlements ─────────────────────────────────────────────────────────
  for (const t of G.towns) {
    const hab = TERRAIN[t.hex.t].hab;
    // A self-reliant town feeds itself better. This is the mechanical payoff
    // for refusing prayers, and it has to be big enough to feel like a choice.
    const yield_ = hab * t.food * (0.62 + t.selfRel * 0.72) * era.mul;
    const crowd  = 1 - t.pop / CFG.popCap;
    t.pop += t.pop * CFG.growthRate * yield_ * crowd - t.stress * 0.55;
    t.pop = Math.max(0, t.pop);
    t.food = clamp(t.food + 0.014, 0, 1.25);
    t.stress = Math.max(0, t.stress - 0.045);
    t.selfRel = clamp(t.selfRel - CFG.selfRelDecay, 0, 1);
    t.pulse *= 0.90;

    if (t.pop < 4) { killTown(t); continue; }

    // ── expansion ─────────────────────────────────────────────────────────
    // Rivals colonise at roughly half the player's rate. They outnumber you
    // three to one, so at parity they simply eat the map: opening the world up
    // to ~70% land took rival holdings from 1-5 settlements to 12-22 and made
    // even good play unwinnable. This is the counterweight.
    const spreadChance = t.owner === 0 ? 0.055 : 0.026;
    if (t.pop > CFG.spreadPop && rnd() < spreadChance) {
      const open = neighbors(t.hex).filter(h => !h.town && TERRAIN[h.t].hab > 0.25);
      if (open.length) {
        open.sort((a, b) => TERRAIN[b.t].hab - TERRAIN[a.t].hab);
        const target = open[Math.min(open.length - 1, rint(0, 1))];
        t.pop -= CFG.spreadCost;
        const nt = makeTown(target, t.owner, CFG.spreadCost);
        nt.selfRel = t.selfRel;
        if (t.owner === 0) log("", nt.name + " is founded out of " + t.name + ".");
      }
    }
  }

  // ── prayers ─────────────────────────────────────────────────────────────
  for (let i = G.prayers.length - 1; i >= 0; i--) {
    const p = G.prayers[i];
    if (--p.life <= 0) expirePrayer(p, false);
  }
  if (--G.nextPray <= 0) {
    spawnPrayer();
    const gap = Math.max(2.2, CFG.prayBase - (G.dependency / 100) * CFG.prayDepScale
                              - myTowns().length * 0.12);
    G.nextPray = Math.round(gap * lerp(0.7, 1.35, rnd()));
  }

  // ── world events ────────────────────────────────────────────────────────
  if (--G.nextDisaster <= 0) {
    disaster();
    G.nextDisaster = Math.round(CFG.disasterBase * lerp(0.75, 1.45, rnd()));
  }

  // ── rivals ──────────────────────────────────────────────────────────────
  for (const rv of G.rivals) {
    const rp = totalPop(rv.idx);
    rv.asc += (rp / 400) * CFG.rivalAscBase * era.mul;
    // Rivals convert your settlements when your devotion is low — the pressure
    // that stops "answer nothing" from being a free strategy.
    if (G.devotion < 42 && rnd() < 0.012 * rv.aggression * (1 - G.devotion / 100)) {
      const mine = myTowns();
      if (mine.length > 1) {
        const victim = mine.reduce((a, b) => a.selfRel < b.selfRel ? a : b);
        victim.owner = rv.idx;
        log("rival", rv.name + " takes " + victim.name + ". They stopped believing you were coming.");
        fx(victim, "lost", rv.col);
      }
    }
  }

  // ── ascension ───────────────────────────────────────────────────────────
  G.ascension += (totalPop(0) / 400) * (G.devotion / 100) * CFG.ascRate * era.mul;

  checkDead();
  checkWin();
}

function killTown(t) {
  t.hex.town = null;
  const i = G.towns.indexOf(t);
  if (i >= 0) G.towns.splice(i, 1);
  // Any prayer from a dead settlement dies with it.
  for (let j = G.prayers.length - 1; j >= 0; j--)
    if (G.prayers[j].town === t) { G.prayers.splice(j, 1); }
  if (t.owner === 0) { log("bad", t.name + " is empty. The last of them walked out."); renderPrayers(); }
  if (G.sel === t) { G.sel = null; $("inspect").style.display = "none"; }
}

const DISASTERS = [
  { n: "A hard winter",     f: () => { for (const t of myTowns()) { t.food *= 0.80; t.stress += 0.5; } } },
  { n: "A wet spring",      f: () => { for (const t of myTowns()) t.food = clamp(t.food + 0.22, 0, 1.3); } },
  { n: "A sickness season", f: () => { for (const t of myTowns()) if (rnd() < 0.4) t.stress += 1.0; } },
  { n: "A quiet year",      f: () => { for (const t of myTowns()) t.stress = Math.max(0, t.stress - 0.8); } },
];

function disaster() {
  const d = pick(DISASTERS);
  d.f();
  log(d.n === "A wet spring" || d.n === "A quiet year" ? "good" : "bad", d.n + " passes over the world.");
}

function checkDead() {
  if (G.over) return;
  if (G.devotion <= 0)        return end(false, "They stopped praying.",
    "Devotion reached nothing. A god with no believers is not a small god — it is not a god. " +
    "The sky where you were is just sky now.");
  if (myTowns().length === 0) return end(false, "There is no one left.",
    "Your last settlement emptied. You still exist, technically, which is the worst version of this.");
}

function checkWin() {
  if (G.over) return;
  if (G.ascension >= 100) return end(true, "Ascension.",
    "Enough of them believed, for long enough, that the belief became structural. You are not " +
    "watching the world any more. You are one of the things it is made of.");
  for (const rv of G.rivals) {
    if (rv.asc >= 100) return end(false, rv.name + " ascends.",
      "Another constellation got there first. The sky only has room for so many fixed points, " +
      "and yours was not one of them.");
  }
}

function end(won, title, body) {
  G.over = true; G.running = false;
  const yrs = Math.floor(G.season / CFG.seasonsPerYear);
  $("endCard").innerHTML =
    '<h2 style="color:' + (won ? "#f5d67a" : "#ff8888") + '">' + title + "</h2>" +
    '<div class="lede">' + (won ? "You are a god" : "Your name is forgotten") + "</div>" +
    "<p class='serif'>" + body + "</p><div class='rule'></div>" +
    "<p>" +
      "<span class='tag'>" + yrs + " years</span>" +
      "<span class='tag'>" + Math.round(totalPop(0)) + " people</span>" +
      "<span class='tag'>" + myTowns().length + " settlements</span>" +
      "<span class='tag'>" + Math.round(G.ascension) + "% ascension</span>" +
    "</p><p>" +
      "<span class='tag'>" + G.answered + " answered</span>" +
      "<span class='tag'>" + G.denied + " refused</span>" +
      "<span class='tag'>" + G.expired + " unheard</span>" +
      "<span class='tag'>" + G.miracles + " miracles</span>" +
    "</p>" +
    '<div style="margin-top:22px"><button class="btn" onclick="location.reload()">Again</button></div>';
  $("ovEnd").classList.add("on");
}

// ═══════════════════════════════════════════════════════════════════ effects
function fx(town, text, col) {
  // Two labels on the same settlement used to render on top of each other and
  // come out as illegible overstruck glyphs. Stack them instead: each new label
  // for a town still on screen starts one row higher.
  const stack = G.fx.filter(f => f.town === town && f.t < 1.1).length;
  G.fx.push({ town, text, col, t: 0, row: stack });
}

function toast(msg) {
  const el = $("toast");
  el.textContent = msg; el.classList.add("on"); G.toastT = 2.2;
}

function log(cls, msg) {
  const el = $("log");
  const yr = Math.floor(G.season / CFG.seasonsPerYear) + 1;
  const d = document.createElement("div");
  if (cls) d.className = cls;
  d.innerHTML = '<span class="t">' + yr + "</span><span>" + msg + "</span>";
  el.appendChild(d);
  while (el.children.length > 90) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

// ═══════════════════════════════════════════════════════════════════ render
const cv = $("cv"), ctx = cv.getContext("2d");
let W = 0, H = 0, DPR = 1, HS = 26, OX = 0, OY = 0;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  const r = cv.getBoundingClientRect();
  W = r.width; H = r.height;
  cv.width = Math.floor(W * DPR); cv.height = Math.floor(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  // Fit the whole grid with a margin, then centre it.
  const gw = Math.sqrt(3) * (HEXW + 0.5), gh = 1.5 * HEXH + 0.5;
  HS = Math.min(W / gw, H / gh) * 0.94;
  OX = W / 2 - HS * Math.sqrt(3) * (HEXW - 1) / 2;
  OY = H / 2 - HS * 1.5 * (HEXH - 1) / 2;
}
window.addEventListener("resize", resize);

const hx = h => OX + HS * Math.sqrt(3) * (h.q + h.r / 2);
const hy = h => OY + HS * 1.5 * h.r;

function hexPath(x, y, s) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 180 * (60 * i - 90);
    const px = x + s * Math.cos(a), py = y + s * Math.sin(a);
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath();
}

let animT = 0;
function draw(dt) {
  animT += dt;
  ctx.clearRect(0, 0, W, H);

  // ── terrain ─────────────────────────────────────────────────────────────
  for (const h of hexes) {
    const x = hx(h), y = hy(h), T = TERRAIN[h.t];
    hexPath(x, y, HS * 0.97);
    // A subtle vertical gradient per hex keeps the map from reading as flat
    // paint; at this scale that is most of what makes it look considered.
    const g = ctx.createLinearGradient(x, y - HS, x, y + HS);
    g.addColorStop(0, T.col2); g.addColorStop(1, T.col);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = "#00000038"; ctx.lineWidth = 1; ctx.stroke();
  }

  // ── constellation lines: your settlements, joined ────────────────────────
  // This is the title made literal — your holdings drawn as a figure in the
  // sky. It also happens to be the clearest read of "how big am I".
  const mine = myTowns();
  if (mine.length > 1) {
    ctx.save();
    ctx.strokeStyle = "rgba(227,178,60,0.30)";
    ctx.lineWidth = 1.1;
    ctx.setLineDash([4, 5]);
    ctx.lineDashOffset = -animT * 12;
    for (let i = 0; i < mine.length; i++) {
      // Join each to its nearest neighbour only — a full graph is spaghetti.
      let best = null, bd = 1e9;
      for (let j = 0; j < mine.length; j++) {
        if (i === j) continue;
        const d = hexDist(mine[i].hex, mine[j].hex);
        if (d < bd) { bd = d; best = mine[j]; }
      }
      if (best && bd <= 4) {
        ctx.beginPath();
        ctx.moveTo(hx(mine[i].hex), hy(mine[i].hex));
        ctx.lineTo(hx(best.hex), hy(best.hex));
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // ── settlements ─────────────────────────────────────────────────────────
  for (const t of G.towns) {
    const x = hx(t.hex), y = hy(t.hex);
    const rv = t.owner === 0 ? null : G.rivals[t.owner - 1];
    const col = t.owner === 0 ? "#e3b23c" : (rv ? rv.col : "#888");
    const rad = HS * (0.17 + Math.min(0.30, t.pop / CFG.popCap * 0.30));

    // glow
    const gl = ctx.createRadialGradient(x, y, 0, x, y, rad * 3.4);
    gl.addColorStop(0, col + "55"); gl.addColorStop(1, col + "00");
    ctx.fillStyle = gl;
    ctx.beginPath(); ctx.arc(x, y, rad * 3.4, 0, 7); ctx.fill();

    // answered-prayer pulse
    if (t.pulse > 0.02) {
      ctx.strokeStyle = "rgba(245,214,122," + t.pulse.toFixed(3) + ")";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, rad + (1 - t.pulse) * HS * 1.5, 0, 7); ctx.stroke();
    }

    // Body, with a heavy dark collar. A settlement dot has to read against
    // ocean, forest and desert alike, and a 1px 40%-black stroke did not — a
    // blue rival on a blue hex vanished. The collar is what separates every
    // owner colour from every terrain colour.
    ctx.fillStyle = "#05060c";
    ctx.beginPath(); ctx.arc(x, y, rad + 2.6, 0, 7); ctx.fill();
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(x, y, rad, 0, 7); ctx.fill();
    // Rivals get a hollow centre so they are distinguishable from yours even
    // for a player who cannot separate the hues.
    if (t.owner !== 0) {
      ctx.fillStyle = "#05060c";
      ctx.beginPath(); ctx.arc(x, y, rad * 0.42, 0, 7); ctx.fill();
    }

    // a settlement praying right now gets a marker, so the map and the panel
    // always agree about where attention is needed
    if (G.prayers.some(p => p.town === t)) {
      const b = 0.55 + 0.45 * Math.sin(animT * 4.5);
      ctx.strokeStyle = "rgba(255,255,255," + b.toFixed(3) + ")";
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(x, y, rad + 4.5, 0, 7); ctx.stroke();
    }

    if (G.sel === t) {
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, rad + 8, 0, 7); ctx.stroke();
    }

    if (HS > 20 && t.pop > 24) {
      ctx.fillStyle = "rgba(255,255,255,0.62)";
      ctx.font = "600 9px ui-sans-serif,system-ui";
      ctx.textAlign = "center";
      ctx.fillText(t.name, x, y + rad + 11);
    }
  }

  // ── floating effect text ────────────────────────────────────────────────
  for (let i = G.fx.length - 1; i >= 0; i--) {
    const f = G.fx[i];
    f.t += dt;
    if (f.t > 1.6 || !f.town.hex) { G.fx.splice(i, 1); continue; }
    const a = 1 - f.t / 1.6;
    ctx.globalAlpha = a;
    ctx.fillStyle = f.col;
    ctx.font = "700 10px ui-sans-serif,system-ui";
    ctx.textAlign = "center";
    ctx.fillText(f.text.toUpperCase(), hx(f.town.hex),
                 hy(f.town.hex) - 16 - f.t * 20 - (f.row || 0) * 12);
    ctx.globalAlpha = 1;
  }
}

// ═══════════════════════════════════════════════════════════════════ UI
function renderPrayers() {
  const box = $("prayers");
  $("pCount").textContent = G.prayers.length;
  if (!G.prayers.length) {
    box.innerHTML = '<div class="empty">No one is asking for anything.<br>' +
                    "This is either peace or the beginning of being forgotten.</div>";
    return;
  }
  box.innerHTML = "";
  for (const p of G.prayers) {
    const d = document.createElement("div");
    d.className = "pray" + (p.kind.urgent ? " urgent" : "");
    const afford  = G.faith >= p.cost;
    const mCost   = Math.round(p.cost * 2.1);
    const affordM = G.faith >= mCost;
    d.innerHTML =
      '<div class="from"><span>' + p.town.name + "</span><em>" + p.kind.id + "</em></div>" +
      '<div class="txt">' + p.text + "</div>" +
      '<div class="row">' +
        '<button class="yes" ' + (afford ? "" : "disabled") + ' data-a="1">Answer' +
          '<span class="c">' + p.cost + " faith</span></button>" +
        '<button class="yes" ' + (affordM ? "" : "disabled") + ' data-a="2">Miracle' +
          '<span class="c">' + mCost + " faith</span></button>" +
        '<button class="no" data-a="0">Refuse<span class="c">−' +
          CFG.devPerDeny.toFixed(1) + " dev</span></button>" +
      "</div>" +
      '<div class="fuse" style="width:' + (p.life / p.maxLife * 100).toFixed(1) + '%"></div>';
    d.querySelectorAll("button").forEach(b => {
      b.onclick = () => {
        const a = b.getAttribute("data-a");
        if (a === "0") denyPrayer(p);
        else answerPrayer(p, a === "2");
      };
    });
    box.appendChild(d);
  }
}

function updateFuses() {
  const cards = $("prayers").children;
  for (let i = 0; i < G.prayers.length && i < cards.length; i++) {
    const f = cards[i].querySelector(".fuse");
    if (f) f.style.width = (G.prayers[i].life / G.prayers[i].maxLife * 100).toFixed(1) + "%";
  }
}

let lastHud = "";
function updateHUD() {
  const era = currentEra(), pop = totalPop(0), mine = myTowns().length;
  const drag = 1 - (G.dependency / 100) * CFG.depDrag;
  const inc = pop * CFG.faithPerPop * (G.devotion / 100) * drag * era.mul;

  // Cheap change-detect: the HUD is a dozen DOM writes and this runs at 60fps.
  const sig = [Math.floor(G.faith), Math.round(G.devotion), Math.round(G.dependency),
               Math.floor(pop), mine, era.name, Math.floor(G.ascension), G.season].join("|");
  if (sig === lastHud) return;
  lastHud = sig;

  $("sFaith").textContent = Math.floor(G.faith);
  $("sFaithInc").textContent = (inc >= 0 ? "+" : "") + inc.toFixed(1) + " / season";
  $("sDev").textContent = Math.round(G.devotion) + "%";
  $("mDev").style.width = G.devotion + "%";
  $("mDev").style.background = G.devotion < 25 ? "var(--danger)"
                             : G.devotion < 50 ? "var(--warn)" : "var(--dev)";
  $("sDep").textContent = Math.round(G.dependency) + "%";
  $("mDep").style.width = G.dependency + "%";
  $("sPop").textContent = Math.floor(pop);
  $("sTowns").textContent = mine + (mine === 1 ? " settlement" : " settlements");
  $("sEra").textContent = era.name;
  $("sYear").textContent = "Year " + (Math.floor(G.season / CFG.seasonsPerYear) + 1);
  $("sAsc").textContent = Math.floor(G.ascension) + "%";
  $("mAsc").style.width = Math.min(100, G.ascension) + "%";

  // Prayer buttons enable/disable as faith crosses their price.
  renderPrayerAfford();
}

function renderPrayerAfford() {
  const cards = $("prayers").children;
  for (let i = 0; i < G.prayers.length && i < cards.length; i++) {
    const p = G.prayers[i], bs = cards[i].querySelectorAll("button");
    if (bs.length < 3) continue;
    bs[0].disabled = G.faith < p.cost;
    bs[1].disabled = G.faith < Math.round(p.cost * 2.1);
  }
}

function updateInspect() {
  const el = $("inspect");
  if (!G.sel) { el.style.display = "none"; return; }
  const t = G.sel;
  const owner = t.owner === 0 ? "Yours" : (G.rivals[t.owner - 1] || {}).name || "Rival";
  el.style.display = "block";
  el.innerHTML =
    "<h4>" + t.name + "</h4>" +
    '<div class="sub">' + TERRAIN[t.hex.t].name + " · " + owner + "</div>" +
    '<div class="r"><span>People</span><b>' + Math.floor(t.pop) + "</b></div>" +
    '<div class="r"><span>Self-reliance</span><b>' + Math.round(t.selfRel * 100) + "%</b></div>" +
    '<div class="r"><span>Harvest</span><b>' + Math.round(t.food * 100) + "%</b></div>" +
    '<div class="r"><span>Hardship</span><b>' + t.stress.toFixed(1) + "</b></div>";
}

// ═══════════════════════════════════════════════════════════════════ input
cv.addEventListener("click", e => {
  const r = cv.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  let best = null, bd = HS * 0.9;
  for (const t of G.towns) {
    const d = Math.hypot(hx(t.hex) - mx, hy(t.hex) - my);
    if (d < bd) { bd = d; best = t; }
  }
  G.sel = best;
  updateInspect();
});

function setSpeed(s) {
  G.speed = s;
  ["sp0", "sp1", "sp2"].forEach((id, i) => {
    const on = [0, 1, 3][i] === s;
    if (on) $(id).setAttribute("data-on", "1"); else $(id).removeAttribute("data-on");
  });
}
$("sp0").onclick = () => setSpeed(0);
$("sp1").onclick = () => setSpeed(1);
$("sp2").onclick = () => setSpeed(3);
$("spH").onclick = () => { $("ovIntro").classList.add("on"); setSpeed(0); };

$("btnStart").onclick = () => {
  $("ovIntro").classList.remove("on");
  if (!G.running && !G.over && !G.towns.length) startGame();
  setSpeed(1);
};

window.addEventListener("keydown", e => {
  if (e.key === " ") { e.preventDefault(); setSpeed(G.speed === 0 ? 1 : 0); }
  if (e.key === "1") setSpeed(1);
  if (e.key === "2") setSpeed(3);
  // Number keys answer the matching prayer — the panel is the main interface
  // and reaching for the mouse for every decision gets old fast.
  const n = parseInt(e.key, 10);
  if (n >= 4 && n <= 9) {
    const p = G.prayers[n - 4];
    if (p && G.faith >= p.cost) answerPrayer(p, false);
  }
});

// ═══════════════════════════════════════════════════════════════════ loop
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (G.running && G.speed > 0) {
    G.acc += dt * 1000 * G.speed;
    // Guard against a tab that was backgrounded dumping 400 seasons at once.
    let guard = 0;
    while (G.acc >= CFG.seasonMs && guard++ < 8) {
      G.acc -= CFG.seasonMs;
      step();
    }
    if (guard >= 8) G.acc = 0;
    updateFuses();
  }

  if (G.toastT > 0) { G.toastT -= dt; if (G.toastT <= 0) $("toast").classList.remove("on"); }

  draw(dt);
  updateHUD();
  requestAnimationFrame(frame);
}

resize();
renderPrayers();
requestAnimationFrame(frame);

})();
