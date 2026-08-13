import { Battle } from "./battle.js";

function clampBattleSize(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(1, Math.min(10, Math.floor(n))) : 1;
}

/**
 * N-vs-N battle layer built on top of the existing Battle move/effect engine.
 * A team can contain up to 10 Pokémon and `battleSize` controls how many
 * are simultaneously active on each side.
 */
export class MultiBattle extends Battle {
  constructor({ data, playerTeam, opponentTeam, networkRole = null, battleSize = 1 }) {
    super({ data, playerTeam, opponentTeam, networkRole });
    this.isMulti = true;
    this.battleSize = clampBattleSize(battleSize);
    this.battleSize = Math.min(this.battleSize, this.player.team.length, this.opponent.team.length);

    this.player.active = this.player.team.slice(0, this.battleSize).map((_, i) => i);
    this.opponent.active = this.opponent.team.slice(0, this.battleSize).map((_, i) => i);
    this.pendingActions = { player: null, opponent: null };
    this.localActionsSubmitted = false;
    this.remoteActionsSubmitted = false;
    this.awaitingPlayerSwitch = false;
    this.locked = false;
    this.busy = false;

    // Fresh entry triggers for every simultaneously active Pokémon.
    for (const side of ["player", "opponent"]) {
      for (const index of this.activeIndices(side)) {
        const p = this[side].team[index];
        this.triggerAbility(p, "onBattleStart");
        this.write(`${side === "player" ? "Your Pokémon" : "The opposing Pokémon"} ${p.name} entered the battle!`);
      }
    }
    this.update();
  }

  clampSize(n) {
    return Math.max(1, Math.min(10, Math.floor(Number(n) || 1)));
  }

  active(side) {
    const s = this[side];
    if (!s) return null;
    if (Array.isArray(s.active)) return s.team[s.active[0]] ?? null;
    return s.team[s.active];
  }

  activeIndices(side) {
    const s = this[side];
    return Array.isArray(s?.active) ? s.active.filter(i => s.team[i]?.canBattle()) : (s?.team?.[s.active]?.canBattle() ? [s.active] : []);
  }

  activePokemon(side) {
    const s = this[side];
    return this.activeIndices(side).map(i => s.team[i]).filter(Boolean);
  }

  isActive(side, pokemon) {
    return this.activeIndices(side).some(i => this[side].team[i] === pokemon);
  }

  getAvailableMovesFor(pokemon) {
    if (!pokemon?.canBattle()) return [];
    let moves = pokemon.moves.filter(m => {
      const forcedContinuation = pokemon.volatile?.charging === m.id ||
        (pokemon.volatile?.outrageTurns > 0 && m.id === "outrage") ||
        (pokemon.volatile?.uproarTurns > 0 && m.id === "uproar");
      if ((m.pp ?? 1) <= 0 && !forcedContinuation) return false;
      if (pokemon.volatile?.tauntTurns > 0 && m.category === "status") return false;
      return true;
    });
    if (pokemon.volatile?.charging) moves = moves.filter(m => m.id === pokemon.volatile.charging);
    if (pokemon.volatile?.outrageTurns > 0) moves = moves.filter(m => m.id === "outrage");
    if (pokemon.volatile?.uproarTurns > 0) moves = moves.filter(m => m.id === "uproar");
    return moves;
  }

  getAvailableMoves() {
    return this.getAvailableMovesFor(this.active("player"));
  }

  getAvailableTargets(side, targetSide = "opponent") {
    return this.activeIndices(targetSide).map(index => ({
      index,
      pokemon: this[targetSide].team[index],
      label: `${this[targetSide].team[index].name} · ${Math.max(0, this[targetSide].team[index].hp)}/${this[targetSide].team[index].maxHP}`
    }));
  }

  canSelectMoveFor(pokemon, move) {
    return super.canSelectMove(pokemon, move);
  }

  getActionKey(side, slotIndex) {
    return `${side}:${slotIndex}`;
  }

  setLocalAction(slotIndex, moveId, targetSide = "opponent", targetIndex = null) {
    if (this.over || this.busy || !this.isMulti) return false;
    const team = this.player.team;
    const actualIndex = this.player.active[slotIndex];
    const pokemon = team[actualIndex];
    const move = pokemon?.moves?.find(m => m.id === moveId);
    if (!pokemon || !this.canSelectMoveFor(pokemon, move)) return false;

    let target = targetIndex;
    if (target === null || target === undefined) {
      const targets = this.getAvailableTargets("player", targetSide);
      target = targets[0]?.index;
    }
    if (target === undefined || target === null || !this[targetSide]?.team?.[target]?.canBattle()) return false;

    this.pendingActions.player = Array.isArray(this.pendingActions.player) ? this.pendingActions.player : [];
    this.pendingActions.player = this.pendingActions.player.filter(a => a.slot !== slotIndex);
    this.pendingActions.player.push({ slot: slotIndex, pokemonIndex: actualIndex, moveId, targetSide, targetIndex: target });
    this.localActionsSubmitted = this.pendingActions.player.length >= this.activeIndices("player").length;
    this.update();
    if (this.networkRole === "host") {
      this.pendingNetwork = this.pendingNetwork || {};
      this.pendingNetwork.playerActions = this.pendingActions.player;
      this.updateNetworkState?.();
      if (this.remoteActionsSubmitted) this.tryResolveNetworkActions();
    } else if (!this.networkRole && this.localActionsSubmitted) {
      this.resolveActions(this.pendingActions.player, this.buildAIOpponentActions());
    }
    return true;
  }

