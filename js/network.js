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
  }

  hydratePokemon(raw) {
    if (!raw) return null;
    return { ...raw, moves: Array.isArray(raw.moves) ? raw.moves.map(m => ({ ...m })) : [], types: [...(raw.types || [])], sprites: { ...(raw.sprites || {}) }, statusData: { ...(raw.statusData || {}) }, canBattle() { return this.hp > 0 && !this.fainted; } };
  }

  hydrateSide(side) {
    return { active: Number.isFinite(Number(side?.active)) ? Number(side.active) : 0, team: Array.isArray(side?.team) ? side.team.map(p => this.hydratePokemon(p)).filter(Boolean) : [] };
  }

  active(side) { return this[side]?.team?.[this[side]?.active] ?? null; }
  getAvailableMoves() { return this.active("player")?.moves?.filter(m => (m.pp ?? 1) > 0) ?? []; }

  playerMove(moveId) {
    if (!this.ready || this.over || this.busy || this.locked || this.awaitingPlayerSwitch) return;
    if (!this.active("player")?.moves?.some(m => m.id === moveId && (m.pp ?? 1) > 0)) return;
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
