import { GAME_CONFIG, clampBattleSize, clampTeamSize } from "./config.js";
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
    const moves = rawMoveset.filter(m => allowed.has(m.id)).map(m => ({ ...m })).slice(0, GAME_CONFIG.moves.maxBattleMoves);
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
    this.battleSize = clampBattleSize(battleSize);
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

  setLocalSwitch(slot, targetIndex) {
    if (this.over || this.busy) return false;
    const activeIndex = this.player.active[slot];
    const p = this.player.team[activeIndex];
    const target = this.player.team[targetIndex];
    if (!p?.canBattle() || !target?.canBattle() || (this.player.active || []).includes(targetIndex)) return false;
    this.localActions = this.localActions.filter(a => a.slot !== slot);
    this.localActions.push({ kind: 'switch', slot, pokemonIndex: activeIndex, targetIndex });
    if (this.localActions.length >= this.activeIndices('player').length) {
      this.busy = true;
      this.locked = true;
      this.sendActions?.(this.localActions);
    }
    this.onUpdate?.();
    return true;
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
    const expected = this.activeIndices("player").length;
    const localCount = this.networkRole === "guest" ? Number(snapshot.opponentActionsCount || 0) : Number(snapshot.playerActionsCount || 0);
    this.localActions = this.localActions.filter(a => a.slot < expected);
    // A remote snapshot may report partial opponent input; that must not lock
    // this client's remaining action slots or make the UI look resolved.
    const remoteCount = this.networkRole === "guest" ? Number(snapshot.playerActionsCount || 0) : Number(snapshot.opponentActionsCount || 0);
    if (!this.busy && remoteCount >= expected && localCount >= expected) this.busy = true;
    this.onUpdate?.();
  }

  orientLog(log) {
    return Array.isArray(log) ? log.map(String) : [];
  }
}

function getTrainerIdentity() {
  // Use a per-tab/session ID for realtime matchmaking. Using localStorage here
  // caused multiple browser tabs on the same machine to appear as the same
  // trainer, which makes a 4-player local matchmaking test impossible and can
  // also corrupt queue grouping. Trainer display name remains persistent.
  const idKey = "pokemon-trainer-session-id";
  let id = sessionStorage.getItem(idKey);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(idKey, id);
  }
  const nameKey = "pokemon-trainer-name";
  let name = localStorage.getItem(nameKey);
  if (!name) {
    name = `Trainer ${id.slice(0, 4).toUpperCase()}`;
    localStorage.setItem(nameKey, name);
  }
  return { id, name };
}

export class PartyMatchClient {
  constructor({ data, team, onStatus, onParty, onMatch, onPartyAction, onPartySnapshot }) {
    this.data = data;
    this.team = team || [];
    this.onStatus = onStatus || (() => {});
    this.onParty = onParty || (() => {});
    this.onMatch = onMatch || (() => {});
    this.onPartyAction = onPartyAction || (() => {});
    this.onPartySnapshot = onPartySnapshot || (() => {});
    this.supabase = null;
    this.queueChannel = null;
    this.partyChannel = null;
    this.matchChannel = null;
    this.partyCode = null;
    this.party = null;
    this.queueTickets = new Map();
    this.queueMode = null;
    this.queueGroup = null;
    this.match = null;
    this.readyIds = new Set();
    this.identity = getTrainerIdentity();
  }

  async connect() {
    if (!isRealtimeConfigured()) throw new Error("Supabase Realtime is not configured.");
    const { url, key } = configFromEnv();
    this.supabase = createClient(url, key, { realtime: { params: { eventsPerSecond: 30 } } });
    this.onStatus("Connected to matchmaking.");
    return true;
  }

  async ensureQueueChannel() {
    if (this.queueChannel) return;
    this.queueChannel = this.supabase.channel("pokemon-matchmaking-v2", {
      config: { broadcast: { self: false }, presence: { key: this.identity.id } }
    });
    this.queueChannel.on("broadcast", { event: "queue" }, ({ payload }) => this.handleQueueMessage(payload));
    await this.subscribe(this.queueChannel);
  }

