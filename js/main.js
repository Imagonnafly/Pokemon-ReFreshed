import { Battle } from "./engine/battle.js";
import { MultiBattle } from "./engine/multi-battle.js";
import { DataRepository } from "./engine/data.js";
import { Renderer } from "./ui/renderer.js";
import { TeamBuilder } from "./ui/teambuilder.js";
import { MultiplayerClient, RemoteBattle, RemoteMultiBattle, isRealtimeConfigured } from "./network.js";

let data = null;
let app = null;
let multiplayer = null;
let multiplayerState = { role: null, team: null, opponentTeam: null, battleStarted: false, battleSize: 1 };

function setStartupMessage(title, detail = "", isError = false) {
  if (!app) app = document.querySelector("#app");
  if (!app) return;
  app.innerHTML = `<div class="startup-screen ${isError ? "startup-error" : ""}"><div class="startup-card"><div class="startup-spinner ${isError ? "hidden" : ""}></div><h1>${escapeHTML(title)}</h1>${detail ? `<p>${escapeHTML(detail)}</p>` : ""}${isError ? `<button id="retryGame" class="builder-primary" type="button">Retry</button>` : ""}</div></div>`;
  if (isError) app.querySelector("#retryGame")?.addEventListener("click", () => location.reload());
}

async function boot() {
  app = document.querySelector("#app");
  if (!app) return;
  setStartupMessage("Loading Pokémon Battle Engine...");
  try {
    data = await Promise.race([
      DataRepository.load(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Data loading timed out. Check that the Vercel deployment is serving the /data files from the project root.")), 45000))
    ]);
    mountBuilder();
  } catch (error) {
    console.error(error);
    setStartupMessage("Game failed to load", error?.stack || error?.message || String(error), true);
  }
}

function mountBuilder() {
  const builder = new TeamBuilder({
    root: app,
    data,
    onStart: payload => startBattle(payload),
    onMultiplayer: (mode, payload) => startMultiplayer(mode, payload)
  });
  builder.mount();
}

async function startMultiplayer(mode, payload) {
  if (!isRealtimeConfigured()) {
    alert("Online multiplayer needs a Supabase Realtime project. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in js/network.js (or configure them in your deployment).\n\nSee DEPLOY.md for the exact steps.");
    return;
  }
  if (multiplayer) multiplayer.leave();
  multiplayer = new MultiplayerClient({
    data,
    onStatus: status => { const el = document.querySelector("#mpStatus"); if (el) el.textContent = status; },
    onClose: () => {
      if (multiplayerState.battleStarted) return;
      const el = document.querySelector("#mpStatus"); if (el) el.textContent = "Multiplayer connection closed.";
    },
    onMessage: handleMultiplayerMessage
  });
  multiplayerState = { role: mode === "create" ? "host" : "guest", team: mode === "create" ? payload.team : payload.team, opponentTeam: null, battleStarted: false, battleSize: Number(payload.battleSize) || 1 };
  showMultiplayerLobby(mode, payload);
  try {
    await multiplayer.connect();
    if (mode === "create") await multiplayer.createRoom(payload);
    else await multiplayer.joinRoom(payload.code, payload.team);
  } catch (error) {
    console.error(error);
    const el = document.querySelector("#mpStatus"); if (el) el.textContent = error?.message || "Could not connect to online multiplayer.";
  }
}

function showMultiplayerLobby(mode, payload) {
  app.innerHTML = `<div class="startup-screen multiplayer-screen"><div class="startup-card multiplayer-card"><div class="startup-badge">ONLINE BATTLE</div><h1>${mode === "create" ? "Creating your room…" : "Joining room…"}</h1><p id="mpStatus">Connecting to the multiplayer server.</p><div id="roomCodeBox" class="room-code-box hidden"><span>ROOM CODE</span><strong id="roomCode">-----</strong><small>Send this code to your opponent.</small></div><button id="cancelMultiplayer" class="builder-secondary" type="button">← Back to Team Builder</button></div></div>`;
  app.querySelector("#cancelMultiplayer").onclick = () => { multiplayer?.leave(); multiplayer = null; mountBuilder(); };
}

function handleMultiplayerMessage(message) {
  if (message.type === "room_created") {
    app.querySelector("#mpStatus").textContent = "Room ready. Waiting for another trainer to join…";
    app.querySelector("#roomCode").textContent = message.code;
    app.querySelector("#roomCodeBox").classList.remove("hidden");
    return;
  }
  if (message.type === "join_request" && multiplayerState.role === "host") {
    multiplayerState.opponentTeam = message.guestTeam;
    multiplayerState.battleSize = Math.max(1, Math.min(10, Number(message.battleSize) || multiplayerState.battleSize || 1));
    app.querySelector("#mpStatus").textContent = `Opponent connected! Starting ${multiplayerState.battleSize}v${multiplayerState.battleSize} battle…`;
    multiplayer.send("match_start", { hostTeam: multiplayerState.team, guestTeam: multiplayerState.opponentTeam, battleSize: multiplayerState.battleSize });
    startHostNetworkBattle();
    return;
  }
  if (message.type === "match_start" && multiplayerState.role === "guest") {
    multiplayerState.opponentTeam = message.hostTeam;
    multiplayerState.battleSize = Math.max(1, Math.min(10, Number(message.battleSize) || multiplayerState.battleSize || 1));
    app.querySelector("#mpStatus").textContent = `Opponent connected! Starting ${multiplayerState.battleSize}v${multiplayerState.battleSize} battle…`;
    startGuestNetworkBattle();
    return;
  }
  if (message.type === "remote_move") { window.__networkBattle?.receiveRemoteMove?.(message.moveId); return; }
  if (message.type === "remote_switch") { window.__networkBattle?.receiveRemoteSwitch?.(message.index); return; }
  if (message.type === "remote_actions") { window.__networkBattle?.receiveRemoteActions?.(message.actions); return; }
  if (message.type === "snapshot") { window.__networkBattle?.applySnapshot?.(message.snapshot); return; }
  if (message.type === "opponent_left") { alert("Your opponent left the battle."); multiplayer?.leave(); multiplayer = null; mountBuilder(); return; }
  if (message.type === "error") alert(message.message || "Multiplayer error.");
}

function startHostNetworkBattle() {
  if (multiplayerState.battleStarted) return;
  multiplayerState.battleStarted = true;
  multiplayer.send("start");
  const BattleClass = multiplayerState.battleSize > 1 ? MultiBattle : Battle;
  const battle = new BattleClass({
    data,
    playerTeam: multiplayerState.team,
    opponentTeam: multiplayerState.opponentTeam,
    networkRole: "host",
    battleSize: multiplayerState.battleSize
  });
  window.__networkBattle = battle;
  mountBattleUI(battle, "host");
  battle.updateNetworkState = () => multiplayer?.send("snapshot", { snapshot: serializeBattle(battle) });
  renderer = new Renderer({ root: document, battle });
  renderer.bind();
  battle.onUpdate = () => {
    renderer?.render();
    battle.updateNetworkState?.();
  };
  renderer.render();
  battle.updateNetworkState();
}

function startGuestNetworkBattle() {
  if (multiplayerState.battleStarted) return;
  multiplayerState.battleStarted = true;
  const multi = multiplayerState.battleSize > 1;
  const battle = multi
    ? new RemoteMultiBattle({ data, role: "guest", team: multiplayerState.team, battleSize: multiplayerState.battleSize })
    : new RemoteBattle({ data, role: "guest", team: multiplayerState.team });
  if (multi) {
    battle.sendActions = actions => multiplayer.sendActions(actions);
  } else {
    battle.sendMove = moveId => multiplayer.sendMove(moveId);
    battle.sendSwitch = index => multiplayer.sendSwitch(index);
  }
  window.__networkBattle = battle;
  mountBattleUI(battle, "guest");
  renderer = new Renderer({ root: document, battle });
  renderer.bind();
  renderer.render();
}

let renderer = null;

function mountBattleUI(battle, role = "local") {
  if (battle.isMulti && battle.battleSize > 1) {
    app.innerHTML = `<div class="battle-page multi-battle-page">
      <header class="topbar"><div class="topbar-brand"><div class="brand-mark">◉</div><div><h1>Pokémon Battle</h1><span class="topbar-sub">${role === "local" ? "N-vs-N Arena" : `Online Match · ${role === "host" ? "Host" : "Guest"}`}</span></div></div>
      <div class="battle-header-actions"><span id="turnLabel" class="turn-pill">Turn 1</span><span id="fieldLabel" class="turn-pill field-pill">No Field</span><button id="backToBuilder" class="header-button" type="button">← Team Builder</button></div></header>
      <main><section class="multi-field"><span class="arena-label">Battle Arena · ${battle.battleSize}v${battle.battleSize}</span><div id="multiOppGrid" class="multi-side-grid"></div><div id="multiPlayerGrid" class="multi-side-grid player-side"></div></section>
      <section class="battle-log" id="battleLog" aria-live="polite"></section><section class="multi-controls"><div id="multiActionPanel"></div><button id="restartButton" class="secondary control-button" type="button">Team Builder</button></section></main></div>`;
  } else {
    app.innerHTML = `<div class="battle-page"><header class="topbar"><div class="topbar-brand"><div class="brand-mark">◉</div><div><h1>Pokémon Battle</h1><span class="topbar-sub">${role === "local" ? "Trainer Arena" : `Online Match · ${role === "host" ? "Host" : "Guest"}`}</span></div></div><div class="battle-header-actions"><span id="turnLabel" class="turn-pill">Turn 1</span><span id="fieldLabel" class="turn-pill field-pill">No Field</span><button id="backToBuilder" class="header-button" type="button">← Team Builder</button></div></header><main><section class="battlefield"><span class="arena-label">Battle Arena · ${role === "local" ? "Practice Match" : "Live Multiplayer"}</span><div class="side opponent"><div class="pokemon-info"><div class="sprite-box"><img id="oppSprite" alt=""></div><div class="pokemon-card"><h2 id="oppName">---</h2><div id="oppTypes" class="types"></div><div class="pokemon-meta">The opposing Pokémon</div><div class="hp-row"><div class="hpbar"><div id="oppHPFill"></div></div><span id="oppHPText" class="hp-text">0 / 0</span></div></div></div></div><div class="side player"><div class="pokemon-info"><div class="pokemon-card"><h2 id="playerName">---</h2><div id="playerTypes" class="types"></div><div class="pokemon-meta">Your Pokémon</div><div class="hp-row"><div class="hpbar"><div id="playerHPFill"></div></div><span id="playerHPText" class="hp-text">0 / 0</span></div></div><div class="sprite-box"><img id="playerSprite" alt=""></div></div></div></section><section class="battle-log" id="battleLog" aria-live="polite"></section><section class="controls"><div id="moveButtons" class="moves"></div><button id="switchButton" class="secondary control-button" type="button">Switch Pokémon</button><button id="restartButton" class="secondary control-button" type="button">Team Builder</button></section><section id="partyPanel" class="party hidden"></section></main></div>`;
  }
  document.querySelector("#backToBuilder").onclick = returnToBuilder;
  document.querySelector("#restartButton").onclick = returnToBuilder;
}
function returnToBuilder() {
  multiplayer?.leave();
  multiplayer = null;
  window.__networkBattle = null;
  multiplayerState = { role: null, team: null, opponentTeam: null, battleStarted: false, battleSize: 1 };
  mountBuilder();
}

function startBattle(payload) {
  try {
    const team = Array.isArray(payload) ? payload : payload.team;
    const battleSize = Array.isArray(payload) ? 1 : Math.max(1, Math.min(10, Number(payload.battleSize) || 1));
    if (battleSize > team.length) {
      throw new Error(`You need at least ${battleSize} Pokémon for a ${battleSize}v${battleSize} battle.`);
    }
    const BattleClass = battleSize > 1 ? MultiBattle : Battle;
    const battle = new BattleClass({ data, playerTeam: team, opponentTeam: data.teams.opponent, battleSize });
    mountBattleUI(battle, "local");
    renderer = new Renderer({ root: document, battle });
    renderer.bind();
    battle.onUpdate = () => renderer.render();
    renderer.render();
  } catch (error) {
    console.error(error);
    setStartupMessage("Battle could not be created", error?.stack || error?.message || String(error), true);
  }
}

function serializePokemon(p) {
  return {
    speciesId: p.speciesId, name: p.name, level: p.level, types: p.types, hp: p.hp, maxHP: p.maxHP,
    moveset: p.moves.map(m => ({ ...m })), ability: p.ability, item: p.item, itemUsed: p.itemUsed,
    choiceMove: p.choiceMove, status: p.status, statusData: p.statusData, volatile: p.volatile, originalTypes: p.originalTypes, fainted: p.fainted, sprites: p.sprites
  };
}

function serializeBattle(battle) {
  const base = {
    turn: battle.turn, over: battle.over, busy: battle.busy, locked: battle.locked,
    battleSize: battle.battleSize || 1,
    field: battle.field || null,
    weather: battle.field || null,
    terrain: battle.field || null,
    fieldTurns: battle.fieldTurns || 0,
    result: battle.result || null,
    awaitingPlayerSwitch: battle.awaitingPlayerSwitch,
    playerMoveSubmitted: !!battle.localMoveSubmitted,
    opponentMoveSubmitted: !!battle.remoteMoveSubmitted,
    playerActionsCount: battle.isMulti ? (battle.pendingActions?.player?.length || 0) : 0,
    opponentActionsCount: battle.isMulti ? (battle.pendingActions?.opponent?.length || 0) : 0,
    log: battle.log.slice(-100),
    player: { active: battle.player.active, team: battle.player.team.map(serializePokemon) },
    opponent: { active: battle.opponent.active, team: battle.opponent.team.map(serializePokemon) }
  };
  return base;
}

function escapeHTML(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" }[c])); }

window.addEventListener("error", event => console.error("Unhandled game error:", event.error || event.message));
window.addEventListener("unhandledrejection", event => console.error("Unhandled promise rejection:", event.reason));
boot();
