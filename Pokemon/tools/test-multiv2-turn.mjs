import fs from 'fs/promises';
globalThis.fetch = async (url) => { try { return {ok:true,status:200, text:async()=>await fs.readFile(new URL(url).pathname,'utf8')}; } catch {return {ok:false,status:404,text:async()=>''}} };
const {DataRepository}=await import('../js/engine/data.js');
const {MultiBattleV2}=await import('../js/engine/multi-battle-v2.js');
const data=await DataRepository.load();
const s=data.species.slice(0,10);const slot=x=>({species:x.id,level:50,moveset:x.learnset.slice(0,4)});const a=s.map(slot),b=s.slice().reverse().map(slot);
const battle=new MultiBattleV2({data,playerTeam:a,opponentTeam:b,battleSize:2});battle.onUpdate=()=>{};
for(const [side,team] of [['player',battle.player],['opponent',battle.opponent]]){
  for(let slotIndex=0;slotIndex<2;slotIndex++){
    const ti=team.active[slotIndex], p=team.team[ti], move=battle.getAvailableMovesFor(p)[0];
    if(side==='player') battle.pendingActions.player.push({kind:'move',slot:slotIndex,pokemonIndex:ti,moveId:move.id,targetSide:'opponent',targetIndex:battle.opponent.active[slotIndex]});
  }
}
await battle.resolveTurn(battle.pendingActions.player,battle.buildAIOpponentActions());
if(battle.turn!==2) throw new Error(`turn did not advance: ${battle.turn}`);
console.log('PASS resolution: turn',battle.turn,'busy',battle.busy,'pending',battle.pendingActions.player.length,battle.pendingActions.opponent.length);
