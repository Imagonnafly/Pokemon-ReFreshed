import { Battle } from './battle.js';

function makeMember(member) {
  return {
    id: String(member.id),
    name: member.name || `Trainer ${String(member.id).slice(0, 4)}`,
    team: Array.isArray(member.team) ? member.team : [],
    active: 0,
    side: member.side === 'beta' ? 'beta' : 'alpha'
  };
}

/**
 * Cooperative 2v2 party battle.
 * Four human players are split into two sides. Each human controls one active
 * Pokémon at a time and can use a personal team of up to 10 Pokémon.
 */
export class PartyBattle extends Battle {
  constructor({ data, members, networkRole = null, localMemberId = null, coordinatorId = null }) {
    const normalized = members.map(makeMember);
    const firstAlpha = normalized.find(m => m.side === 'alpha') || normalized[0];
    const firstBeta = normalized.find(m => m.side === 'beta') || normalized[1] || normalized[0];
    super({
      data,
      playerTeam: firstAlpha?.team || [],
      opponentTeam: firstBeta?.team || [],
      networkRole
    });
    this.isParty = true;
    this.partyMode = '2v2';
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

    // Replace the two superclass sides with per-trainer teams while keeping
    // the Battle engine's move/effect implementation available.
    for (const member of this.members) {
      member.team = this.createTeam(member.team);
      member.active = 0;
    }
    this.write('Team battle ready — 2 trainers vs 2 trainers!');
    for (const member of this.members) {
      const p = this.activeMember(member.id);
      if (p) {
        this.triggerAbility(p, 'onBattleStart');
        this.write(`${member.name} sent out ${p.name}!`);
      }
    }
  }

  active(side) {
    if (!this.memberMap) {
      const legacySide = side === 'player' ? this.player : this.opponent;
      return legacySide?.team?.[legacySide?.active] || null;
    }
    if (side === 'player') return this.activeMember(this.members.find(m => m.side === 'alpha')?.id);
    return this.activeMember(this.members.find(m => m.side === 'beta')?.id);
  }

  activeMember(memberId) {
    const member = this.memberMap.get(String(memberId));
    return member?.team?.[member.active] || null;
  }

  getMember(memberId) {
    return this.memberMap.get(String(memberId));
  }

  getMembersBySide(side) {
    return this.members.filter(m => m.side === side);
  }

  getActiveMembers(side) {
    return this.getMembersBySide(side).filter(m => this.activeMember(m.id)?.canBattle());
  }

