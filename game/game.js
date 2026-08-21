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
  enemyMul:     4.0,     // every wave composition is quadrupled (was 2.0)
  // Doubled from 0.01. Contact damage is a flat one heart, so damage cannot be
  // scaled without jumping from survivable to lethal — survivability is the
  // only lever that compounds smoothly. At 2% a wave-20 body carries ~1.46x
  // its base health against ~1.21x before, and wave 30 ~1.78x against ~1.34x.
  waveStrength: 0.02,    // compounding survivability per wave: 2% = 1.02^(n-1)
  // Hard ceiling on bodies per wave, applied AFTER every multiplier. The
  // separation pass is O(n^2), so this is the knob that decides how much
  // quadratic work a frame carries.
  //
  // Raised 44 -> 88 alongside the multiplier above, because leaving it at 44
  // would have made the increase a no-op exactly where it matters: measured
  // roster at the old settings was already pinned to the cap from wave 15
  // onward, so a bigger multiplier changed nothing past that point and only
  // steepened the early waves.
  //
  // Affordable, measured rather than assumed. step() is pure CPU — AI,
  // physics and separation, no rendering — and costs 0.21ms at 44 bodies,
  // 0.35ms at 88 and 0.73ms at 120. Even 120 is 4.4% of a 60fps frame. The
  // quadratic term is real but small against everything else in the loop.
  //
  // What this does NOT measure is the cost of RENDERING 88 rigs, which is the
  // larger risk on a weak device. That is what the quality ladder is for: it
  // samples real framerate and walks HIGH -> MED -> LOW on its own.
  maxWaveBodies: 88,

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
  // 1.15 -> 0.95: melee bodies swing ~21% more often. This is threat that does
  // not touch the damage cliff and does not bloat health — a crowd that keeps
  // committing is harder to stand in the middle of, which is exactly the
  // pressure the ring of fire otherwise removes.
  zCooldown:    0.95,
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
// Elara's palette, off the reference: deep indigo outer robe, violet inner,
// warm brown leather, and gold for every edge.
const cloak  = new T.MeshStandardMaterial({
  color: 0x2b2a5e, roughness: 0.82, metalness: 0.03,
  normalMap: TEX.clothN, normalScale: new T.Vector2(1.5,1.5), envMapIntensity: 0.5 });
const under  = new T.MeshStandardMaterial({
  color: 0x5b3f8c, roughness: 0.8, metalness: 0.03,
  normalMap: TEX.clothN, normalScale: new T.Vector2(1.2,1.2), envMapIntensity: 0.5 });
const leather= new T.MeshStandardMaterial({
  color: 0x5c4030, roughness: 0.62, metalness: 0.06,
  normalMap: TEX.clothN, normalScale: new T.Vector2(1.1,1.1), envMapIntensity: 0.8 });
// Gold filigree. Metal, not emissive — it should catch the key light and the
// sky probe rather than glow on its own, which is what makes it read as
// metal thread instead of neon piping.
const gold   = new T.MeshStandardMaterial({
  color: 0xd9a441, roughness: 0.28, metalness: 0.9, envMapIntensity: 1.4 });
const hairM  = new T.MeshStandardMaterial({
  color: 0x6f52c8, roughness: 0.5, metalness: 0.05,
  normalMap: TEX.clothN, normalScale: new T.Vector2(0.8,0.8), envMapIntensity: 0.7 });
const crystalM = new T.MeshStandardMaterial({
  color: 0x7fe8ff, roughness: 0.12, metalness: 0.1,
  emissive: 0x39c8f0, emissiveIntensity: 1.1, flatShading: true });
const woodM  = new T.MeshStandardMaterial({
  color: 0x6b4a30, roughness: 0.85, metalness: 0.02,
  normalMap: TEX.barkN, normalScale: new T.Vector2(1.2,1.2), envMapIntensity: 0.4 });
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

// Head. The reference has a visible face under swept-up violet hair rather
// than an anonymous hood, so the hood is pushed back onto the shoulders and
// the face is left showing. The glowing bar stays as a narrow visor across
// the eyes — at fighting distance a face reads as a smudge, and the game
// needs something on the head that carries.
HERO.add(part(new T.SphereGeometry(0.235, 16, 12), skin, 0, 2.06, 0));

// Hair: a swept mass at the back and crown, with a raised sweep on top.
const hair = new T.Group();
hair.position.set(0, 2.10, 0);
HERO.add(hair);
// Pushed back and flattened at the front. At z -0.06 with a 1.12 depth scale
// the hair reached z +0.23 and the skull's face is at +0.235 — it swallowed
// the face entirely and the head rendered as a featureless violet dome.
const hairBack = part(new T.SphereGeometry(0.25, 14, 10), hairM, 0, 0.02, -0.14);
hairBack.scale.set(1.02, 1.06, 1.0);
hair.add(hairBack);
const hairTop = part(new T.SphereGeometry(0.175, 12, 9), hairM, 0, 0.17, -0.09);
hairTop.scale.set(1.06, 0.8, 0.95);
hair.add(hairTop);
// A fringe sweeping across one side of the brow, which is what stops the
// front reading as a bald forehead.
const fringe = part(new T.SphereGeometry(0.13, 10, 8), hairM, -0.09, 0.10, 0.10);
fringe.scale.set(1.1, 0.55, 0.75);
fringe.rotation.z = 0.4;
hair.add(fringe);
// The tail, falling behind the shoulder.
const tail = part(new T.CapsuleGeometry(0.085, 0.42, 5, 9), hairM, 0, -0.30, -0.20);
tail.rotation.x = -0.30;
hair.add(tail);

// Hood, thrown back so it sits between the shoulder blades.
const hood = part(new T.SphereGeometry(0.25, 12, 9), cloak, 0, 1.83, -0.24);
hood.scale.set(1.0, 0.72, 0.85);
HERO.add(hood);

const visor = part(new T.BoxGeometry(0.30, 0.055, 0.05), trim, 0, 2.06, 0.225);
HERO.add(visor);

// Belt with a gold buckle, and the sternum focus stone.
HERO.add(part(new T.CylinderGeometry(0.41, 0.41, 0.11, 10), leather, 0, 1.02, 0));
HERO.add(part(new T.CylinderGeometry(0.415, 0.415, 0.035, 10), gold, 0, 1.08, 0));
HERO.add(part(new T.BoxGeometry(0.14, 0.13, 0.06), gold, 0, 1.02, 0.40));
const strap = part(new T.BoxGeometry(0.13, 0.66, 0.42), leather, -0.07, 1.45, 0);
strap.rotation.z = 0.28;
HERO.add(strap);
HERO.add(part(new T.OctahedronGeometry(0.10, 0), trim, 0.02, 1.62, 0.30));

// Gold edging: collar ring, cuff bands, and a vertical placket down the
// chest. Thin rings and boxes, but they are what turn a coloured robe into
// a made garment.
// `HERO.add(x)` returns HERO, not x — chaining `.rotation.x` onto it lays the
// whole character on its back. Same trap as the Maw's neck; keep the handle.
const collar = part(new T.TorusGeometry(0.30, 0.022, 6, 18), gold, 0, 1.90, 0);
collar.rotation.x = Math.PI/2;
HERO.add(collar);
HERO.add(part(new T.BoxGeometry(0.055, 0.72, 0.03), gold, 0, 1.44, 0.305));
HERO.add(part(new T.BoxGeometry(0.20, 0.03, 0.03), gold, 0, 1.10, 0.31));

// Split robe panels hanging from the belt, front and back, gold-edged. These
// are what give the silhouette its length now that the skirt is short enough
// to show the legs.
const panelF = part(new T.BoxGeometry(0.30, 0.86, 0.035), cloak, 0, 0.70, 0.30);
panelF.rotation.x = -0.06;
HERO.add(panelF);
HERO.add(part(new T.BoxGeometry(0.325, 0.05, 0.04), gold, 0, 0.30, 0.312));
const panelB = part(new T.BoxGeometry(0.40, 0.98, 0.035), cloak, 0, 0.66, -0.30);
panelB.rotation.x = 0.05;
HERO.add(panelB);
HERO.add(part(new T.BoxGeometry(0.425, 0.05, 0.04), gold, 0, 0.20, -0.312));

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

// ── the staff
// Parented to the LEFT FOREARM, so it inherits the gait and the channelling
// pose for free rather than needing its own animation. Raising both arms to
// channel now reads as raising the staff, which is exactly right.
const staff = new T.Group();
staff.position.set(0, -0.26, 0.04);
staff.rotation.x = 0.12;
armL.joint.add(staff);

// Shaft, slightly tapered, with two binding rings.
staff.add(part(new T.CylinderGeometry(0.032, 0.042, 1.95, 8), woodM, 0, 0.52, 0));
const ring1 = part(new T.TorusGeometry(0.047, 0.012, 5, 12), gold, 0, 1.12, 0);
ring1.rotation.x = Math.PI/2; staff.add(ring1);
const ring2 = part(new T.TorusGeometry(0.049, 0.012, 5, 12), gold, 0, -0.26, 0);
ring2.rotation.x = Math.PI/2; staff.add(ring2);

// Crystal cluster at the head: three shards of different heights, splayed,
// plus a light so it actually casts onto the ground near the player.
const crystal = new T.Group();
crystal.position.y = 1.34;
staff.add(crystal);
const shard = (h, r, tilt, spin, y) => {
  const m = part(new T.ConeGeometry(r, h, 5), crystalM, 0, y + h/2, 0);
  const g2 = new T.Group();
  g2.rotation.set(tilt, spin, 0);
  g2.add(m);
  crystal.add(g2);
  return m;
};
shard(0.52, 0.085, 0, 0, 0);
shard(0.34, 0.06, 0.34, 0, 0.02);
shard(0.30, 0.055, -0.30, 1.9, 0.02);
shard(0.22, 0.05, 0.28, 3.6, 0.0);
// The cradle the shards sit in.
const cradle = part(new T.ConeGeometry(0.10, 0.22, 6), gold, 0, 0.02, 0);
cradle.rotation.x = Math.PI;
crystal.add(cradle);

const staffLight = new T.PointLight(0x5fd8ff, 1.1, 6.5, 2);
staffLight.position.y = 1.62;
staff.add(staffLight);

const aura = new T.Mesh(new T.SphereGeometry(1.55,22,16),
  new T.MeshBasicMaterial({ color:0xe94fbf, transparent:true, opacity:0, side:T.BackSide }));
aura.position.y = 1.3;
HERO.add(aura);

const hero = { pos: new T.Vector3(0,0,0), yaw: 0, walk: 0, hp: CFG.maxHealth,
  speed: 0, gait: 0, lastX: 0, lastZ: 0,
               vy: 0, grounded: true };

// Irregular flicker in [-1,1]. Three sines at non-harmonic ratios, so the sum
// never repeats on a human timescale. A single sine is a pulse, and a pulse
// reads as breathing rather than burning. Shared by both fire effects: the ring
// of fire below and the control aura's plume.
function flick(x) {
  return 0.53*Math.sin(x) + 0.31*Math.sin(x*2.37 + 1.13) + 0.16*Math.sin(x*4.61 + 2.71);
}

// ═══════════════════════════════════════════════════════════════ ring of fire
// An orbiting hazard rather than another thing to aim. It rewards standing in
// the crowd, which is the opposite of everything else in the kit — telekinesis
// wants distance, the ring wants you close — so the two pull against each
// other instead of stacking into one dominant style.
//
// Three ranks. Each adds an orb, widens the orbit and raises the damage, so a
// rank-3 ring sweeps a genuinely different volume from a rank-1 one and is not
// merely a bigger number.
const RING = {
  // A rank adds a ring. Three concentric walls of fire at rank 3, each its own
  // damage band, so a body walking in from outside has to cross all three —
  // which is what makes the upgrade feel like more fire rather than a bigger
  // number. Per-ring damage drops as ranks are added, because total output
  // against anything closing on you roughly triples otherwise.
  // Spaced so the gaps between rings are genuinely safe. At 3.3/5.5/7.7 with
  // the old band width the damage zones overlapped, and standing BETWEEN two
  // rings burned 58 where standing on one burned 29 — the pocket that should
  // have been shelter was the worst place on the field. Only the very largest
  // bodies now span two bands, which is fair: they are wide enough to touch both.
  radii: [3.2, 5.8, 8.4],
  levels: [
    null,
    { rings:1, dps:64, height:1.60, glow:0.90 },
    { rings:2, dps:52, height:1.85, glow:1.05 },
    { rings:3, dps:44, height:2.10, glow:1.20 },
  ],
  tick: 0.22,          // seconds between damage applications per body per ring
};

const ringState = { lv:0, ang:0, orbs:[], group:null, cool:new Map() };

// A procedural flame sheet. Tiles horizontally, so it can be wrapped around a
// cylinder and scrolled forever without a seam — every term below is a sine at
// an INTEGER frequency over 0..1 for exactly that reason. Alpha carries the
// tongue shapes; colour runs white-hot at the base through orange to deep red
// at the tips, which is what makes a flat sheet read as fire rather than paint.
function flameSheet(w, h, seed) {
  const c = canvasOf(1); c.width = w; c.height = h;
  const x = c.getContext("2d");
  const img = x.createImageData(w, h);
  let sd = seed >>> 0;
  const rr = () => (sd = (sd*1664525 + 1013904223) >>> 0) / 4294967296;
  // a handful of random phases, fixed up front so the field is stable
  const ph = []; for (let i = 0; i < 10; i++) ph.push(rr()*Math.PI*2);

  for (let i = 0; i < w; i++) {
    const u = i / w, a = u * Math.PI * 2;
    // Layered integer harmonics. More terms at lower amplitude gives wavy
    // licks; three big terms gave sharp triangular spikes.
    let top = 0.44
      + 0.17 * Math.sin(a*3  + ph[0])
      + 0.12 * Math.sin(a*5  + ph[1])
      + 0.09 * Math.sin(a*8  + ph[2])
      + 0.06 * Math.sin(a*13 + ph[3])
      + 0.04 * Math.sin(a*21 + ph[6]);
    top = Math.max(0.14, Math.min(0.96, top));

    for (let j = 0; j < h; j++) {
      const v = 1 - j / h;                     // 0 at the top, 1 at the base
      const k = (j*w + i) * 4;
      if (v > top) { img.data[k+3] = 0; continue; }
      const t = v / top;                        // 0 at the tip, 1 at the base

      // Palette pushed warm. An almost-white core over three ADDITIVE layers
      // blew the whole ring out to white — additive stacking is what turns a
      // pale core into a floodlight. The hottest point is now a deep amber and
      // the tips run to red, which is what fire looks like from outside it.
      let R, G, B;
      if (t > 0.86)      { R=255; G=226; B=150; }
      else if (t > 0.58) { const f=(t-0.58)/0.28; R=255; G=150+f*70; B=36+f*100; }
      else if (t > 0.30) { const f=(t-0.30)/0.28; R=252; G=76+f*72;  B=14+f*20; }
      else               { const f=t/0.30;        R=182+f*70; G=22+f*52; B=8+f*6; }

      // Soft shoulder at the tip instead of a hard cut, so the flame fades out
      // rather than ending in a point.
      const edge = 0.55 + 0.45*Math.sin(a*17 + ph[4] + v*9);
      const tipFade = Math.min(1, Math.max(0, (t - 0.06*edge) / 0.30));
      const flick = 0.80 + 0.20*Math.sin(a*11 + ph[5] + v*13);
      const alpha = tipFade * tipFade * flick;   // squared: gentler shoulder

      img.data[k]   = R;
      img.data[k+1] = G;
      img.data[k+2] = B;
      img.data[k+3] = alpha * 255;
    }
  }
  x.putImageData(img, 0, 0);
  const tex = new T.CanvasTexture(c);
  tex.wrapS = T.RepeatWrapping;
  tex.wrapT = T.ClampToEdgeWrapping;
  tex.colorSpace = T.SRGBColorSpace;
  return tex;
}

// Two sheets at different seeds. Counter-scrolling them at different speeds is
// what turns a repeating band into something that churns.
const flameTexA = flameSheet(512, 128, 0x1f3a);
const flameTexB = flameSheet(512, 128, 0x77c1);
const flameMatA = new T.MeshBasicMaterial({ map:flameTexA, transparent:true,
  blending:T.AdditiveBlending, depthWrite:false, side:T.DoubleSide, opacity:0.78 });
const flameMatB = new T.MeshBasicMaterial({ map:flameTexB, transparent:true,
  blending:T.AdditiveBlending, depthWrite:false, side:T.DoubleSide, opacity:0.52 });

// The scorched ground under the ring — a soft annulus, so the hitbox is
// legible from directly overhead where the vertical curtain is edge-on.
function groundGlowTexture() {
  const c = canvasOf(128), x = c.getContext("2d");
  const g = x.createRadialGradient(64,64,0, 64,64,64);
  g.addColorStop(0.00, "rgba(0,0,0,0)");
  g.addColorStop(0.62, "rgba(0,0,0,0)");
  g.addColorStop(0.78, "rgba(255,140,40,0.55)");
  g.addColorStop(0.90, "rgba(255,70,20,0.42)");
  g.addColorStop(1.00, "rgba(120,20,0,0)");
  x.fillStyle = g; x.fillRect(0,0,128,128);
  const t = new T.CanvasTexture(c);
  t.colorSpace = T.SRGBColorSpace;
  return t;
}
const groundGlowMat = new T.MeshBasicMaterial({ map:groundGlowTexture(),
  transparent:true, blending:T.AdditiveBlending, depthWrite:false, side:T.DoubleSide });

function buildRingOrbs() {
  if (!ringState.group) { ringState.group = new T.Group(); scene.add(ringState.group); }
  const g = ringState.group;
  while (g.children.length) { const c = g.children.pop(); disposeGroup(c); }
  ringState.curtains = [];
  ringState.disc = null; ringState.light = null;
  if (!ringState.lv) return;
  const L = RING.levels[ringState.lv];

  // Two counter-scrolling layers per ring rather than three. At rank 3 that is
  // six curtains already; a third layer each would be nine transparent
  // additive cylinders stacked over the same pixels, which is exactly the kind
  // of overdraw that costs frames for nothing anyone can see.
  for (let i = 0; i < L.rings; i++) {
    const R = RING.radii[i];
    const h = L.height * (1 - i*0.10);        // outer rings sit slightly lower
    const layers = [
      { r:R,        mat:flameMatA, rep:4+i, spd: 0.85 - i*0.22, op:0.80 },
      { r:R + 0.26, mat:flameMatB, rep:5+i, spd:-1.15 + i*0.20, op:0.40 },
    ];
    for (let li = 0; li < layers.length; li++) {
      const cfg = layers[li];
      const mat = cfg.mat.clone();
      mat.map = cfg.mat.map.clone();
      mat.map.needsUpdate = true;
      mat.map.wrapS = T.RepeatWrapping;
      mat.map.repeat.set(cfg.rep, 1);
      mat.opacity = cfg.op * L.glow;
      mat._own = true;
      const geo = new T.CylinderGeometry(cfg.r, cfg.r*0.94, h, 44, 1, true);
      const m = new T.Mesh(geo, mat);
      m.position.y = h/2;
      g.add(m);
      // Its own phase, so no two curtains surge or lick together. Sharing one
      // phase is what made six curtains read as a single turning barrel.
      ringState.curtains.push({ mesh:m, mat, spd:cfg.spd, baseY: h/2,
                                phase: i*2.7 + li*1.31 });
    }
  }

  // Ground scorch sized to the outermost ring, so the whole danger zone is
  // legible from directly overhead where the curtains are edge-on.
  const outer = RING.radii[L.rings-1];
  const gm = groundGlowMat.clone(); gm._own = true;
  // 0.7 additive across a 21-unit plane turned the entire arena floor into a
  // yellow haze that swallowed the trees, the props and the bodies. The disc
  // exists only to keep the ring readable from directly overhead; it should
  // be a hint under the fire, not a light source.
  gm.opacity = 0.26 * L.glow;
  const disc = new T.Mesh(new T.PlaneGeometry(outer*2.6, outer*2.6), gm);
  disc.rotation.x = -Math.PI/2; disc.position.y = 0.06;
  g.add(disc);
  ringState.disc = disc;

  const lt = new T.PointLight(0xff6a1e, 1.5*L.glow, outer*2.2, 2.0);
  lt.position.y = L.height*0.6;
  g.add(lt);
  ringState.light = lt;
}

function ringUpgrade() {
  if (ringState.lv >= 3) return;
  ringState.lv++;
  buildRingOrbs();
  const L = RING.levels[ringState.lv];
  banner("RING OF FIRE · " + ringState.lv);
  toast(L.rings + (L.rings===1?" ring":" rings") + " · " +
        Math.round(L.dps) + " dps each", 2800);
  SFX.overload();
  S.shake = Math.min(1.0, S.shake + 0.35);
}