  async createParty() {
    const code = this.randomCode();
    await this.openParty(code, true);
    return code;
  }

  async joinParty(code) {
    await this.openParty(String(code).trim().toUpperCase(), false);
  }

  async openParty(code, isHost) {
    if (!this.supabase) await this.connect();
    if (this.partyChannel) await this.partyChannel.unsubscribe();
    this.partyCode = code;
    this.party = {
      code,
      hostId: isHost ? this.identity.id : null,
      members: [{ id: this.identity.id, name: this.identity.name, team: this.team, host: !!isHost }]
    };
    this.partyChannel = this.supabase.channel(`pokemon-party-v2:${code}`, {
      config: { broadcast: { self: false }, presence: { key: this.identity.id } }
    });
    this.partyChannel.on("broadcast", { event: "party" }, ({ payload }) => this.handlePartyMessage(payload));
    await this.subscribe(this.partyChannel);
    if (isHost) {
      await this.partyChannel.send({ type: "broadcast", event: "party", payload: { type: "party_state", party: this.party } });
    } else {
      await this.partyChannel.send({ type: "broadcast", event: "party", payload: {
        type: "party_join_request",
        member: { id: this.identity.id, name: this.identity.name, team: this.team, host: false }
      }});
    }
    this.onParty(this.party);
  }

  handlePartyMessage(message) {
    if (message?.type === "party_state" && message.party) {
      this.party = message.party;
      this.onParty(this.party);
      return;
    }
    if (message?.type === "party_join_request" && this.party?.hostId === this.identity.id) {
      if (this.party.members.length >= GAME_CONFIG.matchmaking.maxTrainersPerTeam) return;
      this.party.members.push(message.member);
      this.partyChannel?.send({ type: "broadcast", event: "party", payload: { type: "party_state", party: this.party } });
      this.onParty(this.party);
      return;
    }
    if (message?.type === "party_queue") {
      const group = message.group;
      if (Array.isArray(group?.members) && group.members.some(m => m.id === this.identity.id)) {
        this.queueMode = message.mode || "match";
        this.queueGroup = group;
        this.joinQueue(this.queueMode, group, message.battleSize || 1, message.teamSize || 2);
      }
    }
  }

  async queueSolo(mode = "match", battleSize = 1, teamSize = 1) {
    const group = {
      groupId: this.identity.id,
      members: [{ id: this.identity.id, name: this.identity.name, team: this.team }]
    };
    this.queueMode = mode;
    this.queueGroup = group;
    await this.joinQueue(mode, group, battleSize, teamSize);
  }

  async queueParty(mode = "match", battleSize = 1, teamSize = 2) {
    teamSize = clampTeamSize(teamSize, 2);
    if (!this.party || this.party.members.length < 2) throw new Error("Your party needs at least two trainers before entering matchmaking.");
    if (this.party.members.length > teamSize) throw new Error(`Your party has ${this.party.members.length} trainers, but the selected battle type allows ${teamSize} trainers per team.`);
    if (this.party.hostId !== this.identity.id) {
      this.onStatus("Only the party leader can start matchmaking.");
      return;
    }
    const group = {
      groupId: this.party.code,
      members: this.party.members.map(m => ({ id: m.id, name: m.name, team: m.team }))
    };
    this.queueMode = mode;
    this.queueGroup = group;
    await this.joinQueue(mode, group, battleSize, teamSize);
    await this.partyChannel?.send({ type: "broadcast", event: "party", payload: { type: "party_queue", mode, group, battleSize, teamSize } });
  }

  async joinQueue(mode, group, battleSize = 1, teamSize = 1) {
    await this.ensureQueueChannel();
    const ticket = {
      ticketId: `${group.groupId}:${Date.now()}`,
      groupId: group.groupId,
      mode,
      battleSize: clampBattleSize(battleSize),
      teamSize: clampTeamSize(teamSize),
      createdAt: Date.now(),
      leaderId: group.members.map(m => m.id).sort()[0],
      members: group.members
    };
    this.queueTickets.set(ticket.groupId, ticket);
    await this.queueChannel.send({ type: "broadcast", event: "queue", payload: { type: "queue_ticket", ticket } });
    this.onStatus("Searching for trainers…");
    this.matchmakingActive = true;
    this.startQueueHeartbeat(ticket);
    this.attemptMatch();
  }

