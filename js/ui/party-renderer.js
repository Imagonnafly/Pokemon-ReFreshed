export class PartyRenderer {
  constructor({ root, battle }) {
    this.root = root;
    this.battle = battle;
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
  }

  bind() {
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
    if (this.els.turn) this.els.turn.textContent = `Turn ${this.battle.turn} · 2v2`;
    if (this.els.field) this.els.field.textContent = this.battle.field ? `${this.battle.field}${this.battle.fieldTurns ? ` · ${this.battle.fieldTurns}T` : ''}` : 'No Field';
  }

  renderSide(side, container) {
    if (!container) return;
    container.innerHTML = '';
    const members = this.battle.getMembersBySide(side);
    for (const member of members) {
      const p = this.battle.activeMember(member.id);
      const isLocal = member.id === this.battle.localMemberId;
      const pending = this.battle.pendingPartyActions?.has(member.id) || this.battle.pendingIds?.has(member.id);
      const card = document.createElement('article');
      card.className = `party-pokemon-card ${isLocal ? 'party-local' : ''} ${pending ? 'party-locked' : ''} ${p?.canBattle() ? '' : 'fainted'}`;
      card.innerHTML = p ? `<div class="party-trainer-badge"><span>${this.escape(member.name)}</span><em>${isLocal ? 'YOU' : 'ALLY'}</em></div><img src="${this.escape(p.sprites?.[side === 'alpha' ? 'back' : 'front'] || '')}" alt=""><div class="party-pokemon-info"><strong>${this.escape(p.name)}</strong><div class="party-types">${(p.types || []).map(t => `<span>${this.escape(t)}</span>`).join('')}</div><div class="hp-row"><div class="hpbar"><div style="width:${Math.max(0, Math.min(100, (p.hp / p.maxHP) * 100))}%"></div></div><span class="hp-text">${Math.max(0,p.hp)}/${p.maxHP}</span></div></div>${pending ? '<div class="party-ready-mark">✓ READY</div>' : ''}` : '<div class="party-empty">No active Pokémon</div>';
      container.appendChild(card);
    }
  }

  renderPanel() {
    if (!this.els.panel) return;
    const local = this.battle.getLocalMember?.();
    const p = local ? this.battle.activeMember(local.id) : null;
    if (!local || !p?.canBattle()) {
      this.els.panel.innerHTML = `<div class="multi-finish-panel"><strong>${this.battle.over ? (this.battle.result?.localWon ? 'Victory!' : 'Defeat') : 'Waiting for replacement…'}</strong><span>${this.battle.over ? 'The team battle has ended.' : 'Your active Pokémon has fainted.'}</span></div>`;
      return;
    }
    const submitted = this.battle.pendingPartyActions?.has(local.id) || this.battle.pendingIds?.has(local.id);
    const moves = this.battle.getAvailableMovesForMember(local.id) || [];
    if (this.battle.over) {
      this.els.panel.innerHTML = `<div class="multi-finish-panel"><strong>${this.battle.result?.localWon ? 'Your team won!' : 'Your team lost!'}</strong><span>${this.battle.result?.localWon ? 'Your party held the field.' : 'The opposing party prevailed.'}</span></div>`;
      return;
    }
    if (submitted) {
      this.els.panel.innerHTML = `<div class="party-waiting-panel"><div class="party-spinner"></div><strong>Your action is locked in.</strong><span>Waiting for your teammate and the opposing trainers.</span></div>`;
      this.els.hint.classList.remove('active');
      this.els.hint.innerHTML = '<span class="hint-dot"></span><span>Your action is locked in — your teammate is choosing.</span>';
      return;
    }
    this.els.hint.classList.add('active');
    this.els.hint.innerHTML = `<span class="hint-dot"></span><span>Choose a move for <strong>${this.escape(p.name)}</strong>, then click the target.</span>`;
    this.els.panel.innerHTML = `<div class="multi-command-header"><div><span class="eyebrow">YOUR TURN</span><h2>${this.escape(p.name)} <span class="party-controller-label">· ${this.escape(local.name)}</span></h2></div><span class="command-progress">1 action</span></div><div class="polished-moves">${moves.map(m => `<button class="multi-move-button" data-move="${this.escape(m.id)}" type="button"><strong class="move-name">${this.escape(m.name)}</strong><span class="move-meta">${this.escape((m.types || []).join('/'))} · ${this.escape(m.category || 'Move')}</span><span class="move-pp">PP ${m.pp ?? '—'}</span></button>`).join('')}</div>`;
    this.els.panel.querySelectorAll('[data-move]').forEach(btn => btn.addEventListener('click', () => this.selectMove(btn.dataset.move)));
  }

  selectMove(moveId) {
    const local = this.battle.getLocalMember?.();
    const p = local ? this.battle.activeMember(local.id) : null;
    const move = p?.moves?.find(m => m.id === moveId);
    if (!move) return;
    this.selectedMove = move;
    this.selectedTarget = null;
    const targets = this.battle.getTargetsFor(local.id, move);
    this.els.hint.innerHTML = `<span class="hint-dot"></span><span><strong>${this.escape(move.name)}</strong> selected — click a target.</span>`;
    this.els.panel.querySelectorAll('[data-move]').forEach(b => b.classList.toggle('move-selected', b.dataset.move === moveId));
    this.els.enemyRow.querySelectorAll('.party-pokemon-card').forEach((card, index) => {
      const member = this.battle.getMembersBySide('beta')[index];
      if (targets.some(t => t.memberId === member?.id)) card.classList.add('party-targetable');
    });
    this.els.allyRow.querySelectorAll('.party-pokemon-card').forEach((card, index) => {
      const member = this.battle.getMembersBySide('alpha')[index];
      if (targets.some(t => t.memberId === member?.id)) card.classList.add('party-targetable');
    });
  }

  targetMember(memberId) {
    if (!this.selectedMove) return;
    const local = this.battle.getLocalMember();
    const allowed = this.battle.getTargetsFor(local.id, this.selectedMove).some(t => t.memberId === memberId);
    if (!allowed) return;
    const ok = this.battle.submitAction
      ? this.battle.submitAction(this.selectedMove.id, memberId)
      : this.battle.setLocalAction?.(this.selectedMove.id, memberId);
    if (ok) {
      this.selectedMove = null;
      this.selectedTarget = null;
      this.render();
    }
  }

  renderLog() {
    if (!this.els.log) return;
    const lines = Array.isArray(this.battle.log) ? this.battle.log : [];
    this.els.log.innerHTML = lines.slice(-80).map(x => `<div class="log-line">${this.escape(x)}</div>`).join('');
    this.els.log.scrollTop = this.els.log.scrollHeight;
  }

  escape(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
}

document.addEventListener('click', event => {
  const card = event.target.closest('.party-pokemon-card');
  if (!card) return;
  const root = document.querySelector('.party-battle-page');
  if (!root) return;
  const battle = window.__partyBattle;
  if (!battle || !battle.getMember) return;
  const row = card.parentElement;
  const side = row?.classList.contains('party-enemy-row') ? 'beta' : 'alpha';
  const members = battle.getMembersBySide(side);
  const member = members[Array.from(row.children).indexOf(card)];
  if (member) window.__partyRenderer?.targetMember?.(member.id);
});