function stepRing(dt) {
  const g = ringState.group;
  if (!ringState.lv || !g) return;
  const L = RING.levels[ringState.lv];
  g.position.set(hero.pos.x, 0, hero.pos.z);

  // Scrolling the texture instead of moving geometry: the churn is free, and
  // counter-scrolling layers at different rates is what stops a repeating band
  // from reading as a repeat.
  for (const c of ringState.curtains) {
    // Fire rises; it does not travel around the ring. The lateral scroll is
    // therefore cut to a drift and allowed to stall outright — a surge floor
    // above zero still slides continuously, which the eye reads as a barrel
    // turning past you no matter how the rate is modulated.
    const surge = 0.06 + 0.94*(0.5 + 0.5*flick(S.t*1.9 + c.phase));
    c.mat.map.offset.x = (c.mat.map.offset.x + dt*c.spd*0.45*surge) % 1;
    // With the travel quietened, the vertical lick carries the motion. Each
    // curtain reaches its own height, irregularly, and guts low now and then;
    // one shared sine had all six breathing as a single cylinder.
    c.mesh.scale.y = 0.80 + 0.48*(0.5 + 0.5*flick(S.t*3.6 + c.phase*1.7));
    // A small leap on top of the stretch, out of phase with it, so the tips
    // detach and recover instead of the whole wall inflating as one piece.
    c.mesh.position.y = c.baseY * (1 + 0.06*flick(S.t*4.7 + c.phase*2.3));
    // A slight radial billow. Kept to 2% because this wall is a hitbox as well
    // as an effect, and a flame that visibly breathes past its damage band
    // teaches the player the wrong edge.
    const billow = 1 + 0.02*flick(S.t*2.4 + c.phase*0.9);
    c.mesh.scale.x = c.mesh.scale.z = billow;
  }
  // Firelight flickers; it does not throb. This is most of what sells fire at
  // the edge of vision, where the curtain itself is only a glow.
  if (ringState.disc)
    ringState.disc.material.opacity = (0.24 + 0.07*flick(S.t*3.7)) * L.glow;
  if (ringState.light)
    ringState.light.intensity = (1.4 + 0.42*flick(S.t*5.3 + 1.7)) * L.glow;

  // ── damage ──────────────────────────────────────────────────────────────
  // Each ring is its own annulus band, and a body crossing several is burned
  // by each of them. Applied on a per-body-per-ring cooldown rather than per
  // frame, so output is identical at 30fps and at 144.
  const band = 0.70;
  for (const w of walkers) {
    if (w.dead) continue;
    const d = Math.hypot(w.pos.x - hero.pos.x, w.pos.z - hero.pos.z);
    const reach = band + (w.E.bulk||1)*0.42;
    for (let i = 0; i < L.rings; i++) {
      // The innermost ring burns everything from the player outwards, not just
      // a band at its radius. As an annulus it left a safe hole in the middle:
      // measured at max rank, a runner that closed all the way to 1.2 units sat
      // inside the smallest ring taking nothing while it hit the player. A ring
      // of fire you are standing in the centre of should not be a shelter for
      // whatever reaches you. Outer rings stay bands, so the gaps between them
      // remain real cover.
      const inside = i === 0 ? (d > RING.radii[0] + reach)
                             : (Math.abs(d - RING.radii[i]) > reach);
      if (inside) continue;
      let cd = ringState.cool.get(w);
      if (!cd) { cd = [0,0,0]; ringState.cool.set(w, cd); }
      if (S.t < cd[i]) continue;
      cd[i] = S.t + RING.tick;
      damageWalker(w, L.dps * RING.tick, null, 0, "fire");
      if (Math.random() < 0.4) sparks(tmp3.set(w.pos.x, 1.1, w.pos.z), 0xff8a2a, 3, 8);
    }
  }
  if (ringState.cool.size > 120)
    for (const k of ringState.cool.keys()) if (k.dead) ringState.cool.delete(k);
}

// ═══════════════════════════════════════════════════════════════ ice crown
// The second drafted power. The Ring of Fire is area denial — it punishes
// anything that closes. The Crown is the opposite half: it reaches OUT and
// picks a target, so the two answer different problems and a run that takes
// both is covering both. Ranks add spikes per volley, not damage per spike,
// because "more ice" is what the upgrade should look like.
//
// Per-spike damage steps DOWN as ranks are added, the same way the Ring's
// per-ring dps does. Total output still climbs hard (140 -> 240 -> 315), but
// not by the flat 3x that a constant per-spike number would give.
const CROWN = {
  levels: [
    null,
    { spikes:1, dmg:140, every:1.90, shards:5 },
    { spikes:2, dmg:120, every:1.70, shards:8 },
    { spikes:3, dmg:105, every:1.50, shards:12 },
  ],
  range:   22,     // it will not fire at what it cannot reach
  speed:   34,     // fast enough to feel like a bolt, slow enough to watch
  hitR:    1.5,
  slowMul: 0.55,   // struck bodies wade for a moment
  slowT:   1.6,
  ice:     0xbfe9ff,
};

// `parts` is every mesh the current rank put in the group; `shards` is the
// subset that animates (the spike fan). They are separate because the rebuild
// has to clear ALL of it — a rank-up that only cleared the fan would leave
// three stacked circlets behind by rank 3.
const crownState = { lv:0, t:0, group:null, shards:[], parts:[], spikes:[], crest:null };

// One shared shard geometry — the crown can hold twelve of them and every
// spike in flight reuses it too.
const shardGeo = new T.ConeGeometry(0.13, 0.72, 4);
const shardMat = new T.MeshStandardMaterial({
  color: CROWN.ice, emissive: 0x5fc8ff, emissiveIntensity: 1.15,
  roughness: 0.18, metalness: 0.1, transparent: true, opacity: 0.92,
  flatShading: true });

// ---- the circlet itself. Shared at module scope: the crown is rebuilt on
// every rank-up, and three ranks' worth of one-off geometry is three leaks.
const CROWN_H = 0.30;                    // band height, before CROWN_FIT
// The model is authored at a comfortable working size and then fitted to the
// hero. Built 1:1 it is about three head-widths across and reads as a cage
// around the player rather than a crown above them.
const CROWN_FIT = 0.55;
const CROWN_Y = 2.28;                    // ride height above the hero's origin
const crownBandGeo  = new T.CylinderGeometry(0.80, 0.86, CROWN_H, 22, 1, true);
const crownLipGeo   = new T.TorusGeometry(0.80, 0.022, 6, 26);
const crownFootGeo  = new T.TorusGeometry(0.86, 0.018, 6, 26);
const crownToothGeo = new T.ConeGeometry(0.05, 0.18, 4);
const crownGemGeo   = new T.OctahedronGeometry(0.062, 0);
const crownCrestGeo = new T.OctahedronGeometry(0.13, 0);

const crownBandMat = new T.MeshStandardMaterial({
  color: CROWN.ice, emissive: 0x2f86cc, emissiveIntensity: 0.5,
  roughness: 0.22, metalness: 0.15, transparent: true, opacity: 0.78,
  side: T.DoubleSide, flatShading: true });
const crownLipMat = new T.MeshBasicMaterial({
  color: 0xeaf7ff, transparent: true, opacity: 0.9 });
const crownGemMat = new T.MeshStandardMaterial({
  color: 0x2f5bb0, emissive: 0x1b3f8f, emissiveIntensity: 0.85,
  roughness: 0.15, metalness: 0.3, flatShading: true });
const crownCrestMat = new T.MeshStandardMaterial({
  color: 0xffffff, emissive: 0x9fe0ff, emissiveIntensity: 1.7,
  roughness: 0.1, metalness: 0, transparent: true, opacity: 0.95,
  flatShading: true });

// Hand-tuned heights, not a formula: the fan is meant to be irregular, with
// tall blades interleaved by short ones, the way the key art reads. An even
// ring of identical pins is the thing this replaced.
const CROWN_FAN = [1.0, 0.58, 0.82, 0.48, 1.0, 0.66, 0.54, 0.9, 0.62, 1.0, 0.5, 0.76];
const CROWN_TEETH = [0.9, 0.55, 1.0, 0.62, 0.85, 0.5, 1.0, 0.7, 0.58, 0.95, 0.52, 0.8];

function buildCrown() {
  if (!crownState.group) { crownState.group = new T.Group(); scene.add(crownState.group); }
  const g = crownState.group;
  for (const p of crownState.parts) g.remove(p);
  crownState.parts.length = 0;
  crownState.shards.length = 0;
  crownState.crest = null;
  if (!crownState.lv) return;

  const add = (m) => { m.castShadow = false; g.add(m); crownState.parts.push(m); return m; };
  const lv = crownState.lv;
  const n = CROWN.levels[lv].shards;

  // ---- circlet: an open cylinder wall between a bright lip and a dim foot
  add(new T.Mesh(crownBandGeo, crownBandMat));
  const lip = add(new T.Mesh(crownLipGeo, crownLipMat));
  lip.position.y = CROWN_H / 2; lip.rotation.x = Math.PI / 2;
  const foot = add(new T.Mesh(crownFootGeo, crownLipMat));
  foot.position.y = -CROWN_H / 2; foot.rotation.x = Math.PI / 2;

  // ---- the spike fan, rising from the top rim and splaying outward
  for (let i = 0; i < n; i++) {
    const h = CROWN_FAN[i % CROWN_FAN.length];
    const a = (i / n) * Math.PI * 2;
    const len = 0.72 * (1.05 + h * 0.95);
    const tilt = 0.30 + (1 - h) * 0.72;   // the short ones splay hardest
    const m = new T.Mesh(shardGeo, shardMat);
    m.scale.set(0.62 + h * 0.38, (1.05 + h * 0.95), 0.62 + h * 0.38);
    m.position.set(Math.cos(a) * 0.80, CROWN_H / 2, Math.sin(a) * 0.80);
    // rotateY puts local +X on the outward radial, rotateZ then tips the
    // cone's own axis along it. Setting this once at build and only bobbing
    // y per frame keeps the trig out of the step loop.
    m.rotateY(-a);
    m.rotateZ(-tilt);
    m.translateY(len * 0.5);
    m.userData.a = a;
    m.userData.baseY = m.position.y;
    crownState.parts.push(m);
    crownState.shards.push(m);
    g.add(m);
  }

  // ---- ice teeth under the rim, irregular and not on every station
  for (let i = 0; i < n; i++) {
    const t = CROWN_TEETH[i % CROWN_TEETH.length];
    if (t < 0.55) continue;
    const a = ((i + 0.5) / n) * Math.PI * 2;
    const m = add(new T.Mesh(crownToothGeo, crownBandMat));
    m.scale.set(1, t * 1.4, 1);
    m.position.set(Math.cos(a) * 0.86, -CROWN_H / 2 - t * 0.126, Math.sin(a) * 0.86);
    m.rotation.x = Math.PI;
  }

  // ---- gem clusters set into the wall, three more with every rank
  for (let i = 0; i < lv * 3; i++) {
    const a = (i / (lv * 3)) * Math.PI * 2;
    const big = i % 3 === 0;
    const m = add(new T.Mesh(crownGemGeo, crownGemMat));
    m.scale.setScalar(big ? 1.15 : 0.7);
    m.position.set(Math.cos(a) * 0.845, big ? 0.01 : -0.05, Math.sin(a) * 0.845);
    m.rotation.set(0.4, -a, 0.3);
  }

  // ---- the crest: a centre spire carrying the crown's heart, as in the art.
  // It has to out-reach the tallest blade in the fan (~1.53 at full height)
  // or the heart sits buried inside the fan instead of crowning it.
  const spireScale = 1.62 + lv * 0.13;
  const spireLen = 0.72 * spireScale;
  const spire = add(new T.Mesh(shardGeo, shardMat));
  // Thick enough to actually be seen between the blades. At 0.6 it vanished
  // and the heart read as an unrelated crystal hanging in the air.
  spire.scale.set(1.05, spireScale, 1.05);
  spire.position.y = CROWN_H / 2 + spireLen * 0.5;
  const crest = add(new T.Mesh(crownCrestGeo, crownCrestMat));
  crest.scale.setScalar(0.78 + lv * 0.16);
  crest.position.y = CROWN_H / 2 + spireLen + 0.12;
  crownState.crest = crest;

  g.scale.setScalar(CROWN_FIT);
}

function crownUpgrade() {
  if (crownState.lv >= 3) return;
  crownState.lv++;
  buildCrown();
  const L = CROWN.levels[crownState.lv];
  banner("ICE CROWN · " + crownState.lv);
  toast(L.spikes + (L.spikes === 1 ? " spike" : " spikes") + " a volley · " +
        L.dmg + " each", 2800);
  SFX.rankUp ? SFX.rankUp(2) : SFX.overload();
  S.shake = Math.min(1.0, S.shake + 0.3);
}

function clearSpikes() {
  for (const sp of crownState.spikes) scene.remove(sp.g);
  crownState.spikes.length = 0;
}

function stepCrown(dt) {
  const g = crownState.group;
  if (g && crownState.lv) {
    // The crown rides above the head and turns slowly.
    g.position.set(hero.pos.x, hero.pos.y + CROWN_Y, hero.pos.z);
    g.rotation.y += dt * 0.8;
    // Placement and orientation are baked in at build time; only the bob
    // moves, so the fan keeps its shape and this stays cheap at twelve blades.
    for (const m of crownState.shards) {
      m.position.y = m.userData.baseY + Math.sin(S.t * 2.1 + m.userData.a * 2) * 0.05;
    }
    if (crownState.crest) {
      crownState.crest.rotation.y -= dt * 1.7;
      crownState.crest.rotation.x = Math.sin(S.t * 1.3) * 0.25;
    }
  }

  // ---- volley
  if (crownState.lv) {
    const L = CROWN.levels[crownState.lv];
    crownState.t -= dt;
    if (crownState.t <= 0 && S.phase === "play") {
      crownState.t = L.every;
      // Nearest first, one spike per body: three spikes into one walker is a
      // waste when three are closing, and picking distinct targets is what
      // makes the rank feel like more coverage rather than more overkill.
      const marks = walkers
        .filter(w => !w.dead && w.pos.distanceTo(hero.pos) < CROWN.range)
        .sort((a, b) => a.pos.distanceTo(hero.pos) - b.pos.distanceTo(hero.pos))
        .slice(0, L.spikes);
      for (const mk of marks) {
        const m = new T.Mesh(shardGeo, shardMat);
        m.scale.set(1.7, 2.9, 1.7);
        m.position.set(hero.pos.x, hero.pos.y + CROWN_Y, hero.pos.z);
        scene.add(m);
        crownState.spikes.push({ g: m, mark: mk, dmg: L.dmg, life: 3.0 });
      }
      if (marks.length) SFX.throw ? SFX.throw(1) : null;
    }
  }

  // ---- spikes in flight
  for (let i = crownState.spikes.length - 1; i >= 0; i--) {
    const sp = crownState.spikes[i];
    sp.life -= dt;
    let done = sp.life <= 0;
    const target = sp.mark && !sp.mark.dead ? sp.mark : null;
    if (!target) done = true;
    if (!done) {
      // Substepped. At 34 u/s a frame at 30fps advances further than the 1.5
      // hit radius, and an unsubstepped bolt passes straight through the body
      // it was aimed at — the same tunnelling the archer's arrows hit.
      const step = CROWN.speed * dt;
      const subs = Math.max(1, Math.ceil(step / (CROWN.hitR * 0.5)));
      for (let k = 0; k < subs && !done; k++) {
        tmp.set(target.pos.x - sp.g.position.x,
                (target.pos.y + 1.0) - sp.g.position.y,
                target.pos.z - sp.g.position.z);
        const d = tmp.length();
        if (d > 1e-4) {
          tmp.divideScalar(d);
          sp.g.position.addScaledVector(tmp, Math.min(step / subs, d));
          // Points where it is going.
          sp.g.quaternion.setFromUnitVectors(UP_AXIS, tmp);
        }
        if (d < CROWN.hitR) {
          damageWalker(target, sp.dmg, tmp, 1.2, "impact");
          // Ice: the body wades for a moment. This is the Crown's identity —
          // the Ring burns what closes, the Crown slows what is still coming.
          target.slowT = CROWN.slowT;
          sparks(tmp3.copy(sp.g.position), CROWN.ice, 10, 14);
          SFX.impact(0.5, 1);
          done = true;
        }
      }
    }
    if (done) { scene.remove(sp.g); crownState.spikes.splice(i, 1); }
  }
}

// ═════════════════════════════════════════════════════════════════ casters
// Everything a character carries on their back rather than picking up. Where
// the telekinetic's ammunition is the arena — walk somewhere new when the
// ground runs dry — a caster's is a stack that refills on its own, so their
// pressure is a clock rather than a place. That is why the arena spawns them
// nothing to lift: two characters that both solve "what do I throw" the same
// way are one character with two skins.
//
// The held count comes from the character's PERMANENT level, so levelling is
// felt immediately and every run after.
//
// One system, two kits. The stack, the regen clock, the scatter behind the
// shoulders and the trigger are identical for the pyromancer and the wind
// mage; what differs is the projectile — its model, how it moves, what it
// leaves behind, and what it does on arrival. Those live in a SPEC per
// character (PYRO and WIND at the foot of this section), and the machinery
// below reads the spec rather than knowing which character is playing.
const FIRE_HOT = 0xff8a2e;
// Mint rather than the cyan this started as: the blade is a living gust, and
// green reads as that where blue reads as ice — which the Ice Crown already
// owns two colours' worth of.
const WIND_PALE = 0x8ef0a8;

// Water is not a light source, so it does not get one of the hot colours the
// other two use. It is a body the scene lights: a mid blue you can see the
// ground through, with a pale sheen riding on top of it.
const WATER_BLUE = 0x3aa8e8;

const castState = { held: 0, t: 0, group: null, orbs: [], shots: [], embers: [] };

// ── the fireball ──────────────────────────────────────────────────────────
// One geometry and one material for every ball, held and in flight alike.
// A fireball is a hot core seen THROUGH burning gas, so it is built as nested
// shells rather than one glowing ball: near-white at the centre, yellow over
// that, and a ragged red-orange envelope on the outside. Additive blending
// stacks them into the white-hot middle the reference has, and only the
// envelope is irregular — a core that wobbles reads as jelly.
const pyroGeo     = new T.IcosahedronGeometry(0.26, 1);   // core, smooth
// Perturbed once at creation. Perfect nested spheres stack into concentric
// rings — a target, not a flame. Lumpy shells break that banding, and because
// the two envelopes spin against each other the lumps churn instead of sitting
// still. The trail puffs borrow the same geometry, so smoke is ragged too.
const pyroShellGeo = (() => {
  const g = new T.IcosahedronGeometry(0.26, 1);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const k = 0.70 + Math.random() * 0.60;
    pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k, pos.getZ(i) * k);
  }
  g.computeVertexNormals();
  return g;
})();

const pyroCoreMat = new T.MeshBasicMaterial({ color: 0xfff6d8, transparent: true,
  opacity: 0.95, blending: T.AdditiveBlending, depthWrite: false });
const pyroMidMat = new T.MeshBasicMaterial({ color: 0xffc23a, transparent: true,
  opacity: 0.7, blending: T.AdditiveBlending, depthWrite: false });
const pyroMat = new T.MeshBasicMaterial({ color: FIRE_HOT, transparent: true,
  opacity: 0.55, blending: T.AdditiveBlending, depthWrite: false });
const pyroRimMat = new T.MeshBasicMaterial({ color: 0xff4a12, transparent: true,
  opacity: 0.22, blending: T.AdditiveBlending, depthWrite: false });

// The tail is what makes it read as a fireball in flight rather than a glowing
// marble. Each puff picks a material by AGE from this ladder instead of owning
// one — a per-puff material clone is a GPU program lookup per puff per frame,
// and a volley can leave a hundred of them in the air.
const pyroTrailMats = [
  new T.MeshBasicMaterial({ color: 0xfff0c0, transparent: true, opacity: 0.60,
    blending: T.AdditiveBlending, depthWrite: false }),
  new T.MeshBasicMaterial({ color: 0xffb42e, transparent: true, opacity: 0.46,
    blending: T.AdditiveBlending, depthWrite: false }),
  new T.MeshBasicMaterial({ color: 0xff7a18, transparent: true, opacity: 0.34,
    blending: T.AdditiveBlending, depthWrite: false }),
  new T.MeshBasicMaterial({ color: 0xe8430e, transparent: true, opacity: 0.26,
    blending: T.AdditiveBlending, depthWrite: false }),
  new T.MeshBasicMaterial({ color: 0xc0350f, transparent: true, opacity: 0.20,
    blending: T.AdditiveBlending, depthWrite: false }),
  new T.MeshBasicMaterial({ color: 0x8d2a12, transparent: true, opacity: 0.13,
    blending: T.AdditiveBlending, depthWrite: false }),
  // The reference's tail goes to SMOKE at its far end, not to nothing. Grey
  // and non-additive, so it darkens against the sky instead of glowing.
  new T.MeshBasicMaterial({ color: 0x6b6a66, transparent: true, opacity: 0.05,
    depthWrite: false }),
];

// Builds the layered ball. `size` is the whole thing's scale, so the orbs
// riding on the back can be the same object at a lower burn than the one in
// flight without a second set of materials.
function makeFireball() {
  const g = new T.Group();
  g.add(new T.Mesh(pyroShellGeo, pyroRimMat));   // 0 ragged outer envelope
  g.add(new T.Mesh(pyroShellGeo, pyroMat));      // 1 orange body
  g.add(new T.Mesh(pyroGeo, pyroMidMat));        // 2 yellow
  g.add(new T.Mesh(pyroGeo, pyroCoreMat));       // 3 white-hot core
  g.children[0].scale.setScalar(1.42);
  g.children[1].scale.setScalar(1.18);
  g.children[2].scale.setScalar(0.78);
  g.children[3].scale.setScalar(0.44);
  return g;
}

// Per-frame life for one ball: the envelope churns and the core holds steady.
function burnFireball(g, t, seed, size) {
  const s = size || 1;
  g.children[0].scale.setScalar(s * (1.42 + 0.28 * flick(t * 5.1 + seed)));
  g.children[0].rotation.y += 0.06;
  g.children[0].rotation.x += 0.04;
  g.children[1].scale.setScalar(s * (1.18 + 0.16 * flick(t * 6.7 + seed * 1.7)));
  g.children[1].rotation.y -= 0.09;
  g.children[2].scale.setScalar(s * (0.78 + 0.07 * flick(t * 8.3 + seed * 2.3)));
  g.children[3].scale.setScalar(s * 0.44);
}

