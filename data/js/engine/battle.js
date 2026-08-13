import { BattlePokemon } from "./pokemon.js";
import { calculateDamage, getBattleStat, calculateAccuracy, typeEffectiveness } from "./formulas.js";

const SPECIES_WEIGHTS_KG = {
  bulbasaur: 6.9, charmander: 8.5, charizard: 90.5, squirtle: 9.0, blastoise: 85.5,
  chespin: 9.0, chikorita: 6.4, chimchar: 6.2, cyndaquil: 7.9, dragonite: 210.0,
  fennekin: 9.4, froakie: 7.0, fuecoco: 9.8, grookey: 5.0, koraidon: 303.0,
  litten: 4.3, miraidon: 240.0, mudkip: 7.6, oshawott: 5.9, piplup: 5.2,
  popplio: 7.5, quaxly: 6.1, rowlet: 1.5, scorbunny: 4.5, snivy: 8.1,
  sobble: 4.0, sprigatito: 4.1, tepig: 9.9, torchic: 2.5, totodile: 9.5,
  treecko: 5.0, turtwig: 10.2
};
const STATUS_MOVES = new Set([
  "agility","bulk-up","dragon-cheer","endure","growl","helping-hand","meteor-beam",
  "protect","rest","roar","roost","scary-face","screech","sleep-talk","solar-beam",
  "substitute","sunny-day","swords-dance","taunt","uproar"
]);
const CHARGE_MOVES = new Set(["dig","fly","meteor-beam","solar-beam"]);
const RECHARGE_MOVES = new Set(["giga-impact","hyper-beam"]);
const MULTI_HIT_MOVES = new Set(["double-kick","dual-wingbeat","scale-shot"]);
const CONTACT_STATUS = new Set(["body-slam","ember","fire-blast","fire-fang","flamethrower","flare-blitz","ice-fang","iron-head","rock-smash","thunder-fang","thunderbolt","water-pulse","zen-headbutt"]);
const LEGACY_STATUS_MAP = {
  "Burn": "Scorch",
  "Paralysis": "Shocked",
  "Freeze": "Frostbite",
  "Poison": "Haunted",
  "Bad Poison": "Haunted"
};


export class Battle {
  constructor({data, playerTeam, opponentTeam, networkRole = null}) {
    this.data = data;
    this.networkRole = networkRole;
    this.pendingNetwork = {};
    this.localMoveSubmitted = false;
    this.remoteMoveSubmitted = false;
    this.typeChart = data.types.chart;
    this.field = null;
    this.fieldTurns = 0;
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
    this.turnContext = { damageTaken: new Map(), physicalDamageTaken: new Map(), moveFailed: new Map() };

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

      // Enforce the species learnset at battle creation time. This is the
      // authoritative guard used by both local and multiplayer battles.
      const allowedLearnset = new Set(Array.isArray(species.learnset) ? species.learnset : []);
      const requestedMoves = Array.isArray(slot.moveset) ? slot.moveset : (Array.isArray(slot.moves) ? slot.moves : []);
      const moves = [...new Set(requestedMoves)]
        .filter(id => allowedLearnset.has(id))
        .map(id => this.movesData.find(m => m.id === id))
        .filter(Boolean)
        .slice(0, 4);

      // Never allow a Pokémon to enter battle with an illegal/empty move set.
      // If a stale save or malformed network payload is received, fall back
      // to the first four legal moves from that species' learnset.
      if (!moves.length) {
        for (const id of (species.learnset || [])) {
          const move = this.movesData.find(m => m.id === id);
          if (move) moves.push(move);
          if (moves.length >= 4) break;
        }
      }

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
    const pokemon = this.active("player");
    if (!pokemon?.canBattle()) return [];
    let moves = pokemon.moves.filter(m => {
      const forcedContinuation = pokemon.volatile?.charging === m.id ||
        (pokemon.volatile?.outrageTurns > 0 && m.id === "outrage") ||
        (pokemon.volatile?.uproarTurns > 0 && m.id === "uproar");
      if ((m.pp ?? 1) <= 0 && !forcedContinuation) return false;
      if (pokemon.volatile?.tauntTurns > 0 && m.category === "status") return false;
      return true;
    });
    if (pokemon.volatile?.charging) {
      moves = moves.filter(m => m.id === pokemon.volatile.charging);
    }
    if (pokemon.volatile?.outrageTurns > 0) {
      moves = moves.filter(m => m.id === "outrage");
    }
    if (pokemon.volatile?.uproarTurns > 0) {
      moves = moves.filter(m => m.id === "uproar");
    }
    return moves;
  }

