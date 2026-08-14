import { GAME_CONFIG, clampBattleSize, clampTeamSize } from "../config.js";
import { Battle } from './battle.js';

function makeMember(member, battleSize = 1) {
  return {
    id: String(member.id),
    name: member.name || `Trainer ${String(member.id).slice(0, 4)}`,
    team: Array.isArray(member.team) ? member.team : [],
    // One trainer can control N active Pokémon. `active` stores the team index
    // occupying each field slot; -1 means the slot is empty and will be filled
    // automatically at the start/end of a turn.
    active: Array.isArray(member.active)
      ? member.active.slice(0, battleSize).map(v => Number.isInteger(Number(v)) ? Number(v) : -1)
      : [],
    side: member.side === 'beta' ? 'beta' : 'alpha'
  };
}

function actionKey(memberId, slot) {
  return `${String(memberId)}:${Number(slot)}`;
}

/**
 * Cooperative team battle.
 *
 * battleSize = active Pokémon per trainer (1..3)
 * teamSize   = human trainers on each side (1..3)
 *
 * Therefore a 3v3 with 2 trainers/team has 6 active Pokémon per side, while
 * a 3v3 with 3 trainers/team can have 9 active Pokémon per side.
 */
export class PartyBattle extends Battle {
  constructor({ data, members, networkRole = null, localMemberId = null, coordinatorId = null, battleSize = 1, teamSize = null }) {
    const normalizedBattleSize = clampBattleSize(battleSize);
    const normalized = members.map(m => makeMember(m, normalizedBattleSize));
    const firstAlpha = normalized.find(m => m.side === 'alpha') || normalized[0];
    const firstBeta = normalized.find(m => m.side === 'beta') || normalized[1] || normalized[0];
    super({
      data,
      playerTeam: firstAlpha?.team || [],
      opponentTeam: firstBeta?.team || [],
      networkRole
    });

    this.isParty = true;
    this.teamSize = clampTeamSize(teamSize, Math.ceil(normalized.length / 2) || 1);
    this.partyMode = `${this.teamSize} trainers/team`;
    this.battleSize = normalizedBattleSize;
    this.members = normalized;
    this.memberMap = new Map(normalized.map(m => [m.id, m]));
    this.localMemberId = localMemberId || normalized[0]?.id || null;
    this.coordinatorId = coordinatorId || normalized[0]?.id || null;
    this.pendingPartyActions = new Map();
    this.busy = false;
    this.locked = false;
    this.over = false;
    this.result = null;
    this.log = [];
    this.turn = 1;
    this.turnContext = { damageTaken: new Map(), physicalDamageTaken: new Map(), moveFailed: new Map() };

    for (const member of this.members) {
      member.team = this.createTeam(member.team);
      member.active = this.initialActiveIndices(member);
      this.fillEmptyActiveSlots(member, false);
    }

    this.write(`Team battle ready — ${this.teamSize} trainers/team · ${this.battleSize} active Pokémon/trainer.`);
    for (const member of this.members) {
      for (let slot = 0; slot < this.battleSize; slot += 1) {
        const p = this.activeMember(member.id, slot);
        if (p) {
          this.triggerAbility(p, 'onBattleStart');
          this.write(`${member.name} sent out ${p.name}!`);
        }
      }
    }
  }

  initialActiveIndices(member) {
    const supplied = Array.isArray(member.active) ? member.active : [];
    const used = new Set();
    const result = [];
    for (let slot = 0; slot < this.battleSize; slot += 1) {
      const candidate = Number(supplied[slot]);
      if (Number.isInteger(candidate) && candidate >= 0 && candidate < member.team.length && !used.has(candidate) && member.team[candidate]?.canBattle()) {
        result.push(candidate);
        used.add(candidate);
      } else {
        result.push(-1);
      }
    }
    return result;
  }

  active(side) {
    const legacySide = side === 'player' ? this.player : this.opponent;
    if (!this.memberMap) return legacySide?.team?.[legacySide?.active] || null;
    const member = this.getMembersBySide(side === 'player' ? 'alpha' : 'beta')[0];
    return member ? this.activeMember(member.id, 0) : null;
  }

  activeMember(memberId, slot = 0) {
    const member = this.memberMap.get(String(memberId));
    if (!member) return null;
    const index = Number(member.active?.[Number(slot)]);
    return Number.isInteger(index) && index >= 0 ? member.team[index] || null : null;
  }