// ── the air blade ─────────────────────────────────────────────────────────
// Air is invisible; what you can see is its EDGE. So the blade is not a solid
// disc but three open crescents of different radius, nested and counter-
// spinning, over a faint wash of compressed air in the middle. Nothing here is
// opaque — the arena has to stay readable through it, which is also what keeps
// it from reading as a metal saw.
//
// The arcs are open rather than closed rings on purpose: a closed ring is a
// hoop, and a hoop reads as something to pass through. A crescent has a
// leading point, and a leading point reads as something that cuts.
// A blade is a RIBBON, not a hoop: thick through the belly and drawn out to a
// point at each end, sweeping round and opening outward as it goes. No stock
// geometry does that — a torus arc has one tube radius from end to end, which
// is exactly why the first version of this read as a bracelet — so the curve
// is built by hand: walk the arc, and at each step emit an inner and an outer
// vertex whose separation is the width AT THAT POINT.
//
// `spiral` is what stops it closing into a circle: the radius grows along the
// sweep, so the two tips pass each other at different distances from the
// centre and the shape stays open.
function crescentGeo({ r = 0.34, start = -0.35, span = Math.PI * 1.7, w = 0.10,
                       spiral = 0.30, squash = 0.78, seg = 56 } = {}) {
  const pos = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const a = start + span * t;
    const rr = r * (1 + spiral * t);
    // Fine at both tips, fattest a little past the middle. The exponent is
    // what keeps the points SHARP: a plain sine tapers too politely and the
    // ends read as rounded caps.
    const half = w * Math.pow(Math.sin(Math.PI * t), 0.55);
    const c = Math.cos(a), s2 = Math.sin(a);
    pos.push(c * (rr - half), s2 * (rr - half), 0);
    pos.push(c * (rr + half), s2 * (rr + half), 0);
    if (i < seg) {
      const k = i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const g = new T.BufferGeometry();
  g.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  // Squashed after the fact, so the width tapers in the same proportion the
  // sweep does and the whole thing reads as one curve seen at an angle.
  g.scale(1, squash, 1);
  return g;
}

// Three passes of the same curve at three widths: a broad green haze, the
// green body inside it, and a near-white core down the middle. That stack is
// what makes a flat ribbon look lit from within rather than painted on.
// The glow is DELIBERATELY much wider than the body — nearly three times.
// Stacked additively, the core and body sum to white wherever they overlap,
// so the only place the colour can live is the fringe outside them. A narrow
// glow makes a white blade with a green hint; a broad one makes the green
// blade with a white heart the reference actually shows.
const bladeGlowGeo = crescentGeo({ w: 0.240 });
const bladeBodyGeo = crescentGeo({ w: 0.090 });
const bladeCoreGeo = crescentGeo({ w: 0.026 });
// Smoke is torn ribbon, not dust: the same shape, shorter and fatter, thrown
// at a random angle so the wake reads as air coming apart in sheets.
const bladeWispGeo = crescentGeo({ r: 0.26, span: Math.PI * 0.95, w: 0.085,
                                   spiral: 0.55, squash: 0.85, seg: 16 });

const bladeGlowMat = new T.MeshBasicMaterial({ color: 0x4ed07c, transparent: true,
  opacity: 0.32, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide });
const bladeBodyMat = new T.MeshBasicMaterial({ color: WIND_PALE, transparent: true,
  opacity: 0.72, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide });
const bladeCoreMat = new T.MeshBasicMaterial({ color: 0xf4fff2, transparent: true,
  opacity: 0.85, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide });

// Green while it is still energy, then grey-green as it becomes only disturbed
// air. The last two steps drop additive blending: smoke that keeps glowing is
// not smoke, it is more blade.
const bladeTrailMats = [
  new T.MeshBasicMaterial({ color: 0xd8ffe2, transparent: true, opacity: 0.34,
    blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide }),
  new T.MeshBasicMaterial({ color: 0xa6f0b8, transparent: true, opacity: 0.26,
    blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide }),
  new T.MeshBasicMaterial({ color: 0x7fd499, transparent: true, opacity: 0.18,
    blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide }),
  new T.MeshBasicMaterial({ color: 0x6fae86, transparent: true, opacity: 0.12,
    blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide }),
  new T.MeshBasicMaterial({ color: 0x8d9d90, transparent: true, opacity: 0.20,
    depthWrite: false, side: T.DoubleSide }),
  new T.MeshBasicMaterial({ color: 0x79877c, transparent: true, opacity: 0.13,
    depthWrite: false, side: T.DoubleSide }),
  new T.MeshBasicMaterial({ color: 0x66736a, transparent: true, opacity: 0.06,
    depthWrite: false, side: T.DoubleSide }),
];

// The launched blade holds ONE angle, and this is it: the crescent's opening
// turned upward IN THE BLADE'S OWN PLANE, so a shot reads as a scoop driving
// forward rather than as whatever angle that blade happened to be dealt while
// it rode on the back. On screen it lands near upright rather than exactly —
// the shape is squashed and the camera sits behind and above it.
// Derived from the curve's own sweep rather than guessed — the arc covers
// 1.7π of the circle, which leaves its opening centred near 5.46 radians, and
// this turns that to straight up.
const BLADE_ROLL = Math.PI / 2 - 5.46;

// Two nested groups on purpose. The outer one is AIMED every frame — pointed
// down the line of flight — and the inner one carries the ROLL: the angle the
// crescent is held at around that line. They have to be separate, because
// rolling the outer group would be undone by the next aim, and rolling the
// three passes one at a time would slide them off each other and lose the
// core. The blades on the back are each dealt a random roll, which is what
// keeps the carried stack from looking like one shape stamped out eight
// times; a launched blade overwrites it with BLADE_ROLL.
function makeAirBlade() {
  const g = new T.Group();
  const spin = new T.Group();
  spin.add(new T.Mesh(bladeGlowGeo, bladeGlowMat));
  spin.add(new T.Mesh(bladeBodyGeo, bladeBodyMat));
  spin.add(new T.Mesh(bladeCoreGeo, bladeCoreMat));
  g.add(spin);
  spin.rotation.z = Math.random() * Math.PI * 2;
  return g;
}

// The blade does not turn. It is a held shape thrown forward — a slash that
// keeps its angle the whole way out — so the only motion here is the light
// breathing in and out of the edges. A rolling crescent read as a thrown
// wheel, which is a different weapon.
function pulseAirBlade(g, t, seed, size) {
  const s = size || 1;
  g.scale.setScalar(s);
  const spin = g.children[0];
  // The haze breathes wider than the body and the core barely at all, so the
  // edge of the light moves while the blade itself stays a solid shape.
  spin.children[0].scale.setScalar(1 + 0.10 * flick(t * 3.4 + seed));
  spin.children[1].scale.setScalar(1 + 0.05 * flick(t * 4.9 + seed * 1.7));
  spin.children[2].scale.setScalar(1 + 0.02 * flick(t * 6.2 + seed * 2.3));
}

// In flight the blade goes EDGE FIRST: it stands upright with its plane along
// the line of travel, so it cuts into the air like a thrown knife rather than
// pushing its face through it.
//
// Know what this costs. A plane that contains the direction of travel is seen
// EDGE-ON from anywhere on that line — and the player is on that line, behind
// it. Fired straight ahead the blade is a bright vertical stroke, not a
// crescent; the shape only opens up as the shot crosses the view or the player
// turns. That is the trade this orientation makes.
//
// Yaw only, never pitch: the blade stays upright even when homing pulls it
// down toward a body's chest, so it can never tip onto its face.
function aimAirBlade(g, vel) {
  if (vel.x * vel.x + vel.z * vel.z < 1e-8) return;
  // A quarter turn off the heading puts the face SIDEWAYS, which is the same
  // thing as putting the plane along the line of flight.
  g.rotation.set(0, Math.atan2(vel.x, vel.z) + Math.PI / 2, 0, "YXZ");
}

// On the back it is the opposite problem: a blade held edge-on to the player
// is a line, and a line is invisible. So the carried ones turn their face to
// the camera — the stack has to be legible sitting still, and it is the only
// place the player ever looks at one closely.
// Takes no scratch vector of its own on purpose. It is called from inside the
// placement loop, which is holding the side axis in one of the shared temps —
// borrowing that temp here silently re-aimed the axis and stacked the whole
// carried set into a single narrow line.
function faceAirBlade(g, vel) {
  if (vel.x * vel.x + vel.y * vel.y + vel.z * vel.z < 1e-6) return;
  g.lookAt(g.position.x + vel.x, g.position.y + vel.y, g.position.z + vel.z);
}

// Called once, on the blade that has just left the hand: it drops the random
// roll it was carrying and takes the one every launched blade shares.
function launchAirBlade(g) { g.children[0].rotation.z = BLADE_ROLL; }

// ═══════════════════════════════════════════════════════════════ hydromancer
// Water is drawn out of the air rather than carried as a solid, and the model
// has to say so: where fire and the blade GLOW — additive, brightest where
// they stack — water is TRANSLUCENT. Its body is an ordinary blended blue you
// can see the ground through, and only the sheen on top of it is additive.
// Building water additively makes a blue lamp, which is what the first pass
// of this looked like.
const waterDropGeo = new T.IcosahedronGeometry(0.24, 1);
// The whip from the reference: a tapered ribbon curling around the head, so
// the shot reads as water being PULLED along rather than as a pellet. Barely
// any spiral — water follows the arm, it does not fly off into a coil.
const waterCurlGeo = crescentGeo({ r: 0.34, span: Math.PI * 1.25, w: 0.115,
                                   spiral: 0.12, squash: 0.92, seg: 40 });
const waterSprayGeo = new T.IcosahedronGeometry(0.14, 0);

// These are unlit materials, so what you see is simply colour x opacity —
// there is no lamp to make a dim blue read as a bright one. Both are pushed
// high for that reason: the pass before this used half these numbers and the
// water came out the grey of dishwater against a night arena.
const waterBodyMat = new T.MeshBasicMaterial({ color: 0x2b9ce4, transparent: true,
  opacity: 0.86, depthWrite: false, side: T.DoubleSide });
// Deeper than the head, not lighter. The curl is drawn OVER the head, so a
// pale one lays a grey film across the whole shot — which is what the last
// three passes of this kept producing.
const waterSkinMat = new T.MeshBasicMaterial({ color: 0x1d86cf, transparent: true,
  opacity: 0.88, depthWrite: false, side: T.DoubleSide });
// The additive layers, and they are kept SMALL and FAINT on purpose. A wet
// surface throws back a hard highlight, but at the strength the first pass
// used, additive white swallowed the blue underneath it and the whole shot
// came out the colour of steam. Blue is the body of this thing; white is a
// glint on one part of it.
const waterSheenMat = new T.MeshBasicMaterial({ color: 0xdff4ff, transparent: true,
  opacity: 0.22, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide });


// Droplets thrown off the stream. They go from lit water to dark water and
// simply thin out — no smoke step, because water does not burn away, it
// falls.
// The stream's body. Deeper and less opaque than the spray it throws off,
// because these segments overlap each other along the path — at the spray's
// values the overlap stacked into a white rope.
const waterStreamMats = [
  new T.MeshBasicMaterial({ color: 0x51c4f4, transparent: true, opacity: 0.62, depthWrite: false }),
  new T.MeshBasicMaterial({ color: 0x3fb4f0, transparent: true, opacity: 0.54, depthWrite: false }),
  new T.MeshBasicMaterial({ color: 0x2f9fe0, transparent: true, opacity: 0.45, depthWrite: false }),
  new T.MeshBasicMaterial({ color: 0x2a8ecb, transparent: true, opacity: 0.36, depthWrite: false }),
  new T.MeshBasicMaterial({ color: 0x2478ad, transparent: true, opacity: 0.26, depthWrite: false }),
  new T.MeshBasicMaterial({ color: 0x1f6390, transparent: true, opacity: 0.16, depthWrite: false }),
  new T.MeshBasicMaterial({ color: 0x1a4f73, transparent: true, opacity: 0.08, depthWrite: false }),
];

const waterTrailMats = [
  new T.MeshBasicMaterial({ color: 0x6fd0ff, transparent: true, opacity: 0.58, depthWrite: false }),
  new T.MeshBasicMaterial({ color: 0x4fbdf8, transparent: true, opacity: 0.50, depthWrite: false }),
  new T.MeshBasicMaterial({ color: 0x39a6e8, transparent: true, opacity: 0.42, depthWrite: false }),
  new T.MeshBasicMaterial({ color: 0x2f8fd0, transparent: true, opacity: 0.42, depthWrite: false }),
  new T.MeshBasicMaterial({ color: 0x2775ae, transparent: true, opacity: 0.28, depthWrite: false }),
  new T.MeshBasicMaterial({ color: 0x215f8c, transparent: true, opacity: 0.16, depthWrite: false }),
  new T.MeshBasicMaterial({ color: 0x1b4a6c, transparent: true, opacity: 0.07, depthWrite: false }),
];

function makeWaterWhip() {
  const g = new T.Group();
  g.add(new T.Mesh(waterDropGeo, waterBodyMat));   // 0 the head, a body of water
  g.add(new T.Mesh(waterDropGeo, waterSheenMat));  // 1 the highlight on it
  g.add(new T.Mesh(waterCurlGeo, waterSkinMat));   // 2 the whip curling behind
  g.children[0].scale.setScalar(0.78);   // the head gives way to the curl
  g.children[1].scale.setScalar(0.30);
  g.children[2].scale.setScalar(1.22);   // ...which is the thing that reads as water
  return g;
}

// Water has no flame to flicker and no blade to hold rigid: it WOBBLES. The
// head is stretched and squeezed on axes that disagree with each other, which
// is what stops a sphere reading as a marble, and the curl breathes against
// it rather than with it.
function flowWater(g, t, seed, size) {
  const s = size || 1;
  g.scale.setScalar(s);
  const w1 = flick(t * 4.3 + seed), w2 = flick(t * 5.9 + seed * 1.6);
  g.children[0].scale.set(0.78 * (1 + 0.20 * w1), 0.78 * (1 - 0.13 * w2), 0.78 * (1 + 0.09 * w2));
  g.children[1].scale.set(0.30 * (1 + 0.24 * w2), 0.30, 0.30 * (1 - 0.10 * w1));
  g.children[2].scale.set(1.22 * (1 + 0.10 * w2), 1.22 * (1 + 0.16 * w1), 1.22);
}

// Pointed along the flow, vertical component and all — unlike the blade, a
// stream bending downward onto a body SHOULD lean into the bend. That is what
// makes it read as water falling on someone rather than as a dart.
function aimWater(g, vel) {
  if (vel.x * vel.x + vel.y * vel.y + vel.z * vel.z < 1e-6) return;
  g.lookAt(g.position.x + vel.x, g.position.y + vel.y, g.position.z + vel.z);
}

// Drawn out of the air at the moment of the throw: a handful of droplets
// gathering where the shot begins. Takes its own vector rather than a shared
// temp — castFire is holding the aim in one of those.
const waterConjurePos = new T.Vector3();
function conjureWater(g) {
  waterConjurePos.copy(g.position);
  // A ring on the dirt and a burst of droplets, at the point the water comes
  // UP. Without the ring the stream simply exists at ankle height; with it,
  // something happened to the ground.
  shell(waterConjurePos, 0.7, 0x63c6f0);
  sparks(waterConjurePos, 0x9fdcff, 9, 6);
}

// ── the two kits ──────────────────────────────────────────────────────────
// Read by the machinery below. Anything a character does differently lives
// here; anything they share does not.
const PYRO = {
  label:    "Fire",   // HUD chip and the touch trigger
  verb:     "Fire",
  kind:     "fire",   // what the kill is credited to
  dry:      "NO FIRE LEFT — it grows back",
  hint:     "Tap FIRE to throw · the stack grows back on its own",
  regen:    2.3,      // seconds to grow one back
  speed:    32,
  dmg:      170,
  pierce:   0,        // stops at the first body
  blastR:   4.4,
  blastDmg: 95,
  hitR:     1.15,
  life:     3.4,
  knock:    6,
  orbitR:   0.62,     // how far behind the shoulders they ride
  // The height band the carried projectiles scatter through, measured from
  // the hero's feet. Both ends are load-bearing: at `low` the bottom of one
  // still clears the ground by most of a metre, and `high` stays under the
  // Ice Crown at CROWN_Y so the stack reads as carried on the back rather
  // than orbiting the head.
  low:      1.28,
  high:     1.95,
  hot:      FIRE_HOT,
  make:     makeFireball,
  anim:     burnFireball,
  aim:      null,     // a ball has no orientation worth setting
  carry:    0.66,     // scale on the back
  fly:      1.75,     // the thrown one burns bigger than the carried
  trail:    { geo: () => pyroShellGeo, mats: pyroTrailMats, every: 0.018,
              life: 0.42, spread: 0.13, rise: 0.16, drift: [0.25, 0.75],
              size: [0.85, 1.5], grow: 0.85, spin: [-3, 3] },
};

const WIND = {
  label:    "Blades",
  verb:     "Cut",
  kind:     "cut",
  dry:      "NO BLADES LEFT — they gather again",
  hint:     "Tap CUT to throw · a blade cuts through a line of them",
  // Faster to grow back and faster in the air than fire, and it has to be:
  // the blade has no blast, so a shot into empty space is worth nothing at
  // all, where a fireball into the same space still clears a footprint.
  regen:    1.9,
  speed:    46,
  dmg:      120,
  // The trade for losing the blast. Three bodies standing in a line take the
  // full hit each, which makes lining a crowd up the wind mage's whole game,
  // the way "throw it into the middle" is the pyromancer's.
  pierce:   3,
  blastR:   0,
  blastDmg: 0,
  hitR:     1.3,      // a blade is wider than a ball
  life:     2.6,
  knock:    4,
  orbitR:   0.66,
  low:      1.24,
  high:     1.98,
  hot:      WIND_PALE,
  make:     makeAirBlade,
  anim:     pulseAirBlade,
  launch:   launchAirBlade,
  aim:      aimAirBlade,      // in flight: upright, edge into the wind
  carryAim: faceAirBlade,     // on the back: turned to face the player
  carry:    0.62,
  // Bigger in the air than the carried ones by more than fire is, because a
  // crescent seen at 40 metres is mostly empty space where a ball is not.
  fly:      1.62,
  // Denser and shorter-lived than fire's: the blade covers a metre and a half
  // in the time a fireball covers one, so the same interval would leave gaps.
  trail:    { geo: () => bladeWispGeo, mats: bladeTrailMats, every: 0.021,
              life: 0.34, spread: 0.11, rise: 0.06, drift: [-0.1, 0.35],
              size: [1.0, 2.2], grow: 1.9, spin: [-5, 5] },
};

const WATER = {
  label:    "Water",
  verb:     "Flow",
  kind:     "flood",
  dry:      "NO WATER LEFT — it gathers again",
  hint:     "Tap FLOW · the water comes up out of the ground and finds them",
  regen:    2.0,
  // Nothing rides the shoulders: this water does not exist until it is called,
  // and then it comes out of the ground.
  carried:  false,
  fromGround: true,
  rise:     18,       // straight up first, before the homing bends it over
  riseT:    0.24,     // ...and this long before the homing is allowed to look
  // Slow on purpose. The whole point of this kit is that you WATCH it rise,
  // bend and fall on someone; at the blade's speed there is nothing to watch.
  speed:    20,
  dmg:      130,
  pierce:   0,
  blastR:   0,
  blastDmg: 0,
  hitR:     1.2,
  // Long-lived, because a shot that curves covers far more ground than the
  // distance to its target, and one that expires mid-bend looks like a bug.
  life:     3.8,
  // What water is FOR. Fire clears a footprint, a blade clears a line, water
  // takes one body off its feet. Knockback is a velocity that decays at 7 a
  // second, so a body slides roughly knock/7 before it stops: this is about
  // eight metres, against the fireball's one and the blade's half. It does
  // NOT out-throw a fireball's BLAST, which is an area effect and moves a
  // crowd further than this moves its one target — different jobs.
  knock:    55,
  // Nearly four times the pull the other two use. This is the "flowing to the
  // target" in the brief made mechanical: the stream visibly bends onto them
  // instead of being thrown at where they were standing.
  home:     230,
  orbitR:   0.64,
  low:      1.26,
  high:     1.96,
  hot:      WATER_BLUE,
  make:     makeWaterWhip,
  anim:     flowWater,
  launch:   conjureWater,
  aim:      aimWater,
  carry:    0.64,
  fly:      1.70,
  // The densest of the three trails and the only one that FALLS. Water thrown
  // off a stream does not rise and it does not hang: it drops out of the air,
  // which is what separates a spray from smoke.
  // The BODY of the stream: re-placed along the path every frame, so it flows
  // after the head as one connected thing instead of being a line of debris
  // left behind it. `every` is how many frames of path each segment steps
  // back — 3 at this speed is about a metre, which reads as continuous water
  // without paying for a segment per frame.
  // One segment per FRAME of path. At three frames apart the segments sat a
  // metre from each other while being barely half a metre across, and the
  // stream rendered as three separate blobs — which is exactly the pellet this
  // kit was rebuilt to stop being. Every frame overlaps them into one body.
  stream:   { count: 22, every: 1, head: 1.35, tail: 0.30,
              mats: waterStreamMats,
              make: () => new T.Mesh(waterDropGeo, waterBodyMat) },
  // Spray thrown OFF that body, which is a different thing from the body. Kept
  // sparse: at half this interval the droplets stacked several deep around the
  // head and bleached the whole shot white.
  trail:    { geo: () => waterSprayGeo, mats: waterTrailMats, every: 0.030,
              life: 0.52, spread: 0.12, rise: 0.02, drift: [-1.6, -0.5],
              size: [0.7, 1.4], grow: 0.65, spin: [-4, 4] },
};

// The kit of whoever is playing, or the pyromancer's as a stand-in for the
// telekinetic so nothing downstream has to null-check a spec it never uses.
function castSpec() { return CHAR.cast || PYRO; }

// ── the shared machinery ──────────────────────────────────────────────────
// Rebuilt on a level change and on restart. Every orb the last cap created is
// removed first — growing the cap without clearing would stack two sets on the
// same shoulders, the same way the crown once stacked circlets.
function buildCastStack() {
  if (!castState.group) { castState.group = new T.Group(); scene.add(castState.group); }
  const g = castState.group;
  for (const o of castState.orbs) g.remove(o);
  castState.orbs.length = 0;
  if (!isCaster()) { g.visible = false; return; }
  const spec = castSpec();
  // A kit can hold a resource without WEARING it. The hydromancer's water is
  // drawn out of the ground at the moment it is used, so there is nothing to
  // ride the shoulders — the count lives in the HUD and nowhere else.
  if (spec.carried === false) { g.visible = false; return; }
  g.visible = true;
  const cap = castCap(charLv());
  // Height bands, one per slot, handed out in shuffled order. A plain uniform
  // draw can deal three of them the same height by luck, and taking band i for
  // slot i would tilt the cloud into a diagonal — the ordered layout this
  // scatter exists to break. Shuffling gives a guaranteed spread with no
  // relationship between a slot and where it rides.
  const bands = [];
  for (let i = 0; i < cap; i++) bands.push(i);
  for (let i = cap - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = bands[i]; bands[i] = bands[j]; bands[j] = t;
  }
  for (let i = 0; i < cap; i++) {
    const m = spec.make();
    m.userData.slot = i;
    // Drawn once, here, and then carried for the life of the stack. Re-rolling
    // per frame would make the cloud boil around the player instead of riding
    // with them.
    m.userData.off = {
      side: (i % 2 ? 1 : -1) * (0.18 + Math.floor(i / 2) * 0.28 + Math.random() * 0.15),
      back: spec.orbitR + (Math.random() - 0.5) * 0.36,
      y:    spec.low + (bands[i] + Math.random()) / cap * (spec.high - spec.low),
      phase: Math.random() * Math.PI * 2,
      rate:  2.0 + Math.random() * 1.3,
    };
    g.add(m);
    castState.orbs.push(m);
  }
  castState.held = Math.min(castState.held, cap);
}

function clearCastShots() {
  for (const s of castState.shots) {
    if (s.seg) for (const m of s.seg) scene.remove(m);
    scene.remove(s.g);
  }
  castState.shots.length = 0;
  for (const p of castState.embers) scene.remove(p.m);
  castState.embers.length = 0;
}

// Launched at whatever Single would have aimed at, so every character reads
// the crosshair the same way and the lock-on the player already learned still
// applies.
function castFire() {
  const spec = castSpec();
  if (castState.held <= 0) { toast(spec.dry); SFX.dry(); return; }
  castState.held--;

  aimDir.set(Math.sin(cam.yaw), 0, Math.cos(cam.yaw)).normalize();

  const g = spec.make();
  g.scale.setScalar(spec.fly);
  // Out of the GROUND for a kit that pulls its water from underfoot, rather
  // than out of the hands. Starting it at chest height and calling it "rising"
  // fools nobody: the eye reads where a thing STARTS, so it starts in the dirt.
  // A pace IN FRONT of the caster, too — raised on the spot, the column comes
  // up through the player's own body and wears them like a costume.
  if (spec.fromGround) {
    g.position.set(hero.pos.x + aimDir.x * 1.3, 0.06, hero.pos.z + aimDir.z * 1.3);
  } else {
    g.position.set(hero.pos.x, hero.pos.y + 1.5, hero.pos.z);
  }
  scene.add(g);
  const seek = S.lock && !S.lock.dead ? S.lock : nearestInCone();
  const shot = {
    g, seek,
    vel: aimDir.clone().multiplyScalar(spec.speed),
    path: spec.stream ? [] : null,      // where the stream has been
    seg:  spec.stream ? [] : null,      // ...and the body strung along it
    riseT: spec.riseT || 0,             // seconds of climbing before it hunts
    life: spec.life,
    seed: Math.random() * 40,
    puffT: 0,
    hit: null,        // bodies already cut by this shot, for a piercing kit
  };
  // Thrown upward first. Homing takes the wheel within a few frames and bends
  // it over onto the target, which is what turns a jet out of the ground into
  // an arc that falls on someone.
  if (spec.rise) shot.vel.y = spec.rise;
  if (spec.stream) {
    for (let i = 0; i < spec.stream.count; i++) {
      const m = spec.stream.make();
      m.visible = false;
      scene.add(m);
      shot.seg.push(m);
    }
  }
  if (spec.launch) spec.launch(g);
  if (spec.aim) spec.aim(g, shot.vel);
  castState.shots.push(shot);
  SFX.throw ? SFX.throw(1.2) : null;
  S.shake = Math.min(0.4, S.shake + 0.09);
  updateForceLabel();
}

function stepCast(dt) {
  const spec = castSpec();
  const g = castState.group;
  if (g && isCaster()) {
    g.visible = true;
    // Grow one back on a timer. This is the caster's only resource, so it is
    // deliberately visible: the projectile pops in rather than fading up.
    const cap = castCap(charLv());
    if (castState.held < cap && S.phase === "play") {
      castState.t -= dt;
      if (castState.t <= 0) {
        castState.t = spec.regen;
        castState.held++;
        sparks(tmp.set(hero.pos.x, hero.pos.y + 1.6, hero.pos.z), spec.hot, 5, 6);
        updateForceLabel();
      }
    } else {
      castState.t = spec.regen;
    }

    // Ride behind the shoulders as a loose cloud, so they read as carried
    // rather than orbiting — an orbit would be a second ring of fire. Each one
    // keeps the offset it was dealt when the stack was built, so the scatter
    // travels with the player and turns with the camera.
    const back = tmp.set(-Math.sin(cam.yaw), 0, -Math.cos(cam.yaw)).normalize();
    const side = tmp2.set(back.z, 0, -back.x);
    for (let i = 0; i < castState.orbs.length; i++) {
      const orb = castState.orbs[i];
      orb.visible = i < castState.held;
      if (!orb.visible) continue;
      const off = orb.userData.off;
      const bob = Math.sin(S.t * off.rate + off.phase) * 0.07;
      orb.position.set(
        hero.pos.x + back.x * off.back + side.x * off.side,
        hero.pos.y + off.y + bob,
        hero.pos.z + back.z * off.back + side.z * off.side);
      // A carried blade faces the way the player does, so the crescents read
      // face-on over the shoulders instead of edge-on as three thin lines.
      const orbAim = spec.carryAim || spec.aim;
      if (orbAim) orbAim(orb, tmp3.set(-back.x, 0, -back.z));
      // Each one animates on its own phase, the same reason the ring's
      // curtains do: a stack pulsing in unison reads as one object.
      spec.anim(orb, S.t, i * 2.1, spec.carry);
    }
  } else if (g) {
    g.visible = false;
  }

  // ---- shots in flight
  for (let i = castState.shots.length - 1; i >= 0; i--) {
    const s = castState.shots[i];
    s.life -= dt;
    // A stream spends its first fraction of a second going UP, with the homing
    // held off. Without this the pull cancels the upward throw within three or
    // four frames — measured, the water cleared barely a metre before flying
    // flat, which is a jet of water aimed at someone rather than water rising
    // out of the ground.
    if (s.riseT > 0) {
      s.riseT -= dt;
    } else if (s.seek && !s.seek.dead) {
      tmp.set(s.seek.pos.x - s.g.position.x,
              s.seek.pos.y + 1 - s.g.position.y,
              s.seek.pos.z - s.g.position.z);
      const d = tmp.length() || 1;
      s.vel.addScaledVector(tmp.divideScalar(d), (spec.home || 62) * dt);
      s.vel.setLength(spec.speed);
    }
    s.g.position.addScaledVector(s.vel, dt);
    spec.anim(s.g, S.t, s.seed, spec.fly);
    if (spec.aim) spec.aim(s.g, s.vel);

    // ---- the body of a stream, strung along where its head has BEEN.
    // This is the difference between water flowing and a pellet with a tail:
    // the trail behind the other two kits is dropped and then abandoned, so it
    // hangs in the air; these segments are re-placed every frame along the
    // stored path, so the whole body slides forward after the head and stays
    // one connected thing from the ground to the tip.
    if (s.seg) {
      const st = spec.stream;
      const keep = st.count * st.every;
      const p = s.path.length >= keep ? s.path.pop() : { x: 0, y: 0, z: 0 };
      p.x = s.g.position.x; p.y = s.g.position.y; p.z = s.g.position.z;
      s.path.unshift(p);
      for (let i = 0; i < s.seg.length; i++) {
        const m = s.seg[i];
        const at = s.path[Math.min(s.path.length - 1, i * st.every)];
        if (!at || s.path.length <= i * st.every) { m.visible = false; continue; }
        m.visible = true;
        m.position.set(at.x, at.y, at.z);
        const f = i / Math.max(1, s.seg.length - 1);      // 0 head, 1 tail
        // Fattest just behind the head and drawn out toward the tail, so the
        // stream reads as something being PULLED rather than as a row of beads.
        const w = st.head * (1 - Math.pow(f, 0.7)) + st.tail;
        m.scale.setScalar(w * (1 + 0.16 * flick(S.t * 5.2 + i * 0.9 + s.seed)));
        m.material = st.mats[Math.min(st.mats.length - 1, (f * st.mats.length) | 0)];
      }
    }

    // ---- tail. Dropped at a fixed INTERVAL rather than once per frame, so
    // the trail has the same density at 30fps as at 144 instead of being
    // three times thinner on a slow machine.
    const tr = spec.trail;
    s.puffT -= dt;
    while (s.puffT <= 0 && s.life > 0 && castState.embers.length < 240) {
      s.puffT += tr.every;
      const p = new T.Mesh(tr.geo(), tr.mats[0]);
      p.position.copy(s.g.position);
      // Scatter each puff off the line of flight, widening the tail behind the
      // head the way a real plume does.
      p.position.x += rand(-tr.spread, tr.spread);
      p.position.y += rand(-tr.spread * 0.8, tr.rise);
      p.position.z += rand(-tr.spread, tr.spread);
      p.rotation.set(rand(0, 6.3), rand(0, 6.3), rand(0, 6.3));
      scene.add(p);
      // Owned by the SYSTEM, not by the shot that made it. A tail deleted the
      // instant its head lands snaps off mid-air; this way it is still hanging
      // there afterwards, which is what a real one does.
      castState.embers.push({ m: p, age: 0, mats: tr.mats, max: tr.life,
                              grow: tr.grow, spin: rand(tr.spin[0], tr.spin[1]),
                              drift: rand(tr.drift[0], tr.drift[1]),
                              size: rand(tr.size[0], tr.size[1]) });
    }

    let done = s.life <= 0 || s.g.position.y < 0.2;
    if (!done) {
      for (const w of walkers) {
        if (w.dead) continue;
        if (s.hit && s.hit.includes(w)) continue;   // already cut by this one
        const dx = w.pos.x - s.g.position.x, dz = w.pos.z - s.g.position.z;
        const dy = (w.pos.y + 1) - s.g.position.y;
        if (dx*dx + dy*dy + dz*dz < (spec.hitR + w.r) * (spec.hitR + w.r)) {
          damageWalker(w, spec.dmg * MOD.allDmg, tmp3.copy(s.vel).normalize(),
                       spec.knock, spec.kind);
          // A ball stops at the first body it touches; a blade carries on
          // through until its budget of bodies is spent.
          if (spec.pierce <= 0) { done = true; break; }
          (s.hit || (s.hit = [])).push(w);
          // Homing is what makes the shot feel aimed, and it is also what
          // would trap a piercing one: having passed THROUGH its target it
          // would turn straight back onto it and circle. Cutting a body
          // releases the blade to whatever is in front of it.
          if (s.seek === w) s.seek = null;
          if (s.hit.length >= spec.pierce) { done = true; break; }
        }
      }
    }
    if (done) {
      // A fireball ends in a blast, so a miss into a crowd is still worth the
      // shot. A blade has no blast at all — that is what its pierce is paid
      // for — so it simply comes apart where it stopped.
      if (spec.blastR > 0) {
        queueBlast(tmp3.copy(s.g.position), { r: spec.blastR * MOD.blastR,
                                              dmg: spec.blastDmg * MOD.blastDmg }, null);
        burst(s.g.position, spec.hot);
      } else {
        sparks(tmp3.copy(s.g.position), spec.hot, 7, 9);
      }
      if (s.seg) for (const m of s.seg) scene.remove(m);
      scene.remove(s.g);
      castState.shots.splice(i, 1);
    }
  }

  // ---- the tail, aged as one pool. Each puff carries the ladder it was born
  // with, so a wind mage's wisps still fade like wind after switching kits
  // mid-air rather than turning into smoke halfway down.
  for (let k = castState.embers.length - 1; k >= 0; k--) {
    const p = castState.embers[k];
    p.age += dt;
    const f = p.age / p.max;                       // 0 at birth, 1 at death
    if (f >= 1) { scene.remove(p.m); castState.embers.splice(k, 1); continue; }
    p.m.material = p.mats[Math.min(p.mats.length - 1, (f * p.mats.length) | 0)];
    // Swells and lifts as it ages, which is what turns a line of dots into a
    // plume rather than a dotted line.
    p.m.scale.setScalar(p.size * (0.55 + f * p.grow));
    p.m.position.y += p.drift * dt;
    p.m.rotation.y += p.spin * dt;
  }
}

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
  // An Archer holds further out than anything else that can actually hurt you,
  // and its lateral drift is high so it keeps sliding for a clean line rather
  // than standing still to be picked off.
  archer:   { ring: 17,  lateral: 0.85, spacing: 3.0, telegraph: 0.85 },
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
// Bleached tan sackcloth, not the dark olive it was — the reference's clothes
// read as filthy linen and that contrast against grey-green flesh is most of
// what makes the figure legible.
const zRag   = new T.MeshStandardMaterial({
  color:0x8f8663, roughness:0.96, metalness:0,
  normalMap:TEX.clothN, normalScale:new T.Vector2(2.0,2.0), envMapIntensity:0.35,
                                            side:T.DoubleSide });
const zBone  = new T.MeshStandardMaterial({ color:0xd2c9ad, roughness:0.68,
                                            metalness:0.02, envMapIntensity:0.5 });
const zWound = new T.MeshStandardMaterial({ color:0x71302a, roughness:0.85,
                                            metalness:0, envMapIntensity:0.25 });
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
  walker:  { name:"Walker",  code:"WK", hp:185, speed:2.05, scale:1.00, bulk:1.00,
             skin:0x8b9078, eye:0xff6a30, score:100 },
  runner:  { name:"Runner",  code:"RN", hp:110,  speed:4.70, scale:0.94, bulk:0.80,
             skin:0x969b80, eye:0xffd23c, score:130 },
  crawler: { name:"Crawler", code:"CR", hp:118,  speed:3.10, scale:0.58, bulk:1.10,
             skin:0x7b8069, eye:0xff9a30, score:120 },
  tank:    { name:"Tank",    code:"TK", hp:620, speed:1.25, scale:1.42, bulk:1.45,
             skin:0x6d7260, eye:0xff3c2a, armor:38, score:400 },
  armored: { name:"Armored", code:"AR", hp:300, speed:1.85, scale:1.10, bulk:1.20,
             skin:0x8d94a0, eye:0xff5a3c, armor:62, score:300 },
  exploder:{ name:"Exploder",code:"EX", hp:130,  speed:2.55, scale:1.05, bulk:1.25,
             skin:0xb06a3c, eye:0xffc23c, onDeath:"blast", score:180 },
  leaper:  { name:"Leaper",  code:"LP", hp:155,  speed:2.30, scale:0.98, bulk:0.88,
             skin:0x7d8c83, eye:0x6affc0, leap:true, score:200 },
  // A Shield holds a slab in front of it. Anything arriving from the front
  // is absorbed by the slab, so the answer is to go around it, blow it over,
  // or drop something on it from above.
  shield:  { name:"Shield",  code:"SH", hp:260, speed:1.55, scale:1.14, bulk:1.30,
             skin:0x6d7a86, eye:0xffb03c, shield:{ arc:0.55, hp:320 }, score:340 },
  // A Spawner is a timer: leave it alone and the arena fills with crawlers.
  spawner: { name:"Spawner", code:"SP", hp:380, speed:1.10, scale:1.25, bulk:1.50,
             skin:0x7a5f8a, eye:0xc06aff, spawns:{ every:5.2, type:"crawler", cap:6 },
             score:450 },
  // A Warper does what you do. It picks up loose props and throws them back,
  // which turns your own ammunition supply into a hazard.
  // Archer. The first enemy in the game that reaches out and hits you from
  // across the arena on its own initiative — a Warper needs a loose prop and a
  // Disruptor only spikes strain. Low health, because the answer is to kill it,
  // and a long draw so the shot is always readable before it is in the air.
  archer:  { name:"Archer",  code:"AR", hp:105, speed:1.95, scale:0.98, bulk:0.85,
             skin:0x6f7a5e, eye:0xffd23c, arrow:{ every:3.4, range:26, speed:26 },
             score:300 },
  warper:  { name:"Warper",  code:"WP", hp:215, speed:1.70, scale:1.06, bulk:0.95,
             skin:0x8a6a9c, eye:0xe94fbf, psy:{ every:4.4, range:22 }, score:380 },
  // Punishes careless positioning: closes and spikes your strain. It does
  // NOT switch telekinesis off — an ability that simply stops working is
  // frustration, not difficulty. It pushes you toward overload, which is
  // visible on the bar and can be backed away from.
  disruptor:{ name:"Disruptor", code:"DS", hp:175, speed:2.35, scale:1.00, bulk:0.9,
             skin:0x4a6a8a, eye:0x4FD6E9,
             disrupt:{ every:3.6, range:11, strain:0.28 }, score:420 },
  // Punishes letting anything reach you: roots the player for a moment.
  // Telegraphed, short, and broken by Dash.
  grabber: { name:"Grabber",  code:"GR", hp:235, speed:2.60, scale:1.08, bulk:1.15,
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
  { walker:4, runner:3, archer:1 },
  { walker:3, runner:3, leaper:2, archer:1 },
  { walker:4, runner:2, shield:2, archer:2 },
  { walker:3, leaper:3, exploder:2, armored:1, archer:2 },
  { walker:3, runner:3, disruptor:2, spawner:1, archer:2 },
  { walker:3, grabber:2, shield:2, tank:1, archer:2 },
  { runner:4, leaper:2, disruptor:2, warper:1, armored:2, archer:2 },
  { walker:4, grabber:2, shield:2, spawner:2, tank:1, exploder:3, archer:2 },
  { walker:4, runner:3, shield:2, archer:3 },
];

// The boss is a telekinesis problem, not a health bar: four plates must be
// stripped before the core can be touched, and it fights by throwing the
// same debris the player is using.
// Boss tiers, one per ten waves. A new one is a table entry plus a spawner, not
// a new branch in the wave code — and each has to be a different PROBLEM rather
// than the same fight with a longer bar. Eighty thousand health is not a boss,
// it is a wait.
//
//   10  THE MONOLITH a stone construct whose hands are not attached to it.
//                    It charges a punch, marks the ground it will land on,
//                    and craters where the fist falls. Break the chest
//                    plates to reach the core.
//   20  THE CHOIR    one thing wearing many bodies. The core cannot be touched
//                    while its acolytes orbit, and they move, so there is no
//                    safe side to stand on — unlike the Warden's fixed ring.
//   30  THE HOLLOW   immune to anything you throw at it. It arms you by
//                    hurling, and only its own returned ordnance hurts it.
//
// Past 30 the tiers cycle, each pass harder than the last.
const BOSS_TIERS = ["maw", "choir", "hollow"];
function bossForWave(n) {
  const tier = Math.max(1, Math.round(n / 10));
  return BOSS_TIERS[(tier - 1) % BOSS_TIERS.length];
}
// How many times the cycle has come round, so a second Gorger is not the same
// Gorger. Applied to health and pace, never to the mechanic.
function bossLap(n) { return Math.floor((Math.max(1, Math.round(n/10)) - 1) / BOSS_TIERS.length); }
// Every archetype that must be treated as a singular, front-loaded boss rather
// than as a body in the crowd. Derived once and used by all three places in
// buildWave that care — the count multiplier, the overflow trim, and the
// front-load. Each of those used to carry its own hand-written list, and each
// time a boss was added one of them was missed: the count multiplier gave two
// Wardens, and the front-load let the Choir be shuffled into a mid-wave pulse
// so a milestone wave opened with no boss roughly half the time.
const BIG_TYPES = ["boss", ...BOSS_TIERS];

const CHOIR = {
  name:"THE CHOIR", coreHp:2600, acolytes:6, acolyteHp:260,
  speed:1.15, orbit:5.2, orbitSpin:0.55, lungeEvery:3.2, score:12000,
};
const HOLLOW = {
  name:"THE HOLLOW", coreHp:1800, speed:1.6, hurlEvery:2.1,
  returnMul:9,          // a returned prop hits for nine times its damage
  chip:0.04,            // everything else does this fraction, so it is never
                        // literally unkillable — only obviously the wrong idea
  score:16000,
};

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
  name:"THE MONOLITH", plateHp:420, plates:6, coreHp:4200,
  speed:1.05, reach:5.4, score:20000,
  // The punch IS the fight. A hand pulls back off its slot, its seams light,
  // and a ring burns on the ground where it is going to land. The ring is up
  // for the whole wind-up, so the attack is always answerable: you move, or
  // you wear it. Everything else this thing does is pacing between punches.
  punchEvery:  3.4,   // seconds between punches; the hands alternate
  charge:      1.15,  // wind-up. Long, because it is the read
  punchSpeed:  34,    // travel
  punchR:      2.9,   // contact radius on the way in
  craterR:     9.5,   // ring thrown out where the fist lands
  returnSpeed: 15,
  punchRange:  30,    // beyond this it closes on foot instead
  slamR:       17,    // default reach of a shock ring
  hurlEvery:   5.4,
  roarEvery:   11,
  enrageAt:    0.35,  // fraction of core health
};
// Reused every frame by the hand solver rather than allocating two vectors per
// hand per frame.
const HAND_TMP = new T.Vector3(), HAND_TMP2 = new T.Vector3();
const UP_AXIS = new T.Vector3(0, 1, 0);
const SEAM_COLD = new T.Color(0x3a1a08), SEAM_HOT = new T.Color(0xffb454);

