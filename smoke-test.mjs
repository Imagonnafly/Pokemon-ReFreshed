import fs from 'node:fs/promises';
import { Battle } from './src/engine/battle.js';

const root = new URL('./data/', import.meta.url);
const read = async p => JSON.parse(await fs.readFile(new URL(p, root), 'utf8'));
const config = await read('config.json');
const types = await read('types.json');
const statuses = await read('statuses.json');
const teams = await read('teams.json');
const speciesIds = await read('species/index.json');
const moveIds = await read('moves/index.json');
const species = Object.fromEntries(await Promise.all(speciesIds.map(async id => [id, await read(`species/${id}.json`)])));
const moves = Object.fromEntries(await Promise.all(moveIds.map(async id => [id, await read(`moves/${id}.json`)])));
const data = { config, types, statuses, species, moves, teams };

for (const size of [1, 2, 3]) {
  const battle = new Battle({ data, playerTeam: teams.player, opponentTeam: teams.opponent, battleSize: size, rng: () => 0.99 });
  let loops = 0;
  while (!['finished','error'].includes(battle.phase) && loops++ < 20) {
    if (battle.phase === 'choosing') {
      const active = battle.getActive('player');
      for (let slot = 0; slot < active.length; slot++) {
        const p = active[slot];
        if (p?.hp > 0 && !battle.getSide('player').choices[slot]) {
          const move = p.moves.find(id => data.moves[id]);
          battle.chooseMove('player', slot, move, 0);
        }
      }
      const op = battle.getSide('opponent');
      for (let slot = 0; slot < op.active.length; slot++) {
        const p = op.active[slot] == null ? null : op.team[op.active[slot]];
        if (p?.hp > 0 && !op.choices[slot]) {
          battle.chooseMove('opponent', slot, p.moves.find(id => data.moves[id]), 0);
        }
      }
      if (battle.phase === 'resolving') await new Promise(r => setImmediate(r));
    } else if (battle.phase === 'resolving') {
      await new Promise(r => setImmediate(r));
    }
  }
  if (battle.phase === 'error') throw new Error(`size ${size}: ${battle.snapshot().messages.at(-1)}`);
  console.log(`PASS ${size}v${size}: phase=${battle.phase}, turn=${battle.turn}`);
}
