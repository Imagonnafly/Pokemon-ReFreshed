import { GAME_CONFIG, clampBattleSize } from "../config.js";
import { Battle } from './battle.js';

const MAX = GAME_CONFIG.battle.maxSize;
const clampN = n => Math.max(1, Math.min(MAX, Math.floor(Number(n) || 1)));

export class MultiBattleV2 extends Battle {
  constructor({ data, playerTeam, opponentTeam, networkRole = null, battleSize = 2 }) {
    super({ data, playerTeam, opponentTeam, networkRole });
    this.isMulti = true;
    this.battleSize = Math.min(clampN(battleSize), this.player.team.length, this.opponent.team.length);
    this.player.active = Array.from({ length: this.battleSize }, (_, i) => i);
    this.opponent.active = Array.from({ length: this.battleSize }, (_, i) => i);
    this.pendingActions = { player: [], opponent: [] };
    this.localActionsSubmitted = false;
    this.remoteActionsSubmitted = false;
    this.busy = false;
    this.locked = false;
    this.log = [];
    this.write(`Battle started — ${this.battleSize}v${this.battleSize}!`);
    for (const i of this.activeIndices('opponent')) this.write(`The opposing Pokémon ${this.opponent.team[i].name} entered the battle!`);
    for (const i of this.activeIndices('player')) this.write(`Your Pokémon ${this.player.team[i].name} entered the battle!`);
    for (const side of ['player', 'opponent']) for (const i of this.activeIndices(side)) this.triggerAbility(this[side].team[i], 'onBattleStart');
  }

  active(side) {
    const indices = this.activeIndices(side);
    return indices.length ? this[side].team[indices[0]] : null;
  }
  activeIndices(side) {
    const state = this[side];
    if (!state) return [];
    const active = Array.isArray(state.active) ? state.active : [state.active];
    return active.filter(i => Number.isInteger(i) && state.team[i]?.canBattle());
  }
  activePokemon(side) { return this.activeIndices(side).map(i => this[side].team[i]); }
  requiredSlots(side) {
    const state = this[side];
    const active = Array.isArray(state?.active) ? state.active : [];
    return active.map((teamIndex, slot) => state.team[teamIndex]?.canBattle() ? slot : null).filter(slot => slot !== null);
  }
  getPending(side) { return Array.isArray(this.pendingActions?.[side]) ? this.pendingActions[side] : []; }
  actionForSlot(side, slot) { return this.getPending(side).find(a => a.slot === slot) || null; }

  getAvailableMovesFor(pokemon) {
    if (!pokemon?.canBattle()) return [];
    let moves = pokemon.moves.filter(m => {
      const forced = pokemon.volatile?.charging === m.id || (pokemon.volatile?.outrageTurns > 0 && m.id === 'outrage') || (pokemon.volatile?.uproarTurns > 0 && m.id === 'uproar');
      if ((m.pp ?? 1) <= 0 && !forced) return false;
      if (pokemon.volatile?.tauntTurns > 0 && m.category === 'status') return false;
      return true;
    });
    if (pokemon.volatile?.charging) moves = moves.filter(m => m.id === pokemon.volatile.charging);
    if (pokemon.volatile?.outrageTurns > 0) moves = moves.filter(m => m.id === 'outrage');
    if (pokemon.volatile?.uproarTurns > 0) moves = moves.filter(m => m.id === 'uproar');
    return moves;
  }
  getAvailableMoves() { return this.getAvailableMovesFor(this.active('player')); }

  isCompleteActionSet(actions, side) {
    if (!Array.isArray(actions)) return false;
    const expected = new Set(this.requiredSlots(side));
    const seen = new Set();
    for (const action of actions) {
      const slot = Number(action?.slot);
      if (!expected.has(slot) || seen.has(slot)) return false;
      seen.add(slot);
    }
    return seen.size === expected.size;
  }

  getTargetMode(move) {
    const explicit = String(move?.target || move?.targeting || '').toLowerCase();
    const selfMoves = new Set(['agility','bulk-up','dragon-cheer','endure','protect','rest','roost','substitute','sunny-day','swords-dance','sleep-talk']);
    if (explicit === 'self' || selfMoves.has(move?.id)) return 'self';
    if (['ally','ally-one','teammate','player'].includes(explicit) || move?.id === 'helping-hand') return 'ally';
    if (['any','all'].includes(explicit)) return 'any';
    return 'opponent';
  }

