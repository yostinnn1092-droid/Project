(() => {
"use strict";
const T = THREE;

// ─────────────────────────────────────────────────────────── tuning
const CFG = {
  gravity:      -26,
  moveSpeed:    7.6,
  turnLerp:     11,
  grabRadius:   13,
  // Wave scaling knobs, kept together so they are easy to find and re-tune.
  enemyMul:     2.0,     // every wave composition is doubled
  waveStrength: 0.01,    // compounding survivability per wave: 1% = 1.01^(n-1)
  // Hard ceiling on bodies per wave, applied AFTER every multiplier. The
  // doubling compounds with the late-wave ramp and the HORDE modifier, and
  // unchecked that reached 68 in a single wave — the walker separation pass
  // is O(n^2), so that is 4,600 distance checks per frame before anything
  // else happens. The cap keeps the doubling everywhere it is affordable and
  // only bites at the extreme end.
  maxWaveBodies: 44,

  arenaStock:   26,      // props kept alive in the arena; spent ones return here
  zoneR:        6.5,
  zoneTime:     14,
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

  // Style, kinetic meter and Overdrive.
  styleGrace:   3.4,     // seconds of no kills before style starts bleeding
  styleDecay:   34,      // style points per second once it does
  kinPerDamage: 0.00085, // meter per point of damage dealt
  odTime:       9,       // Overdrive duration
  odDamage:     1.55,
  odGrabR:      7,
  odSpeed:      1.18,

  // Mode identity. Single is the finisher: it aims high and executes the
  // wounded. Burst is crowd control: individually weak, but three landing
  // together collapse into a shockwave.
  execAt:       0.28,    // fraction of max HP at or below which Single executes
  burstWaveMin: 3,       // stones from one burst that must land
  burstWaveWin: 1.3,     // within this many seconds
  burstWaveR:   9,
  burstWaveDmg: 120,

  throwSpeed:   40,
  killSpeed:    13,
  seekTurn:     3.0,     // rad/s the stone can bend toward its mark
  seekTime:     1.5,     // how long guidance lasts
  seekGrav:     0.25,    // gravity multiplier while guided

  // Kinetic strain. FOCUS used to be a pool you spent down; strain is the
  // same meter read the other way up, and it is the same meter deliberately
  // — a separate strain bar alongside focus and the kinetic meter would be
  // three readouts of "how much telekinesis can I do", which is two too many.
  // The difference that matters is the failure mode: focus running out just
  // stopped you, strain maxing out OVERLOADS you, which is a state with
  // consequences you have to play around.
  strainGather: 0.030,   // per unit of mass lifted
  strainSingle: 0.035,   // per aimed shot, scaled by mass — sustainable
  strainBurst:  0.105,   // PER STONE in a volley — this IS the tradeoff.
                         // Three times what an aimed shot costs each, so a
                         // full volley of ordinary stone lands at ~0.95 and
                         // a volley of boulders overloads outright. Burst is
                         // affordable once, never twice, and never free.
  strainRepulse:0.20,
  strainRecover:0.30,    // per second
  strainRested: 1.9,     // recovery multiplier after a moment of not acting
  overloadTime: 3.4,
  overloadClear:0.55,    // strain must fall here before telekinesis returns

  modeCooldown: 10,

  jumpV:        11.5,    // launch speed; ~1.3s hang time under this gravity
  airControl:   0.55,    // fraction of ground steering kept mid-air
  dodgeHeight:  1.7,     // above this, a walker's swipe passes under you
  dashSpeed:    26,
  dashTime:     0.17,
  dashCd:       1.3,

  restitution:  0.34,
  arena:        34,
  walkSpeed:    1.8,     // at or below this the gait is a walk
  runSpeed:     7.6,     // at or above this it is a full run (dash overshoots)
  zSpeed:       2.05,
  zReach:       1.7,
  zCooldown:    1.15,
  maxHealth:    5,
  aimCone:      0.972,
  singleMul:    1.4,     // precision bonus: one deliberate, heavy shot
  burstMul:     0.6,     // each burst projectile hits softer, but spreads
  weakMul:      2.5,     // head hit
  critMul:      5.0,     // dead centre, aimed shots only
  burstCone:    0.72,
  camMin:       7.0,     // shoulder-close; below this the hero's own aura
                         // and carry halo take over the frame
  camMax:       26,      // wide enough to see a whole flank coming
  camStep:      1.6,     // per wheel notch / key press

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
renderer.toneMappingExposure = 1.38;
const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

const scene = new T.Scene();
scene.background = null;             // replaced by the sky texture per arena
scene.fog = new T.Fog(0x0b1310, 26, 72);
const camera = new T.PerspectiveCamera(62, 1, 0.1, 200);

// Threshold sits above the diffuse range, so only genuinely hot things —
// the psychic light, walker eyes, guided stones — actually bleed.
// The renderer's own `antialias: true` does nothing once everything is drawn
// through EffectComposer — the composer renders into its own target, and
// unless that target is multisampled every edge in the game is a staircase.
// This one line is the difference between "hobby project" and "shipped".
const msaaTarget = new T.WebGLRenderTarget(1, 1, {
  type: T.HalfFloatType, samples: 4,
  colorSpace: T.LinearSRGBColorSpace,
});
const composer = new PP.EffectComposer(renderer, msaaTarget);
composer.addPass(new PP.RenderPass(scene, camera));

// Ambient occlusion. Contact darkness where geometry meets geometry is most
// of what separates a lit scene from a grounded one — without it every prop
// looks like a sticker lying on the floor.
const gtao = new PP.GTAOPass(scene, camera, 1, 1);
gtao.output = PP.GTAOPass.OUTPUT.Default;
composer.addPass(gtao);
const bloom = new PP.UnrealBloomPass(new T.Vector2(1, 1), 0.68, 0.5, 0.82);
composer.addPass(bloom);

// Grade. A filmic contrast curve, a little desaturation in the shadows, a
// vignette, and per-pixel grain. None of it is expensive and together it is
// most of the difference between "a render" and "a shot".
const GradeShader = {
  uniforms: {
    tDiffuse:   { value: null },
    uTime:      { value: 0 },
    uGrain:     { value: 0.055 },
    uVignette:  { value: 0.30 },
    uContrast:  { value: 1.09 },
    uSaturation:{ value: 1.06 },
    uAberration:{ value: 0.0016 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime, uGrain, uVignette, uContrast, uSaturation, uAberration;
    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    void main() {
      vec2 uv = vUv;
      vec2 fromCentre = uv - 0.5;
      float r2 = dot(fromCentre, fromCentre);

      // Chromatic aberration, scaled by distance from centre so the middle of
      // the frame — where the crosshair is — stays clean.
      vec2 off = fromCentre * uAberration * r2 * 4.0;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + off).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - off).b;

      // Contrast around mid grey, then saturation.
      col = (col - 0.5) * uContrast + 0.5;
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(lum), col, uSaturation);
      // Shadows lose a little colour, which reads as film rather than video.
      col = mix(col, vec3(lum), (1.0 - smoothstep(0.0, 0.35, lum)) * 0.18);

      // Vignette.
      col *= 1.0 - uVignette * smoothstep(0.15, 0.85, r2 * 2.0);

      // Grain, animated so it does not look like dirt on the lens.
      float g = hash(uv * 1024.0 + fract(uTime) * 91.7) - 0.5;
      col += g * uGrain * (1.0 - lum * 0.6);

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};
// ORDER MATTERS. OutputPass does tone mapping and the conversion to display
// colour space; everything before it is linear HDR, where mid grey is 0.18
// and not 0.5. A contrast curve pivoted on 0.5 applied to linear values
// crushes the whole image — it measured a 50% loss of brightness and turned
// the arena black. The grade belongs AFTER the output pass, on
// display-referred values, which is what it was written for.
composer.addPass(new PP.OutputPass());

const grade = new PP.ShaderPass(GradeShader);
composer.addPass(grade);

// Edge cleanup last, on the graded image.
const smaa = new PP.SMAAPass(1, 1);
composer.addPass(smaa);

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  bloom.setSize(w, h);
  if (gtao) gtao.setSize(w, h);
  if (smaa) smaa.setSize(w, h);
  camera.aspect = w / h;
  camera.fov = w < h ? 74 : 62;
  camera.updateProjectionMatrix();
  el("rotate").classList.toggle("show", h > w * 1.15 && S.phase !== "menu");
}
addEventListener("resize", resize);
addEventListener("orientationchange", () => setTimeout(resize, 250));

// ─────────────────────────────────────────────────────────── lighting
const hemi = new T.HemisphereLight(0x53709a, 0x27301c, 1.25);
scene.add(hemi);
const sun = new T.DirectionalLight(0xc3d8f5, 2.1);   // moonlight through the canopy
sun.position.set(14, 22, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
// A wide PCF radius over a big flat plane at a grazing sun angle banded the
// ground with straight seams. Soft shadows are not worth streaking the floor
// they fall on.
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.022;
sun.shadow.radius = 1.6;
// Tighter frustum over the same map size = sharper contact shadows. The
// light follows the hero, so a wide arena still stays covered.
Object.assign(sun.shadow.camera, { left:-22, right:22, top:22, bottom:-22, near:1, far:60 });
scene.add(sun);

// PBR materials without an environment read as flat paint — roughness has
// nothing to blur and metalness has nothing to mirror. A single prefiltered
// probe, regenerated per arena from that arena's own sky and ground colours,
// is what makes wet stone look wet and a girder look like metal.
const pmrem = new T.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();

// The ground needs large-scale colour variation, not just bump. Built per
// arena from that arena's own two floor colours so the patches always belong
// to the place.
let groundAlbedo = null, clearAlbedo = null;

function buildGroundAlbedo(A) {
  if (groundAlbedo) groundAlbedo.dispose();
  if (clearAlbedo)  clearAlbedo.dispose();
  const gLo = new T.Color(A.ground).multiplyScalar(0.82).getHex();
  const gHi = new T.Color(A.ground).multiplyScalar(1.5).getHex();
  groundAlbedo = albedoFrom(TEX._soil, TEX._soil2, TSIZE, gLo, gHi, 9);
  const cLo = new T.Color(A.clearing).multiplyScalar(0.84).getHex();
  const cHi = new T.Color(A.clearing).multiplyScalar(1.45).getHex();
  clearAlbedo = albedoFrom(TEX._soil, TEX._soil2, TSIZE, cLo, cHi, 9);
  groundMat.map = groundAlbedo; groundMat.needsUpdate = true;
  clearMat.map  = clearAlbedo;  clearMat.needsUpdate  = true;
  // Ground cover shares the floor's own albedo. It was the last surface still
  // lit off a flat colour once the ground moved to a mottled map, which is
  // why it kept reading as bright plates lying on top of the earth rather
  // than as part of it.
  scrubMat.map  = clearAlbedo;  scrubMat.needsUpdate  = true;
  // The map carries the colour now; leaving the tint on multiplies it twice.
  groundMat.color.setHex(0xffffff);
  clearMat.color.setHex(0xffffff);
}

// One sky canvas, used for BOTH the visible background and the reflection
// probe, so what you see behind the treeline is literally what the wet stone
// is reflecting. A flat background colour was the last thing making this read
// as a tech demo rather than a place: no horizon, no depth, nothing above the
// trees.
let skyTex = null, envRT = null;

function buildSky(A) {
  const W = 1024, H = 512;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");

  const sky = new T.Color(A.hemiSky), grd = new T.Color(A.hemiGround);
  const sun = new T.Color(A.sun), bg = new T.Color(A.bg);
  const rgb = (col, m=1) => `rgb(${Math.min(255,col.r*255*m)|0},${Math.min(255,col.g*255*m)|0},${Math.min(255,col.b*255*m)|0})`;

  // Vertical band: deep at the zenith, warming toward the horizon, then the
  // ground colour below it.
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0.00, rgb(bg, 0.55));
  g.addColorStop(0.30, rgb(bg, 1.0));
  g.addColorStop(0.46, rgb(sky, 0.55));
  g.addColorStop(0.50, rgb(sky, 0.85));
  g.addColorStop(0.54, rgb(grd, 0.9));
  g.addColorStop(1.00, rgb(grd, 0.45));
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  // Stars, thinning toward the horizon. Only above the skyline.
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 900; i++) {
    const x = Math.random()*W;
    const y = Math.pow(Math.random(), 1.7) * H * 0.46;
    const a = (1 - y/(H*0.46)) * 0.9 * Math.random();
    const s2 = Math.random() < 0.06 ? 1.8 : 0.9;
    ctx.fillStyle = `rgba(255,252,240,${a.toFixed(3)})`;
    ctx.beginPath(); ctx.arc(x, y, s2, 0, 6.283); ctx.fill();
  }

  // Where the key light comes from: a broad glow sitting on the horizon,
  // which is what gives the sky a direction and the scene a sense of place.
  const sx = W * 0.17, sy = H * 0.46;
  const rg = ctx.createRadialGradient(sx, sy, 2, sx, sy, W*0.34);
  rg.addColorStop(0.0, rgb(sun, 1.0));
  rg.addColorStop(0.25, rgb(sun, 0.35));
  rg.addColorStop(1.0, "rgba(0,0,0,0)");
  ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H*0.62);

  // A second, cooler bloom opposite it, so the sky is not lit from one side
  // only and the silhouettes on that side still separate from it.
  const rx = W * 0.72, ry = H * 0.44;
  const rg2 = ctx.createRadialGradient(rx, ry, 2, rx, ry, W*0.24);
  rg2.addColorStop(0.0, rgb(sky, 0.75));
  rg2.addColorStop(1.0, "rgba(0,0,0,0)");
  ctx.fillStyle = rg2; ctx.fillRect(0, 0, W, H*0.6);
  ctx.globalCompositeOperation = "source-over";

  // Cloud banding along the horizon — a few soft stretched ellipses, enough
  // to break the gradient up so it does not read as a colour ramp.
  ctx.globalAlpha = 0.16;
  for (let i = 0; i < 26; i++) {
    const x = Math.random()*W, y = H*(0.30 + Math.random()*0.15);
    const w2 = 60 + Math.random()*230, h2 = 6 + Math.random()*16;
    ctx.fillStyle = rgb(sky, 0.5 + Math.random()*0.6);
    ctx.beginPath(); ctx.ellipse(x, y, w2, h2, 0, 0, 6.283); ctx.fill();
  }
  ctx.globalAlpha = 1;

  if (skyTex) skyTex.dispose();
  skyTex = new T.CanvasTexture(c);
  skyTex.mapping = T.EquirectangularReflectionMapping;
  skyTex.colorSpace = T.SRGBColorSpace;
  return skyTex;
}

function buildEnvironment(A) {
  const t = buildSky(A);
  scene.background = t;
  scene.backgroundIntensity = 0.85;
  if (envRT) envRT.dispose();
  envRT = pmrem.fromEquirectangular(t);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.8;
}

// Cool rim from behind: separates silhouettes from a very dark ground,
// which is what stops walkers vanishing into the backdrop at range.
const rim = new T.DirectionalLight(0x7fd0a0, 1.0);
rim.position.set(-12, 9, -14);
scene.add(rim);
const psi = new T.PointLight(0xe94fbf, 0, 24, 2);
scene.add(psi);

// ─────────────────────────────────────────────────────────── textures
// Every surface here is generated at runtime on a 2D canvas. The artifact
// CSP blocks every external host, so there is no such thing as loading a
// texture file — a procedural library is the only way to get off flat
// untextured colour. All of it is built once, at load, and shared.
const TEX = {};

