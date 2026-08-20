import { GAME_CONFIG, clampBattleSize, clampTeamSize } from "./config.js";
import { Battle } from "./engine/battle.js";
import { MultiBattleV2 } from "./engine/multi-battle-v2.js";
import { DataRepository } from "./engine/data.js";
import { Renderer } from "./ui/renderer.js";
import { MultiRendererV2 } from "./ui/multi-renderer-v2.js";
import { TeamBuilder } from "./ui/teambuilder.js";
import { MultiplayerClient, RemoteBattle, PartyMatchClient, RemotePartyBattle, isRealtimeConfigured } from "./network.js";
import { PartyBattle } from "./engine/party-battle.js";
import { RemoteMultiBattleV2 } from "./network/multi-network-v2.js";
import { PartyRenderer } from "./ui/party-renderer.js";

let data = null;
let app = null;
let multiplayer = null;
let partyClient = null;
let multiplayerState = { role: null, team: null, opponentTeam: null, battleStarted: false, battleSize: 1, teamSize: 1 };
let partyState = { mode: null, team: null, party: null, match: null, battleStarted: false, battleSize: 1, teamSize: 1 };

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
  if (["quickMatch", "createParty", "joinParty"].includes(mode)) {
    return startPartySocial(mode, payload);
  }
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
  multiplayerState = { role: mode === "create" ? "host" : "guest", team: payload.team, opponentTeam: null, battleStarted: false, battleSize: Number(payload.battleSize) || 1, teamSize: Number(payload.teamSize) || 1 };
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


async function startPartySocial(mode, payload) {
  if (!isRealtimeConfigured()) {
    showSocialLobby("error", { message: "Online matchmaking needs Supabase Realtime configured." });
    return;
  }
  partyClient?.leave();
  partyClient = new PartyMatchClient({
    data,
    team: payload.team,
    onStatus: status => { const el = document.querySelector("#socialStatus"); if (el) el.textContent = status; },
    onParty: party => updatePartyLobby(party),
    onMatch: match => handlePartyMatch(match),
    onPartyAction: action => {
      if (action?.kind === "normal_actions") { window.__networkBattle?.receiveRemoteActions?.(action.actions); return; }
      if (action?.kind === "normal_move") { window.__networkBattle?.receiveRemoteMove?.(action.moveId); return; }
      if (action?.kind === "normal_switch") { window.__networkBattle?.receiveRemoteSwitch?.(action.index); return; }
      window.__partyBattle?.receiveRemotePartyAction?.(action);
    },
    onPartySnapshot: snapshot => window.__networkBattle?.applySnapshot?.(snapshot) || window.__partyBattle?.applySnapshot?.(snapshot)
  });
  partyState = { mode, team: payload.team, party: null, match: null, battleStarted: false, battleSize: Number(payload.battleSize) || 1, teamSize: Number(payload.teamSize) || 1 };
  showSocialLobby(mode, Number(payload.battleSize) || 1, Number(payload.teamSize) || 1);
  try {
    await partyClient.connect();
    if (mode === "quickMatch") {
      const battleSize = clampBattleSize(payload.battleSize);
      const teamSize = clampTeamSize(payload.teamSize);
      if ((payload.team || []).length < battleSize) throw new Error(`You need at least ${battleSize} Pokémon for a ${battleSize}v${battleSize} match.`);
      await partyClient.queueSolo("match", battleSize, teamSize);
      setSocialTitle(`Finding a ${battleSize}v${battleSize} · ${teamSize} trainers per team…`);
    } else if (mode === "createParty") {
      const code = await partyClient.createParty();
      partyState.party = partyClient.party;
      updatePartyLobby(partyClient.party);
    } else if (mode === "joinParty") {
      setSocialTitle("Enter your party code above");
      const input = document.querySelector("#partyCodeInput");
      input?.focus();
    }
  } catch (error) {
    console.error(error);
    setSocialTitle("Could not connect");
    const el = document.querySelector("#socialStatus"); if (el) el.textContent = error?.message || "Connection failed.";
  }
}

