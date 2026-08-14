export class MultiRendererV2 {
  constructor({ root = document, battle }) {
    this.root = root;
    this.battle = battle;
    this.selectedSlot = 0;
    this.targeting = null;
    this.escape = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
    this.els = {};
  }

  bind() {
    this.battle.onUpdate = () => this.render();
    this.els.back?.addEventListener('click', () => history.back());
  }

  render() {
    this.cache();
    if (!this.els.arena) return;
    this.renderHeader();
    this.renderSide('opponent');
    this.renderSide('player');
    this.renderCommandDock();
    this.renderLog();
  }

  cache() {
    const q = id => this.root.querySelector(id);
    this.els = {
      arena:q('#multiArena'), opponent:q('#multiOpponent'), player:q('#multiPlayer'),
      command:q('#multiCommand'), log:q('#battleLog'), turn:q('#turnLabel'), field:q('#fieldLabel'),
      targetHint:q('#multiTargetHint'), back:q('#backToBuilder')
    };
  }

  renderHeader() {
    if (this.els.turn) this.els.turn.textContent = `Turn ${this.battle.turn} · ${this.battle.battleSize}v${this.battle.battleSize}`;
    if (this.els.field) {
      const f = this.battle.field;
      this.els.field.textContent = f ? `${f}${this.battle.fieldTurns ? ` · ${this.battle.fieldTurns}T` : ''}` : 'No Field';
    }
    if (this.els.targetHint) {
      if (this.battle.over) this.els.targetHint.textContent = 'Battle complete';
      else if (this.targeting) this.els.targetHint.textContent = `Choose a target for ${this.targeting.move.name}`;
      else this.els.targetHint.textContent = 'Click one of your active Pokémon to command it.';
    }
  }

  slotsFor(side) { return Array.isArray(this.battle[side]?.active) ? this.battle[side].active : []; }
  pendingFor(side) { return Array.isArray(this.battle.pendingActions?.[side]) ? this.battle.pendingActions[side] : []; }
  pendingForSlot(side, slot) { return this.pendingFor(side).find(a => a.slot === slot); }

  renderSide(side) {
    const box = this.els[side];
    if (!box) return;
    const slots = this.slotsFor(side);
    const pending = this.pendingFor(side);
    box.innerHTML = '';
    slots.forEach((teamIndex, slot) => {
      const p = this.battle[side]?.team?.[teamIndex];
      const action = pending.find(a => a.slot === slot);
      const unit = document.createElement('div');
      unit.className = `multi-v2-field-unit ${side === 'player' ? 'ally-unit' : 'enemy-unit'}`;
      if (!p?.canBattle()) unit.classList.add('fainted');
      if (side === 'player' && slot === this.selectedSlot && p?.canBattle() && !this.targeting) unit.classList.add('selected');
      if (action) unit.classList.add('locked');
      if (this.targeting) {
        const valid = this.validTarget(side, teamIndex, slot);
        unit.classList.toggle('targetable', valid);
        unit.classList.toggle('not-targetable', !valid);
      }
      unit.setAttribute('role', 'button');
      unit.tabIndex = p?.canBattle() ? 0 : -1;
      const actionable = p?.canBattle() && !(side === 'player' && !!action && !this.targeting);
      if (!actionable) unit.setAttribute('aria-disabled', 'true');
      unit.innerHTML = p ? this.fieldUnitHTML(p, side, slot, action) : `<div class="empty-slot">Empty</div>`;
      const click = () => { if (actionable || this.targeting) this.onCardClick(side, slot, teamIndex); };
      unit.addEventListener('click', click);
      unit.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && (actionable || this.targeting)) { e.preventDefault(); click(); } });
      box.appendChild(unit);
    });
  }

  fieldUnitHTML(p, side, slot, action) {
    const sprite = side === 'player' ? p.sprites?.back : p.sprites?.front;
    const hp = Math.max(0, Math.min(100, (p.hp / Math.max(1, p.maxHP)) * 100));
    const status = p.status ? `<span class="multi-v2-status-chip">${this.escape(String(p.status).replace(/-/g,' '))}</span>` : '';
    return `<span class="slot-badge">${slot + 1}</span><div class="multi-v2-sprite-stage"><img class="multi-v2-field-sprite" src="${this.escape(sprite || '')}" alt="${this.escape(p.name)}"><span class="multi-v2-sprite-shadow"></span></div><div class="multi-v2-info-card"><div class="multi-v2-name"><strong>${this.escape(p.name)}</strong><small>Lv.${p.level}</small></div><div class="types">${(p.types||[]).map(t=>`<span class="type">${this.escape(t)}</span>`).join('')}</div><div class="multi-v2-hp"><span><i style="width:${hp}%"></i></span><em>${p.hp}/${p.maxHP}</em></div>${status}</div>${action ? `<span class="action-badge">✓</span>` : ''}`;
  }

  onCardClick(side, slot, teamIndex) {
    if (this.battle.busy || this.battle.over) return;
    const p = this.battle[side]?.team?.[teamIndex];
    if (!p?.canBattle()) return;
    if (this.targeting) {
      if (!this.validTarget(side, teamIndex, slot)) return;
      this.commitTarget(side, teamIndex);
      return;
    }
    if (side !== 'player') return;
    if (this.pendingForSlot('player', slot)) return;
    this.selectedSlot = slot;
    this.render();
  }

  getTargetMode(move) {
    const explicit = String(move?.target || move?.targeting || '').toLowerCase();
    const selfMoves = new Set(['agility','bulk-up','dragon-cheer','endure','protect','rest','roost','substitute','sunny-day','swords-dance','sleep-talk']);
    if (explicit === 'self' || selfMoves.has(move?.id)) return 'self';
    if (['ally','ally-one','teammate','player'].includes(explicit) || move?.id === 'helping-hand') return 'ally';
    if (['any','all'].includes(explicit)) return 'any';
    return 'opponent';
  }

  validTarget(side, teamIndex) {
    const t = this.targeting;
    if (!t) return false;
    if (t.mode === 'self') return side === 'player' && teamIndex === this.battle.player.active?.[this.selectedSlot];
    if (t.mode === 'ally') return side === 'player' && this.battle.activeIndices('player').includes(teamIndex) && teamIndex !== this.battle.player.active?.[this.selectedSlot];
    if (t.mode === 'any') return this.battle.activeIndices(side).includes(teamIndex);
    return side === 'opponent' && this.battle.activeIndices('opponent').includes(teamIndex);
  }

  beginMove(move) {
    const slot = this.selectedSlot;
    if (this.pendingForSlot('player', slot)) return;
    const teamIndex = this.battle.player.active?.[slot];
    const actor = this.battle.player.team?.[teamIndex];
    if (!actor?.canBattle()) return;
    const mode = this.getTargetMode(move);
    if (mode === 'self') {
      this.commitAction(slot, move.id, 'player', teamIndex);
      return;
    }
    this.targeting = { slot, move, mode };
    this.render();
  }

  commitTarget(side, teamIndex) {
    const t = this.targeting;
    if (!t) return;
    if (t.mode === 'self') return;
    if (!this.validTarget(side, teamIndex)) return;
    this.commitAction(t.slot, t.move.id, side, teamIndex);
  }

  commitAction(slot, moveId, targetSide, targetIndex) {
    const ok = this.battle.setLocalAction(slot, moveId, targetSide, targetIndex);
    if (!ok) return;
    this.targeting = null;
    const next = this.findNextOpenSlot();
    if (next >= 0) this.selectedSlot = next;
    this.render();
  }

  commitSwitch(targetIndex) {
    const slot = this.selectedSlot;
    if (this.pendingForSlot('player', slot)) return;
    const ok = this.battle.setLocalSwitch(slot, targetIndex);
    if (!ok) return;
    const next = this.findNextOpenSlot();
    if (next >= 0) this.selectedSlot = next;
    this.render();
  }

  findNextOpenSlot() {
    const required = this.battle.requiredSlots('player');
    const pending = new Set(this.pendingFor('player').map(a => a.slot));
    return required.find(slot => !pending.has(slot)) ?? -1;
  }

  renderCommandDock() {
    const panel = this.els.command;
    if (!panel) return;
    panel.innerHTML = '';
    if (this.battle.over) {
      panel.innerHTML = `<div class="multi-v2-result"><strong>${this.battle.result?.winnerRole === 'local' || this.battle.result?.winnerRole === 'host' ? 'Victory!' : 'Defeat'}</strong><span>Return to Team Builder to play again.</span></div>`;
      return;
    }
    const activeIndex=this.battle.player.active?.[this.selectedSlot];
    const pokemon=this.battle.player.team?.[activeIndex];
    if (!pokemon?.canBattle()) { panel.innerHTML=`<div class="multi-v2-empty-command">Select a living Pokémon on the field.</div>`; return; }
    const pending=this.pendingForSlot('player',this.selectedSlot);
    const allLocked=this.pendingFor('player').length>=this.battle.requiredSlots('player').length;
    const moves=this.battle.getAvailableMovesFor(pokemon);
    const moveCards=moves.map(m=>`<button class="multi-v2-move" data-move="${this.escape(m.id)}" ${pending||this.battle.busy||allLocked?'disabled':''}><strong>${this.escape(m.name)}</strong><span>${this.escape((m.types||[]).join(' / '))} · ${this.escape(m.category||'status')}</span><small>${m.pp??'—'} PP</small></button>`).join('');
    const activeSet=new Set(this.battle.player.active||[]);
    const bench=this.battle.player.team.map((p,i)=>({p,i})).filter(x=>x.p?.canBattle()&&!activeSet.has(x.i));
    const switches=bench.map(x=>`<button class="multi-v2-switch" data-switch="${x.i}" ${pending||this.battle.busy||allLocked?'disabled':''}><img src="${this.escape(x.p.sprites?.front||'')}" alt=""><span>${this.escape(x.p.name)}</span></button>`).join('');
    panel.innerHTML=`<div class="multi-v2-command-head"><div><small>COMMANDING</small><h2>${this.escape(pokemon.name)}</h2></div><div class="multi-v2-progress">${this.pendingFor('player').length}/${this.battle.requiredSlots('player').length} ready</div></div>${this.targeting?`<div class="multi-v2-targeting">Select a valid target on the battlefield for <b>${this.escape(this.targeting.move.name)}</b>.</div>`:`<div class="multi-v2-moves">${moveCards}</div>`}<div class="multi-v2-switches"><div class="multi-v2-section-title">SWITCH</div><div class="multi-v2-switch-row">${switches||'<span class="multi-v2-no-switch">No healthy bench Pokémon available.</span>'}</div></div>`;
    panel.querySelectorAll('[data-move]').forEach(btn=>btn.addEventListener('click',()=>this.beginMove(moves.find(m=>m.id===btn.dataset.move))));
    panel.querySelectorAll('[data-switch]').forEach(btn=>btn.addEventListener('click',()=>this.commitSwitch(Number(btn.dataset.switch))));
  }

  renderLog() {
    if (!this.els.log) return;
    const log=this.battle.log.slice(-14);
    let status='';
    const need=this.battle.requiredSlots('player').length;
    const mine=this.pendingFor('player').length;
    const theirs=this.battle.networkRole ? Number(this.battle.remoteActionsCount || 0) : this.pendingFor('opponent').length;
    if(!this.battle.over){
      if(mine>=need&&!this.battle.busy) status=`<div class="v2-status">Your side is locked in — waiting for the opponent (${theirs}/${this.battle.requiredSlots('opponent').length}).</div>`;
      else if(theirs>=this.battle.requiredSlots('opponent').length&&mine<need&&!this.battle.busy) status=`<div class="v2-status">The opponent is ready — choose the remaining ${need-mine} action${need-mine===1?'':'s'}.</div>`;
      else if(this.battle.busy) status=`<div class="v2-status live">Resolving turn…</div>`;
    }
    this.els.log.innerHTML=log.map(x=>`<div class="v2-log-line">${this.escape(x)}</div>`).join('')+status;
    this.els.log.scrollTop=this.els.log.scrollHeight;
  }
}