  canSelectMove(pokemon, move) {
    if (!pokemon || !move || !pokemon.canBattle()) return false;
    if ((move.pp ?? 1) <= 0) return false;
    if (pokemon.volatile?.tauntTurns > 0 && move.category === "status") {
      this.write(`${pokemon.name} can't use ${move.name} because it is taunted!`);
      return false;
    }
    if (pokemon.status === "Sleep" && move.id !== "sleep-talk") {
      if (pokemon.statusData?.sleepTurns > 0) {
        this.write(`${pokemon.name} is fast asleep!`);
        return false;
      }
    }
    if (pokemon.volatile?.recharge) {
      this.write(`${pokemon.name} must recharge!`);
      return false;
    }
    return true;
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
    if (!this.canSelectMove(player, move)) return;
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

    if (first === "player" && player.volatile?.pendingUturn && player.canBattle()) {
      player.volatile.pendingUturn = false;
      this.awaitingPlayerSwitch = true;
      this.awaitingUturnSwitch = true;
      this.busy = false;
      this.locked = true;
      this.write("Choose a Pokémon to switch into after U-turn!");
      this.update();
      return;
    }

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

    if (second.side === "player" && player.volatile?.pendingUturn && player.canBattle()) {
      player.volatile.pendingUturn = false;
      // The turn's opponent action has already happened, so U-turn's switch
      // happens now and the next turn begins.
      this.awaitingPlayerSwitch = true;
      this.awaitingUturnSwitch = false;
      this.busy = false;
      this.locked = true;
      this.write("Choose a Pokémon to switch into after U-turn!");
      this.update();
      return;
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
    let usable = opponent.moves.filter(m => {
      const forcedContinuation = opponent.volatile?.charging === m.id ||
        (opponent.volatile?.outrageTurns > 0 && m.id === "outrage") ||
        (opponent.volatile?.uproarTurns > 0 && m.id === "uproar");
      if ((m.pp ?? 1) <= 0 && !forcedContinuation) return false;
      if (opponent.volatile?.tauntTurns > 0 && m.category === "status") return false;
      if (opponent.status === "Sleep" && m.id !== "sleep-talk") return false;
      return true;
    });
    if (opponent.volatile?.charging) usable = usable.filter(m => m.id === opponent.volatile.charging);
    if (opponent.volatile?.outrageTurns > 0) usable = usable.filter(m => m.id === "outrage");
    if (opponent.volatile?.uproarTurns > 0) usable = usable.filter(m => m.id === "uproar");
    const selected = usable.length
      ? usable[Math.floor(Math.random() * usable.length)]
      : null;
    if (selected && this.getItem(opponent)?.effect?.kind === "choice_boost") {
      opponent.choiceMove = selected.id;
    }
    return selected;
  }

  getMovePriority(move, pokemon = null) {
    if (!move) return 0;
    const builtIn = {
      "protect": 4, "endure": 4, "helping-hand": 5,
      "aqua-jet": 1, "quick-attack": 1,
      "counter": -5, "focus-punch": -3, "roar": -6, "dragon-tail": -6
    };
    let priority = Number(move.priority ?? builtIn[move.id] ?? 0);
    const statusPenalty = this.getStatusDef(pokemon)?.statusEffect?.priorityPenalty ?? 0;
    const fieldPenalty = this.getFieldDef()?.priorityPenalty ?? 0;
    return priority - Number(statusPenalty) - Number(fieldPenalty);
  }

  getTurnOrder(player, playerMove, opponent, opponentMove) {
    const playerPriority = this.getMovePriority(playerMove, player);
    const opponentPriority = this.getMovePriority(opponentMove, opponent);

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

    const playerPriority = this.getMovePriority(playerMove, player);
    const opponentPriority = this.getMovePriority(opponentMove, opponent);

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

    // PP is consumed when a move sequence starts. Charge moves, Outrage and
    // Uproar continue across turns without spending PP again.
    const continuation = attacker.volatile?.charging === move.id ||
      (attacker.volatile?.outrageTurns > 0 && move.id === "outrage") ||
      (attacker.volatile?.uproarTurns > 0 && move.id === "uproar");
    if (!continuation) move.pp = Math.max(0, (move.pp ?? 1) - 1);

    // Flinch, type-status action restrictions, sleep and recharge are checked at action time.
    if (attacker.volatile?.flinched) {
      attacker.volatile.flinched = false;
      this.write(`${attacker.name} flinched and couldn't move!`);
      attacker.volatile.lastMove = move.id;
      attacker.volatile.lastMoveFailed = true;
      this.turnContext.moveFailed.set(attacker, true);
      return;
    }

    const attackerStatusDef = this.getStatusDef(attacker);
    const attackerStatusEffect = attackerStatusDef?.statusEffect || {};

    if (attackerStatusEffect.actionFailChance && Math.random() < attackerStatusEffect.actionFailChance) {
      this.write(`${attacker.name} is ${String(attacker.status).toLowerCase()} and couldn't move!`);
      attacker.volatile.lastMove = move.id;
      attacker.volatile.lastMoveFailed = true;
      this.turnContext.moveFailed.set(attacker, true);
      return;
    }

    if (attacker.status === "Frostbite") {
      if (Math.random() < 0.2 || ["flare-blitz","fire-blast","flamethrower","fire-fang","ember","heat-wave","overheat","flame-charge","temper-flare"].includes(move.id)) {
        attacker.status = null;
        attacker.statusData = {};
        this.write(`${attacker.name} thawed out!`);
      } else {
        this.write(`${attacker.name} is frostbitten solid!`);
        this.turnContext.moveFailed.set(attacker, true);
        return;
      }
    }

    if (attacker.status === "Sleep" && move.id !== "sleep-talk") {
      if ((attacker.statusData.sleepTurns ?? 0) > 0) {
        attacker.statusData.sleepTurns -= 1;
        this.write(`${attacker.name} is fast asleep!`);
        if (attacker.statusData.sleepTurns <= 0) {
          attacker.status = null;
          attacker.statusData = {};
          this.write(`${attacker.name} woke up!`);
        }
        this.turnContext.moveFailed.set(attacker, true);
        return;
      }
    }

    if (attacker.volatile?.recharge) {
      attacker.volatile.recharge = false;
      this.write(`${attacker.name} must recharge!`);
      this.turnContext.moveFailed.set(attacker, true);
      return;
    }

    if (attacker.volatile?.confusedTurns > 0 && move.id !== "sleep-talk") {
      if (Math.random() < 1 / 3) {
        const selfDamage = Math.max(1, Math.floor(calculateDamage({
          attacker, defender: attacker,
          move: { ...move, types: ["Time"], category: "physical", power: 40 },
          typeChart: this.typeChart,
          rng: Math.random
        }).damage));
        attacker.receiveDamage(selfDamage);
        attacker.volatile.confusedTurns -= 1;
        this.write(`${attacker.name} hurt itself in its confusion!`);
        if (attacker.volatile.confusedTurns <= 0) this.write(`${attacker.name} snapped out of confusion!`);
        this.turnContext.moveFailed.set(attacker, true);
        return;
      }
      attacker.volatile.confusedTurns -= 1;
      if (attacker.volatile.confusedTurns <= 0) this.write(`${attacker.name} snapped out of confusion!`);
    }

    // Focus Punch only succeeds if the user was not damaged before it acts.
    if (move.id === "focus-punch" && (this.turnContext.damageTaken.get(attacker) ?? 0) > 0) {
      this.write(`${attacker.name} lost its focus and couldn't move!`);
      this.turnContext.moveFailed.set(attacker, true);
      return;
    }

    // Two-turn moves: the first action charges, the second action attacks.
    if (CHARGE_MOVES.has(move.id) && attacker.volatile?.charging !== move.id) {
      const sunny = this.field === "Inferno";
      if (move.id === "solar-beam" && sunny) {
        // Sun removes Solar Beam's charge turn.
      } else {
        attacker.volatile.charging = move.id;
        if (move.id === "meteor-beam") this.changeStage(attacker, "specialAttack", 1);
        this.write(`${attacker.name} began charging ${move.name}!`);
        this.turnContext.moveFailed.set(attacker, false);
        return;
      }
    }
    if (attacker.volatile?.charging === move.id) {
      attacker.volatile.charging = null;
      this.write(`${attacker.name} unleashed ${move.name}!`);
    }

    // Sleep Talk chooses a random non-Sleep-Talk move while asleep.
    if (move.id === "sleep-talk") {
      if (attacker.status !== "Sleep") {
        this.write(`${attacker.name} used Sleep Talk, but it failed!`);
        this.turnContext.moveFailed.set(attacker, true);
        return;
      }
      const pool = attacker.moves.filter(m => m.id !== "sleep-talk" && (m.pp ?? 1) > 0);
      if (!pool.length) {
        this.write(`${attacker.name}'s Sleep Talk failed!`);
        this.turnContext.moveFailed.set(attacker, true);
        return;
      }
      const chosen = pool[Math.floor(Math.random() * pool.length)];
      this.write(`${attacker.name} used Sleep Talk and selected ${chosen.name}!`);
      await this.pause(300);
      await this.performMove(attacker, defender, { ...chosen, pp: 1 });
      return;
    }

    this.write(`${this.getBattleMessagePrefix(attacker)} ${attacker.name} used ${move.name}!`);
    await this.pause(700);

    const succeeded = this.executeMove(attacker, defender, move);
    attacker.volatile.lastMove = move.id;
    attacker.volatile.lastMoveFailed = !succeeded;
    this.turnContext.moveFailed.set(attacker, !succeeded);

    // Giga Impact / Hyper Beam require a recharge turn after a successful attack.
    if (RECHARGE_MOVES.has(move.id) && attacker.canBattle()) {
      attacker.volatile.recharge = true;
    }

    // Outrage continues for 2–3 turns; after it ends the user becomes confused.
    if (move.id === "outrage" && succeeded && attacker.canBattle()) {
      const remaining = attacker.volatile.outrageTurns ?? (2 + Math.floor(Math.random() * 2));
      attacker.volatile.outrageTurns = remaining - 1;
      if (attacker.volatile.outrageTurns <= 0) {
        attacker.volatile.outRageTurns = 0;
        attacker.volatile.confusedTurns = 2 + Math.floor(Math.random() * 3);
        this.write(`${attacker.name} became confused due to fatigue!`);
      }
    }
    await this.pause(700);
  }

  getBattleMessagePrefix(pokemon) {
    if (this.networkRole === "host") return pokemon === this.active("player") ? "Your Pokémon" : "The opposing Pokémon";
    return pokemon === this.active("player") ? "Your Pokémon" : "The opposing Pokémon";
  }

  finishActionTurn() {
    if (this.over) return;

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
      const p = this.active(side);
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
      if (p.volatile.trapTurns > 0) {
        p.volatile.trapTurns -= 1;
        if (p.volatile.trapTurns <= 0) {
          p.volatile.trapTurns = 0;
          p.volatile.trapSource = null;
          this.write(`${p.name} was freed from the trapping effect!`);
        }
      }
      if (p.volatile.uproarTurns > 0) {
        p.volatile.uproarTurns -= 1;
        if (p.volatile.uproarTurns <= 0) this.write(`${p.name}'s uproar ended!`);
      }
      if (p.volatile.protectStreak !== undefined && !["protect","endure"].includes(p.volatile.lastMove)) {
        p.volatile.protectStreak = 0;
      }
    }

    this.busy = false;
    this.locked = false;
    this.localMoveSubmitted = false;
    this.remoteMoveSubmitted = false;
    this.endTurn();
    this.turnContext = { damageTaken: new Map(), physicalDamageTaken: new Map(), moveFailed: new Map() };
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
    if (!this.checkAccuracy(attacker, defender, move)) return false;

    if (["dig","fly"].includes(defender.volatile?.charging) && !["earthquake","magnitude","gust","thunder","twister","hurricane"].includes(move.id)) {
      this.write(`${attacker.name}'s ${move.name} missed because ${defender.name} is out of reach!`);
      return false;
    }

    // Protect / Endure are handled before damage and can stop an attack entirely.
    if (defender.volatile?.protected) {
      this.write(`${defender.name} protected itself!`);
      return true;
    }

    // Status moves are handled separately.
    if (move.category === "status") {
      return this.applyEffects(attacker, defender, move);
    }

    const actualMove = this.getEffectiveMove(attacker, defender, move);
    const modified = this.applyAbilityMoveModifiers(attacker, defender, actualMove);
    const finalMove = modified.move;

    // Dynamic variable-power moves.
    finalMove.power = this.getMovePower(attacker, defender, finalMove);

    // Counter is a special retaliation move rather than a normal damage formula.
    if (move.id === "counter") {
      const taken = this.turnContext.physicalDamageTaken.get(attacker) ?? 0;
      if (taken <= 0) {
        this.write(`${attacker.name}'s Counter failed!`);
        return false;
      }
      const effectiveness = typeEffectiveness(move.types, defender.types, this.typeChart);
      if (effectiveness === 0) {
        this.write("It had no effect!");
        return false;
      }
      const damage = Math.max(1, taken * 2);
      this.applyDamage(attacker, defender, damage, move);
      return true;
    }

    // Focus Punch is handled by performMove; if it reaches here it succeeds.
    const result = calculateDamage({
      attacker,
      defender,
      move: finalMove,
      typeChart: this.typeChart,
      rng: Math.random,
      damageModifier: modified.damageModifier,
      attackerItem: this.getItem(attacker),
      defenderItem: this.getItem(defender),
      weather: this.field,
      terrain: this.field,
      field: this.field,
      statusEffects: this.data.types?.statuses,
      fieldEffects: this.data.types?.fields,
      criticalOverride: finalMove.criticalOverride
    });

    let hitCount = 1;
    if (MULTI_HIT_MOVES.has(move.id)) {
      if (move.id === "double-kick" || move.id === "dual-wingbeat") hitCount = 2;
      else hitCount = 2 + Math.floor(Math.random() * 4); // Scale Shot: 2–5
    }

    let totalDamage = 0;
    let anyHit = false;
    for (let i = 0; i < hitCount; i++) {
      if (!attacker.canBattle() || !defender.canBattle()) break;

      const hitResult = i === 0 ? result : calculateDamage({
        attacker,
        defender,
        move: finalMove,
        typeChart: this.typeChart,
        rng: Math.random,
        damageModifier: modified.damageModifier,
        attackerItem: this.getItem(attacker),
        defenderItem: this.getItem(defender),
        weather: this.field,
        terrain: this.field,
        field: this.field,
        statusEffects: this.data.types?.statuses,
        fieldEffects: this.data.types?.fields,
        criticalOverride: finalMove.criticalOverride
      });

      if (hitResult.effectiveness === 0) {
        if (i === 0) this.write("It had no effect!");
        break;
      }

      let damage = hitResult.damage;
      if (this.handleItemBeforeDamage(defender, damage)) damage = Math.max(0, defender.hp - 1);

      const substitute = defender.volatile?.substitute ?? 0;
      if (substitute > 0 && damage > 0) {
        const absorbed = Math.min(substitute, damage);
        defender.volatile.substitute -= absorbed;
        damage = 0;
        this.write(`${defender.name}'s Substitute took the hit!`);
        if (defender.volatile.substitute <= 0) {
          defender.volatile.substitute = 0;
          this.write(`${defender.name}'s Substitute broke!`);
        }
      }

      if (damage > 0) {
        if (defender.volatile?.endure && damage >= defender.hp) {
          damage = Math.max(0, defender.hp - 1);
          this.write(`${defender.name} endured the hit!`);
        }
        defender.receiveDamage(damage);
        totalDamage += damage;
        this.turnContext.damageTaken.set(defender, (this.turnContext.damageTaken.get(defender) ?? 0) + damage);
        if (finalMove.category === "physical") {
          this.turnContext.physicalDamageTaken.set(defender, (this.turnContext.physicalDamageTaken.get(defender) ?? 0) + damage);
        }
        defender.volatile.lastDamageTaken = damage;
      }

      anyHit = true;

      if (i === 0) {
        if (hitResult.effectiveness > 1) this.write("It's super effective!");
        else if (hitResult.effectiveness < 1) this.write("It's not very effective...");
        if (hitResult.critical) this.write("A critical hit!");
      }
      if (damage > 0) this.write(`${damage} damage${hitCount > 1 ? ` (${i + 1}/${hitCount})` : ""}!`);

      // Secondary effects only apply if the hit did not hit a Substitute.
      const blockedBySubstitute = substitute > 0 && damage === 0;
      if (hitResult.effectiveness !== 0) this.applySecondaryEffects(attacker, defender, finalMove, hitResult, blockedBySubstitute);
      if (!defender.canBattle()) break;
    }

    if (!anyHit) return false;

    // Recoil and draining use the actual damage dealt.
    if (finalMove.id === "flare-blitz" || finalMove.id === "double-edge" || finalMove.id === "wild-charge" || finalMove.id === "take-down") {
      const fraction = (finalMove.id === "wild-charge" || finalMove.id === "take-down") ? 0.25 : 1 / 3;
      if (totalDamage > 0 && attacker.canBattle()) {
        const recoil = Math.max(1, Math.floor(totalDamage * fraction));
        attacker.receiveDamage(recoil);
        this.write(`${attacker.name} was hurt by recoil!`);
      }
    }
    if (finalMove.id === "drain-punch" || finalMove.id === "parabolic-charge") {
      if (totalDamage > 0 && attacker.canBattle()) {
        const heal = Math.max(1, Math.floor(totalDamage * 0.5));
        attacker.hp = Math.min(attacker.maxHP, attacker.hp + heal);
        this.write(`${attacker.name} restored HP!`);
      }
    }

    this.handleItemAfterDamage(defender);
    this.handleItemAfterAttack(attacker, { ...result, damage: totalDamage });

    this.triggerAbility(defender, "onDamageTaken", {
      attacker, defender, move: finalMove, damage: totalDamage
    });
    this.triggerAbility(attacker, "onDamageDealt", {
      attacker, defender, move: finalMove, damage: totalDamage
    });

    // Moves that modify stats after dealing damage.
    this.applyMovePostDamageEffects(attacker, defender, finalMove, totalDamage);

    return true;
  }