function showSocialLobby(mode, battleSize = 1, teamSize = 1) {
  const join = mode === "joinParty";
  const quick = mode === "quickMatch";
  const normal = mode === "quickMatch";
  app.innerHTML = `<div class="startup-screen multiplayer-screen"><div class="startup-card multiplayer-card social-card">
    <div class="startup-badge">${quick ? "MATCHMAKING" : "TRAINER PARTY"}</div>
    <h1 id="socialTitle">${normal ? `Finding ${battleSize}v${battleSize} · ${teamSize} trainers/team…` : mode === "createParty" ? "Create a Party" : "Join a Party"}</h1>
    <p id="socialStatus">Connecting to the online service…</p>
    ${join ? `<div class="social-code-entry"><label for="partyCodeInput">Party Code</label><input id="partyCodeInput" maxlength="5" autocomplete="off" placeholder="ABCDE"><button id="confirmPartyJoin" class="builder-primary" type="button">Join Party</button></div>` : ""}
    <div id="socialPartyPanel" class="social-party-panel hidden"></div>
    <div id="socialMatchPanel" class="social-match-panel hidden"></div>
    <button id="cancelSocial" class="builder-secondary" type="button">← Back to Team Builder</button>
  </div></div>`;
  app.querySelector("#cancelSocial").onclick = () => { partyClient?.leave(); partyClient = null; partyState = { mode:null,team:null,party:null,match:null,battleStarted:false,battleSize:1,teamSize:1 }; mountBuilder(); };
  app.querySelector("#confirmPartyJoin")?.addEventListener("click", async () => {
    const code = app.querySelector("#partyCodeInput")?.value.trim().toUpperCase();
    if (!code) return;
    try { await partyClient.joinParty(code); setSocialTitle("Joining party…"); } catch (e) { const el = app.querySelector("#socialStatus"); if (el) el.textContent = e.message; }
  });
}

function setSocialTitle(text) { const el = document.querySelector("#socialTitle"); if (el) el.textContent = text; }
function setPartyCode(code) {
  const panel = document.querySelector("#socialPartyPanel"); if (!panel) return;
  panel.classList.remove("hidden");
  panel.innerHTML = `<div class="party-code-display"><span>PARTY CODE</span><strong>${escapeHTML(code)}</strong><small>Invite one friend with this code.</small></div>`;
}
function updatePartyLobby(party) {
  partyState.party = party;
  const panel = document.querySelector("#socialPartyPanel"); if (!panel) return;
  panel.classList.remove("hidden");
  const members = (party?.members || []).map(m => `<div class="party-member"><span class="party-avatar">${escapeHTML((m.name || "T").slice(0,1))}</span><div><strong>${escapeHTML(m.name)}</strong><small>${m.host ? "Party Leader" : "Teammate"}</small></div></div>`).join("");
  const isHost = party?.hostId === partyClient?.identity?.id;
  panel.innerHTML = `<div class="party-lobby-card">${party.code ? `<div class="party-code-display"><span>PARTY CODE</span><strong>${escapeHTML(party.code)}</strong><small>Invite teammates · up to ${GAME_CONFIG.matchmaking.maxTrainersPerTeam} trainers.</small></div>` : ''}<div class="party-lobby-head"><div><span class="eyebrow">PARTY</span><h3>${party.members?.length || 0} trainers</h3></div><span class="party-online-dot">LIVE</span></div><div class="party-members">${members}</div>${isHost ? `<button id="queuePartyButton" class="builder-primary" type="button" ${party.members?.length >= 2 ? "" : "disabled"}>Find Match for Party</button>` : `<p class="social-subtle">Waiting for your party leader to start matchmaking…</p>`}</div>`;
  panel.querySelector("#queuePartyButton")?.addEventListener("click", async () => {
    try { const battleSize = Number(partyState.battleSize) || 1; const teamSize = clampTeamSize(partyState.teamSize, 2); await partyClient.queueParty("match", battleSize, teamSize); setSocialTitle(`Finding ${battleSize}v${battleSize} · ${teamSize} trainers/team…`); } catch (e) { setSocialTitle(e.message); }
  });
  if (party.members?.length >= 2 && partyState.teamSize > 1) setSocialTitle(`Party ready · ${partyState.battleSize}v${partyState.battleSize} · ${partyState.teamSize} trainers/team`);
}

function handlePartyMatch(match) {
  if (!match?.members) return;
  if (match.kind === "normal") return handleNormalMatch(match);
  partyState.match = match;
  const panel = document.querySelector("#socialMatchPanel");
  if (panel) {
    panel.classList.remove("hidden");
    const teamSize = clampTeamSize(match.teamSize, 2);
    const battleSize = clampBattleSize(match.battleSize);
    panel.innerHTML = `<div class="match-found-card"><div class="match-pulse"></div><span class="eyebrow">MATCH FOUND</span><h3>${teamSize} trainers/team · ${battleSize}v${battleSize}</h3><p>${teamSize * 2} trainers are getting ready…</p></div>`;
  }
  if (!match.ready || partyState.battleStarted) return;
  startPartyBattle(match);
}