  startQueueHeartbeat(ticket) {
    clearInterval(this.queueHeartbeat);
    this.queueHeartbeat = setInterval(() => {
      if (!this.matchmakingActive || !this.queueChannel) return;
      this.queueChannel.send({ type: "broadcast", event: "queue", payload: { type: "queue_ticket", ticket } }).catch(() => {});
      this.attemptMatch();
    }, 1500);
  }

  async leaveQueue() {
    this.matchmakingActive = false;
    clearInterval(this.queueHeartbeat);
    this.queueHeartbeat = null;
    if (this.queueChannel && this.queueGroup) {
      this.queueTickets.delete(this.queueGroup.groupId);
      await this.queueChannel.send({ type: "broadcast", event: "queue", payload: { type: "queue_leave", groupId: this.queueGroup.groupId } });
    }
    this.queueGroup = null;
    this.queueMode = null;
  }

  handleQueueMessage(message) {
    if (!message) return;
    if (message.type === "queue_ticket" && message.ticket) {
      const validMode = message.ticket.mode === "match" || message.ticket.mode === "team-2v2" || /^normal-\d+$/.test(message.ticket.mode);
      if (!validMode) return;
      this.queueTickets.set(message.ticket.groupId, message.ticket);
      this.attemptMatch();
    } else if (message.type === "queue_leave") {
      this.queueTickets.delete(message.groupId);
    } else if (message.type === "match_found" && message.match) {
      const match = message.match;
      const me = match.members.find(m => m.id === this.identity.id);
      if (!me) return;
      this.match = { ...match, localMemberId: this.identity.id, localSide: me.side };
      this.leaveQueue();
      this.openMatchChannel(match);
    }
  }

  attemptMatch() {
    const allTickets = [...this.queueTickets.values()]
      .filter(t => Array.isArray(t.members) && t.members.length >= 1 && t.members.length <= GAME_CONFIG.matchmaking.maxTrainersPerTeam)
      .sort((a, b) => a.createdAt - b.createdAt || a.groupId.localeCompare(b.groupId));
    if (!allTickets.length || !this.queueGroup || !this.matchmakingActive) return;

    const myGroupId = this.queueGroup.groupId;
    const myTicket = allTickets.find(t => t.groupId === myGroupId);
    if (!myTicket) return;

    // One matchmaking queue, partitioned by the two selected dimensions:
    // battleSize = active Pokémon per trainer; teamSize = trainers per team.
    const battleSize = clampBattleSize(myTicket.battleSize);
    const teamSize = clampTeamSize(myTicket.teamSize);
    const candidates = allTickets.filter(t => {
      const sameMode = t.mode === myTicket.mode || (t.mode === 'team-2v2' && myTicket.mode === 'match' && Number(t.teamSize) === 2);
      return sameMode && Number(t.battleSize) === battleSize && Number(t.teamSize || 1) === teamSize;
    });
    const coordinatorTicket = candidates[0];
    if (!coordinatorTicket || coordinatorTicket.leaderId !== this.identity.id) return;

    const needed = teamSize * 2;
    const picked = [];
    let total = 0;
    for (const ticket of candidates) {
      if (total + ticket.members.length > needed) continue;
      picked.push(ticket);
      total += ticket.members.length;
      if (total === needed) break;
    }
    if (total !== needed) {
      this.onStatus(`Searching for ${battleSize}v${battleSize} · ${teamSize} trainers/team… ${total}/${needed} trainers found`);
      return;
    }

    // Split complete groups across the two teams without breaking a party.
    const alpha = [];
    const beta = [];
    for (const ticket of picked) {
      const groupMembers = ticket.members.map(m => ({ ...m }));
      if (alpha.length + groupMembers.length <= teamSize) alpha.push(...groupMembers.map(m => ({ ...m, side: 'alpha' })));
      else if (beta.length + groupMembers.length <= teamSize) beta.push(...groupMembers.map(m => ({ ...m, side: 'beta' })));
      else {
        this.onStatus('Finding a compatible team arrangement…');
        return;
      }
    }
    if (alpha.length !== teamSize || beta.length !== teamSize) return;

    const allIds = [...alpha, ...beta].map(m => m.id);
    if (new Set(allIds).size !== needed) return;

    const kind = teamSize > 1 ? 'party' : 'normal';
    const match = {
      id: crypto.randomUUID(),
      kind,
      mode: 'match',
      battleSize,
      teamSize,
      coordinatorId: this.identity.id,
      members: [...alpha, ...beta]
    };
    this.queueChannel.send({ type: 'broadcast', event: 'queue', payload: { type: 'match_found', match } }).catch(() => {});
    this.handleQueueMessage({ type: 'match_found', match });
  }

