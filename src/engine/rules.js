export function typeEffectiveness(typesData, moveType, defenderTypes) {
  let multiplier = 1;
  for (const defenderType of defenderTypes) multiplier *= typesData.chart?.[moveType]?.[defenderType] ?? 1;
  return multiplier;
}

export function calculateStats(species, level = 50, ivs = {}, evs = {}) {
  const iv = key => Number(ivs[key] ?? 31);
  const ev = key => Number(evs[key] ?? 0);
  const stat = (base, key) => Math.floor(((2 * base + iv(key) + Math.floor(ev(key) / 4)) * level) / 100) + 5;
  const hp = Math.floor(((2 * species.baseStats.hp + iv('hp') + Math.floor(ev('hp') / 4)) * level) / 100) + level + 10;
  return {
    hp, attack: stat(species.baseStats.attack,'attack'), defense: stat(species.baseStats.defense,'defense'),
    specialAttack: stat(species.baseStats.specialAttack,'specialAttack'),
    specialDefense: stat(species.baseStats.specialDefense,'specialDefense'), speed: stat(species.baseStats.speed,'speed')
  };
}

export function stageMultiplier(stage) {
  const s = Math.max(-6, Math.min(6, stage));
  return s >= 0 ? (2 + s) / 2 : 2 / (2 - s);
}