// Expanding ground shockwaves. A ring you jump over rather than out-run,
// which is why the arena has a jump button at all.
//
// It has to be drawn as a ring lying ON the floor. The first version reused
// shell(), the spherical flash explosions use — at a 17 metre radius that
// sphere swallows the camera and whites out the screen, which is the exact
// opposite of a readable telegraph.
const shocks = [];
const shockGeo = new T.RingGeometry(0.92, 1.0, 56);

function makeShock(pos, max) {
  const mesh = new T.Mesh(shockGeo, new T.MeshBasicMaterial({
    color: 0xff6a20, transparent: true, opacity: 0.9,
    side: T.DoubleSide, depthWrite: false, blending: T.AdditiveBlending }));
  mesh.rotation.x = -Math.PI/2;
  mesh.position.set(pos.x, 0.12, pos.z);
  scene.add(mesh);
  return { pos: pos.clone(), r: 2, max: max || MAW.slamR, hit: false, mesh };
}

function killShock(sw) {
  scene.remove(sw.mesh);
  sw.mesh.material.dispose();
}

// Wound tint targets. Kept module-level so the per-frame path allocates
// nothing: a colour object per walker per frame is exactly the kind of churn
// that shows up as GC sawtooth in a wave of forty bodies.
const WOUND_COL  = new T.Color(0x5a1410);
const WOUND_GLOW = new T.Color(0xff2a10);
const tmpCol     = new T.Color();

// ═══════════════════════════════════════════════════════════════════ arrows
// The Archer's shot. A real projectile rather than a hitscan: it takes time to
// cross the gap, which is the only reason a telegraph means anything. It can be
// out-walked, dashed through, or blocked by putting a pillar between you and
// the shooter — all three are things the player already knows how to do.
const arrows = [];
const arrowShaftGeo = new T.CylinderGeometry(0.035, 0.035, 1.25, 5);
arrowShaftGeo.rotateX(Math.PI / 2);                 // lie along -Z, its travel axis
const arrowHeadGeo = new T.ConeGeometry(0.10, 0.30, 5);
arrowHeadGeo.rotateX(-Math.PI / 2);
arrowHeadGeo.translate(0, 0, -0.72);
const arrowMat = new T.MeshStandardMaterial({ color:0x9a8b6a, roughness:0.8 });
const arrowTipMat = new T.MeshStandardMaterial({ color:0xffd23c, emissive:0xffb020,
                                                  emissiveIntensity:1.4, roughness:0.4 });

function fireArrow(from, speed) {
  const g = new T.Group();
  g.add(new T.Mesh(arrowShaftGeo, arrowMat));
  g.add(new T.Mesh(arrowHeadGeo, arrowTipMat));
  // Aimed at the chest, from the bow rather than from the feet.
  g.position.set(from.x, 1.9, from.z);
  const dir = tmp2.set(hero.pos.x - from.x, 1.15 - 1.9, hero.pos.z - from.z).normalize();
  g.lookAt(g.position.x + dir.x, g.position.y + dir.y, g.position.z + dir.z);
  scene.add(g);
  arrows.push({ g, pos:g.position, dir:dir.clone(), spd:speed, life:3.2 });
  SFX.throw(1.25);
}

