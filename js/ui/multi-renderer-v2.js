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
    window.addEventListener('resize', () => this.renderResponsiveLabels(), { passive: true });
    this.render();
  }

  render() {
    this.cache();
    if (!this.els.arena) return;
    this.renderHeader();
    this.renderSide('opponent');
    this.renderSide('player');
    this.renderRosters('opponent');
    this.renderRosters('player');
    this.renderCommandDock();
    this.renderLog();
    this.renderResponsiveLabels();
  }

  cache() {
    const q = id => this.root.querySelector(id);
    this.els = {
      arena:q('#multiArena'), opponent:q('#multiOpponent'), player:q('#multiPlayer'),
      command:q('#multiCommand'), log:q('#battleLog'), turn:q('#turnLabel'), field:q('#fieldLabel'),
      opponentRail:q('#multiOpponentRail'), playerRail:q('#multiPlayerRail'), back:q('#backToBuilder')
    };
    if (this.els.back && !this.els.back.dataset.bound) {
      this.els.back.dataset.bound = '1';
      this.els.back.addEventListener('click', () => this.onBack?.());
    }
  }

  renderHeader() {
    if (this.els.turn) this.els.turn.textContent = `Turn ${this.battle.turn} · ${this.battle.battleSize}v${this.battle.battleSize}`;
    if (this.els.field) {
      const f = this.battle.field;
      this.els.field.textContent = f ? `${f}${this.battle.fieldTurns ? ` · ${this.battle.fieldTurns}T` : ''}` : 'No Field';
    }
  }

  renderResponsiveLabels() {
    this.els.arena?.setAttribute('data-slots', String(this.battle.battleSize));
    this.els.arena?.style.setProperty('--battle-count', String(this.battle.battleSize));
    this.els.arena?.style.setProperty('--viewport-w', `${window.innerWidth}px`);
  }

  slotsFor(side) { return Array.isArray(this.battle[side]?.active) ? this.battle[side].active : []; }
  pendingFor(side) { return Array.isArray(this.battle.pendingActions?.[side]) ? this.battle.pendingActions[side] : []; }
  pendingForSlot(side, slot) { return this.pendingFor(side).find(a => a.slot === slot); }

  hpBarHTML(p) {
    const hp = Math.max(0, Number(p?.hp ?? 0));
    const max = Math.max(1, Number(p?.maxHP ?? p?.hp ?? 1));
    const pct = Math.max(0, Math.min(100, (hp / max) * 100));
    const tone = pct <= 25 ? 'danger' : pct <= 50 ? 'warn' : 'ok';
    return `<div class="sd-hp"><div class="sd-hp-track"><div class="sd-hp-fill ${tone}" style="width:${pct}%"></div></div><span>${hp}/${max}</span></div>`;
  }

  fieldUnitHTML(p, side, slot, action) {
    const sprite = side === 'player' ? (p.sprites?.back || p.sprites?.front) : (p.sprites?.front || p.sprites?.back);
    const status = p.status ? `<span class="sd-status">${this.escape(String(p.status).replace(/-/g, ' '))}</span>` : '';
    const chips = (p.types || []).slice(0, 2).map(t => `<span class="sd-chip">${this.escape(t)}</span>`).join('');
    return `
      <span class="sd-slot-badge">${slot + 1}</span>
      <div class="sd-unit-hud">
        <div class="sd-name-row"><strong>${this.escape(p.name)}</strong><span>Lv.${p.level ?? 50}</span></div>
        ${this.hpBarHTML(p)}
        <div class="sd-meta-row">${chips}${status}</div>
      </div>
      <div class="sd-sprite-stage"><span class="sd-shadow"></span><img class="sd-field-sprite" src="${this.escape(sprite || '')}" alt="${this.escape(p.name)}" draggable="false"></div>
      ${action ? '<span class="sd-ready-mark">✓</span>' : ''}`;
  }

  renderSide(side) {
    const box = this.els[side];
    if (!box) return;
    const slots = this.slotsFor(side);
    const pending = this.pendingFor(side);
    box.innerHTML = '';
    slots.forEach((teamIndex, slot) => {
      const p = this.battle[side]?.team?.[teamIndex];
      const action = pending.find(a => a.slot === slot);
      const unit = document.createElement('button');
      unit.type = 'button';
      const selectable = p?.canBattle() && !(side === 'player' && action && !this.targeting);
      unit.className = `sd-field-unit ${side === 'player' ? 'is-player' : 'is-opponent'}`;
      if (!p?.canBattle()) unit.classList.add('is-fainted');
      if (side === 'player' && slot === this.selectedSlot && p?.canBattle() && !this.targeting) unit.classList.add('is-selected');
      if (action) unit.classList.add('is-locked');
      if (this.targeting) {
        const valid = this.validTarget(side, teamIndex, slot);
        unit.classList.toggle('is-targetable', valid);
        unit.classList.toggle('is-not-targetable', !valid);
      }
      unit.disabled = !selectable && !this.targeting;
      unit.setAttribute('aria-label', p ? `${side === 'player' ? 'Select' : 'Target'} ${p.name}, slot ${slot + 1}` : 'Empty slot');
      unit.innerHTML = p ? this.fieldUnitHTML(p, side, slot, action) : `<div class="sd-empty-slot">Empty slot</div>`;
      unit.addEventListener('click', () => {
        if (this.targeting) {
          if (this.validTarget(side, teamIndex, slot)) this.commitTarget(side, teamIndex);
          return;
        }
        if (selectable && side === 'player') {
          this.selectedSlot = slot;
          this.render();
        }
      });
      box.appendChild(unit);
    });
    if (!slots.length) box.innerHTML = '<div class="sd-empty-slot">No active Pokémon</div>';
  }

  renderRosters(side) {
    const box = side === 'player' ? this.els.playerRail : this.els.opponentRail;
    if (!box) return;
    const team = this.battle[side]?.team || [];
    const active = new Set(this.slotsFor(side));
    box.innerHTML = team.map((p, index) => {
      const activeHere = active.has(index);
      const fainted = !p?.canBattle();
      const state = fainted ? 'faint' : activeHere ? 'active' : 'bench';
      const sprite = p?.sprites?.front || p?.sprites?.back || '';
      return `<div class="sd-rail-dot ${state}" title="${this.escape(p?.name || '')}"><img src="${this.escape(sprite)}" alt=""></div>`;
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

  validTarget(side, teamIndex, slot) {
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
    if (!t || !this.validTarget(side, teamIndex, 0)) return;
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
    return required.find(slot => !pending.has(slot) && this.battle.player.team?.[this.battle.player.active?.[slot]]?.canBattle()) ?? -1;
  }

  renderCommandDock() {
    const panel = this.els.command;
    if (!panel) return;
    if (this.battle.over) {
      panel.innerHTML = `<div class="sd-waiting"><strong>${this.battle.result?.winnerRole === 'local' || this.battle.result?.winnerRole === 'host' ? 'Victory!' : 'Defeat'}</strong><span>Return to Team Builder to play again.</span></div>`;
      return;
    }
    const activeIndex = this.battle.player.active?.[this.selectedSlot];
    const pokemon = this.battle.player.team?.[activeIndex];
    if (!pokemon?.canBattle()) {
      panel.innerHTML = `<div class="sd-waiting"><strong>Select one of your active Pokémon.</strong><span>Click a Pokémon on the field to command it.</span></div>`;
      return;
    }
    const pending = this.pendingForSlot('player', this.selectedSlot);
    const required = this.battle.requiredSlots('player').length;
    const mine = this.pendingFor('player').length;
    const allLocked = mine >= required;
    const moves = this.battle.getAvailableMovesFor(pokemon) || [];
    const moveCards = moves.map(m => `<button class="sd-move ${this.targeting?.move?.id === m.id ? 'is-selected' : ''}" data-move="${this.escape(m.id)}" ${pending || this.battle.busy || allLocked ? 'disabled' : ''}><span class="sd-move-name">${this.escape(m.name)}</span><span class="sd-move-meta">${this.escape((m.types || []).join(' / '))} · ${this.escape(m.category || 'status')}</span><span class="sd-move-pp">${m.pp ?? '—'} PP</span></button>`).join('');
    const activeSet = new Set(this.battle.player.active || []);
    const bench = this.battle.player.team.map((p,i) => ({p,i})).filter(x => x.p?.canBattle() && !activeSet.has(x.i));
    const switches = bench.map(x => `<button class="sd-switch" data-switch="${x.i}" ${pending || this.battle.busy || allLocked ? 'disabled' : ''}><img src="${this.escape(x.p.sprites?.front || '')}" alt=""><span>${this.escape(x.p.name)}</span><small>${x.p.hp}/${x.p.maxHP}</small></button>`).join('');
    panel.innerHTML = `<div class="sd-command-head"><div><span class="sd-eyebrow">WHAT WILL ${this.escape(pokemon.name.toUpperCase())} DO?</span><h2>${this.escape(pokemon.name)}</h2></div><div class="sd-ready">${mine}/${required} ready</div></div>${this.targeting ? `<div class="sd-target-banner">Choose a target on the field for <strong>${this.escape(this.targeting.move.name)}</strong><button class="sd-cancel" id="sdCancelTarget" type="button">Cancel</button></div>` : ''}<div class="sd-command-body"><div class="sd-move-grid">${moveCards}</div><div class="sd-switch-block"><div class="sd-section-title">Switch</div><div class="sd-switch-grid">${switches || '<span class="sd-empty-text">No healthy bench Pokémon.</span>'}</div></div></div>`;
    panel.querySelectorAll('[data-move]').forEach(btn => btn.addEventListener('click', () => this.beginMove(moves.find(m => m.id === btn.dataset.move))));
    panel.querySelectorAll('[data-switch]').forEach(btn => btn.addEventListener('click', () => this.commitSwitch(Number(btn.dataset.switch))));
    const cancel = panel.querySelector('#sdCancelTarget');
    if (cancel) cancel.addEventListener('click', () => { this.targeting = null; this.render(); });
  }

  renderLog() {
    if (!this.els.log) return;
    const log = Array.isArray(this.battle.log) ? this.battle.log.slice(-80) : [];
    const need = this.battle.requiredSlots('player').length;
    const mine = this.pendingFor('player').length;
    const theirs = this.battle.networkRole ? Number(this.battle.remoteActionsCount || 0) : this.pendingFor('opponent').length;
    let status = '';
    if (!this.battle.over) {
      if (this.battle.busy) status = '<div class="sd-log-entry"><strong>Resolving turn…</strong></div>';
      else if (mine >= need) status = `<div class="sd-log-entry"><strong>Your side is ready.</strong> Waiting for opponent (${Math.min(theirs, need)}/${need}).</div>`;
      else if (theirs >= need) status = `<div class="sd-log-entry"><strong>Opponent is ready.</strong> Choose your remaining actions.</div>`;
      else status = `<div class="sd-log-entry">Choose actions for ${Math.max(0, need - mine)} Pokémon.</div>`;
    }
    this.els.log.innerHTML = `${log.map(x => `<div class="sd-log-entry">${this.escape(x)}</div>`).join('')}${status}`;
    this.els.log.scrollTop = this.els.log.scrollHeight;
  }
}
