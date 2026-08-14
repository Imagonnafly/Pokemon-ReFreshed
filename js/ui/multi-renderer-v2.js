export class MultiRendererV2 {
  constructor({ root = document, battle }) {
    this.root = root;
    this.battle = battle;
    this.selectedSlot = 0;
    this.targeting = null;
    this.escape = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
    this.els = {};
    this.bound = false;
  }

  bind() {
    if (this.bound) return;
    this.bound = true;
    this.battle.onUpdate = () => this.render();
    this.render();
  }

  cache() {
    const q = id => this.root.querySelector(id);
    this.els = {
      arena: q('#multiArena'), opponent: q('#multiOpponent'), player: q('#multiPlayer'),
      command: q('#multiCommand'), log: q('#battleLog'), turn: q('#turnLabel'), field: q('#fieldLabel'),
      opponentRail: q('#multiOpponentRail'), playerRail: q('#multiPlayerRail'), back: q('#backToBuilder')
    };
    if (this.els.back && !this.els.back.dataset.bound) {
      this.els.back.dataset.bound = '1';
      this.els.back.addEventListener('click', () => this.onBack?.());
    }
  }

  render() {
    this.cache();
    if (!this.els.arena) return;
    this.updateHeader();
    this.renderField('opponent');
    this.renderField('player');
    this.renderRail('opponent');
    this.renderRail('player');
    this.renderCommands();
    this.renderLog();
    const count = String(this.battle.battleSize || 1);
    this.els.arena.dataset.slots = count;
    this.els.opponent?.style.setProperty('--battle-count', count);
    this.els.player?.style.setProperty('--battle-count', count);
  }

  updateHeader() {
    if (this.els.turn) this.els.turn.textContent = `Turn ${this.battle.turn} · ${this.battle.battleSize}v${this.battle.battleSize}`;
    if (this.els.field) {
      const f = this.battle.field;
      this.els.field.textContent = f ? `${f}${this.battle.fieldTurns ? ` · ${this.battle.fieldTurns}T` : ''}` : 'No Field';
    }
  }

  slotsFor(side) { return Array.isArray(this.battle[side]?.active) ? this.battle[side].active : []; }
  pendingFor(side) { return Array.isArray(this.battle.pendingActions?.[side]) ? this.battle.pendingActions[side] : []; }
  pendingForSlot(side, slot) { return this.pendingFor(side).find(a => Number(a.slot) === Number(slot)); }

  hp(p) {
    const max = Math.max(1, Number(p?.maxHP ?? p?.hp ?? 1));
    const hp = Math.max(0, Number(p?.hp ?? 0));
    return { max, hp, pct: Math.max(0, Math.min(100, hp / max * 100)) };
  }

  hpHTML(p) {
    const { max, hp, pct } = this.hp(p);
    const tone = pct <= 25 ? 'danger' : pct <= 50 ? 'warn' : 'ok';
    return `<div class="v4-hp"><div class="v4-hp-track"><span class="v4-hp-fill ${tone}" style="width:${pct}%"></span></div><span class="v4-hp-text">${hp}/${max}</span></div>`;
  }

  fieldUnitHTML(p, side, slot, action) {
    const sprite = side === 'player' ? (p.sprites?.back || p.sprites?.front) : (p.sprites?.front || p.sprites?.back);
    const status = p.status ? `<span class="v4-status">${this.escape(String(p.status).replace(/-/g, ' '))}</span>` : '';
    const types = (p.types || []).slice(0, 2).map(t => `<span class="v4-type">${this.escape(t)}</span>`).join('');
    return `
      <span class="v4-slot">${slot + 1}</span>
      <div class="v4-mon-hud">
        <div class="v4-name-line"><strong>${this.escape(p.name)}</strong><span>Lv.${p.level ?? 50}</span></div>
        ${this.hpHTML(p)}
        <div class="v4-type-line">${types}${status}</div>
      </div>
      <div class="v4-mon-stage"><span class="v4-shadow"></span><img class="v4-mon-sprite" src="${this.escape(sprite || '')}" alt="${this.escape(p.name)}" draggable="false"></div>
      ${action ? '<span class="v4-ready">✓</span>' : ''}`;
  }

  renderField(side) {
    const box = this.els[side];
    if (!box) return;
    const slots = this.slotsFor(side);
    const pending = this.pendingFor(side);
    box.innerHTML = '';
    slots.forEach((teamIndex, slot) => {
      const p = this.battle[side]?.team?.[teamIndex];
      const action = pending.find(a => Number(a.slot) === Number(slot));
      const unit = document.createElement('button');
      unit.type = 'button';
      const ownSelectable = side === 'player' && p?.canBattle() && !action && !this.battle.busy;
      unit.className = `v4-field-unit ${side === 'player' ? 'is-own' : 'is-enemy'}`;
      if (!p?.canBattle()) unit.classList.add('is-fainted');
      if (side === 'player' && slot === this.selectedSlot && p?.canBattle() && !this.targeting) unit.classList.add('is-selected');
      if (action) unit.classList.add('is-locked');
      if (this.targeting) {
        const valid = this.validTarget(side, teamIndex);
        unit.classList.toggle('is-targetable', valid);
        unit.classList.toggle('is-dimmed', !valid);
      }
      unit.disabled = !ownSelectable && !this.targeting;
      unit.innerHTML = p ? this.fieldUnitHTML(p, side, slot, action) : '<div class="v4-empty">Empty</div>';
      unit.addEventListener('click', () => {
        if (this.targeting) {
          if (this.validTarget(side, teamIndex)) this.commitTarget(side, teamIndex);
          return;
        }
        if (ownSelectable) {
          this.selectedSlot = slot;
          this.render();
        }
      });
      box.appendChild(unit);
    });
  }

  renderRail(side) {
    const box = side === 'player' ? this.els.playerRail : this.els.opponentRail;
    if (!box) return;
    const team = this.battle[side]?.team || [];
    const active = new Set(this.slotsFor(side));
    box.innerHTML = team.map((p, index) => {
      const state = !p?.canBattle() ? 'faint' : active.has(index) ? 'active' : 'bench';
      const sprite = p?.sprites?.front || p?.sprites?.back || '';
      return `<button type="button" class="v4-rail-dot ${state}" title="${this.escape(p?.name || '')}" disabled><img src="${this.escape(sprite)}" alt=""></button>`;
    }).join('');
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
    if (!this.battle.activeIndices(side).includes(teamIndex)) return false;
    if (t.mode === 'self') return side === 'player' && teamIndex === this.battle.player.active?.[t.slot];
    if (t.mode === 'ally') return side === 'player' && teamIndex !== this.battle.player.active?.[t.slot];
    if (t.mode === 'any') return true;
    return side === 'opponent';
  }

  beginMove(move) {
    const slot = this.selectedSlot;
    if (this.pendingForSlot('player', slot)) return;
    const teamIndex = this.battle.player.active?.[slot];
    const actor = this.battle.player.team?.[teamIndex];
    if (!actor?.canBattle()) return;
    if (this.getTargetMode(move) === 'self') {
      this.commitAction(slot, move.id, 'player', teamIndex);
      return;
    }
    this.targeting = { slot, move, mode: this.getTargetMode(move) };
    this.render();
  }

  commitTarget(side, teamIndex) {
    const t = this.targeting;
    if (!t) return;
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
    const pending = new Set(this.pendingFor('player').map(a => Number(a.slot)));
    return required.find(slot => !pending.has(slot) && this.battle.player.team?.[this.battle.player.active?.[slot]]?.canBattle()) ?? -1;
  }

  renderCommands() {
    const panel = this.els.command;
    if (!panel) return;
    if (this.battle.over) {
      panel.innerHTML = `<div class="v4-wait"><strong>${this.battle.result?.winnerRole === 'local' || this.battle.result?.winnerRole === 'host' ? 'Victory!' : 'Defeat'}</strong><span>Return to Team Builder to play again.</span></div>`;
      return;
    }
    const activeIndex = this.battle.player.active?.[this.selectedSlot];
    const pokemon = this.battle.player.team?.[activeIndex];
    if (!pokemon?.canBattle()) {
      panel.innerHTML = `<div class="v4-wait"><strong>Select one of your active Pokémon.</strong><span>Click a Pokémon on the field to command it.</span></div>`;
      return;
    }
    const pending = this.pendingForSlot('player', this.selectedSlot);
    const required = this.battle.requiredSlots('player').length;
    const mine = this.pendingFor('player').length;
    const moves = this.battle.getAvailableMovesFor(pokemon) || [];
    const allLocked = mine >= required;
    const moveCards = moves.map(m => `<button class="v4-move ${this.targeting?.move?.id === m.id ? 'is-selected' : ''}" data-move="${this.escape(m.id)}" ${pending || this.battle.busy || allLocked ? 'disabled' : ''}><strong>${this.escape(m.name)}</strong><span>${this.escape((m.types || []).join(' / '))} · ${this.escape(m.category || 'Move')}</span><small>${m.pp ?? '—'} PP</small></button>`).join('');
    const activeSet = new Set(this.battle.player.active || []);
    const bench = this.battle.player.team.map((p, i) => ({ p, i })).filter(x => x.p?.canBattle() && !activeSet.has(x.i));
    const switchCards = bench.map(x => `<button class="v4-switch" data-switch="${x.i}" ${pending || this.battle.busy || allLocked ? 'disabled' : ''}><img src="${this.escape(x.p.sprites?.front || '')}" alt=""><span>${this.escape(x.p.name)}</span><small>${x.p.hp}/${x.p.maxHP}</small></button>`).join('');
    panel.innerHTML = `
      <div class="v4-command-top"><div><div class="v4-eyebrow">WHAT WILL ${this.escape(pokemon.name.toUpperCase())} DO?</div><h2>${this.escape(pokemon.name)}</h2></div><span class="v4-ready-count">${mine}/${required} ready</span></div>
      ${this.targeting ? `<div class="v4-target-banner"><span>Choose a target for <strong>${this.escape(this.targeting.move.name)}</strong>.</span><button id="v4CancelTarget" type="button">Cancel</button></div>` : ''}
      <div class="v4-action-grid">${moveCards}</div>
      <div class="v4-switch-wrap"><div class="v4-section-title">SWITCH</div><div class="v4-switch-grid">${switchCards || '<span class="v4-empty-text">No healthy bench Pokémon available.</span>'}</div></div>`;
    panel.querySelectorAll('[data-move]').forEach(btn => btn.addEventListener('click', () => this.beginMove(moves.find(m => m.id === btn.dataset.move))));
    panel.querySelectorAll('[data-switch]').forEach(btn => btn.addEventListener('click', () => this.commitSwitch(Number(btn.dataset.switch))));
    panel.querySelector('#v4CancelTarget')?.addEventListener('click', () => { this.targeting = null; this.render(); });
  }

  renderLog() {
    if (!this.els.log) return;
    const lines = Array.isArray(this.battle.log) ? this.battle.log.slice(-100) : [];
    const need = this.battle.requiredSlots('player').length;
    const mine = this.pendingFor('player').length;
    const theirs = this.battle.networkRole ? Number(this.battle.remoteActionsCount || 0) : this.pendingFor('opponent').length;
    let status = '';
    if (!this.battle.over) {
      if (this.battle.busy) status = '<div class="v4-log-status"><strong>Resolving turn…</strong></div>';
      else if (mine >= need) status = `<div class="v4-log-status"><strong>Your side is ready.</strong> Waiting for the opponent (${Math.min(theirs, need)}/${need}).</div>`;
      else if (theirs >= need) status = `<div class="v4-log-status"><strong>Opponent is ready.</strong> Choose your remaining actions.</div>`;
      else status = `<div class="v4-log-status">Choose actions for ${Math.max(0, need - mine)} Pokémon.</div>`;
    }
    this.els.log.innerHTML = `${lines.map(x => `<div class="v4-log-entry">${this.escape(x)}</div>`).join('')}${status}`;
    this.els.log.scrollTop = this.els.log.scrollHeight;
  }
}