// Value noise, fBm-stacked. The grid for each octave is sized to exactly the
// number of cells that octave spans across the texture, so index wrapping at
// the grid edge IS the texture edge and every layer tiles seamlessly. A first
// pass sampled every octave from one fixed 64-cell grid at frequencies that
// did not divide 64, which does not tile — and at repeat(9,9) across the
// ground that showed up as a hard grid of seams straight across the floor.
function noiseLayer(out, size, fx, fy, amp, seed) {
  const g = new Float32Array(fx*fy);
  let st = (seed >>> 0) || 1;
  const rnd = () => (st = (st*1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  const at = (a, b) => g[(((b % fy) + fy) % fy) * fx + (((a % fx) + fx) % fx)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = x/size*fx, gy = y/size*fy;
      const xi = Math.floor(gx), yi = Math.floor(gy);
      const tx = gx - xi, ty = gy - yi;
      const sx = tx*tx*(3-2*tx), sy = ty*ty*(3-2*ty);
      const a = at(xi,yi), b = at(xi+1,yi), c = at(xi,yi+1), d = at(xi+1,yi+1);
      out[y*size+x] += amp * ((a*(1-sx)+b*sx)*(1-sy) + (c*(1-sx)+d*sx)*sy);
    }
  }
}

function fbm(size, octaves, seed) {
  const out = new Float32Array(size*size);
  let amp = 1, norm = 0, freq = 4;
  for (let o = 0; o < octaves; o++) {
    noiseLayer(out, size, freq, freq, amp, seed + o*977);
    norm += amp; amp *= 0.5; freq *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

function canvasOf(size) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  return c;
}

function texFrom(canvas, repeat) {
  const t = new T.CanvasTexture(canvas);
  t.wrapS = t.wrapT = T.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = maxAniso;
  return t;
}

// Height field -> tangent-space normal map. This is what actually sells a
// surface: colour variation alone still reads as flat paint under a moving
// light, and the whole point of the exercise is that the light moves.
function normalFromHeight(h, size, strength, repeat) {
  const c = canvasOf(size), ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  const at = (x,y) => h[((y+size)%size)*size + ((x+size)%size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x+1,y) - at(x-1,y)) * strength;
      const dy = (at(x,y+1) - at(x,y-1)) * strength;
      // normalize(-dx, -dy, 1) mapped into 0..255
      const len = Math.hypot(dx, dy, 1);
      const i = (y*size+x)*4;
      img.data[i]   = (-dx/len * 0.5 + 0.5) * 255;
      img.data[i+1] = (-dy/len * 0.5 + 0.5) * 255;
      img.data[i+2] = ( 1  /len * 0.5 + 0.5) * 255;
      img.data[i+3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return texFrom(c, repeat);
}

// Greyscale field -> single-channel-ish map, used for roughness and AO.
function grayFrom(h, size, lo, hi, repeat) {
  const c = canvasOf(size), ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < h.length; i++) {
    const v = (lo + (hi-lo)*h[i]) * 255;
    img.data[i*4] = img.data[i*4+1] = img.data[i*4+2] = v;
    img.data[i*4+3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return texFrom(c, repeat);
}

// Colour field: a base tint modulated by the same height field, with a
// second field mixing in a contrasting tone so it does not read as one
// colour with the brightness wobbling.
function albedoFrom(h, h2, size, colA, colB, repeat, srgb) {
  const c = canvasOf(size), ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  const a = new T.Color(colA), b = new T.Color(colB);
  for (let i = 0; i < h.length; i++) {
    const t = Math.min(1, Math.max(0, h2[i]*1.35 - 0.15));
    const shade = 0.86 + 0.28*h[i];
    img.data[i*4]   = Math.min(255, (a.r + (b.r-a.r)*t) * shade * 255);
    img.data[i*4+1] = Math.min(255, (a.g + (b.g-a.g)*t) * shade * 255);
    img.data[i*4+2] = Math.min(255, (a.b + (b.b-a.b)*t) * shade * 255);
    img.data[i*4+3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = texFrom(c, repeat);
  t.colorSpace = srgb === false ? T.NoColorSpace : T.SRGBColorSpace;
  return t;
}

// Bark: anisotropic layers — many cells across, few down — so the grain runs
// as long vertical fibres rather than as blobs.
function barkHeight(size, seed) {
  const out = new Float32Array(size*size);
  noiseLayer(out, size, 24, 3,  0.62, seed);
  noiseLayer(out, size, 48, 6,  0.24, seed + 31);
  noiseLayer(out, size,  8, 12, 0.14, seed + 57);
  return out;
}

const TSIZE = 256;

function buildTextures() {
  const rock  = fbm(TSIZE, 4, 11);
  const rock2 = fbm(TSIZE, 3, 77);
  const soil  = fbm(TSIZE, 5, 203);
  const soil2 = fbm(TSIZE, 3, 401);
  const bark  = barkHeight(TSIZE, 613);
  const cloth = fbm(TSIZE, 4, 821);
  const flesh = fbm(TSIZE, 3, 929);

  TEX.groundN = normalFromHeight(soil, TSIZE, 26, 9);
  TEX.groundR = grayFrom(soil, TSIZE, 0.72, 1.0, 9);
  TEX.rockN   = normalFromHeight(rock, TSIZE, 40, 2);
  TEX.rockR   = grayFrom(rock, TSIZE, 0.55, 0.95, 2);
  TEX.barkN   = normalFromHeight(bark, TSIZE, 34, 3);
  TEX.barkR   = grayFrom(bark, TSIZE, 0.7, 1.0, 3);
  TEX.clothN  = normalFromHeight(cloth, TSIZE, 12, 2);
  TEX.fleshN  = normalFromHeight(flesh, TSIZE, 9, 1.5);

  // Held for re-tinting: every arena rebuilds its own ground albedo from
  // these, because a mottle that reads as leaf litter reads as nothing at
  // all on quarry stone.
  TEX._soil = soil; TEX._soil2 = soil2;
  TEX._rock = rock; TEX._rock2 = rock2;
  TEX._bark = bark;
}

buildTextures();

// ─────────────────────────────────────────────────────────── arenas
// Four places to fight, cycling every three waves. They are not reskins:
// each one changes how much cover you get, how far you can see, and how
// legible a body is against the ground — which is the whole read of a fight
// at range. Everything below is built ONCE and then re-coloured and
// re-placed per arena, because disposing and rebuilding two hundred
// instanced trees mid-run is a stutter the player would feel.
const ARENAS = [
  { id:"woods", name:"BLACKWOOD", sub:"Night forest. Close horizon, heavy cover.",
    bg:0x0b1310, fogNear:26, fogFar:72,
    ground:0x33402a, clearing:0x46512f,
    hemiSky:0x53709a, hemiGround:0x27301c, hemiI:1.25,
    sun:0xc3d8f5, sunI:2.1, rim:0x7fd0a0, rimI:1.0,
    trunk:0x3b2f26, foliaA:0x24401f, foliaB:0x2f5228,
    treeH:[7,15], trunkW:1.0, canopyScale:1.0, treeRing:23,
    scrub:0x223a1a, scrubTint:0x9fc98a, scrubN:260,
    bole:0x4a3b2c, stone:0x8d9199, log:0x342a22,
    mote:0xd8e878, moteSize:0.13, moteHi:6,
    coverTrees:6, coverStones:4, logs:7 },

  { id:"quarry", name:"THE QUARRY", sub:"Open stone. Long sightlines, little to hide behind.",
    bg:0x161311, fogNear:40, fogFar:112,
    ground:0x4a4238, clearing:0x5d5346,
    hemiSky:0x9a8a70, hemiGround:0x342c24, hemiI:1.5,
    sun:0xffd9a8, sunI:2.4, rim:0xc98f5a, rimI:0.8,
    trunk:0x6e6355, foliaA:0x7d7263, foliaB:0x5f564a,
    treeH:[3.5,7.5], trunkW:2.7, canopyScale:0.5, treeRing:30,
    scrub:0x574b3a, scrubTint:0xc9bda6, scrubN:120,
    bole:0x6e6355, stone:0x9a9188, log:0x554b3e,
    mote:0xe8d9a8, moteSize:0.10, moteHi:9,
    coverTrees:3, coverStones:8, logs:4 },

  { id:"ash", name:"ASHFALL", sub:"Burnt ground. Embers falling, almost no cover left.",
    bg:0x150a08, fogNear:20, fogFar:64,
    ground:0x35211a, clearing:0x4a2e23,
    hemiSky:0x9a4a30, hemiGround:0x1c100c, hemiI:1.15,
    sun:0xffb079, sunI:2.15, rim:0xff4a2a, rimI:0.9,
    trunk:0x241a16, foliaA:0x2e201a, foliaB:0x1c1310,
    treeH:[6,13], trunkW:0.72, canopyScale:0.22, treeRing:26,
    scrub:0x2e1c12, scrubTint:0xb08a70, scrubN:90,
    bole:0x2b1f19, stone:0x6b5a52, log:0x1f1512,
    mote:0xff7a3c, moteSize:0.16, moteHi:11,
    coverTrees:4, coverStones:3, logs:9 },

  { id:"ruin", name:"SUNKEN RUIN", sub:"Flooded stonework. Cold light, broken pillars.",
    bg:0x08131a, fogNear:22, fogFar:80,
    ground:0x1e3038, clearing:0x2a4149,
    hemiSky:0x4a8fa8, hemiGround:0x16242a, hemiI:1.35,
    sun:0xa8d8f0, sunI:1.9, rim:0x4fd6e9, rimI:1.2,
    trunk:0x6d7a80, foliaA:0x2c4a44, foliaB:0x223a38,
    treeH:[5,12], trunkW:1.7, canopyScale:0.55, treeRing:25,
    scrub:0x1f3a34, scrubTint:0x8fc9bd, scrubN:200,
    bole:0x7a838a, stone:0x8fa0a8, log:0x3a4a50,
    mote:0x9fe8ff, moteSize:0.12, moteHi:8,
    coverTrees:5, coverStones:6, logs:5 },
];

// ─────────────────────────────────────────────────────────── world
const groundMat = new T.MeshStandardMaterial({
  color: 0x33402a, roughness: 1.0, metalness: 0,
  normalMap: TEX.groundN, roughnessMap: TEX.groundR,
  normalScale: new T.Vector2(1.1, 1.1), envMapIntensity: 0.35 });
const ground = new T.Mesh(new T.CircleGeometry(CFG.arena + 26, 96), groundMat);
ground.rotation.x = -Math.PI/2; ground.receiveShadow = true;
scene.add(ground);

// A worn clearing floor, slightly lighter than the ground beyond it, so the
// playable circle reads as a place rather than an invisible rule.
const clearMat = new T.MeshStandardMaterial({
  color: 0x46512f, roughness: 0.96, metalness: 0,
  normalMap: TEX.groundN, roughnessMap: TEX.groundR,
  normalScale: new T.Vector2(0.85, 0.85), envMapIntensity: 0.35 });
const clearing = new T.Mesh(new T.CircleGeometry(CFG.arena, 72), clearMat);
clearing.rotation.x = -Math.PI/2; clearing.position.y = 0.015;
clearing.receiveShadow = true;
scene.add(clearing);

// Treeline is instanced: ~200 trunks and 400 crowns would be 600 draw calls
// as separate meshes, and 3 as instances. The same three meshes serve every
// arena — a quarry is the same instances with rock colours, a squat profile
// and the crowns scaled down to rubble.
const TREES = 210;
const trunkMat = new T.MeshStandardMaterial({
  color: 0x3b2f26, roughness: 0.94, metalness: 0,
  normalMap: TEX.barkN, roughnessMap: TEX.barkR,
  normalScale: new T.Vector2(1.4, 1.4), envMapIntensity: 0.3 });
const foliaA = new T.MeshStandardMaterial({
  color: 0x24401f, roughness: 0.88, metalness: 0,
  normalMap: TEX.fleshN, normalScale: new T.Vector2(0.9, 0.9), envMapIntensity: 0.4 });
const foliaB = new T.MeshStandardMaterial({
  color: 0x2f5228, roughness: 0.88, metalness: 0,
  normalMap: TEX.fleshN, normalScale: new T.Vector2(0.9, 0.9), envMapIntensity: 0.4 });

// More sides on the trunks and a subdivision on the crowns: at 210 instances
// this is three draw calls either way, and the silhouette stops reading as
// origami the moment the profile has more than six faces.
const trunks = new T.InstancedMesh(new T.CylinderGeometry(0.26, 0.46, 1, 10), trunkMat, TREES);
const canopy1 = new T.InstancedMesh(new T.IcosahedronGeometry(1, 1), foliaA, TREES);
const canopy2 = new T.InstancedMesh(new T.IcosahedronGeometry(1, 1), foliaB, TREES);
trunks.castShadow = canopy1.castShadow = canopy2.castShadow = true;
trunks.receiveShadow = canopy1.receiveShadow = canopy2.receiveShadow = true;
scene.add(trunks, canopy1, canopy2);

const M = new T.Matrix4(), Q = new T.Quaternion(), Vp = new T.Vector3(), Vs = new T.Vector3();

function layTreeline(A) {
  for (let i = 0; i < TREES; i++) {
    // Ring the clearing, thickening outward, so the player is walled in
    // without a single trunk standing inside the fight.
    const a = rand(0, Math.PI*2);
    const d = CFG.arena + 2.5 + Math.pow(Math.random(), 0.65) * A.treeRing;
    const x = Math.cos(a)*d, z = Math.sin(a)*d;
    const h = rand(A.treeH[0], A.treeH[1]), lean = rand(-0.06, 0.06);

    Q.setFromEuler(new T.Euler(lean, rand(0, 6.28), lean));
    const tw = A.trunkW;
    M.compose(Vp.set(x, h/2, z), Q, Vs.set(rand(0.8,1.3)*tw, h, rand(0.8,1.3)*tw));
    trunks.setMatrixAt(i, M);

    const cs = A.canopyScale;
    const r1 = rand(1.9, 3.2) * cs;
    Q.setFromEuler(new T.Euler(rand(0,1), rand(0,6.28), rand(0,1)));
    M.compose(Vp.set(x, h*0.82, z), Q, Vs.set(r1, r1*rand(0.7,1.0), r1));
    canopy1.setMatrixAt(i, M);

    const r2 = r1 * rand(0.6, 0.85);
    Q.setFromEuler(new T.Euler(rand(0,1), rand(0,6.28), rand(0,1)));
    M.compose(Vp.set(x + rand(-1,1), h*0.62, z + rand(-1,1)), Q, Vs.set(r2, r2*0.8, r2));
    canopy2.setMatrixAt(i, M);
  }
  trunks.instanceMatrix.needsUpdate = true;
  canopy1.instanceMatrix.needsUpdate = true;
  canopy2.instanceMatrix.needsUpdate = true;
}

// Ground cover inside the clearing: purely decorative and kept low, so it
// dresses the floor without ever blocking a stone or a walker. Unused
// instances are parked at zero scale rather than removed.
const SCRUB = 260;
const scrubMat = new T.MeshStandardMaterial({
  color: 0x1d3018, roughness: 0.95, metalness: 0,
  normalMap: TEX.fleshN, envMapIntensity: 0.3 });
const scrub = new T.InstancedMesh(new T.IcosahedronGeometry(1, 0), scrubMat, SCRUB);
scrub.receiveShadow = true;
scene.add(scrub);

function layScrub(A) {
  for (let i = 0; i < SCRUB; i++) {
    if (i >= A.scrubN) { M.makeScale(0,0,0); scrub.setMatrixAt(i, M); continue; }
    const a = rand(0, Math.PI*2), d = Math.sqrt(Math.random()) * (CFG.arena - 2);
    const s = rand(0.2, 0.44);
    Q.setFromEuler(new T.Euler(rand(-0.2,0.2), rand(0,6.28), rand(-0.2,0.2)));
    // Small, rounded and half-buried. Wide flat plates caught the key light
    // and read as dark tiles lying on the floor rather than as ground cover.
    M.compose(Vp.set(Math.cos(a)*d, s*0.2, Math.sin(a)*d), Q, Vs.set(s*1.3, s*0.62, s*1.3));
    scrub.setMatrixAt(i, M);
  }
  scrub.instanceMatrix.needsUpdate = true;
}

// Solid cover inside the clearing. Until this existed the arena floor was
// empty and the treeline purely decorative, so there was nothing to slam
// anything INTO — which is half of what environmental combat means.
const obstacles = [];
const boleMat  = new T.MeshStandardMaterial({
  color: 0x4a3b2c, roughness: 0.93, metalness: 0,
  normalMap: TEX.barkN, roughnessMap: TEX.barkR,
  normalScale: new T.Vector2(1.5, 1.5), envMapIntensity: 0.3 });
const stoneMat = new T.MeshStandardMaterial({
  color: 0x8d9199, roughness: 0.82, metalness: 0.04,
  normalMap: TEX.rockN, roughnessMap: TEX.rockR,
  normalScale: new T.Vector2(1.6, 1.6), envMapIntensity: 0.7 });

function addObstacle(x, z, r, h, kind) {
  const mesh = kind === "stone"
    ? new T.Mesh(new T.DodecahedronGeometry(r*1.15, 1), stoneMat)
    : new T.Mesh(new T.CylinderGeometry(r*0.85, r*1.1, h, 12), boleMat);
  mesh.position.set(x, h/2, z);
  if (kind === "stone") { mesh.position.y = r*0.75; mesh.rotation.set(rand(0,1), rand(0,6), rand(0,1)); }
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  // Cover is destructible: a boulder is not a permanent feature of the map,
  // it is a thing you can knock down and then have to live without.
  obstacles.push({ pos: new T.Vector3(x, 0, z), r, h, mesh, kind,
                   hp: kind === "stone" ? 420 : 300, maxHp: kind === "stone" ? 420 : 300,
                   dead:false });
}

function hurtObstacle(ob, amount) {
  if (ob.dead) return;
  ob.hp -= amount;
  // Lean it further as it takes punishment, so the state is readable before
  // it goes rather than only after.
  const wear = 1 - Math.max(0, ob.hp)/ob.maxHp;
  ob.mesh.rotation.z = wear * 0.5 * (ob.kind === "stone" ? 0.4 : 1);
  if (ob.hp > 0) { sparks(ob.mesh.position, 0xb9b0a2, 6, 12); return; }
  ob.dead = true;
  ob.mesh.visible = false;
  sparks(ob.mesh.position, ob.kind === "stone" ? 0xb9b0a2 : 0x6b4b34, 22, 24);
  SFX.boom();
  S.shake = Math.min(1, S.shake + 0.4);
  banner(ob.kind === "stone" ? "COVER SHATTERED" : "TIMBER");
  // Falling cover hurts whatever is standing under it.
  queueBlast(ob.pos, { r: ob.r + 3.4, dmg: 120 }, null);
}

// Cover has to be hittable without becoming a wall between the player and
// the fight. A first pass put 15 obstacles from 0.3x arena radius outward,
// including boulders the size of a house directly in the firing line; most
// throws hit scenery and the kill rate collapsed. Fewer, smaller, and held
// out past the middle where the player actually stands.
function layCover(A) {
  // A dozen meshes is cheap to rebuild; the instanced treeline is not, which
  // is why only this part is torn down between arenas.
  obstacles.forEach(ob => { scene.remove(ob.mesh); ob.mesh.geometry.dispose(); });
  obstacles.length = 0;
  for (let i = 0; i < A.coverTrees; i++) {
    const a = (i/A.coverTrees)*Math.PI*2 + rand(-0.35,0.35);
    const d = rand(CFG.arena*0.58, CFG.arena*0.9);
    addObstacle(Math.cos(a)*d, Math.sin(a)*d, rand(0.6,0.85), rand(5,8), "tree");
  }
  for (let i = 0; i < A.coverStones; i++) {
    const a = (i/A.coverStones)*Math.PI*2 + rand(-0.6,0.6);
    const d = rand(CFG.arena*0.55, CFG.arena*0.85);
    addObstacle(Math.cos(a)*d, Math.sin(a)*d, rand(0.7,1.0), 1.9, "stone");
  }
}

// Fallen logs and rubble, for silhouette interest at ground level.
const logMat = new T.MeshStandardMaterial({
  color: 0x342a22, roughness: 0.95, metalness: 0,
  normalMap: TEX.barkN, roughnessMap: TEX.barkR,
  normalScale: new T.Vector2(1.3, 1.3), envMapIntensity: 0.28 });
const logs = [];

function layLogs(A) {
  logs.forEach(L => { scene.remove(L); L.geometry.dispose(); });
  logs.length = 0;
  for (let i = 0; i < A.logs; i++) {
    const a = rand(0, Math.PI*2), d = rand(CFG.arena*0.45, CFG.arena-3);
    const L = new T.Mesh(new T.CylinderGeometry(0.34, 0.42, rand(3,6), 12), logMat);
    L.position.set(Math.cos(a)*d, 0.36, Math.sin(a)*d);
    L.rotation.set(Math.PI/2, 0, rand(0, 6.28));
    L.rotation.z = rand(0, 6.28);
    L.castShadow = L.receiveShadow = true;
    scene.add(L);
    logs.push(L);
  }
}

// Drifting motes. Fireflies in the woods, dust in the quarry, embers in the
// ash — same points, different colour, size and ceiling.
const moteN = 260, motePos = new Float32Array(moteN*3);
const moteGeo = new T.BufferGeometry();
moteGeo.setAttribute("position", new T.BufferAttribute(motePos, 3));
const moteMat = new T.PointsMaterial({
  color: 0xd8e878, size: 0.13, transparent: true, opacity: 0.85,
  depthWrite: false, sizeAttenuation: true });
const motes = new T.Points(moteGeo, moteMat);
scene.add(motes);

function layMotes(A) {
  for (let i = 0; i < moteN; i++) {
    const a = rand(0, Math.PI*2), d = Math.sqrt(Math.random()) * (CFG.arena + 12);
    motePos[i*3]   = Math.cos(a)*d;
    motePos[i*3+1] = rand(0.5, A.moteHi);
    motePos[i*3+2] = Math.sin(a)*d;
  }
  moteGeo.attributes.position.needsUpdate = true;
  moteMat.color.setHex(A.mote);
  moteMat.size = A.moteSize;
}

// The one entry point: swap every palette and re-lay everything that varies.
let arena = ARENAS[0];

function buildArena(A) {
  arena = A;
  // Fog should fade toward the HORIZON, not toward the old flat background —
  // otherwise distant geometry dissolves into a dark band sitting in front of
  // a bright sky, which reads as a missing skybox.
  scene.fog.color.copy(new T.Color(A.bg).lerp(new T.Color(A.hemiSky), 0.45));
  scene.fog.near = A.fogNear; scene.fog.far = A.fogFar;

  buildEnvironment(A);
  hemi.color.setHex(A.hemiSky); hemi.groundColor.setHex(A.hemiGround);
  hemi.intensity = A.hemiI;
  sun.color.setHex(A.sun); sun.intensity = A.sunI;
  rim.color.setHex(A.rim);  rim.intensity = A.rimI;

  buildGroundAlbedo(A);
  trunkMat.color.setHex(A.trunk);
  foliaA.color.setHex(A.foliaA);
  foliaB.color.setHex(A.foliaB);
  scrubMat.color.setHex(A.scrubTint);
  boleMat.color.setHex(A.bole);
  stoneMat.color.setHex(A.stone);
  logMat.color.setHex(A.log);

  layTreeline(A);
  layScrub(A);
  layCover(A);
  layLogs(A);
  layMotes(A);
}

// Three waves each, then cycle, so a long run keeps moving instead of
// running out of places at wave 12.
function arenaFor(n) {
  return ARENAS[Math.floor((n-1)/3) % ARENAS.length];
}

// ─────────────────────────────────────────────────────────── hero
const HERO = new T.Group();
// Default Euler order is XYZ, which resolves to yaw applied BEFORE pitch —
// so a lean set on rotation.x tips the body toward world +Z no matter which
// way the character faces, and running "south" leans backwards. YXZ applies
// the lean in the body's own frame, which is the only thing that means
// "forward". Verified by checking where the head actually moves at four
// facings, not by reading the matrix convention.
HERO.rotation.order = "YXZ";
scene.add(HERO);

const skin   = new T.MeshStandardMaterial({
  color: 0xd8b49a, roughness: 0.74, metalness: 0,
  normalMap: TEX.fleshN, normalScale: new T.Vector2(0.5,0.5), envMapIntensity: 0.5 });
const cloak  = new T.MeshStandardMaterial({
  color: 0x232b33, roughness: 0.88, metalness: 0.02,
  normalMap: TEX.clothN, normalScale: new T.Vector2(1.5,1.5), envMapIntensity: 0.4 });
const under  = new T.MeshStandardMaterial({
  color: 0x39424c, roughness: 0.86, metalness: 0.02,
  normalMap: TEX.clothN, normalScale: new T.Vector2(1.2,1.2), envMapIntensity: 0.4 });
const leather= new T.MeshStandardMaterial({
  color: 0x4a3524, roughness: 0.68, metalness: 0.05,
  normalMap: TEX.clothN, normalScale: new T.Vector2(1.1,1.1), envMapIntensity: 0.7 });
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
// The skirt hung to mid-shin, which meant the legs were inside it and every
// stride the character took was invisible from the game's own camera. Cut to
// upper-thigh length so the gait actually reads, with more sides so the hem
// is not a visible octagon.
const cloakSkirt = part(new T.CylinderGeometry(0.40, 0.60, 0.62, 12, 1, true), cloak, 0, 1.30, 0);
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

// Two segments with a joint between them. A single straight capsule can be
// swung but it cannot be BENT, and a leg that never bends cannot run — the
// difference between a walk and a run is mostly knee, not stride. The pivot
// is still what callers rotate, so it keeps behaving like the old one-piece
// limb; `.joint` is the new half.
function limb(parent, len, mat, px, py, pz, rad = 0.115, endMat) {
  const pivot = new T.Group();
  pivot.position.set(px,py,pz);
  const upper = len*0.52, lower = len - upper;
  pivot.add(part(new T.CapsuleGeometry(rad, upper, 5, 9), mat, 0, -upper/2-0.05, 0));

  const joint = new T.Group();
  joint.position.y = -upper - 0.06;
  joint.add(part(new T.CapsuleGeometry(rad*0.92, lower, 5, 9), mat, 0, -lower/2-0.04, 0));
  // A blob at the end of the limb: hands and boots stop the arms looking
  // like sticks, which is most of what "unfinished model" reads as.
  if (endMat) {
    const end = part(new T.SphereGeometry(rad*1.5, 8, 6), endMat, 0, -lower-0.08, 0);
    end.scale.set(1, 0.85, 1.15);
    joint.add(end);
  }
  pivot.add(joint);
  pivot.joint = joint;

  parent.add(pivot);
  return pivot;
}
// Pushed clear of the shoulder mantle; at 0.45 they swung inside it.
const armL = limb(HERO, 0.52, under, -0.53, 1.72, 0, 0.105, skin);
const armR = limb(HERO, 0.52, under,  0.53, 1.72, 0, 0.105, skin);
// Length and hip height are set together so a straight leg puts the boot on
// the floor. At 0.58 from a hip at 0.95 the foot hung ~0.18 above the ground
// and the whole run read as levitating.
const legL = limb(HERO, 0.70, under, -0.17, 1.00, 0, 0.125, leather);
const legR = limb(HERO, 0.70, under,  0.17, 1.00, 0, 0.125, leather);

const aura = new T.Mesh(new T.SphereGeometry(1.55,22,16),
  new T.MeshBasicMaterial({ color:0xe94fbf, transparent:true, opacity:0, side:T.BackSide }));
aura.position.y = 1.3;
HERO.add(aura);

const hero = { pos: new T.Vector3(0,0,0), yaw: 0, walk: 0, hp: CFG.maxHealth,
  speed: 0, gait: 0, lastX: 0, lastZ: 0,
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

// ─────────────────────────────────────────────────────────── enemy AI
// Enemies used to run `pos += normalize(hero - pos) * speed`, which is the
// shortest path for every one of them at once. The result is a queue: they
// arrive single file from wherever they spawned and die in order, and there
// is no positioning problem for the player to solve. Difficulty here is not
// a statline, it is a shape — bodies that arc around and close from several
// bearings at once are dangerous at the same health.
//
// Per archetype: how hard it arcs, how much room it wants from its
// neighbours, and how close it commits to a straight run.
// Per archetype: standoff ring it wants to fight from, how much it shuffles
// sideways to find a free bearing, how much room it wants from its
// neighbours, and how long its attack telegraph is.
const AI = {
  walker:   { ring: 1.5, lateral: 0.55, spacing: 2.0, telegraph: 0.42 },
  runner:   { ring: 1.3, lateral: 0.30, spacing: 1.6, telegraph: 0.26 },
  crawler:  { ring: 1.2, lateral: 0.70, spacing: 1.4, telegraph: 0.34 },
  tank:     { ring: 2.0, lateral: 0.15, spacing: 2.8, telegraph: 0.70 },
  armored:  { ring: 1.7, lateral: 0.40, spacing: 2.3, telegraph: 0.52 },
  exploder: { ring: 1.0, lateral: 0.20, spacing: 1.8, telegraph: 0.30 },
  leaper:   { ring: 1.6, lateral: 0.65, spacing: 2.1, telegraph: 0.32 },
  shield:   { ring: 1.8, lateral: 0.25, spacing: 2.5, telegraph: 0.60 },
  // These two fight from range and should never crowd into contact.
  spawner:  { ring: 12,  lateral: 0.55, spacing: 3.2, telegraph: 0.55 },
  warper:   { ring: 15,  lateral: 0.60, spacing: 3.0, telegraph: 0.50 },
  disruptor:{ ring: 9,   lateral: 0.75, spacing: 2.4, telegraph: 0.40 },
  grabber:  { ring: 1.2, lateral: 0.35, spacing: 1.8, telegraph: 0.45 },
};
const AI_DEFAULT = AI.walker;

const steer = new T.Vector3(), sep = new T.Vector3();

// Direction this body should travel.
//
// The first attempt at this made the lateral term as strong as the radial
// one, on the theory that arcing bodies would encircle. They did not — they
// ORBITED. Bodies with a flank weight above 1 turned more than they closed,
// and at twenty-four simulated seconds there were still enemies circling at
// nineteen metres that never engaged at all. That is not harder, it is
// easier, and it stalls wave completion.
//
// What actually produces encirclement is much simpler: the spawn ring
// already puts bodies on even bearings, so the job is to PRESERVE that
// spread while closing, not to add rotation. Each body drives straight in to
// its own standoff ring and holds there; the lateral term is a weak shuffle
// that only fills gaps, and it can never overpower the approach.
function walkerHeading(w, toHero, dist, out) {
  const cfg = w.AI;

  // Radial: close to the standoff ring, back off if crowded inside it.
  const closing = clamp(dist - cfg.ring, -1, 1);
  out.copy(toHero).multiplyScalar(closing);

  // Lateral: a shuffle for position, strongest once near the ring, and
  // always weaker than a full approach so it bends the path instead of
  // replacing it.
  const near = clamp(1 - (dist - cfg.ring) / 14, 0, 1);
  const lat = cfg.lateral * near;
  out.x += -toHero.z * lat * w.arcDir;
  out.z +=  toHero.x * lat * w.arcDir;

  // Separation. This is what turns a converging crowd into a ring: without
  // it every body funnels to the same point and stacks.
  sep.set(0, 0, 0);
  let n = 0;
  for (const o of walkers) {
    if (o === w || o.dead || o.thrown > 0) continue;
    const dx = w.pos.x - o.pos.x, dz = w.pos.z - o.pos.z;
    const d2 = dx*dx + dz*dz;
    const want = cfg.spacing + o.r;
    if (d2 > 0.0001 && d2 < want*want) {
      const d = Math.sqrt(d2);
      sep.x += (dx/d) * (1 - d/want);
      sep.z += (dz/d) * (1 - d/want);
      n++;
    }
  }
  if (n) out.addScaledVector(sep, 1.1);

  out.y = 0;
  const len = out.length();
  // Below a threshold it is holding station on the ring, not travelling.
  if (len < 0.08) return out.set(0, 0, 0);
  return out.divideScalar(len);
}

// ─────────────────────────────────────────────────────────── gait
// Walking and running are not the same motion played at different rates.
// A walk keeps a nearly straight leg, swings from the hip, stays level and
// lets the arms hang. A run bends the knee hard on the recovery, drives the
// arms with locked elbows, leans the torso in and leaves the ground twice a
// cycle. Everything here is one continuous blend between those two poses on
// `g` (0 = walk, 1 = run), so acceleration reads as a gait change rather
// than as the same animation sped up.
//
// Returned angles are radians on the X axis unless noted. Phase is the
// stride cycle; left and right are half a cycle apart.
const GAIT = {
  // Cadence in cycles per second at a given ground speed. Real gait scales
  // roughly with the square root of speed, not linearly — that is why a
  // linear speed-to-playback-rate mapping always looks like a cartoon.
  cadence: (speed) => 1.05 * Math.sqrt(Math.max(0, speed)) + 0.35,

  // Where in the walk-to-run blend a given speed sits.
  blend: (speed, walkAt, runAt) =>
    clamp((speed - walkAt) / Math.max(0.001, runAt - walkAt), 0, 1),
};

// Hip swing and knee bend for one leg. `ph` is that leg's phase in radians.
function legPose(ph, g) {
  const sw = Math.sin(ph);
  // Stride opens up as the gait tips into a run — but only so far. At ±77
  // degrees of thigh swing both feet leave the ground for most of the cycle
  // and the run reads as bounding, not sprinting. The knee does the work
  // instead; that is what it looks like on a real sprinter too.
  const hip = sw * (0.55 + 0.42*g);
  // The knee is the whole tell. It bends on the recovery half of the cycle
  // (leg travelling forward) and straightens to plant. Walk barely bends;
  // run tucks the heel almost to the backside.
  const recover = Math.max(0, -Math.cos(ph));       // 0..1 over the swing half
  // Positive X rotation swings the segment backward, so a knee that bends the
  // heel toward the backside is POSITIVE. Negative hyperextends it forward,
  // which is a knee bending the wrong way — the pose reads as broken legs.
  const knee = (0.14 + 1.75*g) * recover + 0.06;
  return { hip, knee };
}

// Shoulder and elbow for one arm. Arms are counter-phase to the legs.
function armPose(ph, g) {
  const sw = Math.sin(ph);
  const shoulder = sw * (0.42 + 0.68*g);
  // Elbows straighten in a walk and lock near a right angle in a run, which
  // is most of what separates the two silhouettes from a distance.
  const elbow = -(0.12 + 1.15*g) - Math.max(0, sw) * 0.45 * g;
  return { shoulder, elbow };
}

// Vertical bob, two dips per stride cycle, growing with the gait. Biased
// downward on purpose: a bob that only ever ADDS height lifts the planted
// foot off the floor every step, and the character reads as hovering. The
// body drops through midstance and returns to neutral at the extremes,
// which is also what a real gait does.
function gaitBob(ph, g) {
  return (Math.abs(Math.sin(ph)) - 0.62) * (0.05 + 0.13*g);
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
            size:[0.42,0.72], color:0x8f8a7e },
  heavy:  { name:"Boulder", dmg:265, mass:3.4, knock:2.6, count:2,
            size:[1.00,1.30], color:0x6b6660 },
  plank:  { name:"Plank",   dmg:62,  mass:0.55, knock:2.0, pierce:3, count:3,
            size:[0.55,0.75], color:0x7a5330, shape:"plank", speedMul:1.15 },
  barrel: { name:"Barrel",  dmg:30,  mass:1.2, knock:1.0, count:4,
            size:[0.62,0.62], color:0xc4562e, shape:"barrel",
            explode:{ r:7.5, dmg:190 }, emissive:0x5a1a08 },
  chem:   { name:"Chem",    dmg:24,  mass:1.2, knock:0.8, count:2,
            size:[0.62,0.62], color:0x8ada4e, shape:"barrel",
            puddle:{ r:5.0, dps:70, life:7 }, emissive:0x2f6b18 },
  metal:  { name:"Girder",  dmg:150, mass:1.7, knock:1.6, pierce:2, count:3,
            size:[0.5,0.7], color:0x8c99a8, shape:"plank", speedMul:1.4 },
};

const rockMat = new T.MeshStandardMaterial({ color:0x8f8a7e, roughness:0.86, metalness:0.03,
  normalMap:TEX.rockN, roughnessMap:TEX.rockR,
  normalScale:new T.Vector2(1.4,1.4), envMapIntensity:0.55 });
const heldMat = new T.MeshStandardMaterial({ color:0xc98fb8, roughness:0.42, metalness:0.15,
                                             emissive:0xe94fbf, emissiveIntensity:0.55 });
const seekMat = new T.MeshStandardMaterial({ color:0xffb0a0, roughness:0.34, metalness:0.2,
                                             emissive:0xff5a3c, emissiveIntensity:0.85 });
const matCache = {};
// Props carry the surface of what they are: stone gets rock, timber gets
// bark, and the girder gets metalness so it actually catches the key light
// instead of being a grey box.
const PROP_SURFACE = {
  plank:  { normalMap: TEX.barkN, roughnessMap: TEX.barkR, roughness: 0.9,
            metalness: 0, normalScale: 1.2, env: 0.3 },
  barrel: { normalMap: TEX.clothN, roughness: 0.62, metalness: 0.18,
            normalScale: 0.7, env: 0.9 },
  metal:  { normalMap: TEX.clothN, roughness: 0.46, metalness: 0.7,
            normalScale: 0.7, env: 0.85 },
  stone:  { normalMap: TEX.rockN, roughnessMap: TEX.rockR, roughness: 0.88,
            metalness: 0.03, normalScale: 1.5, env: 0.55 },
};

function matFor(key, def) {
  if (!matCache[key]) {
    const sfc = PROP_SURFACE[key] || PROP_SURFACE[def.shape] || PROP_SURFACE.stone;
    const lo = quality === "low";
    matCache[key] = new T.MeshStandardMaterial({
      color: def.color, roughness: sfc.roughness, metalness: sfc.metalness,
      normalMap: lo ? null : sfc.normalMap, roughnessMap: lo ? null : sfc.roughnessMap,
      normalScale: new T.Vector2(sfc.normalScale, sfc.normalScale),
      envMapIntensity: lo ? 0 : sfc.env,
      emissive: def.emissive || 0x000000, emissiveIntensity: def.emissive ? 0.7 : 0 });
  }
  return matCache[key];
}

const rocks = [];

function geomFor(def, r) {
  if (def.shape === "plank")  return new T.BoxGeometry(r*0.45, r*0.42, r*3.4);
  if (def.shape === "barrel") return new T.CylinderGeometry(r, r, r*2.3, 16);
  // Subdivision 2 with jittered vertices and smooth normals reads as crumpled
  // paper, not stone. One subdivision, gentler jitter, and let the normal map
  // carry the surface instead of the silhouette.
  const geo = new T.IcosahedronGeometry(r, 1);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const s2 = rand(0.9,1.1);
    p.setXYZ(i, p.getX(i)*s2, p.getY(i)*s2, p.getZ(i)*s2);
  }
  geo.computeVertexNormals();
  return geo;
}

// Move a spent or stranded prop back into play near the player. Keeps the
// object count bounded (good for the physics loop) while guaranteeing there
// is always something to pick up.
// Returns a spent prop to the ARENA, not to the player's feet.
//
// This used to drop strays at 7-13 metres — inside grab range — whenever
// fewer than six were reachable, every 1.4 seconds. It was written to fix a
// real softlock (nothing left to throw, game unwinnable) and it
// over-corrected into infinite ammunition permanently underfoot, which is
// the single largest reason the game plays as too easy. Replenishment now
// lands well outside reach: it restocks the ARENA, and the player still has
// to go and get it.
function recycleObject(o) {
  const a = rand(0, Math.PI*2), d = rand(CFG.grabRadius + 5, CFG.arena - 4);
  o.pos.set(hero.pos.x + Math.cos(a)*d, o.r + 6, hero.pos.z + Math.sin(a)*d);
  const lim = CFG.arena - 3;
  const hd = Math.hypot(o.pos.x, o.pos.z);
  if (hd > lim) { o.pos.x *= lim/hd; o.pos.z *= lim/hd; }
  o.vel.set(0, 0, 0);
  o.gone = false; o.held = false; o.pierced = 0; o.seekT = 0; o.seek = null;
  o.fireMode = null; o.volleyId = -1;
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
    fireMode:null, volleyId:-1,
    hostile:0, grabT:0, boostT:0, boostTo:0, launchDir:new T.Vector3(0,0,1),
  });
}

const zSkin  = new T.MeshStandardMaterial({ color:0x7d8f66, roughness:0.93, metalness:0,
  normalMap:TEX.fleshN, normalScale:new T.Vector2(1.2,1.2), envMapIntensity:0.4 });
const zRot   = new T.MeshStandardMaterial({
  color:0x76866a, roughness:0.92, metalness:0,
  normalMap:TEX.fleshN, normalScale:new T.Vector2(1.1,1.1), envMapIntensity:0.4 });
const zRag   = new T.MeshStandardMaterial({
  color:0x55503f, roughness:0.95, metalness:0,
  normalMap:TEX.clothN, normalScale:new T.Vector2(1.6,1.6), envMapIntensity:0.35,
                                            side:T.DoubleSide });
const zEye   = new T.MeshBasicMaterial({ color:0xff6a30 });
const zJaw   = new T.MeshStandardMaterial({ color:0x8a3b32, roughness:0.9 });

// Walkers build their own geometry and some of their own materials on spawn,
// and clearAll only ever removed them from the scene. Over a run that leaked
// every limb of every enemy of every wave — 216 live geometries on wave 1
// climbing past 700 by wave 10. Disposal needs to know which materials are
// shared and must survive.
const SHARED_MATS = new Set([zSkin, zRot, zRag, zJaw]);

function disposeGroup(g) {
  g.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    const m = o.material;
    if (!m) return;
    if (Array.isArray(m)) m.forEach(x => { if (!SHARED_MATS.has(x)) x.dispose(); });
    else if (!SHARED_MATS.has(m)) m.dispose();
  });
}
// Archetypes are a table for the same reason objects are: a new enemy
// should be an entry, not a new branch in the AI loop.
//
//   armor    flat reduction applied BEFORE hp loss; heavy props punch it,
//            light ones bounce off — this is what makes prop choice matter
//   onDeath  "blast" detonates when killed
//   leap     closes distance in bursts instead of a steady walk
const ENEMIES = {
  walker:  { name:"Walker",  code:"WK", hp:100, speed:2.05, scale:1.00, bulk:1.00,
             skin:0x7d8f66, eye:0xff6a30, score:100 },
  runner:  { name:"Runner",  code:"RN", hp:55,  speed:4.70, scale:0.94, bulk:0.80,
             skin:0x93a86a, eye:0xffd23c, score:130 },
  crawler: { name:"Crawler", code:"CR", hp:45,  speed:3.10, scale:0.58, bulk:1.10,
             skin:0x6b7d55, eye:0xff9a30, score:120 },
  tank:    { name:"Tank",    code:"TK", hp:430, speed:1.25, scale:1.42, bulk:1.45,
             skin:0x5f6f4b, eye:0xff3c2a, armor:38, score:400 },
  armored: { name:"Armored", code:"AR", hp:170, speed:1.85, scale:1.10, bulk:1.20,
             skin:0x8d94a0, eye:0xff5a3c, armor:62, score:300 },
  exploder:{ name:"Exploder",code:"EX", hp:70,  speed:2.55, scale:1.05, bulk:1.25,
             skin:0xb06a3c, eye:0xffc23c, onDeath:"blast", score:180 },
  leaper:  { name:"Leaper",  code:"LP", hp:85,  speed:2.30, scale:0.98, bulk:0.88,
             skin:0x6f8f7a, eye:0x6affc0, leap:true, score:200 },
  // A Shield holds a slab in front of it. Anything arriving from the front
  // is absorbed by the slab, so the answer is to go around it, blow it over,
  // or drop something on it from above.
  shield:  { name:"Shield",  code:"SH", hp:150, speed:1.55, scale:1.14, bulk:1.30,
             skin:0x6d7a86, eye:0xffb03c, shield:{ arc:0.55, hp:320 }, score:340 },
  // A Spawner is a timer: leave it alone and the arena fills with crawlers.
  spawner: { name:"Spawner", code:"SP", hp:230, speed:1.10, scale:1.25, bulk:1.50,
             skin:0x7a5f8a, eye:0xc06aff, spawns:{ every:5.2, type:"crawler", cap:6 },
             score:450 },
  // A Warper does what you do. It picks up loose props and throws them back,
  // which turns your own ammunition supply into a hazard.
  warper:  { name:"Warper",  code:"WP", hp:120, speed:1.70, scale:1.06, bulk:0.95,
             skin:0x8a6a9c, eye:0xe94fbf, psy:{ every:4.4, range:22 }, score:380 },
  // Punishes careless positioning: closes and spikes your strain. It does
  // NOT switch telekinesis off — an ability that simply stops working is
  // frustration, not difficulty. It pushes you toward overload, which is
  // visible on the bar and can be backed away from.
  disruptor:{ name:"Disruptor", code:"DS", hp:95, speed:2.35, scale:1.00, bulk:0.9,
             skin:0x4a6a8a, eye:0x4FD6E9,
             disrupt:{ every:3.6, range:11, strain:0.28 }, score:420 },
  // Punishes letting anything reach you: roots the player for a moment.
  // Telegraphed, short, and broken by Dash.
  grabber: { name:"Grabber",  code:"GR", hp:130, speed:2.60, scale:1.08, bulk:1.15,
             skin:0x7a5a4a, eye:0xffb03c,
             grab:{ every:5.5, range:3.2, hold:1.1 }, score:400 },
};

// Waves introduce a mechanic rather than a bigger number. Anything past the
// table repeats the last row with a scaling multiplier.
// Staged, not linear. Each block introduces ONE new idea and then combines
// it with what came before, rather than adding bodies and health.
//
//   1-2   teach: slow bodies, plenty of room, nothing that punishes
//   3-4   speed: runners and leapers — you have to react
//   5-6   combinations: something that resists rocks, plus something fast
//   7-8   resource and position pressure: disruptors, grabbers, spawners
//   9-10  everything at once, and this is where events get dangerous
//   11    the Warden
const WAVES = [
  { walker:5 },
  { walker:5, crawler:2 },
  { walker:4, runner:3 },
  { walker:3, runner:3, leaper:2 },
  { walker:4, runner:2, shield:2 },
  { walker:3, leaper:3, exploder:2, armored:1 },
  { walker:3, runner:3, disruptor:2, spawner:1 },
  { walker:3, grabber:2, shield:2, tank:1 },
  { runner:4, leaper:2, disruptor:2, warper:1, armored:2 },
  { walker:4, grabber:2, shield:2, spawner:2, tank:1, exploder:3 },
  { maw:1, walker:4, runner:3, shield:2 },
];

// The boss is a telekinesis problem, not a health bar: four plates must be
// stripped before the core can be touched, and it fights by throwing the
// same debris the player is using.
const BOSS = {
  name:"Warden", plateHp:230, plates:4, coreHp:1300,
  speed:1.05, reach:3.2, atkEvery:3.6, score:5000,
};

// The wave-11 climax. The Warden is a big humanoid; this is a different
// order of thing — a hulking quadruped that fills the arena's middle and has
// to be fought by moving rather than by out-damaging.
//
// Its whole kit is built out of mechanics the player already knows, so
// nothing about it needs explaining: armour plates like an Armored, a
// telegraphed wind-up like everything else, debris throws like the Warden,
// and a ground slam you beat with the jump button.
const MAW = {
  name:"THE MAW", plateHp:420, plates:6, coreHp:4200,
  speed:1.35, reach:5.4, score:20000,
  slamEvery:  5.0,   // seconds between ground slams
  slamWind:   1.15,  // long tell — this is the attack you must read
  slamR:      17,    // shockwave reach
  hurlEvery:  4.2,
  roarEvery:  11,
  enrageAt:   0.35,  // fraction of core health
};

// Expanding ground shockwaves. A ring you jump over rather than out-run,
// which is why the arena has a jump button at all.
//
// It has to be drawn as a ring lying ON the floor. The first version reused
// shell(), the spherical flash explosions use — at a 17 metre radius that
// sphere swallows the camera and whites out the screen, which is the exact
// opposite of a readable telegraph.
const shocks = [];
const shockGeo = new T.RingGeometry(0.92, 1.0, 56);

function makeShock(pos) {
  const mesh = new T.Mesh(shockGeo, new T.MeshBasicMaterial({
    color: 0xff6a20, transparent: true, opacity: 0.9,
    side: T.DoubleSide, depthWrite: false, blending: T.AdditiveBlending }));
  mesh.rotation.x = -Math.PI/2;
  mesh.position.set(pos.x, 0.12, pos.z);
  scene.add(mesh);
  return { pos: pos.clone(), r: 2, max: MAW.slamR, hit: false, mesh };
}

function killShock(sw) {
  scene.remove(sw.mesh);
  sw.mesh.material.dispose();
}

const walkers = [];

function spawnMaw(x, z) {
  const g = new T.Group();
  // It measured 4.5x the hero's height and still read as a small dark lump
  // at fighting distance — the first hide colour was darker than the Sunken
  // Ruin floor it stands on. Size was never the problem; contrast was.
  const hideM = new T.MeshStandardMaterial({
    color:0x6b5647, roughness:0.9, metalness:0.04,
    normalMap:TEX.fleshN, normalScale:new T.Vector2(1.6,1.6), envMapIntensity:0.6 });
  const plateM = new T.MeshStandardMaterial({
    color:0x8a919c, roughness:0.35, metalness:0.8,
    emissive:0x2a1408, emissiveIntensity:0.6,
    normalMap:TEX.rockN, normalScale:new T.Vector2(0.9,0.9), envMapIntensity:1.3 });
  const coreM = new T.MeshStandardMaterial({ color:0xff5a1a, emissive:0xff5a1a,
                                             emissiveIntensity:1.8, roughness:0.3 });
  const mawM = new T.MeshStandardMaterial({ color:0x8a2a20, roughness:0.65,
                                            emissive:0x6a1408, emissiveIntensity:1.1 });

  // Hunched barrel of a body, low and long rather than tall — it should read
  // as an animal, not another man in armour.
  const body = new T.Group();
  body.position.y = 3.4;
  g.add(body);
  const trunk = part(new T.SphereGeometry(2.9, 18, 14), hideM, 0, 0, 0);
  trunk.scale.set(1.0, 0.82, 1.32);
  body.add(trunk);
  const haunch = part(new T.SphereGeometry(2.3, 14, 12), hideM, 0, -0.35, -2.9);
  haunch.scale.set(1.05, 0.9, 1.0);
  body.add(haunch);

  // Head slung forward on a thick neck, with a jaw that opens when it roars.
  const neck = new T.Group();
  neck.position.set(0, 0.15, 3.1);
  body.add(neck);
  const neckMesh = part(new T.CylinderGeometry(1.05, 1.35, 2.2, 10), hideM, 0, -0.15, 0.8);
  neckMesh.rotation.x = Math.PI/2.35;
  neck.add(neckMesh);
  const head = new T.Group();
  head.position.set(0, -0.55, 2.5);
  neck.add(head);
  const skull = part(new T.SphereGeometry(1.5, 14, 12), hideM, 0, 0, 0);
  skull.scale.set(1.0, 0.86, 1.35);
  head.add(skull);
  const jaw = new T.Group();
  jaw.position.set(0, -0.55, 0.5);
  head.add(jaw);
  const jawMesh = part(new T.ConeGeometry(1.15, 2.2, 8), mawM, 0, -0.2, 0.7);
  jawMesh.rotation.x = -Math.PI/2.1;
  jaw.add(jawMesh);
  // Eyes, high and close together — the only part that reads at distance.
  // Big, hot, and lit. On a dark arena the eyes are the only part of a
  // silhouette that carries at range, so they do the work of announcing it.
  const eyeM = new T.MeshBasicMaterial({ color:0xffd23c });
  head.add(part(new T.SphereGeometry(0.44, 10, 8), eyeM, -0.58, 0.5, 1.0));
  head.add(part(new T.SphereGeometry(0.44, 10, 8), eyeM,  0.58, 0.5, 1.0));
  const eyeLight = new T.PointLight(0xffa030, 3.2, 18, 2);
  eyeLight.position.set(0, 0.5, 1.4);
  head.add(eyeLight);

  // Throat core: the thing you are actually trying to hit, lit so it is
  // obvious, and only reachable once the spine plates are gone.
  const core = part(new T.OctahedronGeometry(1.15, 0), coreM, 0, -0.9, 1.4);
  body.add(core);
  const glow = new T.PointLight(0xff5a1a, 0, 26, 2);
  glow.position.set(0, 2.6, 2.6);
  g.add(glow);

  // Spine plates in a row down the back. Each is its own body with its own
  // health, exactly like the Warden's ring — same rule, new silhouette.
  const plates = [];
  for (let i = 0; i < MAW.plates; i++) {
    const t = i / (MAW.plates - 1);
    const pl = part(new T.BoxGeometry(1.8 - t*0.6, 1.9 - t*0.6, 0.55), plateM,
                    0, 2.55 - t*0.45, 1.8 - t*4.6);
    pl.rotation.x = -0.30 + t*0.16;
    body.add(pl);
    plates.push({ mesh: pl, hp: MAW.plateHp });
  }

  // Four thick legs. Reusing limb() means they inherit the jointed knee and
  // therefore the same gait code as everything else on the field.
  const fL = limb(g, 3.0, hideM, -2.1, 3.6,  1.9, 0.62);
  const fR = limb(g, 3.0, hideM,  2.1, 3.6,  1.9, 0.62);
  const bL = limb(g, 3.2, hideM, -2.2, 3.7, -2.1, 0.7);
  const bR = limb(g, 3.2, hideM,  2.2, 3.7, -2.1, 0.7);

  const tell = new T.Mesh(new T.RingGeometry(3.4, 4.6, 28),
    new T.MeshBasicMaterial({ color:0xff3c2a, transparent:true, opacity:0,
                              side:T.DoubleSide, depthWrite:false }));
  tell.rotation.x = -Math.PI/2;
  tell.position.y = 9.0;
  tell.visible = false;
  g.add(tell);

  g.position.set(x, 0, z);
  scene.add(g);
  walkers.push({ g, body, torso: body, head, jaw,
    aL: fL, aR: fR, lL: bL, lR: bR, pos: g.position,
    type:"maw", boss:true, maw:true, core, glow, plates, platesLeft:MAW.plates,
    E:{ name:"THE MAW", hp:MAW.coreHp, speed:MAW.speed, scale:3.6, skin:0x3a2f28,
        score:MAW.score },
    reach: MAW.reach,
    r:4.2, walk:0, gait:0, spd:0, dead:false, cool:0,
    atkT: MAW.hurlEvery, slamT: MAW.slamEvery, roarT: MAW.roarEvery,
    slamWind: 0, enraged: false,
    AI: AI.tank, arcDir: 1, windup: 0, tell,
    hp:MAW.coreHp, maxHp:MAW.coreHp, flash:0, kb:new T.Vector3(),
    // thrown/tvel are not optional. The movement guard reads `w.thrown <= 0`,
    // and `undefined <= 0` is FALSE — so a boss record without these fields
    // simply never moves. That is how the Warden ended up frozen in place
    // from the moment the guard was added, and nobody noticed because every
    // boss test damaged it directly instead of letting it walk.
    thrown:0, tvel:new T.Vector3(),
    leapT:99, vy:0, air:false });
}

function spawnBoss(x, z) {
  const g = new T.Group();
  const skinM = new T.MeshStandardMaterial({
    color:0x4d5a44, roughness:0.93, metalness:0,
    normalMap:TEX.fleshN, normalScale:new T.Vector2(1.2,1.2), envMapIntensity:0.4 });
  const plateM= new T.MeshStandardMaterial({ color:0x6d7686, roughness:0.42, metalness:0.72,
    normalMap:TEX.rockN, normalScale:new T.Vector2(0.5,0.5), envMapIntensity:1.0 });
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

  // The Warden shares the wind-up path with everything else, so it needs the
  // same tell — scaled to its bulk.
  const bossTell = new T.Mesh(new T.RingGeometry(1.8, 2.5, 22),
    new T.MeshBasicMaterial({ color:0xff3c2a, transparent:true, opacity:0,
                              side:T.DoubleSide, depthWrite:false }));
  bossTell.rotation.x = -Math.PI/2;
  bossTell.position.y = 5.2;
  bossTell.visible = false;
  g.add(bossTell);

  g.position.set(x, 0, z);
  scene.add(g);
  walkers.push({ g, body:g, torso:g, aL, aR, lL, lR, pos:g.position,
    type:"boss", boss:true, core, glow, plates, platesLeft:BOSS.plates,
    E:{ name:"WARDEN", hp:BOSS.coreHp, speed:BOSS.speed, scale:2.1, skin:0x4d5a44,
        score:BOSS.score },
    r:2.0, walk:0, dead:false, cool:0, atkT:BOSS.atkEvery,
    AI: AI.tank, arcDir: 1, windup: 0, tell: bossTell,
    hp:BOSS.coreHp, maxHp:BOSS.coreHp, flash:0, kb:new T.Vector3(),
    // thrown/tvel are not optional. The movement guard reads `w.thrown <= 0`,
    // and `undefined <= 0` is FALSE — so a boss record without these fields
    // simply never moves. That is how the Warden ended up frozen in place
    // from the moment the guard was added, and nobody noticed because every
    // boss test damaged it directly instead of letting it walk.
    thrown:0, tvel:new T.Vector3(),
    leapT:99, vy:0, air:false });
}

function spawnWalker(type, x, z) {
  if (type === "boss") return spawnBoss(x, z);
  if (type === "maw")  return spawnMaw(x, z);
  const E = ENEMIES[type] || ENEMIES.walker;
  const g = new T.Group(), body = new T.Group();
  g.add(body);

  // Hunched forward from the hips — the stoop is what separates a walker
  // from a person at fifty metres, before any detail is legible.
  const torso = new T.Group();
  torso.position.y = 1.02;
  torso.rotation.x = 0.34;
  body.add(torso);

  const skinM = new T.MeshStandardMaterial({
    color:E.skin, roughness:0.93, metalness:0,
    normalMap: quality === "low" ? null : TEX.fleshN,
    normalScale:new T.Vector2(1.2,1.2),
    envMapIntensity: quality === "low" ? 0 : 0.4 });
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
    const upper = len*0.5, lower = len - upper;
    pv.add(part(new T.CapsuleGeometry(rad, upper, 4, 7), skinM, 0, -upper/2-0.04, 0));

    const joint = new T.Group();
    joint.position.y = -upper - 0.05;
    joint.add(part(new T.CapsuleGeometry(rad*0.9, lower, 4, 7), skinM, 0, -lower/2-0.04, 0));
    const hand = part(new T.ConeGeometry(rad*1.7, rad*3.2, 5), skinM, 0, -lower-0.12, 0);
    hand.rotation.x = Math.PI;
    joint.add(hand);
    pv.add(joint);
    pv.joint = joint;

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
  // Beyond the table the horde stops growing and starts getting harder: more
  // elites and a steady health ramp, so wave 40 is a real fight rather than a
  // frame-rate problem.
  const over = Math.max(0, S.wave - (WAVES.length + 4));
  // A named variant arriving as an ELITE ARRIVAL event takes precedence over
  // the generic roll.
  const named = pendingElite && pendingElite.base === type ? pendingElite : null;
  // The curve introduces elites in the 9-10 block. Before that they are the
  // named-variant event only, so the first one the player meets is announced
  // rather than wandering in unremarked.
  const elite = !!named ||
                (S.wave >= 7 && Math.random() < Math.min(0.6, (0.10 + over*0.02) * DIFF.elite));
  let EE = named
    ? Object.assign({}, E, named.mod(E), { scale:E.scale*1.22, score:E.score*5,
                                           name:named.name, code:E.code+"!" })
    : elite
    ? Object.assign({}, E, { hp:Math.round(E.hp*2.1), scale:E.scale*1.28,
                             armor:(E.armor||0)+18, score:E.score*3,
                             name:"Elite "+E.name })
    : E;
  if (named) EE.hp = Math.round(EE.hp);
  if (over > 0) {
    EE = Object.assign({}, EE, {
      hp: Math.round(EE.hp * (1 + over*0.12)),
      armor: (EE.armor||0) + over*3,
      score: Math.round(EE.score * (1 + over*0.1)),
    });
  }
  // Compounding per-wave strength. Survivability rather than damage: contact
  // damage is a flat one heart, so scaling that would jump straight from
  // survivable to lethal, and scaling speed changes how a wave FEELS rather
  // than how tough it is.
  const grit = Math.pow(1 + CFG.waveStrength, Math.max(0, S.wave - 1));
  if (grit !== 1) {
    EE = Object.assign({}, EE, {
      hp: Math.round(EE.hp * grit),
      armor: Math.round((EE.armor||0) * grit),
    });
  }
  // The wave modifier is the last word on the statline, applied on top of the
  // archetype and any elite promotion.
  if (WMOD.hp !== 1 || WMOD.speed !== 1 || WMOD.armor || DIFF.speed !== 1) {
    EE = Object.assign({}, EE, {
      hp: Math.max(1, Math.round(EE.hp * WMOD.hp)),
      speed: EE.speed * WMOD.speed * DIFF.speed,
      armor: (EE.armor||0) + WMOD.armor,
    });
  }

  // Each new archetype needs a silhouette, not just a statline — you have to
  // be able to tell what is walking at you before it reaches you.
  let slab = null;
  if (EE.shield) {
    slab = new T.Mesh(new T.BoxGeometry(1.5, 1.7, 0.22),
      new T.MeshStandardMaterial({ color:0x9aa3ad, roughness:0.45, metalness:0.6,
        normalMap:TEX.rockN, normalScale:new T.Vector2(0.6,0.6), envMapIntensity:0.9 }));
    slab.position.set(0, 1.15, 0.72);
    slab.castShadow = true;
    body.add(slab);
  }
  if (EE.spawns) {
    // A lit spine: the thing on it is what keeps producing crawlers.
    const spine = new T.Mesh(new T.ConeGeometry(0.34, 1.5, 6),
      new T.MeshStandardMaterial({ color:0xc06aff, emissive:0xc06aff,
                                   emissiveIntensity:1.2, flatShading:true }));
    spine.position.set(0, 2.15, -0.1);
    body.add(spine);
  }
  if (EE.psy) {
    const halo = new T.Mesh(new T.TorusGeometry(0.62, 0.07, 6, 16),
      new T.MeshStandardMaterial({ color:0xe94fbf, emissive:0xe94fbf,
                                   emissiveIntensity:1.4, flatShading:true }));
    halo.rotation.x = Math.PI/2;
    halo.position.y = 2.4;
    body.add(halo);
  }

  g.position.set(x,0,z);
  g.scale.setScalar(EE.scale * rand(0.94, 1.06));
  if (elite) {
    const ring2 = new T.Mesh(new T.RingGeometry(0.9, 1.12, 20),
      new T.MeshBasicMaterial({ color:0xffd23c, transparent:true, opacity:0.55,
                                side:T.DoubleSide, depthWrite:false }));
    ring2.rotation.x = -Math.PI/2; ring2.position.y = 0.06;
    g.add(ring2);
  }
  // Attack tell: a ring that flares over the body while it winds up. On a
  // dark ground the wind-up POSE alone is not readable at range, and a
  // telegraph you cannot see is not a telegraph.
  const tell = new T.Mesh(new T.RingGeometry(0.75, 1.05, 18),
    new T.MeshBasicMaterial({ color:0xff3c2a, transparent:true, opacity:0,
                              side:T.DoubleSide, depthWrite:false }));
  tell.rotation.x = -Math.PI/2;
  tell.position.y = 2.5;
  tell.visible = false;
  g.add(tell);

  // Without this the enemy exists, walks, damages and dies — entirely
  // invisibly. Dropped when the elite block was inserted; every test since
  // asserted on counts rather than on anything being on screen, so all of
  // them passed against a game with no visible enemies.
  scene.add(g);
  walkers.push({ g, body, torso, aL, aR, lL, lR, pos:g.position, elite,
                 type, E:EE, r:0.75*EE.scale,
                 AI: AI[type] || AI_DEFAULT,
                 arcDir: Math.random() < 0.5 ? -1 : 1,
                 windup: 0, tell,
                 walk:rand(0,6), gait:0, spd:0, dead:false, cool:0,
                 hp:EE.hp, maxHp:EE.hp, flash:0, kb:new T.Vector3(),
                 leapT:rand(1,3), vy:0, air:false,
                 slab, slabHp: EE.shield ? EE.shield.hp : 0,
                 spawnT: EE.spawns ? rand(2.5, EE.spawns.every) : 0,
                 psyT: EE.psy ? rand(2, EE.psy.every) : 0, brood:0,
                 thrown:0, tvel:new T.Vector3() });
}

// ─────────────────────────────────────────────────────────── upgrades
// Every upgrade writes into MOD, and the gameplay code reads MOD. Nothing
// here special-cases an upgrade by name, so adding one is a table entry.
const MOD = {
  singleDmg: 1, burstDmg: 1, allDmg: 1,
  maxHeld: 0, grabR: 0, focusRegen: 1, hpBonus: 0,
  berserk: false, gravity: false, voidwell: false,
  blastDmg: 1, arcHops: 3,
  singularity: false, marksman: false, secondWind: false, avalanche: false,
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
    desc:"Kinetic strain clears 55% faster.",
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

// ── synergies
// Upgrades are additive on their own. Pairs of them are not: taking the
// second half of a pair unlocks a named effect neither one grants alone.
// This is what turns a draft into a build — the third pick starts being
// chosen for what it completes rather than for what it does.
const SYNERGIES = [
  { id:"singularity", name:"Singularity", need:["gravity","voidwell"],
    desc:"Kills collapse into a well that pulls hard and tears.",
    take(){ MOD.singularity = true; } },
  { id:"chainstorm",  name:"Chain Storm",  need:["storm","swarm"],
    desc:"Lightning arcs every other kill, and reaches five bodies.",
    take(){ MOD.lightning = 2; MOD.arcHops = 5; } },
  { id:"demolition",  name:"Demolition",   need:["ordnance","berserk"],
    desc:"Every explosion hits 60% harder.",
    take(){ MOD.blastDmg *= 1.6; } },
  { id:"marksman",    name:"Marksman",     need:["kinetic","reach"],
    desc:"The weak point is twice the size on an aimed shot.",
    take(){ MOD.marksman = true; } },
  { id:"secondwind",  name:"Second Wind",  need:["flow","hardened"],
    desc:"Dropping to your last two hearts refills focus. Once per wave.",
    take(){ MOD.secondWind = true; } },
  { id:"avalanche",   name:"Avalanche",    need:["heft","swarm"],
    desc:"Two stones landing together are enough for a kinetic wave, and it is wider.",
    take(){ MOD.avalanche = true; } },
];

function synergyGained(u) {
  // Which synergy, if any, this pick just completed.
  return SYNERGIES.find(sy => !sy.got && sy.need.includes(u.id) &&
                              sy.need.every(n => n === u.id || taken.includes(n)));
}

// Named on the card before you commit: a pick that completes something says so.
function synergyHint(u) {
  const sy = synergyGained(u);
  return sy ? '<u class="syn">completes ' + sy.name + '</u>' : '';
}

function applySynergies(u) {
  const sy = synergyGained(u);
  if (!sy) return;
  sy.got = true;
  sy.take();
  setTimeout(() => { banner(sy.name.toUpperCase()); toast(sy.name + " — " + sy.desc, 3000);
                     SFX.rankUp(4); }, 260);
}

function offerDraft() {
  S.phase = "draft";
  // Three distinct picks, drawn without replacement.
  const pool = UPGRADES.filter(u => !taken.includes(u.id));
  if (pool.length < 3) pool.push(...UPGRADES.filter(u => taken.includes(u.id)));
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
    b.innerHTML = '<span class="ut">' + u.tag + '</span><b>' + u.name + '</b><i>' + u.desc + '</i>'
                + synergyHint(u);
    b.onclick = () => { u.take(); applySynergies(u); taken.push(u.id);
                        SFX.pick(); startNextWave(); };
    box.appendChild(b);
  });
  el("modName2").classList.remove("show");
  el("bossBar").classList.remove("show");
  el("overlay").classList.remove("hide");
  ["hud","touch","cross"].forEach(i => el(i).classList.add("hide"));
}

