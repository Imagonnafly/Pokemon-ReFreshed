export class PartyRenderer {
  constructor({ root, battle }) {
    this.root = root;
    this.battle = battle;
    this.selectedSlot = 0;
    this.selectedMove = null;
    this.selectedTarget = null;
    this.els = {
      turn: root.querySelector('#turnLabel'),
      field: root.querySelector('#fieldLabel'),
      allyRow: root.querySelector('#partyAllyRow'),
      enemyRow: root.querySelector('#partyEnemyRow'),
      panel: root.querySelector('#partyMovePanel'),
      hint: root.querySelector('#partyCommandHint'),
      log: root.querySelector('#battleLog')
    };
    this.bound = false;
  }

  bind() {
    if (this.bound) return;
    this.bound = true;
    this.battle.onUpdate = () => this.render();
  }

  render() {
    this.renderHeader();
    this.renderSide('beta', this.els.enemyRow);
    this.renderSide('alpha', this.els.allyRow);
    this.renderPanel();
    this.renderLog();
  }

  renderHeader() {
    if (this.els.turn) {
      const totalActive = (Number(this.battle.battleSize) || 1) * (Number(this.battle.teamSize) || 1);
      this.els.turn.textContent = `Turn ${this.battle.turn} · ${totalActive} active/side`;
    }
    if (this.els.field) this.els.field.textContent = this.battle.field ? `${this.battle.field}${this.battle.fieldTurns ? ` · ${this.battle.fieldTurns}T` : ''}` : 'No Field';
  }

  isPending(memberId, slot) {
    const key = `${memberId}:${slot}`;
    return this.battle.pendingPartyActions?.has(key) || this.battle.pendingIds?.has(key);
  }

  renderSide(side, container) {
    if (!container) return;
    container.innerHTML = '';
    const members = this.battle.getMembersBySide(side);
    for (const member of members) {
      for (let slot = 0; slot < this.battle.battleSize; slot += 1) {
        const p = this.battle.activeMember(member.id, slot);
        const isLocalMember = member.id === this.battle.localMemberId;
        const pending = this.isPending(member.id, slot);
        const selectedSource = isLocalMember && slot === this.selectedSlot && p?.canBattle();
        const card = document.createElement('article');
        card.dataset.memberId = member.id;
        card.dataset.slot = String(slot);
        card.className = [
          'party-pokemon-card',
          isLocalMember ? 'party-local' : '',
          pending ? 'party-locked' : '',
          selectedSource ? 'party-source-selected' : '',
          p?.canBattle() ? '' : 'fainted',
          this.selectedTarget?.memberId === member.id && this.selectedTarget?.slot === slot ? 'party-target-selected' : ''
        ].filter(Boolean).join(' ');

        if (p) {
          const sideSprite = side === 'alpha' ? p.sprites?.back : p.sprites?.front;
          const ownerLabel = isLocalMember ? 'YOU' : (member.side === side ? 'ALLY' : 'OPPONENT');
          const interactiveHint = isLocalMember && p?.canBattle() ? 'Select' : (this.selectedMove ? 'Target' : '');
          card.setAttribute('aria-label', `${interactiveHint} ${p.name}, ${member.name}, slot ${slot + 1}`.trim());
          const hpPct = Math.max(0, Math.min(100, (p.hp / Math.max(1, p.maxHP)) * 100));
          const statusText = p.status ? String(p.status).replace(/-/g, ' ') : '';
          card.innerHTML = `
            <div class="party-trainer-badge"><span>${this.escape(member.name)} · Slot ${slot + 1}</span><em>${ownerLabel}</em></div>
            <div class="showdown-unit-hud">
              <div class="showdown-name-row"><strong>${this.escape(p.name)}</strong><span>Lv.${p.level}</span></div>
              <div class="showdown-hp-row"><div class="showdown-hp-bar"><i style="width:${hpPct}%"></i></div><span>${Math.max(0, p.hp)}/${p.maxHP}</span></div>
            </div>
            <div class="showdown-sprite-stage">
              <img src="${this.escape(sideSprite || '')}" alt="${this.escape(p.name)}">
              <span class="showdown-ground-shadow"></span>
            </div>
            <div class="showdown-unit-meta">
              <div class="party-types">${(p.types || []).map(t => `<span>${this.escape(t)}</span>`).join('')}</div>
              ${statusText ? `<span class="showdown-status-chip">${this.escape(statusText)}</span>` : ''}
            </div>
            ${pending ? '<div class="party-ready-mark">✓ READY</div>' : ''}
            ${selectedSource ? '<div class="party-source-mark">ACTIVE</div>' : ''}`;
        } else {
          card.innerHTML = `<div class="party-empty">Empty Slot ${slot + 1}</div>`;
        }
        container.appendChild(card);
      }
    }

    container.querySelectorAll('.party-pokemon-card').forEach(card => {
      card.addEventListener('click', () => this.handleFieldCardClick(card));
    });
  }

  handleFieldCardClick(card) {
    const memberId = card.dataset.memberId;
    const slot = Number(card.dataset.slot);
    const local = this.battle.getLocalMember?.();
    if (!local) return;

    // Selecting one of your own active Pokémon changes which command dock is shown.
    if (memberId === local.id && this.battle.activeMember(memberId, slot)?.canBattle()) {
      const allowedTarget = this.selectedMove && this.battle.getTargetsFor(local.id, this.selectedMove, this.selectedSlot)
        .some(t => t.memberId === memberId && t.slot === slot);
      if (!this.selectedMove || !allowedTarget) {
        this.selectedSlot = slot;
        this.selectedMove = null;
        this.selectedTarget = null;
        this.render();
        return;
      }
    }

    // If a move is selected, clicking a highlighted Pokémon confirms the target.
    if (this.selectedMove) this.targetMember(memberId, slot);
  }

  getLocalActiveSlots() {
    const local = this.battle.getLocalMember?.();
    if (!local) return [];
    return Array.from({ length: this.battle.battleSize }, (_, slot) => ({
      slot,
      pokemon: this.battle.activeMember(local.id, slot)
    }));
  }

  firstUnsubmittedSlot() {
    const local = this.battle.getLocalMember?.();
    if (!local) return 0;
    for (let slot = 0; slot < this.battle.battleSize; slot += 1) {
      const p = this.battle.activeMember(local.id, slot);
      if (p?.canBattle() && !this.isPending(local.id, slot)) return slot;
    }
    return 0;
  }

  canSwitchFromCurrent(current) {
    if (!current?.canBattle()) return false;
    if (current.volatile?.trapTurns > 0) return false;
    if (this.battle.getStatusDef?.(current)?.statusEffect?.switchBlock) return false;
    return true;
  }

  renderPanel() {
    if (!this.els.panel) return;
    const local = this.battle.getLocalMember?.();
    if (!local) return;

    const localSlots = this.getLocalActiveSlots();
    if (this.battle.over) {
      this.els.panel.innerHTML = `<div class="multi-finish-panel"><strong>${this.battle.result?.localWon ? 'Your team won!' : 'Your team lost!'}</strong><span>${this.battle.result?.localWon ? 'Your team held the field.' : 'The opposing team prevailed.'}</span></div>`;
      return;
    }

    if (!this.battle.pendingPartyActions) this.battle.pendingPartyActions = new Map();
    if (!localSlots.some(s => s.pokemon?.canBattle())) {
      this.els.panel.innerHTML = `<div class="party-waiting-panel"><div class="party-spinner"></div><strong>Waiting for the field to update…</strong><span>Your team is preparing its next active slots.</span></div>`;
      return;
    }

    const aliveCount = localSlots.filter(s => s.pokemon?.canBattle()).length;
    const localPendingCount = localSlots.filter(s => this.isPending(local.id, s.slot)).length;
    if (localPendingCount >= aliveCount) {
      this.els.panel.innerHTML = `<div class="party-waiting-panel compact"><strong>All your actions are locked in.</strong><span>Waiting for the rest of the team and the opposing trainers.</span></div>`;
      this.els.hint.classList.remove('active');
      this.els.hint.innerHTML = '<span class="hint-dot"></span><span>All of your active Pokémon have chosen.</span>';
      return;
    }

    if (!localSlots[this.selectedSlot]?.pokemon?.canBattle() || this.isPending(local.id, this.selectedSlot)) {
      this.selectedSlot = this.firstUnsubmittedSlot();
      this.selectedMove = null;
      this.selectedTarget = null;
    }

    const current = localSlots[this.selectedSlot]?.pokemon;
    const moves = this.battle.getAvailableMovesForMember(local.id, this.selectedSlot) || [];
    const bench = this.battle.getBenchOptions?.(local.id, this.selectedSlot) || [];
    const switchAllowed = this.canSwitchFromCurrent(current) && bench.length > 0 && !this.isPending(local.id, this.selectedSlot);

    const switchButtons = switchAllowed
      ? bench.map(({ pokemon, teamIndex }) => `<button type="button" class="party-switch-button" data-switch-index="${teamIndex}"><img src="${this.escape(pokemon.sprites?.front || '')}" alt=""><span><strong>${this.escape(pokemon.name)}</strong><small>Switch in</small></span></button>`).join('')
      : '';

    this.els.panel.innerHTML = `
      <div class="party-command-top">
        <div>
          <span class="eyebrow">SELECTED ON FIELD · SLOT ${this.selectedSlot + 1}</span>
          <h2>${this.escape(current?.name || 'Select a Pokémon')}</h2>
        </div>
        <span class="command-progress">${localPendingCount}/${aliveCount} actions</span>
      </div>
      <div class="party-action-grid">
        <section class="party-move-section">
          <div class="party-section-title"><span>MOVES</span><small>${this.selectedMove ? 'Choose a highlighted target' : 'Choose a move'}</small></div>
          <div class="polished-moves compact-moves">${moves.map(m => `<button class="multi-move-button ${this.selectedMove?.id === m.id ? 'move-selected' : ''}" data-move="${this.escape(m.id)}" type="button"><strong class="move-name">${this.escape(m.name)}</strong><span class="move-meta">${this.escape((m.types || []).join('/'))} · ${this.escape(m.category || 'Move')}</span><span class="move-pp">PP ${m.pp ?? '—'}</span></button>`).join('')}</div>
        </section>
        <section class="party-switch-section">
          <div class="party-section-title"><span>SWITCH</span><small>${switchAllowed ? 'Select a Pokémon from your bench' : 'No legal switch available'}</small></div>
          <div class="party-switch-grid">${switchButtons || '<div class="party-no-switch">No healthy bench Pokémon available.</div>'}</div>
        </section>
      </div>`;

    this.els.panel.querySelectorAll('[data-move]').forEach(btn => btn.addEventListener('click', () => this.selectMove(btn.dataset.move)));
    this.els.panel.querySelectorAll('[data-switch-index]').forEach(btn => btn.addEventListener('click', () => this.selectSwitch(Number(btn.dataset.switchIndex))));

    this.els.hint.classList.add('active');
    if (this.selectedMove) {
      this.els.hint.innerHTML = `<span class="hint-dot"></span><span><strong>${this.escape(this.selectedMove.name)}</strong> selected for <strong>${this.escape(current?.name || '')}</strong> — click a highlighted Pokémon on the field.</span>`;
    } else {
      this.els.hint.innerHTML = `<span class="hint-dot"></span><span>Click one of your active Pokémon to command it. Then choose a move or switch from the command dock.</span>`;
    }
    this.refreshTargetHighlights();
  }

  selectMove(moveId) {
    const local = this.battle.getLocalMember?.();
    const p = local ? this.battle.activeMember(local.id, this.selectedSlot) : null;
    const move = p?.moves?.find(m => m.id === moveId);
    if (!move) return;
    this.selectedMove = move;
    this.selectedTarget = null;
    this.els.hint.innerHTML = `<span class="hint-dot"></span><span><strong>${this.escape(move.name)}</strong> selected — click a highlighted Pokémon on the field.</span>`;
    this.refreshTargetHighlights();
    this.renderPanel();
  }

  selectSwitch(teamIndex) {
    const local = this.battle.getLocalMember?.();
    if (!local || !this.battle.submitPartySwitch) return;
    const current = this.battle.activeMember(local.id, this.selectedSlot);
    if (!this.canSwitchFromCurrent(current)) return;
    const ok = this.battle.submitPartySwitch(local.id, this.selectedSlot, Number(teamIndex));
    if (ok) {
      this.selectedMove = null;
      this.selectedTarget = null;
      this.selectedSlot = this.firstUnsubmittedSlot();
      this.render();
    }
  }

  refreshTargetHighlights() {
    const all = this.battle.getTargetsFor?.(this.battle.localMemberId, this.selectedMove, this.selectedSlot) || [];
    const targetSet = new Set(all.map(t => `${t.memberId}:${t.slot}`));
    document.querySelectorAll('.party-pokemon-card').forEach(card => {
      const key = `${card.dataset.memberId}:${card.dataset.slot}`;
      card.classList.toggle('party-targetable', !!this.selectedMove && targetSet.has(key));
    });
  }

  targetMember(memberId, slot = 0) {
    if (!this.selectedMove) return;
    const local = this.battle.getLocalMember?.();
    if (!local) return;
    const allowed = this.battle.getTargetsFor(local.id, this.selectedMove, this.selectedSlot).some(t => t.memberId === memberId && t.slot === Number(slot));
    if (!allowed) return;
    const ok = this.battle.submitPartyAction
      ? this.battle.submitPartyAction(local.id, this.selectedSlot, this.selectedMove.id, memberId, Number(slot))
      : false;
    if (ok) {
      this.selectedMove = null;
      this.selectedTarget = null;
      this.selectedSlot = this.firstUnsubmittedSlot();
      this.render();
    }
  }

  renderLog() {
    if (!this.els.log) return;
    const lines = Array.isArray(this.battle.log) ? this.battle.log : [];
    this.els.log.innerHTML = lines.slice(-20).map(x => `<div class="log-line">${this.escape(x)}</div>`).join('');
    this.els.log.scrollTop = this.els.log.scrollHeight;
  }

  escape(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
}