function handleNormalMatch(match) {
  partyState.match = match;
  const panel = document.querySelector("#socialMatchPanel");
  if (panel) {
    panel.classList.remove("hidden");
    panel.innerHTML = `<div class="match-found-card"><div class="match-pulse"></div><span class="eyebrow">MATCH FOUND</span><h3>${match.battleSize}v${match.battleSize} Match</h3><p>Two trainers are getting ready…</p></div>`;
  }
  if (!match.ready || partyState.battleStarted) return;
  startNormalMatch(match);
}

function startNormalMatch(match) {
  if (partyState.battleStarted) return;
  partyState.battleStarted = true;
  const me = match.members.find(m => m.id === partyClient.identity.id);
  if (!me) return;
  const alpha = match.members.find(m => m.side === "alpha");
  const beta = match.members.find(m => m.side === "beta");
  if (!alpha || !beta) return;
  const isCoordinator = partyClient.identity.id === match.coordinatorId;
  if (isCoordinator) {
    const battleSize = clampBattleSize(match.battleSize);
    const BattleClass = battleSize > 1 ? MultiBattleV2 : Battle;
    const battle = new BattleClass({
      data,
      playerTeam: alpha.team,
      opponentTeam: beta.team,
      networkRole: "host",
      battleSize
    });
    window.__networkBattle = battle;
    battle.updateNetworkState = () => partyClient?.sendPartySnapshot(serializeBattle(battle));
    mountBattleUI(battle, "host");
    if (battle.isMulti) {
      const multiRenderer = new MultiRendererV2({ root: document, battle });
      window.__multiRenderer = multiRenderer;
      multiRenderer.bind();
      battle.onUpdate = () => { multiRenderer.render(); battle.updateNetworkState?.(); };
      multiRenderer.render();
    } else {
      renderer = new Renderer({ root: document, battle });
      renderer.bind();
      battle.onUpdate = () => { renderer?.render(); battle.updateNetworkState?.(); };
      renderer.render();
    }
    battle.updateNetworkState();
  } else {
    const battleSize = clampBattleSize(match.battleSize);
    const multi = battleSize > 1;
    const battle = multi
      ? new RemoteMultiBattleV2({ data, role: "guest", team: beta.team, battleSize })
      : new RemoteBattle({ data, role: "guest", team: beta.team });
    if (multi) battle.sendActions = actions => partyClient?.sendPartyAction({ kind: "normal_actions", actions });
    else {
      battle.sendMove = moveId => partyClient?.sendPartyAction({ kind: "normal_move", moveId });
      battle.sendSwitch = index => partyClient?.sendPartyAction({ kind: "normal_switch", index });
    }
    window.__networkBattle = battle;
    mountBattleUI(battle, "guest");
    if (battle.isMulti) {
      const multiRenderer = new MultiRendererV2({ root: document, battle });
      window.__multiRenderer = multiRenderer;
      multiRenderer.bind();
      battle.onUpdate = () => multiRenderer.render();
      multiRenderer.render();
    } else {
      renderer = new Renderer({ root: document, battle });
      renderer.bind();
      renderer.render();
    }
  }
}

function startPartyBattle(match) {
  if (partyState.battleStarted) return;
  partyState.battleStarted = true;
  const me = match.members.find(m => m.id === partyClient.identity.id);
  if (!me) return;
  if (partyClient.identity.id === match.coordinatorId) {
    const battle = new PartyBattle({ data, members: match.members, networkRole: "coordinator", localMemberId: partyClient.identity.id, coordinatorId: match.coordinatorId, battleSize: match.battleSize, teamSize: match.teamSize });
    window.__partyBattle = battle;
    battle.updateNetworkState = () => partyClient?.sendPartySnapshot(serializePartyBattle(battle));
    battle.sendPartyAction = action => partyClient?.sendPartyAction(action);
    mountPartyBattleUI(battle, "coordinator");
    const partyRenderer = new PartyRenderer({ root: document, battle });
    partyRenderer.bind();
    window.__partyRenderer = partyRenderer;
    battle.onUpdate = () => { partyRenderer.render(); battle.updateNetworkState?.(); };
    partyRenderer.render();
    battle.updateNetworkState();
  } else {
    const battle = new RemotePartyBattle({ data, match: { ...match, battleSize: match.battleSize, teamSize: match.teamSize }, localMemberId: partyClient.identity.id });
    battle.sendPartyAction = action => partyClient?.sendPartyAction(action);
    window.__partyBattle = battle;
    mountPartyBattleUI(battle, "member");
    const partyRenderer = new PartyRenderer({ root: document, battle });
    partyRenderer.bind();
    window.__partyRenderer = partyRenderer;
    battle.onUpdate = () => partyRenderer.render();
    partyRenderer.render();
  }
}

