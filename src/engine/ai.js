export function makeAiTurn(battle) {
  const side = battle.getSide('opponent');
  battle.getActive('opponent').forEach((pokemon, slot) => {
    const legal = pokemon.moves.filter(id => battle.data.moves[id]);
    const moveId = chooseMove(battle, pokemon, legal);
    const targets = battle.getActive('player').filter(p => p.hp > 0);
    const targetIndex = Math.max(0, targets.findIndex(p => p.hp === Math.min(...targets.map(x => x.hp))));
    if (moveId) battle.chooseMove('opponent', slot, moveId, targetIndex);
  });
}

function chooseMove(battle, pokemon, legal) {
  if (!legal.length) return null;
  const target = battle.getActive('player').find(p => p.hp > 0);
  if (!target) return legal[0];
  return legal.slice().sort((a,b) => score(battle, pokemon, target, b) - score(battle, pokemon, target, a))[0];
}
function score(battle, attacker, defender, id) {
  const move = battle.data.moves[id];
  if (!move.power) return 10;
  const chart = battle.data.types.chart?.[move.type] || {};
  let eff = 1; for (const t of defender.types) eff *= chart[t] ?? 1;
  const stab = attacker.types.includes(move.type) ? 1.5 : 1;
  return move.power * eff * stab;
}
