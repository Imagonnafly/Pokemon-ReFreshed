import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://runvpplxfmoostzzpjco.supabase.co";
const SUPABASE_KEY = "sb_publishable_mCQAAeREfJckZHeJE7CpuA_rcYLuPw-";

function configFromEnv() {
  const url = globalThis.__SUPABASE_URL__ || SUPABASE_URL;
  const key = globalThis.__SUPABASE_KEY__ || SUPABASE_KEY;
  return { url, key };
}

export function isRealtimeConfigured() {
  const { url, key } = configFromEnv();
  return Boolean(url && key);
}

export class MultiplayerClient {
  constructor({ data, onStatus, onMessage, onClose }) {
    this.data = data;
    this.onStatus = onStatus || (() => {});
    this.onMessage = onMessage || (() => {});
    this.onClose = onClose || (() => {});
    this.supabase = null;
    this.channel = null;
    this.roomCode = null;
    this.role = null;
    this.team = null;
    this.connected = false;
  }

  async connect() {
    if (!isRealtimeConfigured()) {
      this.onStatus("Online multiplayer is not configured yet. Add your Supabase URL and publishable key.");
      return false;
    }
    const { url, key } = configFromEnv();
    this.supabase = createClient(url, key, {
      realtime: { params: { eventsPerSecond: 20 } }
    });
    this.connected = true;
    this.onStatus("Connected to the online multiplayer service.");
    return true;
  }

  async openRoom(code, team, role) {
    if (!this.supabase) throw new Error("Connect to multiplayer first.");
    this.roomCode = String(code).trim().toUpperCase();
    this.role = role;
    this.team = team;
    this.channel = this.supabase.channel(`pokemon-battle:${this.roomCode}`, {
      config: { broadcast: { self: false }, presence: { key: crypto.randomUUID() } }
    });
    this.channel.on("broadcast", { event: "game" }, ({ payload }) => {
      try { this.onMessage(payload); } catch (error) { console.error(error); }
    });
    const status = await new Promise((resolve, reject) => {
      this.channel.subscribe(status => {
        if (status === "SUBSCRIBED") resolve(status);
        else if (["CHANNEL_ERROR", "TIMED_OUT"].includes(status)) reject(new Error(`Realtime channel ${status.toLowerCase()}.`));
      });
    });
    return status === "SUBSCRIBED";
  }

  async createRoom(team) {
    this.role = "host";
    this.team = team;
    const code = generateRoomCode();
    await this.openRoom(code, team, "host");
    await this.send("room_created", { code });
    this.onMessage({ type: "room_created", code });
  }

  async joinRoom(code, team) {
    this.role = "guest";
    this.team = team;
    await this.openRoom(code, team, "guest");
    await this.send("join_request", { guestTeam: team });
  }

  async send(type, payload = {}) {
    if (!this.channel) throw new Error("Multiplayer room is not connected.");
    await this.channel.send({ type: "broadcast", event: "game", payload: { type, ...payload } });
  }

