# Nebula 3D — Constellation

A 3D god-game. You are a constellation who cannot act on the world, only answer
the people in it. Inspired by the premise of the manhwa *Nebula's Civilization*
(Wirae / Beomguin) — original code, world, art and text throughout. The UI takes
its floating-lit-panel language and cold starfield palette from that direction;
no character or story content is reproduced.

## What is simulated

Every person is an individual agent, not a population number.

- **Name, trade, home, temperament.** Six temperaments, each reacting differently
  to the same act: measured, one identical answer moves a Zealot +0.143 faith,
  a Devout +0.107, a Skeptic +0.039.
- **They decide for themselves.** Each re-evaluates on its own clock, weighing
  hunger, fear and belief: work, eat, go home, pray, flee, or leave for good.
- **Faith is per-person.** Devotion in the HUD is literally the mean of what
  every living person privately believes — not a number handed to you.
- **Prayers come from individuals**, chosen by who is actually suffering, and
  an answer ripples out from that person to everyone who could see it, filtered
  through each witness's own temperament.

## Controls

Drag to pan · wheel to zoom · Q/E rotate · click a person to read them.

## Balance, measured

8 seeds per policy, 600 days each:

| Policy | Survived | Median souls |
|---|---|---|
| Refuse everything | 0/8 | 5 |
| Answer urgent only | 2/8 to day 600 | 53 (floor 20) |
| Answer everything | 2/8 to day 600 | 46 (floor 1) |

Refusing everything fails decisively. Selective play has the best median and a
much higher floor. The gap between selective and indiscriminate is real but
narrower than in the 2D version — see the note in the commit message.

## Build

    node build.mjs ../nebula3d.html
