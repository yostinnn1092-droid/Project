# Medieval RPG — combat slice

The first playable piece: a third-person character who moves, commits to weighted
swings, dodges, and a wolf that circles and lunges at him. Everything else in the
design — naming monsters into a family, emergent classes, skill trees, the demon
king — is built on top of this feeling right first.

**None of this code has been compiled.** It was written in an environment with no
Unity and no C# toolchain, so treat the first build as a spelling test: paste any
compiler errors back and they will be fixed. Nothing here is clever, precisely
because it could not be verified.

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

## What comes next

Once the feel is right, in order:

1. **Subdue instead of kill** — a body left alive at low health, approachable.
2. **Naming** — name that body and it becomes yours. The heart of the whole idea.
3. **Pack leaders** — a wolf leader whose pack scatters or rallies with it.
4. **Emergent class** — track what the player actually does, have NPCs notice.

Nothing above matters if step 0 is not fun, which is why it is the whole of this
first slice.
