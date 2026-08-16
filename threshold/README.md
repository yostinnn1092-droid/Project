# Threshold

A 3D roguelike. You are a Candidate inside an assessment tower that was supposed
to be nine floors and has not stopped. Original setting, enemies, skills, items
and text throughout — it borrows the *premise* of a brutal endless tutorial
tower, nothing else.

## The loop

Enter floor → clear the objective → take one reward from three → find the exit →
next floor. Die, lose everything you were carrying, keep the Marks, spend them
on what you are rather than what you hold, re-enter.

## Systems in the slice

- Third-person movement, jump, and a dodge with real invulnerability frames
- Melee (stamina) and ranged bolts (focus), with a 4-slot skill bar
- Vitality / Stamina / Focus, plus ATK, DEF, crit
- Four enemy archetypes with distinct behaviour, all telegraphing before they hit
- A three-phase boss every fifth floor — different attack per phase, not more HP
- Procedural floors: rooms, corridors, cover pillars, hazards
- Three objective types: purge, endure (with pressure spawns), sever anchors
- Loot in four rarity tiers, equipment slots, run-long relics
- Permanent progression across eight upgrade lines, saved to localStorage
- Risk rewards that cost vitality for a stronger item

## Verified

| Check | Result |
|---|---|
| Floor connectivity (flood fill, 6 floors) | exit + 100% of enemies reachable |
| Warden guard | front 12 · behind 100 · flank 100 — positioning worth 8.3x |
| Dodge i-frames | 36 damage normally, 0 during i-frames |
| Scaling | floor 1: 38hp/13dmg → floor 20: 587hp/86.7dmg |
| Boss | 3 phases, 3 distinct attacks |
| Save/load | roundtrips |
| Power curve | HP x3.0, ATK x4.3 start to developed |

## Not yet in

Branching skill tree (skills are currently drawn from reward rolls), enemy
variety beyond four archetypes plus boss, more than one boss, random narrative
events. The architecture takes them without restructuring: enemies are table
entries in `EDEF`, skills in `SKILLS`, objectives in `makeObjective`.


## Enemy roster

Nine archetypes, each owning a mechanic no other one has:

| | Behaviour |
|---|---|
| Shambler | Slow melee, heavy telegraph. The baseline dead. |
| Sprinter | Fast, fragile, short wind-up. Punishes standing still. |
| Spitter | Hangs back and spits, strafes, retreats when closed on. |
| Bulwark | Guard faces where it looks — flank it or break it with Sunder. |
| Screamer | Rings out to full reach, no safe spacing. Slows to 55%. |
| Spewer | Three-way spray; strafing does not clear it, cover does. |
| Revenant | Walks through walls, and so does its shot. Cover is no answer. |
| Crawler | Lies flat on the floor until you are 5m away, then erupts. |
| Bloater | Leaves persistent bile where you stand. Takes ground, not health. |

## Mobile

One build serves both. `IS_TOUCH` (coarse pointer) switches the input scheme,
the HUD and the performance budget at load.

- Floating twin-stick: the left thumb spawns a movement stick wherever it lands,
  the right half of the screen drags the camera. Nothing is a fixed pad you have
  to hunt for while something is winding up at you.
- Thumb cluster bottom-right: strike, dodge, bolt, plus four skill buttons up
  the edge. The middle third of the screen is kept clear — that is where the
  fight is.
- Aim assist on touch only: committing to a strike eases you toward the nearest
  enemy inside a forward cone. It never turns you around, so it assists intent
  rather than replacing it, and it is off on desktop where the mouse is precise.
- Attack latch: a tap can start and end inside one frame, so the intent is held
  for ~0.16s and always lands exactly one strike. Holding auto-repeats.
- Performance: pixel ratio capped at 1.5, antialiasing off, shadow map 768
  instead of 1536, PCF instead of PCFSoft. Phone GPUs are fill-rate bound long
  before they are triangle bound, so resolution goes before geometry.
- Portrait shows a rotate prompt and pauses the run — a twin-stick layout plus a
  readable HUD does not fit.
- Browser gestures disabled: pull-to-refresh, double-tap zoom, text selection,
  iOS callout.

## Build

    node build.mjs ../threshold.html
