import { calculateStats, stageMultiplier, typeEffectiveness } from './rules.js';

const SIDE = { PLAYER: 'player', OPPONENT: 'opponent' };

export class Battle {
  constructor({ data, playerTeam, opponentTeam, battleSize = 1, rng = Math.random }) {
    this.data = data;
    this.config = data.config;
    this.rng = rng;
    this.listeners = new Set();
    this.battleSize = normalizeBattleSize(battleSize, this.config.battle.allowedSizes);
    this.turn = 1;
    this.phase = 'choosing';
    this.winner = null;
    this.messageQueue = [];
    this.teams = {
      player: createSide(this, SIDE.PLAYER, playerTeam),
      opponent: createSide(this, SIDE.OPPONENT, opponentTeam)
    };
    this.fillActive(SIDE.PLAYER);
    this.fillActive(SIDE.OPPONENT);
    this.setMessage(`Choose a move for ${this.activeNames(SIDE.PLAYER)}.`);
    this.emit();
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit() { const snapshot = this.snapshot(); for (const listener of this.listeners) listener(snapshot); }
  getSide(side) { return this.teams[side]; }
  getActive(side) { return this.getSide(side).active.map(i => this.getSide(side).team[i]).filter(Boolean); }
  activeNames(side) { return this.getActive(side).map(p => p.name).join(', '); }

  snapshot() {
    return structuredClone({
      turn: this.turn, phase: this.phase, winner: this.winner,
      battleSize: this.battleSize, messages: this.messageQueue.slice(-12),
      sides: this.teams
    });
  }

  setMessage(message) { this.messageQueue.push(message); }

  chooseMove(side, activeIndex, moveId, targetIndex = 0) {
    if (this.phase !== 'choosing') return { ok: false, error: 'The battle is not accepting moves right now.' };
    const sideState = this.getSide(side);
    const teamIndex = sideState.active[activeIndex];
    const pokemon = sideState.team[teamIndex];
    if (!pokemon || pokemon.hp <= 0) return { ok: false, error: 'That Pokémon cannot act.' };
    const move = this.data.moves[moveId];
    if (!move) return { ok: false, error: `Unknown move: ${moveId}.` };
    if (!pokemon.moves.includes(moveId)) return { ok: false, error: `${pokemon.name} does not know ${move.name}.` };
    sideState.choices[activeIndex] = { kind: 'move', moveId, targetIndex: Number(targetIndex) || 0 };
    this.setMessage(`${pokemon.name} selected ${move.name}.`);
    this.tryResolve();
    return { ok: true };
  }

  chooseSwitch(side, activeIndex, teamIndex) {
    if (this.phase !== 'choosing') return { ok: false, error: 'The battle is not accepting switches right now.' };
    const sideState = this.getSide(side);
    if (!Number.isInteger(teamIndex) || !sideState.team[teamIndex]) return { ok: false, error: 'Invalid Pokémon.' };
    if (sideState.team[teamIndex].hp <= 0 || sideState.active.includes(teamIndex)) return { ok: false, error: 'That Pokémon cannot switch in.' };
    sideState.choices[activeIndex] = { kind: 'switch', teamIndex };
    this.setMessage(`${this.getActive(side)[activeIndex]?.name ?? 'A Pokémon'} will switch.`);
    this.tryResolve();
    return { ok: true };
  }

  tryResolve() {
    if (!this.allChoicesReady(SIDE.PLAYER) || !this.allChoicesReady(SIDE.OPPONENT)) return;
    this.phase = 'resolving';
    this.emit();
    queueMicrotask(() => this.resolveTurn());
  }

  allChoicesReady(side) {
    const s = this.getSide(side);
    return s.active.every((_, i) => {
      const p = s.team[s.active[i]];
      return !p || p.hp <= 0 || Boolean(s.choices[i]);
    });
  }

  resolveTurn() {
    try {
      const actions = this.collectActions();
      actions.sort((a, b) => b.priority - a.priority || b.speed - a.speed || a.sideOrder - b.sideOrder);
      for (const action of actions) {
        if (this.winner) break;
        this.performAction(action);
        this.handleFaints();
      }
      if (!this.winner) this.endTurn();
    } catch (error) {
      console.error('Battle resolution failed:', error);
      this.phase = 'error';
      this.setMessage(`Battle engine error: ${error.message}`);
    }
    this.emit();
  }

  collectActions() {
    const actions = [];
    for (const side of [SIDE.PLAYER, SIDE.OPPONENT]) {
      const state = this.getSide(side);
      state.active.forEach((teamIndex, activeIndex) => {
        const p = state.team[teamIndex]; const choice = state.choices[activeIndex];
        if (!p || p.hp <= 0 || !choice) return;
        if (choice.kind === 'switch') actions.push({ type: 'switch', side, activeIndex, teamIndex, priority: 6, speed: 999, sideOrder: side === SIDE.PLAYER ? 1 : 0 });
        else {
          const move = this.data.moves[choice.moveId];
          actions.push({ type: 'move', side, activeIndex, teamIndex, move, targetIndex: choice.targetIndex, priority: Number(move.priority ?? 0), speed: effectiveSpeed(p), sideOrder: side === SIDE.PLAYER ? 1 : 0 });
        }
      });
    }
    return actions;
  }

  performAction(action) {
    if (action.type === 'switch') return this.performSwitch(action);
    const attacker = this.getSide(action.side).team[action.teamIndex];
    if (!attacker || attacker.hp <= 0) return;
    if (attacker.status?.id === 'sleep') {
      attacker.status.turns = (attacker.status.turns || 0) + 1;
      if (attacker.status.turns < (this.data.statuses.sleep?.maxTurns ?? 3)) { this.setMessage(`${attacker.name} is fast asleep.`); return; }
      attacker.status = null; this.setMessage(`${attacker.name} woke up.`);
    }
    if (attacker.status?.id === 'freeze') {
      if (this.rng() < (this.data.statuses.freeze?.thawChance ?? 0.2)) { attacker.status = null; this.setMessage(`${attacker.name} thawed out.`); }
      else { this.setMessage(`${attacker.name} is frozen solid.`); return; }
    }
    if (attacker.status?.id === 'paralysis' && this.rng() < (this.data.statuses.paralysis?.skipChance ?? 0.25)) { this.setMessage(`${attacker.name} is fully paralyzed.`); return; }
    const targetSide = action.side === SIDE.PLAYER ? SIDE.OPPONENT : SIDE.PLAYER;
    const target = this.resolveTarget(targetSide, action.targetIndex);
    if (!target) return;
    this.setMessage(`${attacker.name} used ${action.move.name}.`);
    if (action.move.category === 'status' || !action.move.power) this.applyMoveEffects(attacker, target, action.move, 0);
    else this.dealDamage(attacker, target, action.move);
  }

  resolveTarget(side, targetIndex) {
    const active = this.getActive(side).filter(p => p.hp > 0);
    if (!active.length) return null;
    return active[Math.max(0, Math.min(active.length - 1, Number(targetIndex) || 0))];
  }

  dealDamage(attacker, defender, move) {
    const offenseKey = move.category === 'special' ? 'specialAttack' : 'attack';
    const defenseKey = move.category === 'special' ? 'specialDefense' : 'defense';
    let attackStat = getStageAdjustedStat(attacker, offenseKey);
    if (attacker.status?.id === 'burn' && offenseKey === 'attack') attackStat *= this.data.config.statuses.burn.attackMultiplier;
    const defenseStat = getStageAdjustedStat(defender, defenseKey);
    const level = attacker.level;
    const stab = attacker.types.includes(move.type) ? this.data.config.damage.stabMultiplier : 1;
    const eff = typeEffectiveness(this.data.types, move.type, defender.types);
    const crit = this.rng() < this.data.config.damage.criticalChance ? this.data.config.damage.criticalMultiplier : 1;
    const random = this.data.config.damage.randomMin + this.rng() * (this.data.config.damage.randomMax - this.data.config.damage.randomMin);
    const base = Math.floor(Math.floor(((2 * level / 5 + 2) * move.power * attackStat / Math.max(1, defenseStat)) / 50) + 2);
    let damage = Math.max(1, Math.floor(base * stab * eff * crit * random));
    defender.hp = Math.max(0, defender.hp - damage);
    this.setMessage(`${defender.name} lost ${damage} HP.`);
    if (eff > 1) this.setMessage(this.data.config.damage.superEffectiveMessage);
    if (eff > 0 && eff < 1) this.setMessage(this.data.config.damage.notVeryEffectiveMessage);
    if (eff === 0) this.setMessage(`It doesn't affect ${defender.name}.`);
    if (crit > 1) this.setMessage('A critical hit!');
    if (damage > 0) this.applyMoveEffects(attacker, defender, move, damage);
  }

  applyMoveEffects(attacker, defender, move, damage) {
    for (const effect of move.effects ?? []) {
      const chance = effect.kind.includes('status') ? Number(effect.chance ?? 1) : 1;
      if (this.rng() > chance) continue;
      switch (effect.kind) {
        case 'burn': this.tryStatus(defender, 'burn'); break;
        case 'paralysis': this.tryStatus(defender, 'paralysis'); break;
        case 'freeze': this.tryStatus(defender, 'freeze'); break;
        case 'poison': this.tryStatus(defender, 'poison'); break;
        case 'attack': changeStage(defender, 'attack', Number(effect.value)); break;
        case 'specialAttack': changeStage(defender, 'specialAttack', Number(effect.value)); break;
        case 'defense': changeStage(defender, 'defense', Number(effect.value)); break;
        case 'specialDefense': changeStage(defender, 'specialDefense', Number(effect.value)); break;
        case 'self-speed': changeStage(attacker, 'speed', Number(effect.value)); break;
        case 'self-defense': changeStage(attacker, 'defense', Number(effect.value)); break;
        case 'self-specialDefense': changeStage(attacker, 'specialDefense', Number(effect.value)); break;
        case 'heal': attacker.hp = Math.min(attacker.maxHp, attacker.hp + Math.floor(attacker.maxHp * Number(effect.value))); this.setMessage(`${attacker.name} restored HP.`); break;
        case 'heal-damage': attacker.hp = Math.min(attacker.maxHp, attacker.hp + Math.floor(damage * Number(effect.value))); this.setMessage(`${attacker.name} absorbed some HP.`); break;
        case 'recoil': attacker.hp = Math.max(0, attacker.hp - Math.floor(damage * Number(effect.value))); break;
      }
    }
  }

  tryStatus(pokemon, id) {
    if (pokemon.hp <= 0 || pokemon.status) return;
    pokemon.status = { id, turns: 0, counter: 1 };
    this.setMessage(`${pokemon.name} was afflicted with ${this.data.statuses[id]?.label ?? id}.`);
  }

  performSwitch(action) {
    const side = this.getSide(action.side);
    side.active[action.activeIndex] = action.teamIndex;
    side.choices[action.activeIndex] = null;
    const p = side.team[action.teamIndex];
    this.setMessage(`${p.name} entered the battle.`);
  }

  handleFaints() {
    for (const sideName of [SIDE.PLAYER, SIDE.OPPONENT]) {
      const side = this.getSide(sideName);
      side.active.forEach((teamIndex, activeIndex) => {
        const p = side.team[teamIndex];
        if (p && p.hp <= 0 && !p.faintedAnnounced) { p.faintedAnnounced = true; this.setMessage(`${p.name} fainted!`); }
      });
    }
    const playerAlive = this.getSide(SIDE.PLAYER).team.some(p => p.hp > 0);
    const opponentAlive = this.getSide(SIDE.OPPONENT).team.some(p => p.hp > 0);
    if (!playerAlive || !opponentAlive) { this.winner = playerAlive ? SIDE.PLAYER : SIDE.OPPONENT; this.phase = 'finished'; this.setMessage(this.winner === SIDE.PLAYER ? 'You won the battle!' : 'You lost the battle.'); return; }
    this.fillActive(SIDE.PLAYER); this.fillActive(SIDE.OPPONENT);
  }

  fillActive(sideName) {
    const side = this.getSide(sideName);
    for (let slot = 0; slot < this.battleSize; slot++) {
      const current = side.active[slot];
      if (side.team[current]?.hp > 0) continue;
      const replacement = side.team.findIndex((p, index) => p.hp > 0 && !side.active.includes(index));
      side.active[slot] = replacement >= 0 ? replacement : null;
      side.choices[slot] = null;
    }
  }

  endTurn() {
    applyEndTurnStatus(this, SIDE.PLAYER);
    applyEndTurnStatus(this, SIDE.OPPONENT);
    this.turn += 1; this.phase = 'choosing';
    this.getSide(SIDE.PLAYER).choices = Array(this.battleSize).fill(null);
    this.getSide(SIDE.OPPONENT).choices = Array(this.battleSize).fill(null);
    const freePlayer = this.getActive(SIDE.PLAYER).filter(p => p.hp > 0);
    const freeOpponent = this.getActive(SIDE.OPPONENT).filter(p => p.hp > 0);
    if (!freePlayer.length || !freeOpponent.length) { this.handleFaints(); return; }
    this.setMessage(`Turn ${this.turn}: choose your moves.`);
  }
}

function createSide(battle, side, team) {
  const hydrated = team.slice(0, battle.config.battle.maxTeamSize).map((set, i) => hydratePokemon(battle, set, side, i));
  return { side, team: hydrated, active: Array(battle.battleSize).fill(null), choices: Array(battle.battleSize).fill(null) };
}

function hydratePokemon(battle, set, side, index) {
  const species = battle.data.species[set.species];
  if (!species) throw new Error(`Unknown species: ${set.species}`);
  const level = Number(set.level || battle.config.battle.defaultLevel);
  const stats = calculateStats(species, level, set.ivs, set.evs);
  return {
    uid: `${side}-${index}-${crypto.randomUUID()}`, speciesId: species.id, name: species.name, level,
    types: [...species.types], baseStats: {...species.baseStats}, stats, maxHp: stats.hp, hp: stats.hp,
    moves: (set.moves || species.moveset || []).slice(0, battle.config.battle.maxBattleMoves), ability: set.ability || species.abilities?.[0] || null,
    sprites: {...species.sprites}, status: null, stages: {attack:0,defense:0,specialAttack:0,specialDefense:0,speed:0}, faintedAnnounced: false
  };
}

function effectiveSpeed(p) {
  let value = getStageAdjustedStat(p, 'speed');
  if (p.status?.id === 'paralysis') value *= 0.5;
  return value;
}
function getStageAdjustedStat(p, key) { return p.stats[key] * stageMultiplier(p.stages?.[key] ?? 0); }
function changeStage(p, key, amount) { p.stages[key] = Math.max(-6, Math.min(6, (p.stages[key] || 0) + amount)); }
function applyEndTurnStatus(battle, sideName) {
  for (const p of battle.getSide(sideName).team) {
    if (p.hp <= 0 || !p.status) continue;
    const id = p.status.id; const def = battle.data.statuses[id];
    if (id === 'burn' || id === 'poison' || id === 'bad-poison') {
      let damage = Math.max(1, Math.floor(p.maxHp * (def.damageFraction || 0)) * (def.escalating ? (p.status.counter || 1) : 1));
      p.hp = Math.max(0, p.hp - damage); battle.setMessage(`${p.name} is hurt by ${def.label}.`); if (def.escalating) p.status.counter = Math.min(16, (p.status.counter || 1) + 1);
    }
  }
}
function normalizeBattleSize(value, allowed) { const v = Number(value) || allowed[0]; return allowed.includes(v) ? v : allowed[0]; }