function mountPartyBattleUI(battle, role) {
  const teamSize = clampTeamSize(battle.teamSize || Number(battle.members?.length / 2) || 2, 1);
  const battleSize = clampBattleSize(battle.battleSize);
  app.innerHTML = `<div class="battle-page sd-v4 sd-party-v4">
    <header class="v4-topbar">
      <div class="v4-brand"><div class="v4-brand-mark">◉</div><div><h1>Pokémon Battle</h1><span>${teamSize} trainers/team · ${battleSize} active/trainer</span></div></div>
      <div class="v4-top-actions"><span id="turnLabel" class="v4-pill">Turn 1</span><span id="fieldLabel" class="v4-pill">No Field</span><button id="partyLeaveButton" class="v4-button">Leave Battle</button></div>
    </header>
    <main class="v4-main">
      <section class="v4-left">
        <section class="v4-field-panel">
          <div class="v4-field-head"><div><span class="v4-eyebrow">TEAM BATTLE</span><h2>${battleSize} ACTIVE · ${teamSize} TRAINERS / TEAM</h2></div><div id="partyCommandHint" class="v4-hint"><span class="v4-live-dot"></span><span>Click your Pokémon, choose a move, then click a target.</span></div></div>
          <section class="v4-arena v4-party-arena">
            <div class="v4-side-label"><strong>OPPONENT</strong><span>${teamSize} TRAINERS</span></div>
            <div id="partyEnemyRow" class="v4-party-side v4-enemy-side"></div>
            <div class="v4-center-line"></div>
            <div class="v4-side-label"><strong>YOUR TEAM</strong><span>${teamSize} TRAINERS</span></div>
            <div id="partyAllyRow" class="v4-party-side v4-ally-side"></div>
          </section>
        </section>
        <section class="v4-command" id="partyMovePanel"></section>
      </section>
      <aside class="v4-log"><div class="v4-log-head"><strong>BATTLE LOG</strong><span>LIVE</span></div><div class="v4-log-body" id="battleLog" aria-live="polite"></div></aside>
    </main>
  </div>`;
  document.querySelector('#partyLeaveButton').onclick = () => { partyClient?.leave(); partyClient = null; window.__partyBattle = null; mountBuilder(); };
}

function serializePartyPokemon(p) {
  return { speciesId:p.speciesId,name:p.name,level:p.level,types:p.types,hp:p.hp,maxHP:p.maxHP,moveset:p.moves.map(m=>({...m})),ability:p.ability,item:p.item,status:p.status,statusData:p.statusData,volatile:p.volatile,originalTypes:p.originalTypes,fainted:p.fainted,sprites:p.sprites };
}
function serializePartyBattle(battle) {
  return {
    turn: battle.turn,
    over: battle.over,
    busy: battle.busy,
    locked: battle.locked,
    battleSize: battle.battleSize || 1,
    teamSize: battle.teamSize || 2,
    field: battle.field || null,
    fieldTurns: battle.fieldTurns || 0,
    result: battle.result || null,
    pendingIds: [...(battle.pendingPartyActions || new Map()).keys()],
    log: battle.log.slice(-120),
    members: battle.members.map(m => ({
      id: m.id,
      name: m.name,
      side: m.side,
      active: Array.isArray(m.active) ? [...m.active] : [Number(m.active) || 0],
      team: m.team.map(serializePartyPokemon)
    }))
  };
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
    multiplayerState.battleSize = clampBattleSize(message.battleSize, multiplayerState.battleSize || 1);
    app.querySelector("#mpStatus").textContent = `Opponent connected! Starting ${multiplayerState.battleSize}v${multiplayerState.battleSize} battle…`;
    multiplayer.send("match_start", { hostTeam: multiplayerState.team, guestTeam: multiplayerState.opponentTeam, battleSize: multiplayerState.battleSize });
    startHostNetworkBattle();
    return;
  }
  if (message.type === "match_start" && multiplayerState.role === "guest") {
    multiplayerState.opponentTeam = message.hostTeam;
    multiplayerState.battleSize = clampBattleSize(message.battleSize, multiplayerState.battleSize || 1);
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
  const BattleClass = multiplayerState.battleSize > 1 ? MultiBattleV2 : Battle;
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
  if (battle.isMulti) {
    const multiRenderer = new MultiRendererV2({ root: document, battle });
    window.__multiRenderer = multiRenderer;
    multiRenderer.bind();
    battle.onUpdate = () => { multiRenderer.render(); battle.updateNetworkState?.(); };
    multiRenderer.render();
  } else {
    renderer = new Renderer({ root: document, battle });
    renderer.bind();
    battle.onUpdate = () => { renderer?.render(); battle.updateNetworkState?.(); };
    renderer.render();
  }
  battle.updateNetworkState();
}

