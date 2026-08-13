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

  renderSide(side, container) {
    if (!container) return;
    container.innerHTML = '';
    const members = this.battle.getMembersBySide(side);
    for (const member of members) {
      for (let slot = 0; slot < this.battle.battleSize; slot += 1) {
        const p = this.battle.activeMember(member.id, slot);
        const isLocal = member.id === this.battle.localMemberId;
        const pending = this.battle.pendingPartyActions?.has(`${member.id}:${slot}`) ||
          this.battle.pendingIds?.has(`${member.id}:${slot}`);
        const card = document.createElement('article');
        card.dataset.memberId = member.id;
        card.dataset.slot = String(slot);
        card.className = `party-pokemon-card ${isLocal ? 'party-local' : ''} ${pending ? 'party-locked' : ''} ${p?.canBattle() ? '' : 'fainted'}`;
        if (this.selectedTarget && this.selectedTarget.memberId === member.id && this.selectedTarget.slot === slot) card.classList.add('party-target-selected');
        if (p) {
          const sideSprite = side === 'alpha' ? p.sprites?.back : p.sprites?.front;
          card.innerHTML = `<div class="party-trainer-badge"><span>${this.escape(member.name)} · Slot ${slot + 1}</span><em>${isLocal ? 'YOU' : (member.side === side ? 'ALLY' : 'OPPONENT')}</em></div><img src="${this.escape(sideSprite || '')}" alt="${this.escape(p.name)}"><div class="party-pokemon-info"><strong>${this.escape(p.name)}</strong><div class="party-types">${(p.types || []).map(t => `<span>${this.escape(t)}</span>`).join('')}</div><div class="hp-row"><div class="hpbar"><div style="width:${Math.max(0, Math.min(100, (p.hp / p.maxHP) * 100))}%"></div></div><span class="hp-text">${Math.max(0,p.hp)}/${p.maxHP}</span></div></div>${pending ? '<div class="party-ready-mark">✓ READY</div>' : ''}`;
        } else {
          card.innerHTML = `<div class="party-empty">Empty Slot ${slot + 1}</div>`;
        }
        container.appendChild(card);
      }
    }

    container.querySelectorAll('.party-pokemon-card').forEach(card => {
      card.addEventListener('click', () => {
        const memberId = card.dataset.memberId;
        const slot = Number(card.dataset.slot);
        this.targetMember(memberId, slot);
      });
    });
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
      const pending = this.battle.pendingPartyActions?.has(`${local.id}:${slot}`) || this.battle.pendingIds?.has(`${local.id}:${slot}`);
      if (p?.canBattle() && !pending) return slot;
    }
    return 0;
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

    const localPendingCount = localSlots.filter(s => this.battle.pendingPartyActions.has(`${local.id}:${s.slot}`) || this.battle.pendingIds?.has(`${local.id}:${s.slot}`)).length;
    if (localPendingCount === localSlots.filter(s => s.pokemon?.canBattle()).length) {
      this.els.panel.innerHTML = `<div class="party-waiting-panel"><div class="party-spinner"></div><strong>All your actions are locked in.</strong><span>Waiting for the rest of your team and the opposing trainers.</span></div>`;
      this.els.hint.classList.remove('active');
      this.els.hint.innerHTML = '<span class="hint-dot"></span><span>All of your active Pokémon have chosen.</span>';
      return;
    }

    if (!localSlots[this.selectedSlot]?.pokemon?.canBattle() || this.battle.pendingPartyActions.has(`${local.id}:${this.selectedSlot}`)) {
      this.selectedSlot = this.firstUnsubmittedSlot();
      this.selectedMove = null;
      this.selectedTarget = null;
    }

    const current = localSlots[this.selectedSlot]?.pokemon;
    const moves = this.battle.getAvailableMovesForMember(local.id, this.selectedSlot) || [];
    const tabs = localSlots.map(({ slot, pokemon }) => {
      const pending = this.battle.pendingPartyActions.has(`${local.id}:${slot}`) || this.battle.pendingIds?.has(`${local.id}:${slot}`);
      return `<button type="button" class="party-active-tab ${slot === this.selectedSlot ? 'active' : ''} ${pending ? 'ready' : ''} ${pokemon?.canBattle() ? '' : 'fainted'}" data-slot="${slot}"><span class="slot-index">${slot + 1}</span><span class="slot-name">${this.escape(pokemon?.name || 'Empty')}</span><span class="slot-state">${pending ? '✓' : pokemon?.canBattle() ? 'CHOOSING' : 'FAINTED'}</span></button>`;
    }).join('');

    this.els.panel.innerHTML = `<div class="party-command-top"><div><span class="eyebrow">YOUR ACTIVE FIELD</span><h2>${this.escape(current?.name || 'Select a Pokémon')}</h2></div><span class="command-progress">${localPendingCount}/${localSlots.filter(s => s.pokemon?.canBattle()).length} actions</span></div><div class="party-active-tabs-inline">${tabs}</div><div class="polished-moves">${moves.map(m => `<button class="multi-move-button ${this.selectedMove?.id === m.id ? 'move-selected' : ''}" data-move="${this.escape(m.id)}" type="button"><strong class="move-name">${this.escape(m.name)}</strong><span class="move-meta">${this.escape((m.types || []).join('/'))} · ${this.escape(m.category || 'Move')}</span><span class="move-pp">PP ${m.pp ?? '—'}</span></button>`).join('')}</div>`;

    this.els.panel.querySelectorAll('[data-slot]').forEach(btn => btn.addEventListener('click', () => {
      this.selectedSlot = Number(btn.dataset.slot);
      this.selectedMove = null;
      this.selectedTarget = null;
      this.render();
    }));
    this.els.panel.querySelectorAll('[data-move]').forEach(btn => btn.addEventListener('click', () => this.selectMove(btn.dataset.move)));

    this.els.hint.classList.add('active');
    if (this.selectedMove) {
      this.els.hint.innerHTML = `<span class="hint-dot"></span><span><strong>${this.escape(this.selectedMove.name)}</strong> selected for <strong>${this.escape(current?.name || '')}</strong> — click a highlighted target.</span>`;
    } else {
      this.els.hint.innerHTML = `<span class="hint-dot"></span><span>Choose a move for <strong>${this.escape(current?.name || '')}</strong>, then click the target.</span>`;
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
    this.els.hint.innerHTML = `<span class="hint-dot"></span><span><strong>${this.escape(move.name)}</strong> selected — click a highlighted target.</span>`;
    this.refreshTargetHighlights();
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
      : this.battle.submitAction?.(this.selectedMove.id, memberId, Number(slot));
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
    this.els.log.innerHTML = lines.slice(-100).map(x => `<div class="log-line">${this.escape(x)}</div>`).join('');
    this.els.log.scrollTop = this.els.log.scrollHeight;
  }

  escape(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
}
