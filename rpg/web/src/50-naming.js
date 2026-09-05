// ───────────────────────────────────────────────────────────── identity
//
// What a creature IS, as opposed to what it is doing. A wild thing is "a Wolf"
// — indefinite, one of many. The moment it is named it becomes "Fenrir", and
// nothing else in the world is that. Everything the naming system is for hangs
// off that one change.
class Identity {
  constructor(actor, alpha) {
    this.actor = actor;
    this.species = alpha ? 'Dire Wolf' : 'Wolf';
    this.isLeader = !!alpha;
    this.cost = alpha ? CFG.roster.alphaCost : CFG.roster.wolfCost;
    this.power = alpha ? CFG.roster.alphaPower : CFG.roster.wolfPower;
    this.given = '';
    this.onNamed = [];
  }

  get named() { return this.given.length > 0; }
  get display() { return this.named ? this.given : this.species; }

  /** Names it, permanently. Refuses a second name — in the fiction and in code. */
  bestow(name) {
    if (this.named) return false;
    name = (name || '').trim();
    if (!name) return false;
    this.given = name;
    for (const fn of this.onNamed) fn(this);
    return true;
  }
}

// ───────────────────────────────────────────────────────────── subduable
//
// The window in which a creature can be named instead of killed.
//
// Worn down past a threshold it COLLAPSES rather than dying: helpless, on the
// ground, for a few seconds. Land another blow in that window and it dies like
// anything else. Leave it too long and it gets back up.
//
// The whole design is in that sentence. Taming is not a menu option or a thrown
// net — it is the ability to notice a creature break and to STOP HITTING IT.
// That is genuinely hard here, because attacks commit and cannot be called off
// once started, so a greedy third swing is exactly how a player loses the wolf
// they wanted. The combat's weight and the naming's difficulty turn out to be
// the same mechanic seen from two sides.
class Subduable {
  constructor(actor) {
    this.actor = actor;
    this.isDown = false;
    this.remaining = 0;
    this.onCollapsed = [];
    this.onRecovered = [];
    // Armed from the start: anything tameable is worn down rather than killed,
    // so the window always appears at least once.
    actor.health.preventDeath = true;

    actor.health.onHit.push(() => {
      if (actor.health.dead) return;
      if (this.isDown) {
        // Already broken, and hit again. This is the mistake the whole mechanic
        // is built around, so it is not softened: it dies, and the name is lost
        // with it.
        actor.health.kill();
        return;
      }
      // Family is not prey — named creatures obviously, but also pack members,
      // who joined under their leader and carry no name of their own. Without
      // the second half a wolf that came with its leader would keep collapsing
      // in fights, and every recovery re-arms the death guard.
      if (this.spokenFor) return;
      if (actor.health.health <= actor.health.maxHealth * CFG.subdue.collapseAt)
        this.collapse();
    });
  }

  get spokenFor() {
    if (this.actor.identity.named) return true;
    // An UNBOUND familiar does not count: the component holds settings long
    // before it holds an allegiance.
    return this.actor.familiar.bound;
  }

  get canBeNamed() {
    return this.isDown && !this.actor.health.dead && !this.spokenFor;
  }

  collapse() {
    if (this.isDown) return;
    this.isDown = true;
    this.remaining = CFG.subdue.downFor;
    // NOT invulnerable. Making it so would drop the finishing blow before the
    // hit even registered, so a downed creature could never be killed at all —
    // and the tension the mechanic runs on would be gone. The death guard comes
    // off instead. From here a hit is a hit.
    this.actor.health.preventDeath = false;
    this.actor.swing.close();
    this.actor.mesh.rotation.z = 1.3;
    for (const fn of this.onCollapsed) fn();
  }

  tick(dt) {
    if (!this.isDown) return;
    this.remaining -= dt;
    if (this.remaining > 0) return;
    this.isDown = false;
    this.remaining = 0;
    this.actor.health.preventDeath = true;      // it can be broken again
    this.actor.health.heal(this.actor.health.maxHealth * CFG.subdue.recoverTo);
    this.actor.mesh.rotation.z = 0;
    this.actor.state = WolfState.Idle;
    for (const fn of this.onRecovered) fn();
  }

  /**
   * The naming succeeded. Ends the window without healing it back to fighting
   * strength — a new familiar gets up hurt, which is a quiet reason to care
   * about the thing you just took in.
   */
  consume() {
    this.isDown = false;
    this.remaining = 0;
    // A creature that has joined you dies like anything else. Keeping the guard
    // on would make every familiar quietly unkillable.
    this.actor.health.preventDeath = false;
    this.actor.mesh.rotation.z = 0;
    this.actor.state = WolfState.Idle;
  }
}