function startGuestNetworkBattle() {
  if (multiplayerState.battleStarted) return;
  multiplayerState.battleStarted = true;
  const multi = multiplayerState.battleSize > 1;
  const battle = multi
    ? new RemoteMultiBattleV2({ data, role: "guest", team: multiplayerState.team, battleSize: multiplayerState.battleSize })
    : new RemoteBattle({ data, role: "guest", team: multiplayerState.team });
  if (multi) {
    battle.sendActions = actions => multiplayer.sendActions(actions);
  } else {
    battle.sendMove = moveId => multiplayer.sendMove(moveId);
    battle.sendSwitch = index => multiplayer.sendSwitch(index);
  }
  window.__networkBattle = battle;
  mountBattleUI(battle, "guest");
  if (battle.isMulti) {
    const multiRenderer = new MultiRendererV2({ root: document, battle });
    window.__multiRenderer = multiRenderer;
    multiRenderer.bind();
    battle.onUpdate = () => multiRenderer.render();
    multiRenderer.render();
  } else {
    renderer = new Renderer({ root: document, battle });
    renderer.bind();
    renderer.render();
  }
}

let renderer = null;

function mountBattleUI(battle, role = "local") {
  const multi = !!battle.isMulti && Number(battle.battleSize || 1) > 1;
  const count = multi ? Number(battle.battleSize) : 1;
  app.innerHTML = `
    <div class="battle-page modern-battle" data-count="${count}">
      <header class="battle-topbar">
        <div class="brand">
          <div class="brand-icon">P</div>
          <div><strong>Pokémon Battle</strong><span>${role === "local" ? (multi ? "N-vs-N Arena" : "Practice Arena") : `Online Match · ${role === "host" ? "Host" : "Guest"}`}</span></div>
        </div>
        <div class="battle-top-actions">
          <span id="turnLabel" class="battle-pill">Turn 1${multi ? ` · ${count}v${count}` : ""}</span>
          <span id="fieldLabel" class="battle-pill">No Field</span>
          <button id="battleBack" class="battle-button ghost" type="button">← Team Builder</button>
        </div>
      </header>

      <main class="battle-layout">
        <section class="battle-main">
          <section class="battle-arena" id="battleArena">
            <div class="arena-grid enemy" id="enemyField"></div>
            <div class="arena-divider"><span>VS</span></div>
            <div class="arena-grid self" id="selfField"></div>
          </section>
          <section class="battle-commands" id="battleCommands"></section>
        </section>

        <aside class="battle-sidebar">
          <div class="sidebar-title"><strong>BATTLE LOG</strong><span>LIVE</span></div>
          <div class="battle-log" id="battleLog" aria-live="polite"></div>
        </aside>
      </main>

      <section id="partyPanel" class="party-layer hidden"></section>
    </div>`;

  document.querySelector("#battleBack")?.addEventListener("click", returnToBuilder);
}

function returnToBuilder() {
  multiplayer?.leave();
  multiplayer = null;
  partyClient?.leave();
  partyClient = null;
  window.__partyBattle = null;
  window.__partyRenderer = null;
  window.__networkBattle = null;
  multiplayerState = { role: null, team: null, opponentTeam: null, battleStarted: false, battleSize: 1, teamSize: 1 };
  mountBuilder();
}

function startBattle(payload) {
  try {
    const team = Array.isArray(payload) ? payload : payload.team;
    const battleSize = Array.isArray(payload) ? 1 : clampBattleSize(payload.battleSize);
    if (battleSize > team.length) {
      throw new Error(`You need at least ${battleSize} Pokémon for a ${battleSize}v${battleSize} battle.`);
    }
    const BattleClass = battleSize > 1 ? MultiBattleV2 : Battle;
    const battle = new BattleClass({ data, playerTeam: team, opponentTeam: data.teams.opponent, battleSize });
    mountBattleUI(battle, "local");
    if (battle.isMulti) {
      const multiRenderer = new MultiRendererV2({ root: document, battle });
      window.__multiRenderer = multiRenderer;
      multiRenderer.bind();
      battle.onUpdate = () => multiRenderer.render();
      multiRenderer.render();
    } else {
      renderer = new Renderer({ root: document, battle });
      renderer.bind();
      battle.onUpdate = () => renderer.render();
      renderer.render();
    }
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