  async openMatchChannel(match) {
    if (!this.supabase) return;
    if (this.matchChannel) await this.matchChannel.unsubscribe();
    this.readyIds = new Set();
    this.matchChannel = this.supabase.channel(`pokemon-party-match-v2:${match.id}`, {
      config: { broadcast: { self: false }, presence: { key: this.identity.id } }
    });
    this.matchChannel.on("broadcast", { event: "match" }, ({ payload }) => {
      if (!payload) return;
      if (payload.type === "match_ready") {
        this.readyIds.add(payload.memberId);
        this.onStatus(`Trainer ${this.readyIds.size}/${match.members.length} ready…`);
        if (this.identity.id === match.coordinatorId && this.readyIds.size === match.members.length) {
          this.match = { ...match, ready: true };
          this.matchChannel?.send({ type: "broadcast", event: "match", payload: { type: match.kind === "normal" ? "match_start" : "party_start", match: this.match } });
          this.onMatch({ ...this.match, ready: true, started: true });
        }
      }
      if ((payload.type === "party_start" || payload.type === "match_start") && payload.match) {
        this.match = { ...payload.match, localMemberId: this.identity.id };
        this.onMatch({ ...this.match, ready: true, started: true });
      }
      if (payload.type === "party_action" || payload.type === "match_action") this.onPartyAction(payload.action);
      if (payload.type === "party_snapshot" || payload.type === "match_snapshot") this.onPartySnapshot(payload.snapshot);
    });
    await this.subscribe(this.matchChannel);
    this.readyIds.add(this.identity.id);
    await this.matchChannel.send({ type: "broadcast", event: "match", payload: { type: "match_ready", memberId: this.identity.id } });
    this.onMatch({ ...match, ready: false, waiting: true });
  }

  async sendPartyAction(action) {
    const eventType = this.match?.kind === "normal" ? "match_action" : "party_action";
    await this.matchChannel?.send({ type: "broadcast", event: "match", payload: { type: eventType, action } });
  }

  async sendPartySnapshot(snapshot) {
    const eventType = this.match?.kind === "normal" ? "match_snapshot" : "party_snapshot";
    await this.matchChannel?.send({ type: "broadcast", event: "match", payload: { type: eventType, snapshot } });
  }

  subscribe(channel) {
    return new Promise((resolve, reject) => {
      channel.subscribe(status => {
        if (status === "SUBSCRIBED") resolve(status);
        else if (["CHANNEL_ERROR", "TIMED_OUT"].includes(status)) reject(new Error(`Realtime channel ${status.toLowerCase()}.`));
      });
    });
  }

  randomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  leave() {
    this.leaveQueue().catch(() => {});
    try { this.partyChannel?.unsubscribe(); } catch {}
    try { this.matchChannel?.unsubscribe(); } catch {}
    try { this.queueChannel?.unsubscribe(); } catch {}
    this.partyChannel = null;
    this.matchChannel = null;
    this.queueChannel = null;
  }
}