  resolveTarget(actor, move, targetSide, targetIndex, actorSide, actorSlot) {
    const mode = this.getTargetMode(move);
    const ownIndex = this[actorSide]?.active?.[actorSlot];
    if (mode === 'self') return ownIndex === undefined ? null : { side: actorSide, index: ownIndex };
    if (mode === 'ally') {
      const allies = this.activeIndices(actorSide).filter(i => i !== ownIndex);
      const idx = allies.includes(Number(targetIndex)) ? Number(targetIndex) : allies[0];
      return idx === undefined ? null : { side: actorSide, index: idx };
    }
    if (mode === 'any') {
      const enemySide = actorSide === 'player' ? 'opponent' : 'player';
      const candidates = [...this.activeIndices(actorSide).map(index => ({side:actorSide,index})), ...this.activeIndices(enemySide).map(index => ({side:enemySide,index}))];
      return candidates.find(t => t.side === targetSide && t.index === Number(targetIndex)) || candidates.find(t => t.side === enemySide) || candidates[0] || null;
    }
    const enemySide = actorSide === 'player' ? 'opponent' : 'player';
    const enemies = this.activeIndices(enemySide);
    const idx = enemies.includes(Number(targetIndex)) ? Number(targetIndex) : enemies[0];
    return idx === undefined ? null : { side: enemySide, index: idx };
  }

  setLocalAction(slot, moveId, targetSide = 'opponent', targetIndex = null) {
    if (this.over || this.busy) return false;
    const teamIndex = this.player.active?.[slot];
    const actor = this.player.team[teamIndex];
    const move = actor?.moves?.find(m => m.id === moveId);
    if (!actor?.canBattle() || !this.canSelectMove(actor, move)) return false;
    const target = this.resolveTarget(actor, move, targetSide, targetIndex, 'player', slot);
    if (!target) return false;
    this.pendingActions.player = this.getPending('player').filter(a => a.slot !== slot);
    this.pendingActions.player.push({ kind:'move', slot, pokemonIndex:teamIndex, moveId:move.id, targetSide:target.side, targetIndex:target.index });
    this.pendingActions.player.sort((a,b)=>a.slot-b.slot);
    this.localActionsSubmitted = this.isCompleteActionSet(this.pendingActions.player, 'player');
    this.write(`${actor.name}'s action is locked in.`);
    this.syncNetwork();
    if (!this.networkRole && this.localActionsSubmitted) this.resolveTurn(this.pendingActions.player, this.buildAIOpponentActions());
    return true;
  }

  setLocalSwitch(slot, targetIndex) {
    if (this.over || this.busy) return false;
    const teamIndex=this.player.active?.[slot], actor=this.player.team[teamIndex], target=this.player.team[targetIndex];
    if (!actor?.canBattle() || !target?.canBattle() || this.player.active.includes(targetIndex)) return false;
    this.pendingActions.player=this.getPending('player').filter(a=>a.slot!==slot);
    this.pendingActions.player.push({kind:'switch',slot,pokemonIndex:teamIndex,targetIndex});
    this.pendingActions.player.sort((a,b)=>a.slot-b.slot);
    this.localActionsSubmitted=this.isCompleteActionSet(this.pendingActions.player,'player');
    this.write(`${actor.name} will switch to ${target.name}.`);
    this.syncNetwork();
    if(!this.networkRole && this.localActionsSubmitted) this.resolveTurn(this.pendingActions.player,this.buildAIOpponentActions());
    return true;
  }

  buildAIOpponentActions() {
    const actions=[];
    for(const slot of this.requiredSlots('opponent')){
      const teamIndex=this.opponent.active[slot], p=this.opponent.team[teamIndex];
      const moves=this.getAvailableMovesFor(p); const move=moves[Math.floor(Math.random()*moves.length)]||moves[0]||p.moves[0];
      if(!move) continue; const target=this.resolveTarget(p,move,'player',null,'opponent',slot);
      if(target) actions.push({kind:'move',slot,pokemonIndex:teamIndex,moveId:move.id,targetSide:target.side,targetIndex:target.index});
    }
    return actions;
  }

  async receiveRemoteActions(actions){
    if(this.networkRole!=='host'||this.over||this.busy)return false;
    const incoming=Array.isArray(actions)?actions.map(a=>({...a})):[];
    if(!this.isCompleteActionSet(incoming,'opponent')){
      this.write(`Opponent actions received: ${incoming.length}/${this.requiredSlots('opponent').length}. Waiting for the rest.`);
      this.syncNetwork(); return false;
    }
    this.pendingActions.opponent=incoming; this.remoteActionsSubmitted=true; this.syncNetwork();
    return this.tryResolveNetworkTurn();
  }