// ─────────────────────────────────────────────────────────── persistence
// A run is disposable; the record of it is not. Everything here is
// best-effort: private-mode browsers and file:// origins can both refuse
// localStorage outright, and the game has to keep working when they do.
const SAVE_KEY = "kinesis.v1";
const PROFILE = {
  best: 0, bestWave: 1, runs: 0, kills: 0,
  bestRank: "D", seen: {},        // modifier ids the player has met
};

function loadProfile() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p && typeof p === "object") {
      for (const k in PROFILE) if (k in p) PROFILE[k] = p[k];
    }
  } catch (e) { /* storage unavailable or corrupt — start clean */ }
}

function saveProfile() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(PROFILE)); }
  catch (e) { /* nothing to do; the run still counts in this session */ }
}

// Returns what actually improved, so the end screen can call it out.
function recordRun() {
  const beat = { score:false, wave:false, rank:false };
  PROFILE.runs++;
  PROFILE.kills += S.kills;
  if (S.score > PROFILE.best)      { PROFILE.best = S.score; beat.score = true; }
  if (S.wave  > PROFILE.bestWave)  { PROFILE.bestWave = S.wave; beat.wave = true; }
  const ri = RANKS.findIndex(r => r.name === S.rank);
  const bi = RANKS.findIndex(r => r.name === PROFILE.bestRank);
  if (ri > bi) { PROFILE.bestRank = S.rank; beat.rank = true; }
  saveProfile();
  return beat;
}

