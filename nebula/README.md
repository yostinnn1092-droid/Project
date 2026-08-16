# Nebula — Constellation

A god-game about indirect power, inspired by the premise of the manhwa
*Nebula's Civilization* (Wirae / Beomguin). Original code, art, world and text —
this borrows the **idea** of a constellation who gains power from a civilization's
devotion, not the story, characters or setting.

## The design

You never act on the world. You answer prayers, or you don't.

- **Faith** is income: population x devotion, dragged down by dependency.
- **Devotion** is the multiplier and the fail state. It decays on its own.
- **Dependency** is the trap. Answering raises it. It suppresses faith income
  and makes them pray more often.
- **Self-reliance** is per-settlement. Refusing a prayer raises it; a self-reliant
  town feeds itself better and quietly solves its own problems.

Both extremes lose. Answer everything and dependency strangles you while a rival
ascends. Answer nothing and famine empties the map. The game is in the triage.

## Verified balance

A/B across policies over 900 seasons, and 7 seeds of the middle policy:

| Policy | Result |
|---|---|
| Answer everything affordable | Loses — dependency ~70%, ascension stalls |
| Refuse everything | Loses — extinct by season ~50 |
| Answer urgent, refuse the rest | Wins 5/7 seeds, typically season 270-360 |

## Build

    node build.mjs ../nebula.html

Single self-contained HTML file, no dependencies, canvas 2D.