function stepArrows(dt) {
  for (let i = arrows.length - 1; i >= 0; i--) {
    const a = arrows[i];
    a.life -= dt;
    // Substepped. At 26 units a second against a hero capsule under a metre
    // wide, a single-step test at 30fps skips straight past the player on some
    // frames — the arrow passes through and nothing happens. This is the same
    // tunnelling that made thrown props miss, and it is fixed the same way.
    const steps = Math.max(1, Math.ceil(a.spd * dt / 0.35));
    const h = dt / steps;
    let done = a.life <= 0;
    for (let k = 0; k < steps && !done; k++) {
      a.pos.addScaledVector(a.dir, a.spd * h);
      if (a.pos.y < 0.1) { done = true; break; }
      const dx = a.pos.x - hero.pos.x, dz = a.pos.z - hero.pos.z;
      const dy = a.pos.y - 1.15;
      if (dx*dx + dz*dz < 0.42 && Math.abs(dy) < 1.05) {
        // Dashing is invulnerability everywhere else in this game; an arrow
        // must not be the one thing a dash cannot beat.
        if (S.dashT === undefined || S.dashT <= 0) {
          hurtHero();
          S.shake = Math.min(1.0, S.shake + 0.45);
          sparks(tmp3.set(a.pos.x, a.pos.y, a.pos.z), 0xffd23c, 10, 16);
          SFX.impact(0.6, 1);
        }
        done = true;
      }
    }
    if (done) { scene.remove(a.g); arrows.splice(i, 1); }
  }
}

function clearArrows() {
  for (const a of arrows) scene.remove(a.g);
  arrows.length = 0;
}

const walkers = [];

// The Monolith's glowing crack network, drawn once and reused by every chunk of
// its body. Geometry strips were the other option and they look like applied
// stripes; an emissive map reads as light escaping from inside the stone, which
// is the whole point of the reference.
//
// Each crack is a random walk. Every stroke is drawn nine times at +/- one
// canvas width so the pattern wraps — a seam running down a boulder is more
// visible than the cracks themselves.
function makeCrackTex() {
  const S = 256, c = canvasOf(S), g = c.getContext("2d");
  g.fillStyle = "#000"; g.fillRect(0, 0, S, S);
  g.lineCap = "round";
  const stroke = (pts, w, a) => {
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
      g.beginPath();
      g.moveTo(pts[0][0] + ox*S, pts[0][1] + oy*S);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0] + ox*S, pts[i][1] + oy*S);
      g.lineWidth = w; g.strokeStyle = "rgba(255,244,214," + a + ")"; g.stroke();
    }
  };
  // Radiating hubs: the reference has star-bursts where several cracks meet,
  // and those nodes are what stop it reading as crazed pottery.
  for (let h = 0; h < 3; h++) {
    const hx = Math.random()*S, hy = Math.random()*S;
    const arms = 3 + Math.floor(Math.random()*2);
    for (let a = 0; a < arms; a++) {
      let ang = (a/arms)*Math.PI*2 + Math.random()*0.6;
      let px = hx, py = hy;
      const pts = [[px, py]];
      const steps = 4 + Math.floor(Math.random()*3);
      for (let i = 0; i < steps; i++) {
        ang += (Math.random()-0.5)*0.9;
        const len = 6 + Math.random()*13;
        px += Math.cos(ang)*len; py += Math.sin(ang)*len;
        pts.push([px, py]);
      }
      stroke(pts, 3.4, 0.22);   // soft halo under the hot line
      stroke(pts, 1.5, 0.95);
    }
  }
  const t = texFrom(c, 1);
  return t;
}

function spawnMaw(x, z) {
  const g = new T.Group();
  // Pale blue-green stone lit from inside, not grey granite. The cracks are an
  // emissive map rather than painted lines, so the light reads as coming from
  // under the surface — see makeCrackTex.
  TEX.cracks = TEX.cracks || makeCrackTex();
  const stoneM = (col, rough) => new T.MeshStandardMaterial({
    color: col, roughness: rough, metalness: 0.04,
    normalMap: TEX.rockN, normalScale: new T.Vector2(1.3, 1.3),
    emissive: 0xffffff, emissiveMap: TEX.cracks, emissiveIntensity: 0.85,
    envMapIntensity: 0.55 });
  const rockM  = stoneM(0x74a3b0, 0.86);
  const darkM  = stoneM(0x4f7783, 0.9);
  const plateM = stoneM(0x8fbcc6, 0.72);
  const coreM  = new T.MeshStandardMaterial({ color:0xfff2d0, emissive:0xffe9b0,
                                              emissiveIntensity:2.0, roughness:0.35 });

  // A boulder. The whole body is these — a low-poly icosahedron squashed and
  // spun at random, which reads as broken rock where a box reads as masonry.
  // The reference is a pile of chunks, not a stack of slabs.
  const chunk = (parent, r, px, py, pz, sx, sy, sz, mat) => {
    const m = part(new T.IcosahedronGeometry(r, 0), mat || rockM, px, py, pz);
    m.scale.set(sx, sy, sz);
    m.rotation.set(rand(0, 6.283), rand(0, 6.283), rand(0, 6.283));
    parent.add(m);
    return m;
  };

  const HIP = 4.3, SHOULDER = 7.4;

  // Legs: short and thick, carrying a top-heavy mass. Chunk overlays give the
  // limb a broken outline instead of a smooth capsule.
  const lL = limb(g, HIP, rockM, -1.7, HIP, 0.1, 1.15);
  const lR = limb(g, HIP, rockM,  1.7, HIP, -0.1, 1.15);
  for (const leg of [lL, lR]) {
    chunk(leg, 1.5, 0, -0.9, 0, 1.15, 1.0, 1.1, rockM);
    chunk(leg.joint, 1.35, 0, -0.85, 0, 1.1, 0.95, 1.05, darkM);
    // Wide splayed foot, built from three boulders rather than a box.
    chunk(leg.joint, 1.05, -0.4, -HIP*0.48, 0.5, 1.0, 0.55, 1.3, darkM);
    chunk(leg.joint, 0.95,  0.45, -HIP*0.48, 0.35, 0.95, 0.5, 1.2, darkM);
    chunk(leg.joint, 0.8,   0.0, -HIP*0.46, -0.5, 0.9, 0.5, 0.85, rockM);
  }

  const body = new T.Group();
  body.position.y = HIP;
  g.add(body);

  // Torso: a hunched wedge of boulders, widest at the shoulders and tapering
  // into the hips — the reference's mass is nearly all above the waist.
  chunk(body, 1.9, 0, 0.05, 0, 1.25, 0.95, 1.05, darkM);
  chunk(body, 2.15, 0, 1.35, 0.1, 1.2, 1.0, 1.0, rockM);
  chunk(body, 2.35, -0.5, 2.5, 0, 1.15, 1.0, 0.95, rockM);
  chunk(body, 2.3,  0.55, 2.55, 0.05, 1.15, 1.0, 0.95, rockM);
  // Back slabs — the star-burst node between the shoulder blades is the most
  // recognisable single feature of the reference from behind.
  chunk(body, 1.6, 0, 2.6, -1.3, 1.5, 1.2, 0.7, rockM);
  chunk(body, 1.2, -0.9, 3.4, -1.1, 1.1, 0.9, 0.65, darkM);
  chunk(body, 1.2,  0.9, 3.4, -1.1, 1.1, 0.9, 0.65, darkM);

  // Shoulders: two great boulder masses cantilevered out and UP, so the head
  // sits in a trough between them.
  chunk(body, 2.05, -2.55, SHOULDER-HIP-0.35, 0, 1.0, 0.9, 0.95, rockM);
  chunk(body, 2.05,  2.55, SHOULDER-HIP-0.35, 0, 1.0, 0.9, 0.95, rockM);
  chunk(body, 1.25, -2.95, SHOULDER-HIP+0.55, -0.35, 0.85, 0.75, 0.8, darkM);
  chunk(body, 1.25,  2.95, SHOULDER-HIP+0.55, -0.35, 0.85, 0.75, 0.8, darkM);

  // Head: small, sunk low between the shoulders, barely clearing them.
  const neck = new T.Group();
  neck.position.set(0, SHOULDER-HIP+0.05, 0.4);
  body.add(neck);
  const head = new T.Group();
  head.position.set(0, 0.7, 0.15);
  neck.add(head);
  chunk(head, 1.35, 0, 0, 0, 1.05, 0.9, 1.0, rockM);
  chunk(head, 0.7, -0.75, 0.35, 0.35, 0.8, 0.7, 0.8, darkM);
  chunk(head, 0.7,  0.75, 0.35, 0.35, 0.8, 0.7, 0.8, darkM);
  // Eyes: two hot points in the crack light, the only symmetry on the model.
  head.add(part(new T.SphereGeometry(0.19, 8, 6), coreM, -0.42, 0.05, 1.02));
  head.add(part(new T.SphereGeometry(0.19, 8, 6), coreM,  0.42, 0.05, 1.02));
  const eyeLight = new T.PointLight(0xffe9b0, 2.4, 16, 2);
  eyeLight.position.set(0, 0.1, 1.4);
  head.add(eyeLight);

  // The jaw is the lower boulder of the head, hinged — the step code drives
  // w.jaw on the reinforcement call either way.
  const jaw = new T.Group();
  jaw.position.set(0, -0.7, 0.25);
  head.add(jaw);
  chunk(jaw, 0.85, 0, -0.25, 0.1, 1.15, 0.6, 0.9, darkM);

  // Chest core — what you are trying to hit once the plates are off. It sits
  // where the crack network converges, so an exposed core reads as the thing
  // lighting the whole body.
  const core = part(new T.OctahedronGeometry(1.05, 0), coreM, 0, 1.9, 1.5);
  body.add(core);
  const glow = new T.PointLight(0xffd27a, 0, 26, 2);
  glow.position.set(0, HIP + 1.9, 1.7);
  g.add(glow);

  // Plates: paler boulders spalled over the chest. Break them to reach the core.
  const plates = [];
  for (let i = 0; i < MAW.plates; i++) {
    const a = (i / MAW.plates) * Math.PI * 2;
    const pl = chunk(body, 1.0, Math.sin(a) * 1.75, 1.9 + Math.cos(a) * 1.3, 1.55,
                     1.15, 1.0, 0.65, plateM);
    plates.push({ mesh: pl, hp: MAW.plateHp });
  }

  const tell = new T.Mesh(new T.RingGeometry(3.0, 4.2, 26),
    new T.MeshBasicMaterial({ color:0xffd27a, transparent:true, opacity:0,
                              side:T.DoubleSide, depthWrite:false }));
  tell.rotation.x = -Math.PI/2;
  tell.position.y = 10.2;
  tell.visible = false;
  g.add(tell);

  g.position.set(x, 0, z);
  scene.add(g);

  // ── the hands ─────────────────────────────────────────────────────────────
  // Kept detached, because the charging punch is the fight and it needs a hand
  // that can leave, cross twenty metres and come back. The reference's arms are
  // attached, but its fists are exactly this shape — so the silhouette matches
  // and the mechanic survives. World-space parts go on w.detached; nothing in
  // the normal teardown path reaches them otherwise.
  const hands = [], detached = [];
  for (const side of [-1, 1]) {
    const h = new T.Group();
    chunk(h, 1.7, 0, 0, 0, 1.15, 1.0, 1.0, rockM);
    // Knuckle boulders across the striking face.
    for (let i = -1; i <= 1; i++)
      chunk(h, 0.72, i * 0.85, 0.35, 1.35, 1.0, 0.9, 0.9, plateM);
    // Curled fingers underneath.
    for (let i = -1; i <= 1; i++)
      chunk(h, 0.62, i * 0.8, -0.85, 0.95, 0.95, 0.9, 1.35, darkM);
    chunk(h, 0.8, side * -0.9, -0.35, 0.95, 1.1, 0.85, 0.9, darkM);
    // Wrist ring: the one place a hand's own light is driven separately, so a
    // charging fist can come up to heat while its twin stays cold.
    const seam = part(new T.TorusGeometry(1.35, 0.16, 6, 12),
                      new T.MeshBasicMaterial({ color: SEAM_COLD.getHex() }),
                      0, -0.1, -0.75);
    seam.rotation.x = Math.PI/2;
    h.add(seam);
    scene.add(h);

    const mark = new T.Mesh(new T.RingGeometry(MAW.punchR * 0.72, MAW.punchR, 30),
      new T.MeshBasicMaterial({ color:0xffd27a, transparent:true, opacity:0.9,
        side:T.DoubleSide, depthWrite:false, blending:T.AdditiveBlending }));
    mark.rotation.x = -Math.PI/2;
    mark.visible = false;
    scene.add(mark);

    hands.push({
      g: h, seam, mark, side,
      slot: new T.Vector3(side * 4.7, SHOULDER - 3.9, 3.0),
      state: "idle", t: 0, target: new T.Vector3(),
    });
    detached.push(h, mark);
  }
  for (const h of hands) h.g.position.set(x + h.slot.x, h.slot.y, z + h.slot.z);

  walkers.push({ g, body, torso: body, head, jaw, bodyY: HIP,
    lL, lR, pos: g.position,
    type:"maw", boss:true, maw:true, core, glow, plates, platesLeft:MAW.plates,
    hands, detached, nextHand:0, punchT: MAW.punchEvery, punchHits:0,
    E:{ name:MAW.name, hp:MAW.coreHp, speed:MAW.speed, scale:3.6, skin:0x74a3b0,
        score:MAW.score },
    reach: MAW.reach,
    r:4.2, walk:0, gait:0, spd:0, dead:false, cool:0,
    atkT: MAW.hurlEvery, roarT: MAW.roarEvery,
    AI: AI.tank, arcDir:1, windup:0, jawOpen:0, enraged:false,
    hp:MAW.coreHp, maxHp:MAW.coreHp, flash:0, kb:new T.Vector3(),
    // Without these the shared mover never runs: it gates on `w.thrown <= 0`
    // and `undefined <= 0` is FALSE — so a boss record without these fields
    // simply never moves. That is how the Warden ended up frozen in place
    // from the moment the guard was added, and nobody noticed because every
    // boss test damaged it directly instead of letting it walk.
    thrown:0, tvel:new T.Vector3(),
    leapT:99, vy:0, air:false });
}

// ── THE CHOIR ───────────────────────────────────────────────────────────────
// One thing wearing several bodies. The core cannot be damaged while acolytes
// orbit it, and because they ORBIT there is no safe side to stand on — that is
// the whole difference from the Warden, whose plates sit still and can be
// flanked. Kill acolytes and the survivors orbit faster, so the fight speeds up
// as it shortens.
function spawnChoir(x, z, lap) {
  const scale = 1 + lap * 0.35;
  const g = new T.Group();
  const skinM = new T.MeshStandardMaterial({ color:0x5a4a6b, roughness:0.9,
    normalMap:TEX.fleshN, normalScale:new T.Vector2(1.1,1.1), envMapIntensity:0.4 });
  const coreM = new T.MeshStandardMaterial({ color:0xc06aff, emissive:0xc06aff,
    emissiveIntensity:1.6, roughness:0.3 });

  g.add(part(new T.CylinderGeometry(0.9, 1.35, 2.6, 8), skinM, 0, 1.7, 0));
  g.add(part(new T.SphereGeometry(0.62, 12, 9), skinM, 0, 3.4, 0));
  const core = part(new T.OctahedronGeometry(0.85, 0), coreM, 0, 2.3, 0);
  g.add(core);
  const glow = new T.PointLight(0xc06aff, 0.4, 20, 2);
  glow.position.set(0, 2.3, 0); g.add(glow);

  const tell = new T.Mesh(new T.RingGeometry(1.6, 2.3, 22),
    new T.MeshBasicMaterial({ color:0xc06aff, transparent:true, opacity:0,
                              side:T.DoubleSide, depthWrite:false }));
  tell.rotation.x = -Math.PI/2; tell.position.y = 4.4; tell.visible = false;
  g.add(tell);

  g.position.set(x, 0, z);
  g.scale.setScalar(scale);
  scene.add(g);

  // Acolytes are their own groups in world space, not children — they have to
  // orbit independently and be hit on their own.
  const acolytes = [];
  const n = CHOIR.acolytes;
  for (let i = 0; i < n; i++) {
    const ag = new T.Group();
    const am = new T.MeshStandardMaterial({ color:0x7a6a8c, roughness:0.92,
      emissive:0x2a1040, emissiveIntensity:0.5 });
    ag.add(part(new T.CylinderGeometry(0.34, 0.46, 1.5, 7), am, 0, 0.95, 0));
    ag.add(part(new T.SphereGeometry(0.34, 10, 8), am, 0, 1.95, 0));
    ag.add(part(new T.SphereGeometry(0.09, 6, 5),
          new T.MeshBasicMaterial({ color:0xffb0ff }), 0, 2.0, 0.28));
    ag.scale.setScalar(scale);
    scene.add(ag);
    acolytes.push({ g:ag, a:(i/n)*Math.PI*2, hp:Math.round(CHOIR.acolyteHp*(1+lap*0.5)),
                    maxHp:Math.round(CHOIR.acolyteHp*(1+lap*0.5)), alive:true, lungeT:rand(1,3) });
  }

  const hp = Math.round(CHOIR.coreHp * (1 + lap*0.6));
  walkers.push({ g, body:g, torso:g, pos:g.position,
    type:"choir", boss:true, choir:true, core, glow, tell, acolytes,
    plates:[], platesLeft:0,
    E:{ name:CHOIR.name, hp, speed:CHOIR.speed, scale:2.4*scale, skin:0x5a4a6b,
        score:CHOIR.score },
    reach:3.4, r:2.0*scale, walk:0, gait:0, spd:0, dead:false, cool:0,
    AI:AI.tank, arcDir:1, windup:0, orbit:0,
    hp, maxHp:hp, flash:0, kb:new T.Vector3(),
    thrown:0, tvel:new T.Vector3(), leapT:99, vy:0, air:false });
}