  async tryResolveNetworkTurn(){
    if(this.networkRole!=='host'||this.busy||this.over)return;
    if(!this.isCompleteActionSet(this.pendingActions.player,'player'))return;
    if(!this.isCompleteActionSet(this.pendingActions.opponent,'opponent'))return;
    const playerActions=this.pendingActions.player.map(a=>({...a}),), opponentActions=this.pendingActions.opponent.map(a=>({...a}));
    this.pendingActions={player:[],opponent:[]}; this.localActionsSubmitted=false; this.remoteActionsSubmitted=false;
    await this.resolveTurn(playerActions,opponentActions);
  }

  async resolveTurn(playerActions,opponentActions){
    if(this.busy||this.over)return;
    this.busy=true; this.locked=true; this.syncNetwork();
    this.write('All active Pokémon have chosen — resolving the turn...');
    const actions=[...(playerActions||[]).map(a=>({...a,side:'player'})),...(opponentActions||[]).map(a=>({...a,side:'opponent'}))]
      .filter(a=>this[a.side]?.team?.[a.pokemonIndex]?.canBattle()).sort((a,b)=>this.compareActions(a,b));

    for(const action of actions){
      const side=action.side, actor=this[side].team[action.pokemonIndex];
      if(!actor?.canBattle())continue;
      if(action.kind==='switch'){this.executeSwitch(side,action.slot,action.targetIndex);await this.pause(100);continue;}
      const move=actor.moves.find(m=>m.id===action.moveId); if(!move)continue;
      let targetSide=action.targetSide==='player'||action.targetSide==='opponent'?action.targetSide:(side==='player'?'opponent':'player');
      let targetIndex=action.targetIndex;
      let defender=this[targetSide]?.team?.[targetIndex];
      if(this.getTargetMode(move)==='self') defender=actor;
      if(!defender?.canBattle()){
        const fallback=this.resolveTarget(actor,move,targetSide,null,side,action.slot);
        if(fallback){targetSide=fallback.side;targetIndex=fallback.index;defender=this[targetSide].team[targetIndex];}
      }
      if(!defender?.canBattle())continue;
      await this.performMove(actor,defender,move); await this.pause(80);
    }

    this.autoFillFaintedSlots();
    if(this.sideHasNoUsable('player')){this.end(false);this.busy=false;this.locked=false;this.syncNetwork();return;}
    if(this.sideHasNoUsable('opponent')){this.end(true);this.busy=false;this.locked=false;this.syncNetwork();return;}
    this.finishMultiTurn();
  }

  compareActions(a,b){
    if(a.kind==='switch'&&b.kind!=='switch')return -1; if(b.kind==='switch'&&a.kind!=='switch')return 1;
    const ap=this[a.side].team[a.pokemonIndex],bp=this[b.side].team[b.pokemonIndex];
    const am=ap?.moves?.find(m=>m.id===a.moveId)||ap?.moves?.[0],bm=bp?.moves?.find(m=>m.id===b.moveId)||bp?.moves?.[0];
    const pa=a.kind==='switch'?100:this.getMovePriority(am,ap),pb=b.kind==='switch'?100:this.getMovePriority(bm,bp);
    if(pa!==pb)return pb-pa; const sa=this.getStat(ap,'speed'),sb=this.getStat(bp,'speed'); if(sa!==sb)return sb-sa; return Math.random()<0.5?-1:1;
  }

  executeSwitch(side,slot,targetIndex){
    const state=this[side], currentIndex=state.active?.[slot], current=state.team[currentIndex], target=state.team[targetIndex];
    if(!current?.canBattle()||!target?.canBattle()||state.active.includes(targetIndex))return false;
    this.resetOnSwitch(current); state.active[slot]=targetIndex; this.triggerAbility(target,'onBattleStart');
    this.write(`${side==='player'?'Your Pokémon':'The opposing Pokémon'} ${current.name} was switched out for ${target.name}!`); return true;
  }

  autoFillFaintedSlots(){
    for(const side of ['player','opponent']){
      const state=this[side], active=[...(state.active||[])], used=new Set(active.filter(Number.isInteger));
      for(let slot=0;slot<this.battleSize;slot++){
        const current=state.team[active[slot]]; if(current?.canBattle())continue;
        const next=state.team.findIndex((p,i)=>p?.canBattle()&&!used.has(i)); if(next<0)continue;
        active[slot]=next;used.add(next);this.triggerAbility(state.team[next],'onBattleStart');
        this.write(`${side==='player'?'Your side sent out':'The opposing side sent out'} ${state.team[next].name}!`);
      }
      state.active=active;
    }
  }

