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

function getTrainerIdentity() {
  const key = "pokemon-trainer-id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  let name = localStorage.getItem("pokemon-trainer-name");
  if (!name) {
    name = `Trainer ${id.slice(0, 4).toUpperCase()}`;
    localStorage.setItem("pokemon-trainer-name", name);
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
      if (this.party.members.length >= 2) return;
      this.party.members.push(message.member);
      this.partyChannel?.send({ type: "broadcast", event: "party", payload: { type: "party_state", party: this.party } });
      this.onParty(this.party);
      return;
    }
    if (message?.type === "party_queue") {
      const group = message.group;
      if (Array.isArray(group?.members) && group.members.some(m => m.id === this.identity.id)) {
        this.queueMode = message.mode || "team-2v2";
        this.queueGroup = group;
        this.joinQueue(this.queueMode, group);
      }
    }
  }

  async queueSolo(mode = "team-2v2") {
    const group = { groupId: this.identity.id, members: [{ id: this.identity.id, name: this.identity.name, team: this.team }] };
    this.queueMode = mode;
    this.queueGroup = group;
    await this.joinQueue(mode, group);
  }

  async queueParty(mode = "team-2v2") {
    if (!this.party || this.party.members.length < 2) throw new Error("Your party needs two trainers before entering matchmaking.");
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
    await this.joinQueue(mode, group);
    await this.partyChannel?.send({ type: "broadcast", event: "party", payload: { type: "party_queue", mode, group } });
  }

  async joinQueue(mode, group) {
    await this.ensureQueueChannel();
    const ticket = {
      ticketId: `${group.groupId}:${Date.now()}`,
      groupId: group.groupId,
      mode,
      createdAt: Date.now(),
      leaderId: group.members.map(m => m.id).sort()[0],
      members: group.members
    };
    this.queueTickets.set(ticket.groupId, ticket);
    await this.queueChannel.send({ type: "broadcast", event: "queue", payload: { type: "queue_ticket", ticket } });
    this.onStatus("Searching for trainers…");
    this.attemptMatch();
  }

  async leaveQueue() {
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
      if (message.ticket.mode !== "team-2v2") return;
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
    const tickets = [...this.queueTickets.values()]
      .filter(t => t.mode === "team-2v2")
      .sort((a, b) => a.createdAt - b.createdAt || a.groupId.localeCompare(b.groupId));
    if (!tickets.length || !this.queueGroup) return;
    const myLeader = this.queueGroup.members.map(m => m.id).sort()[0];
    const current = tickets.find(t => t.groupId === this.queueGroup.groupId);
    if (!current || current.leaderId !== myLeader) return;

    const picked = [];
    let count = 0;
    for (const ticket of tickets) {
      if (picked.some(p => p.groupId === ticket.groupId)) continue;
      const size = ticket.members.length;
      if (size > 2 || count + size > 4) continue;
      picked.push(ticket);
      count += size;
      if (count === 4) break;
    }
    if (count !== 4) return;

    // The earliest waiting group is the coordinator. Everyone else simply
    // receives the same match descriptor and joins the match channel.
    if (picked[0].leaderId !== myLeader) return;
    const alpha = [];
    const beta = [];
    for (const ticket of picked) {
      const target = alpha.length + ticket.members.length <= 2 && beta.length === 0 ? alpha : (beta.length + ticket.members.length <= 2 ? beta : alpha);
      target.push(...ticket.members.map(m => ({ ...m, side: target === alpha ? "alpha" : "beta" })));
    }
    // If a greedy grouping produced an unbalanced split, fall back to a simple
    // deterministic first-two/last-two split while preserving party members.
    if (alpha.length !== 2 || beta.length !== 2) {
      const flat = picked.flatMap(t => t.members.map(m => ({ ...m })));
      alpha.length = 0; beta.length = 0;
      flat.forEach((m, i) => (i < 2 ? alpha : beta).push({ ...m, side: i < 2 ? "alpha" : "beta" }));
    }
    const members = [...alpha, ...beta];
    const match = {
      id: crypto.randomUUID(),
      mode: "team-2v2",
      coordinatorId: members[0]?.id,
      members
    };
    this.queueChannel.send({ type: "broadcast", event: "queue", payload: { type: "match_found", match } });
    // Broadcast channels do not echo to the sender, so the coordinator needs
    // to consume the match descriptor locally as well.
    this.handleQueueMessage({ type: "match_found", match });
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
          this.matchChannel?.send({ type: "broadcast", event: "match", payload: { type: "party_start", match: this.match } });
          this.onMatch({ ...this.match, ready: true, started: true });
        }
      }
      if (payload.type === "party_start" && payload.match) {
        this.match = { ...payload.match, localMemberId: this.identity.id };
        this.onMatch({ ...this.match, ready: true, started: true });
      }
      if (payload.type === "party_action") this.onPartyAction(payload.action);
      if (payload.type === "party_snapshot") this.onPartySnapshot(payload.snapshot);
    });
    await this.subscribe(this.matchChannel);
    this.readyIds.add(this.identity.id);
    await this.matchChannel.send({ type: "broadcast", event: "match", payload: { type: "match_ready", memberId: this.identity.id } });
    this.onMatch({ ...match, ready: false, waiting: true });
  }

  async sendPartyAction(action) {
    await this.matchChannel?.send({ type: "broadcast", event: "match", payload: { type: "party_action", action } });
  }

  async sendPartySnapshot(snapshot) {
    await this.matchChannel?.send({ type: "broadcast", event: "match", payload: { type: "party_snapshot", snapshot } });
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
    this.partyMode = "2v2";
    this.battleSize = 2;
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
      active: 0
    }));
    this.memberMap = new Map(this.members.map(m => [m.id, m]));
    this.localActions = new Map();
    this.pendingIds = new Set();
    this.onUpdate = null;
    this.sendPartyAction = null;
  }

  getMember(id) { return this.memberMap.get(String(id)); }
  activeMember(id) { const m = this.getMember(id); return m?.team?.[m.active] || null; }
  getLocalMember() { return this.getMember(this.localMemberId); }
  getMembersBySide(side) { return this.members.filter(m => m.side === side); }
  getActiveMembers(side) { return this.getMembersBySide(side).filter(m => this.activeMember(m.id)?.canBattle()); }
  activeIndices(side) { return this.getActiveMembers(side).map(m => this.members.indexOf(m)); }
  active(side) { return this.activeMember(this.getMembersBySide(side)[0]?.id); }
  getAvailableMovesForMember(id) {
    const p = this.activeMember(id);
    if (!p?.canBattle()) return [];
    return (p.moves || []).filter(m => (m.pp ?? 1) > 0 && !(p.volatile?.tauntTurns > 0 && m.category === "status"));
  }
  getTargetsFor(id, move = null) {
    const me = this.getMember(id);
    if (!me) return [];
    const sameSide = move?.id === "helping-hand" || move?.id === "dragon-cheer";
    const pool = this.getMembersBySide(sameSide ? me.side : (me.side === "alpha" ? "beta" : "alpha"));
    return pool.map(target => ({ memberId: target.id, pokemon: this.activeMember(target.id), label: `${target.name} · ${this.activeMember(target.id)?.name || "---"}` })).filter(x => x.pokemon?.canBattle());
  }
  submitAction(moveId, targetMemberId) {
    if (this.over || this.busy || this.pendingIds.has(this.localMemberId)) return false;
    const p = this.getLocalMember();
    const move = p?.team ? p.team[p.active]?.moves?.find(m => m.id === moveId) : null;
    const target = this.activeMember(targetMemberId);
    const targetMember = this.getMember(targetMemberId);
    if (!p || !move || !targetMember || !target?.canBattle()) return false;
    this.localActions.set(this.localMemberId, { memberId: this.localMemberId, moveId, targetMemberId });
    this.pendingIds.add(this.localMemberId);
    this.sendPartyAction?.(this.localActions.get(this.localMemberId));
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
    this.over = !!snapshot.over;
    this.busy = !!snapshot.busy;
    this.locked = !!snapshot.locked;
    this.field = snapshot.field || null;
    this.fieldTurns = Number(snapshot.fieldTurns) || 0;
    this.result = snapshot.result || null;
    this.log = Array.isArray(snapshot.log) ? snapshot.log : [];
    this.pendingIds = new Set(snapshot.pendingIds || []);
    this.members = snapshot.members.map(m => ({ ...m, team: (m.team || []).map(p => this.hydratePokemon(p)).filter(Boolean), active: Number(m.active) || 0 }));
    this.memberMap = new Map(this.members.map(m => [m.id, m]));
    if (this.pendingIds.has(this.localMemberId)) this.localActions.set(this.localMemberId, this.localActions.get(this.localMemberId) || null);
    else this.localActions.delete(this.localMemberId);
    this.onUpdate?.();
  }
}
