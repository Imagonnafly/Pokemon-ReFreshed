import { BattlePokemon } from "./pokemon.js";
import { calculateDamage, getBattleStat, calculateAccuracy } from "./formulas.js";

export class Battle {
  constructor({data, playerTeam, opponentTeam, networkRole = null}) {
    this.data = data;
    this.networkRole = networkRole;
    this.pendingNetwork = {};
    this.localMoveSubmitted = false;
    this.remoteMoveSubmitted = false;
    this.typeChart = data.types.chart;
    this.species = data.species;
    this.movesData = data.moves;
    this.abilitiesData = data.abilities ?? [];
    this.itemsData = data.items ?? [];
    this.turn = 1;
    this.over = false;
    this.result = null;
    this.busy = false;
    this.locked = false;
    this.log = [];
    this.onUpdate = null;

    this.player = { team: this.createTeam(playerTeam), active: 0 };
    this.opponent = { team: this.createTeam(opponentTeam), active: 0 };

    this.write("Battle started!");
    this.write(`${this.active("opponent").name} appeared!`);
    this.write(`${this.active("player").name}, go!`);
    this.triggerAbility(this.active("player"), "onBattleStart");
    this.triggerAbility(this.active("opponent"), "onBattleStart");
  }

  createTeam(teamData) {
    return teamData.map(slot => {
      const species = this.species.find(p => p.id === slot.species);
      if (!species) throw new Error(`Unknown Pokémon species: ${slot.species}`);

      const moves = slot.moves
        .map(id => this.movesData.find(m => m.id === id))
        .filter(Boolean);

      return new BattlePokemon(
        species,
        slot.level ?? 50,
        moves,
        slot.ability ?? species.abilities?.[0] ?? null,
        slot.item ?? null
      );
    });
  }

  active(side) {
    return this[side].team[this[side].active];
  }

  write(text) {
    this.log.push(text);
    this.update();
  }

  update() {
    this.onUpdate?.();
    this.updateNetworkState?.();
  }

