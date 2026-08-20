export class Renderer {
  constructor(root, data, battle, callbacks) { this.root = root; this.data = data; this.battle = battle; this.callbacks = callbacks; this.selectedSlot = 0; }
  mount() { this.battle.subscribe(snapshot => this.render(snapshot)); this.render(this.battle.snapshot()); }
  render(state) {
    this.root.innerHTML = `
      <div class="shell">
        <header class="topbar"><div><strong>Pokémon ReFreshed</strong><span class="sub">clean battle rewrite</span></div><div class="pill">Turn ${state.turn} · ${state.battleSize}v${state.battleSize}</div></header>
        <main class="battle-layout">
          <section class="field">
            <div class="sky"></div>
            <div class="side-label enemy-label">OPPONENT</div>
            <div class="active-row enemy-row">${state.sides.opponent.active.map((_,i)=>this.card(state.sides.opponent,i,'enemy')).join('')}</div>
            <div class="ground enemy-ground"></div>
            <div class="side-label player-label">YOU</div>
            <div class="ground player-ground"></div>
            <div class="active-row player-row">${state.sides.player.active.map((_,i)=>this.card(state.sides.player,i,'player')).join('')}</div>
          </section>
          <aside class="battle-panel">
            <div class="log">${state.messages.map(m=>`<div>${escapeHtml(m)}</div>`).join('')}</div>
            <div class="commands"><div class="command-title">Choose an action</div><div class="actor-grid">${this.actorSelectors(state)}</div><div class="move-grid">${this.playerMoves(state)}</div></div>
            <div class="party-panel"><div class="command-title">Party</div>${state.sides.player.team.map((p,i)=>this.partyButton(p,i,state)).join('')}</div>
            ${state.phase==='finished'?`<button class="primary restart" data-action="restart">Return to Team Builder</button>`:''}
          </aside>
        </main>
      </div>`;
    this.bind();
  }
  card(sideState, slot, side) {
    const teamIndex = sideState.active[slot]; const p = teamIndex == null ? null : sideState.team[teamIndex];
    if (!p) return `<div class="slot empty"></div>`;
    const hp = Math.round((p.hp / p.maxHp) * 100);
    const sprite = side === 'enemy' ? p.sprites.front : p.sprites.back;
    return `<article class="pokemon-card ${side} ${p.hp<=0?'fainted':''}">
      <div class="namebar"><span>${escapeHtml(p.name)}</span><span>Lv.${p.level}</span></div>
      <div class="types">${p.types.map(t=>`<span class="type type-${t.toLowerCase()}">${t}</span>`).join('')}</div>
      <div class="hp"><div class="hp-fill" style="width:${hp}%"></div></div><div class="hp-text">${p.hp} / ${p.maxHp}</div>
      <img class="sprite" src="${sprite}" alt="${escapeHtml(p.name)}" loading="eager" onerror="this.style.visibility='hidden'">
      ${p.status?`<span class="status">${escapeHtml(this.data.statuses[p.status.id]?.label || p.status.id)}</span>`:''}
    </article>`;
  }
  actorSelectors(state) {
    return state.sides.player.active.map((idx, slot) => { const p = idx == null ? null : state.sides.player.team[idx]; if (!p) return ''; const chosen = Boolean(state.sides.player.choices[slot]); return `<button class="actor-btn ${slot===this.selectedSlot?'selected':''} ${chosen?'chosen':''}" data-actor="${slot}">${escapeHtml(p.name)} ${chosen?'✓':''}</button>`; }).join('');
  }
  playerMoves(state) {
    const p = this.currentPlayerPokemon(state,this.selectedSlot); if (!p) return '';
    if (state.sides.player.choices[this.selectedSlot]) return `<div class="choice-locked">${escapeHtml(p.name)} is locked in. Choose another active Pokémon.</div>`;
    return p.moves.map(id => { const move=this.data.moves[id]; return `<button class="move" data-move="${id}"><span>${escapeHtml(move.name)}</span><small>${move.type} · ${move.category}</small></button>`; }).join('');
  }
  partyButton(p,i,state) { const active=state.sides.player.active.includes(i); return `<button class="party-btn ${p.hp<=0?'dead':''} ${active?'active':''}" data-switch="${i}"><span>${i+1}. ${escapeHtml(p.name)}</span><span>${p.hp}/${p.maxHp}</span></button>`; }
  currentPlayerPokemon(state,slot){ const idx=state.sides.player.active[slot]; return idx==null?null:state.sides.player.team[idx]; }
  bind() {
    this.root.querySelectorAll('[data-actor]').forEach(btn=>btn.addEventListener('click',()=>{ this.selectedSlot=Number(btn.dataset.actor); this.render(this.battle.snapshot()); }));
    this.root.querySelectorAll('[data-move]').forEach(btn=>btn.addEventListener('click',()=>this.callbacks.onMove(btn.dataset.move,this.selectedSlot)));
    this.root.querySelectorAll('[data-switch]').forEach(btn=>btn.addEventListener('click',()=>this.callbacks.onSwitch(Number(btn.dataset.switch))));
    this.root.querySelector('[data-action="restart"]')?.addEventListener('click',this.callbacks.onRestart);
  }
}
function escapeHtml(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