  applyDamage(attacker, defender, damage, move) {
    if (defender.volatile?.protected) {
      this.write(`${defender.name} protected itself!`);
      return;
    }
    const finalDamage = Math.max(0, Math.min(defender.hp, damage));
    defender.receiveDamage(finalDamage);
    this.turnContext.damageTaken.set(defender, (this.turnContext.damageTaken.get(defender) ?? 0) + finalDamage);
    this.write(`${defender.name} took ${finalDamage} damage!`);
    if (!defender.canBattle()) this.write(`${defender.name} fainted!`);
  }

  getEffectiveMove(attacker, defender, move) {
    const actual = { ...move, effects: [...(move.effects ?? [])] };
    if (move.id === "gust" && defender.volatile?.charging === "fly") actual.power = Number(actual.power ?? 40) * 2;
    if (move.id === "facade" && ["Scorch","Shocked","Frostbite","Soaked","Fractured","Winded","Entangled","Rusted","Dazzled","Weakened","Confounded","Haunted","Starstruck","Time-Lagged"].includes(attacker.status)) actual.power = 140;
    if (move.id === "acrobatics" && (!attacker.item || attacker.itemUsed)) actual.power = 110;
    if (move.id === "temper-flare" && attacker.volatile?.lastMoveFailed) actual.power = 150;
    if (move.id === "stomping-tantrum" && attacker.volatile?.lastMoveFailed) actual.power = 150;
    if (move.id === "body-press") actual.damageStat = "defense";
    actual.critStage = attacker.volatile?.critStage ?? 0;
    if (move.id === "razor-leaf" || move.id === "shadow-claw") actual.critStage = Math.max(actual.critStage, 1);
    return actual;
  }