  getActiveSlots(memberId) {
    const member = this.getMember(memberId);
    if (!member) return [];
    return Array.from({ length: this.battleSize }, (_, slot) => ({
      slot,
      teamIndex: Number(member.active?.[slot] ?? -1),
      pokemon: this.activeMember(member.id, slot)
    }));
  }

  getActiveEntries(side) {
    const entries = [];
    for (const member of this.getMembersBySide(side)) {
      for (let slot = 0; slot < this.battleSize; slot += 1) {
        const pokemon = this.activeMember(member.id, slot);
        if (pokemon?.canBattle()) entries.push({ member, memberId: member.id, slot, pokemon });
      }
    }
    return entries;
  }

  getMember(memberId) {
    return this.memberMap.get(String(memberId));
  }

  getLocalMember() {
    return this.getMember(this.localMemberId);
  }

  getMembersBySide(side) {
    return this.members.filter(m => m.side === side);
  }

  getActiveMembers(side) {
    return this.getActiveEntries(side).map(entry => entry.pokemon);
  }

  getAvailableMovesForMember(memberId, slot = 0) {
    const pokemon = this.activeMember(memberId, slot);
    if (!pokemon?.canBattle()) return [];
    let moves = pokemon.moves.filter(m => {
      const forced = pokemon.volatile?.charging === m.id ||
        (pokemon.volatile?.outrageTurns > 0 && m.id === 'outrage') ||
        (pokemon.volatile?.uproarTurns > 0 && m.id === 'uproar');
      if ((m.pp ?? 1) <= 0 && !forced) return false;
      if (pokemon.volatile?.tauntTurns > 0 && m.category === 'status') return false;
      return true;
    });
    if (pokemon.volatile?.charging) moves = moves.filter(m => m.id === pokemon.volatile.charging);
    if (pokemon.volatile?.outrageTurns > 0) moves = moves.filter(m => m.id === 'outrage');
    if (pokemon.volatile?.uproarTurns > 0) moves = moves.filter(m => m.id === 'uproar');
    return moves;
  }

  getBenchOptions(memberId, sourceSlot = 0) {
    const member = this.getMember(memberId);
    if (!member) return [];
    const activeSet = new Set((member.active || []).map(i => Number(i)).filter(i => i >= 0));
    const current = Number(member.active?.[Number(sourceSlot)] ?? -1);
    const trapped = this.activeMember(member.id, Number(sourceSlot))?.volatile?.trapTurns > 0 ||
      this.getStatusDef(this.activeMember(member.id, Number(sourceSlot)))?.statusEffect?.switchBlock;
    if (trapped) return [];
    return member.team.map((pokemon, teamIndex) => ({ pokemon, teamIndex }))
      .filter(({ pokemon, teamIndex }) => teamIndex !== current && !activeSet.has(teamIndex) && pokemon?.canBattle())
      .map(({ pokemon, teamIndex }) => ({ teamIndex, pokemon }));
  }

  submitPartySwitch(memberId, sourceSlot, targetTeamIndex) {
    if (this.over || this.busy) return false;
    const member = this.getMember(memberId);
    const slot = Number(sourceSlot);
    const targetIndex = Number(targetTeamIndex);
    if (!member || slot < 0 || slot >= this.battleSize) return false;
    const current = this.activeMember(member.id, slot);
    const target = member.team[targetIndex];
    if (!current?.canBattle() || !target?.canBattle()) return false;
    if (member.active.some((idx, i) => i !== slot && Number(idx) === targetIndex)) return false;
    if (current.volatile?.trapTurns > 0 || this.getStatusDef(current)?.statusEffect?.switchBlock) return false;
    const key = actionKey(member.id, slot);
    if (this.pendingPartyActions.has(key)) return false;
    const action = { kind: 'switch', memberId: member.id, slot, switchTo: targetIndex, pokemonIndex: member.active[slot] };
    this.pendingPartyActions.set(key, action);
    if (member.id === this.localMemberId && this.networkRole !== 'coordinator') this.sendPartyAction?.(action);
    this.write(`${member.id === this.localMemberId ? 'You' : member.name} selected a switch for ${current.name}.`);
    this.update();
    if (this.allActiveMembersSubmitted()) this.tryResolvePartyActions();
    return true;
  }

