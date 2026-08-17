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
| archer present from wave 3 | archers existed but first spawned at wave 5, past where runs ended. The case itself was then a coin flip: it asked `counts()`, which sees only the opening group, so a pulse-arriving archer read as absent. It now asks `roster()` over eight passes |
| archer bow silhouette | it shipped with only a skin-tone difference and was invisible at range |
| archer arrow hits / dash beats it | substepping; at 26 u/s a single-step test tunnels through the player |
| ring builds one more ring per rank | ranks silently not applying |
| ring burns centre and bands, not gaps | the middle was a safe pocket for anything that closed |
| Monolith closes and craters | the rig was rebuilt quadruped → biped → stone golem; limb slots feed the shared gait. The case also never aggroed the boss, so "closed more than 5 units" was satisfied by aimless drift |
| Monolith hurls what is lying around | the hurl and the reinforcement call were both gated on `w.slamWind <= 0`; when the slam was replaced by the punch that field stopped existing, and `undefined <= 0` is false, so both attacks silently switched off |
| punch charges, flies, craters | the wind-up is the entire read; a hand that charges without launching, or launches without cratering, breaks the fight without erroring |
| dashing beats the fist | dash is invulnerability everywhere else and cannot fail here alone |
| every tenth wave brings that tier's boss | the front-load that lifts a boss out of the shuffle listed two of the four boss types, so wave 20 opened bossless ~40% of the time |
| never more than one big body | the late-wave ramp and HORDE both multiply counts — unguarded, that gave two Wardens |
| every boss survives being animated | the shared gait posed limbs unconditionally; the Choir has neither legs nor arms, so it killed the animation loop on its first frame |
| a body stays attached to its own shoulders | the walk bob was written as an absolute y, dropping the Gorger's torso from 4.9 to 0 while its arms stayed at 7.9 — no error, no log, boss silently in pieces |
| choir core untouchable / acolytes die with it | the shield is the whole fight; a routing slip makes it either invincible or a plain sack of HP |
| hollow only takes returned ordnance | same — the chip multiplier is the puzzle, and a missed gate collapses it to either wall or pushover |
| restart drops the last run's build | the fire ring keeps its rank outside `MOD`, so `restart()` reset everything else and left it — a new run opened at wave 1 with a maxed triple ring, and because the draft gates on `lv < 3` the pick then never reappeared all session |
| damage flash only at low health, on every route | the red vignette fired on every hit at any health, so the loudest signal in the game was also its most common. It was also pasted at four call sites and missing from the rest, so an arrow or a Choir acolyte took a heart in silence |
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
- writing the walk bob absolutely again → *"maw torso drifted from its build height"*
- skipping archers below wave 5 → *"wave 3 contained no archer on some passes"*
- removing the punch's dash guard → *"dashing took 5 fist hits"*
- making a charged hand return instead of launch → *"a hand charged but never launched"*
- removing the ring reset from `restart()` → *"the fire ring's rank survived a restart"*
- removing the low-health gate → *"the screen flashed red at full health"*
- removing `damageFlash()` from `hurtHero` → *"dropping to 2 hearts did not flash"*

## Test the thing running, not just its functions

Every choir and hollow case pokes `damageWalker` directly and never runs a
frame — which is how the Choir shipped unable to animate at all while four
green cases covered it, and how the Gorger walked around in pieces for just as
long. A case that calls a system's functions is not a case that runs the
system. At least one per feature has to `step`.

A related trap caught during the same work: a debug script that reused **one
page** across several creature types kept earlier spawns alive in `walkers`, so
a crash from the first type was reported against the third. That produced a
confident, wrong diagnosis ("the Hollow has no arms" — it has a full rig).
Isolate the subject per page, or the harness will lie to you.

The same work produced a second wrong diagnosis worth recording: flooring wave
counts at one (`Math.max(1, ...)`) was credited with fixing a missing archer.
It did not. `CFG.enemyMul` is 2.0 and no modifier reduces counts, so the
expression it guards can never round to zero — the floor is harmless insurance
that has never once fired. The archer was missing because of the opening-group
split above. A fix that is applied and then never proven to have been the cause
is a guess wearing a commit message.

## Control the environment or the threshold is a coin flip

"The boss closes more than 5 units in 40s" swung between 5 and 24 depending
only on where the random prop scatter landed, because the boss gets stuck on a
barrel. No threshold survives that. The case now strips props and asserts a
real close (>15), and hurling — which needs props — was split into its own
case that keeps them. Control the variable; do not tune a number against it.

The same case also shows the other half of the lesson: it never aggroed the
boss, so for its whole life it was measuring drift and calling it pursuit.
Check that a case is exercising the thing it names.

## Two things can land in the same frame

The Monolith's punch always craters, and the fist and its ring arrive in the
same `step()`. They have DIFFERENT answers — dash beats the fist, jump beats
the ring — so hero health cannot tell you which one connected, and three
attempts at isolating them by clearing rings, or by lifting the hero above
`dodgeHeight` (gravity puts them straight back), all measured the wrong thing.
The boss counts its own fist hits instead. When two effects share a frame,
count them at the source.

## State that lives outside the obvious container

`restart()` reads as complete: it resets MOD, synergies, the taken list, wave,
score, health, style, rank and overdrive. It was still wrong, because one
drafted upgrade keeps its rank in its own module object and so was not in the
list of things anybody thought to reset. Reviewing a reset function against
itself cannot find that — the missing item is by definition not written there.
Ask instead what a run OWNS, then check each of those against the reset.

## A signal pasted per call site is a signal with holes

The red damage vignette lived as the same two lines copied into four places.
Four is enough to look deliberate and not enough to be complete: arrows and
Choir acolytes took health off the player without ever colouring the screen,
and nothing said so because there was no single place to compare against. It
now lives in `hurtHero`, which the file already describes as the one route
every point of player damage passes through. If a signal belongs to an event,
put it where the event is, not where you happened to remember it.

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