  sendMove(moveId) { return this.send("remote_move", { moveId }); }
  sendSwitch(index) { return this.send("remote_switch", { index }); }
  sendActions(actions) { return this.send("remote_actions", { actions }); }
  leave() {
    try { this.channel?.unsubscribe(); } catch {}
    this.channel = null;
    this.connected = false;
    this.onClose();
  }
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export class RemoteBattle {
  constructor({ data, role, team }) {
    this.data = data;
    this.networkRole = role;
    this.abilitiesData = data.abilities ?? [];
    this.itemsData = data.items ?? [];
    this.turn = 1;
    this.over = false;
    this.busy = false;
    this.locked = false;
    this.awaitingPlayerSwitch = false;
    this.localMoveSubmitted = false;
    this.remoteMoveSubmitted = false;
    this.log = [];
    this.lastSnapshotTurn = 0;
    this.team = team || [];
    this.player = { team: [], active: 0 };
    this.opponent = { team: [], active: 0 };
    this.onUpdate = null;
    this.sendMove = null;
    this.sendSwitch = null;
    this.ready = false;
    this.pendingAction = false;
    this.pendingTurn = null;
    this.result = null;
    this.field = null;
    this.fieldTurns = 0;
  }

  hydratePokemon(raw) {
    if (!raw) return null;
    const species = this.data.species.find(p => p.id === raw.speciesId);
    const allowed = new Set(Array.isArray(species?.learnset) ? species.learnset : []);
    const rawMoveset = Array.isArray(raw.moveset) ? raw.moveset : (Array.isArray(raw.moves) ? raw.moves : []);
    const moves = rawMoveset.filter(m => allowed.has(m.id)).map(m => ({ ...m })).slice(0, 4);
    const legacyStatusMap = { Burn: "Scorch", Paralysis: "Shocked", Freeze: "Frostbite", Poison: "Haunted", "Bad Poison": "Haunted" };
    const normalizedStatus = legacyStatusMap[raw.status] || raw.status || null;
    return { ...raw, status: normalizedStatus, moves, types: [...(raw.types || [])], originalTypes: [...(raw.originalTypes || raw.types || [])], sprites: { ...(raw.sprites || {}) }, statusData: { ...(raw.statusData || {}) }, volatile: { ...(raw.volatile || {}) }, canBattle() { return this.hp > 0 && !this.fainted; } };
  }

  hydrateSide(side) {
    return { active: Number.isFinite(Number(side?.active)) ? Number(side.active) : 0, team: Array.isArray(side?.team) ? side.team.map(p => this.hydratePokemon(p)).filter(Boolean) : [] };
  }

  active(side) { return this[side]?.team?.[this[side]?.active] ?? null; }
  getAvailableMoves() {
    const pokemon = this.active("player");
    if (!pokemon) return [];
    return pokemon.moves.filter(m => {
      const forced = pokemon.volatile?.charging === m.id ||
        (pokemon.volatile?.outrageTurns > 0 && m.id === "outrage") ||
        (pokemon.volatile?.uproarTurns > 0 && m.id === "uproar");
      if ((m.pp ?? 1) <= 0 && !forced) return false;
      if (pokemon.volatile?.tauntTurns > 0 && m.category === "status") return false;
      return true;
    });
  }

  playerMove(moveId) {
    if (!this.ready || this.over || this.busy || this.locked || this.awaitingPlayerSwitch) return;
    const species = this.data.species.find(p => p.id === this.active("player")?.speciesId);
    const legal = new Set(Array.isArray(species?.learnset) ? species.learnset : []);
    if (!legal.has(moveId)) return;
    const pokemon = this.active("player");
    const move = pokemon?.moves?.find(m => m.id === moveId);
    const forced = pokemon?.volatile?.charging === moveId ||
      (pokemon?.volatile?.outrageTurns > 0 && moveId === "outrage") ||
      (pokemon?.volatile?.uproarTurns > 0 && moveId === "uproar");
    if (!move || ((move.pp ?? 1) <= 0 && !forced)) return;
    if (pokemon.volatile?.tauntTurns > 0 && move.category === "status") return;
    this.busy = true; this.locked = true; this.pendingAction = true; this.pendingTurn = this.turn;
    this.localMoveSubmitted = true;
    this.onUpdate?.();
    Promise.resolve(this.sendMove?.(moveId)).catch(error => { console.error(error); this.busy = false; this.locked = false; this.pendingAction = false; this.onUpdate?.(); });
    this.onUpdate?.();
  }

  switchPlayer(index) {
    if (!this.ready || this.over || this.busy) return false;
    this.busy = true; this.locked = true; this.pendingAction = true; this.pendingTurn = this.turn;
    Promise.resolve(this.sendSwitch?.(index)).catch(error => { console.error(error); this.busy = false; this.locked = false; this.pendingAction = false; this.onUpdate?.(); });
    this.onUpdate?.();
    return true;
  }

  applySnapshot(snapshot) {
    if (!snapshot?.player || !snapshot?.opponent) return;
    const orient = this.networkRole === "guest" ? { player: snapshot.opponent, opponent: snapshot.player } : { player: snapshot.player, opponent: snapshot.opponent };
    this.turn = Number(snapshot.turn) || 1;
    this.field = snapshot.field || snapshot.weather || snapshot.terrain || null;
    this.fieldTurns = Number(snapshot.fieldTurns) || 0;
    this.over = !!snapshot.over;
    this.result = snapshot.result || null;
    const turnAdvanced = this.pendingTurn !== null && this.turn > this.pendingTurn;
    if (turnAdvanced) {
      this.pendingAction = false;
      this.pendingTurn = null;
    }

    const hostSubmitted = !!snapshot.playerMoveSubmitted;
    const guestSubmitted = !!snapshot.opponentMoveSubmitted;
    this.localMoveSubmitted = guestSubmitted;
    this.remoteMoveSubmitted = hostSubmitted;

    // The host uses `busy` as a battle-resolution lock. It must NOT lock the
    // guest merely because the host has submitted first. A turn is resolving
    // only after both actions have been submitted, or after the host has
    // cleared both submission flags and is actively resolving the turn.
    const bothSubmitted = hostSubmitted && guestSubmitted;
    const oneSidedSubmission = hostSubmitted !== guestSubmitted;
    const resolving = bothSubmitted || (!!snapshot.busy && !oneSidedSubmission);
    this.busy = resolving;
    this.locked = resolving || this.pendingAction;
    this.player = this.hydrateSide(orient.player);
    this.opponent = this.hydrateSide(orient.opponent);
    this.log = this.orientLog(snapshot.log || []);
    this.ready = this.player.team.length > 0 && this.opponent.team.length > 0;
    this.onUpdate?.();
  }

  orientLog(lines) {
    if (this.networkRole !== "guest") return lines;
    return lines.map(line => String(line).replace(/^(Your Pokémon|The opposing Pokémon)/, prefix => prefix === "Your Pokémon" ? "The opposing Pokémon" : "Your Pokémon"));
  }
}


export class RemoteMultiBattle {
  constructor({ data, role, team, battleSize = 1 }) {
    this.data = data;
    this.networkRole = role;
    this.isMulti = true;
    this.battleSize = Math.max(1, Math.min(10, Number(battleSize) || 1));
    this.turn = 1;
    this.over = false;
    this.busy = false;
    this.locked = false;
    this.field = null;
    this.fieldTurns = 0;
    this.result = null;
    this.log = [];
    this.localActions = [];
    this.player = { team: [], active: [] };
    this.opponent = { team: [], active: [] };
    this.onUpdate = null;
  }