  buildAIOpponentActions() {
    return this.activeIndices("opponent").map((teamIndex, slot) => {
      const p = this.opponent.team[teamIndex];
      const moves = this.getAvailableMovesFor(p);
      const move = moves[Math.floor(Math.random() * moves.length)] ?? p.moves[0];
      const targets = this.getAvailableTargets("opponent", "player");
      const target = targets[Math.floor(Math.random() * targets.length)];
      return { slot, pokemonIndex: teamIndex, moveId: move?.id, targetSide: "player", targetIndex: target?.index };
    }).filter(a => a.moveId && a.targetIndex !== undefined);
  }

  async receiveRemoteActions(actions) {
    if (this.networkRole !== "host" || this.over || !this.isMulti) return;
    this.pendingNetwork = this.pendingNetwork || {};
    this.pendingNetwork.opponentActions = Array.isArray(actions) ? actions : [];
    this.pendingActions.opponent = this.pendingNetwork.opponentActions;
    this.remoteActionsSubmitted = true;
    this.write("The opponent has chosen all of their actions.");
    this.updateNetworkState?.();
    await this.tryResolveNetworkActions();
  }

  async tryResolveNetworkActions() {
    if (this.networkRole !== "host") return;
    if (!this.pendingNetwork?.playerActions || !this.pendingNetwork?.opponentActions) return;
    if (this.busy || this.over) return;

    const playerActions = this.pendingNetwork.playerActions;
    const opponentActions = this.pendingNetwork.opponentActions;
    this.pendingNetwork = {};
    this.pendingActions = { player: null, opponent: null };
    this.localActionsSubmitted = false;
    this.remoteActionsSubmitted = false;
    await this.resolveActions(playerActions, opponentActions, true);
  }

  async resolveActions(playerActions, opponentActions, networkResolve = false) {
    if (this.busy || this.over) return;
    this.busy = true;
    this.locked = true;
    this.update();

    const actions = [
      ...(playerActions ?? []).map(a => ({ ...a, side: "player" })),
      ...(opponentActions ?? []).map(a => ({ ...a, side: "opponent" }))
    ].filter(a => {
      const p = this[a.side]?.team?.[a.pokemonIndex];
      return p?.canBattle() && a.moveId;
    });

    actions.sort((a, b) => {
      const ap = this[a.side].team[a.pokemonIndex];
      const bp = this[b.side].team[b.pokemonIndex];
      const am = ap.moves.find(m => m.id === a.moveId) ?? ap.moves[0];
      const bm = bp.moves.find(m => m.id === b.moveId) ?? bp.moves[0];
      const pa = this.getMovePriority(am, ap);
      const pb = this.getMovePriority(bm, bp);
      if (pa !== pb) return pb - pa;
      const sa = this.getStat(ap, "speed");
      const sb = this.getStat(bp, "speed");
      if (sa !== sb) return sb - sa;
      return Math.random() < 0.5 ? -1 : 1;
    });

    this.write(`${actions.length} actions queued — resolving the turn...`);

    for (const action of actions) {
      const attacker = this[action.side].team[action.pokemonIndex];
      if (!attacker?.canBattle()) continue;
      const defenderTeam = this[action.targetSide === "player" ? "player" : "opponent"]?.team;
      const defender = defenderTeam?.[action.targetIndex];
      const move = attacker.moves.find(m => m.id === action.moveId);
      if (!defender?.canBattle() || !move) {
        this.write(`${attacker.name}'s target is no longer available.`);
        continue;
      }
      await this.performMove(attacker, defender, move);
    }

    this.autoFillFaintedSlots();
    if (this.sideHasNoUsable("player")) {
      this.end(false);
      this.busy = false; this.locked = false; this.update();
      return;
    }
    if (this.sideHasNoUsable("opponent")) {
      this.end(true);
      this.busy = false; this.locked = false; this.update();
      return;
    }

    this.finishMultiTurn();
  }

  autoFillFaintedSlots() {
    for (const side of ["player", "opponent"]) {
      const active = Array.isArray(this[side].active) ? [...this[side].active] : [];
      const used = new Set(active);
      for (let slot = 0; slot < this.battleSize; slot++) {
        const current = active[slot];
        if (this[side].team[current]?.canBattle()) continue;
        let next = this[side].team.findIndex((p, i) => !used.has(i) && p.canBattle());
        if (next === -1) continue;
        if (current !== undefined) this.resetOnSwitch(this[side].team[current]);
        active[slot] = next;
        used.add(next);
        const p = this[side].team[next];
        this.triggerAbility(p, "onBattleStart");
        this.write(`${side === "player" ? "Your side sent out" : "The opposing side sent out"} ${p.name}!`);
      }
      this[side].active = active;
    }
  }