  pause(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getAvailableMoves() {
    return this.active("player").moves.filter(m => (m.pp ?? 1) > 0);
  }

  async playerMove(moveId) {
    if (this.over || this.busy || this.locked || this.awaitingPlayerSwitch) return;

    if (this.networkRole === "host") {
      const move = this.active("player").moves.find(m => m.id === moveId);
      if (!move || this.pendingNetwork?.playerMove) return;

      this.pendingNetwork = this.pendingNetwork || {};
      this.pendingNetwork.playerMove = move.id;
      this.localMoveSubmitted = true;
      this.busy = true;
      this.locked = true;
      this.write(`Your move is locked in — waiting for the opponent to choose.`);
      this.updateNetworkState?.();
      await this.tryNetworkTurn();
      return;
    }

    const move = this.active("player").moves.find(m => m.id === moveId);
    const player = this.active("player");
    const opponent = this.active("opponent");

    if (!move || !player.canBattle() || !opponent.canBattle()) return;

    const heldItem = this.getItem(player);
    if (heldItem?.effect?.kind === "choice_boost" && player.choiceMove && player.choiceMove !== move.id) {
      const lockedMove = this.movesData.find(m => m.id === player.choiceMove);
      this.write(`${player.name} is locked into ${lockedMove?.name ?? "its move"}!`);
      return;
    }
    if (heldItem?.effect?.kind === "choice_boost" && !player.choiceMove) player.choiceMove = move.id;

    this.busy = true;
    this.locked = true;
    this.update();
    await this.pause(500);

    const opponentMove = this.chooseOpponentMove();
    await this.runTurn(move, opponentMove);
  }

  async receiveRemoteMove(moveId) {
    if (this.networkRole !== "host" || this.over) return;
    this.pendingNetwork = this.pendingNetwork || {};
    if (this.pendingNetwork.opponentMove) return;
    this.pendingNetwork.opponentMove = moveId;
    this.remoteMoveSubmitted = true;
    this.write(`The opponent has chosen a move.`);
    this.updateNetworkState?.();
    if (this.pendingNetwork.playerSwitch !== undefined) await this.tryNetworkSwitchChoice();
    else await this.tryNetworkTurn();
  }

  async tryNetworkSwitchChoice() {
    const pending = this.pendingNetwork;
    if (!pending?.playerSwitch && pending?.playerSwitch !== 0) return;
    if (pending.opponentMove || pending.opponentSwitch !== undefined) {
      const playerTarget = this.player.team[pending.playerSwitch];
      if (!playerTarget?.canBattle()) return;
      const opponentSwitch = pending.opponentSwitch;
      const opponentMove = pending.opponentMove ? this.opponent.team[this.opponent.active]?.moves.find(m => m.id === pending.opponentMove) : null;
      this.pendingNetwork = {};
      this.busy = true; this.locked = true;
      this.player.active = Number(pending.playerSwitch);
      this.write(`Go, ${playerTarget.name}!`);
      await this.pause(500);
      if (opponentSwitch !== undefined) {
        const target = this.opponent.team[opponentSwitch];
        if (target?.canBattle()) {
          this.opponent.active = opponentSwitch;
          this.write(`The opposing side sent out ${target.name}!`);
        }
        this.finishActionTurn();
        return;
      }
      if (opponentMove && this.active("opponent").canBattle()) {
        await this.performMove(this.active("opponent"), playerTarget, opponentMove);
      }
      if (!playerTarget.canBattle()) { await this.handlePlayerFaint(); return; }
      this.finishActionTurn();
    }
  }

  async receiveRemoteSwitch(index) {
    if (this.networkRole !== "host" || this.over || this.busy) return;
    const target = this.opponent.team[index];
    if (!target?.canBattle() || index === this.opponent.active) return;
    this.pendingNetwork = this.pendingNetwork || {};
    this.pendingNetwork.opponentSwitch = index;
    this.write("Your opponent is switching Pokémon...");
    if (this.pendingNetwork.playerSwitch !== undefined) await this.tryNetworkSwitchChoice();
    else await this.tryNetworkSwitchTurn();
  }

  async tryNetworkSwitchTurn() {
    const pending = this.pendingNetwork;
    if (!pending?.playerMove || pending.opponentSwitch === undefined || this.busy || this.over) return;
    const player = this.active("player");
    const move = player.moves.find(m => m.id === pending.playerMove);
    const target = this.opponent.team[pending.opponentSwitch];
    this.pendingNetwork = {};
    this.localMoveSubmitted = false;
    this.remoteMoveSubmitted = false;
    if (!move || !target?.canBattle()) return;

    this.busy = true;
    this.locked = true;
    this.opponent.active = pending.opponentSwitch;
    this.write(`The opposing side sent out ${target.name}!`);
    await this.pause(600);
    await this.performMove(player, target, move);
    if (!target.canBattle()) await this.handleOpponentFaint();
    if (!this.active("player").canBattle()) { await this.handlePlayerFaint(); return; }
    this.finishActionTurn();
  }

  async tryNetworkTurn() {
    if (this.networkRole !== "host" || this.over) return;
    const pending = this.pendingNetwork;
    if (pending?.opponentSwitch !== undefined) { await this.tryNetworkSwitchTurn(); return; }
    if (!pending?.playerMove || !pending?.opponentMove) return;

    const player = this.active("player");
    const opponent = this.active("opponent");
    const move = player.moves.find(m => m.id === pending.playerMove);
    const opponentMove = opponent.moves.find(m => m.id === pending.opponentMove);
    this.pendingNetwork = {};
    this.localMoveSubmitted = false;
    this.remoteMoveSubmitted = false;
    if (!move || !opponentMove || !player.canBattle() || !opponent.canBattle()) return;

    const heldItem = this.getItem(player);
    if (heldItem?.effect?.kind === "choice_boost" && player.choiceMove && player.choiceMove !== move.id) {
      const lockedMove = this.movesData.find(m => m.id === player.choiceMove);
      this.write(`${player.name} is locked into ${lockedMove?.name ?? "its move"}!`);
      this.updateNetworkState?.();
      return;
    }
    if (heldItem?.effect?.kind === "choice_boost" && !player.choiceMove) player.choiceMove = move.id;

    this.busy = true;
    this.locked = true;
    this.updateNetworkState?.();
    await this.pause(450);
    await this.runTurn(move, opponentMove);
  }

  async runTurn(move, opponentMove) {
    const player = this.active("player");
    const opponent = this.active("opponent");
    const first = this.getTurnOrder(player, move, opponent, opponentMove);
    const second = first === "player"
      ? { side: "opponent", pokemon: opponent, move: opponentMove }
      : { side: "player", pokemon: player, move };

    this.write(this.getOrderMessage(player, move, opponent, opponentMove, first));
    await this.pause(650);

    if (first === "player") await this.performMove(player, opponent, move);
    else await this.performMove(opponent, player, opponentMove);

    if (!this.active("player").canBattle()) { await this.handlePlayerFaint(); return; }
    if (!this.active("opponent").canBattle()) {
      const switched = await this.handleOpponentFaint();
      if (!switched) { this.end(true); this.busy = false; this.locked = false; this.update(); return; }
      await this.pause(700);
      this.finishActionTurn();
      return;
    }

    if (second.pokemon.canBattle()) {
      await this.pause(550);
      await this.performMove(second.pokemon, second.side === "player" ? this.active("opponent") : this.active("player"), second.move);
    }

    if (!this.active("player").canBattle()) { await this.handlePlayerFaint(); return; }
    if (!this.active("opponent").canBattle()) {
      const switched = await this.handleOpponentFaint();
      if (!switched) { this.end(true); this.busy = false; this.locked = false; this.update(); return; }
      await this.pause(700);
    }
    this.finishActionTurn();
  }

  chooseOpponentMove() {
    const opponent = this.active("opponent");
    if (opponent.choiceMove) {
      return opponent.moves.find(m => m.id === opponent.choiceMove && (m.pp ?? 1) > 0) ?? null;
    }
    const usable = opponent.moves.filter(m => (m.pp ?? 1) > 0);
    const selected = usable.length
      ? usable[Math.floor(Math.random() * usable.length)]
      : null;
    if (selected && this.getItem(opponent)?.effect?.kind === "choice_boost") {
      opponent.choiceMove = selected.id;
    }
    return selected;
  }

  getMovePriority(move) {
    return Number(move?.priority ?? 0);
  }

  getTurnOrder(player, playerMove, opponent, opponentMove) {
    const playerPriority = this.getMovePriority(playerMove);
    const opponentPriority = this.getMovePriority(opponentMove);

    if (playerPriority !== opponentPriority) {
      return playerPriority > opponentPriority ? "player" : "opponent";
    }

    const playerSpeed = this.getStat(player, "speed");
    const opponentSpeed = this.getStat(opponent, "speed");

    if (playerSpeed !== opponentSpeed) {
      return playerSpeed > opponentSpeed ? "player" : "opponent";
    }

    // Exact Speed ties are resolved randomly, like a normal Pokémon battle.
    return Math.random() < 0.5 ? "player" : "opponent";
  }

  getOrderMessage(player, playerMove, opponent, opponentMove, first) {
    if (!opponentMove) {
      return `${player.name} is faster and will move first!`;
    }

    const playerPriority = this.getMovePriority(playerMove);
    const opponentPriority = this.getMovePriority(opponentMove);

    if (playerPriority !== opponentPriority) {
      const faster = first === "player" ? player.name : opponent.name;
      return `${faster}'s move has higher priority!`;
    }

    const playerSpeed = this.getStat(player, "speed");
    const opponentSpeed = this.getStat(opponent, "speed");

    if (playerSpeed === opponentSpeed) {
      return `Both Pokémon have the same Speed! ${first === "player" ? player.name : opponent.name} will move first!`;
    }

    const faster = first === "player" ? player.name : opponent.name;
    return `${faster} is faster and will move first!`;
  }

  async performMove(attacker, defender, move) {
    if (!attacker?.canBattle() || !defender?.canBattle() || !move) return;

    this.write(`${this.getBattleMessagePrefix(attacker)} ${attacker.name} used ${move.name}!`);
    await this.pause(900);

    this.executeMove(attacker, defender, move);
    await this.pause(900);
  }

  getBattleMessagePrefix(pokemon) {
    if (this.networkRole === "host") return pokemon === this.active("player") ? "Your Pokémon" : "The opposing Pokémon";
    return pokemon === this.active("player") ? "Your Pokémon" : "The opposing Pokémon";
  }

  finishActionTurn() {
    if (this.over) return;

    this.applyEndTurnStatus();
    this.applyEndTurnItems();

    this.busy = false;
    this.locked = false;
    this.localMoveSubmitted = false;
    this.remoteMoveSubmitted = false;
    this.endTurn();
    this.update();
  }

  async handleOpponentFaint() {
    const opponent = this.active("opponent");
    this.write(`${opponent.name} fainted!`);
    await this.pause(1100);

    return this.tryOpponentSwitch();
  }

  async handlePlayerFaint() {
    const player = this.active("player");
    this.write(`${player.name} fainted!`);
    await this.pause(1100);

    const hasReplacement = this.player.team.some(
      (p, i) => i !== this.player.active && p.canBattle()
    );

    if (!hasReplacement) {
      this.end(false);
      this.busy = false;
      this.locked = false;
      this.update();
      return;
    }

    // IMPORTANT: do not auto-select the next Pokémon.
    // The battle remains on the switch screen until the player chooses one.
    this.awaitingPlayerSwitch = true;
    this.busy = false;
    this.locked = true;
    this.write("Choose a Pokémon to send out!");
    this.update();
  }

  executeMove(attacker, defender, move) {
    move.pp = Math.max(0, (move.pp ?? 1) - 1);

    if (!this.checkAccuracy(attacker, defender, move)) return;

    // Ability can modify a move before damage is calculated.
    const modified = this.applyAbilityMoveModifiers(attacker, defender, move);
    const actualMove = modified.move;

    if (actualMove.category === "status") {
      this.applyEffects(attacker, defender, actualMove);
      return;
    }

    const result = calculateDamage({
      attacker,
      defender,
      move: actualMove,
      typeChart: this.typeChart,
      rng: Math.random,
      damageModifier: modified.damageModifier,
      attackerItem: this.getItem(attacker),
      defenderItem: this.getItem(defender)
    });

    const savedBySash = this.handleItemBeforeDamage(defender, result.damage);
    if (savedBySash) defender.hp = 1;
    else defender.receiveDamage(result.damage);
    this.update();

    if (result.effectiveness === 0) {
      this.write("It had no effect!");
    } else if (result.effectiveness > 1) {
      this.write("It's super effective!");
    } else if (result.effectiveness < 1) {
      this.write("It's not very effective...");
    }

    if (result.critical) this.write("A critical hit!");
    if (result.damage > 0) this.write(`${result.damage} damage!`);

    this.applyEffects(attacker, defender, actualMove);
    this.handleItemAfterDamage(defender);
    this.handleItemAfterAttack(attacker, result);

    // Defensive abilities react after damage.
    this.triggerAbility(defender, "onDamageTaken", {
      attacker,
      defender,
      move: actualMove,
      damage: result.damage
    });

    this.triggerAbility(attacker, "onDamageDealt", {
      attacker,
      defender,
      move: actualMove,
      damage: result.damage
    });
  }

  applyAbilityMoveModifiers(attacker, defender, move) {
    let damageModifier = 1;
    const ability = this.getAbility(attacker);

    if (ability?.effect?.kind === "boost_type_damage") {
      if (move.types.includes(ability.effect.type)) {
        damageModifier *= ability.effect.multiplier ?? 1.5;
        this.write(`${attacker.name}'s ${ability.name} boosted the move!`);
      }
    }

    if (ability?.effect?.kind === "boost_low_hp") {
      if (attacker.hp <= attacker.maxHP * (ability.effect.threshold ?? 1 / 3)) {
        if (move.types.includes(ability.effect.type)) {
          damageModifier *= ability.effect.multiplier ?? 1.5;
          this.write(`${attacker.name}'s ${ability.name} boosted the move!`);
        }
      }
    }

    if (this.getAbility(defender)?.effect?.kind === "immunity") {
      const defenderAbility = this.getAbility(defender);
      if (move.types.includes(defenderAbility.effect.type)) {
        this.write(`${defender.name} is immune because of ${defenderAbility.name}!`);
        return { move: {...move, category: "status", effects: []}, damageModifier: 0 };
      }
    }

    return { move, damageModifier };
  }

  getAbility(pokemon) {
    return this.abilitiesData.find(a => a.id === pokemon.ability) ?? null;
  }

  getItem(pokemon) {
    return this.itemsData.find(i => i.id === pokemon.item) ?? null;
  }

  getStat(pokemon, stat) {
    return getBattleStat(pokemon, stat, this.getItem(pokemon));
  }

  consumeItem(pokemon) {
    if (!pokemon.item || pokemon.itemUsed) return;
    const item = this.getItem(pokemon);
    if (!item) return;
    pokemon.itemUsed = true;
    this.write(`${pokemon.name} consumed its ${item.name}!`);
  }

  checkAccuracy(attacker, defender, move) {
    const accuracy = calculateAccuracy(attacker, defender, move);
    if (accuracy >= 100) return true;
    if (Math.random() * 100 < accuracy) return true;
    this.write(`${attacker.name}'s ${move.name} missed!`);
    return false;
  }

  handleItemBeforeDamage(defender, incomingDamage) {
    const item = this.getItem(defender);
    if (item?.effect?.kind !== "survive_full_hp" || defender.itemUsed) return false;
    if (defender.hp === defender.maxHP && incomingDamage >= defender.hp) {
      defender.itemUsed = true;
      this.write(`${defender.name}'s Focus Sash held on!`);
      return true;
    }
    return false;
  }

  handleItemAfterDamage(defender) {
    const item = this.getItem(defender);
    if (!item?.effect || defender.itemUsed || !defender.canBattle()) return;

    if (item.effect.kind === "heal_threshold" &&
        defender.hp <= defender.maxHP * (item.effect.threshold ?? 0.5)) {
      const amount = Math.max(1, Math.floor(defender.maxHP * (item.effect.percent ?? 0.25)));
      defender.hp = Math.min(defender.maxHP, defender.hp + amount);
      this.consumeItem(defender);
      this.write(`${defender.name} restored HP with its ${item.name}!`);
      return;
    }

    if (item.effect.kind === "cure_status" && defender.status) {
      defender.status = null;
      defender.statusData = {};
      this.consumeItem(defender);
      this.write(`${defender.name}'s ${item.name} cured its status!`);
    }
  }

  handleItemAfterAttack(attacker, result) {
    const item = this.getItem(attacker);
    if (!item?.effect || result.damage <= 0 || !attacker.canBattle()) return;

    if (item.effect.kind === "damage_boost") {
      const recoil = Math.max(1, Math.floor(attacker.maxHP * (item.effect.recoilPercent ?? 0.1)));
      attacker.receiveDamage(recoil);
      this.write(`${attacker.name} was hurt by its ${item.name}!`);
    }
  }

  applyEndTurnStatus() {
    for (const side of ["player", "opponent"]) {
      const pokemon = this.active(side);
      if (!pokemon?.canBattle() || !pokemon.status) continue;

      let percent = 0;
      if (pokemon.status === "Burn") percent = 1 / 16;
      if (pokemon.status === "Poison") percent = 1 / 8;
      if (pokemon.status === "Bad Poison") {
        const turns = Math.max(1, pokemon.statusData.toxicTurns ?? 1);
        percent = Math.min(15, turns) / 16;
        pokemon.statusData.toxicTurns = turns + 1;
      }

      if (percent > 0) {
        const damage = Math.max(1, Math.floor(pokemon.maxHP * percent));
        pokemon.receiveDamage(damage);
        this.write(`${pokemon.name} was hurt by its ${pokemon.status.toLowerCase()}!`);
      }
    }
  }

  applyEndTurnItems() {
    for (const side of ["player", "opponent"]) {
      const pokemon = this.active(side);
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

  triggerAbility(pokemon, trigger, context = {}) {
    const ability = this.getAbility(pokemon);
    if (!ability?.effect) return;

    const effect = ability.effect;

    if (effect.kind === "on_entry" && trigger === "onBattleStart") {
      this.write(`${pokemon.name}'s ${ability.name} activated!`);
    }

    if (effect.kind === "weather" && trigger === "onBattleStart") {
      this.write(`${pokemon.name}'s ${ability.name} activated!`);
      this.write(`The weather became ${effect.weather}!`);
      this.weather = effect.weather;
    }

    if (effect.kind === "heal_on_entry" && trigger === "onBattleStart") {
      const amount = Math.floor(pokemon.maxHP * (effect.percent ?? 0.25));
      pokemon.hp = Math.min(pokemon.maxHP, pokemon.hp + amount);
      this.write(`${pokemon.name}'s ${ability.name} restored its HP!`);
    }

    if (effect.kind === "heal_on_damage" && trigger === "onDamageTaken" && context.damage > 0) {
      const amount = Math.floor(pokemon.maxHP * (effect.percent ?? 0.1));
      pokemon.hp = Math.min(pokemon.maxHP, pokemon.hp + amount);
      this.write(`${pokemon.name}'s ${ability.name} restored some HP!`);
    }
  }

  applyEffects(attacker, defender, move) {
    for (const effect of move.effects ?? []) {
      if (effect.kind === "heal") {
        const amount = Math.floor(attacker.maxHP * (effect.percent ?? 0.5));
        attacker.hp = Math.min(attacker.maxHP, attacker.hp + amount);
        this.update();
        this.write(`${attacker.name} recovered HP!`);
      }

      if (effect.kind === "status" && !defender.status) {
        if (Math.random() <= (effect.chance ?? 1)) {
          defender.status = effect.status;
          this.write(`${defender.name} was afflicted with ${effect.status}!`);
        }
      }
    }
  }

  tryOpponentSwitch() {
    const next = this.opponent.team.findIndex(
      (p, i) => i !== this.opponent.active && p.canBattle()
    );
    if (next === -1) return false;

    this.opponent.active = next;
    const pokemon = this.active("opponent");
    this.write(`Opponent sent out ${pokemon.name}!`);
    this.triggerAbility(pokemon, "onBattleStart");
    return true;
  }

  tryPlayerAutoSwitch() {
    // Kept as a compatibility method for older code, but normal fainting
    // now always requires an explicit player choice.
    return false;
  }

  async switchPlayer(index) {
    if (this.over) return false;

    if (this.networkRole === "host" && !this.awaitingPlayerSwitch) {
      const target = this.player.team[index];
      if (!target?.canBattle() || index === this.player.active || this.busy || this.locked) return false;
      this.pendingNetwork = this.pendingNetwork || {};
      this.pendingNetwork.playerSwitch = index;
      this.write("Waiting for your opponent's action...");
      this.updateNetworkState?.();
      await this.tryNetworkSwitchChoice();
      return true;
    }

    const forced = this.awaitingPlayerSwitch;

    // Normal switching cannot happen while an action is in progress.
    if (!forced && (this.busy || this.locked)) return false;

    if (index === this.player.active) return false;

    const target = this.player.team[index];
    if (!target?.canBattle()) return false;

    this.busy = true;
    this.locked = true;
    this.update();

    await this.pause(500);

    this.player.active = index;
    this.awaitingPlayerSwitch = false;

    this.write(`Go, ${target.name}!`);
    this.triggerAbility(target, "onBattleStart");

    await this.pause(900);

    // A forced switch happens after the fainted Pokémon's turn is over.
    // The opponent does not get an extra move just because the player switched.
    if (forced) {
      this.applyEndTurnStatus();
      this.applyEndTurnItems();
      this.busy = false;
      this.locked = false;
      this.endTurn();
      this.update();
      return true;
    }

    // Voluntary switching consumes the player's action, so the opponent acts.
    const opponent = this.active("opponent");
    if (opponent.canBattle()) {
      const opponentMove = this.chooseOpponentMove();
      if (opponentMove) {
        await this.pause(700);
        await this.performMove(opponent, this.active("player"), opponentMove);
      }
    }

    if (!this.active("player").canBattle()) {
      await this.handlePlayerFaint();
      return true;
    }

    this.finishActionTurn();
    return true;
  }

  endTurn() {
    this.turn++;
    this.update();
  }

  end(playerWon) {
    this.over = true;
    if (this.networkRole === "host") {
      this.result = { winnerRole: playerWon ? "host" : "guest" };
    } else {
      this.result = { winnerRole: playerWon ? "local" : "remote" };
    }
    this.write(playerWon ? "You won the battle!" : "You lost the battle!");
  }
}