  executePartySwitch(action) {
    const member = this.getMember(action.memberId);
    const slot = Number(action.slot);
    const targetIndex = Number(action.switchTo);
    if (!member || slot < 0 || slot >= this.battleSize) return false;
    const current = this.activeMember(member.id, slot);
    const target = member.team[targetIndex];
    if (!current?.canBattle() || !target?.canBattle()) return false;
    if (member.active.some((idx, i) => i !== slot && Number(idx) === targetIndex)) return false;
    this.resetOnSwitch(current);
    member.active[slot] = targetIndex;
    this.triggerAbility(target, 'onBattleStart');
    this.write(`${member.id === this.localMemberId ? 'Your' : `${member.name}'s`} ${current.name} switched out — go, ${target.name}!`);
    return true;
  }

  getTargetsFor(memberId, move = null, slot = 0) {
    const member = this.getMember(memberId);
    if (!member) return [];
    const selfMoves = new Set(['agility','bulk-up','dragon-cheer','endure','protect','rest','roost','substitute','swords-dance','sleep-talk','sunny-day','taunt','uproar']);
    if (selfMoves.has(move?.id)) {
      const self = this.activeMember(member.id, slot);
      return self?.canBattle() ? [{ memberId: member.id, slot, pokemon: self, label: `${member.name} · ${self.name} · Slot ${slot + 1}` }] : [];
    }
    if (move?.id === 'helping-hand') {
      return this.getActiveEntries(member.side)
        .filter(entry => entry.memberId !== member.id)
        .map(entry => ({ memberId: entry.memberId, slot: entry.slot, pokemon: entry.pokemon, label: `${entry.member.name} · ${entry.pokemon.name}` }));
    }
    const enemySide = member.side === 'alpha' ? 'beta' : 'alpha';
    return this.getActiveEntries(enemySide).map(entry => ({
      memberId: entry.memberId,
      slot: entry.slot,
      pokemon: entry.pokemon,
      label: `${entry.member.name} · ${entry.pokemon.name}`
    }));
  }

  setLocalAction(moveId, targetMemberId, targetSlot = 0, sourceSlot = null) {
    const slot = sourceSlot == null ? this.nextLocalUnsubmittedSlot() : Number(sourceSlot);
    return this.submitPartyAction(this.localMemberId, slot, moveId, targetMemberId, targetSlot);
  }

  nextLocalUnsubmittedSlot() {
    const member = this.getLocalMember();
    if (!member) return 0;
    for (let slot = 0; slot < this.battleSize; slot += 1) {
      const p = this.activeMember(member.id, slot);
      if (p?.canBattle() && !this.pendingPartyActions.has(actionKey(member.id, slot))) return slot;
    }
    return 0;
  }

  submitPartyAction(memberId, sourceSlot, moveId, targetMemberId, targetSlot = 0) {
    if (this.over || this.busy) return false;
    const member = this.getMember(memberId);
    const slot = Number(sourceSlot);
    if (!member || slot < 0 || slot >= this.battleSize) return false;
    const pokemon = this.activeMember(member.id, slot);
    const move = pokemon?.moves?.find(m => m.id === moveId);
    const targetMember = this.getMember(targetMemberId);
    const target = this.activeMember(targetMemberId, targetSlot);
    const selfMoves = new Set(['agility','bulk-up','dragon-cheer','endure','protect','rest','roost','substitute','swords-dance','sleep-talk','sunny-day','taunt','uproar']);
    const allyTarget = move?.id === 'helping-hand';
    const validSameSide = targetMember?.side === member.side && (selfMoves.has(move?.id) || allyTarget);
    const validEnemy = targetMember?.side !== member.side;
    if (!pokemon?.canBattle() || !move || !targetMember || !target?.canBattle() || (!validSameSide && !validEnemy)) return false;
    if (!this.canSelectMove(pokemon, move)) return false;

    const key = actionKey(member.id, slot);
    if (this.pendingPartyActions.has(key)) return false;
    const action = { memberId: member.id, slot, pokemonIndex: member.active[slot], moveId, targetMemberId: targetMember.id, targetSlot: Number(targetSlot) };
    this.pendingPartyActions.set(key, action);
    if (member.id === this.localMemberId && this.networkRole !== 'coordinator') this.sendPartyAction?.(action);
    this.update();
    if (this.allActiveMembersSubmitted()) this.tryResolvePartyActions();
    return true;
  }

  receiveRemotePartyAction(action) {
    if (this.networkRole !== 'coordinator' || this.over || !action?.memberId) return;
    const member = this.getMember(action.memberId);
    const slot = Number(action.slot ?? 0);
    if (!member || slot < 0 || slot >= this.battleSize) return;
    const key = actionKey(member.id, slot);
    if (this.pendingPartyActions.has(key)) return;

    if (action.kind === 'switch') {
      const current = this.activeMember(member.id, slot);
      const targetIndex = Number(action.switchTo);
      const target = member.team[targetIndex];
      if (!current?.canBattle() || !target?.canBattle() || member.active.some((idx, i) => i !== slot && Number(idx) === targetIndex)) return;
      if (current.volatile?.trapTurns > 0 || this.getStatusDef(current)?.statusEffect?.switchBlock) return;
      this.pendingPartyActions.set(key, { kind: 'switch', memberId: member.id, slot, pokemonIndex: member.active[slot], switchTo: targetIndex });
      this.write(`${member.name} locked in a switch (${slot + 1}/${this.battleSize}).`);
      this.updateNetworkState?.();
      if (this.allActiveMembersSubmitted()) this.tryResolvePartyActions();
      return;
    }

    const pokemon = this.activeMember(member.id, slot);
    const move = pokemon?.moves?.find(m => m.id === action.moveId);
    const targetMember = this.getMember(action.targetMemberId);
    const target = this.activeMember(action.targetMemberId, Number(action.targetSlot ?? 0));
    if (!pokemon?.canBattle() || !move || !target?.canBattle() || !targetMember || !this.isTargetAllowed(member, move, targetMember, Number(action.targetSlot ?? 0), slot)) return;
    if (!this.canSelectMove(pokemon, move)) return;
    this.pendingPartyActions.set(key, {
      kind: 'move',
      memberId: member.id,
      slot,
      pokemonIndex: member.active[slot],
      moveId: action.moveId,
      targetMemberId: targetMember.id,
      targetSlot: Number(action.targetSlot ?? 0)
    });
    this.write(`${member.name} locked in ${pokemon.name}'s action (${slot + 1}/${this.battleSize}).`);
    this.updateNetworkState?.();
    if (this.allActiveMembersSubmitted()) this.tryResolvePartyActions();
  }

  isTargetAllowed(member, move, targetMember, targetSlot, sourceSlot = 0) {
    const selfMoves = new Set(['agility','bulk-up','dragon-cheer','endure','protect','rest','roost','substitute','swords-dance','sleep-talk','sunny-day','taunt','uproar']);
    if (targetMember?.side === member.side && !selfMoves.has(move?.id) && move?.id !== 'helping-hand') return false;
    return this.getTargetsFor(member.id, move, sourceSlot).some(t => t.memberId === targetMember?.id && t.slot === Number(targetSlot));
  }

  allActiveMembersSubmitted() {
    for (const member of this.members) {
      for (let slot = 0; slot < this.battleSize; slot += 1) {
        const active = this.activeMember(member.id, slot);
        if (active?.canBattle() && !this.pendingPartyActions.has(actionKey(member.id, slot))) return false;
      }
    }
    return true;
  }

  async tryResolvePartyActions() {
    if (this.networkRole !== 'coordinator' || this.busy || this.over || !this.allActiveMembersSubmitted()) return;
    const actions = [...this.pendingPartyActions.values()];
    this.pendingPartyActions.clear();
    this.busy = true;
    this.locked = true;
    this.updateNetworkState?.();

    actions.sort((a, b) => {
      // Switching resolves before normal moves.
      const aSwitch = a.kind === 'switch' ? 6 : 0;
      const bSwitch = b.kind === 'switch' ? 6 : 0;
      if (aSwitch !== bSwitch) return bSwitch - aSwitch;
      const am = this.activeMember(a.memberId, a.slot);
      const bm = this.activeMember(b.memberId, b.slot);
      const aMove = am?.moves.find(m => m.id === a.moveId);
      const bMove = bm?.moves.find(m => m.id === b.moveId);
      const pa = a.kind === 'switch' ? 6 : this.getMovePriority(aMove, am);
      const pb = b.kind === 'switch' ? 6 : this.getMovePriority(bMove, bm);
      if (pa !== pb) return pb - pa;
      const sa = this.getStat(am, 'speed');
      const sb = this.getStat(bm, 'speed');
      if (sa !== sb) return sb - sa;
      return Math.random() - 0.5;
    });

    this.write('All trainers have chosen — resolving the turn...');
    for (const action of actions) {
      if (action.kind === 'switch') {
        this.executePartySwitch(action);
        continue;
      }
      const attacker = this.activeMember(action.memberId, action.slot);
      const target = this.activeMember(action.targetMemberId, action.targetSlot);
      const move = attacker?.moves?.find(m => m.id === action.moveId);
      if (!attacker?.canBattle() || !target?.canBattle() || !move) continue;
      await this.performMove(attacker, target, move);
    }

    this.autoReplaceFainted();
    const alphaAlive = this.sideHasAnyUsable('alpha');
    const betaAlive = this.sideHasAnyUsable('beta');
    if (!alphaAlive || !betaAlive) {
      this.finishPartyBattle(alphaAlive && !betaAlive ? 'alpha' : 'beta');
      return;
    }

    this.applyPartyEndTurn();
    this.autoReplaceFainted();
    this.busy = false;
    this.locked = false;
    this.pendingPartyActions.clear();
    this.turnContext = { damageTaken: new Map(), physicalDamageTaken: new Map(), moveFailed: new Map() };
    this.turn += 1;
    this.updateNetworkState?.();
    this.update();
  }

  sideHasAnyUsable(side) {
    return this.getMembersBySide(side).some(member => member.team.some(p => p.canBattle()));
  }

  fillEmptyActiveSlots(member, announce = true) {
    const used = new Set(member.active.filter(i => Number.isInteger(i) && i >= 0));
    for (let slot = 0; slot < this.battleSize; slot += 1) {
      const current = this.activeMember(member.id, slot);
      if (current?.canBattle()) continue;
      if (current) this.resetOnSwitch(current);
      let next = member.team.findIndex((p, index) => p.canBattle() && !used.has(index));
      if (next < 0) {
        member.active[slot] = -1;
        continue;
      }
      used.add(next);
      member.active[slot] = next;
      const replacement = this.activeMember(member.id, slot);
      this.triggerAbility(replacement, 'onBattleStart');
      if (announce) this.write(`${member.name} sent out ${replacement.name}!`);
    }
  }

  autoReplaceFainted() {
    for (const member of this.members) this.fillEmptyActiveSlots(member, true);
  }

  applyPartyEndTurn() {
    for (const member of this.members) {
      for (let slot = 0; slot < this.battleSize; slot += 1) {
        const p = this.activeMember(member.id, slot);
        if (!p?.canBattle()) continue;
        if (p.status) {
          const def = this.getStatusDef(p);
          const amount = Number(def?.statusEffect?.endTurnDamage ?? 0);
          if (amount > 0) {
            p.receiveDamage(Math.max(1, Math.floor(p.maxHP * amount)));
            this.write(`${p.name} was hurt by ${p.status}!`);
          }
        }
        if (p.volatile?.tauntTurns > 0) p.volatile.tauntTurns -= 1;
        if (p.volatile?.trapTurns > 0) p.volatile.trapTurns -= 1;
        p.volatile.protected = false;
        p.volatile.endure = false;
        p.volatile.flinched = false;
        p.volatile.lastDamageTaken = 0;
        if (p.volatile.roosted) {
          p.types = [...(p.originalTypes || p.types)];
          p.volatile.roosted = false;
        }
      }
    }

    if (this.fieldTurns > 0) {
      this.fieldTurns -= 1;
      if (this.fieldTurns <= 0) {
        this.field = null;
        this.write('The battlefield returned to normal.');
      }
    }
  }

  getBattleMessagePrefix(pokemon) {
    const owner = this.members.find(m => this.getActiveSlots(m.id).some(s => s.pokemon === pokemon));
    if (!owner) return 'Pokémon';
    return owner.id === this.localMemberId ? 'Your Pokémon' : `${owner.name}'s Pokémon`;
  }

  finishPartyBattle(winnerSide) {
    this.over = true;
    const winnerIds = this.getMembersBySide(winnerSide).map(m => m.id);
    this.result = {
      winnerSide,
      winnerIds,
      localWon: winnerIds.includes(this.localMemberId)
    };
    this.write(winnerIds.includes(this.localMemberId) ? 'Your team won the battle!' : 'Your team lost the battle!');
    this.busy = false;
    this.locked = false;
    this.updateNetworkState?.();
    this.update();
  }
}