// ── THE HOLLOW ──────────────────────────────────────────────────────────────
// Immune to anything you throw at it, so the usual answer simply stops working.
// It arms you instead: it hurls constantly, and a prop you catch mid-flight and
// send back is the only thing that lands. Everything else chips at four percent
// — never literally unkillable, just obviously the wrong idea.
function spawnHollow(x, z, lap) {
  const scale = 1 + lap * 0.3;
  const g = new T.Group();
  // Matte charcoal, not the polished metal it used to be. The reference this
  // is built from is a charcoal drawing: the form has to read from silhouette
  // and edge alone, so a shiny surface actively fights it.
  const hideM = new T.MeshStandardMaterial({ color:0x272b34, roughness:0.82,
    metalness:0.05, envMapIntensity:0.35 });
  const boneM = new T.MeshStandardMaterial({ color:0x3d434e, roughness:0.6,
    metalness:0.18, envMapIntensity:0.7 });
  const voidM = new T.MeshBasicMaterial({ color:0x05060a });
  const eyeM  = new T.MeshBasicMaterial({ color:0x8fd8ff });

  // A thorn. Every spike on this thing is one of these, which is what makes
  // the crown and the arm barbs the same language rather than two ideas.
  const thorn = (parent, len, rad, px, py, pz, rx, rz) => {
    const m = part(new T.ConeGeometry(rad, len, 5), boneM, px, py, pz);
    m.rotation.set(rx, 0, rz);
    parent.add(m);
    return m;
  };

  const HIP = 2.8, SHOULDER = 5.05;

  // Digitigrade legs: thin, and long enough that the thing towers. The claws
  // are added to the shin so they swing with the step.
  const lL = limb(g, HIP, hideM, -0.66, HIP, 0, 0.33);
  const lR = limb(g, HIP, hideM,  0.66, HIP, 0, 0.33);
  for (const leg of [lL, lR]) {
    const foot = part(new T.BoxGeometry(0.5, 0.18, 0.9), hideM, 0, -HIP*0.48 - 0.06, 0.24);
    leg.joint.add(foot);
    // Splayed toe-claws. Three forward, one back — the reference's feet are
    // the widest part of its footprint and that is what sells the weight.
    for (let i = -1; i <= 1; i++)
      thorn(leg.joint, 0.62, 0.10, i*0.20, -HIP*0.48 - 0.10, 0.72, 1.35, 0);
    thorn(leg.joint, 0.44, 0.09, 0, -HIP*0.48 - 0.10, -0.26, -1.5, 0);
    // Bound from hip to knee, as in the reference.
    for (let i = 0; i < 3; i++) {
      const wrap = part(new T.TorusGeometry(0.37 - i*0.02, 0.07, 5, 12), boneM,
                        0, -0.42 - i*0.36, 0);
      wrap.rotation.x = Math.PI/2;
      leg.add(wrap);
    }
  }

  // Everything above the hip leans as one piece, so the gait's hunch drives
  // the whole upper mass. bodyY is the rest height the bob is added to.
  const body = new T.Group();
  body.position.y = HIP;
  g.add(body);

  // Trunk: narrow at the waist, broad at the shoulders — an inverted wedge.
  const waist = part(new T.CylinderGeometry(0.68, 0.5, 0.95, 8), hideM, 0, 0.12, 0);
  body.add(waist);
  const trunk = part(new T.CylinderGeometry(1.28, 0.92, 2.15, 10), hideM, 0, 1.55, 0);
  body.add(trunk);

  // Ribbed segmentation up the trunk. The reference's torso is banded the
  // whole way, and those bands are most of why it reads as flayed rather
  // than armoured.
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    const rib = part(new T.TorusGeometry(0.56 + t*0.86, 0.085, 5, 14), boneM,
                     0, 0.5 + i*0.42, 0.02);
    rib.rotation.x = Math.PI/2;
    rib.scale.set(1, 0.66, 1);
    body.add(rib);
  }

  // No head. The mass just ends in a shoulder yoke, and the only feature on
  // it is a single vertical slit — which is far more unpleasant than a face.
  const yoke = part(new T.SphereGeometry(1.2, 12, 10), hideM, 0, 2.92, -0.05);
  yoke.scale.set(1.28, 0.98, 1.0);
  body.add(yoke);
  const slit = part(new T.BoxGeometry(0.18, 1.1, 0.12), voidM, 0, 2.72, 0.98);
  body.add(slit);
  body.add(part(new T.BoxGeometry(0.08, 0.7, 0.06), eyeM, 0, 2.72, 1.05));

  // The crown: thorns fanned around and above the yoke, longest at the back,
  // so the profile is a spread of spines rather than a hedgehog.
  for (let i = 0; i < 13; i++) {
    const a = (i / 12) * Math.PI * 2;
    const back = 0.55 + 0.45 * Math.cos(a);   // longest pointing rearward
    thorn(body, 1.55 + back*1.9, 0.155,
          Math.sin(a) * 1.34, 3.16, Math.cos(a) * 0.72 - 0.05,
          -Math.cos(a) * 0.85, -Math.sin(a) * 0.95);
  }
  // A second, shorter rank down the spine.
  for (let i = 0; i < 4; i++)
    thorn(body, 0.95 - i*0.12, 0.11, 0, 2.6 - i*0.5, -0.78, -2.35, 0);

  // The hollow itself: an open cavity in the chest where a sternum should be.
  // This is the mechanic made visible — there is nothing in there to hit, and
  // the only thing that reaches it is ordnance it threw at you first.
  body.add(part(new T.TorusGeometry(0.72, 0.19, 7, 14), boneM, 0, 1.75, 0.52));
  body.add(part(new T.SphereGeometry(0.6, 11, 9), voidM, 0, 1.75, 0.56));
  const core = part(new T.OctahedronGeometry(0.34, 0),
    new T.MeshStandardMaterial({ color:0x8fd8ff, emissive:0x8fd8ff,
      emissiveIntensity:1.8, roughness:0.3 }), 0, 1.75, 0.6);
  body.add(core);
  const glow = new T.PointLight(0x8fd8ff, 1.2, 22, 2);
  glow.position.set(0, HIP + 1.75, 0.7); g.add(glow);

  const tell = new T.Mesh(new T.RingGeometry(2.2, 3.0, 24),
    new T.MeshBasicMaterial({ color:0x8fd8ff, transparent:true, opacity:0,
                              side:T.DoubleSide, depthWrite:false }));
  tell.rotation.x = -Math.PI/2; tell.position.y = 6.4; tell.visible = false;
  g.add(tell);

  // Arms longer than the creature is tall, hung wide off the shoulders. This
  // is the whole silhouette — in the reference they bow out and the hands
  // reach past the feet.
  const aL = limb(g, 4.35, hideM, -1.78, SHOULDER, -0.05, 0.3);
  const aR = limb(g, 4.35, hideM,  1.78, SHOULDER, -0.05, 0.3);
  for (const [arm, side] of [[aL, -1], [aR, 1]]) {
    // Bowed outward at rest so the arms frame the body instead of hanging
    // flat against it.
    arm.rotation.z = side * 0.3;
    arm.joint.rotation.z = -side * 0.34;
    // Barbs down both segments, alternating and growing toward the hand —
    // the reference's arms are serrated their whole length.
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      thorn(arm, 0.5 + t*0.42, 0.085, side*0.16, -0.35 - i*0.5, -0.05,
            -0.35, side * (1.05 + t*0.35));
    }
    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      thorn(arm.joint, 0.62 + t*0.55, 0.09, side*0.15, -0.3 - i*0.42, -0.05,
            -0.3, side * (1.15 + t*0.4));
    }
    // Hand: a splay of long claws rather than a fist.
    for (let i = -1; i <= 1; i++)
      thorn(arm.joint, 1.2, 0.085, i*0.17, -2.2, 0.05, 2.75, i*0.28);
  }

  g.position.set(x, 0, z);
  g.scale.setScalar(scale);
  scene.add(g);

  const hp = Math.round(HOLLOW.coreHp * (1 + lap*0.6));
  walkers.push({ g, body, torso: body, bodyY: HIP, aL, aR, lL, lR, pos:g.position,
    type:"hollow", boss:true, hollow:true, core, glow, tell,
    plates:[], platesLeft:0,
    E:{ name:HOLLOW.name, hp, speed:HOLLOW.speed, scale:2.2*scale, skin:0x16181d,
        score:HOLLOW.score },
    reach:4.2, r:1.9*scale, walk:0, gait:0, spd:0, dead:false, cool:0, armRest:-0.12,
    AI:AI.tank, arcDir:1, windup:0, atkT:HOLLOW.hurlEvery,
    hp, maxHp:hp, flash:0, kb:new T.Vector3(),
    thrown:0, tvel:new T.Vector3(), leapT:99, vy:0, air:false });
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
    // gait/spd are not optional either, for the same reason as thrown/tvel
    // below: the shared gait does `w.gait += ...`, and `undefined + n` is NaN.
    // That NaN reached gaitBob, then body.position.y — and since this rig's
    // body IS its root group, the Warden's WORLD Y went NaN on its first
    // animated frame. It still walked and still threw, because those read x
    // and z only, which is exactly why it survived untested this long.
    r:2.0, walk:0, gait:0, spd:0, dead:false, cool:0, atkT:BOSS.atkEvery,
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
  if (type === "boss")   return spawnBoss(x, z);
  if (type === "maw")    return spawnMaw(x, z);
  if (type === "choir")  return spawnChoir(x, z, bossLap(S.wave));
  if (type === "hollow") return spawnHollow(x, z, bossLap(S.wave));
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

  // Torn hem: a ring of tapered spikes hanging off the bottom of the shirt.
  // The reference's clothing is defined by its ragged edge more than by its
  // colour, and a clean cylinder hem is what reads as "untextured cylinder".
  const hemN = 9;
  for (let i = 0; i < hemN; i++) {
    const a2 = (i/hemN)*Math.PI*2;
    const len = rand(0.10, 0.26);
    const tag = part(new T.ConeGeometry(0.055*B, len, 4), zRag,
                     Math.cos(a2)*0.42*B, -0.16 - len/2, Math.sin(a2)*0.42*B);
    tag.rotation.set(rand(-0.2,0.2), a2, rand(-0.2,0.2));
    torso.add(tag);
  }
  // A wound, placed at random so the crowd is not identical.
  const wnd = part(new T.SphereGeometry(rand(0.05,0.085), 7, 5), zWound,
                   rand(-0.18,0.18)*B, rand(0.18,0.52), 0.17*B);
  wnd.scale.set(1.3, 1.0, 0.5);
  torso.add(wnd);

  // Head lolls to one side.
  const neck = new T.Group();
  neck.position.set(0, 0.76, 0.04);
  neck.rotation.z = rand(-0.35, 0.35);
  neck.rotation.x = -0.2;
  torso.add(neck);
  const skull = part(new T.SphereGeometry(0.225, 14, 10), skinM, 0, 0.1, 0);
  skull.scale.set(0.9, 1.08, 1.02);
  neck.add(skull);
  // Brow ridge and cheekbones in bare bone, which is what gives the head a
  // skull underneath rather than a smooth ball with eyes stuck on.
  const brow = part(new T.BoxGeometry(0.30, 0.055, 0.10), zBone, 0, 0.205, 0.14);
  brow.rotation.x = -0.22; neck.add(brow);
  neck.add(part(new T.SphereGeometry(0.055, 7, 5), zBone, -0.135, 0.09, 0.155));
  neck.add(part(new T.SphereGeometry(0.055, 7, 5), zBone,  0.135, 0.09, 0.155));
  // Sunken sockets: a dark recess behind each eye so the glow sits INSIDE a
  // hole instead of bulging off the front of the face.
  neck.add(part(new T.SphereGeometry(0.085, 8, 6), zWound, -0.095, 0.14, 0.16));
  neck.add(part(new T.SphereGeometry(0.085, 8, 6), zWound,  0.095, 0.14, 0.16));
  neck.add(part(new T.SphereGeometry(0.052, 8, 6), eyeM, -0.095, 0.14, 0.20));
  neck.add(part(new T.SphereGeometry(0.052, 8, 6), eyeM,  0.095, 0.14, 0.20));
  // Exposed upper teeth and a hanging jaw.
  neck.add(part(new T.BoxGeometry(0.19, 0.05, 0.09), zBone, 0, 0.03, 0.175));
  const jawL = part(new T.BoxGeometry(0.20, 0.10, 0.12), zJaw, 0, -0.045, 0.165);
  jawL.rotation.x = 0.22; neck.add(jawL);

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
  if (EE.arrow) {
    // A bow, held out and lit. The Archer shipped with nothing but a slightly
    // different skin tone, which at its 17-unit standoff in a dark arena is no
    // silhouette at all — the player reported simply never seeing one. This
    // file's own rule is that an archetype needs a shape before it needs a
    // statline, and this one had the statline only.
    const bowMat = new T.MeshStandardMaterial({ color:0x8a6a3c, roughness:0.6,
      emissive:0xffd23c, emissiveIntensity:0.55 });
    const limb1 = new T.Mesh(new T.TorusGeometry(0.62, 0.055, 5, 12, Math.PI*1.15), bowMat);
    limb1.rotation.y = Math.PI/2;
    limb1.position.set(0.34, 1.28, 0.34);
    limb1.castShadow = true;
    body.add(limb1);
    // Drawn string, so the shape reads as a bow rather than a hoop.
    const string = new T.Mesh(new T.CylinderGeometry(0.018, 0.018, 1.18, 4),
      new T.MeshBasicMaterial({ color:0xffe9a0 }));
    string.position.set(0.34, 1.28, 0.10);
    body.add(string);
    // A lit nock: the one part that carries at range, and it brightens on the
    // draw so the telegraph is visible on the body as well as on the ground.
    const nock = new T.Mesh(new T.SphereGeometry(0.13, 8, 6),
      new T.MeshBasicMaterial({ color:0xffd23c }));
    nock.position.set(0.34, 1.28, 0.10);
    body.add(nock);
    g.userData.nock = nock;
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

  // ── the six that never got one ────────────────────────────────────────────
  // The rule three branches up — "a silhouette, not just a statline" — was
  // written for the Archer and then not applied to anyone else. Measured, NINE
  // archetypes shared a byte-identical part list, and seven of those sit within
  // 10% of each other in scale: at range they were one enemy wearing seven
  // hats, exactly the failure that made the Archer invisible.
  //
  // Each shape below is keyed off the behaviour the archetype ALREADY has, so
  // the silhouette answers "what is this about to do to me" rather than merely
  // being different for a test's benefit.
  const deco = (col, emi) => new T.MeshStandardMaterial({
    color: col, emissive: emi || col, emissiveIntensity: emi ? 0.85 : 0.18,
    roughness: 0.55, flatShading: true });

  // RUNNER — the only archetype above speed 4. Backswept quills read as motion
  // even while it stands still, so "the fast one" is legible before it moves.
  if (EE.speed >= 4) {
    for (let i = -1; i <= 1; i++) {
      const q = new T.Mesh(new T.ConeGeometry(0.09, 0.95, 4), deco(0xd9dcc4));
      q.position.set(i * 0.22, 2.02, -0.22);
      q.rotation.x = 2.35 + Math.abs(i) * 0.12;
      q.castShadow = true;
      body.add(q);
    }
  }

  // ARMORED — plated: pauldrons plus a chest slab. Bulk you can see, which is
  // the whole point of an archetype whose statline is flat damage reduction.
  if (EE.armor) {
    for (const sx of [-1, 1]) {
      const pad = new T.Mesh(new T.BoxGeometry(0.52, 0.34, 0.62), deco(0x9aa2ae));
      pad.position.set(sx * 0.5, 1.62, 0);
      pad.rotation.z = -sx * 0.22;
      pad.castShadow = true;
      body.add(pad);
    }
    const plate = new T.Mesh(new T.BoxGeometry(0.86, 0.72, 0.2), deco(0x9aa2ae));
    plate.position.set(0, 1.2, 0.44);
    plate.castShadow = true;
    body.add(plate);
  }

  // EXPLODER — a swollen sac on the back with a hot seam. You should want to
  // kill this one at a distance, and the shape should say so.
  if (EE.onDeath === "blast") {
    const sac = new T.Mesh(new T.SphereGeometry(0.56, 10, 8), deco(0xd88a44));
    sac.scale.set(1, 0.92, 0.86);
    sac.position.set(0, 1.5, -0.5);
    sac.castShadow = true;
    body.add(sac);
    const seam = new T.Mesh(new T.TorusGeometry(0.44, 0.07, 5, 12),
                            deco(0xff6a20, 0xff6a20));
    seam.rotation.y = Math.PI / 2;
    seam.position.set(0, 1.5, -0.5);
    body.add(seam);
  }

  // LEAPER — haunches, not a crest. The first attempt gave it a dorsal fin row,
  // which measured as the same silhouette as the Runner's backswept quills:
  // both are three cones projecting rearward at about the same height, and the
  // profile check was right to reject them. The identity here is JUMPING, so
  // the read belongs in the legs — big raptor haunches that fold up behind the
  // knee, which no other body has and which say "this one closes in one hop".
  if (EE.leap) {
    for (const sx of [-1, 1]) {
      const thigh = new T.Mesh(new T.BoxGeometry(0.3, 0.72, 0.34), deco(0x8fbfae));
      thigh.position.set(sx * 0.26, 0.86, -0.3);
      thigh.rotation.x = 0.62;
      thigh.castShadow = true;
      body.add(thigh);
      const shin = new T.Mesh(new T.BoxGeometry(0.2, 0.6, 0.24), deco(0x7fae9e));
      shin.position.set(sx * 0.26, 0.42, -0.02);
      shin.rotation.x = -0.75;
      shin.castShadow = true;
      body.add(shin);
    }
  }

  // DISRUPTOR — antennae. It fights from eleven units by draining strain, so
  // the tell is an instrument, not a weapon.
  if (EE.disrupt) {
    for (const sx of [-1, 1]) {
      const ant = new T.Mesh(new T.ConeGeometry(0.06, 1.25, 4),
                             deco(0x7fd6ff, 0x4FD6E9));
      ant.position.set(sx * 0.2, 2.35, -0.05);
      ant.rotation.z = sx * 0.3;
      body.add(ant);
    }
    const dish = new T.Mesh(new T.TorusGeometry(0.3, 0.05, 5, 12),
                            deco(0x7fd6ff, 0x4FD6E9));
    dish.rotation.x = Math.PI / 2;
    dish.position.set(0, 2.9, -0.05);
    body.add(dish);
  }

  // GRABBER — hooked claws on both hands. The one that roots you should look
  // like it reaches, and the hook is visible on the arm that swings at you.
  if (EE.grab) {
    for (const arm of [aL, aR]) {
      for (let i = -1; i <= 1; i++) {
        const claw = new T.Mesh(new T.ConeGeometry(0.07, 0.46, 4), deco(0xc0a080));
        claw.position.set(i * 0.1, -0.72, 0.12);
        claw.rotation.x = 2.5;
        claw.castShadow = true;
        arm.joint.add(claw);
      }
    }
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
                 skinM, woundT:0,
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
    more(){ return CHAR.power === "kinesis"; },
    take(){ MOD.singleDmg *= 1.45; } },
  { id:"swarm",    name:"Swarm",           tag:"Burst",
    desc:"Carry 3 more objects, and burst throws hit 20% harder.",
    more(){ return CHAR.power === "kinesis"; },
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
    more(){ return CHAR.power === "kinesis"; },
    take(){ MOD.grabR += 5; } },
  { id:"flow",     name:"Flow State",      tag:"Utility",
    desc:"Kinetic strain clears 55% faster.",
    more(){ return CHAR.power === "kinesis"; },
    take(){ MOD.focusRegen *= 1.55; } },
  { id:"hardened", name:"Hardened",        tag:"Defence",
    desc:"+2 maximum health, and refill now.",
    take(){ MOD.hpBonus += 2; hero.hp = CFG.maxHealth + MOD.hpBonus; } },
  { id:"ordnance", name:"Ordnance",        tag:"Explosive",
    desc:"Every explosion is 40% wider.",
    take(){ MOD.blastR *= 1.4; } },
  // The only repeatable pick in the table. `more()` lets it stay in the pool
  // after being taken, and the name and description read the current rank so a
  // second offer says what it will actually do rather than repeating the
  // first-rank pitch.
  { id:"ringfire", tag:"Fire",
    get name(){ return ringState.lv ? "Ring of Fire " + (ringState.lv+1) : "Ring of Fire"; },
    get desc(){
      const n = ringState.lv + 1, L = RING.levels[Math.min(3,n)];
      return ringState.lv === 0
        ? "A wall of fire orbits you, burning anything that walks through it."
        : "A " + (n===2?"second":"third") + " ring, further out. " + n +
          " bands of fire to cross, " + Math.round(L.dps) + " damage a second each.";
    },
    more(){ return ringState.lv < 3; },
    take(){ ringUpgrade(); } },
  { id:"crown",    name:"Ice Crown",       tag:"Power",
    desc(){
      const n = crownState.lv + 1, L = CROWN.levels[n];
      return crownState.lv === 0
        ? "A crown of ice picks a target and drives a spike through it. Struck bodies slow."
        : "A " + (n===2?"second":"third") + " spike each volley, thrown at a " +
          "different body. " + L.spikes + " spikes, " + L.dmg + " damage each.";
    },
    more(){ return crownState.lv < 3; },
    take(){ crownUpgrade(); } },
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
  // A repeatable upgrade stays in the pool while more() says there is another
  // rank to give; everything else drops out once taken.
  const pool = UPGRADES.filter(u => u.more ? u.more() : !taken.includes(u.id));
  if (pool.length < 3)
    pool.push(...UPGRADES.filter(u => taken.includes(u.id) && !u.more));
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
    b.onclick = () => { u.take(); applySynergies(u);
                        if (!u.more) taken.push(u.id);
                        SFX.pick(); startNextWave(); };
    box.appendChild(b);
  });
  el("modName2").classList.remove("show");
  el("bossBar").classList.remove("show");
  el("overlay").classList.remove("hide");
  ["hud","touch","cross"].forEach(i => el(i).classList.add("hide"));
}

// ─────────────────────────────────────────────────────────── characters
// A character is not a loadout, it is a different arena. The telekinetic's
// magazine is whatever is lying around, so the ground is covered in props;
// the pyromancer carries their own ammunition, so there is nothing out there
// to pick up at all. Choosing one changes what the level IS, not just which
// button does damage — which is the only reason to have two.
//
// Their levels are PERMANENT and per-character: a boss kill raises the one
// you are playing, and it survives the run that earned it. That is the only
// progression in the game that outlives a death, so it is deliberately slow
// and tied to the hardest thing in a wave rather than to score.
const CHAR_MAX_LV = 8;
// Shared by every carried-stack character: what levelling buys is the same
// number for all of them, so a level means the same thing whoever you picked.
function castCap(lv) { return Math.min(8, 1 + lv); }

const CHARS = {
  telekinetic: {
    name: "TELEKINETIC",
    desc: "The arena is your magazine.",
    power: "kinesis",
    props: 1,                                   // full prop density
    perk(lv) { return "Carry " + (CFG.maxHeld + lv - 1) + " objects"; },
  },
  pyromancer: {
    name: "PYROMANCER",
    desc: "Nothing to lift. Fire rides your back.",
    power: "pyro",
    props: 0,                                   // an empty field by design
    cast: PYRO,
    perk(lv) { return castCap(lv) + " fireballs held"; },
  },
  // Same mechanism as the pyromancer — a stack that grows back, capped by a
  // permanent level — and a deliberately different answer to a crowd: no
  // blast, but the blade keeps going through the bodies behind the first.
  windmage: {
    name: "WIND MAGE",
    desc: "Nothing to lift. Blades ride the air.",
    power: "wind",
    props: 0,
    cast: WIND,
    perk(lv) { return castCap(lv) + " air blades held"; },
  },
  // The third answer to the same question. Fire clears a footprint, a blade
  // clears a line, and water takes one body off its feet and puts it where
  // you want it — the only kit here whose point is control rather than
  // damage.
  hydromancer: {
    name: "HYDROMANCER",
    desc: "Nothing to lift, nothing carried. The ground answers.",
    power: "water",
    props: 0,
    cast: WATER,
    perk(lv) { return castCap(lv) + " streams to call"; },
  },
};
for (const k in CHARS) CHARS[k].key = k;
let CHAR = CHARS.telekinetic;

// Read through a clamp rather than trusted raw: PROFILE comes off localStorage,
// which the player can edit and an older build may have written without this
// field at all.
function charLevel(key) {
  const raw = (PROFILE.charLv && PROFILE.charLv[key]) || 1;
  return Math.max(1, Math.min(CHAR_MAX_LV, raw | 0));
}
function charLv() { return charLevel(CHAR.key); }
// A caster is anyone whose ammunition rides on their back. The machinery asks
// this rather than naming a character, so a third kit is a CHARS entry with a
// `cast` spec and nothing else.
function isCaster() { return !!CHAR.cast; }

function setCharacter(key) {
  CHAR = CHARS[key] || CHARS.telekinetic;
  try { localStorage.setItem("kinesis.char", CHAR.key); } catch (e) {}
  // The strain bar and the carry counter belong to telekinesis; a caster has
  // neither, and leaving them on screen reads as a broken HUD. One class for
  // "carries a stack" and one per character, because the widgets are shared
  // but the briefing and the labels are not.
  document.body.classList.toggle("casterChar", isCaster());
  for (const k in CHARS) document.body.classList.toggle(k + "Char", CHAR.key === k);
  const n = el("charName");
  if (n) n.textContent = CHAR.name;
  // The chip and the trigger are one widget shared by every caster, so their
  // wording is set here rather than duplicated per character in the shell.
  const cl = el("castLbl");
  if (cl) cl.textContent = castSpec().label;
  updateForceLabel();
}

// ─────────────────────────────────────────────────────────── persistence
// A run is disposable; the record of it is not. Everything here is
// best-effort: private-mode browsers and file:// origins can both refuse
// localStorage outright, and the game has to keep working when they do.
const SAVE_KEY = "kinesis.v1";
const PROFILE = {
  best: 0, bestWave: 1, runs: 0, kills: 0,
  bestRank: "D", seen: {},        // modifier ids the player has met
  charLv: {},                     // permanent per-character level, by CHARS key
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
  // A save written before a character existed carries no level for it, and the
  // copy above replaces the whole charLv object rather than merging into it —
  // so seed every key AFTER the load, not in the defaults.
  if (!PROFILE.charLv || typeof PROFILE.charLv !== "object") PROFILE.charLv = {};
  for (const k in CHARS) {
    if (typeof PROFILE.charLv[k] !== "number") PROFILE.charLv[k] = 1;
  }
}

function saveProfile() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(PROFILE)); }
  catch (e) { /* nothing to do; the run still counts in this session */ }
}

