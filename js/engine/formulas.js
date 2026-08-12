export function statValue(base, iv = 31, ev = 0, level = 50, nature = 1, hp = false) {
  const core = Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100);
  return hp ? core + level + 10 : Math.floor((core + 5) * nature);
}

export function calculateStats(species, level = 50) {
  const result = {};
  for (const [stat, base] of Object.entries(species.baseStats)) {
    result[stat] = statValue(base, 31, 0, level, 1, stat === "hp");
  }
  return result;
}

export function typeEffectiveness(moveTypes, defenderTypes, typeChart) {
  let multiplier = 1;
  for (const attackType of moveTypes) {
    for (const defendType of defenderTypes) {
      multiplier *= typeChart?.[attackType]?.[defendType] ?? 1;
    }
  }
  return multiplier;
}

export function stageMultiplier(stage) {
  const s = Math.max(-6, Math.min(6, stage ?? 0));
  return s >= 0 ? (2 + s) / 2 : 2 / (2 - s);
}

export function accuracyStageMultiplier(stage) {
  const s = Math.max(-6, Math.min(6, stage ?? 0));
  return s >= 0 ? (3 + s) / 3 : 3 / (3 - s);
}

export function getBattleStat(pokemon, stat, itemData = null) {
  let value = pokemon.stats[stat] ?? 0;
  value *= stageMultiplier(pokemon.statStages?.[stat] ?? 0);

  const effect = itemData?.effect;
  if (effect?.kind === "stat_multiplier" && effect.stat === stat) {
    value *= effect.multiplier ?? 1;
  }
  if (effect?.kind === "choice_boost" && effect.stat === stat) {
    value *= effect.multiplier ?? 1;
  }
  return Math.floor(value);
}

export function calculateAccuracy(attacker, defender, move) {
  if (move.accuracy === null || move.accuracy === undefined) return 100;
  const base = Number(move.accuracy ?? 100);
  const atk = accuracyStageMultiplier(attacker.statStages?.accuracy ?? 0);
  const eva = accuracyStageMultiplier(defender.statStages?.evasion ?? 0);
  return Math.max(1, Math.min(100, base * atk / eva));
}

export function calculateDamage({ attacker, defender, move, typeChart, rng = Math.random, damageModifier = 1, attackerItem = null, defenderItem = null }) {
  if (move.category === "status") return { damage: 0, effectiveness: 1, critical: false };

  const attackStat = move.category === "physical" ? "attack" : "specialAttack";
  const defenseStat = move.category === "physical" ? "defense" : "specialDefense";
  const atk = Math.max(1, getBattleStat(attacker, attackStat, attackerItem));
  const def = Math.max(1, getBattleStat(defender, defenseStat, defenderItem));
  const power = move.power ?? 0;
  const level = attacker.level;

  const base = Math.floor(Math.floor(Math.floor((2 * level) / 5 + 2) * power * atk / def) / 50) + 2;
  const stab = move.types.some(t => attacker.types.includes(t)) ? 1.5 : 1;
  const effectiveness = typeEffectiveness(move.types, defender.types, typeChart);
  const random = 0.85 + rng() * 0.15;
  const critical = rng() < 1 / 24 ? 1.5 : 1;

  let itemModifier = 1;
  const itemEffect = attackerItem?.effect;
  if (itemEffect?.kind === "damage_boost") itemModifier *= itemEffect.multiplier ?? 1;
  if (itemEffect?.kind === "category_boost" && itemEffect.category === move.category) itemModifier *= itemEffect.multiplier ?? 1;
  if (itemEffect?.kind === "super_effective_boost" && effectiveness > 1) itemModifier *= itemEffect.multiplier ?? 1;

  const damage = effectiveness === 0
    ? 0
    : Math.max(1, Math.floor(base * stab * effectiveness * critical * random * damageModifier * itemModifier));

  return { damage, effectiveness, critical: critical > 1, itemModifier };
}
