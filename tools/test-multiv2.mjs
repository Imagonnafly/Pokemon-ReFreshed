import fs from 'fs/promises';
import path from 'path';
const root = path.resolve(new URL('../data/', import.meta.url).pathname);
globalThis.fetch = async (url) => {
  const file = new URL(url).pathname;
  try { const text = await fs.readFile(file, 'utf8'); return { ok:true, status:200, async text(){return text;} }; }
  catch { return { ok:false, status:404, async text(){return '';} }; }
};
const { DataRepository } = await import('../js/engine/data.js');
const { MultiBattleV2 } = await import('../js/engine/multi-battle-v2.js');
const data = await DataRepository.load();
const species = data.species.slice(0, 10);
const toSlot = s => ({species:s.id, level:50, moveset:(s.learnset||[]).filter(id=>data.moves.some(m=>m.id===id)).slice(0,4), ability:s.abilities?.[0]||null, item:null});
const teamA = species.map(toSlot);
const teamB = species.slice().reverse().map(toSlot);
for (const n of [2,3,5,10]) {
  const b = new MultiBattleV2({data, playerTeam:teamA, opponentTeam:teamB, battleSize:n});
  b.onUpdate=()=>{};
  if (b.player.active.length !== n || b.opponent.active.length !== n) throw new Error(`active length ${n}`);
  const p0=b.player.team[b.player.active[0]];
  const move=b.getAvailableMovesFor(p0)[0];
  if (!move) throw new Error('no move');
  const target=b.opponent.active[0];
  if (!b.setLocalAction(0,move.id,'opponent',target)) throw new Error(`could not set action ${n}`);
  const bench=b.player.team.findIndex((p,i)=>p.canBattle()&&!b.player.active.includes(i));
  if (bench >= 0) { b.pendingActions.player=[]; b.setLocalSwitch(0,bench); }
  console.log(`PASS ${n}v${n}: active=${b.player.active.length}, move=${move.name}, switch=${bench>=0}`);
}
