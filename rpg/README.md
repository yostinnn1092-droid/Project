# Medieval RPG — combat slice

The first playable piece: a third-person character who moves, commits to weighted
swings, dodges, and a wolf that circles and lunges at him. Everything else in the
design — naming monsters into a family, emergent classes, skill trees, the demon
king — is built on top of this feeling right first.

**This code compiles, but has never run.** It was written without Unity, so
`tools/check.sh` builds it against real UnityEngine assemblies pulled from NuGet
— that catches typos, wrong argument counts and misremembered Unity APIs, which
is most of what goes wrong when code is written blind.

It says nothing about the runtime. Null references, inspector wiring, execution
order and whether any of it is fun to play are all still unknown. Nothing here is
clever, precisely because only half of it can be verified.

## Setting the project up

1. **Unity 6 LTS**, template **3D (URP)**.
   URP, not HDRP: the reference screenshot is a mobile-grade RPG look, which URP
   reaches comfortably and which keeps Android open. HDRP would be prettier on a
   desktop and would close that door.

2. **Project Settings → Player → Active Input Handling → `Both`.**
   These scripts use the old Input Manager (`Input.GetAxisRaw`, `Fire1`). If this
   is left on the new Input System only, every script throws on the first frame.
   This is the single most likely reason for "nothing works".

3. Copy `Assets/Scripts/` into your project's `Assets/`.

## Building the test scene

A capsule is enough. Bought art changes nothing below.

**Ground** — a big Plane or Cube.

**Player**
- Capsule, tagged **`Player`** (the camera and the wolf both find it by tag).
- Add: `CharacterController`, `Damageable`, `KnockbackReceiver`,
  `PlayerLocomotion`, `PlayerCombat`.
- Child empty called `Weapon`, sitting roughly where a blade would be, with a
  `HitBox` on it. Drag that into `PlayerCombat → Weapon Hit Box`.
- Put the player on its own layer, e.g. **`Player`**.

**Camera**
- On the Main Camera add `OrbitCamera`.
- Set **Collide With** to exclude the `Player` layer, or the camera will fight the
  head it is following.

**Wolf**
- Capsule on a layer like **`Enemy`**.
- Add: `CharacterController`, `Damageable`, `KnockbackReceiver`, `WolfAI`.
- Child empty called `Jaws` with a `HitBox`. Drag into `WolfAI → Jaws`.

**Hit layers** — on each `HitBox`, set **Hit Layers** to the layer it should be
able to strike (player's weapon hits `Enemy`, wolf's jaws hit `Player`). Getting
this wrong is the second most likely reason for "my sword does nothing".

**Hitstop** — one empty object in the scene with the `Hitstop` component. Without
it nothing breaks; hits just feel flat.

## Controls

| | |
|---|---|
| Move | `WASD` |
| Sprint | `Left Shift` |
| Attack | `Left Mouse` |
| Dodge | `Space` |
| Look | Mouse |

## What to judge on the first run

Ignore how it looks. The questions are:

- Does a swing feel like it has **weight**, or like waving a stick?
- When you press attack during a swing, does the next one come out when it should?
- Can you see the wolf's crouch in time to roll it?
- Does getting bitten feel like being hit?

Everything is tuned from the inspector — `AttackStep` timings on `PlayerCombat`,
`telegraph` on `WolfAI`, `hitstopOnDamage` on `Damageable`. Those numbers are
first guesses by someone who could not play it. **Expect to change them.**

## How this is meant to feel, and why

The design rests on one trade: **attacks commit, but input never gets eaten.**

- A swing cannot be cancelled once its windup starts. That commitment is what
  gives a blow weight and what gives an enemy something to punish.
- Presses during a swing are **buffered** and spent the moment the window opens,
  so the player experiences a responsive game made of unresponsive attacks.
- **Recovery is cancellable into a dodge.** That escape valve is what keeps
  commitment fair instead of cruel.
- **Poise**, not health, decides staggering — so a fast weapon cannot lock a big
  monster in permanent flinch, and a heavy weapon is worth its slowness.
- The wolf's **telegraph is the contract**: see the crouch, and you have time.
  Shorten it and the enemy becomes cheap rather than hard.

## Naming

Wear a creature down and it **collapses** instead of dying — helpless for a few
seconds. Walk over and press `F` and it is yours, permanently, under the name you
give it.

The difficulty is not the fight. It is **stopping**. Hit it again while it is down
and it dies, and attacks in this game commit — so a greedy third swing is exactly
how you lose the wolf you wanted. That is the same weight the combat is built on,
seen from the other side.

Two limits keep a name meaningful. **Will** is spent per name and returns slowly,
so you cannot clear a forest and adopt all of it. **Capacity** caps how many you
hold at once, so eventually the roster is a question of who is worth a place.

A named creature keeps fighting like itself. `Familiar` decides only where to be
and what to fight; the creature's own brain still decides how. A named Minotaur
should feel nothing like a large wolf, and that is enforced by the split rather
than by remembering to be careful.

### Scene setup for it

**Player** — add `FamilyRoster` and `NamingInteractor`.

**Wolf** — add `MonsterIdentity` and `Subduable`. On `Subduable`, drag the
`WolfAI` component into **Brain**. Set the wolf's layer in
`NamingInteractor → Monster Layers` and `Familiar → Hostile Layers`.

Hostile Layers on a familiar must **not** include the player or the family, or
your own wolf will pick a fight with you.

`pendingName` on `NamingInteractor` is a placeholder for a text field — whatever
is typed there is the name given. `Prompt` is a string the HUD can display; there
is deliberately no UI yet.

### Orders

`FamilyRoster.OrderAll(...)` takes **Follow**, **Hold**, **Attack**, **Wait**.
Nothing is bound to a key yet — orders exist as an API, not an interface.

## What comes next

1. **Pack leaders** — a wolf leader whose pack scatters or rallies with it.
2. **Emergent class** — track what the player actually does, have NPCs notice.
3. **Saving** — names do not survive a restart yet, which they must.

Nothing above matters if the combat is not fun, which is why that was step 0.
