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

## Build

    node build.mjs ../threshold.html