  getMovePower(attacker, defender, move) {
    if (move.id === "low-kick" || move.id === "heat-crash" || move.id === "heavy-slam") {
      const aWeight = SPECIES_WEIGHTS_KG[attacker.speciesId] ?? 50;
      const dWeight = SPECIES_WEIGHTS_KG[defender.speciesId] ?? 50;
      if (move.id === "low-kick") {
        if (dWeight < 10) return 20;
        if (dWeight < 25) return 40;
        if (dWeight < 50) return 60;
        if (dWeight < 100) return 80;
        if (dWeight < 200) return 100;
        return 120;
      }
      const ratio = dWeight > 0 ? aWeight / dWeight : 1;
      if (ratio >= 5) return 120;
      if (ratio >= 4) return 100;
      if (ratio >= 3) return 80;
      if (ratio >= 2) return 60;
      return 40;
    }
    if (move.id === "reversal") {
      const ratio = attacker.hp / attacker.maxHP;
      if (ratio >= 0.7) return 20;
      if (ratio >= 0.35) return 40;
      if (ratio >= 0.2) return 80;
      if (ratio >= 0.1) return 100;
      if (ratio >= 0.04) return 120;
      return 150;
    }
    if (move.id === "facade" && ["Scorch","Shocked","Frostbite","Soaked","Fractured","Winded","Entangled","Rusted","Dazzled","Weakened","Confounded","Haunted","Starstruck","Time-Lagged"].includes(attacker.status)) return 140;
    if (move.id === "acrobatics" && (!attacker.item || attacker.itemUsed)) return 110;
    if (move.id === "temper-flare" && attacker.volatile?.lastMoveFailed) return 150;
    if (move.id === "stomping-tantrum" && attacker.volatile?.lastMoveFailed) return 150;
    return Number(move.power ?? 0);
  }