  hydratePokemon(raw) {
    if (!raw) return null;
    const species = this.data.species.find(p => p.id === raw.speciesId);
    if (!species) return null;
    const moves = (raw.moveset || raw.moves || []).map(m => typeof m === "string" ? this.data.moves.find(x => x.id === m) : m).filter(Boolean);
    const BattlePokemonCtor = this.data.BattlePokemon;
    // Use a minimal shape identical to BattlePokemon for rendering.
    const maxHP = Number(raw.maxHP ?? raw.hp ?? 1);
    return {
      ...raw,
      speciesId: raw.speciesId,
      name: raw.name ?? species.name,
      level: raw.level ?? 50,
      types: raw.types ?? species.types,
      originalTypes: raw.originalTypes ?? species.types,
      moves,
      hp: Number(raw.hp ?? maxHP),
      maxHP,
      status: raw.status ?? null,
      statusData: raw.statusData ?? {},
      volatile: raw.volatile ?? {},
      sprites: raw.sprites ?? species.sprites,
      canBattle() { return !this.fainted && this.hp > 0; }
    };
  }

  applySide(side) {
    const team = (side?.team || []).map(p => this.hydratePokemon(p)).filter(Boolean);
    return { team, active: Array.isArray(side?.active) ? side.active : [Number(side?.active ?? 0)] };
  }

  active(side) {
    return this[side]?.team?.[this[side]?.active?.[0]] ?? null;
  }

  activePokemon(side) {
    return (this[side]?.active || []).map(i => this[side]?.team?.[i]).filter(p => p?.canBattle());
  }

  activeIndices(side) {
    return (this[side]?.active || []).filter(i => this[side]?.team?.[i]?.canBattle());
  }

  getAvailableMovesFor(pokemon) {
    if (!pokemon?.canBattle()) return [];
    return (pokemon.moves || []).filter(m => (m.pp ?? 1) > 0 && !(pokemon.volatile?.tauntTurns > 0 && m.category === "status"));
  }

  submitAction(slot, moveId, targetSide, targetIndex) {
    if (this.over || this.busy) return false;
    const activeIndex = this.player.active[slot];
    const p = this.player.team[activeIndex];
    const move = p?.moves?.find(m => m.id === moveId);
    if (!p || !move || !p.canBattle()) return false;
    this.localActions = this.localActions.filter(a => a.slot !== slot);
    this.localActions.push({ slot, pokemonIndex: activeIndex, moveId, targetSide, targetIndex });
    if (this.localActions.length >= this.activeIndices("player").length) {
      this.busy = true;
      this.locked = true;
      this.sendActions?.(this.localActions);
    }
    this.onUpdate?.();
    return true;
  }

  applySnapshot(snapshot) {
    if (!snapshot?.player || !snapshot?.opponent) return;
    const orient = this.networkRole === "guest"
      ? { player: snapshot.opponent, opponent: snapshot.player }
      : { player: snapshot.player, opponent: snapshot.opponent };
    this.turn = Number(snapshot.turn) || 1;
    this.field = snapshot.field || null;
    this.fieldTurns = Number(snapshot.fieldTurns) || 0;
    this.over = !!snapshot.over;
    this.result = snapshot.result || null;
    this.busy = !!snapshot.busy;
    this.locked = !!snapshot.locked;
    this.player = this.applySide(orient.player);
    this.opponent = this.applySide(orient.opponent);
    this.battleSize = Number(snapshot.battleSize) || this.battleSize;
    this.log = this.orientLog(snapshot.log || []);
    if (this.over) this.localActions = [];
    const localCount = this.networkRole === "guest" ? Number(snapshot.opponentActionsCount || 0) : Number(snapshot.playerActionsCount || 0);
    this.localActions = this.localActions.filter(a => a.slot < this.activeIndices("player").length);
    if (localCount >= this.activeIndices("player").length) this.busy = true;
    this.onUpdate?.();
  }

  orientLog(log) {
    return Array.isArray(log) ? log.map(String) : [];
  }
}