// ─────────────────────────────────────────────────────────── wave modifiers
// From wave 3 on, each wave draws a condition. They are deliberately
// double-edged: every one of them makes the wave harder in one direction and
// hands you something back in another, so the right play changes wave to
// wave rather than the difficulty just ratcheting.
const MODIFIERS = [
  { id:"frenzy",   name:"FRENZY",      desc:"They are faster. They are also brittle.",
    apply(){ WMOD.speed = 1.4; WMOD.hp = 0.75; } },
  { id:"armored",  name:"IRON TIDE",   desc:"Everything is plated. Blasts ignore plate.",
    apply(){ WMOD.armor = 26; WMOD.blastPierce = true; } },
  { id:"horde",    name:"HORDE",       desc:"Half again as many, at three-quarter health.",
    apply(){ WMOD.count = 1.5; WMOD.hp = 0.75; } },
  { id:"volatile", name:"VOLATILE",    desc:"Twice the barrels. Everything explodes bigger.",
    apply(){ WMOD.props = { barrel:2.5, chem:2 }; WMOD.blastR = 1.35; } },
  { id:"scarcity", name:"SCARCITY",    desc:"Little to throw. Strain clears twice as fast.",
    apply(){ WMOD.propsAll = 0.5; WMOD.focus = 2; } },
  { id:"heavy",    name:"DEAD WEIGHT", desc:"Only the heavy props spawned. They hit harder.",
    apply(){ WMOD.props = { rock:0.35, plank:0.3, heavy:2.4, metal:2.2 }; WMOD.dmg = 1.25; } },
  { id:"glass",    name:"GLASS",       desc:"One hit kills you. Style builds twice as fast.",
    apply(){ WMOD.oneHp = true; WMOD.style = 2; } },
];

// Reset to the identity every wave; a modifier is a diff on top of this.
const WMOD_BASE = { speed:1, hp:1, armor:0, count:1, props:null, propsAll:1,
                    focus:1, dmg:1, blastR:1, blastPierce:false, oneHp:false,
                    style:1, name:null, desc:null };
const WMOD = Object.assign({}, WMOD_BASE);

function rollModifier(n) {
  Object.assign(WMOD, WMOD_BASE);
  WMOD.props = null;
  if (n < 3) return;                       // the first two waves teach, plainly
  const pool = MODIFIERS.filter(m => {
    // Glass is a run-ender if it lands while you are already on one heart.
    if (m.id === "glass" && hero.hp <= 2) return false;
    // It is also a run-ender at wave 3, where the curve is still teaching
    // that fast enemies exist. Measured idle survival at waves 5-10 came out
    // at one second flat, which was GLASS rolling early, not the difficulty
    // curve doing its job.
    if (m.id === "glass" && n < 7) return false;
    // Iron Tide before there is anything heavy to answer it with is just a
    // damage wall.
    if (m.id === "armored" && n < 5) return false;
    return true;
  });
  const m = pool[Math.floor(Math.random()*pool.length)];
  WMOD.name = m.name; WMOD.desc = m.desc;
  PROFILE.seen[m.id] = true; saveProfile();
  m.apply();
}

