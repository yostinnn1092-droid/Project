# Kinesis regression suite

    node test/run.mjs           # everything
    node test/run.mjs ring      # only cases whose name contains "ring"

Exit code 0 = all passed, 1 = at least one failure. Full run is ~5 minutes;
filtered runs are ~15s each.

## What it is

Playwright drives a **probe build** — `build.mjs` with the `probe` argument
injects `test/probe.js` inside the game's IIFE, which is the only way to reach
module-private state without exporting it from the shipped file. One case
asserts the probe never reaches `kinesis3d.html`.

Cases drive the simulation directly via `step(dt)` rather than waiting on
wall-clock time. Software GL renders at a few frames a second in CI, so timed
waits measure the machine rather than the game — a mistake made repeatedly
before this suite existed.

## Why each case exists

Every one corresponds to a bug that actually shipped during development and was
caught by hand. The suite exists so the next one is caught without anybody
remembering to look.

| Case | The bug it would have caught |
|---|---|
| boot / live wave / wave transitions have no errors | a dangling `auras.forEach` in `clearAll` threw on every wave change |
| probe never leaks | a probe build published as the real artifact |
| wave body ceiling | the separation pass is O(n²); an unbounded wave is a frame-rate cliff |
| durability | a Rock did 100 and a Walker had exactly 100 HP — one-tap |
| archer present from wave 3 | archers existed but first spawned at wave 5, past where runs ended |
| archer bow silhouette | it shipped with only a skin-tone difference and was invisible at range |
| archer arrow hits / dash beats it | substepping; at 26 u/s a single-step test tunnels through the player |
| ring builds one more ring per rank | ranks silently not applying |
| ring burns centre and bands, not gaps | the middle was a safe pocket for anything that closed |
| boss closes, slams, throws | the rig was rebuilt quadruped → biped; limb slots feed the shared gait |
| every tenth wave brings that tier's boss | the front-load that lifts a boss out of the shuffle listed two of the four boss types, so wave 20 opened bossless ~40% of the time |
| never more than one big body | the late-wave ramp and HORDE both multiply counts — unguarded, that gave two Wardens |
| every boss survives being animated | the shared gait posed limbs unconditionally; the Choir has no legs or arms and the Hollow no arms, so both killed the animation loop on their first frame |
| choir core untouchable / acolytes die with it | the shield is the whole fight; a routing slip makes it either invincible or a plain sack of HP |
| hollow only takes returned ordnance | same — the chip multiplier is the puzzle, and a missed gate collapses it to either wall or pushover |
| wounds track health, bosses excluded | with 2-hit kills, nothing showed which bodies were finishable |
| quality warm-up / hysteresis / recovery | the ladder judged the loading window and never re-checked |

## Verified against mutations

A suite that has never failed has not been shown to work. Three deliberate
regressions were introduced and each turned the right case red:

- reverting the ring-centre fix → *"the middle of the ring is a safe pocket"*
- removing archers from waves 3–4 → *"wave 3 contains no archer"*
- a dangling reference in `clearAll` → wave-transition case threw
- restoring the two-name front-load list → *"wave 20 opened with no boss on 7/12 passes"*
- removing the `w.lL` guard from the gait → *"stepping \"choir\" threw"*

## Test the thing running, not just its functions

Every choir and hollow case pokes `damageWalker` directly and never runs a
frame — which is how both bosses shipped unable to animate at all while four
green cases covered them. A case that calls a system's functions is not a case
that runs the system. At least one per feature has to `step`.

## Randomised cases need passes, not a pass

Anything downstream of the wave shuffle or a random modifier must be checked
over many builds. The tier-boss case originally did one build per wave and sat
green while a boss was missing from 40% of wave 20s. Twelve passes turned the
same bug into a hard, reproducible failure. If a case touches `buildWave`,
loop it.

## Setup retries

Loading the 1.1MB bundle under software GL occasionally blows the navigation
timeout mid-suite, which once put three consecutive cases in the red that all
passed on their own. `run.mjs` retries **setup only**, up to three times, and
prints `(setup retried N×)` on the pass so the flake stays visible. Assertions
are never retried — a suite that quietly re-rolls its own failures is worse
than no suite.

## Adding a case

Add a `test("name", async (pg, errs) => { ... })` in `run.mjs`. `pg` is the
Playwright page with `window.__probe` available; `errs` accumulates page and
console errors for the life of that case. Use `ok`, `eq`, `near`. Expose any new
internals from `test/probe.js`.

**Then break the thing on purpose and confirm your case fails.** An assertion
that cannot fail is documentation, not a test.
