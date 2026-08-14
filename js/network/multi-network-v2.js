function hydratePokemon(data, raw) {
  if (!raw) return null;
  const species = data.species.find(s => s.id === raw.speciesId);
  if (!species) return null;
  const moves = (raw.moveset || raw.moves || []).map(m => typeof m === 'string' ? data.moves.find(x => x.id === m) : m).filter(Boolean).slice(0, 4);
  return {
    ...raw,
    name: raw.name || species.name,
    level: raw.level ?? 50,
    types: [...(raw.types || species.types || [])],
    originalTypes: [...(raw.originalTypes || raw.types || species.types || [])],
    moves,
    sprites: { ...(raw.sprites || species.sprites || {}) },
    statusData: { ...(raw.statusData || {}) },
    volatile: { ...(raw.volatile || {}) },
    hp: Number(raw.hp ?? raw.maxHP ?? 1),
    maxHP: Number(raw.maxHP ?? raw.hp ?? 1),
    status: raw.status || null,
    fainted: !!raw.fainted,
    canBattle() { return !this.fainted && this.hp > 0; }
  };
}

export class RemoteMultiBattleV2 {
  constructor({ data, role = 'guest', team = [], battleSize = 2 }) {
    this.data = data;
    this.networkRole = role;
    this.isMulti = true;
    this.battleSize = Math.max(2, Math.min(10, Number(battleSize) || 2));
    this.turn = 1;
    this.over = false;
    this.busy = false;
    this.locked = false;
    this.field = null;
    this.fieldTurns = 0;
    this.result = null;
    this.log = [];
    this.localActions = [];
    this.remoteActionsCount = 0;
    this.player = { team: [], active: [] };
    this.opponent = { team: [], active: [] };
    this.onUpdate = null;
    this.sendActions = null;
  }

  hydrateSide(raw) {
    return {
      team: Array.isArray(raw?.team) ? raw.team.map(p => hydratePokemon(this.data, p)).filter(Boolean) : [],
      active: Array.isArray(raw?.active) ? [...raw.active] : [Number(raw?.active || 0)]
    };
  }
  active(side) { const s = this[side]; return s?.team?.[s.active?.[0]] || null; }
  activeIndices(side) { const s = this[side]; return (s?.active || []).filter(i => s.team[i]?.canBattle()); }
  getAvailableMovesFor(p) { return (p?.moves || []).filter(m => (m.pp ?? 1) > 0 && !(p.volatile?.tauntTurns > 0 && m.category === 'status')); }
  requiredSlots() { return this.activeIndices('player').length; }
  actionForSlot(slot) { return this.localActions.find(a => a.slot === slot) || null; }

  setLocalAction(slot, moveId, targetSide = 'opponent', targetIndex = null) {
    if (this.over || this.busy) return false;
    const index = this.player.active?.[slot], p = this.player.team[index], move = p?.moves?.find(m => m.id === moveId);
    if (!p?.canBattle() || !move) return false;
    this.localActions = this.localActions.filter(a => a.slot !== slot);
    this.localActions.push({ kind:'move', slot, pokemonIndex:index, moveId, targetSide, targetIndex });
    this.localActions.sort((a,b) => a.slot - b.slot);
    if (this.localActions.length >= this.requiredSlots()) this.sendActions?.(this.localActions.map(a => ({...a})));
    this.onUpdate?.();
    return true;
  }

  setLocalSwitch(slot, targetIndex) {
    if (this.over || this.busy) return false;
    const index = this.player.active?.[slot], p = this.player.team[index], target = this.player.team[targetIndex];
    if (!p?.canBattle() || !target?.canBattle() || this.player.active.includes(targetIndex)) return false;
    this.localActions = this.localActions.filter(a => a.slot !== slot);
    this.localActions.push({ kind:'switch', slot, pokemonIndex:index, targetIndex });
    this.localActions.sort((a,b) => a.slot - b.slot);
    if (this.localActions.length >= this.requiredSlots()) this.sendActions?.(this.localActions.map(a => ({...a})));
    this.onUpdate?.();
    return true;
  }

  applySnapshot(snapshot) {
    if (!snapshot?.player || !snapshot?.opponent) return;
    const orient = this.networkRole === 'guest' ? { player: snapshot.opponent, opponent: snapshot.player } : { player: snapshot.player, opponent: snapshot.opponent };
    const nextTurn = Number(snapshot.turn) || 1;
    if (nextTurn > this.turn) this.localActions = [];
    this.turn = nextTurn;
    this.over = !!snapshot.over;
    this.result = snapshot.result || null;
    this.busy = !!snapshot.busy;
    this.locked = !!snapshot.locked;
    this.field = snapshot.field || null;
    this.fieldTurns = Number(snapshot.fieldTurns) || 0;
    this.player = this.hydrateSide(orient.player);
    this.opponent = this.hydrateSide(orient.opponent);
    this.battleSize = Number(snapshot.battleSize) || this.battleSize;
    this.log = this.orientLog(snapshot.log || []);
    this.remoteActionsCount = this.networkRole === 'guest' ? Number(snapshot.playerActionsCount || 0) : Number(snapshot.opponentActionsCount || 0);
    if (this.over) this.localActions = [];
    this.onUpdate?.();
  }

  orientLog(lines) {
    if (this.networkRole !== 'guest') return lines;
    return lines.map(line => String(line)
      .replace(/^Your Pokémon/, '__OWN__')
      .replace(/^The opposing Pokémon/, 'Your Pokémon')
      .replace(/^__OWN__/, 'The opposing Pokémon'));
  }

  receiveRemoteActions() {}
}