// ─────────────────────────────────────────────────────────── spawning
// Every enemy used to arrive at wave start, evenly around one circle. That
// makes a wave a single problem you solve once and then mop up. Bodies now
// arrive in pulses from chosen bearings, so a wave is a sequence of
// situations and the safe side of the arena keeps moving.
//
// Two hard rules, from the anti-frustration list: nothing spawns closer than
// SPAWN_MIN, and nothing spawns inside the arc the player is currently
// looking at unless there is nowhere else — you get told about a threat
// before it can touch you.
const SPAWN_MIN = 19;
const SECTORS = 8;

const spawnQ = [];              // { type, at } — pending reinforcements
let recentSector = -1;

// Pick a bearing to send bodies from: prefer sectors that are currently
// empty, so pressure arrives where the player is NOT looking, but never the
// same sector twice running.
function pickSector(avoidFacing) {
  const load = new Array(SECTORS).fill(0);
  for (const w of walkers) {
    if (w.dead) continue;
    const b = Math.atan2(w.pos.x - hero.pos.x, w.pos.z - hero.pos.z);
    load[Math.floor(((b + Math.PI) / (Math.PI*2)) * SECTORS) % SECTORS]++;
  }
  const facing = Math.floor(((cam.yaw % (Math.PI*2) + Math.PI*2) % (Math.PI*2))
                            / (Math.PI*2) * SECTORS) % SECTORS;
  let best = -1, bestScore = -Infinity;
  for (let i = 0; i < SECTORS; i++) {
    if (i === recentSector) continue;
    // Emptier is better. Behind the player is better, but never so much that
    // everything arrives from behind.
    let score = -load[i] * 2 + Math.random()*0.8;
    const away = Math.min(Math.abs(i - facing), SECTORS - Math.abs(i - facing));
    if (avoidFacing) score += away * 0.5;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  recentSector = best;
  return (best / SECTORS) * Math.PI*2 - Math.PI;
}

// Where a body actually appears: on the chosen bearing, outside SPAWN_MIN of
// the player and inside the arena.
function spawnAt(type, bearing, jitter) {
  const a = bearing + rand(-jitter, jitter);
  const sx = Math.sin(a), sz = Math.cos(a);
  let d = Math.max(SPAWN_MIN, CFG.arena - rand(1, 6));
  // Keep it in the arena even when the player is standing near the rim.
  for (let i = 0; i < 6; i++) {
    const x = hero.pos.x + sx*d, z = hero.pos.z + sz*d;
    if (Math.hypot(x, z) < CFG.arena - 1) { spawnWalker(type, x, z); return true; }
    d -= 3;
    if (d < SPAWN_MIN) break;
  }
  // Fell off the arena on that bearing: put it on the rim instead, still at
  // a readable distance if we possibly can.
  const rim = CFG.arena - 2;
  const x = Math.cos(a)*rim, z = Math.sin(a)*rim;
  if (Math.hypot(x - hero.pos.x, z - hero.pos.z) > 10) { spawnWalker(type, x, z); return true; }
  return false;
}

const SECTOR_NAME = (bearing) => {
  // Named relative to where the player is looking, which is the only frame
  // of reference that means anything to them.
  let d = bearing - cam.yaw;
  while (d >  Math.PI) d -= Math.PI*2;
  while (d < -Math.PI) d += Math.PI*2;
  const a = Math.abs(d);
  if (a < Math.PI*0.25) return "AHEAD";
  if (a > Math.PI*0.75) return "BEHIND YOU";
  return d > 0 ? "ON YOUR RIGHT" : "ON YOUR LEFT";
};

// Send a group in from one bearing, announced.
function reinforce(types, label) {
  const bearing = pickSector(true);
  let n = 0;
  for (const t of types) if (spawnAt(t, bearing, 0.35)) n++;
  if (!n) return 0;
  banner((label || "REINFORCEMENTS") + " · " + SECTOR_NAME(bearing));
  SFX.arena();
  updateHUD();
  return n;
}

// ─────────────────────────────────────────────────────────── difficulty
// Not an HP slider. Each mode moves the variables the brief names —
// aggression, composition, object availability, elite frequency, event
// frequency — and Nightmare rewards mastery by making the same toolkit
// carry more weight, not by inflating enemy health.
const DIFFS = {
  normal: { name:"NORMAL", desc:"Balanced.",
            speed:1.00, stock:1.00, elite:1.00, events:1.00, eventGap:1.00,
            strain:1.00, hp:1.00 },
  hard:   { name:"HARD",   desc:"Faster, hungrier, less to throw.",
            speed:1.15, stock:0.72, elite:1.7,  events:1.4,  eventGap:0.75,
            strain:1.2,  hp:1.0 },
  night:  { name:"NIGHTMARE", desc:"Elite-heavy. Little to throw. Strain bites.",
            speed:1.28, stock:0.52, elite:2.6,  events:1.9,  eventGap:0.55,
            strain:1.45, hp:1.0 },
};
let DIFF = DIFFS.normal;

function setDifficulty(key) {
  DIFF = DIFFS[key] || DIFFS.normal;
  try { localStorage.setItem("kinesis.diff", key); } catch (e) {}
  const d = el("diffName");
  if (d) d.textContent = DIFF.name;
}

// ─────────────────────────────────────────────────────────── elites
// The generic elite promotion (more health, bigger, worth more) makes a
// tougher body but not a different problem. These are named variants that
// each force a specific answer, and they arrive as an announced event.
const ELITES = [
  { id:"frenzied", name:"Frenzied Runner", base:"runner",
    mod: E => ({ speed: E.speed*1.5, hp: E.hp*2.2, skin:0xffd23c, eye:0xff3c2a }) },
  { id:"bulwark",  name:"Armored Tank",    base:"tank",
    mod: E => ({ hp: E.hp*1.6, armor:(E.armor||0)+30, skin:0x9aa3ad }) },
  { id:"void",     name:"Void Disruptor",  base:"disruptor",
    mod: E => ({ hp: E.hp*2.4, disrupt:{ every:2.6, range:15, strain:0.34 },
                 skin:0x2a4a8a, eye:0x9fe8ff }) },
  { id:"telekin",  name:"Telekinetic Elite", base:"warper",
    mod: E => ({ hp: E.hp*2.2, psy:{ every:2.8, range:26 }, skin:0xc06aff }) },
  { id:"volatile", name:"Explosive Elite", base:"exploder",
    mod: E => ({ hp: E.hp*3.0, onDeath:"blast", skin:0xff5a3c, eye:0xffd23c }) },
];

// ─────────────────────────────────────────────────────────── pressure events
// Wave modifiers are conditions that hold for a whole wave. These are
// MOMENTS inside one — a spike that arrives, resolves, and leaves. Each is
// telegraphed before it lands, because an event you cannot see coming is
// just damage.
const EVENTS = [
  { id:"horde", name:"HORDE INCOMING", warn:"A crowd is massing",
    at: n => n >= 4,
    fire() {
      const pool = ["walker","runner","crawler","runner","walker"];
      reinforce(pool.slice(0, 4 + Math.floor(Math.random()*3)), "HORDE");
    } },
  { id:"elite", name:"ELITE ARRIVAL", warn:"Something bigger is coming",
    at: n => n >= 5,
    fire() {
      const kind = ELITES[Math.floor(Math.random()*ELITES.length)];
      pendingElite = kind;
      reinforce([kind.base], kind.name.toUpperCase());
      pendingElite = null;
    } },
  { id:"scarce", name:"OBJECT SCARCITY", warn:"The ground is emptying",
    at: n => n >= 6,
    fire() {
      // Removes half of what is lying around, briefly. Never all of it —
      // the anti-frustration list rules that out explicitly.
      const live = rocks.filter(o => !o.gone && !o.held);
      const take = Math.floor(live.length * 0.5);
      for (let i = 0; i < take; i++) {
        const o = live[Math.floor(Math.random()*live.length)];
        if (o && !o.gone) { o.gone = true; o.mesh.visible = false; }
      }
      toast("Objects are scarce — they will return", 2600);
    } },
  { id:"surge", name:"KINETIC SURGE", warn:"Kinetic pressure building",
    at: n => n >= 3,
    fire() {
      // The risk/reward zone from the brief: a patch of ground that clears
      // strain fast and charges the kinetic meter, and pulls the horde to it.
      spawnZone();
    } },
  { id:"flank", name:"REINFORCEMENTS", warn:"Movement behind you",
    at: n => n >= 3,
    fire() { reinforce(["runner","runner","leaper"], "FLANKED"); } },
];

let eventT = 0, pendingEvent = null, pendingElite = null;

function scheduleEvent(n) {
  const pool = EVENTS.filter(e => e.at(n));
  if (!pool.length) { eventT = 1e9; return; }
  pendingEvent = pool[Math.floor(Math.random()*pool.length)];
  eventT = rand(11, 17) * DIFF.eventGap;
}

function tickEvents(dt, n) {
  if (!pendingEvent) return;
  eventT -= dt;
  // Two-stage: warn, then fire two seconds later.
  if (eventT <= 2 && !pendingEvent.warned) {
    pendingEvent.warned = true;
    banner(pendingEvent.name);
    toast(pendingEvent.warn, 2200);
    SFX.warn();
  }
  if (eventT <= 0) {
    const e = pendingEvent;
    pendingEvent = null;
    e.warned = false;
    e.fire();
    // Another one later in the wave, if it runs long.
    if (Math.random() < Math.min(0.92, 0.6 * DIFF.events)) scheduleEvent(n);
  }
}

// ── kinetic zones (brief §11)
// Stand in it and strain clears fast and the kinetic meter fills; but it
// drags the horde toward you, so the reward is paid for in exposure.
const zones = [];
function spawnZone() {
  const a = rand(0, Math.PI*2), d = rand(6, CFG.arena*0.6);
  const pos = new T.Vector3(Math.cos(a)*d, 0, Math.sin(a)*d);
  const mesh = new T.Mesh(new T.RingGeometry(CFG.zoneR*0.82, CFG.zoneR, 36),
    new T.MeshBasicMaterial({ color:0x4FD6E9, transparent:true, opacity:0.5,
                              side:T.DoubleSide, depthWrite:false }));
  mesh.rotation.x = -Math.PI/2;
  mesh.position.copy(pos); mesh.position.y = 0.05;
  scene.add(mesh);
  const disc = new T.Mesh(new T.CircleGeometry(CFG.zoneR, 36),
    new T.MeshBasicMaterial({ color:0x4FD6E9, transparent:true, opacity:0.10,
                              side:T.DoubleSide, depthWrite:false }));
  disc.rotation.x = -Math.PI/2;
  disc.position.copy(pos); disc.position.y = 0.04;
  scene.add(disc);
  zones.push({ pos, mesh, disc, life: CFG.zoneTime });
  toast("Kinetic surge — stand in it to vent strain, but they will come", 3000);
}

function clearZones() {
  zones.forEach(z => { scene.remove(z.mesh); scene.remove(z.disc);
                       z.mesh.geometry.dispose(); z.disc.geometry.dispose(); });
  zones.length = 0;
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
  crit:   () => { tone(1500, 0.10, "square", 0.2, 2400);
                  setTimeout(()=>tone(2100, 0.16, "triangle", 0.16, 2900), 55); },
  kill:   () => { noise(0.22, 0.26, 700, 120); tone(70, 0.2, "sine", 0.16, 34); },
  boom:   () => { noise(0.62, 0.5, 2400, 90); tone(58, 0.5, "sine", 0.3, 24);
                  tone(140, 0.28, "square", 0.14, 40); },
  hurt:   () => { tone(230, 0.26, "sawtooth", 0.22, 70); noise(0.16, 0.14, 500, 150); },
  combo:  (n) => tone(520 + Math.min(n,8)*90, 0.14, "triangle", 0.18, 780 + n*70),
  pick:   () => tone(760, 0.1, "triangle", 0.16, 1150),
  wave:   () => { tone(300, 0.5, "sine", 0.2, 620); setTimeout(()=>tone(460,0.45,"sine",0.16,760), 130); },
  // Arrival: a low swell, deliberately unlike the wave chime.
  arena:  () => { tone(90, 1.5, "sine", 0.28, 210);
                  tone(135, 1.3, "triangle", 0.14, 320);
                  noise(1.1, 0.16, 900, 2600); },
  // Rank-up climbs with the rank so S reads as bigger news than C.
  rankUp: (i) => { const f = 440 * Math.pow(1.16, i);
                   tone(f, 0.16, "triangle", 0.2, f*1.5);
                   setTimeout(()=>tone(f*1.5, 0.24, "triangle", 0.16, f*2), 90); },
  rankDown: () => { tone(300, 0.3, "sawtooth", 0.12, 150); },
  // The wind-up needs an audio tell too — the attacker is often off-screen.
  tell:   () => { tone(210, 0.16, "square", 0.10, 150); },
  whiff:  () => { noise(0.14, 0.10, 900, 300); },
  dry:    () => { tone(180, 0.18, "square", 0.10, 90); },
  overload: () => { tone(70, 0.9, "sawtooth", 0.3, 40); noise(0.7, 0.24, 400, 90); },
  disrupt: () => { tone(300, 0.3, "sawtooth", 0.18, 90); noise(0.25, 0.14, 2200, 400); },
  warn:   () => { tone(160, 0.5, "square", 0.16, 240);
                  setTimeout(()=>tone(160, 0.5, "square", 0.16, 240), 260); },
  grabbed: () => { tone(110, 0.4, "square", 0.22, 55); noise(0.3, 0.18, 600, 150); },
  overdrive: () => { tone(120, 0.75, "sawtooth", 0.26, 460);
                     tone(240, 0.7, "square", 0.14, 700);
                     noise(0.5, 0.3, 3000, 300); },
  odEnd:  () => { tone(420, 0.4, "sine", 0.16, 130); },
};

// ─────────────────────────────────────────────────────────── combat
// Damage scales with how hard the thing was actually travelling, so a
// lobbed boulder and a hurled one are not the same hit.
const MIN_HIT_SPEED = 9;

const puddles = [];
const blastQ  = [];            // explosions wait here; see MAX_BLASTS
const MAX_BLASTS = 5;          // per frame, so a barrel farm cannot stall a phone

// ── style
// The combo counts kills. Style rates HOW you killed: repeating one trick
// pays less each time, and switching tricks pays a bonus. That is the whole
// pressure — the scoring system asks you to use the toolkit, not the best
// tool. Score multiplier comes off the rank, so style is not cosmetic.
const KILL_KINDS = {
  impact:  { label:"IMPACT",      style:10 },
  blast:   { label:"DETONATION",  style:16 },
  pierce:  { label:"SKEWERED",    style:18 },
  env:     { label:"ENVIRONMENTAL", style:24 },
  crush:   { label:"CRUSHED",     style:20 },
  chem:    { label:"DISSOLVED",   style:14 },
  repulse: { label:"SHOCKWAVE",   style:14 },
  arc:     { label:"ARC",         style:16 },
  weak:    { label:"WEAK POINT",  style:20 },
  crit:    { label:"CRITICAL",    style:30 },
};
const RANKS = [
  { at:0,   name:"D",  mult:1.0,  color:"#7E7894" },
  { at:60,  name:"C",  mult:1.25, color:"#8FA8C4" },
  { at:140, name:"B",  mult:1.5,  color:"#69D0B4" },
  { at:240, name:"A",  mult:2.0,  color:"#E8C24F" },
  { at:370, name:"S",  mult:2.6,  color:"#E94FBF" },
  { at:520, name:"SS", mult:3.4,  color:"#FF5A3C" },
];
const STYLE_MAX = RANKS[RANKS.length-1].at + 160;

function rankFor(style) {
  let r = RANKS[0];
  for (const c of RANKS) if (style >= c.at) r = c;
  return r;
}

function addStyle(kind) {
  const k = KILL_KINDS[kind] || KILL_KINDS.impact;
  // Repeats decay geometrically and recover over time, so a player who only
  // ever throws rocks settles at a low ceiling rather than being locked out.
  const reps = S.recent.filter(x => x === kind).length;
  const fresh = reps === 0;
  const gain = k.style * Math.pow(0.62, reps) * (fresh ? 1.5 : 1);
  S.style = Math.min(STYLE_MAX, S.style + gain * WMOD.style);
  S.styleT = CFG.styleGrace;
  S.recent.unshift(kind);
  if (S.recent.length > 5) S.recent.pop();

  const r = rankFor(S.style);
  if (r.name !== S.rank) {
    const up = RANKS.indexOf(r) > RANKS.findIndex(x => x.name === S.rank);
    S.rank = r.name;
    if (up) { banner("RANK " + r.name); SFX.rankUp(RANKS.indexOf(r)); }
  }
  return { label: k.label, fresh };
}

// ── kinetic meter / Overdrive
const OD = { on:false, t:0 };

function addKinetic(v) {
  if (OD.on) return;                       // no charging while it is spending
  S.kinetic = Math.min(1, S.kinetic + v);
  if (S.kinetic >= 1) startOverdrive();
}

function startOverdrive() {
  OD.on = true; OD.t = CFG.odTime;
  S.kinetic = 1;
  S.freeze = Math.max(S.freeze, 0.22);
  banner("OVERDRIVE");
  toast("Overdrive — free focus, wider reach, heavier hits", 2200);
  SFX.overdrive();
  S.shake = Math.min(1, S.shake + 0.5);
  document.body.classList.add("od");
}

function endOverdrive() {
  OD.on = false; OD.t = 0; S.kinetic = 0;
  document.body.classList.remove("od");
  SFX.odEnd();
}

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
  // Free it here rather than at the end of the wave. The record stays in the
  // array (guided stones still hold references to their marks) but its
  // geometry and its own materials are done with the moment it comes off
  // screen — and a long wave with a Spawner in it kills enough bodies to
  // matter. w.pos aliases w.g.position, which survives disposal.
  disposeGroup(w.g);
  w.disposed = true;
  burst(w.pos, w.E.skin);
  // An Exploder is a delivery mechanism: killing one near a crowd is the
  // point, and killing one next to a barrel is better.
  if (w.E.onDeath === "blast") queueBlast(w.pos, { r:6.5, dmg:150 }, null);
  S.kills++;
  const st = addStyle(w.lastHit || "impact");
  if (st.fresh && S.combo >= 1) banner(st.label);
  S.score += Math.round((w.E.score || 100) * Math.max(1, S.combo) * rankFor(S.style).mult);
  if (MOD.voidwell) {
    pullToward(w.pos, MOD.singularity ? 11 : 8, MOD.singularity ? 26 : 16);
    if (MOD.singularity) { queueBlast(w.pos, { r:5.5, dmg:90 }, null);
                           shell(w.pos, 5.5, 0x9B6BFF); }
  }
  if (MOD.lightning && S.kills % MOD.lightning === 0) arcLightning(w.pos);
  S.shake = Math.min(0.9, S.shake + 0.35);
  S.freeze = Math.max(S.freeze, 0.045);
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
  damageWalker(other, dmg, null, 0, "env");
  damageWalker(w, dmg * 0.6, null, 0, "env");
  sparks(w.pos, 0x8a5a4a, 8, 14);
  SFX.impact(2.2, 1.2);
  S.shake = Math.min(0.9, S.shake + 0.2);
  S.freeze = Math.max(S.freeze, 0.12);
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
  for (let n = 0; n < MOD.arcHops; n++) {
    let best = null, bd = 16;
    for (const w of walkers) {
      if (w.dead || hit.includes(w)) continue;
      const d = Math.hypot(w.pos.x-src.x, w.pos.z-src.z);
      if (d < bd) { bd = d; best = w; }
    }
    if (!best) break;
    hit.push(best);
    bolt(src, best.pos);
    damageWalker(best, 95, null, 0, "arc");
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
// Aura pool. A shell around every object currently under control, so the
// telekinesis reads on the OBJECTS and not only on the character. Pooled
// rather than parented per prop: there are up to ~170 props in an arena and
// at most a dozen under control at once, so a dozen meshes is the honest
// number.
//
// Additive blending, so it adds light rather than tinting — and it feeds the
// bloom pass on the high quality tier, which is what turns it from a
// coloured shell into a glow.
const auraGeo = new T.SphereGeometry(1, 14, 10);
const auras = [];
// Carry caps at 7, or 10 with Swarm. A full volley of 10 can be in flight
// while the next 10 are already gathered, plus whatever a Warper has thrown
// back — so 14 was not enough and the overflow would silently go unlit.
for (let i = 0; i < 24; i++) {
  const m = new T.Mesh(auraGeo, new T.MeshBasicMaterial({
    color: 0xe94fbf, transparent: true, opacity: 0,
    blending: T.AdditiveBlending, depthWrite: false, side: T.BackSide }));
  m.visible = false;
  m.frustumCulled = false;
  scene.add(m);
  auras.push(m);
}

// Colours by what kind of control the object is under, so the aura carries
// information rather than just decoration.
const AURA_HELD   = new T.Color(0xe94fbf);   // in your carry
const AURA_SEEK   = new T.Color(0xffb060);   // launched and guiding
const AURA_HOSTILE= new T.Color(0xff3020);   // thrown back at you

function updateAuras() {
  let i = 0;
  const claim = (o, col, base, pulseHz) => {
    if (i >= auras.length) return;
    const m = auras[i++];
    m.visible = true;
    m.position.copy(o.pos);
    // Follows the prop's own scale, which the zoom shrinks when held, so the
    // aura never becomes the thing filling the screen.
    // Just over the prop's own size. The shell is BackSide, so the prop —
    // which writes depth — hides everything except the sliver that peeks out
    // around its silhouette. That sliver is the glow. At 1.85 the whole far
    // hemisphere showed and each one read as a filled bubble instead, and
    // seven of them merged into a single pink mass.
    const s = o.r * o.mesh.scale.x * 1.24;
    const pulse = 1 + 0.07*Math.sin(S.t*pulseHz + o.slot*1.7);
    m.scale.setScalar(s * pulse);
    m.material.color.copy(col);
    // A fresh grab flares, then settles.
    m.material.opacity = base + 0.30*Math.max(0, o.grabT||0)
                       + 0.06*Math.sin(S.t*pulseHz*1.6 + o.slot);
  };

  for (const o of S.held) claim(o, AURA_HELD, 0.55, 7);
  for (const o of rocks) {
    if (o.gone || o.held) continue;
    if (o.hostile > 0)     claim(o, AURA_HOSTILE, 0.75, 13);
    else if (o.seekT > 0)  claim(o, AURA_SEEK, 0.62, 11);
  }
  for (; i < auras.length; i++) auras[i].visible = false;
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

// Every route that hurts the player goes through here, so GLASS only has to
// be honoured in one place.
function hurtHero() {
  hero.hp = WMOD.oneHp ? 0 : hero.hp - 1;
  if (MOD.secondWind && !S.windUsed && hero.hp > 0 && hero.hp <= 2) {
    S.windUsed = true;
    S.strain = 0; S.overload = 0;
    banner("SECOND WIND");
    SFX.rankUp(3);
  }
}

function damageWalker(w, amount, dir, knock, kind) {
  if (w.dead) return;
  // Whatever landed last is what the kill gets credited to. Recorded before
  // the damage resolves so killWalker can read it without another argument
  // threaded through every death path.
  if (kind) w.lastHit = kind;
  amount *= OD.on ? CFG.odDamage : 1;
  // Armour subtracts flat, with a small floor so nothing is fully immune.
  // A rock into a Tank is a chip; a boulder or a blast is a real hit.
  // A plated boss takes almost nothing on the body. The plates ARE the
  // fight; the core only opens once they are gone.
  if (w.boss && w.platesLeft > 0) {
    const pl = w.plates.find(p => p.hp > 0);
    if (w.maw && pl) {
      pl.hp -= amount;
      w.flash = 1;
      if (pl.hp <= 0) {
        pl.mesh.visible = false;
        w.platesLeft--;
        sparks(w.pos, 0xaab4c4, 22, 26);
        SFX.boom();
        S.shake = Math.min(1.2, S.shake + 0.6);
        S.freeze = Math.max(S.freeze, 0.16);
        banner(w.platesLeft ? "PLATE SHATTERED · " + w.platesLeft + " LEFT"
                            : "THROAT EXPOSED");
      }
      return;
    }
    if (pl) {
      pl.hp -= amount;
      if (pl.hp <= 0) {
        pl.mesh.visible = false;
        w.platesLeft--;
        sparks(w.pos, 0xaab4c4, 16, 20);
        SFX.boom();
        S.shake = Math.min(1, S.shake + 0.5);
        S.freeze = Math.max(S.freeze, 0.16);
        banner(w.platesLeft ? "PLATE DOWN · " + w.platesLeft + " LEFT" : "CORE EXPOSED");
      }
    }
    w.flash = 1;
    return;                      // body damage is absorbed entirely
  }
  // A Shield eats anything arriving through its front arc. Blasts wrap round
  // it and a body dropped on it from above misses the slab entirely, so the
  // counters are flanking, explosives, and launching something at it — not
  // simply more damage.
  if (w.slab && w.slabHp > 0 && dir && kind !== "blast" && kind !== "chem") {
    // dir is built at the impact site as (prop - walker) normalised, so it
    // points from the body back toward where the hit came from. The slab is
    // on the body's facing side, so a frontal hit is a POSITIVE dot with the
    // facing vector — an earlier negation here had the slab blocking hits
    // that arrived from behind and passing everything that hit the front.
    const facx = Math.sin(w.g.rotation.y), facz = Math.cos(w.g.rotation.y);
    if (dir.x*facx + dir.z*facz > w.E.shield.arc) {
      w.slabHp -= amount;
      w.flash = 1;
      sparks(tmp3.set(w.pos.x, 1.4, w.pos.z), 0xaab4c4, 6, 12);
      SFX.impact(2.4, 1.1);
      if (w.slabHp <= 0) {
        w.slab.visible = false;
        banner("SHIELD BROKEN");
        S.freeze = Math.max(S.freeze, 0.1);
        sparks(w.pos, 0xaab4c4, 18, 22);
      }
      return;                    // the slab took it, the body did not
    }
  }
  // IRON TIDE plates everything but hands blasts a way through it, so the
  // wave has an answer rather than just being slower.
  let ar = (WMOD.blastPierce && kind === "blast") ? 0 : (w.E.armor || 0);
  // Armour is flat subtraction, so it is light props it punishes — which is
  // the point: a rock pings off a Tank and a boulder does not. A weak point
  // or a critical bypasses most of it, which is what makes precision the
  // answer to armour rather than raw output.
  if (ar && (kind === "weak" || kind === "crit")) ar *= 0.25;
  if (ar) amount = Math.max(amount * 0.08, amount - ar);
  w.hp -= amount;
  w.flash = 1;
  if (dir && knock) w.kb.addScaledVector(dir, knock);
  // Damage dealt is what charges the kinetic meter. Not kills — damage — so
  // chipping a Tank still builds toward the payoff instead of feeling wasted.
  addKinetic(Math.min(amount, w.maxHp) * CFG.kinPerDamage);
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
  const ex = { r: b.ex.r * MOD.blastR * WMOD.blastR, dmg: b.ex.dmg * MOD.blastDmg };
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
      damageWalker(w, ex.dmg*fall, tmp, 9*fall, "blast");
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
  // Cover is in the blast radius too. A barrel chain does not just clear
  // bodies, it rearranges the map you are fighting on.
  for (const ob of obstacles) {
    if (ob.dead) continue;
    const d = Math.hypot(ob.pos.x-pos.x, ob.pos.z-pos.z);
    if (d < ex.r + ob.r) hurtObstacle(ob, ex.dmg * (1 - d/(ex.r+ob.r)) * 1.4);
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
  combo:0, comboT:0, score:0, recycleT:0, waveT:0, endless:false,
  inReach:0, reachT:0, dryWarned:false, inZone:false,
  strain:0, overload:0, idleT:0, grabbed:0,
  style:0, styleT:0, rank:"D", recent:[],   // see addStyle
  kinetic:0,
  held: [],
  mode: "single",          // "single" | "aoe"
  modeCd: 0,               // seconds left on the switch cooldown
  dashT: 0, dashCd: 0, dashDir: new T.Vector3(), repCd: 0, windUsed: false,
  freeze: 0,               // hit stop, in real seconds — see frame()
  lock: null,              // walker currently under the crosshair
};
// `dist` is what the camera uses; `distWant` is what the player asked for.
// Keeping them apart is what makes a wheel notch or a pinch feel like a
// camera move rather than a jump cut.
const cam = { yaw: Math.PI, pitch: 0.26, dist: 11.2, distWant: 11.2 };

function clearAll() {
  rocks.forEach(o => { scene.remove(o.mesh); o.mesh.geometry.dispose(); });
  rocks.length = 0;
  walkers.forEach(w => { scene.remove(w.g); if (!w.disposed) disposeGroup(w.g); });
  walkers.length = 0;
  gibs.forEach(x => scene.remove(x.mesh)); gibs.length = 0;
  puddles.forEach(p => scene.remove(p.mesh)); puddles.length = 0;
  shells.forEach(s => { s.life = 0; s.mesh.visible = false; });
  blastQ.length = 0;
  bolts.forEach(b2 => scene.remove(b2.mesh)); bolts.length = 0;
  tethers.forEach(t2 => { t2.visible = false; });
  auras.forEach(a2 => { a2.visible = false; });
  S.held = []; S.lock = null; S.combo = 0; S.comboT = 0;
  resetObstacles();
}

// Cover destroyed during a wave stays destroyed for that wave; a new wave is
// a new patch of woods. Restoring rather than respawning keeps the instanced
// meshes and the obstacle list stable across a whole run.
function resetObstacles() {
  for (const ob of obstacles) {
    ob.dead = false;
    ob.hp = ob.maxHp;
    ob.mesh.visible = true;
    ob.mesh.rotation.z = 0;
  }
}

function buildWave(n) {
  clearAll();
  rollModifier(n);
  // Only re-lay the world when the place actually changes; re-laying 210
  // instanced trees every single wave is work nobody asked for.
  const A = arenaFor(n);
  const moved = A !== arena;
  if (moved) buildArena(A);

  // Scatter the catalogue rather than a pile of identical rocks, so what is
  // lying near you is itself a tactical fact.
  for (const key in OBJECTS) {
    const def = OBJECTS[key];
    // Modifiers reshape what is lying around, which is a bigger lever on how
    // a wave plays than the enemy statline is.
    const pm = (WMOD.props && WMOD.props[key] !== undefined ? WMOD.props[key] : 1)
             * WMOD.propsAll;
    // Capped: past wave ~12 more props stop being more options and start
    // being a quadratic collision bill. The prop pass is O(n^2).
    const dens = Math.min(3.2, 1.4 + n*0.15) * DIFF.stock;
    const n2 = Math.max(1, Math.round(def.count * dens * pm));
    for (let i = 0; i < n2; i++) {
      const a = rand(0,Math.PI*2);
      // Uniform over a disc is sqrt-distributed, which piles everything at
      // the rim. Bias inward instead so there is always something underfoot.
      const d = Math.pow(Math.random(), 0.8) * (CFG.arena*0.62);
      spawnObject(key, Math.cos(a)*d, Math.sin(a)*d);
    }
  }
  // Past the table, take a late-block composition rather than repeating the
  // boss wave forever, and bring a big one back every fifth wave.
  let comp = WAVES[Math.min(n, WAVES.length) - 1];
  if (n > WAVES.length) {
    const late = [WAVES[6], WAVES[7], WAVES[8], WAVES[9]];
    comp = Object.assign({}, late[(n - WAVES.length - 1) % late.length]);
    const since = n - WAVES.length;
    if (since % 5 === 0) comp[since % 10 === 0 ? "maw" : "boss"] = 1;
  }
  // Past the table the wave scales up, but the count stops growing after a
  // point and the difficulty moves into the enemies themselves — see
  // LATE_RAMP. Eighty bodies is not harder than forty, it is just slower.
  const extra = Math.min(4, Math.max(0, n - WAVES.length));
  const list = [];
  for (const t in comp) {
    // A boss is a boss, singular. The late-wave ramp and the HORDE modifier
    // both multiply counts, and left unguarded that produced TWO Wardens in
    // one endless wave.
    const isBig = t === "boss" || t === "maw";
    let c = isBig ? comp[t] : comp[t] + Math.round(comp[t] * extra * 0.35);
    if (!isBig) c = Math.round(c * WMOD.count * CFG.enemyMul);
    for (let i = 0; i < c; i++) list.push(t);
  }
  // Trim to the ceiling, dropping the most numerous archetypes first so the
  // wave keeps its variety rather than losing whatever happens to be last.
  if (list.length > CFG.maxWaveBodies) {
    const count = {};
    list.forEach(t => { count[t] = (count[t]||0)+1; });
    while (list.length > CFG.maxWaveBodies) {
      let worst = null, most = 0;
      for (const t in count) {
        if (t === "boss" || t === "maw") continue;
        if (count[t] > most) { most = count[t]; worst = t; }
      }
      if (!worst || most <= 1) break;
      list.splice(list.lastIndexOf(worst), 1);
      count[worst]--;
    }
  }

  // Shuffle so the held-back half is not always the same archetypes.
  for (let i = list.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  // The Warden is never a reinforcement. The shuffle above could put it in
  // the held-back half, which made it stroll in mid-wave as a "reinforcement"
  // — and left wave 11 with no boss at all in its opening group.
  for (const big of ["maw", "boss"]) {
    const bi = list.indexOf(big);
    if (bi > 0) { list.splice(bi, 1); list.unshift(big); }
  }

  // The opening group arrives evenly all round — that is the wave's starting
  // shape. The rest is held back and arrives in pulses from chosen bearings,
  // so the wave keeps developing instead of being one problem.
  spawnQ.length = 0;
  recentSector = -1;
  const opening = n <= 2 ? list.length : Math.max(3, Math.round(list.length * 0.6));
  list.slice(0, opening).forEach((t, i) => {
    const a = (i/opening)*Math.PI*2 + rand(-0.25,0.25), d = CFG.arena - rand(2,8);
    spawnWalker(t, Math.cos(a)*d, Math.sin(a)*d);
  });
  // Remaining bodies go into pulses of two or three, spaced out across the
  // wave. Boss never gets held back.
  let t0 = rand(7, 10);
  let rest = list.slice(opening);
  while (rest.length) {
    const grp = rest.splice(0, 1 + Math.floor(Math.random()*3));
    spawnQ.push({ types: grp, at: t0 });
    t0 += rand(8, 13);
  }
  S.waveT = 0;
  clearZones();
  shocks.forEach(killShock);
  shocks.length = 0;
  pendingEvent = null;
  scheduleEvent(n);
  hero.pos.set(0,0,0); hero.yaw = Math.PI;
  hero.vy = 0; hero.grounded = true;
  hero.lastX = 0; hero.lastZ = 0; hero.speed = 0; hero.gait = 0;
  S.dashT = 0; S.dashCd = 0; S.windUsed = false; S.freeze = 0; S.grabbed = 0;
  cam.yaw = Math.PI; cam.pitch = 0.26;
  S.strain = 0; S.overload = 0; document.body.classList.remove("ovl");
  el("wave").textContent = n;
  const mn = el("modName2");
  if (mn) {
    mn.textContent = WMOD.name || "";
    mn.classList.toggle("show", !!WMOD.name);
  }
  // Arriving somewhere new is the louder event, so it gets the banner and
  // the condition follows it rather than fighting it for the same slot.
  if (moved) {
    banner(A.name);
    toast(A.name + " — " + A.sub, 3000);
    el("arena").textContent = A.name;
    SFX.arena();
  }
  if (WMOD.name) setTimeout(() => { banner(WMOD.name); toast(WMOD.desc, 3200); },
                            moved ? 3200 : 420);
  updateHUD();
}

function updateHUD() {
  const alive = walkers.filter(w => !w.dead);
  el("left").textContent = alive.length;
  // Two-letter codes, because first letters collide (Shield/Spawner,
  // Exploder/Elite) and the roll-call is useless if you cannot read it.
  const kinds = {};
  alive.forEach(w => {
    if (w.boss) { kinds["BOSS"] = (kinds["BOSS"]||0)+1; return; }
    const c = (w.E.code || w.E.name.slice(0,2).toUpperCase()) + (w.elite ? "*" : "");
    kinds[c] = (kinds[c]||0)+1;
  });
  const bw = walkers.find(w => w.boss && !w.dead);
  const bb = el("bossBar");
  if (bb) {
    bb.classList.toggle("show", !!bw);
    if (bw) {
      const plates = bw.plates.reduce((s,p) => s + Math.max(0,p.hp), 0);
      const pMax = bw.maw ? MAW.plates * MAW.plateHp : BOSS.plates * BOSS.plateHp;
      el("bossPlate").style.width = (plates/pMax*100) + "%";
      el("bossCore").style.width  = (Math.max(0,bw.hp)/bw.maxHp*100) + "%";
      const bn = bw.maw ? "THE MAW" : "WARDEN";
      el("bossName").textContent = bn +
        (bw.platesLeft ? " · ARMOURED" : bw.enraged ? " · ENRAGED" : " · EXPOSED");
      el("bossBar").classList.toggle("open", !bw.platesLeft);
    }
  }
  const th = el("threat");
  if (th) th.textContent = Object.keys(kinds).length
    ? Object.entries(kinds).sort((a,b) => b[1]-a[1]).slice(0, 5)
        .map(([k,v]) => k+v).join(" ") : "";
  let h = "";
  const maxHp = CFG.maxHealth + MOD.hpBonus;
  for (let i = 0; i < maxHp; i++) h += `<i class="${i < hero.hp ? "" : "off"}"></i>`;
  el("hp").innerHTML = h;
  el("carry").textContent = S.held.length;
  const sc = el("score"); if (sc) sc.textContent = S.score;
  const cv = el("comboVal"); if (cv) cv.textContent = "x" + Math.max(1, S.combo);
  const cw = el("comboWrap"); if (cw) cw.classList.toggle("hot", S.combo > 1);

  updateMeters();
}

// The two continuous meters, cheap enough to touch every frame. Kept out of
// updateHUD, which walks the walker list and rebuilds strings.
let lastRank = "", lastStyleW = -1, lastKinW = -1;
function updateMeters() {
  const rv = el("rankVal");
  if (!rv) return;
  const r = rankFor(S.style);
  const i = RANKS.indexOf(r);
  if (r.name !== lastRank) {
    lastRank = r.name;
    rv.textContent = r.name;
    rv.style.color = r.color;
    rv.style.textShadow = i > 1 ? "0 0 12px " + r.color : "none";
    el("styleWrap").style.color = r.color;
  }
  // The bar fills across the current rank, not across the whole scale, so it
  // always reads as "this much further to the next letter".
  const lo = r.at, hi = i+1 < RANKS.length ? RANKS[i+1].at : STYLE_MAX;
  const w = Math.round(Math.max(0, Math.min(100, (S.style-lo)/(hi-lo)*100)));
  if (w !== lastStyleW) { lastStyleW = w; el("styleFill").style.width = w + "%"; }
  el("styleWrap").classList.toggle("fade", S.styleT <= 0 && S.style > 0);

  const k = Math.round(S.kinetic*100);
  if (k !== lastKinW) { lastKinW = k; el("kinFill").style.width = k + "%"; }
  el("kinWrap").classList.toggle("full", OD.on);
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
  if (!silent) toast(m === "single"
    ? "Single — aims for the head, executes the wounded"
    : "Burst — three landing together detonate a kinetic wave");
}

// Zoom. One entry point so the wheel, the pinch and the keys cannot drift
// apart, and so the preference is saved in exactly one place.
let zoomTold = 0;
function setZoom(d, quiet) {
  cam.distWant = clamp(d, CFG.camMin, CFG.camMax);
  try { localStorage.setItem("kinesis.zoom", cam.distWant.toFixed(2)); } catch (e) {}
  // Announce it a couple of times for discoverability, then shut up — the
  // toast is shared with gameplay warnings like NO OBJECTS IN RANGE, and a
  // readout on every wheel notch would bury them.
  if (!quiet && zoomTold < 3) {
    zoomTold++;
    const pct = Math.round((1 - (cam.distWant - CFG.camMin) / (CFG.camMax - CFG.camMin)) * 100);
    toast("Zoom " + pct + "%", 700);
  }
}
function zoomBy(delta) { setZoom(cam.distWant + delta); }

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
  addStrain(CFG.strainRepulse);
  let n = 0;
  for (const w of walkers) {
    if (w.dead) continue;
    const dx = w.pos.x-hero.pos.x, dz = w.pos.z-hero.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < CFG.repulseR && d > 0.1) {
      const k = 26 * (1 - d/CFG.repulseR) / d;
      w.kb.x += dx*k; w.kb.z += dz*k;
      damageWalker(w, 45, null, 0, "repulse");
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
  // Breaking a grab is the one thing dash always does, cooldown or not — a
  // root you cannot escape is a stun-lock, which the brief rules out.
  if (S.grabbed > 0) { S.grabbed = 0; banner("BROKE FREE"); SFX.rankUp(1); }
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
  if (e.code === "Minus" || e.code === "NumpadSubtract" || e.code === "BracketLeft")
    { e.preventDefault(); zoomBy(CFG.camStep); }
  if (e.code === "Equal" || e.code === "NumpadAdd" || e.code === "BracketRight")
    { e.preventDefault(); zoomBy(-CFG.camStep); }
  if (e.code === "Digit0") { e.preventDefault(); setZoom(11.2); }
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

// Pointers currently down on the canvas. One is a look-drag; two is a pinch.
// They have to be tracked together, because the moment a second finger lands
// the first one must STOP steering the camera — otherwise pinching also
// whips the view round.
const camPointers = new Map();
let pinchFrom = 0, pinchDist = 0;

const spread = () => {
  const [a2, b2] = [...camPointers.values()];
  return Math.hypot(a2.x - b2.x, a2.y - b2.y);
};

canvas.addEventListener("pointerdown", e => {
  camPointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
  if (camPointers.size === 2) {
    // Entering a pinch: drop the look-drag and take a reference reading.
    lookId = null;
    pinchFrom = spread();
    pinchDist = cam.distWant;
  } else if (camPointers.size === 1 && lookId === null) {
    lookId = e.pointerId; lp = { x:e.clientX, y:e.clientY };
  }
});

addEventListener("pointermove", e => {
  if (camPointers.has(e.pointerId))
    camPointers.set(e.pointerId, { x:e.clientX, y:e.clientY });

  if (camPointers.size === 2) {
    const now = spread();
    // Fingers apart = closer in. Ratio rather than difference, so the
    // gesture feels the same wherever it starts from.
    if (pinchFrom > 8 && now > 8) setZoom(pinchDist * (pinchFrom / now), true);
    return;
  }
  if (e.pointerId !== lookId) return;
  cam.yaw  -= (e.clientX-lp.x)*0.005;
  cam.pitch = clamp(cam.pitch + (e.clientY-lp.y)*0.004, -0.2, 1.0);
  lp = { x:e.clientX, y:e.clientY };
});

function lookEnd(e) {
  camPointers.delete(e.pointerId);
  if (e.pointerId === lookId) lookId = null;
  // Coming out of a pinch with a finger still down: hand it back to look,
  // re-anchored, so the view does not snap to wherever that finger is.
  if (camPointers.size === 1 && lookId === null) {
    const [id] = [...camPointers.keys()];
    lookId = id;
    lp = { ...camPointers.get(id) };
  }
}
addEventListener("pointerup", lookEnd);
addEventListener("pointercancel", lookEnd);

// Wheel / trackpad.
canvas.addEventListener("wheel", e => {
  e.preventDefault();
  // deltaMode 1 is lines, 2 is pages; normalise so a trackpad and a mouse
  // do not differ by two orders of magnitude.
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
  // Finer than a key press: a wheel gets many notches, a key gets one press.
  zoomBy(Math.sign(e.deltaY * unit) * CFG.camStep * 0.55);
}, { passive: false });

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

// ── kinetic strain
// Builds with telekinetic throughput and recovers on its own. At maximum the
// player OVERLOADS: reach collapses, carry shrinks, throws lose speed, and
// gathering is refused until it has bled back down. Every part of that is
// signposted before it happens — the bar fills visibly, changes colour in
// the last quarter, and the overload itself is announced.
function addStrain(v) {
  if (OD.on) return;
  v *= DIFF.strain;                    // Overdrive is the reward for building it
  S.strain = Math.min(1, S.strain + v);
  S.idleT = 0;
  if (S.strain >= 1 && S.overload <= 0) {
    S.overload = CFG.overloadTime;
    banner("TELEKINESIS OVERLOAD");
    toast("Overloaded — reach and carry cut until it clears", 2400);
    SFX.overload();
    S.shake = Math.min(1, S.shake + 0.3);
    document.body.classList.add("ovl");
  }
}

function overloaded() { return S.overload > 0; }

function grabReach() {
  const base = CFG.grabRadius + MOD.grabR + (OD.on ? CFG.odGrabR : 0);
  return overloaded() ? base * 0.55 : base;
}

function carryCap() {
  return Math.max(2, CFG.maxHeld + MOD.maxHeld - (overloaded() ? 3 : 0));
}

function gather() {
  if (overloaded()) { toast("Overloaded — telekinesis recovering"); SFX.dry(); return; }
  const near = rocks
    .filter(o => !o.held && !o.gone && o.seekT <= 0 && o.pos.distanceTo(hero.pos) < grabReach())
    .sort((a,b) => a.pos.distanceTo(hero.pos) - b.pos.distanceTo(hero.pos))
    .slice(0, carryCap());
  if (!near.length) { toast("NO OBJECTS IN RANGE — move"); SFX.dry(); return; }
  let heaviest = 0;
  near.forEach((o,i) => {
    o.held = true; o.slot = i; o.mesh.material = heldMat;
    o.fireMode = null; o.volleyId = -1;
    // Snap it off the floor so the grab reads as a yank rather than a fade.
    // Kept small and capped: the carry spring has to stay dominant, and an
    // earlier value of 7/mass flung light props clean over the treeline.
    o.vel.y += Math.min(3.2, 2.0 / Math.max(0.7, o.def.mass));
    o.grabT = 0.5;
    sparks(tmp.set(o.pos.x, o.pos.y*0.4, o.pos.z), 0xe94fbf, 4, 7);
    heaviest = Math.max(heaviest, o.def.mass);
  });
  S.held = near;
  // Heavier loads strain more, which is what makes a boulder a decision.
  let mass = 0;
  near.forEach(o => { mass += o.def.mass; });
  addStrain(CFG.strainGather * mass);
  SFX.gather(heaviest);
  S.shake = Math.min(0.4, S.shake + 0.06*heaviest);
  updateHUD();
  updateForceLabel();
}

const aimDir = new T.Vector3();

// One burst = one id. Stones remember which volley they belong to, so three
// landing together can be recognised as a volley rather than three unrelated
// hits, and collapse into a shockwave at their centroid.
const volley = { id:0, t:0, hits:[], fired:false };

function noteVolleyHit(o, pos) {
  if (o.volleyId !== volley.id || volley.fired || volley.t <= 0) return;
  volley.hits.push(pos.clone());
  if (volley.hits.length < (MOD.avalanche ? 2 : CFG.burstWaveMin)) return;
  volley.fired = true;
  const c = new T.Vector3();
  volley.hits.forEach(h => c.add(h));
  c.divideScalar(volley.hits.length);
  c.y = 0;
  const wr = CFG.burstWaveR * (MOD.avalanche ? 1.5 : 1);
  queueBlast(c, { r:wr, dmg:CFG.burstWaveDmg }, null);
  shell(c, wr, 0x4FD6E9);
  S.shake = Math.min(1, S.shake + 0.45);
  S.freeze = Math.max(S.freeze, 0.14);
  banner("KINETIC WAVE");
  SFX.boom();
}

function shootOne() {
  const o = S.held.shift();
  addStrain(CFG.strainSingle * Math.sqrt(o.def.mass));
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
  // Per stone, and roughly twice what an aimed shot costs each. A full seven
  // stone volley very nearly overloads from neutral — which is the point:
  // Burst is the emergency button, not the default.
  let mass = 0;
  S.held.forEach(o => { mass += Math.sqrt(o.def.mass); });
  addStrain(CFG.strainBurst * mass);
  aimDir.set(Math.sin(cam.yaw), 0, Math.cos(cam.yaw)).normalize();

  // Burst assigns a DIFFERENT mark per stone across a wide forward arc.
  // Single concentrates one heavy shot; burst spreads seven light ones over
  // seven bodies. That is the whole distinction between the modes.
  const marks = walkers.filter(w => !w.dead).map(w => {
    tmp.set(w.pos.x-hero.pos.x, 0, w.pos.z-hero.pos.z);
    const d = tmp.length() || 1;
    return { w, d, dot: tmp.divideScalar(d).dot(aimDir) };
  }).filter(m => m.dot > CFG.burstCone).sort((a,b) => a.d - b.d);

  volley.id++; volley.t = CFG.burstWaveWin; volley.hits.length = 0; volley.fired = false;
  S.held.forEach((o,i) => {
    o.held = false;
    o.fireMode = "aoe";
    o.volleyId = volley.id;
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
  o.fireMode = "single";
  o.volleyId = -1;
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

  // Strain bleeds off on its own, and faster once you have stopped acting
  // for a moment — so backing out of a fight is a real way to reset.
  S.idleT += dt;
  const rested = S.idleT > 1.4 ? CFG.strainRested : 1;
  const rate = CFG.strainRecover * MOD.focusRegen * WMOD.focus * rested;
  S.strain = OD.on ? 0 : Math.max(0, S.strain - rate*dt);
  if (S.overload > 0) {
    S.overload -= dt;
    // Cannot clear until the meter has actually come down, so a long
    // overload is always the consequence of how hard you were pushing.
    if (S.overload <= 0 && S.strain > CFG.overloadClear) S.overload = 0.25;
    else if (S.overload <= 0) {
      S.overload = 0;
      document.body.classList.remove("ovl");
      banner("KINESIS RESTORED");
      SFX.rankUp(2);
    }
  }
  el("focusFill").style.width = (S.strain*100) + "%";
  el("focusFill").classList.toggle("spent", S.strain > 0.75);
  el("focusWrap").classList.toggle("ovl", overloaded());
  updateMeters();

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

  // Held by a Grabber: steering still works, ground speed does not. Dash
  // breaks it outright, which is the counterplay and is announced when it
  // happens.
  if (S.grabbed > 0) S.grabbed = Math.max(0, S.grabbed - dt);
  const rooted = S.grabbed > 0;

  if (move.lengthSq() > 1e-6) {
    move.normalize();
    lastMove.copy(move);
    const ctl = hero.grounded ? 1 : CFG.airControl;
    if (!rooted) hero.pos.addScaledVector(move, CFG.moveSpeed*mag*ctl*dt);
    const want = Math.atan2(move.x, move.z);
    let d = want - hero.yaw;
    while (d >  Math.PI) d -= Math.PI*2;
    while (d < -Math.PI) d += Math.PI*2;
    hero.yaw += d * Math.min(1, CFG.turnLerp*dt);
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
  HERO.rotation.y = hero.yaw;

  // ---- gait
  // Measured ground speed, not input magnitude: a dash is movement the stick
  // never asked for, and driving the animation off the stick means the
  // fastest thing the character ever does is also the only thing that is not
  // animated.
  const moved = Math.hypot(hero.pos.x - hero.lastX, hero.pos.z - hero.lastZ);
  hero.lastX = hero.pos.x; hero.lastZ = hero.pos.z;
  const inst = dt > 0 ? moved/dt : 0;
  hero.speed += (inst - hero.speed) * Math.min(1, 11*dt);
  hero.gait  += (GAIT.blend(hero.speed, CFG.walkSpeed, CFG.runSpeed) - hero.gait)
                * Math.min(1, 6*dt);

  const moving = hero.speed > 0.35 && hero.grounded;
  if (moving) hero.walk += dt * GAIT.cadence(hero.speed) * Math.PI*2;

  const g = hero.gait;
  const kk = Math.min(1, 12*dt);
  const airT = hero.grounded ? 0 : 1;

  if (airT) {
    // Airborne: tuck, do not run on nothing.
    legL.rotation.x += (-0.75 - legL.rotation.x) * kk;
    legR.rotation.x += ( 0.35 - legR.rotation.x) * kk;
    legL.joint.rotation.x += (1.05 - legL.joint.rotation.x) * kk;
    legR.joint.rotation.x += (0.45 - legR.joint.rotation.x) * kk;
  } else if (moving) {
    const L = legPose(hero.walk, g), R = legPose(hero.walk + Math.PI, g);
    legL.rotation.x = L.hip;  legL.joint.rotation.x = L.knee;
    legR.rotation.x = R.hip;  legR.joint.rotation.x = R.knee;
  } else {
    legL.rotation.x += (0 - legL.rotation.x) * kk;
    legR.rotation.x += (0 - legR.rotation.x) * kk;
    legL.joint.rotation.x += (0.05 - legL.joint.rotation.x) * kk;
    legR.joint.rotation.x += (0.05 - legR.joint.rotation.x) * kk;
  }

  // Cloth lags the body: the skirt kicks back as the run builds and sways
  // against the stride. Two numbers, and it does more for the read of speed
  // than another ten degrees of stride would.
  cloakSkirt.rotation.x = -g*0.15 - (moving && !airT ? Math.sin(hero.walk*2)*0.04*g : 0);
  cloakSkirt.rotation.z = (moving && !airT) ? Math.sin(hero.walk)*0.07*(0.3+g) : 0;

  // Bob and lean. Running pitches the whole body forward into the run, which
  // is the single clearest read that the gait has changed.
  const bob = (moving && !airT) ? gaitBob(hero.walk, g) : 0;
  HERO.position.set(hero.pos.x, hero.pos.y + bob, hero.pos.z);
  HERO.rotation.x = (moving && !airT) ? g * 0.20 : 0;
  // Shoulders counter-rotate against the hips; the amount grows with gait.
  HERO.rotation.z = (moving && !airT) ? Math.sin(hero.walk) * -0.045 * (0.4 + g) : 0;

  // Arms: carrying overrides the swing entirely — both hands go up to hold
  // the wheel, and that pose has to win over any gait.
  const channel = S.held.length > 0;
  const k = Math.min(1, 9*dt);
  if (channel) {
    armL.rotation.x += (-2.25 - armL.rotation.x)*k;
    armR.rotation.x += (-2.25 - armR.rotation.x)*k;
    armL.rotation.z += (-0.45 - armL.rotation.z)*k;
    armR.rotation.z += ( 0.45 - armR.rotation.z)*k;
    armL.joint.rotation.x += (-0.55 - armL.joint.rotation.x)*k;
    armR.joint.rotation.x += (-0.55 - armR.joint.rotation.x)*k;
  } else if (moving && !airT) {
    // Counter-phase to the legs, and the elbows tighten as the run builds.
    const A = armPose(hero.walk + Math.PI, g), B = armPose(hero.walk, g);
    armL.rotation.x = A.shoulder;  armL.joint.rotation.x = A.elbow;
    armR.rotation.x = B.shoulder;  armR.joint.rotation.x = B.elbow;
    // Elbows tuck in against the ribs at speed instead of flapping wide.
    armL.rotation.z += (-0.06 - 0.12*g - armL.rotation.z)*k;
    armR.rotation.z += ( 0.06 + 0.12*g - armR.rotation.z)*k;
  } else {
    armL.rotation.x += (0 - armL.rotation.x)*k;
    armR.rotation.x += (0 - armR.rotation.x)*k;
    armL.rotation.z += (-0.04 - armL.rotation.z)*k;
    armR.rotation.z += ( 0.04 - armR.rotation.z)*k;
    armL.joint.rotation.x += (-0.12 - armL.joint.rotation.x)*k;
    armR.joint.rotation.x += (-0.12 - armR.joint.rotation.x)*k;
  }

  // Zoom factor: 0 at the closest the camera can get, 1 at the default
  // framing. The aura and the carry halo were sized for the default and
  // swallow the screen at close range, so both recede as the camera comes in.
  const zf = clamp((cam.dist - CFG.camMin) / (11.2 - CFG.camMin), 0, 1);
  const auraTarget = channel ? 0.17 * (0.25 + 0.75*zf) : 0;
  aura.material.opacity += (auraTarget - aura.material.opacity)*Math.min(1,7*dt);
  aura.scale.setScalar(0.55 + 0.45*zf);
  psi.position.set(hero.pos.x, hero.pos.y + 2.2, hero.pos.z);
  psi.intensity += ((channel?13:0)-psi.intensity)*Math.min(1,8*dt);
  visor.material.emissiveIntensity = channel ? 1.5 : 0.35;

  // ---- carry wheel, behind the character
  const back = new T.Vector3(-Math.sin(cam.yaw), 0, -Math.cos(cam.yaw));
  // Halo pulls in and drops closer to the head as the camera closes, so it
  // keeps roughly the same share of the frame instead of filling it.
  const zw = clamp(cam.dist / 11.2, 0.5, 1.25);
  const wr = (S.mode === "single" ? CFG.wheelSingle : CFG.wheelAoe) * zw;
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
              CFG.wheelHeight*(0.62 + 0.38*zw) + Math.sin(a*2)*0.35,
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
        // Single guides onto the head, burst onto centre mass. Weak-point
        // crits are then a property of the mode, not of luck.
        const aimY = target.pos.y + (o.fireMode === "single" ? 1.85 : 1.15);
        tmp.set(target.pos.x - o.pos.x, aimY - o.pos.y, target.pos.z - o.pos.z);
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
      if (ob.dead || o.pos.y > ob.h + o.r) continue;
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
            hurtObstacle(ob, sp2 * o.def.mass * 1.6);
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
        hurtHero();
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

    // Held props shrink with the camera. Purely visual — o.r, which is what
    // physics and damage use, is untouched — but at close range a carry of
    // boulders is otherwise most of the screen.
    const want = o.held ? Math.min(1, zw*0.72) : 1;
    const sc = o.mesh.scale.x + (want - o.mesh.scale.x) * Math.min(1, 9*dt);
    o.mesh.scale.setScalar(sc);

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
      // tmp stays the pure bearing to the player — reach, facing and the
      // leap all want that. `steer` is where the body actually goes.
      walkerHeading(w, tmp, dist, steer);
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
      // Winding up to strike roots it: the telegraph has to be a commitment
      // or it is not a tell, it is just a delay.
      if (w.thrown <= 0 && w.windup <= 0) w.pos.addScaledVector(steer, spd*dt);
      if (steer.lengthSq() < 1e-6) w.spd = 0;
      // Faces where it is going, except while striking, when it faces the
      // player — otherwise a flanking body attacks side-on.
      const face = (w.windup > 0 || dist < w.AI.ring + 4 || steer.lengthSq() < 1e-6)
                   ? tmp : steer;
      w.g.rotation.y = Math.atan2(face.x, face.z);
      w.spd = (w.thrown > 0 || w.windup > 0) ? 0 : spd;
    }

    // A Spawner is a clock. Ignore it and the arena fills; the cap keeps a
    // long wave from becoming unwinnable rather than merely urgent.
    if (w.E.spawns && !w.thrown) {
      w.spawnT -= dt;
      if (w.spawnT <= 0) {
        w.spawnT = w.E.spawns.every;
        if (w.brood < w.E.spawns.cap) {
          w.brood++;
          const a2 = rand(0, Math.PI*2);
          spawnWalker(w.E.spawns.type, w.pos.x + Math.cos(a2)*2.2,
                                        w.pos.z + Math.sin(a2)*2.2);
          sparks(tmp3.set(w.pos.x, 2.1, w.pos.z), 0xc06aff, 10, 14);
          SFX.gather(0.6);
          updateHUD();
        }
      }
    }

    // A Warper throws your own ammunition back at you. It reuses the exact
    // hostile-prop path the boss uses, so a returned rock behaves the same
    // way and can be shot out of the air or simply dodged.
    if (w.E.psy && !w.thrown && dist < w.E.psy.range) {
      w.psyT -= dt;
      if (w.psyT <= 0) {
        w.psyT = w.E.psy.every;
        let pick = null, bd = 13;
        for (const o of rocks) {
          if (o.held || o.gone || o.hostile) continue;
          const d2 = o.pos.distanceTo(w.pos);
          if (d2 < bd && d2 > 1.2) { bd = d2; pick = o; }
        }
        if (pick) {
          tmp2.set(hero.pos.x-pick.pos.x, 2.0, hero.pos.z-pick.pos.z).normalize();
          pick.vel.copy(tmp2).multiplyScalar(30);
          pick.hostile = 1.8;
          pick.mesh.material = seekMat;
          sparks(tmp3.set(w.pos.x, 2.3, w.pos.z), 0xe94fbf, 8, 12);
          SFX.throw(0.8);
        }
      }
    }

    // A Disruptor spikes your strain from close range. Announced, visible,
    // and always survivable by backing off — the counter is distance, and it
    // is the same counter every time.
    if (w.E.disrupt && !w.thrown && dist < w.E.disrupt.range) {
      w.psyT -= dt;
      if (w.psyT <= 0) {
        w.psyT = w.E.disrupt.every;
        addStrain(w.E.disrupt.strain);
        bolt(tmp3.set(w.pos.x, 2.2, w.pos.z), tmp2.set(hero.pos.x, hero.pos.y+1.4, hero.pos.z));
        sparks(tmp3.set(hero.pos.x, 1.5, hero.pos.z), 0x4FD6E9, 10, 14);
        banner("DISRUPTED");
        SFX.disrupt();
      }
    }

    // A Grabber roots the player for a beat. Dash breaks it, so it punishes
    // standing still beside one — exactly the mistake it exists to punish.
    if (w.E.grab && !w.thrown && dist < w.E.grab.range && S.grabbed <= 0) {
      w.psyT -= dt;
      if (w.psyT <= 0) {
        w.psyT = w.E.grab.every;
        S.grabbed = w.E.grab.hold;
        banner("GRABBED — DASH FREE");
        SFX.grabbed();
        S.shake = Math.min(1, S.shake + 0.3);
      }
    }

    // ---- THE MAW
    if (w.maw) {
      w.glow.intensity = w.platesLeft ? 0.5 : 6 + Math.sin(S.t*5)*3;
      w.core.material.emissiveIntensity = w.platesLeft ? 0.35 : 2.4;

      // Enrage once the core is worn down: everything gets faster, and it is
      // announced so a sudden change in rhythm is never a surprise.
      if (!w.enraged && !w.platesLeft && w.hp < w.maxHp * MAW.enrageAt) {
        w.enraged = true;
        banner("THE MAW IS ENRAGED");
        toast("It stops pacing itself", 2600);
        SFX.overload();
        S.shake = Math.min(1.2, S.shake + 0.8);
      }
      const rate = w.enraged ? 0.62 : 1;

      // GROUND SLAM. Long wind-up, rears up on its back legs, then drops —
      // a ring races out across the floor and only touches you if you are
      // standing on it. Jump the ring. That is the whole fight.
      if (w.slamWind > 0) {
        w.slamWind -= dt;
        const t = 1 - w.slamWind / (MAW.slamWind*rate);
        w.body.position.y = 3.4 + Math.sin(t*Math.PI)*2.6;
        w.body.rotation.x = -Math.sin(t*Math.PI)*0.5;
        w.tell.visible = true;
        w.tell.material.opacity = 0.3 + 0.6*t;
        w.tell.scale.setScalar(1 + t*0.7);
        if (w.slamWind <= 0) {
          w.slamWind = 0;
          w.body.position.y = 3.4; w.body.rotation.x = 0;
          w.tell.visible = false;
          shocks.push(makeShock(w.pos));
          S.shake = Math.min(1.4, S.shake + 1.0);
          SFX.boom();
          S.freeze = Math.max(S.freeze, 0.12);
        }
      } else {
        w.slamT -= dt;
        if (w.slamT <= 0 && dist < MAW.slamR) {
          w.slamT = MAW.slamEvery * rate;
          w.slamWind = MAW.slamWind * rate;
          banner("SLAM — JUMP");
          SFX.warn();
        }
      }

      // HURL: picks up whatever is lying near it and throws it. Same hostile
      // prop path the Warden uses, so it can be shot out of the air.
      w.atkT -= dt;
      if (w.atkT <= 0 && w.slamWind <= 0) {
        w.atkT = MAW.hurlEvery * rate;
        let pick = null, bd = 22;
        for (const o of rocks) {
          if (o.held || o.gone || o.hostile) continue;
          const d2 = o.pos.distanceTo(w.pos);
          if (d2 < bd && d2 > 2.5) { bd = d2; pick = o; }
        }
        if (pick) {
          tmp2.set(hero.pos.x-pick.pos.x, 2.4, hero.pos.z-pick.pos.z).normalize();
          pick.vel.copy(tmp2).multiplyScalar(38);
          pick.hostile = 2.0;
          pick.mesh.material = seekMat;
          SFX.throw(2);
          banner("INCOMING");
        }
      }

      // ROAR: opens the jaw and calls in bodies from a chosen bearing, so the
      // arena never empties out while you work on it.
      w.roarT -= dt;
      if (w.roarT <= 0 && w.slamWind <= 0) {
        w.roarT = MAW.roarEvery * rate;
        w.jawOpen = 0.55;
        reinforce(w.enraged ? ["runner","runner","leaper","crawler"]
                            : ["walker","runner","crawler"], "THE MAW CALLS");
      }
      w.jawOpen = Math.max(0, (w.jawOpen || 0) - dt*0.8);
      w.jaw.rotation.x = w.jawOpen;
      w.head.rotation.y = Math.sin(S.t*0.7)*0.12;
    }

    if (w.boss && !w.maw) {
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
            if (ob.dead || w.pos.y > ob.h) continue;
            const dd = Math.hypot(w.pos.x-ob.pos.x, w.pos.z-ob.pos.z);
            if (dd < ob.r + w.r) {
              w.tvel.multiplyScalar(-0.25);
              damageWalker(w, Math.min(260, sp3*11), null, 0, "env");
              sparks(w.pos, 0x8a5a4a, 10, 16);
              SFX.impact(2.6, 1.3);
              S.shake = Math.min(1, S.shake + 0.3);
              hurtObstacle(ob, sp3 * 5);
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
          if (sp3 > LAUNCH_MIN) damageWalker(w, sp3*5, null, 0, "crush");
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
    // ---- walker gait (skipped while winding up: the tell owns the pose)
    if (w.windup > 0) { w.body.position.y = 0; }
    else {
    // Same blend as the hero, driven by the archetype's own speed, so a
    // Walker shambles, a Runner actually runs, and a leaper's burst reads as
    // a sprint rather than as a shamble played fast. FRENZY, which multiplies
    // speed, therefore changes how the wave MOVES and not just how quickly.
    const wspd = w.spd || 0;
    const wg = GAIT.blend(wspd, 1.6, 4.6);
    w.gait += (wg - (w.gait||0)) * Math.min(1, 5*dt);
    const gz = w.gait;
    w.walk += dt * GAIT.cadence(wspd) * Math.PI*2;

    const L = legPose(w.walk, gz), R = legPose(w.walk + Math.PI, gz);
    w.lL.rotation.x = L.hip;  w.lL.joint.rotation.x = L.knee;
    w.lR.rotation.x = R.hip;  w.lR.joint.rotation.x = R.knee;

    // The reach is the shamble's signature, so it survives at low speed and
    // gives way to a pumping arm as the thing starts to sprint.
    const A = armPose(w.walk + Math.PI, gz), B = armPose(w.walk, gz);
    const shamble = -1.6 * (1 - gz);
    w.aL.rotation.x = shamble + A.shoulder*gz + Math.sin(w.walk*0.55)*0.14*(1-gz);
    w.aR.rotation.x = shamble + B.shoulder*gz - Math.sin(w.walk*0.55)*0.14*(1-gz);
    w.aL.joint.rotation.x = -0.25 - 1.1*gz + A.elbow*gz*0.5;
    w.aR.joint.rotation.x = -0.25 - 1.1*gz + B.elbow*gz*0.5;

    w.body.rotation.z = Math.sin(w.walk)*(0.11 - 0.05*gz);
    w.body.position.y = gaitBob(w.walk, gz);
    // Hunched when shambling, driving forward when sprinting.
    w.torso.rotation.x = 0.34 + 0.30*gz + Math.sin(w.walk*0.5)*0.06;
    }

    // ---- attack: wind up, then strike
    // Contact damage used to be instantaneous on entering reach, which gives
    // the player nothing to read and nothing to answer — you simply lose a
    // heart because something touched you. Now every attack is a rooted
    // wind-up with a visible tell, and stepping out of reach makes it whiff.
    // The window is per archetype: a Runner's is short and a Tank's is long.
    const reach = w.reach || (w.boss ? BOSS.reach : CFG.zReach * (w.E.scale || 1));
    if (w.windup > 0) {
      w.windup -= dt;
      // Rears back, then lunges. Also flashes, because on a dark ground the
      // pose alone is not enough of a tell at range.
      const t = 1 - w.windup / w.AI.telegraph;
      w.torso.rotation.x = 0.34 - 0.55*Math.sin(t*Math.PI);
      w.aL.rotation.x = -1.6 - 1.5*Math.sin(t*Math.PI);
      w.aR.rotation.x = -1.6 - 1.5*Math.sin(t*Math.PI);
      w.tell.material.opacity = 0.25 + 0.55*Math.sin(t*Math.PI);
      w.tell.visible = true;
      w.tell.scale.setScalar(1 + t*0.5);
      if (w.windup <= 0) {
        w.tell.visible = false;
        w.cool = CFG.zCooldown;
        // Only lands if the player is still inside reach and on the ground:
        // moving, dashing or jumping all beat it.
        if (dist < reach*1.25 && hero.pos.y < CFG.dodgeHeight) {
          hurtHero();
          SFX.hurt();
          S.shake = Math.min(1, S.shake+0.45);
          el("dmg").classList.add("on");
          setTimeout(() => el("dmg").classList.remove("on"), 220);
          updateHUD();
          if (hero.hp <= 0) { gameOver(); return; }
        } else {
          SFX.whiff();
        }
      }
    } else if (dist < reach && w.cool <= 0 && hero.pos.y < CFG.dodgeHeight &&
               !(w.maw && w.slamWind > 0)) {
      w.windup = w.AI.telegraph;
      SFX.tell();
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
          // Three tiers, not two. The head box scales with the archetype, so
          // a Crawler's weak point is genuinely harder to hit than a Tank's,
          // and the inner band is a CRITICAL — small, and worth going for.
          const hy = o.pos.y / Math.max(0.4, w.E.scale);
          // Marksman widens the head box, but only for a shot you aimed.
          const wide = MOD.marksman && o.fireMode === "single";
          const lo = wide ? 1.20 : 1.52, hi = wide ? 2.60 : 2.25;
          const weak = hy > lo && hy < hi;
          // Dead centre of the head box, and only on a shot that was aimed —
          // a burst projectile cannot roll a critical.
          const mid = (lo + hi) * 0.5, half = (hi - lo) * 0.5;
          const crit = weak && o.fireMode === "single" &&
                       Math.abs(hy - mid) < half * 0.34;
          let dmg = o.def.dmg * scale * (o.mult || 1) * MOD.allDmg * WMOD.dmg;
          if (MOD.berserk && hero.hp <= 2) dmg *= 2;
          const hardness = Math.min(1.8, scale) * Math.sqrt(o.def.mass);
          if (crit) {
            dmg *= CFG.critMul;
            banner("CRITICAL");
            SFX.crit();
            S.freeze = Math.max(S.freeze, 0.14);
            sparks(tmp3.set(o.pos.x, 2.0, o.pos.z), 0xffffff, 18, 26);
          } else if (weak) {
            dmg *= CFG.weakMul; banner("WEAK POINT"); SFX.weak();
            S.freeze = Math.max(S.freeze, 0.09);
          }
          else SFX.impact(o.def.mass, Math.min(1.6, scale));
          tmp.y = 0; tmp.normalize();
          // Single is the finisher: a wounded body hit by an aimed shot dies
          // outright. It gives the precision mode a reason to exist once the
          // crowd is already softened, and it is the loop that makes picking
          // targets feel better than spraying.
          const hitKind = crit ? "crit" : weak ? "weak" : null;
          const exec = o.fireMode === "single" && !w.boss &&
                       w.hp <= w.maxHp * CFG.execAt && w.hp > 0;
          if (exec) {
            S.freeze = Math.max(S.freeze, 0.13);
            banner("EXECUTE");
            SFX.weak();
            sparks(tmp3.set(o.pos.x, 1.8, o.pos.z), 0xffd23c, 16, 22);
            damageWalker(w, w.hp + 1, tmp, 4.5*(o.def.knock||1), "impact");
          } else {
            // Piercing props read as a different kill from a blunt impact,
            // and the style system pays for the distinction.
            damageWalker(w, dmg, tmp, 4.5*(o.def.knock||1),
                         hitKind || ((o.def.pierce && o.pierced > 0) ? "pierce" : "impact"));
          }
          noteVolleyHit(o, o.pos);
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
            o.fireMode = null; o.volleyId = -1;  // no longer an aimed shot
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
    S.recycleT = 3.0;
    // The trigger is ARENA stock now, not what is under the player's feet.
    // Only props consumed outright — detonated barrels, spilled chem — come
    // back, and they come back far away. A prop lying somewhere inconvenient
    // is not restocked; going to fetch it IS the decision.
    let stock = 0, dead = 0;
    for (const o of rocks) {
      if (o.gone) dead++;
      else if (!o.held) stock++;
    }
    if (stock < CFG.arenaStock * DIFF.stock && dead > 0) {
      let moved = 0;
      for (const o of rocks) {
        if (moved >= 2) break;
        if (o.gone) { recycleObject(o); moved++; }
      }
    }
  }

  // Live count of what is actually reachable, for the HUD and the warning.
  S.reachT -= dt;
  if (S.reachT <= 0) {
    S.reachT = 0.25;
    let n = 0;
    for (const o of rocks)
      if (!o.gone && !o.held && o.seekT <= 0 && o.pos.distanceTo(hero.pos) < grabReach()) n++;
    S.inReach = n;
    const ammo = el("ammo");
    if (ammo) {
      ammo.textContent = n;
      el("ammoWrap").classList.toggle("dry", n === 0);
      el("ammoWrap").classList.toggle("low", n > 0 && n <= 2);
    }
    // Only nags when it is actionable: empty-handed with nothing in reach.
    if (n === 0 && !S.held.length && S.phase === "play") {
      if (!S.dryWarned) { S.dryWarned = true; toast("NO OBJECTS IN RANGE — move", 2000); }
    } else S.dryWarned = false;
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
      if (Math.hypot(w.pos.x-p.pos.x, w.pos.z-p.pos.z) < p.r) damageWalker(w, p.dps*dt, null, 0, "chem");
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

  // Style bleeds once you stop killing. The grace window is generous enough
  // to cross the arena, short enough that camping loses the rank you earned.
  if (S.style > 0) {
    if (S.styleT > 0) S.styleT -= dt;
    else {
      const was = S.rank;
      // Bleed proportionally: a high rank you fought for takes a while to
      // lose, a low one does not evaporate before you can reach the next
      // target. A flat rate made D→C feel like it never stuck.
      const rate = CFG.styleDecay * (0.4 + 0.6*(S.style/STYLE_MAX));
      S.style = Math.max(0, S.style - rate*dt);
      const r = rankFor(S.style);
      if (r.name !== was) { S.rank = r.name; SFX.rankDown(); }
    }
  }
  if (OD.on) {
    OD.t -= dt;
    S.kinetic = Math.max(0, OD.t / CFG.odTime);
    if (OD.t <= 0) endOverdrive();
  }
  // Ground shockwaves. A ring races outward; it catches you only if you are
  // standing on the floor when it passes. Jumping over it is the counter, and
  // it is the same jump button that already dodges an ordinary swipe.
  for (let i = shocks.length-1; i >= 0; i--) {
    const sw = shocks[i];
    const prev = sw.r;
    sw.r += 26*dt;
    const d = Math.hypot(hero.pos.x-sw.pos.x, hero.pos.z-sw.pos.z);
    if (!sw.hit && d >= prev && d < sw.r && hero.pos.y < CFG.dodgeHeight) {
      sw.hit = true;
      hurtHero();
      SFX.hurt();
      S.shake = Math.min(1.2, S.shake + 0.7);
      el("dmg").classList.add("on");
      setTimeout(() => el("dmg").classList.remove("on"), 220);
      updateHUD();
      if (hero.hp <= 0) { gameOver(); return; }
    }
    // It knocks the loose props about too, which is half the spectacle.
    for (const o of rocks) {
      if (o.gone || o.held) continue;
      const od = Math.hypot(o.pos.x-sw.pos.x, o.pos.z-sw.pos.z);
      if (od >= prev && od < sw.r) {
        tmp.set(o.pos.x-sw.pos.x, 0.6, o.pos.z-sw.pos.z).normalize();
        o.vel.addScaledVector(tmp, 16/Math.max(0.6, o.def.mass));
      }
    }
    sw.mesh.scale.setScalar(sw.r);
    // Fades as it widens, so the leading edge stays the readable part.
    sw.mesh.material.opacity = 0.9 * (1 - sw.r/sw.max) + 0.12;
    if (sw.r >= sw.max) { killShock(sw); shocks.splice(i,1); }
  }

  // Kinetic zones: vent strain fast inside one, and pull the horde to it.
  for (let i = zones.length-1; i >= 0; i--) {
    const z = zones[i];
    z.life -= dt;
    const pulse = 0.35 + 0.25*Math.sin(S.t*3);
    z.mesh.material.opacity = pulse;
    z.disc.material.opacity = pulse*0.22;
    if (z.life <= 0) {
      scene.remove(z.mesh); scene.remove(z.disc);
      z.mesh.geometry.dispose(); z.disc.geometry.dispose();
      zones.splice(i,1);
      continue;
    }
    // Everything is drawn to it, which is the cost of standing there.
    for (const w of walkers) {
      if (w.dead || w.thrown > 0) continue;
      const dx = z.pos.x - w.pos.x, dz = z.pos.z - w.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.5 && d < 26) { w.pos.x += (dx/d)*1.1*dt; w.pos.z += (dz/d)*1.1*dt; }
    }
    if (Math.hypot(hero.pos.x-z.pos.x, hero.pos.z-z.pos.z) < CFG.zoneR) {
      S.strain = Math.max(0, S.strain - 0.55*dt);
      addKinetic(0.035*dt);
      S.inZone = true;
    }
  }

  // Reinforcement clock.
  if (S.phase === "play") {
    S.waveT += dt;
    tickEvents(dt, S.wave);
    while (spawnQ.length && spawnQ[0].at <= S.waveT) {
      const g = spawnQ.shift();
      reinforce(g.types);
    }
  }
  if (volley.t > 0) volley.t -= dt;
  if (S.comboT > 0) {
    S.comboT -= dt;
    if (S.comboT <= 0 && S.combo) { S.combo = 0; updateHUD(); }
  }

  updateTethers();
  updateAuras();

  motes.rotation.y += dt*0.012;
  motes.position.y = Math.sin(S.t*0.25)*0.4;

  S.shake *= 0.88;

  // ---- crosshair lock
  S.lock = nearestInCone();
  el("cross").classList.toggle("lock", !!S.lock);
  el("cross").classList.toggle("armed", S.held.length > 0);

  // ---- camera
  // Ease toward the requested distance rather than snapping to it.
  cam.dist += (cam.distWant - cam.dist) * Math.min(1, 9*dt);
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

  if (alive === 0 && spawnQ.length === 0 && S.phase === "play") {
    S.phase = "clear"; setTimeout(nextWave, 1200);
  }
  // Cleared the field early but reinforcements are still coming: pull the
  // next pulse forward rather than making the player stand in an empty arena.
  else if (alive === 0 && spawnQ.length && S.phase === "play") {
    spawnQ[0].at = Math.min(spawnQ[0].at, S.waveT + 1.2);
  }
}

function nextWave() {
  // Killing the Maw ends the ARC. It does not have to end the run: the late
  // scaling, the arena cycling and the elite ramp all exist and were
  // previously unreachable, because the run stopped at wave 11 before any of
  // it could happen.
  if (S.wave >= WAVES.length && !S.endless) {
    S.phase = "done";
    show(`<h1>Survived</h1>${runSummary()}
          <p class="rule">The Maw is down. Nothing walked away from you.</p>
          <button id="endless">Keep going</button>
          <button id="again" class="ghost">Finish here</button>`);
    el("again").onclick = restart;
    el("endless").onclick = () => {
      S.endless = true;
      banner("ENDLESS");
      offerDraft();
    };
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

// The scoreboard the end screens share: what this run did, and whether any
// of it was the best you have managed.
function runSummary() {
  const beat = recordRun();
  const row = (label, val, isBest) =>
    `<div class="stat"><span>${label}</span><b class="${isBest ? "best" : ""}">${val}` +
    (isBest ? ' <i class="pb">best</i>' : '') + `</b></div>`;
  return `<div class="stats">
      ${row("Score", S.score.toLocaleString(), beat.score)}
      ${row("Wave reached", S.wave, beat.wave)}
      ${row("Style rank", S.rank, beat.rank)}
      ${row("Put down", S.kills, false)}
    </div>
    <p class="rule career">Career · ${PROFILE.runs} run${PROFILE.runs === 1 ? "" : "s"}
       · ${PROFILE.kills.toLocaleString()} killed
       · best ${PROFILE.best.toLocaleString()} (wave ${PROFILE.bestWave}, rank ${PROFILE.bestRank})
       · ${Object.keys(PROFILE.seen).length}/${MODIFIERS.length} conditions met</p>`;
}

function gameOver() {
  S.phase = "dead";
  show(`<h1>Overrun</h1>${runSummary()}
        <p class="rule">They got close enough to touch you.</p><button id="again">Try again</button>`);
  el("again").onclick = restart;
}

function show(html) {
  el("card").innerHTML = html;
  el("modName2").classList.remove("show");
  el("bossBar").classList.remove("show");
  el("overlay").classList.remove("hide");
  ["hud","touch","cross"].forEach(i => el(i).classList.add("hide"));
}

function restart() {
  // A run's build does not carry into the next one.
  Object.assign(MOD, { singleDmg:1, burstDmg:1, allDmg:1, maxHeld:0, grabR:0,
    focusRegen:1, hpBonus:0, berserk:false, gravity:false, voidwell:false,
    lightning:0, blastR:1, blastDmg:1, arcHops:3,
    singularity:false, marksman:false, secondWind:false, avalanche:false });
  SYNERGIES.forEach(sy => { sy.got = false; });
  taken.length = 0;
  S.wave = 1; S.kills = 0; S.score = 0; hero.hp = CFG.maxHealth; S.modeCd = 0;
  S.style = 0; S.styleT = 0; S.rank = "D"; S.recent.length = 0; S.endless = false;
  buildArena(ARENAS[0]);
  el("arena").textContent = ARENAS[0].name;
  S.kinetic = 0; endOverdrive();
  start();
}

// Adaptive quality. Bloom re-renders the scene several times at reduced
// resolution, which a desktop GPU shrugs off and a weak phone does not.
// Rather than guess the target device, sample the real framerate for the
// first few seconds of play and drop the expensive pass if it cannot hold up.
// Realistic surfaces are fragment work: a normal map, a roughness map and a
// prefiltered environment on every material is roughly 3x the per-pixel cost
// of the flat-shaded version this replaced. That is nothing on a real GPU and
// fatal on a weak one, so quality is a ladder the game walks DOWN on its own
// rather than a guess about the device.
//
// HIGH  everything
// MED   no bloom, native pixel ratio, half the ground cover
// LOW   surface maps stripped, no environment probe, small shadow map
let quality = "high";
let fxOn = true, fpsFrames = 0, fpsT0 = 0, stage = 0;

// Every material carrying surface detail, so LOW can strip them in one pass.
// Registered explicitly rather than discovered by traversing the scene,
// because instanced and pooled meshes are not all attached when this runs.
const SURFACED = [];

// Registered in one block after every module-level material exists, rather
// than wrapped at each declaration — the list is the point, and a list is
// easier to keep honest than seventeen call sites.
[groundMat, clearMat, trunkMat, foliaA, foliaB, scrubMat, boleMat, stoneMat,
 logMat, rockMat, skin, cloak, under, leather, zSkin, zRot, zRag]
  .forEach(m => SURFACED.push(m));

function stripSurface(m) {
  if (!m || !m.isMeshStandardMaterial) return;
  m.normalMap = null;
  m.roughnessMap = null;
  m.envMapIntensity = 0;
  m.needsUpdate = true;
}

function setQuality(q) {
  if (q === quality) return;
  quality = q;

  if (q !== "high") {
    // MED keeps the grade and the edge cleanup — they are nearly free and
    // they carry most of the look — but drops bloom and ambient occlusion,
    // which are the passes that actually cost.
    gtao.enabled = false;
    bloom.enabled = false;
    renderer.setPixelRatio(1);
  }
  if (q === "low") {
    // LOW drops the composer entirely and renders straight to the screen.
    fxOn = false;
  }
  if (q === "low") {
    SURFACED.forEach(stripSurface);
    // Props and enemies mint their own materials at spawn; the ones already
    // standing have to be caught by a sweep, and the ones spawned later are
    // caught by the quality check in their factories.
    scene.traverse(o => {
      if (!o.material) return;
      if (Array.isArray(o.material)) o.material.forEach(stripSurface);
      else stripSurface(o.material);
    });
    scene.environment = null;
    sun.shadow.mapSize.set(1024, 1024);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    scrub.count = Math.min(scrub.count, 60);
  } else if (q === "med") {
    scene.environmentIntensity = 0.5;
  }
  resize();
}

// Sampled against the WALL CLOCK, deliberately not the simulation clock: dt
// is clamped to 1/30, so measuring against it caps the computed rate at 30
// and would condemn every machine, fast or slow.
function judgeFrame(now) {
  if (stage > 1) return;
  if (!fpsT0) { fpsT0 = now; return; }
  fpsFrames++;
  const elapsed = (now - fpsT0) / 1000;
  if (elapsed < 3) return;
  const fps = fpsFrames / elapsed;
  fpsFrames = 0; fpsT0 = now;
  if (stage === 0) {
    if (fps < 40) { setQuality("med"); toast("Effects reduced to keep it smooth", 2600); }
    stage = 1;
  } else {
    // A second window, so a machine that is merely loading is not condemned
    // by the first three seconds of a run.
    if (fps < 34) { setQuality("low"); toast("Detail reduced to keep it smooth", 2600); }
    stage = 2;
  }
}

let last = performance.now();
function frame(now) {
  const real = Math.min((now-last)/1000, 1/30);
  last = now;
  // Hit stop. A few frames of near-frozen time on a heavy hit is the single
  // cheapest way to make an impact land: the eye reads the pause as weight.
  // Real time still advances so the freeze always ends.
  let dt = real;
  if (S.freeze > 0) { S.freeze -= real; dt = real * 0.14; }
  if (S.phase === "play" || S.phase === "clear") {
    step(dt);
    judgeFrame(now);
  }
  if (fxOn) { grade.uniforms.uTime.value = now * 0.001; composer.render(); }
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

// Difficulty picker on the menu. Remembered between sessions.
// Remembered zoom, restored before the first frame.
(function initZoom() {
  let z = NaN;
  try { z = parseFloat(localStorage.getItem("kinesis.zoom")); } catch (e) {}
  if (isFinite(z)) { cam.distWant = clamp(z, CFG.camMin, CFG.camMax); cam.dist = cam.distWant; }
})();

(function initDifficulty() {
  let saved = "normal";
  try { saved = localStorage.getItem("kinesis.diff") || "normal"; } catch (e) {}
  if (!DIFFS[saved]) saved = "normal";
  setDifficulty(saved);
  const box = el("diffPick");
  if (!box) return;
  for (const key in DIFFS) {
    const btn = document.createElement("button");
    btn.className = "diffBtn" + (key === saved ? " on" : "");
    btn.innerHTML = '<b>' + DIFFS[key].name + '</b><i>' + DIFFS[key].desc + '</i>';
    btn.onclick = () => {
      setDifficulty(key);
      [...box.children].forEach(c => c.classList.remove("on"));
      btn.classList.add("on");
    };
    box.appendChild(btn);
  }
})();

// The module-level declarations create the meshes; nothing is placed until
// here, so the opening arena goes through exactly the same path as every
// later one rather than being a special case built inline.
buildArena(ARENAS[0]);
el("arena").textContent = ARENAS[0].name;

loadProfile();
if (PROFILE.runs > 0) {
  const m = el("menuBest");
  if (m) {
    m.innerHTML = `Best ${PROFILE.best.toLocaleString()} · wave ${PROFILE.bestWave}` +
                  ` · rank ${PROFILE.bestRank} · ${PROFILE.kills.toLocaleString()} put down`;
    m.classList.add("show");
  }
}
resize();
requestAnimationFrame(frame);
})();