export class RemotePartyBattle {
  constructor({ data, match, localMemberId }) {
    this.data = data;
    this.isParty = true;
    this.partyMode = `${Math.max(1, Number(match.teamSize) || 2)} trainers/team`;
    this.battleSize = clampBattleSize(match.battleSize);
    this.teamSize = clampTeamSize(match.teamSize, 2);
    this.networkRole = "member";
    this.localMemberId = localMemberId;
    this.turn = 1;
    this.over = false;
    this.busy = false;
    this.locked = false;
    this.field = null;
    this.fieldTurns = 0;
    this.result = null;
    this.log = [];
    this.members = (match.members || []).map(m => ({
      id: m.id,
      name: m.name,
      side: m.side,
      team: [],
      active: Array.from({ length: this.battleSize }, () => -1)
    }));
    this.memberMap = new Map(this.members.map(m => [m.id, m]));
    this.localActions = new Map();
    this.pendingIds = new Set();
    this.onUpdate = null;
    this.sendPartyAction = null;
  }

  getMember(id) { return this.memberMap.get(String(id)); }
  activeMember(id, slot = 0) {
    const m = this.getMember(id);
    if (!m) return null;
    const index = Number(Array.isArray(m.active) ? m.active[Number(slot)] : m.active);
    return Number.isInteger(index) && index >= 0 ? m.team[index] || null : null;
  }
  getLocalMember() { return this.getMember(this.localMemberId); }
  getMembersBySide(side) { return this.members.filter(m => m.side === side); }
  getActiveEntries(side) {
    const out = [];
    for (const member of this.getMembersBySide(side)) {
      for (let slot = 0; slot < this.battleSize; slot += 1) {
        const pokemon = this.activeMember(member.id, slot);
        if (pokemon?.canBattle()) out.push({ member, memberId: member.id, slot, pokemon });
      }
    }
    return out;
  }
  getActiveMembers(side) { return this.getActiveEntries(side).map(x => x.pokemon); }
  activeIndices(side) { return this.getActiveEntries(side).map(entry => `${entry.memberId}:${entry.slot}`); }
  active(side) { return this.activeMember(this.getMembersBySide(side)[0]?.id, 0); }
  getAvailableMovesForMember(id, slot = 0) {
    const p = this.activeMember(id, slot);
    if (!p?.canBattle()) return [];
    return (p.moves || []).filter(m => (m.pp ?? 1) > 0 && !(p.volatile?.tauntTurns > 0 && m.category === 'status'));
  }
  getBenchOptions(id, sourceSlot = 0) {
    const member = this.getMember(id);
    if (!member) return [];
    const current = Number(member.active?.[Number(sourceSlot)] ?? -1);
    const activeSet = new Set((member.active || []).map(i => Number(i)).filter(i => i >= 0));
    return (member.team || []).map((pokemon, teamIndex) => ({ pokemon, teamIndex }))
      .filter(({ pokemon, teamIndex }) => teamIndex !== current && !activeSet.has(teamIndex) && pokemon?.canBattle?.())
      .map(({ pokemon, teamIndex }) => ({ pokemon, teamIndex }));
  }

  submitPartySwitch(memberId, sourceSlot, targetTeamIndex) {
    const slot = Number(sourceSlot);
    const targetIndex = Number(targetTeamIndex);
    const member = this.getMember(memberId);
    if (this.over || this.busy || member?.id !== this.localMemberId || !member || slot < 0 || slot >= this.battleSize) return false;
    if (this.pendingIds.has(`${memberId}:${slot}`)) return false;
    const current = this.activeMember(memberId, slot);
    const target = member.team[targetIndex];
    if (!current?.canBattle?.() || !target?.canBattle?.()) return false;
    if (member.active.some((idx, i) => i !== slot && Number(idx) === targetIndex)) return false;
    const action = { kind: 'switch', memberId, slot, switchTo: targetIndex };
    this.localActions.set(`${memberId}:${slot}`, action);
    this.pendingIds.add(`${memberId}:${slot}`);
    this.sendPartyAction?.(action);
    this.onUpdate?.();
    return true;
  }