  applyMovePostDamageEffects(attacker, defender, move, totalDamage) {
    if (!attacker.canBattle()) return;
    if (move.id === "giga-impact" || move.id === "hyper-beam") attacker.volatile.recharge = true;
    if (move.id === "u-turn" && defender.canBattle()) {
      if (attacker === this.active("player")) {
        attacker.volatile.pendingUturn = true;
      } else {
        // Remote player's U-turn: choose the first legal replacement on the host.
        const next = this.opponent.team.findIndex((p, i) => i !== this.opponent.active && p.canBattle());
        if (next >= 0) {
          this.opponent.active = next;
          this.write(`Opponent sent out ${this.active("opponent").name}!`);
          this.triggerAbility(this.active("opponent"), "onBattleStart");
        }
      }
    }
    if (move.id === "dragon-tail" && defender.canBattle() && totalDamage > 0) this.tryOpponentSwitch(true);
    if (move.id === "roar" && defender.canBattle()) this.tryOpponentSwitch(true);
    if (move.id === "scale-shot" && totalDamage > 0) {
      this.changeStage(attacker, "speed", 1);
      this.changeStage(attacker, "defense", -1);
    }
    if (move.id === "double-kick" || move.id === "dual-wingbeat") {
      // fixed two-hit moves have no additional effect
    }
  }

