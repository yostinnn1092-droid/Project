# Medieval RPG — combat slice

The first playable piece: a third-person character who moves, commits to weighted
swings, dodges, and a wolf that circles and lunges at him. Everything else in the
design — naming monsters into a family, emergent classes, skill trees, the demon
king — is built on top of this feeling right first.

**None of this has run yet.** It was written without Unity, so `tools/check.sh`
builds it against real UnityEngine and UnityEditor assemblies pulled from NuGet.
That catches typos, wrong argument counts and misremembered APIs — most of what
goes wrong when code is written blind, and it has caught plenty. It says nothing
about null references, execution order, or whether any of it is fun. Nothing here
is clever, precisely because only half of it can be verified.

## Playing it

You need **Unity 6 LTS** (via Unity Hub) and about ten minutes.

1. **New project → 3D (URP).**
   URP rather than HDRP: the look this is aiming at is mobile-grade, which URP
   reaches comfortably and which keeps Android open. HDRP is prettier on a
   desktop and closes that door.

2. **Copy `Assets/` from this folder into your new project's `Assets/`.**
   Both `Scripts` and `Editor`. Wait for Unity to finish compiling.

3. **Tools ▸ RPG ▸ Build Test Scene.**

4. If it says input handling was changed, **restart Unity** and run the menu item
   again. Then press **Play**.

That is the whole setup. The menu item creates the layers, fixes the input
setting, builds the ground, the player rig, the camera, a training dummy and a
wolf pack, wires every reference, and saves the result to
`Assets/Scenes/Arena.unity`.

### Why the scene is a script

There is no scene and no prefab checked in here, deliberately. A Unity scene is
opaque YAML that cannot be reviewed or written correctly by anything but Unity,
and the alternative — a page of instructions ending in "now drag the WolfAI
component into the Brain slot" — is about forty chances to make a mistake that
shows up as a silent nothing an hour later. As code the scene is reviewable,
repeatable, and when a field gets renamed it fails loudly instead of leaving an
empty slot. Run the menu item as often as you like; it is idempotent.

## Controls

| | |
|---|---|
| Move | `WASD` |
| Sprint | `Left Shift` |
| Attack | `Left Mouse` |
| Dodge | `Space` |
| Look | Mouse |
| Name a downed beast | `F` |
| Pick a different name | `Tab` |

## What to do on the first run

**Hit the dummy first.** It is seven metres ahead and cannot fight back, which is
the point — it isolates what a swing feels like from what a fight feels like.
Left mouse three times for the chain. The third is the heavy one.

**Then walk north to the pack.** Four wolves and a leader, the big dark one with
the gold crest. They notice you at about fourteen metres.

Ignore how it looks. The questions are:

- Does a swing have **weight**, or does it feel like waving a stick?
- Press attack during a swing — does the next one come out when it should?
- Can you see the wolf's crouch in time to roll it?
- Does getting bitten feel like being hit?

**Then try to take one alive.** Wear a wolf down and it collapses instead of
dying. Walk over and press **F**. The hard part is stopping — attacks commit, so
the greedy third swing is exactly how you lose the wolf you wanted.

**Then go for the leader.** Name it and the whole pack comes with it, for one
place on the roster. That is the payoff the naming system was built for, and it
is the first thing worth judging in the design rather than the feel.

Everything is tuned from the inspector — `AttackStep` timings on `PlayerCombat`,
`telegraph` on `WolfAI`, `hitstopOnDamage` on `Damageable`. Those numbers are
first guesses by someone who could not play it. **Expect to change them.**

## Known rough edges

- **Wild wolves can clip each other** when a lunge passes through a packmate.
  Their jaws are set to hit both the player and other monsters, because a wolf
  that joins you has to be able to fight the ones that did not. A tamed wolf's
  jaws are narrowed the moment it changes sides, so a familiar cannot bite its
  owner — but two familiars can still catch each other in a scrum.
- **No animation.** Everything is primitives, and the attack "animation" is a
  hitbox switching on. The telegraph is legible only because the leader has a
  crest and every wolf has a pale snout showing which way it faces.
- **Names do not survive a restart.** Nothing is saved yet.

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

### If you are wiring it by hand

The builder does all of this, but for a scene of your own: the **Player** needs
`FamilyRoster` and `NamingInteractor`; a **creature** needs `MonsterIdentity` and
`Subduable`, with its AI component dragged into `Subduable → Brain`. Set the
creature's layer in `NamingInteractor → Monster Layers`, and set
`Familiar → Hostile Layers` to what it should fight for you — **not** the player's
layer, or your own wolf will pick a fight with you.

A `Familiar` component can sit on a wild creature to hold those settings; it does
nothing until the creature is actually named.

### Orders

`FamilyRoster.OrderAll(...)` takes **Follow**, **Hold**, **Attack**, **Wait**.
Nothing is bound to a key yet — orders exist as an API, not an interface.

## Packs and leaders

Six identical wolves is an endurance test, and the only decision in it is which
one happens to be closest. Put a **leader** among them and the fight acquires a
question — spend yourself reaching the dangerous one, or grind through the
escort — and answering it right is paid out in the pack coming apart.

Morale gives that shape:

| What happens to the leader | What the pack does |
| --- | --- |
| Collapses (down, alive) | **Hesitates** for a few seconds — it can still be rallied, and this is your window to walk over and name it |
| Dies | **Routs**, scattering away from where it fell |
| Is named | **Joins you**, anchored to the leader rather than to you |

The last row is the payoff the whole naming system was building toward. A named
leader brings its **entire pack for one place on the roster**, because the pack
follows the leader and the leader follows you. That is the fiction's own
hierarchy, and it is what makes hunting a leader worth the risk rather than just
fighting a tougher wolf. Members are deliberately not named themselves and
cannot be — one name, one slot, six wolves.

Routing is a reprieve, not a win. A scattered wolf recovers its nerve and then
simply asks the ordinary question of whether anything is still close enough to
notice — so breaking a pack buys you the seconds to finish the leader or to
leave, and standing there admiring your work does not.

### Scene setup for a pack

The test scene builds one already. For a scene of your own: put the leader and
its members under one parent object and add **`MonsterPack`** to the parent. Leave **Leader** and **Members** empty and it takes the first
child `MonsterIdentity` marked **Is Leader** and everything else beneath it.

On the leader's `MonsterIdentity`, tick **Is Leader** and raise **Naming Cost** —
it is worth several wolves, and the price should say so. Members need nothing
beyond the usual `MonsterIdentity` + `Subduable`; the pack anchors them to their
leader itself, which is what makes them read as a pack rather than as six animals
standing near each other.

`MonsterPack.Adopt(...)` adds a creature at runtime, for a leader that calls for
help or a den that keeps producing them.

## What comes next

1. **Emergent class** — track what the player actually does, have NPCs notice.
2. **Saving** — names do not survive a restart yet, which they must.
3. **A second species** — the wolf is the only proof that `IMonsterBrain` keeps
   a named creature fighting like itself. One more would make it a fact.

Nothing above matters if the combat is not fun, which is why that was step 0.
