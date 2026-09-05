// Everything the player has named, and what naming costs them.
//
// Two limits doing different jobs. WILL is spent per name and comes back
// slowly, so naming is paced — you cannot clear a forest and adopt all of it in
// one afternoon. CAPACITY is a hard ceiling on how many can be kept at once, so
// the late game becomes a question of who is worth a place rather than how many
// can be hoarded. A resource alone would only delay hoarding; a cap alone would
// make an early name feel free.
class Roster {
  constructor(owner) {
    this.owner = owner;
    this.capacity = CFG.roster.capacity;
    this.will = CFG.roster.maxWill;
    this.family = [];

    // Named creatures turn on whatever hurts their master. This is the "they
    // defend us" half of the promise, and it should not need an order.
    owner.health.onHit.push(blow => {
      const src = blow.source;
      if (!src || src === owner) return;
      // Never turn the family on each other, and never on the master —
      // friendly fire from a familiar's own jaws would start a brawl inside
      // the party.
      if (src.familiar && src.familiar.bound) return;
      for (const f of this.family) f.familiar.defendAgainst(src);
    });
  }

  tick(dt) {
    if (this.will < CFG.roster.maxWill)
      this.will = Math.min(CFG.roster.maxWill, this.will + CFG.roster.willRegen * dt);
    // A familiar that dies leaves the roster. Checked here rather than through
    // a death listener so a body removed any other way is also noticed.
    for (let i = this.family.length - 1; i >= 0; i--)
      if (this.family[i].health.dead) this.family.splice(i, 1);
  }

  /**
   * Whether this creature could be named right now, and if not, why. The reason
   * is returned rather than logged so the prompt can say "no room" or "not
   * enough will" instead of just refusing silently.
   */
  canName(actor) {
    if (!actor) return 'Nothing there.';
    if (actor.identity.named) return `${actor.identity.display} already has a name.`;
    if (this.family.length >= this.capacity) return `No room. ${this.capacity} is all you can hold.`;
    if (this.will < actor.identity.cost)
      return `Not enough will (${Math.floor(this.will)}/${Math.ceil(actor.identity.cost)}).`;
    return null;
  }

  /** Names it and takes it in. Returns null and a reason if it could not be done. */
  name(actor, given) {
    const refusal = this.canName(actor);
    if (refusal) return { familiar: null, reason: refusal };
    given = (given || '').trim();
    if (!given) return { familiar: null, reason: 'It needs a name.' };

    this.will -= actor.identity.cost;

    // A name makes it stronger. This is what separates naming from recruiting,
    // and why spending the will is worth it.
    actor.health.scaleMaxHealth(actor.identity.power);
    actor.subdue.consume();
    actor.tame();
    actor.familiar.bindTo(this);
    this.family.push(actor);

    // The name goes on LAST, deliberately. bestow raises the event a pack
    // listens to, and naming the creature first meant a pack heard its
    // leader's name, went looking for the roster to bind its members to, and
    // found nothing there yet — the whole pack would have joined masterless.
    actor.identity.bestow(given);

    return { familiar: actor, reason: null };
  }

  orderAll(order, target = null) {
    for (const f of this.family) f.familiar.command(order, target);
  }
}

// ───────────────────────────────────────────────────────────── the pack
//
// A leader and the creatures that follow it.
//
// This exists to make a fight have a SHAPE. Six identical wolves is an
// endurance test whose only decision is which one happens to be closest. Put a
// leader among them and the fight acquires a question — spend yourself reaching
// the dangerous one, or grind through the escort — and answering it correctly
// is rewarded by the pack coming apart.
//
// The same structure carries the naming system's biggest payoff. Name the
// leader and the whole pack comes with it, for ONE place on the roster, because
// the pack follows the leader rather than the player. That is the fiction's own
// hierarchy, and it is what makes hunting a leader worth the risk.
class Pack {
  constructor(leader, members) {
    this.leader = leader;
    this.members = members.slice();
    this.broken = false;

    // A wild pack already keeps station on its leader, which is what makes it
    // read as a pack rather than as five animals standing near each other.
    for (const m of this.members) m.setHome(leader, CFG.pack.memberLeash);

    leader.identity.onNamed.push(() => this.onLeaderNamed());
    leader.subdue.onCollapsed.push(() => this.signal(CFG.pack.hesitateDuration));
    leader.health.onDeath.push(() => {
      if (this.broken) return;
      this.broken = true;
      this.signal(CFG.pack.routDuration);
    });
  }

  /**
   * The leader is down or dead. On a collapse the pack WAVERS rather than
   * breaking — that is the moment the player is deciding whether to name it,
   * and a pack that fled here would rob the decision of its danger.
   */
  signal(seconds) {
    for (const m of this.members) {
      if (m.health.dead) continue;
      m.rout(this.leader.pos.x, this.leader.pos.z, seconds);
    }
  }

  /**
   * The leader has been named, so the pack changes hands with it. Members are
   * tamed and anchored to the leader, and are deliberately NOT added to the
   * roster: the player holds the leader, the leader holds the pack. One name,
   * one place, five wolves.
   */
  onLeaderNamed() {
    const roster = this.leader.familiar.master;
    for (const m of this.members) {
      if (m.health.dead) continue;
      m.tame();
      // Subduable arms the death guard on everything tameable and only clears
      // it when one actually collapses. A member that joined without ever
      // going down would otherwise be unkillable.
      m.health.preventDeath = false;
      if (roster) m.familiar.bindTo(roster);
      m.familiar.setAnchor(this.leader);
      m.familiar.command(Order.Follow);
      m.subdue.isDown = false;
      m.mesh.rotation.z = 0;
    }
  }
}