// ───────────────────────────────────────────────────────────── familiar
//
// What a named creature does. Deliberately thin: it decides WHERE to be and WHO
// to fight, and hands both to the creature's own brain. It never moves the body.
//
// That split is the point. A familiar layer that drove movement directly would
// make every named creature move identically, and a named Minotaur would just
// be a large wolf. Here a wolf keeps circling and lunging, and whatever is
// added later keeps whatever makes it itself.
const Order = { Follow: 'follow', Hold: 'hold', Attack: 'attack', Wait: 'wait' };

class Familiar {
  constructor(actor) {
    this.actor = actor;
    this.master = null;
    this.order = Order.Follow;
    this.anchor = null;
    this.nextThink = 0;

    actor.health.onHit.push(blow => {
      if (!this.bound || this.order === Order.Wait) return;
      const src = blow.source;
      if (!src) return;
      if (src.familiar && src.familiar.bound) return;    // never the family
      if (this.master && src === this.master.owner) return;  // nor the master
      if (!this.actor.target) this.actor.setTarget(src);
    });
  }

  /** Actually belongs to someone. The component exists long before that. */
  get bound() { return this.master !== null; }

  bindTo(roster) {
    this.master = roster;
    this.order = Order.Follow;
    this.actor.setHome(this.anchorActor(), CFG.familiar.leash);
    // Anything that has joined you dies like anything else. Subduable arms the
    // guard on everything tameable and only clears it when one actually
    // collapses — so a pack member that joined with its leader, having never
    // gone down itself, would have been quietly unkillable.
    this.actor.health.preventDeath = false;
  }

  /**
   * Keep station on something other than the master. A pack member is anchored
   * to its LEADER, so the chain runs player → leader → pack, which is the
   * hierarchy the fiction promises and the reason a leader costs one slot
   * rather than the pack costing six.
   */
  setAnchor(actor) {
    this.anchor = actor;
    if (this.order === Order.Follow)
      this.actor.setHome(this.anchorActor(), CFG.familiar.leash);
  }

  anchorActor() {
    if (this.anchor) return this.anchor;
    return this.master ? this.master.owner : null;
  }

  command(order, target = null) {
    this.order = order;
    if (order === Order.Attack) { this.actor.setTarget(target); return; }
    this.actor.setTarget(null);
    if (order === Order.Follow) this.actor.setHome(this.anchorActor(), CFG.familiar.leash);
  }

  /** Something hurt the master. Answer it unless told to stay out. */
  defendAgainst(attacker) {
    if (!this.bound || this.order === Order.Wait || !attacker) return;
    this.actor.setTarget(attacker);
  }

  tick(dt, actors) {
    // Inert until it has a master. Otherwise a wild wolf carrying this for its
    // settings would start hunting the very creatures it is one day meant to
    // fight FOR you — which is to say, the pack attacking itself.
    if (!this.bound || this.actor.health.dead) return;
    if (this.actor.world.time < this.nextThink) return;
    this.nextThink = this.actor.world.time + CFG.familiar.rethinkEvery;

    const anchor = this.anchorActor();
    const t = this.actor.target;
    if (t) {
      const gone = t.health.dead;
      const tooFar = anchor && dist2(t.pos, anchor.pos) > CFG.familiar.chaseLimit;
      if (gone || tooFar) this.actor.setTarget(null);
    }

    if (this.order === Order.Wait) return;
    if (this.order === Order.Attack && this.actor.target) return;
    if (!this.actor.target) this.acquire(actors, anchor);
  }

  acquire(actors, anchor) {
    const from = anchor ? anchor.pos : this.actor.pos;
    let best = null, bestD = Infinity;
    for (const c of actors) {
      if (c === this.actor || c.health.dead) continue;
      if (c.team !== 'monster') continue;
      if (c.familiar && c.familiar.bound) continue;             // family
      // A creature already broken is not a threat, and finishing it is the
      // player's call — a familiar should not rob them of a naming.
      if (c.subdue && c.subdue.isDown) continue;
      if (dist2(c.pos, this.actor.pos) > CFG.familiar.watchRadius) continue;
      const d = dist2(c.pos, from);
      if (d > CFG.familiar.chaseLimit) continue;
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best !== this.actor.target) this.actor.setTarget(best);
  }
}