  applySecondaryEffects(attacker, defender, move, hitResult, blockedBySubstitute = false) {
    // Data-driven effects remain supported for moves whose special effects are
    // declared in their JSON definitions.
    for (const effect of move.effects ?? []) {
      if (effect.kind === "status" && !blockedBySubstitute && Math.random() < (effect.chance ?? 1)) {
        this.inflictStatus(defender, effect.status, `${attacker.name}'s ${move.name}`);
      }
      if (effect.kind === "stat_stage") {
        const target = effect.target === "opponent" ? defender : attacker;
        if (target === attacker || !blockedBySubstitute) this.changeStage(target, effect.stat, Number(effect.stages ?? 0));
      }
    }

    // Statuses and battlefield fields are intentionally independent.
    // A move only inflicts a status when that move explicitly declares a
    // status effect. A move only changes the battlefield when it explicitly
    // declares a field effect (or when a dedicated ability does so).
    // There is NO generic "move type -> status" chance and a status never
    // creates a battlefield field.
    for (const effect of move.effects ?? []) {
      if (effect.kind === "field" && !blockedBySubstitute) {
        const field = effect.field || effect.name;
        if (field) this.setField(field, Number(effect.duration ?? 5), `${attacker.name}'s ${move.name}`);
      }
    }

    if (!blockedBySubstitute && move.id === "body-slam" && Math.random() < 0.30) this.inflictStatus(defender, "Shocked", `${attacker.name}'s Body Slam`);
    if (!blockedBySubstitute && move.id === "fire-spin" && defender.canBattle() && defender.volatile.trapTurns <= 0) {
      defender.volatile.trapTurns = 4 + Math.floor(Math.random() * 2);
      defender.volatile.trapSource = attacker.speciesId;
      this.write(`${defender.name} became trapped in fire!`);
    }
    if (!blockedBySubstitute && move.id === "fire-fang" && Math.random() < 0.10) defender.volatile.flinched = true;
    if (!blockedBySubstitute && move.id === "ice-fang" && Math.random() < 0.10) defender.volatile.flinched = true;
    if (!blockedBySubstitute && move.id === "iron-head" && Math.random() < 0.30) defender.volatile.flinched = true;
    if (!blockedBySubstitute && move.id === "rock-smash" && Math.random() < 0.50) this.changeStage(defender, "defense", -1);
    if (!blockedBySubstitute && move.id === "thunder-fang" && Math.random() < 0.10) defender.volatile.flinched = true;
    if (!blockedBySubstitute && move.id === "water-pulse" && Math.random() < 0.20) this.confuse(defender);
    if (!blockedBySubstitute && move.id === "zen-headbutt" && Math.random() < 0.20) defender.volatile.flinched = true;
    if (move.id === "ancient-power" && Math.random() < 0.10) {
      for (const stat of ["attack","defense","specialAttack","specialDefense","speed"]) this.changeStage(attacker, stat, 1);
    }
    if (!blockedBySubstitute && move.id === "focus-blast" && Math.random() < 0.10) this.changeStage(defender, "specialDefense", -1);
    if (!blockedBySubstitute && move.id === "crunch" && Math.random() < 0.20) this.changeStage(defender, "defense", -1);
    if (!blockedBySubstitute && move.id === "breaking-swipe") this.changeStage(defender, "attack", -1);
    if (!blockedBySubstitute && (move.id === "bulldoze" || move.id === "low-sweep" || move.id === "mud-shot")) this.changeStage(defender, "speed", -1);
    if (!blockedBySubstitute && move.id === "mud-slap") this.changeStage(defender, "accuracy", -1);
    if (!blockedBySubstitute && move.id === "snarl") this.changeStage(defender, "specialAttack", -1);
    if (move.id === "flame-charge") this.changeStage(attacker, "speed", 1);
    if (move.id === "draco-meteor" || move.id === "overheat") this.changeStage(attacker, "specialAttack", -2);
  }

  changeStage(pokemon, stat, stages) {
    if (!pokemon?.statStages || pokemon.statStages[stat] === undefined || !stages) return false;
    const old = pokemon.statStages[stat];
    const next = Math.max(-6, Math.min(6, old + stages));
    pokemon.statStages[stat] = next;
    if (next === old) {
      this.write(`${pokemon.name}'s ${stat} won't go any higher!`);
      return false;
    }
    const word = stages > 0 ? "rose" : "fell";
    const magnitude = Math.abs(stages);
    this.write(`${pokemon.name}'s ${this.prettyStat(stat)} ${word}${magnitude > 1 ? ` ${magnitude} stages` : ""}!`);
    return true;
  }

  prettyStat(stat) {
    return String(stat).replace(/([A-Z])/g, " $1").toLowerCase();
  }

  inflictStatus(pokemon, status, source = null) {
    status = LEGACY_STATUS_MAP[status] || status;
    if (!pokemon?.canBattle() || pokemon.status) return false;
    if (pokemon.volatile?.substitute > 0) return false;

    const def = this.getStatusDef(status);
    if (!def) return false;

    const statusEffect = def.statusEffect || {};
    const immuneType = def.immuneType || Object.entries(this.data.types?.statuses || {}).find(([, d]) => d?.status === status)?.[0];
    if (immuneType && pokemon.types.includes(immuneType)) {
      this.write(`${pokemon.name} is immune to ${status}!`);
      return false;
    }

    pokemon.status = status;
    pokemon.statusData = { turns: 0 };

    this.write(`${pokemon.name} was afflicted with ${status}!`);
    // Status conditions affect the individual Pokémon only. They NEVER
    // create or change the battlefield field. Fields must be created by an
    // explicit move effect or an ability.
    return true;
  }