  sideHasNoUsable(side) {
    return this[side].team.every(p => !p.canBattle());
  }

  applyEndTurnStatus() {
    for (const side of ["player", "opponent"]) {
      for (const index of this.activeIndices(side)) {
        const pokemon = this[side].team[index];
        if (!pokemon?.canBattle() || !pokemon.status) continue;
        const def = this.getStatusDef(pokemon);
        const effect = def?.statusEffect || {};
        const percent = Number(effect.endTurnDamage ?? 0);
        if (percent > 0) {
          pokemon.receiveDamage(Math.max(1, Math.floor(pokemon.maxHP * percent)));
          this.write(`${pokemon.name} was hurt by ${pokemon.status}!`);
        }
        if (pokemon.statusData) pokemon.statusData.turns = (pokemon.statusData.turns ?? 0) + 1;
        if (pokemon.volatile?.trapTurns > 0 && pokemon.canBattle()) {
          pokemon.receiveDamage(Math.max(1, Math.floor(pokemon.maxHP / 8)));
          this.write(`${pokemon.name} was hurt by the trapping flames!`);
        }
      }
    }
  }

  applyEndTurnItems() {
    for (const side of ["player", "opponent"]) {
      for (const index of this.activeIndices(side)) {
        const pokemon = this[side].team[index];
        if (!pokemon?.canBattle()) continue;
        const item = this.getItem(pokemon);
        if (item?.effect?.kind === "end_turn_heal") {
          const amount = Math.max(1, Math.floor(pokemon.maxHP * (item.effect.percent ?? 0.0625)));
          const old = pokemon.hp;
          pokemon.hp = Math.min(pokemon.maxHP, pokemon.hp + amount);
          if (pokemon.hp > old) this.write(`${pokemon.name} restored HP with its ${item.name}!`);
        }
      }
    }
  }

  finishMultiTurn() {
    this.applyEndTurnStatus();
    this.applyEndTurnItems();
    if (this.fieldTurns > 0) {
      this.fieldTurns -= 1;
      if (this.fieldTurns <= 0) {
        this.field = null;
        this.write("The battlefield returned to normal.");
      }
    }

    for (const side of ["player", "opponent"]) {
      for (const index of this.activeIndices(side)) {
        const p = this[side].team[index];
        if (!p?.volatile) continue;
        p.volatile.protected = false;
        p.volatile.endure = false;
        p.volatile.flinched = false;
        if (p.volatile.roosted) {
          p.types = [...(p.originalTypes || p.types)];
          p.volatile.roosted = false;
        }
        p.volatile.lastDamageTaken = 0;
        if (p.volatile.tauntTurns > 0) p.volatile.tauntTurns -= 1;
        if (p.volatile.trapTurns > 0) p.volatile.trapTurns -= 1;
        if (p.volatile.uproarTurns > 0) p.volatile.uproarTurns -= 1;
        if (p.volatile.protectStreak !== undefined && !["protect","endure"].includes(p.volatile.lastMove)) p.volatile.protectStreak = 0;
      }
    }

    this.autoFillFaintedSlots();
    this.busy = false;
    this.locked = false;
    this.localActionsSubmitted = false;
    this.remoteActionsSubmitted = false;
    this.pendingActions = { player: null, opponent: null };
    this.turnContext = { damageTaken: new Map(), physicalDamageTaken: new Map(), moveFailed: new Map() };
    this.turn++;
    this.updateNetworkState?.();
    this.update();
  }

  tryOpponentSwitch(force = false) {
    // In N-vs-N, Roar/forced-switch effects replace the targeted opposing slot
    // with the first healthy bench Pokémon not already active.
    const active = this.opponent.active || [];
    const target = this.active("opponent");
    if (!target && !active.length) return false;
    const next = this.opponent.team.findIndex((p, i) => !active.includes(i) && p.canBattle());
    if (next === -1) return false;
    const slot = Math.max(0, active.findIndex(i => this.opponent.team[i] === target));
    if (active[slot] !== undefined) this.resetOnSwitch(this.opponent.team[active[slot]]);
    active[slot] = next;
    this.opponent.active = active;
    const pokemon = this.opponent.team[next];
    this.triggerAbility(pokemon, "onBattleStart");
    this.write(`The opposing side sent out ${pokemon.name}!`);
    return true;
  }

  end(playerWon) {
    this.over = true;
    if (this.networkRole === "host") {
      this.result = { winnerRole: playerWon ? "host" : "guest" };
    } else if (this.networkRole === "guest") {
      this.result = { winnerRole: playerWon ? "host" : "guest" };
    } else {
      this.result = { winnerRole: playerWon ? "local" : "remote" };
    }
    this.write(playerWon ? "Your side won the battle!" : "Your side lost the battle!");
  }

  getBattleMessagePrefix(pokemon) {
    return this.isActive("player", pokemon) ? "Your Pokémon" : "The opposing Pokémon";
  }
}