  applyEndTurnStatus(){
    for(const side of ['player','opponent']) for(const index of this.activeIndices(side)){
      const pokemon=this[side].team[index];
      if(!pokemon?.canBattle() || !pokemon.status) continue;
      const def=this.getStatusDef(pokemon); const effect=def?.statusEffect || {}; const percent=Number(effect.endTurnDamage??0);
      if(percent>0){pokemon.receiveDamage(Math.max(1,Math.floor(pokemon.maxHP*percent)));this.write(`${pokemon.name} was hurt by ${pokemon.status}!`);}
      if(pokemon.statusData) pokemon.statusData.turns=(pokemon.statusData.turns??0)+1;
      if(pokemon.volatile?.trapTurns>0&&pokemon.canBattle()){pokemon.receiveDamage(Math.max(1,Math.floor(pokemon.maxHP/8)));this.write(`${pokemon.name} was hurt by the trapping flames!`);}
    }
  }

  applyEndTurnItems(){
    for(const side of ['player','opponent']) for(const index of this.activeIndices(side)){
      const pokemon=this[side].team[index]; if(!pokemon?.canBattle()) continue;
      const item=this.getItem(pokemon); if(item?.effect?.kind!=='end_turn_heal') continue;
      const amount=Math.max(1,Math.floor(pokemon.maxHP*(item.effect.percent??0.0625))); const old=pokemon.hp; pokemon.hp=Math.min(pokemon.maxHP,pokemon.hp+amount);
      if(pokemon.hp>old)this.write(`${pokemon.name} restored HP with its ${item.name}!`);
    }
  }

  finishMultiTurn(){
    this.applyEndTurnStatus(); this.applyEndTurnItems();
    if(this.fieldTurns>0){this.fieldTurns--;if(this.fieldTurns<=0){this.field=null;this.write('The battlefield returned to normal.');}}
    for(const side of ['player','opponent'])for(const index of this.activeIndices(side)){
      const p=this[side].team[index];if(!p?.volatile)continue;p.volatile.protected=false;p.volatile.endure=false;p.volatile.flinched=false;
      if(p.volatile.roosted){p.types=[...(p.originalTypes||p.types)];p.volatile.roosted=false;}p.volatile.lastDamageTaken=0;
      if(p.volatile.tauntTurns>0)p.volatile.tauntTurns--; if(p.volatile.trapTurns>0)p.volatile.trapTurns--; if(p.volatile.uproarTurns>0)p.volatile.uproarTurns--;
    }
    this.autoFillFaintedSlots();
    this.busy=false;this.locked=false;this.pendingActions={player:[],opponent:[]};this.localActionsSubmitted=false;this.remoteActionsSubmitted=false;
    this.turnContext={damageTaken:new Map(),physicalDamageTaken:new Map(),moveFailed:new Map()}; this.turn++; this.syncNetwork();
  }

  tryOpponentSwitch(){
    const active=Array.isArray(this.opponent.active)?this.opponent.active:[this.opponent.active];
    const slot=active.findIndex(i=>this.opponent.team[i]?.canBattle()) >= 0 ? active.findIndex(i=>this.opponent.team[i]?.canBattle()) : 0;
    const next=this.opponent.team.findIndex((p,i)=>p?.canBattle()&&!active.includes(i));
    if(next<0)return false; const currentIndex=active[slot]; const current=this.opponent.team[currentIndex];
    if(current?.canBattle())this.resetOnSwitch(current); active[slot]=next; this.opponent.active=active;
    const replacement=this.opponent.team[next]; this.triggerAbility(replacement,'onBattleStart'); this.write(`The opposing side sent out ${replacement.name}!`); return true;
  }

  sideHasNoUsable(side){return this[side].team.every(p=>!p.canBattle());}
  syncNetwork(){try{this.updateNetworkState?.();}catch{} this.update();}
  end(playerWon){this.over=true;this.result=this.networkRole==='host'?{winnerRole:playerWon?'host':'guest'}:this.networkRole==='guest'?{winnerRole:playerWon?'host':'guest'}:{winnerRole:playerWon?'local':'remote'};this.write(playerWon?'Your side won the battle!':'Your side lost the battle!');}
  isSidePokemon(side,p){return this[side]?.team?.includes(p);}
  getBattleMessagePrefix(p){return this.isSidePokemon('player',p)?'Your Pokémon':'The opposing Pokémon';}
}
