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

  esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }

  isPending(memberId, slot) {
    const key = `${memberId}:${slot}`;
    return this.battle.pendingPartyActions?.has(key) || this.battle.pendingIds?.has(key);
  }

  hpBar(p) {
    const max = Math.max(1, Number(p?.maxHP ?? p?.hp ?? 1));
    const hp = Math.max(0, Number(p?.hp ?? 0));
    const pct = Math.max(0, Math.min(100, hp / max * 100));
    const tone = pct <= 25 ? 'danger' : pct <= 50 ? 'warn' : 'ok';
    return `<div class="sd-hp"><div class="sd-hp-track"><div class="sd-hp-fill ${tone}" style="width:${pct}%"></div></div><span>${hp}/${max}</span></div>`;
  }

  sprite(p, side) { return side === 'alpha' ? (p?.sprites?.back || p?.sprites?.front || '') : (p?.sprites?.front || p?.sprites?.back || ''); }

  render() {
    this.renderHeader();
    this.renderSide('beta', this.els.enemyRow);
    this.renderSide('alpha', this.els.allyRow);
    this.renderPanel();
    this.renderLog();
  }

  renderHeader() {
    const totalActive = (Number(this.battle.battleSize) || 1) * (Number(this.battle.teamSize) || 1);
    if (this.els.turn) this.els.turn.textContent = `Turn ${this.battle.turn} · ${totalActive} active/side`;
    if (this.els.field) this.els.field.textContent = this.battle.field ? `${this.battle.field}${this.battle.fieldTurns ? ` · ${this.battle.fieldTurns}T` : ''}` : 'No Field';
  }

  renderSide(side, container) {
    if (!container) return;
    const members = this.battle.getMembersBySide(side);
    container.innerHTML = members.map(member => {
      const slots = Array.from({ length: this.battle.battleSize }, (_, slot) => {
        const p = this.battle.activeMember(member.id, slot);
        if (!p) return `<div class="sd-party-slot is-empty"><span>${slot + 1}</span></div>`;
        const local = member.id === this.battle.localMemberId;
        const pending = this.isPending(member.id, slot);
        const selected = local && slot === this.selectedSlot && p.canBattle();
        const target = this.selectedMove && this.battle.getTargetsFor?.(this.battle.localMemberId, this.selectedMove, this.selectedSlot)?.some(t => t.memberId === member.id && Number(t.slot) === slot);
        const faint = !p.canBattle();
        const cls = ['sd-party-unit', selected ? 'is-selected' : '', pending ? 'is-locked' : '', target ? 'is-targetable' : '', faint ? 'is-fainted' : ''].filter(Boolean).join(' ');
        const status = p.status ? `<span class="sd-status">${this.esc(String(p.status).replace(/-/g,' '))}</span>` : '';
        return `<button type="button" class="${cls}" data-member-id="${this.esc(member.id)}" data-slot="${slot}">
          <div class="sd-unit-hud"><div class="sd-name-row"><strong>${this.esc(p.name)}</strong><span>Lv.${p.level ?? 50}</span></div>${this.hpBar(p)}<div class="sd-meta-row">${(p.types || []).map(t => `<span class="sd-chip">${this.esc(t)}</span>`).join('')}${status}</div></div>
          <div class="sd-sprite-stage"><span class="sd-shadow"></span><img class="sd-field-sprite" src="${this.esc(this.sprite(p, side))}" alt="" draggable="false"></div>
          <span class="sd-slot-badge">${slot + 1}</span>${pending ? '<span class="sd-ready-mark">✓</span>' : ''}
        </button>`;
      });
      return `<section class="sd-member-block"><div class="sd-member-label"><strong>${this.esc(member.name || 'Trainer')}</strong><span>${member.id === this.battle.localMemberId ? 'YOU' : (member.side === side ? 'ALLY' : 'OPPONENT')}</span></div><div class="sd-party-grid">${slots.join('')}</div></section>`;
    }).join('');
    container.querySelectorAll('.sd-party-unit').forEach(btn => btn.addEventListener('click', () => this.handleFieldClick(btn)));
  }

  handleFieldClick(btn) {
    const memberId = btn.dataset.memberId;
    const slot = Number(btn.dataset.slot);
    const local = this.battle.getLocalMember?.();
    if (!local) return;
    if (this.selectedMove) {
      this.targetMember(memberId, slot);
      return;
    }
    if (memberId === local.id && this.battle.activeMember(memberId, slot)?.canBattle()) {
      this.selectedSlot = slot;
      this.selectedMove = null;
      this.selectedTarget = null;
      this.render();
    }
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
    const local = this.battle.getLocalMember?.();
    if (!local || !this.els.panel) return;
    const activeSlots = Array.from({length: this.battle.battleSize}, (_, slot) => ({slot, pokemon:this.battle.activeMember(local.id, slot)}));
    const aliveCount = activeSlots.filter(s => s.pokemon?.canBattle()).length;
    const pendingCount = activeSlots.filter(s => this.isPending(local.id, s.slot)).length;
    if (!activeSlots.some(s => s.pokemon?.canBattle())) {
      this.els.panel.innerHTML = `<div class="sd-waiting">Waiting for your field to update…</div>`;
      return;
    }
    if (!activeSlots[this.selectedSlot]?.pokemon?.canBattle() || this.isPending(local.id, this.selectedSlot)) this.selectedSlot = this.firstUnsubmittedSlot();
    if (pendingCount >= aliveCount) {
      this.els.panel.innerHTML = `<div class="sd-waiting"><strong>All of your actions are locked in.</strong><span>Waiting for the other trainers…</span></div>`;
      if (this.els.hint) this.els.hint.innerHTML = '<span class="hint-dot"></span><span>All of your active Pokémon have chosen.</span>';
      return;
    }
    const current = activeSlots[this.selectedSlot].pokemon;
    const moves = this.battle.getAvailableMovesForMember(local.id, this.selectedSlot) || [];
    const bench = this.battle.getBenchOptions?.(local.id, this.selectedSlot) || [];
    const switchAllowed = this.canSwitchFromCurrent(current) && bench.length && !this.isPending(local.id, this.selectedSlot);
    const movesHTML = moves.map(m => `<button type="button" class="sd-move ${this.selectedMove?.id === m.id ? 'is-selected' : ''}" data-move="${this.esc(m.id)}"><span class="sd-move-name">${this.esc(m.name)}</span><span class="sd-move-meta">${this.esc((m.types||[]).join('/'))} · ${this.esc(m.category||'Move')}</span><span class="sd-move-pp">${m.pp ?? '—'} PP</span></button>`).join('');
    const switches = switchAllowed ? bench.map(({pokemon,teamIndex}) => `<button type="button" class="sd-switch" data-switch-index="${teamIndex}"><img src="${this.esc(pokemon.sprites?.front||'')}" alt=""><span>${this.esc(pokemon.name)}</span><small>${pokemon.hp}/${pokemon.maxHP ?? pokemon.hp}</small></button>`).join('') : '<span class="sd-empty-text">No healthy bench Pokémon available.</span>';
    this.els.panel.innerHTML = `<div class="sd-command-head"><div><span class="sd-eyebrow">WHAT WILL ${this.esc(current?.name || 'POKÉMON').toUpperCase()} DO?</span><h2>${this.esc(current?.name || '')}</h2></div><div class="sd-ready">${pendingCount}/${aliveCount} ready</div></div><div class="sd-command-body"><div class="sd-move-grid">${movesHTML}</div><div class="sd-switch-block"><div class="sd-section-title">Switch</div><div class="sd-switch-grid">${switches}</div></div></div>`;
    this.els.panel.querySelectorAll('[data-move]').forEach(b => b.addEventListener('click', () => this.selectMove(b.dataset.move)));
    this.els.panel.querySelectorAll('[data-switch-index]').forEach(b => b.addEventListener('click', () => this.selectSwitch(Number(b.dataset.switchIndex))));
    if (this.els.hint) this.els.hint.innerHTML = `<span class="hint-dot"></span><span>${this.selectedMove ? `Click a highlighted target for <strong>${this.esc(this.selectedMove.name)}</strong>.` : 'Click one of your active Pokémon to command it, then choose a move or switch.'}</span>`;
  }

  selectMove(moveId) {
    const local = this.battle.getLocalMember?.();
    const p = local ? this.battle.activeMember(local.id, this.selectedSlot) : null;
    const move = p?.moves?.find(m => m.id === moveId);
    if (!move) return;
    this.selectedMove = move;
    this.selectedTarget = null;
    this.render();
  }

  selectSwitch(teamIndex) {
    const local = this.battle.getLocalMember?.();
    if (!local) return;
    const current = this.battle.activeMember(local.id, this.selectedSlot);
    if (!this.canSwitchFromCurrent(current) || !this.battle.submitPartySwitch) return;
    if (this.battle.submitPartySwitch(local.id, this.selectedSlot, Number(teamIndex))) {
      this.selectedMove = null;
      this.selectedSlot = this.firstUnsubmittedSlot();
      this.render();
    }
  }

  targetMember(memberId, slot) {
    if (!this.selectedMove) return;
    const local = this.battle.getLocalMember?.();
    if (!local) return;
    const allowed = this.battle.getTargetsFor?.(local.id, this.selectedMove, this.selectedSlot)?.some(t => t.memberId === memberId && Number(t.slot) === Number(slot));
    if (!allowed) return;
    if (this.battle.submitPartyAction?.(local.id, this.selectedSlot, this.selectedMove.id, memberId, Number(slot))) {
      this.selectedMove = null;
      this.selectedTarget = null;
      this.selectedSlot = this.firstUnsubmittedSlot();
      this.render();
    }
  }

  renderLog() {
    if (!this.els.log) return;
    const lines = Array.isArray(this.battle.log) ? this.battle.log : [];
    this.els.log.innerHTML = lines.slice(-80).map(x => `<div class="sd-log-entry">${this.esc(x)}</div>`).join('') || '<div class="sd-empty-text">Battle log will appear here.</div>';
    this.els.log.scrollTop = this.els.log.scrollHeight;
  }
}
