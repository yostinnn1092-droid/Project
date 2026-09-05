# The Naming — playable combat slice

The same design as the Unity project one level up, rebuilt to run in a browser.

Not a port for its own sake. The Unity build needs an 8–15 GB editor install on
a desktop, which put it out of reach; this opens on a phone. And it can be
**verified**, which the C# version never could — the numbers below were measured
by driving the game headlessly, not guessed.

## Play it

Open `arena.html`. That is the whole thing: one file, no server, no install.

| | Touch | Keyboard |
|---|---|---|
| Move | left stick (push far to run) | `WASD`, `Shift` to run |
| Look | drag anywhere | drag with the mouse |
| Attack | **ATTACK** | left click |
| Dodge | **DODGE** | `Space` |
| Name a downed beast | **NAME** (lights up when one is down) | `F` |
| Pick a different name | **OTHER** | `Tab` |
| Order the family | **ORDER** (heel / send / hold) | `Q` |

## What to try, in order

1. **Hit the dummy.** Seven metres ahead, cannot fight back. Three taps for the
   chain; the third is the heavy one. This isolates what a *swing* feels like
   from what a *fight* feels like — two different questions that get confused
   when you only meet them together.
2. **Walk north to the pack.** A leader — bigger, dark red, gold crest — and
   three wolves. They notice you at about fourteen metres.
3. **Watch for the crouch.** A wolf drops and holds before it lunges. That tell
   is the contract: see it, and you have time to roll.
4. **Take one alive.** Worn down, a wolf collapses instead of dying. Walk over
   and press NAME. The hard part is *stopping* — attacks commit, so the greedy
   third swing is exactly how you lose the wolf you wanted.
5. **Then go for the leader.** Name it and the whole pack comes with it, for one
   place on the roster. Then **ORDER** them — heel, send them at something, or
   hold ground.
6. **Clear the territory and another appears**, further out and tougher. Every
   second one widens the roster, so the late game is a question of who is worth
   a place rather than whether you can afford one.

Death is a full restart, and everything you named is lost with you. That is the
only thing that makes spending will on a name a risk.

## Reading a creature

Each wolf wears a thin bar with a **gold tick** on it. The tick marks where that
creature *collapses instead of dying* — everything left of it is a wolf you can
still take alive. The fill turns gold as it enters that window, and the animal
itself sinks and drops its head as it fails.

This is not decoration. The whole mechanic asks the player to notice a creature
is about to break and to stop swinging; without a reading of how close it is,
that is not a decision, it is luck. The first build shipped without it and the
collapse was a surprise that happened to you.

## What was measured, and what it changed

Every number here came from driving `step(dt)` headlessly. Several of them
changed the design.

| Question | Answer |
|---|---|
| Is the tell long enough to answer? | 0.47s (leader 0.55s), lunge 0.30s |
| Does dodging on the tell work? | Yes — 0 damage dodged, **12 damage standing still** |
| How long does a standing player last? | 10.5s against the pack |
| How fast can the player answer? | 46 dps; the pack is 590 health |
| Is the naming window winnable? | Reached from 6m in 0.6s, 5.4s to spare |
| Does the next territory land where you can go to it? | 30-42m out, never underfoot |

The one that changed the design: with no limit on how many wolves could commit
at once, a standing player died in **7 seconds** while needing **15 seconds** of
uninterrupted offence to clear the pack. The fix was not to nerf the wolves. It
was that **only one monster commits to an attack at a time** — because this
design's promise is "see the crouch and you have time", and two crouches at once
from two directions is a promise it cannot keep. Now the pack is a rhythm: one
commits, you roll, you punish, the next steps up, and the others stop being
damage and start being the thing that stops you running away.

## Building and testing

```bash
node build.mjs arena.html      # concatenate src/*.js and inline three.js
node test/run.mjs              # 20 regression cases
node test/run.mjs pack         # substring filter, not a regex
node test/measure.mjs          # the balance numbers above
node test/shot.mjs             # render stills to /tmp
TOUCH=1 node test/shot.mjs     # ...with the on-screen controls
```

Sources are numbered so the concatenation order is the file listing, and kept
small deliberately — one 1500-line `game.js` is how a project stops being
reviewable. three.js is shared with the other game in this repo rather than
copied; its MIT notice is emitted by `build.mjs` so a re-bundle cannot drop it.

### On the tests

Every case was **mutation-verified**: the behaviour it names was broken on
purpose and the case was required to fail. That found four cases that proved
nothing at all —

- the attack-cap case compared against the very config value it was testing, so
  raising the cap raised the assertion with it;
- the unbound-familiar case never cleared targets, so it never reached the code
  it was about;
- the one-slot rule was checked on pack members who were standing up, and
  `canBeNamed` requires being down, so it passed on posture rather than
  allegiance;
- and it killed a member with `kill()`, which sets health to zero directly and
  never consults the death guard the case existed to check.

A green suite nobody has watched fail is decoration.

Later rounds found four more of the same kind — a case that sampled the family's
target *after* cycling back to Follow, which clears it, so "the family was not
sent at its master" was true because there was no target at all; and a
message-queue case that could not tell a queue from a single slot, because the
message on screen has already left the queue either way. Both were rewritten
until a deliberate break made them fail.

The mutation harness itself has been wrong three times now, and each time it
reported healthy code as untested. It is checked the same way as everything
else: if breaking the behaviour does not turn the suite red, the harness is the
first suspect, not the last.