  getAvailableMovesForMember(memberId) {
    const pokemon = this.activeMember(memberId);
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

  getTargetsFor(memberId, move = null) {
    const member = this.getMember(memberId);
    if (!member) return [];
    const selfMoves = new Set(['agility','bulk-up','dragon-cheer','endure','protect','rest','roost','substitute','swords-dance','sleep-talk','sunny-day','taunt','uproar']);
    if (selfMoves.has(move?.id)) {
      return [{ memberId: member.id, pokemon: this.activeMember(member.id), label: `${member.name} · self` }].filter(x => x.pokemon?.canBattle());
    }
    if (move?.id === 'helping-hand') {
      return this.getMembersBySide(member.side).filter(m => m.id !== member.id).map(targetMember => ({ memberId: targetMember.id, pokemon: this.activeMember(targetMember.id), label: `${targetMember.name} · ${this.activeMember(targetMember.id)?.name || '---'}` })).filter(x => x.pokemon?.canBattle());
    }
    const enemySide = member.side === 'alpha' ? 'beta' : 'alpha';
    return this.getActiveMembers(enemySide).map(targetMember => ({
      memberId: targetMember.id,
      pokemon: this.activeMember(targetMember.id),
      label: `${targetMember.name} · ${this.activeMember(targetMember.id)?.name || '---'}`
    }));
  }

  setLocalAction(moveId, targetMemberId) {
    return this.submitPartyAction(this.localMemberId, moveId, targetMemberId);
  }

  submitPartyAction(memberId, moveId, targetMemberId) {
    if (this.over || this.busy) return false;
    const member = this.getMember(memberId);
    if (!member) return false;
    const pokemon = this.activeMember(member.id);
    const move = pokemon?.moves?.find(m => m.id === moveId);
    const targetMember = this.getMember(targetMemberId);
    const target = this.activeMember(targetMemberId);
    const selfMoves = new Set(['agility','bulk-up','dragon-cheer','endure','protect','rest','roost','substitute','swords-dance','sleep-talk','sunny-day','taunt','uproar']);
    const allyTarget = move?.id === 'helping-hand';
    const validSameSide = targetMember?.side === member.side && (selfMoves.has(move?.id) || allyTarget);
    const validEnemy = targetMember?.side !== member.side;
    if (!pokemon?.canBattle() || !move || !targetMember || !target?.canBattle() || (!validSameSide && !validEnemy)) return false;
    if (!this.canSelectMove(pokemon, move)) return false;

    const action = { memberId: member.id, pokemonIndex: member.active, moveId, targetMemberId };
    this.pendingPartyActions.set(member.id, action);
    if (member.id === this.localMemberId && this.networkRole !== 'coordinator') {
      this.sendPartyAction?.(action);
    }
    this.update();
    if (this.allActiveMembersSubmitted()) this.tryResolvePartyActions();
    return true;
  }

  receiveRemotePartyAction(action) {
    if (this.networkRole !== 'coordinator' || this.over) return;
    if (!action?.memberId) return;
    const member = this.getMember(action.memberId);
    if (!member) return;
    const pokemon = this.activeMember(member.id);
    const move = pokemon?.moves?.find(m => m.id === action.moveId);
    const target = this.activeMember(action.targetMemberId);
    const targetMember = this.getMember(action.targetMemberId);
    if (!pokemon?.canBattle() || !move || !target?.canBattle() || !targetMember || targetMember.side === member.side) return;
    if (!this.canSelectMove(pokemon, move)) return;
    this.pendingPartyActions.set(member.id, {
      memberId: member.id,
      pokemonIndex: member.active,
      moveId: action.moveId,
      targetMemberId: targetMember.id
    });
    this.write(`${member.name} locked in their move.`);
    this.updateNetworkState?.();
    if (this.allActiveMembersSubmitted()) this.tryResolvePartyActions();
  }

  allActiveMembersSubmitted() {
    return this.members.every(member => {
      const active = this.activeMember(member.id);
      return !active?.canBattle() || this.pendingPartyActions.has(member.id);
    });
  }

  async tryResolvePartyActions() {
    if (this.networkRole !== 'coordinator' || this.busy || this.over || !this.allActiveMembersSubmitted()) return;
    const actions = [...this.pendingPartyActions.values()];
    this.pendingPartyActions.clear();
    this.busy = true;
    this.locked = true;
    this.updateNetworkState?.();
    actions.sort((a, b) => {
      const am = this.activeMember(a.memberId);
      const bm = this.activeMember(b.memberId);
      const aMove = am?.moves.find(m => m.id === a.moveId);
      const bMove = bm?.moves.find(m => m.id === b.moveId);
      const pa = this.getMovePriority(aMove, am);
      const pb = this.getMovePriority(bMove, bm);
      if (pa !== pb) return pb - pa;
      const sa = this.getStat(am, 'speed');
      const sb = this.getStat(bm, 'speed');
      if (sa !== sb) return sb - sa;
      return Math.random() - 0.5;
    });

    this.write('All trainers have chosen — resolving the turn...');
    for (const action of actions) {
      const attacker = this.activeMember(action.memberId);
      const targetMember = this.getMember(action.targetMemberId);
      const defender = this.activeMember(targetMember?.id);
      const move = attacker?.moves?.find(m => m.id === action.moveId);
      if (!attacker?.canBattle() || !defender?.canBattle() || !move) continue;
      await this.performMove(attacker, defender, move);
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

  autoReplaceFainted() {
    for (const member of this.members) {
      const current = this.activeMember(member.id);
      if (current?.canBattle()) continue;
      if (current) this.resetOnSwitch(current);
      const next = member.team.findIndex(p => p.canBattle());
      if (next < 0) continue;
      member.active = next;
      const replacement = this.activeMember(member.id);
      this.triggerAbility(replacement, 'onBattleStart');
      this.write(`${member.name} sent out ${replacement.name}!`);
    }
  }

  applyPartyEndTurn() {
    for (const member of this.members) {
      const p = this.activeMember(member.id);
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

    if (this.fieldTurns > 0) {
      this.fieldTurns -= 1;
      if (this.fieldTurns <= 0) {
        this.field = null;
        this.write('The battlefield returned to normal.');
      }
    }
  }

  getBattleMessagePrefix(pokemon) {
    const owner = this.members.find(m => this.activeMember(m.id) === pokemon);
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
    this.write(winnerIds.includes(this.localMemberId)
      ? 'Your team won the battle!'
      : 'Your team lost the battle!');
    this.busy = false;
    this.locked = false;
    this.updateNetworkState?.();
    this.update();
  }
}