  getTargetsFor(id, move = null, sourceSlot = 0) {
    const me = this.getMember(id);
    if (!me) return [];
    const selfMoves = new Set(['agility','bulk-up','dragon-cheer','endure','protect','rest','roost','substitute','swords-dance','sleep-talk','sunny-day','taunt','uproar']);
    if (selfMoves.has(move?.id)) {
      const p = this.activeMember(me.id, sourceSlot);
      return p?.canBattle() ? [{ memberId: me.id, slot: sourceSlot, pokemon: p, label: `${me.name} · ${p.name}` }] : [];
    }
    const ally = move?.id === 'helping-hand';
    const side = ally ? me.side : (me.side === 'alpha' ? 'beta' : 'alpha');
    return this.getActiveEntries(side).map(entry => ({ memberId: entry.memberId, slot: entry.slot, pokemon: entry.pokemon, label: `${entry.member.name} · ${entry.pokemon.name}` }));
  }
  submitAction(moveId, targetMemberId, targetSlot = 0, sourceSlot = null) {
    const slot = sourceSlot == null ? 0 : Number(sourceSlot);
    if (this.over || this.busy || this.pendingIds.has(`${this.localMemberId}:${slot}`)) return false;
    const p = this.getLocalMember();
    const move = p ? this.activeMember(p.id, slot)?.moves?.find(m => m.id === moveId) : null;
    const target = this.activeMember(targetMemberId, Number(targetSlot));
    const targetMember = this.getMember(targetMemberId);
    if (!p || !move || !targetMember || !target?.canBattle()) return false;
    const action = { kind: 'move', memberId: this.localMemberId, slot, moveId, targetMemberId, targetSlot: Number(targetSlot) };
    this.localActions.set(`${this.localMemberId}:${slot}`, action);
    this.pendingIds.add(`${this.localMemberId}:${slot}`);
    this.sendPartyAction?.(action);
    this.onUpdate?.();
    return true;
  }
  hydratePokemon(raw) {
    if (!raw) return null;
    const species = this.data.species.find(p => p.id === raw.speciesId);
    if (!species) return null;
    const moves = (raw.moveset || raw.moves || []).map(m => typeof m === "string" ? this.data.moves.find(x => x.id === m) : m).filter(Boolean).slice(0,4);
    const maxHP = Number(raw.maxHP ?? raw.hp ?? 1);
    return { ...raw, name: raw.name || species.name, level: raw.level || 50, types: raw.types || species.types, originalTypes: raw.originalTypes || species.types, moves, hp: Number(raw.hp ?? maxHP), maxHP, sprites: raw.sprites || species.sprites, volatile: raw.volatile || {}, statusData: raw.statusData || {}, canBattle() { return !this.fainted && this.hp > 0; } };
  }
  applySnapshot(snapshot) {
    if (!snapshot?.members) return;
    this.turn = Number(snapshot.turn) || 1;
    this.battleSize = clampBattleSize(snapshot.battleSize, this.battleSize || 1);
    this.teamSize = clampTeamSize(snapshot.teamSize, this.teamSize || 2);
    this.over = !!snapshot.over;
    this.busy = !!snapshot.busy;
    this.locked = !!snapshot.locked;
    this.field = snapshot.field || null;
    this.fieldTurns = Number(snapshot.fieldTurns) || 0;
    this.result = snapshot.result || null;
    this.log = Array.isArray(snapshot.log) ? snapshot.log : [];
    this.pendingIds = new Set(snapshot.pendingIds || []);
    this.members = snapshot.members.map(m => ({
      ...m,
      team: (m.team || []).map(p => this.hydratePokemon(p)).filter(Boolean),
      active: Array.isArray(m.active) ? [...m.active].slice(0, this.battleSize) : [Number(m.active) || 0]
    }));
    for (const member of this.members) while (member.active.length < this.battleSize) member.active.push(-1);
    this.memberMap = new Map(this.members.map(m => [m.id, m]));
    for (const key of [...this.localActions.keys()]) {
      if (!this.pendingIds.has(key)) this.localActions.delete(key);
    }
    this.onUpdate?.();
  }
}
