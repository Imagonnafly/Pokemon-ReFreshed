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

export function calculateAccuracy(attacker, defender, move, statusEffects = null) {
  // In the move data, 0 means “no accuracy check” (shown as — in Pokémon data).
  if (move.accuracy === null || move.accuracy === undefined || Number(move.accuracy) === 0) return 100;
  const base = Number(move.accuracy ?? 100);
  const atk = accuracyStageMultiplier(attacker.statStages?.accuracy ?? 0);
  const eva = accuracyStageMultiplier(defender.statStages?.evasion ?? 0);
  let multiplier = 1;
  if (statusEffects) {
    const attackerDef = Object.values(statusEffects).find(s => s?.status === attacker.status)?.statusEffect;
    const defenderDef = Object.values(statusEffects).find(s => s?.status === defender.status)?.statusEffect;
    multiplier *= Number(attackerDef?.accuracyMultiplier ?? 1);
    if (defenderDef?.evasionMultiplier) multiplier /= Number(defenderDef.evasionMultiplier);
  }
  return Math.max(1, Math.min(100, base * atk / eva * multiplier));
}

export function calculateDamage({ attacker, defender, move, typeChart, rng = Math.random, damageModifier = 1, attackerItem = null, defenderItem = null, weather = null, terrain = null, field = null, statusEffects = null, fieldEffects = null, criticalOverride = null }) {
  if (move.category === "status") return { damage: 0, effectiveness: 1, critical: false };

  const attackStat = move.damageStat || (move.category === "physical" ? "attack" : "specialAttack");
  const defenseStat = move.defenseStat || (move.category === "physical" ? "defense" : "specialDefense");
  const atk = Math.max(1, getBattleStat(attacker, attackStat, attackerItem));
  const def = Math.max(1, getBattleStat(defender, defenseStat, defenderItem));
  const power = Math.max(1, Number(move.power ?? 0));
  const level = attacker.level;

  const base = Math.floor(Math.floor(Math.floor((2 * level) / 5 + 2) * power * atk / def) / 50) + 2;
  const stab = move.types.some(t => attacker.types.includes(t)) ? 1.5 : 1;
  const effectiveness = typeEffectiveness(move.types, defender.types, typeChart);

  let environmentalModifier = 1;
  const activeField = field || weather || terrain || null;
  if (activeField && fieldEffects) {
    const fieldDef = Object.values(fieldEffects).find(f => f?.name === activeField);
    const typeMods = fieldDef?.damage || {};
    for (const moveType of move.types || []) {
      environmentalModifier *= Number(typeMods[moveType] ?? 1);
    }
  } else {
    // Legacy compatibility for older snapshots.
  }

  const signatureModifier = move.effects?.find(e => e.kind === "signature_super_effective_boost" && effectiveness > 1)?.multiplier ?? 1;
  const critStage = Number(move.critStage ?? 0);
  let criticalChance = 1 / 24;
  if (critStage >= 3) criticalChance = 1;
  else if (critStage === 2) criticalChance = 1 / 2;
  else if (critStage === 1) criticalChance = 1 / 8;
  const critical = criticalOverride ?? (rng() < criticalChance);
  const random = 0.85 + rng() * 0.15;

  let burnModifier = 1;
  const attackerStatusDef = statusEffects ? Object.values(statusEffects).find(s => s?.status === attacker.status)?.statusEffect : null;
  const defenderStatusDef = statusEffects ? Object.values(statusEffects).find(s => s?.status === defender.status)?.statusEffect : null;
  if (move.category === "physical" && attackerStatusDef?.physicalDamageMultiplier && !attacker.abilityIgnoreBurn) {
    burnModifier *= Number(attackerStatusDef.physicalDamageMultiplier);
  }
  if (move.category === "special" && attackerStatusDef?.specialDamageMultiplier) {
    burnModifier *= Number(attackerStatusDef.specialDamageMultiplier);
  }
  if (attackerStatusDef?.damageMultiplier) {
    burnModifier *= Number(attackerStatusDef.damageMultiplier);
  }
  if (defenderStatusDef?.damageTakenMultiplier) {
    burnModifier *= Number(defenderStatusDef.damageTakenMultiplier);
  }
  if (defenderStatusDef?.healingMultiplier && move.effects?.some(e => e.kind === "heal")) {
    burnModifier *= Number(defenderStatusDef.healingMultiplier);
  }

  let itemModifier = 1;
  const itemEffect = attackerItem?.effect;
  if (itemEffect?.kind === "damage_boost") itemModifier *= itemEffect.multiplier ?? 1;
  if (itemEffect?.kind === "category_boost" && itemEffect.category === move.category) itemModifier *= itemEffect.multiplier ?? 1;
  if (itemEffect?.kind === "super_effective_boost" && effectiveness > 1) itemModifier *= itemEffect.multiplier ?? 1;

  const damage = effectiveness === 0
    ? 0
    : Math.max(1, Math.floor(base * stab * effectiveness * (critical ? 1.5 : 1) * random * damageModifier * itemModifier * environmentalModifier * signatureModifier * burnModifier));

  return { damage, effectiveness, critical, itemModifier };
}