// A boss kill raises the character that made it, permanently. Saved on the
// spot rather than at the end of the run: the whole point is that dying after
// beating a boss still leaves you stronger than you started.
function levelCharacter() {
  const lv = charLevel(CHAR.key);
  if (lv >= CHAR_MAX_LV) return;
  PROFILE.charLv[CHAR.key] = lv + 1;
  saveProfile();
  banner(CHAR.name + " · LEVEL " + (lv + 1));
  toast(CHAR.perk(lv + 1) + " — kept between runs", 3200);
  if (isCaster()) buildCastStack();
  SFX.rankUp ? SFX.rankUp(3) : SFX.overload();
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
  // An air blade's kills. Without an entry of its own every one of them would
  // fall through to IMPACT, and the wind mage would never see the style their
  // kit is built around.
  cut:     { label:"CLEAVED",     style:18 },
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

// Parts that live in world space instead of as children of w.g: the Choir's
// acolytes and the Monolith's hands. Nothing in the normal teardown path
// reaches them, because that path only walks w.g. Both death and the wave
// clear sweep this, and the flag makes the sweep safe to run twice — an
// acolyte killed individually is already gone by the time the core dies.
function releaseDetached(w) {
  if (!w.detached) return;
  for (const o of w.detached) {
    if (o.__released) continue;
    o.__released = true;
    scene.remove(o);
    disposeGroup(o);
  }
}

function killWalker(w) {
  if (w.dead) return;
  w.dead = true;
  releaseDetached(w);
  if (w.acolytes) for (const a of w.acolytes) {
    if (a.alive) { a.alive = false; scene.remove(a.g); disposeGroup(a.g); }
  }
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
  // A big body is the only thing that raises a character, and the level it
  // grants is kept — this is the one reward in the game that outlives the run.
  if (BIG_TYPES.includes(w.type)) levelCharacter();
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

// Restored by request: this is the PLUME from the reference image, not the rim
// shell that briefly replaced it. Recovered from 879c166 rather than rewritten,
// so the two hard-won details in the texture generator come back intact — the
// CanvasTexture flipY handling that had the column rendering upside down, and
// the soft core column that stopped the filaments reading as thin scratches.
// ── the plume texture ───────────────────────────────────────────────────────
// A rising column of energy rather than a shell around the prop. Tiles
// VERTICALLY so scrolling the V offset makes the wisps climb forever without a
// seam — same trick as the ring of fire's sheet, rotated ninety degrees.
// Colour runs white-hot magenta at the base through violet to blue at the tips,
// which is what separates a core from a haze.
function plumeSheet(w, h, seed) {
  const c = canvasOf(1); c.width = w; c.height = h;
  const x = c.getContext("2d");
  const img = x.createImageData(w, h);
  let sd = seed >>> 0;
  const rr = () => (sd = (sd*1664525 + 1013904223) >>> 0) / 4294967296;
  const ph = []; for (let i = 0; i < 8; i++) ph.push(rr()*Math.PI*2);

  for (let j = 0; j < h; j++) {
    // v: 0 at the TOP of the quad, 1 at its base.
    //
    // CanvasTexture flips Y by default, so canvas row 0 becomes UV v=1 — the
    // TOP of the plane. Writing `1 - j/h` here therefore put the hot pink base
    // colour and the wide end of the waist at the top of the column and the
    // thin blue tip at the bottom: the whole plume rendered upside down, and
    // three additive layers of near-white pink at the top blew out to white.
    const v = j / h;
    const av = v * Math.PI * 2;
    for (let i = 0; i < w; i++) {
      const u = i / w;
      const k = (j*w + i) * 4;

      // Wisps over a body. The first version was filaments ALONE at a high
      // frequency, which rendered as thin scratches rather than a column of
      // energy — the reference is dense. So: a soft core column supplies the
      // mass, and fewer, fatter filaments ride on top of it as detail.
      // Wander grows toward the tip. Fire is anchored where it burns and licks
      // at the top; a constant-amplitude wander is a wavy ribbon instead.
      // Near zero at the base and widest at the tip. Applied evenly it thinned
      // the hot core into a string, which is a wisp of smoke, not a flame.
      const lick = 0.30 + (1 - v) * 2.3;
      const wander = (0.14*Math.sin(av*3 + ph[0]) + 0.08*Math.sin(av*7.3 + ph[1])
                    + 0.045*Math.sin(av*13.7 + ph[5])) * lick;
      const uu = u + wander;
      const fil = Math.sin(uu * Math.PI * 5 + ph[2]) * Math.sin(uu * Math.PI * 2.5 + ph[3]);

      // waist: 1 on the centre line, 0 at the edges. Measured on the WANDERED
      // coordinate, so the column itself snakes rather than staying a straight
      // bar with texture painted over it.
      const waist = Math.max(0, 1 - Math.abs(uu - 0.5) * 2);
      // the body — a fat soft column that narrows as it rises
      const body = Math.pow(waist, 0.9 + (1 - v) * 1.5);
      let a = body * 0.80 + Math.max(0, fil) * body * 0.85;

      a *= Math.pow(v, 0.42);                 // thins out toward the top
      // Tongues, not bands. This was `sin(av*9 + au*2)`: nine cycles down the
      // sheet with almost no u term, which is a stack of evenly spaced
      // horizontal stripes — and scrolling evenly spaced stripes upward is
      // exactly the conveyor-belt read this is meant to avoid. Tying the
      // vertical term to the wandered u slants them into licks instead.
      a *= 0.78 + 0.22*Math.sin(av*3.1 + uu*Math.PI*3.4 + ph[4]);
      // Sharpen so the flame has edges — but only just. Three additive quads
      // overlap at the centre line, so pushing the multiplier much past this
      // blows the core out to flat white and the colour ramp stops reading.
      a = Math.pow(Math.max(0, a), 1.05) * 1.28;

      // magenta core -> violet -> blue
      let R,G,B;
      if (v > 0.82)      { R=255; G=140; B=225; }
      else if (v > 0.52) { const f=(v-0.52)/0.30; R=200+f*55; G=70+f*120; B=225+f*20; }
      else if (v > 0.24) { const f=(v-0.24)/0.28; R=120+f*80; G=60+f*10;  B=235-f*10; }
      else               { const f=v/0.24;        R=60+f*60;  G=70-f*10;  B=210+f*25; }

      img.data[k]   = R;
      img.data[k+1] = G;
      img.data[k+2] = B;
      img.data[k+3] = Math.min(1, a) * 255;
    }
  }
  x.putImageData(img, 0, 0);
  const t = new T.CanvasTexture(c);
  t.wrapS = T.ClampToEdgeWrapping;
  t.wrapT = T.RepeatWrapping;
  t.colorSpace = T.SRGBColorSpace;
  return t;
}

const plumeTexA = plumeSheet(64, 160, 0x2b71);
const plumeTexB = plumeSheet(64, 160, 0x9f04);

// Three quads at sixty degrees around the vertical. From any camera angle at
// least one is broadly facing you, which gives a billboard's readability
// without a per-frame lookAt on twenty-four objects.
const plumeGeo = new T.PlaneGeometry(1, 1);
plumeGeo.translate(0, 0.5, 0);          // pivot at the foot, so it grows upward

// Bright core at the base — the hot spot the plume rises out of.
const coreGeo = new T.SphereGeometry(1, 10, 8);

const auras = [];
// Carry caps at 7, or 10 with Swarm. A full volley of 10 can be in flight
// while the next 10 are already gathered, plus whatever a Warper has thrown
// back — so 14 was not enough and the overflow would silently go unlit.
for (let i = 0; i < 24; i++) {
  const g = new T.Group();
  const mat = new T.MeshBasicMaterial({
    map: i % 2 ? plumeTexB : plumeTexA,
    transparent: true, opacity: 0, blending: T.AdditiveBlending,
    depthWrite: false, side: T.DoubleSide });
  const blades = [];
  for (let k = 0; k < 3; k++) {
    const q = new T.Mesh(plumeGeo, mat);
    q.rotation.y = (k / 3) * Math.PI;      // 0, 60, 120 degrees
    g.add(q); blades.push(q);
  }
  const coreMat = new T.MeshBasicMaterial({
    color: 0xffb0f0, transparent: true, opacity: 0,
    blending: T.AdditiveBlending, depthWrite: false });
  const core = new T.Mesh(coreGeo, coreMat);
  g.add(core);
  g.visible = false;
  g.frustumCulled = false;
  scene.add(g);
  auras.push({ g, mat, coreMat, blades, core });
}

// Tints by what kind of control the object is under, so the aura still carries
// information rather than only decoration. The plume's own ramp already runs
// magenta at the core to blue at the tips, so HELD is left essentially
// untinted — that IS the intended look — and the other two states pull it warm
// or red so a returning prop still reads as danger at a glance.
const AURA_HELD    = new T.Color(0xffffff);
const AURA_SEEK    = new T.Color(0xffc890);
const AURA_HOSTILE = new T.Color(0xff7060);

function updateAuras(dt) {
  // Scroll the two shared sheets rather than a clone per object: twenty-four
  // cloned textures would be twenty-four GPU uploads to animate what is really
  // one motion. Two different rates so alternating auras never march in step.
  //
  // Slower than it was. The scroll is now the slowest thing in the effect —
  // it supplies drift, while the per-blade lick below supplies the motion the
  // eye actually reads as fire. Run fast, it goes back to being a conveyor.
  plumeTexA.offset.y = (plumeTexA.offset.y - 0.34*dt) % 1;
  plumeTexB.offset.y = (plumeTexB.offset.y - 0.47*dt) % 1;

  let i = 0;
  const claim = (o, col, base, pulseHz) => {
    if (i >= auras.length) return;
    const A = auras[i++];
    A.g.visible = true;

    // Sized off the prop, so a boulder wears a taller column than a plank and
    // the zoom-shrunk carry never becomes the thing filling the screen — the
    // failure the old spherical shell had to be tuned down twice to avoid.
    const r = o.r * o.mesh.scale.x;
    const t = S.t, seed = o.slot * 1.7;
    // `pulseHz` now sets how agitated the flame is rather than a beat rate, so
    // a hostile prop still burns faster than a held one.
    const rate = pulseHz * 0.55;

    // Every blade on its own phase. Scaling all three together was the other
    // half of the conveyor read: three quads growing and shrinking in lockstep
    // is one object breathing, not a fire. Independent phases make them read
    // as separate tongues.
    for (let k = 0; k < 3; k++) {
      const q = A.blades[k];
      const ph = seed + k * 2.39;
      // Tongue length, irregular, and guttering low now and then.
      const lick = 0.86 + 0.38 * (0.5 + 0.5*flick(t*rate + ph));
      // A taller tongue is a thinner one. Centred on 1 rather than below it —
      // at 1.12 the whole column came out a quarter narrower than before and
      // read as a wisp of smoke instead of a flame.
      const wide = 1.34 - 0.32*lick;
      q.scale.set(r*2.5*wide, r*4.6*lick, 1);
      // The geometry's pivot is at its foot, so this leans the TIP and leaves
      // the base sitting on the prop — which is how a flame moves.
      q.rotation.z = 0.19*flick(t*rate*0.80 + ph*1.31);
    }

    // Seated below the prop's centre so the column rises THROUGH the object
    // rather than balancing on top of it.
    A.g.position.set(o.pos.x, o.pos.y - r*0.85, o.pos.z);

    A.mat.color.copy(col);
    // A fresh grab flares, then settles.
    A.mat.opacity = base + 0.34*Math.max(0, o.grabT||0)
                  + 0.09*flick(t*rate*1.7 + seed);

    // The hot core sits back at the prop itself — the bright spot the column
    // is rising out of. It flickers faster than the tongues, the way the base
    // of a real flame is the busiest part of it.
    A.core.position.y = r*0.85;
    A.core.scale.setScalar(r * (0.80 + 0.13*flick(t*rate*2.4 + seed)));
    A.coreMat.color.copy(col);
    A.coreMat.opacity = base*0.7 + 0.30*Math.max(0, o.grabT||0);
  };

  for (const o of S.held) claim(o, AURA_HELD, 0.55, 7);
  for (const o of rocks) {
    if (o.gone || o.held) continue;
    if (o.hostile > 0)     claim(o, AURA_HOSTILE, 0.75, 13);
    else if (o.seekT > 0)  claim(o, AURA_SEEK, 0.62, 11);
  }
  for (; i < auras.length; i++) auras[i].g.visible = false;
}

// Tethers removed on request. The magenta threads from the hero to every
// carried prop were the last piece of per-object control decoration, and with
// a full carry of seven they were most of what was on screen.
//
// The state is not hidden by their absence: the carry wheel overhead still
// shows every held prop, and the CARRY readout still counts them. Removed
// outright rather than left disabled — twelve Line objects and their
// geometries updated every frame to draw nothing is a cost with no payer.
//
// Every reference went with it. The last time a pool was removed here the
// call in clearAll was left behind and threw on every wave transition, which
// is why the grep for remaining uses is part of the job, not an afterthought.

const bolts = [];
function bolt(a, b2) {
  const geo = new T.BufferGeometry().setFromPoints([
    new T.Vector3(a.x, 1.4, a.z), new T.Vector3(b2.x, 1.4, b2.z)]);
  const m = new T.Line(geo, new T.LineBasicMaterial({ color:0x9ad8ff, transparent:true }));
  scene.add(m);
  bolts.push({ mesh:m, life:0.22 });
}

// Hearts at or below which the screen itself warns you.
const LOW_HEALTH = 2;
let dmgFlashT = 0;

// The red vignette. It used to fire on EVERY hit at any health, which made the
// loudest signal in the game also its most common one — by the time it meant
// "one more and you are done" the player had long since learned to read past
// it. Now it only appears once you are down to LOW_HEALTH, so it says exactly
// one thing.
//
// It also used to be pasted at four call sites and absent from the others, so
// an arrow and a Choir acolyte took health off you without ever colouring the
// screen. Living in hurtHero means every route that costs a heart warns you,
// which is the whole point of a low-health warning.
function damageFlash() {
  if (hero.hp > LOW_HEALTH) return;
  const d = el("dmg");
  d.classList.add("on");
  // Re-arm rather than stack: two hits close together used to leave the first
  // timer to strip the class mid-way through the second flash.
  clearTimeout(dmgFlashT);
  dmgFlashT = setTimeout(() => d.classList.remove("on"), 220);
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
  damageFlash();
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
  // THE CHOIR: untouchable while any acolyte still orbits. The acolytes are the
  // fight; the core is the reward for finishing it.
  if (w.choir) {
    const live = w.acolytes.filter(a => a.alive);
    if (live.length) {
      // Route the hit into the nearest acolyte instead, so swinging at the
      // middle is not simply wasted — it is aimed at the wrong target.
      let best = null, bd = 1e9;
      for (const a of live) {
        const d = Math.hypot(a.g.position.x - hero.pos.x, a.g.position.z - hero.pos.z);
        if (d < bd) { bd = d; best = a; }
      }
      if (best) {
        best.hp -= amount;
        w.flash = 1;
        if (best.hp <= 0) {
          best.alive = false;
          scene.remove(best.g); disposeGroup(best.g);
          const left = w.acolytes.filter(a => a.alive).length;
          sparks(w.pos, 0xc06aff, 20, 24); SFX.boom();
          S.shake = Math.min(1.2, S.shake + 0.55);
          banner(left ? "ACOLYTE DOWN · " + left + " LEFT" : "THE CORE IS OPEN");
        }
      }
      return;
    }
  }

  // THE HOLLOW: only its own returned ordnance lands. Everything else chips,
  // so the answer is discoverable by trying rather than by being told.
  if (w.hollow) {
    const returned = kind === "returned";
    amount = returned ? amount * HOLLOW.returnMul : amount * HOLLOW.chip;
    if (returned) {
      banner("RETURNED");
      SFX.crit();
      S.freeze = Math.max(S.freeze, 0.12);
      S.shake = Math.min(1.2, S.shake + 0.5);
    }
  }

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
        // "THROAT EXPOSED" was written for a fanged giant. A stone construct
        // has no throat, and the line has to name what the player is now
        // looking at — the lit core in its chest.
        banner(w.platesLeft ? "PLATE SHATTERED · " + w.platesLeft + " LEFT"
                            : "CORE EXPOSED");
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
  clearArrows();
  clearSpikes();
  clearCastShots();
  for (const w of walkers) {
    releaseDetached(w);
    if (w.acolytes) for (const a of w.acolytes) {
      if (a.alive) { scene.remove(a.g); disposeGroup(a.g); }
    }
  }
  rocks.forEach(o => { scene.remove(o.mesh); o.mesh.geometry.dispose(); });
  rocks.length = 0;
  walkers.forEach(w => { scene.remove(w.g); if (!w.disposed) disposeGroup(w.g); });
  walkers.length = 0;
  gibs.forEach(x => scene.remove(x.mesh)); gibs.length = 0;
  puddles.forEach(p => scene.remove(p.mesh)); puddles.length = 0;
  shells.forEach(s => { s.life = 0; s.mesh.visible = false; });
  blastQ.length = 0;
  bolts.forEach(b2 => scene.remove(b2.mesh)); bolts.length = 0;
  auras.forEach(a2 => { a2.g.visible = false; });
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
    const dens = Math.min(3.2, 1.4 + n*0.15) * DIFF.stock * CHAR.props;
    // The floor of 1 is what keeps a wave from opening with nothing to throw —
    // but the pyromancer is MEANT to have nothing, so their empty field has to
    // skip the loop rather than be floored back up to one prop per type.
    if (CHAR.props <= 0) continue;
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
  } else {
    comp = Object.assign({}, comp);
  }
  // Every tenth wave is that tier's boss, and the tiers differ in KIND rather
  // than in size — see BOSS_TIERS. The Warden still turns up on the odd fives
  // as a lesser gate, so the rhythm is boss/Warden/boss rather than a long
  // quiet stretch between milestones.
  if (n % 10 === 0)     comp[bossForWave(n)] = 1;
  else if (n % 5 === 0) comp.boss = 1;
  // Past the table the wave scales up, but the count stops growing after a
  // point and the difficulty moves into the enemies themselves — see
  // LATE_RAMP. Eighty bodies is not harder than forty, it is just slower.
  const extra = Math.min(4, Math.max(0, n - WAVES.length));
  const list = [];
  for (const t in comp) {
    // A boss is a boss, singular. The late-wave ramp and the HORDE modifier
    // both multiply counts, and left unguarded that produced TWO Wardens in
    // one endless wave. See BIG_TYPES.
    const isBig = BIG_TYPES.includes(t);
    let c = isBig ? comp[t] : comp[t] + Math.round(comp[t] * extra * 0.35);
    // Floored at one. Rounding a single-body archetype against a count-reducing
    // modifier lands on zero and deletes it from the wave silently — which is
    // how an archer listed in wave 4 was simply not there some runs.
    if (!isBig) c = Math.max(1, Math.round(c * WMOD.count * CFG.enemyMul));
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
        if (BIG_TYPES.includes(t)) continue;
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
  // A boss is never a reinforcement. The shuffle above could put it in
  // the held-back half, which made it stroll in mid-wave as a "reinforcement"
  // — and left wave 11 with no boss at all in its opening group. This list has
  // to stay in step with the tier table, hence BIG_TYPES: while it was the
  // hand-written pair, wave 20 opened without its Choir about half the time,
  // because 26 bodies against a 0.6 opening leaves a 40% chance of the shuffle
  // parking it in a later pulse.
  for (const big of BIG_TYPES) {
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
      const bn = bw.maw ? MAW.name : "WARDEN";
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
  // Carry chip removed from the HUD — the THROW button already prints this
  // number, so it was the same figure twice. Guarded rather than deleted
  // outright: the element is gone, and an unguarded write here would throw on
  // every HUD update, which is every wave and every kill.
  const cy = el("carry"); if (cy) cy.textContent = S.held.length;
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
  const btn = el("force");
  if (isCaster()) {
    // The stack IS the readout: how many are left, and whether firing is even
    // possible right now.
    const f = castState.held;
    btn.innerHTML = castSpec().verb + (f ? '<b class="cnt">' + f + '</b>' : "");
    btn.classList.toggle("loaded", f > 0);
    return;
  }
  const n = S.held.length;
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
  // A caster has nothing to gather and no modes to switch between, so the
  // same button is simply the trigger.
  if (isCaster()) { castFire(); return; }
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
  // The telekinetic's permanent level is one more object per level, on top of
  // whatever the run's draft has added. It is the mirror of the pyromancer's
  // fireball cap: the same reward, expressed in each character's own currency.
  const perm = CHAR.power === "kinesis" ? charLv() - 1 : 0;
  return Math.max(2, CFG.maxHeld + perm + MOD.maxHeld - (overloaded() ? 3 : 0));
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
    // Catching something that was thrown AT you is remembered. The Hollow is
    // immune to everything else, so this flag is the whole answer to it.
    if (o.hostile > 0) { o.returned = true; o.hostile = 0; }
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
  stepRing(dt);
  stepCrown(dt);
  stepCast(dt);
  stepArrows(dt);

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
    // The left arm carries the staff, so it swings at a third — a hand
    // holding two kilos of wood does not pump like an empty one.
    const A = armPose(hero.walk + Math.PI, g), B = armPose(hero.walk, g);
    armL.rotation.x = A.shoulder*0.35;  armL.joint.rotation.x = A.elbow*0.5 - 0.35;
    armR.rotation.x = B.shoulder;       armR.joint.rotation.x = B.elbow;
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
  // The crystal answers what she is doing: bright while channelling, hotter
  // still in Overdrive, and dimmed to a sullen ember while overloaded.
  const want = OD.on ? 2.4 : overloaded() ? 0.35 : channel ? 1.8 : 1.0;
  crystalM.emissiveIntensity += (want - crystalM.emissiveIntensity)*Math.min(1, 6*dt);
  staffLight.intensity = crystalM.emissiveIntensity * 0.85 + Math.sin(S.t*3)*0.1;

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
      // Struck by the Crown: wades for a moment. Decremented here rather than
      // in stepCrown so it ticks with the body that owns it.
      if (w.slowT > 0) { w.slowT -= dt; spd *= CROWN.slowMul; }
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

    // An Archer draws, holds, and looses. The draw is a full telegraph — the
    // tell ring flares at its feet for the whole 0.85s — so the shot is always
    // announced before it is in the air, and stepping behind anything solid
    // during the draw beats it outright.
    if (w.E.arrow && !w.thrown && dist < w.E.arrow.range) {
      w.arrowT = (w.arrowT === undefined ? rand(1.2, w.E.arrow.every) : w.arrowT) - dt;
      if (w.drawT > 0) {
        w.drawT -= dt;
        w.tell.visible = true;
        const k = 1 - w.drawT / w.AI.telegraph;
        w.tell.material.opacity = 0.25 + k * 0.5;
        w.tell.scale.setScalar(0.6 + k * 1.5);
        // The nock brightens and swells as the string comes back. A ring on the
        // ground is easy to lose at a 17-unit standoff; a light on the body
        // itself is what actually carries at that distance.
        const nk = w.g.userData.nock;
        if (nk) nk.scale.setScalar(1 + k * 1.9);
        if (w.drawT <= 0) {
          w.tell.visible = false;
          const nk2 = w.g.userData.nock;
          if (nk2) nk2.scale.setScalar(1);
          fireArrow(w.pos, w.E.arrow.speed);
          w.arrowT = w.E.arrow.every * rand(0.85, 1.2);
        }
      } else if (w.arrowT <= 0) {
        w.drawT = w.AI.telegraph;
        SFX.warn();
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

    // ---- THE CHOIR
    if (w.choir) {
      const live = w.acolytes.filter(a => a.alive);
      // Faster the fewer are left, so the fight accelerates as it shortens.
      const speedUp = 1 + (w.acolytes.length - live.length) * 0.42;
      w.orbit += dt * CHOIR.orbitSpin * speedUp;
      const R = CHOIR.orbit * (w.g.scale.x || 1);

      for (const a of live) {
        const ang = w.orbit + a.a;
        // Lunges break the orbit briefly: a body that only ever circles is a
        // fixture, and a fixture is not a threat.
        a.lungeT -= dt;
        let rad = R;
        if (a.lungeT < 0.55 && a.lungeT > 0) rad = R * (0.35 + a.lungeT);
        else if (a.lungeT <= 0) a.lungeT = CHOIR.lungeEvery * rand(0.7, 1.4);
        a.g.position.set(w.pos.x + Math.cos(ang)*rad, 0, w.pos.z + Math.sin(ang)*rad);
        a.g.rotation.y = -ang + Math.PI/2;
        // Contact hurts, so orbiting acolytes are a moving wall.
        if (Math.hypot(a.g.position.x-hero.pos.x, a.g.position.z-hero.pos.z) < 1.6
            && w.cool <= 0) {
          w.cool = CFG.zCooldown; hurtHero(); SFX.hurt();
        }
      }
      w.core.material.emissiveIntensity = live.length ? 0.5 : 2.6;
      w.glow.intensity = live.length ? 0.4 : 5;
      if (!live.length && !w.exposed) {
        w.exposed = true;
        banner("THE CHOIR IS ALONE");
        SFX.overload(); S.shake = Math.min(1.2, S.shake + 0.8);
      }
    }

    // ---- THE HOLLOW
    // Hurls constantly, because hurling is how it arms the only thing that can
    // hurt it. Standing still and holding your carry starves the fight.
    if (w.hollow) {
      w.atkT -= dt;
      w.core.material.emissiveIntensity = 1.4 + Math.sin(S.t*4)*0.6;
      if (w.atkT <= 0) {
        w.atkT = HOLLOW.hurlEvery * rand(0.8, 1.25);
        let pick = null, bd = 26;
        for (const o of rocks) {
          if (o.held || o.gone || o.hostile) continue;
          const d2 = o.pos.distanceTo(w.pos);
          if (d2 < bd && d2 > 2.0) { bd = d2; pick = o; }
        }
        if (pick) {
          tmp2.set(hero.pos.x-pick.pos.x, 2.2, hero.pos.z-pick.pos.z).normalize();
          pick.vel.copy(tmp2).multiplyScalar(32);
          pick.hostile = 2.0;
          pick.returned = false;
          pick.mesh.material = seekMat;
          sparks(tmp3.set(w.pos.x, 2.5, w.pos.z), 0x8fd8ff, 10, 14);
          SFX.throw(0.9);
        }
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
        banner("THE MONOLITH IS ENRAGED");
        toast("It stops pacing itself", 2600);
        SFX.overload();
        S.shake = Math.min(1.2, S.shake + 0.8);
      }
      const rate = w.enraged ? 0.62 : 1;

      // ---- THE PUNCH
      // One hand at a time. It pulls back off its slot, its seams come up to
      // heat, and a ring burns on the floor where it will land. The target is
      // locked when the wind-up STARTS, not when it ends — locking it at the
      // end would make the whole telegraph decoration, because there would be
      // nothing you could do with the information.
      w.punchT -= dt;
      const yaw = w.g.rotation.y;
      const anyBusy = w.hands.some(h => h.state !== "idle");
      if (!anyBusy && w.punchT <= 0 && dist < MAW.punchRange) {
        const h = w.hands[w.nextHand++ % w.hands.length];
        w.punchT = MAW.punchEvery * rate;
        h.state = "charge";
        h.t = MAW.charge * rate;
        h.target.set(hero.pos.x, 1.15, hero.pos.z);
        h.mark.position.set(h.target.x, 0.14, h.target.z);
        h.mark.visible = true;
        banner("PUNCH — MOVE");
        SFX.warn();
      }

      for (const h of w.hands) {
        // Slot position in the golem's own frame, resolved to world.
        HAND_TMP.copy(h.slot).applyAxisAngle(UP_AXIS, yaw).add(w.pos);
        HAND_TMP.y = h.slot.y + Math.sin(S.t*1.6 + h.side*2.1)*0.24;

        if (h.state === "charge") {
          h.t -= dt;
          const k = 1 - Math.max(0, h.t) / (MAW.charge * rate);
          // Draws back and rises as it winds — the pose says which way it is
          // about to go before the ring does.
          HAND_TMP2.set(h.target.x - w.pos.x, 0, h.target.z - w.pos.z).normalize();
          h.g.position.lerp(
            HAND_TMP.addScaledVector(HAND_TMP2, -3.2*k).setY(HAND_TMP.y + 1.9*k),
            Math.min(1, dt*7));
          h.g.rotation.y = yaw;
          h.seam.material.color.copy(SEAM_COLD).lerp(SEAM_HOT, k);
          h.mark.material.opacity = 0.35 + 0.55*Math.abs(Math.sin(k*Math.PI*5));
          h.mark.scale.setScalar(1 + (1-k)*0.5);
          if (h.t <= 0) { h.state = "punch"; SFX.throw(2); }

        } else if (h.state === "punch") {
          // Substepped. At 34 u/s a frame at 30fps advances further than the
          // contact radius, and an unsubstepped fist simply teleports through
          // the player — the same tunnelling the archer's arrows hit.
          const step = MAW.punchSpeed * dt;
          const subs = Math.max(1, Math.ceil(step / (MAW.punchR * 0.5)));
          let landed = false;
          for (let i = 0; i < subs && !landed; i++) {
            HAND_TMP2.copy(h.target).sub(h.g.position);
            const d = HAND_TMP2.length();
            if (d < 0.001 || d < step/subs) { h.g.position.copy(h.target); landed = true; }
            else h.g.position.addScaledVector(HAND_TMP2.divideScalar(d), step/subs);
            const hx = h.g.position.x - hero.pos.x, hz = h.g.position.z - hero.pos.z;
            if (hx*hx + hz*hz < MAW.punchR*MAW.punchR) {
              // Dashing is invulnerability everywhere else in this game and
              // has to be here too, or the boss's one real attack is the only
              // thing in the arena a dash cannot answer.
              if (!(S.dashT > 0) && w.cool <= 0) {
                // Counted so the fist can be told apart from its own crater.
                // Both land in the same frame, so hero health alone cannot say
                // which of the two touched you — and they have DIFFERENT
                // answers: dash beats the fist, jump beats the ring.
                w.punchHits++;
                w.cool = CFG.zCooldown;
                hurtHero(); SFX.hurt();
                S.shake = Math.min(1.3, S.shake + 0.8);
                updateHUD();
                if (hero.hp <= 0) { gameOver(); return; }
              }
              landed = true;
            }
          }
          if (landed) {
            // It always craters, hit or miss. Dodging the fist buys you the
            // ring instead, and the ring is jumpable — so a clean dodge is two
            // reads, not one.
            shocks.push(makeShock(h.g.position, MAW.craterR));
            sparks(tmp3.copy(h.g.position), 0xff8a30, 16, 20);
            S.shake = Math.min(1.4, S.shake + 0.9);
            SFX.boom();
            S.freeze = Math.max(S.freeze, 0.1);
            h.mark.visible = false;
            h.state = "return";
          }

        } else if (h.state === "return") {
          HAND_TMP2.copy(HAND_TMP).sub(h.g.position);
          const d = HAND_TMP2.length();
          h.seam.material.color.lerp(SEAM_COLD, Math.min(1, dt*3));
          if (d < 0.6) { h.g.position.copy(HAND_TMP); h.state = "idle"; }
          else h.g.position.addScaledVector(HAND_TMP2.divideScalar(d),
                                            Math.min(d, MAW.returnSpeed*dt));
          h.g.rotation.y = yaw;

        } else {
          h.g.position.lerp(HAND_TMP, Math.min(1, dt*3.4));
          h.g.rotation.y = yaw + Math.sin(S.t*0.8 + h.side)*0.12;
          h.seam.material.color.lerp(SEAM_COLD, Math.min(1, dt*2));
          h.mark.visible = false;
        }
      }

      // HURL: picks up whatever is lying near it and throws it. Same hostile
      // prop path the Warden uses, so it can be shot out of the air.
      w.atkT -= dt;
      if (w.atkT <= 0 && !w.hands.some(h => h.state !== "idle")) {
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
      if (w.roarT <= 0 && !w.hands.some(h => h.state !== "idle")) {
        w.roarT = MAW.roarEvery * rate;
        w.jawOpen = 0.55;
        reinforce(w.enraged ? ["runner","runner","leaper","crawler"]
                            : ["walker","runner","crawler"], "THE MONOLITH CALLS");
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

    // ---- wound state
    // Doubling every archetype's health made the SECOND hit the one that
    // kills, and nothing on screen said which bodies had already taken the
    // first. Without that, a crowd is undifferentiated and the finisher —
    // single-target execute, which only fires on the wounded — is invisible.
    // Health now reads off the body itself: skin darkens and goes livid, and
    // the eyes bank up as it gets closer to dropping.
    if (w.skinM && !w.boss) {
      const frac = clamp(w.hp / w.maxHp, 0, 1);
      const hurt = 1 - frac;
      if (Math.abs(hurt - w.woundT) > 0.02) {
        w.woundT = hurt;
        // toward a dark, bloodied cast rather than simply darker, so a
        // wounded body separates from one merely standing in shadow
        const c = tmpCol.setHex(w.E.skin);
        // Measured at 0.72: a body at 12% health came out #645344 — browner,
        // not visibly dying. In a crowd of forty that is no signal at all.
        c.lerp(WOUND_COL, hurt * 0.95);
        c.multiplyScalar(1 - hurt * 0.30);
        w.skinM.color.copy(c);
        // Emissive only appears in the last third — that is the execute
        // window, and it should be the thing the eye catches in a crowd.
        w.skinM.emissive.copy(WOUND_GLOW);
        // Opens at 55% rather than 66% so the execute window is flagged for
        // longer than the instant before it closes.
        w.skinM.emissiveIntensity = Math.max(0, hurt - 0.55) * 3.2;
      }
    }
    // ---- walker gait (skipped while winding up: the tell owns the pose)
    if (w.windup > 0) { w.body.position.y = w.bodyY || 0; }
    else {
    // Same blend as the hero, driven by the archetype's own speed, so a
    // Walker shambles, a Runner actually runs, and a leaper's burst reads as
    // a sprint rather than as a shamble played fast. FRENZY, which multiplies
    // speed, therefore changes how the wave MOVES and not just how quickly.
    const wspd = w.spd || 0;
    const wg = GAIT.blend(wspd, 1.6, 4.6);
    // Written as an assignment, not `+=`. `undefined += n` is NaN and it never
    // recovers; the guard on the right was already there but the read on the
    // left was not, which is how the Warden animated itself to a NaN position.
    w.gait = (w.gait || 0) + (wg - (w.gait || 0)) * Math.min(1, 5*dt);
    const gz = w.gait;
    w.walk += dt * GAIT.cadence(wspd) * Math.PI*2;

    // Limbs are posed only if the rig actually has them. Not every body is a
    // biped: THE CHOIR is a floating core with neither legs nor arms, and it
    // threw here on the first frame it existed, which killed the animation
    // loop the instant wave 20 began.
    if (w.lL) {
      const L = legPose(w.walk, gz), R = legPose(w.walk + Math.PI, gz);
      w.lL.rotation.x = L.hip;  w.lL.joint.rotation.x = L.knee;
      w.lR.rotation.x = R.hip;  w.lR.joint.rotation.x = R.knee;
    }

    // The reach is the shamble's signature, so it survives at low speed and
    // gives way to a pumping arm as the thing starts to sprint.
    if (w.aL) {
      const A = armPose(w.walk + Math.PI, gz), B = armPose(w.walk, gz);
      // Rest angle is per rig. -1.6 is the classic outstretched zombie shamble
      // and is right for a body with short arms; on THE HOLLOW, whose arms are
      // longer than it is tall, it threw two five-metre sticks out horizontally
      // instead of letting them hang. That one is armRest ~0.
      const shamble = (w.armRest !== undefined ? w.armRest : -1.6) * (1 - gz);
      w.aL.rotation.x = shamble + A.shoulder*gz + Math.sin(w.walk*0.55)*0.14*(1-gz);
      w.aR.rotation.x = shamble + B.shoulder*gz - Math.sin(w.walk*0.55)*0.14*(1-gz);
      w.aL.joint.rotation.x = -0.25 - 1.1*gz + A.elbow*gz*0.5;
      w.aR.joint.rotation.x = -0.25 - 1.1*gz + B.elbow*gz*0.5;
    }

    w.body.rotation.z = Math.sin(w.walk)*(0.11 - 0.05*gz);
    // Bob is a small offset ON TOP OF the rig's rest height, not an absolute
    // position. Written absolutely it dropped the Gorger's whole torso from
    // y=4.9 to y=0 on its first stepped frame, leaving its arms hanging in
    // the air 7.9 units above the body they belong to.
    w.body.position.y = (w.bodyY || 0) + gaitBob(w.walk, gz);
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
      // Armless rigs rear with the torso alone — same guard as the gait above.
      if (w.aL) {
        w.aL.rotation.x = -1.6 - 1.5*Math.sin(t*Math.PI);
        w.aR.rotation.x = -1.6 - 1.5*Math.sin(t*Math.PI);
      }
      if (w.tell) {
        w.tell.material.opacity = 0.25 + 0.55*Math.sin(t*Math.PI);
        w.tell.visible = true;
        w.tell.scale.setScalar(1 + t*0.5);
      }
      if (w.windup <= 0) {
        if (w.tell) w.tell.visible = false;
        w.cool = CFG.zCooldown;
        // Only lands if the player is still inside reach and on the ground:
        // moving, dashing or jumping all beat it.
        if (dist < reach*1.25 && hero.pos.y < CFG.dodgeHeight) {
          hurtHero();
          SFX.hurt();
          S.shake = Math.min(1, S.shake+0.45);
          updateHUD();
          if (hero.hp <= 0) { gameOver(); return; }
        } else {
          SFX.whiff();
        }
      }
    } else if (dist < reach && w.cool <= 0 && hero.pos.y < CFG.dodgeHeight &&
               // It does not swipe while a fist is out. The guard used to name
               // the ground slam; when the slam was replaced by the punch the
               // name went stale, and `undefined > 0` being false meant it
               // silently stopped guarding anything at all.
               !(w.maw && w.hands.some(h => h.state !== "idle"))) {
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
      const hitD = tmp.length();
      if (hitD < o.r + w.r) {
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
            // A prop caught mid-flight and sent back is its own damage kind.
            // The Hollow is immune to everything else, so this tag is the
            // difference between the fight being possible and being a wall.
            damageWalker(w, dmg, tmp, 4.5*(o.def.knock||1),
                         o.returned ? "returned"
                         : hitKind || ((o.def.pierce && o.pierced > 0) ? "pierce" : "impact"));
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
          // Resting contact, not an impact. This used to shove the WALKER back
          // a flat 0.35 every frame — roughly seven times its own per-frame
          // step — so a body that walked into a barrel was pinned against it
          // for the rest of the wave. It could not close, could not be found,
          // and the wave could never be cleared: the run just stopped, with
          // the threat counter still showing bodies that were never coming.
          //
          // Resolved as a mutual, penetration-proportional separation instead,
          // so it settles at contact rather than oscillating, and the lighter
          // side gives way — a body shoves a plank aside and leans on a
          // boulder.
          const pen = Math.max(0, (o.r + w.r) - hitD);
          tmp.y = 0;
          if (tmp.lengthSq() > 1e-6) {
            tmp.normalize();
            const give = 1 / (1 + (o.def.mass || 1));
            w.pos.addScaledVector(tmp, -pen * (1 - give));
            o.pos.addScaledVector(tmp,  pen * give);
          }
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
    // A caster's ammunition is the stack on their back rather than the
    // ground, so it gets a readout of its own. The touch FORCE button already
    // carries the count, but that button is hidden on desktop — without this
    // chip the whole resource would be invisible to a keyboard player.
    const fc = el("castCnt");
    if (fc && isCaster()) {
      fc.textContent = castState.held;
      el("castWrap").classList.toggle("dry", castState.held === 0);
    }
    // Only nags when it is actionable: empty-handed with nothing in reach.
    // Never for a caster — an empty field is their design, not a problem they
    // can walk out of.
    if (!isCaster() && n === 0 && !S.held.length && S.phase === "play") {
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

  updateAuras(dt);

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
  // The ring of fire is a draft pick and belongs to the run, but it keeps its
  // rank in its own module state rather than in MOD — so restart() rebuilt
  // every other part of the build and left this one standing. A new run began
  // at wave 1 with whatever rank the last run finished on, which hands over
  // the strongest pick in the pool for free; and because the draft entry gates
  // on `ringState.lv < 3`, a maxed ring then never appeared as an option again
  // for the rest of the session.
  ringState.lv = 0;
  buildRingOrbs();
  // Same treatment as the ring above, and for the same reason: rank lives in
  // its own module state, so a restart that forgot it would hand the next run
  // a maxed Crown for free and then never offer the pick again.
  crownState.lv = 0;
  buildCrown();
  clearSpikes();
  // The stack is a per-run resource even though the CAP that sizes it is
  // permanent, so a new run opens empty and has to earn its first shot.
  castState.held = 0;
  castState.t = castSpec().regen;
  clearCastShots();
  buildCastStack();
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
// Rolling quality-ladder state. The old ladder judged exactly two three-second
// windows and then stopped forever, and the FIRST of those windows covered
// shader compilation, texture upload and the opening spawn — the slowest three
// seconds a run will ever have. A machine that stuttered once at load was
// condemned to LOW for the rest of the session, and a machine that only
// struggled at wave 20, when forty bodies are on the field, was never helped
// at all because the ladder had already retired.
let qBadRuns = 0, qGoodRuns = 0, qStartedAt = 0;
const Q_WARMUP = 5.0;      // seconds of grace before any judgement
const Q_WINDOW = 2.5;      // length of each sample window
const BASE_PIXEL_RATIO = Math.min(devicePixelRatio || 1, 1.75);

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
  if (!qStartedAt) { qStartedAt = now; fpsT0 = now; return; }
  // Warm-up: ignore everything until the run has settled. Judging the opening
  // seconds measures the loading, not the game.
  if ((now - qStartedAt) / 1000 < Q_WARMUP) { fpsT0 = now; fpsFrames = 0; return; }

  fpsFrames++;
  const elapsed = (now - fpsT0) / 1000;
  if (elapsed < Q_WINDOW) return;
  const fps = fpsFrames / elapsed;
  fpsFrames = 0; fpsT0 = now;

  // Two consecutive bad windows before stepping down, so a single hitch — a
  // garbage collection, a backgrounded tab, a wave spawning — never costs the
  // player their visuals for the rest of the run.
  if (fps < 34)      { qBadRuns++;  qGoodRuns = 0; }
  else if (fps > 52) { qGoodRuns++; qBadRuns  = 0; }
  else               { qBadRuns = 0; qGoodRuns = 0; }

  if (qBadRuns >= 2) {
    qBadRuns = 0;
    if (quality === "high")     { setQuality("med"); toast("Effects reduced to keep it smooth", 2600); }
    else if (quality === "med") { setQuality("low"); toast("Detail reduced to keep it smooth", 2600); }
  } else if (qGoodRuns >= 4 && quality === "med") {
    // Recovery, but only MED -> HIGH. That step is a clean re-enable of two
    // passes and the pixel ratio. LOW is deliberately one-way: it strips normal
    // maps off live materials, and there is no honest way to put back data that
    // was thrown away without rebuilding every body in the arena.
    qGoodRuns = 0;
    restoreHigh();
    toast("Effects restored", 2200);
  }
}

function restoreHigh() {
  if (quality !== "med") return;
  quality = "high";
  gtao.enabled = true;
  bloom.enabled = true;
  fxOn = true;
  renderer.setPixelRatio(BASE_PIXEL_RATIO);
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
  // The opening run reaches here without going through restart(), so the
  // stack has to be raised on this path too — otherwise a caster's very first
  // run has a working trigger and nothing to show for it.
  castState.held = 0;
  castState.t = castSpec().regen;
  clearCastShots();
  buildCastStack();
  buildWave(S.wave);
  S.phase = "play";
  last = performance.now();
  resize();
  toast(isCaster() ? castSpec().hint
                   : "Tap FORCE to gather · then SHOOT one at a time", 3400);
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

// Before the picker, not after: the cards show each character's permanent
// level, and the profile that holds those levels is what loadProfile reads
// off storage. Painting first would show everyone level 1 on a fresh page.
loadProfile();

(function initCharacter() {
  let saved = "telekinetic";
  try { saved = localStorage.getItem("kinesis.char") || "telekinetic"; } catch (e) {}
  if (!CHARS[saved]) saved = "telekinetic";
  setCharacter(saved);
  const box = el("charPick");
  if (!box) return;

  // Each card carries the permanent level as well as the name, because the
  // level is the reason to pick one character over the other on a given day —
  // and it is the only number on this screen that the last run could change.
  const paint = () => {
    [...box.children].forEach(btn => {
      const key = btn.dataset.char, lv = charLevel(key);
      btn.classList.toggle("on", key === CHAR.key);
      btn.querySelector(".charLv").innerHTML =
        (lv >= CHAR_MAX_LV ? "MAX" : "LV " + lv) + " · " +
        "<s>" + CHARS[key].perk(lv) + "</s>";
    });
  };

  for (const key in CHARS) {
    const c = CHARS[key];
    const btn = document.createElement("button");
    btn.className = "diffBtn";
    btn.dataset.char = key;
    btn.innerHTML = '<b>' + c.name + '</b><i>' + c.desc + '</i><span class="charLv"></span>';
    btn.onclick = () => { setCharacter(key); paint(); };
    box.appendChild(btn);
  }
  paint();
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