  confuse(pokemon) {
    if (!pokemon?.canBattle() || pokemon.volatile?.substitute > 0 || pokemon.volatile.confusedTurns > 0) return false;
    pokemon.volatile.confusedTurns = 2 + Math.floor(Math.random() * 3);
    this.write(`${pokemon.name} became confused!`);
    return true;
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

  getStatusDef(pokemonOrStatus) {
    const raw = typeof pokemonOrStatus === "string" ? pokemonOrStatus : pokemonOrStatus?.status;
    const status = LEGACY_STATUS_MAP[raw] || raw;
    if (!status) return null;
    return Object.values(this.data.types?.statuses || {}).find(def => def?.status === status) || null;
  }

  getFieldDef(field = this.field) {
    if (!field) return null;
    return Object.values(this.data.types?.fields || {}).find(def => def?.name === field) || null;
  }

  setField(field, turns = 5, source = null) {
    const def = this.getFieldDef(field);
    if (!def) return false;
    this.field = def.name;
    this.fieldTurns = turns;
    this.write(`${source ? `${source} caused ` : "The field became "}${def.name}!`);
    return true;
  }

  getStat(pokemon, stat) {
    let value = getBattleStat(pokemon, stat, this.getItem(pokemon));
    const effect = this.getAbility(pokemon)?.effect;
    const abilityField = effect?.field || effect?.weather || effect?.terrain;
    if ((effect?.kind === "field_and_stat_boost" || effect?.kind === "weather_and_stat_boost" || effect?.kind === "terrain_and_stat_boost") &&
        this.field === abilityField && effect.stat === stat) {
      value = Math.floor(value * (effect.multiplier ?? 1));
    }

    const statusDef = this.getStatusDef(pokemon);
    const statusEffect = statusDef?.statusEffect || {};
    if (statusEffect[`${stat}Multiplier`]) value = Math.floor(value * statusEffect[`${stat}Multiplier`]);
    if (statusEffect.speedMultiplier && stat === "speed") value = Math.floor(value * statusEffect.speedMultiplier);

    const fieldDef = this.getFieldDef();
    const fieldBoost = fieldDef?.statBoost?.[pokemon.types?.find(t => fieldDef?.statBoost?.[t])]?.[stat];
    if (fieldBoost) value = Math.floor(value * fieldBoost);
    return Math.max(1, value);
  }

  consumeItem(pokemon) {
    if (!pokemon.item || pokemon.itemUsed) return;
    const item = this.getItem(pokemon);
    if (!item) return;
    pokemon.itemUsed = true;
    this.write(`${pokemon.name} consumed its ${item.name}!`);
  }

  checkAccuracy(attacker, defender, move) {
    const accuracy = calculateAccuracy(attacker, defender, move, this.data.types?.statuses);
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

      const def = this.getStatusDef(pokemon);
      const effect = def?.statusEffect || {};
      const percent = Number(effect.endTurnDamage ?? 0);

      if (percent > 0) {
        const damage = Math.max(1, Math.floor(pokemon.maxHP * percent));
        pokemon.receiveDamage(damage);
        this.write(`${pokemon.name} was hurt by ${pokemon.status}!`);
      }

      if (pokemon.statusData) pokemon.statusData.turns = (pokemon.statusData.turns ?? 0) + 1;

      if (pokemon.volatile?.trapTurns > 0 && pokemon.canBattle()) {
        const damage = Math.max(1, Math.floor(pokemon.maxHP / 8));
        pokemon.receiveDamage(damage);
        this.write(`${pokemon.name} was hurt by the trapping flames!`);
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

    if ((effect.kind === "field" || effect.kind === "field_and_stat_boost" ||
         effect.kind === "weather" || effect.kind === "weather_and_stat_boost" ||
         effect.kind === "terrain" || effect.kind === "terrain_and_stat_boost") && trigger === "onBattleStart") {
      this.write(`${pokemon.name}'s ${ability.name} activated!`);
      const field = effect.field || effect.weather || effect.terrain;
      if (field) this.setField(field, 5, `${pokemon.name}'s ${ability.name}`);
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
    if (!move) return false;

    const targetMoves = new Set(["body-slam","breaking-swipe","bulldoze","brick-break","crunch","dragon-tail","growl","fire-fang","focus-blast","ice-fang","mud-shot","mud-slap","low-sweep","roar","rock-smash","scary-face","screech","snarl","taunt","thunder-fang","water-pulse","zen-headbutt"]);
    if (defender?.volatile?.protected && targetMoves.has(move.id)) {
      this.write(`${defender.name} protected itself!`);
      return true;
    }

    switch (move.id) {
      case "agility":
        this.changeStage(attacker, "speed", 2); return true;
      case "bulk-up":
        this.changeStage(attacker, "attack", 1); this.changeStage(attacker, "defense", 1); return true;
      case "dragon-cheer":
        attacker.volatile.critStage = Math.min(3, (attacker.volatile.critStage ?? 0) + (attacker.types.includes("Cosmos") ? 2 : 1));
        this.write(`${attacker.name}'s critical-hit ratio rose!`);
        return true;
      case "endure": {
        const streak = attacker.volatile.protectStreak ?? 0;
        const chance = Math.pow(1 / 3, streak);
        if (Math.random() >= chance) {
          attacker.volatile.protectStreak = 0;
          this.write(`${attacker.name}'s Endure failed!`);
          return false;
        }
        attacker.volatile.endure = true;
        attacker.volatile.protectStreak = streak + 1;
        this.write(`${attacker.name} braced itself!`);
        return true;
      }
      case "protect": {
        const streak = attacker.volatile.protectStreak ?? 0;
        const chance = Math.pow(1 / 3, streak);
        if (Math.random() >= chance) {
          attacker.volatile.protectStreak = 0;
          this.write(`${attacker.name}'s Protect failed!`);
          return false;
        }
        attacker.volatile.protected = true;
        attacker.volatile.protectStreak = streak + 1;
        this.write(`${attacker.name} protected itself!`);
        return true;
      }
      case "growl":
        this.changeStage(defender, "attack", -1); return true;
      case "scary-face":
        this.changeStage(defender, "speed", -2); return true;
      case "screech":
        this.changeStage(defender, "defense", -2); return true;
      case "swords-dance":
        this.changeStage(attacker, "attack", 2); return true;
      case "sunny-day":
        this.setField("Inferno", 5, attacker.name);
        return true;
      case "taunt":
        if (defender.volatile.tauntTurns > 0) {
          this.write(`${defender.name} is already taunted!`);
          return false;
        }
        defender.volatile.tauntTurns = 3;
        this.write(`${defender.name} fell for the taunt!`);
        return true;
      case "substitute": {
        if (attacker.volatile.substitute > 0) {
          this.write(`${attacker.name} already has a Substitute!`);
          return false;
        }
        const cost = Math.max(1, Math.floor(attacker.maxHP / 4));
        if (attacker.hp <= cost) {
          this.write(`${attacker.name} does not have enough HP to make a Substitute!`);
          return false;
        }
        attacker.hp -= cost;
        attacker.volatile.substitute = cost;
        this.write(`${attacker.name} put in a Substitute!`);
        return true;
      }
      case "rest":
        if (this.active("player")?.volatile?.uproarTurns > 0 || this.active("opponent")?.volatile?.uproarTurns > 0) {
          this.write("The uproar prevented Rest!");
          return false;
        }
        if (attacker.hp === attacker.maxHP && attacker.status !== "Sleep") {
          this.write(`${attacker.name} is already at full HP!`);
          return false;
        }
        attacker.hp = attacker.maxHP;
        attacker.status = "Sleep";
        attacker.statusData = { sleepTurns: 2 };
        this.write(`${attacker.name} went to sleep and restored its HP!`);
        return true;
      case "roost":
        if (attacker.hp === attacker.maxHP) {
          this.write(`${attacker.name} is already at full HP!`);
          return false;
        }
        attacker.hp = Math.min(attacker.maxHP, attacker.hp + Math.floor(attacker.maxHP / 2));
        if (attacker.types.includes("Air")) {
          attacker.types = attacker.types.filter(t => t !== "Air");
          attacker.volatile.roosted = true;
        }
        this.write(`${attacker.name} restored HP!`);
        return true;
      case "meteor-beam":
        // First use charges and raises Sp. Atk; the second use is the attack.
        if (attacker.volatile.charging !== "meteor-beam") {
          attacker.volatile.charging = "meteor-beam";
          this.changeStage(attacker, "specialAttack", 1);
          this.write(`${attacker.name} began charging Meteor Beam!`);
          return false;
        }
        attacker.volatile.charging = null;
        return true;
      case "solar-beam":
        return true;
      case "roar":
        if (!this.tryOpponentSwitch(true)) {
          this.write(`${defender.name} has no Pokémon left to switch to!`);
          return false;
        }
        return true;
      case "helping-hand":
        // This is a single-battle engine, so there is no ally target.
        this.write(`${attacker.name} tried to use Helping Hand, but it has no ally!`);
        return false;
      case "sleep-talk":
        return true;
      case "uproar":
        attacker.volatile.uproarTurns = 3;
        this.write(`${attacker.name} caused an uproar!`);
        return true;
      default:
        // Legacy effect data remains supported for simple healing/status/stage effects.
        for (const effect of move.effects ?? []) {
          if (effect.kind === "heal") {
            const amount = Math.floor(attacker.maxHP * (effect.percent ?? 0.5));
            attacker.hp = Math.min(attacker.maxHP, attacker.hp + amount);
            this.write(`${attacker.name} recovered HP!`);
          }
          if (effect.kind === "status") {
            if (Math.random() < (effect.chance ?? 1)) this.inflictStatus(defender, effect.status);
          }
          if (effect.kind === "stat_stage") {
            const target = effect.target === "opponent" ? defender : attacker;
            this.changeStage(target, effect.stat, Number(effect.stages ?? 0));
          }
        }
        return true;
    }
  }

  resetOnSwitch(pokemon) {
    if (!pokemon) return;
    pokemon.statStages = { attack: 0, defense: 0, specialAttack: 0, specialDefense: 0, speed: 0, accuracy: 0, evasion: 0 };
    const v = pokemon.volatile || {};
    for (const key of ["protected","endure","substitute","charging","recharge","focusPunch","focusPunchHit","confusedTurns","flinched","tauntTurns","trapTurns","trapSource","outrageTurns","uproarTurns","pendingUturn","roosted","protectStreak","critStage","lastMove","lastMoveFailed","lastDamageTaken"]) {
      if (key === "substitute" || key.endsWith("Turns") || key === "lastDamageTaken") v[key] = 0;
      else if (key === "trapSource" || key === "lastMove") v[key] = null;
      else v[key] = false;
    }
    pokemon.types = [...(pokemon.originalTypes || pokemon.types)];
  }

  tryOpponentSwitch(force = false) {
    const current = this.active("opponent");
    if (!force && (current?.volatile?.trapTurns > 0 || this.getStatusDef(current)?.statusEffect?.switchBlock)) {
      this.write(`${current.name} can't switch out right now!`);
      return false;
    }
    const next = this.opponent.team.findIndex(
      (p, i) => i !== this.opponent.active && p.canBattle()
    );
    if (next === -1) return false;

    this.resetOnSwitch(current);
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

    if (!forced && (this.active("player")?.volatile?.trapTurns > 0 || this.getStatusDef(this.active("player"))?.statusEffect?.switchBlock)) {
      this.write(`${this.active("player").name} can't switch out right now!`);
      return false;
    }

    // Normal switching cannot happen while an action is in progress.
    if (!forced && (this.busy || this.locked)) return false;

    if (index === this.player.active) return false;

    const target = this.player.team[index];
    if (!target?.canBattle()) return false;

    this.busy = true;
    this.locked = true;
    this.update();

    await this.pause(500);

    this.resetOnSwitch(this.active("player"));
    this.player.active = index;
    this.awaitingPlayerSwitch = false;

    this.write(`Go, ${target.name}!`);
    this.triggerAbility(target, "onBattleStart");

    await this.pause(900);

    // A forced switch happens after the fainted Pokémon's turn is over.
    // The opponent does not get an extra move just because the player switched.
    if (forced) {
      if (this.awaitingUturnSwitch) {
        this.awaitingUturnSwitch = false;
        this.busy = true;
        this.locked = true;
        const opponent = this.active("opponent");
        const opponentMove = opponent.canBattle() ? this.chooseOpponentMove() : null;
        if (opponentMove) {
          await this.pause(500);
          await this.performMove(opponent, this.active("player"), opponentMove);
        }
        if (!this.active("player").canBattle()) {
          await this.handlePlayerFaint();
          return true;
        }
        this.finishActionTurn();
        return true;
      }
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
