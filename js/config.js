// Central game rules/configuration. Keep gameplay limits here instead of scattering magic numbers.
export const GAME_CONFIG = Object.freeze({
  team: Object.freeze({ maxPokemon: 9 }),
  battle: Object.freeze({ minSize: 1, maxSize: 3 }),
  matchmaking: Object.freeze({ minTrainersPerTeam: 1, maxTrainersPerTeam: 3 }),
  moves: Object.freeze({ maxBattleMoves: 4 }),
  level: Object.freeze({ min: 1, max: 100, default: 50 })
});

export const clampBattleSize = (value, fallback = GAME_CONFIG.battle.minSize) =>
  Math.max(GAME_CONFIG.battle.minSize, Math.min(GAME_CONFIG.battle.maxSize, Math.floor(Number(value) || fallback)));

export const clampTeamSize = (value, fallback = GAME_CONFIG.matchmaking.minTrainersPerTeam) =>
  Math.max(GAME_CONFIG.matchmaking.minTrainersPerTeam, Math.min(GAME_CONFIG.matchmaking.maxTrainersPerTeam, Math.floor(Number(value) || fallback)));

export const maxActivePerSide = (battleSize, teamSize) => clampBattleSize(battleSize) * clampTeamSize(teamSize);
