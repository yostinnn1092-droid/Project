// The HUD.
//
// The naming system is invisible without it. A wolf that has collapsed looks
// much like a wolf about to get up, and the difference between those two is the
// entire mechanic — so the countdown has to be on screen or the window cannot
// be played.
const hud = {
  hp: el('hpFill'), hpText: el('hpText'),
  will: el('willFill'), willText: el('willText'),
  family: el('family'),
  prompt: el('prompt'),
  pending: el('pending'),
  flash: el('flash'),
  dead: el('dead'),
  bName: el('bName'),
};

let lastFamilySig = '';

function drawHud() {
  const p = world.player;
  const h = p.health;

  const hpPct = Math.max(0, h.health / h.maxHealth) * 100;
  hud.hp.style.width = hpPct + '%';
  hud.hpText.textContent = `${Math.max(0, Math.ceil(h.health))} / ${Math.ceil(h.maxHealth)}`;

  const r = p.roster;
  hud.will.style.width = (r.will / CFG.roster.maxWill * 100) + '%';
  hud.willText.textContent = `${Math.floor(r.will)} / ${CFG.roster.maxWill}`;

  // Rebuilt only when it changes: this runs every frame, and thrashing the DOM
  // for a list that is identical 99% of the time is a real cost on a phone.
  const sig = r.family.map(f =>
    `${f.identity.display}:${Math.ceil(f.health.health)}`).join('|') + `/${r.capacity}`;
  if (sig !== lastFamilySig) {
    lastFamilySig = sig;
    const rows = r.family.map(f => {
      const pct = Math.max(0, f.health.health / f.health.maxHealth) * 100;
      const led = f.identity.isLeader ? ' <b>◆</b>' : '';
      return `<div class="fam"><span>${f.identity.display}${led}</span>` +
             `<i style="width:${pct}%"></i></div>`;
    }).join('');
    const spare = r.capacity - r.family.length;
    hud.family.innerHTML =
      `<div class="famHead">Family ${r.family.length} / ${r.capacity}</div>` + rows +
      (spare > 0 ? `<div class="fam dimmed"><span>${spare} place${spare > 1 ? 's' : ''} free</span></div>` : '');
  }

  const showing = !!naming.prompt;
  hud.prompt.textContent = naming.prompt;
  hud.prompt.classList.toggle('on', showing);
  // The name you are about to give is the decision being made, so it belongs on
  // screen at the moment you make it and nowhere else.
  hud.pending.textContent = showing ? `“${naming.pending}”` : '';
  hud.pending.classList.toggle('on', showing);
  hud.bName.classList.toggle('live', !!naming.candidate);

  const flashing = world.time < naming.flashUntil;
  hud.flash.textContent = flashing ? naming.flash : '';
  hud.flash.classList.toggle('on', flashing);

  hud.dead.classList.toggle('on', p.health.dead);
}
