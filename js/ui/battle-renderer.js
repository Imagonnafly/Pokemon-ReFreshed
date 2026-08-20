import { moveTarget } from "../engine/rules.js";

export class BattleRenderer {
  constructor({ root = document, battle, role = "local" }) {
    this.root = root;
    this.battle = battle;
    this.role = role;
    this.selectedSlot = 0;
    this.targeting = null;
    this.bound = false;
    this.els = {};
  }

  bind() {
    if (this.bound) return;
    this.bound = true;
    this.cache();
    this.battle.onUpdate = () => this.render();
    this.root.querySelector("#battleBack")?.addEventListener("click", () => this.onBack?.());
    this.render();
  }

  cache() {
    const q = id => this.root.querySelector(`#${id}`);
    this.els = {
      arena: q("battleArena"), opponentField: q("enemyField"), playerField: q("selfField"),
      command: q("battleCommands"), log: q("battleLog"), turn: q("turnLabel"), field: q("fieldLabel"),
      party: q("partyPanel"), back: q("battleBack")
    };
  }

  escape(v) {
    return String(v ?? "").replace(/[&<>'"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","'":"&#039;",'"':"&quot;" }[c]));
  }

  isMulti() {
    return !!this.battle?.isMulti && Number(this.battle?.battleSize || 1) > 1;
  }

  slots(side) {
    if (this.isMulti()) return Array.isArray(this.battle?.[side]?.active) ? this.battle[side].active : [];
    const idx = this.battle?.[side]?.active;
    return Number.isFinite(Number(idx)) ? [Number(idx)] : [];
  }

  pending(side) {
    return Array.isArray(this.battle?.pendingActions?.[side]) ? this.battle.pendingActions[side] : [];
  }

  pendingForSlot(side, slot) {
    return this.pending(side).find(a => Number(a.slot) === Number(slot));
  }

  activePokemon(side, slot = 0) {
    const idx = this.slots(side)[slot];
    return idx === undefined ? null : this.battle[side]?.team?.[idx] ?? null;
  }

  hp(p) {
    const max = Math.max(1, Number(p?.maxHP ?? 1));
    const current = Math.max(0, Number(p?.hp ?? 0));
    return { max, current, pct: Math.max(0, Math.min(100, current / max * 100)) };
  }

  typeBadge(type) {
    return `<span class="poke-type poke-type-${this.escape(String(type).toLowerCase())}">${this.escape(type)}</span>`;
  }

  statusBadge(status) {
    return status ? `<span class="status-tag">${this.escape(status)}</span>` : "";
  }

  pokemonCard(p, side, slot, action) {
    if (!p) return "";
    const self = side === "player";
    const sprite = self ? (p.sprites?.back || p.sprites?.front) : (p.sprites?.front || p.sprites?.back);
    const { max, current, pct } = this.hp(p);
    const cls = [
      "battle-mon",
      self ? "battle-mon-self" : "battle-mon-enemy",
      !p.canBattle() ? "is-fainted" : "",
      action ? "is-locked" : "",
      self && slot === this.selectedSlot && !action ? "is-selected" : "",
      this.targeting && this.isValidTarget(side, this.slots(side)[slot]) ? "is-targetable" : "",
      this.targeting && !this.isValidTarget(side, this.slots(side)[slot]) ? "is-dimmed" : ""
    ].filter(Boolean).join(" ");

    return `<article class="${cls}" data-side="${side}" data-slot="${slot}" data-index="${this.slots(side)[slot]}">
      <div class="mon-info">
        <div class="mon-name"><strong>${this.escape(p.name)}</strong><span>Lv. ${this.escape(p.level ?? 50)}</span></div>
        <div class="mon-types">${(p.types || []).map(t => this.typeBadge(t)).join("")}${this.statusBadge(p.status)}</div>
        <div class="mon-hp"><div class="mon-hp-track"><span style="width:${pct}%"></span></div><span>${current}/${max}</span></div>
      </div>
      <div class="mon-sprite-wrap"><span class="mon-shadow"></span><img class="mon-sprite" src="${this.escape(sprite || "")}" alt="${this.escape(p.name)}" draggable="false"></div>
      ${action ? '<div class="lock-badge">READY</div>' : ""}
    </article>`;
  }

  renderField(side) {
    const box = side === "player" ? this.els.playerField : this.els.opponentField;
    if (!box) return;
    const slots = this.slots(side);
    box.innerHTML = slots.map((teamIndex, slot) => this.pokemonCard(
      this.battle[side]?.team?.[teamIndex], side, slot, this.pendingForSlot(side, slot)
    )).join("");
    box.querySelectorAll(".battle-mon").forEach(card => {
      card.addEventListener("click", () => this.onFieldClick(card.dataset.side, Number(card.dataset.index), Number(card.dataset.slot)));
    });
  }

  onFieldClick(side, teamIndex, slot) {
    const p = this.battle[side]?.team?.[teamIndex];
    if (!p?.canBattle()) return;

    if (this.targeting) {
      if (this.isValidTarget(side, teamIndex)) this.commitTarget(side, teamIndex);
      return;
    }

    if (side === "player" && !this.isMulti()) {
      return;
    }

    if (side === "player" && !this.pendingForSlot("player", slot) && !this.battle.busy) {
      this.selectedSlot = slot;
      this.render();
    }
  }

  targetMode(move) {
    return moveTarget(move);
  }

  isValidTarget(side, teamIndex) {
    if (!this.targeting) return false;
    const { slot, move } = this.targeting;
    if (!this.slots(side).includes(teamIndex)) return false;

    const mode = this.targetMode(move);
    const actorIndex = this.slots("player")[slot];
    if (mode === "self") return side === "player" && teamIndex === actorIndex;
    if (mode === "ally") return side === "player" && teamIndex !== actorIndex;
    if (mode === "any") return side === "player" || side === "opponent";
    return side === "opponent";
  }

  beginMove(move) {
    if (!move || this.battle.over || this.battle.busy) return;
    if (!this.isMulti()) {
      const mode = this.targetMode(move);
      if (mode === "self") {
        this.executeSingleMove(move.id);
      } else {
        this.executeSingleMove(move.id);
      }
      return;
    }

    const slot = this.selectedSlot;
    if (this.pendingForSlot("player", slot)) return;
    const teamIndex = this.slots("player")[slot];
    const actor = this.battle.player.team?.[teamIndex];
    if (!actor?.canBattle()) return;

    const mode = this.targetMode(move);
    if (mode === "self") {
      this.commitAction(slot, move.id, "player", teamIndex);
      return;
    }
    this.targeting = { slot, move, mode };
    this.render();
  }

  async executeSingleMove(moveId) {
    try {
      await this.battle.playerMove(moveId);
    } catch (error) {
      this.battle.busy = false;
      this.battle.locked = false;
      this.battle.write(`Couldn't use the move: ${error?.message || error}`);
    }
    this.render();
  }

  commitTarget(side, teamIndex) {
    const t = this.targeting;
    if (!t) return;
    this.commitAction(t.slot, t.move.id, side, teamIndex);
  }

  commitAction(slot, moveId, targetSide, targetIndex) {
    const ok = this.battle.setLocalAction?.(slot, moveId, targetSide, targetIndex);
    if (!ok) return;
    this.targeting = null;
    const next = this.findNextOpenSlot();
    if (next >= 0) this.selectedSlot = next;
    this.render();
  }

  commitSwitch(index) {
    if (!this.isMulti()) {
      if (this.battle.over || this.battle.busy && !this.battle.awaitingPlayerSwitch) return;
      this.battle.switchPlayer(index)?.then?.(() => this.render());
      return;
    }
    const slot = this.selectedSlot;
    if (this.pendingForSlot("player", slot)) return;
    if (this.battle.setLocalSwitch?.(slot, index)) {
      const next = this.findNextOpenSlot();
      if (next >= 0) this.selectedSlot = next;
      this.render();
    }
  }

  findNextOpenSlot() {
    if (!this.isMulti()) return -1;
    const required = this.battle.requiredSlots?.("player") || this.slots("player").map((_, i) => i);
    const pending = new Set(this.pending("player").map(a => Number(a.slot)));
    return required.find(slot => {
      const p = this.activePokemon("player", slot);
      return p?.canBattle() && !pending.has(Number(slot));
    }) ?? -1;
  }

  renderCommands() {
    const panel = this.els.command;
    if (!panel) return;

    if (this.battle.over) {
      const winner = this.battle.result?.winnerRole;
      const victory = winner === "local" || winner === "host" || winner === "coordinator";
      panel.innerHTML = `<div class="battle-result ${victory ? "win" : "loss"}"><strong>${victory ? "Victory!" : "Battle Over"}</strong><span>Return to the Team Builder when you're ready.</span></div>`;
      return;
    }

    if (this.isMulti()) {
      this.renderMultiCommands(panel);
    } else {
      this.renderSingleCommands(panel);
    }
  }

  renderSingleCommands(panel) {
    const p = this.activePokemon("player", 0);
    if (!p?.canBattle()) {
      panel.innerHTML = `<div class="command-empty"><strong>Choose a Pokémon.</strong><span>Select a healthy Pokémon from your team.</span></div>`;
      this.renderParty(true);
      return;
    }

    const moves = this.battle.getAvailableMoves?.() || [];
    const guestWaiting = this.battle.networkRole === "guest" && !this.battle.ready;
    const locked = this.battle.busy || this.battle.over || guestWaiting || (this.battle.networkRole && this.battle.localMoveSubmitted);

    const cards = moves.map(m => `<button class="move-card" data-move="${this.escape(m.id)}" ${locked ? "disabled" : ""}>
      <span class="move-name">${this.escape(m.name)}</span>
      <span class="move-meta">${(m.types || []).map(t => this.escape(t)).join(" / ")} · ${this.escape(m.category || "status")}</span>
      <span class="move-pp">${m.pp ?? "—"} PP</span>
    </button>`).join("");

    panel.innerHTML = `<div class="command-head"><div><span class="eyebrow">YOUR COMMAND</span><h2>${this.escape(p.name)}</h2></div><button class="plain-button" id="openParty">Switch</button></div>
      <div class="move-grid">${cards || '<div class="command-empty">No moves available.</div>'}</div>`;

    panel.querySelectorAll("[data-move]").forEach(btn => btn.addEventListener("click", () => this.beginMove(
      moves.find(m => m.id === btn.dataset.move)
    )));
    panel.querySelector("#openParty")?.addEventListener("click", () => this.renderParty(true));
  }

  renderMultiCommands(panel) {
    const activeIndex = this.slots("player")[this.selectedSlot];
    const p = this.battle.player.team?.[activeIndex];
    if (!p?.canBattle()) {
      panel.innerHTML = `<div class="command-empty"><strong>Select a healthy active Pokémon.</strong><span>Click one of your Pokémon above, then choose its action.</span></div>`;
      return;
    }

    const required = this.battle.requiredSlots?.("player")?.length ?? this.slots("player").length;
    const mine = this.pending("player").length;
    const pending = this.pendingForSlot("player", this.selectedSlot);
    const allLocked = mine >= required;
    const moves = this.battle.getAvailableMovesFor?.(p) || [];
    const disabled = !!pending || this.battle.busy || allLocked;

    const cards = moves.map(m => `<button class="move-card" data-move="${this.escape(m.id)}" ${disabled ? "disabled" : ""}>
      <span class="move-name">${this.escape(m.name)}</span>
      <span class="move-meta">${(m.types || []).join(" / ")} · ${this.escape(m.category || "status")}</span>
      <span class="move-pp">${m.pp ?? "—"} PP</span>
    </button>`).join("");

    const activeSet = new Set(this.slots("player"));
    const bench = (this.battle.player.team || []).map((p2, i) => ({p:p2,i}))
      .filter(x => x.p?.canBattle() && !activeSet.has(x.i));

    panel.innerHTML = `<div class="command-head"><div><span class="eyebrow">ACTIVE SLOT ${this.selectedSlot + 1}</span><h2>${this.escape(p.name)}</h2></div><span class="ready-counter">${mine}/${required} READY</span></div>
      ${this.targeting ? `<div class="target-banner">Select a target for <strong>${this.escape(this.targeting.move.name)}</strong><button id="cancelTarget" class="plain-button">Cancel</button></div>` : ""}
      <div class="move-grid">${cards}</div>
      <div class="bench-head">TEAM</div>
      <div class="bench-grid">${bench.map(x => `<button class="bench-card" data-switch="${x.i}" ${disabled ? "disabled" : ""}>
        <img src="${this.escape(x.p.sprites?.front || x.p.sprites?.back || "")}" alt=""><span>${this.escape(x.p.name)}</span><small>${x.p.hp}/${x.p.maxHP}</small>
      </button>`).join("") || '<span class="muted">No available healthy bench Pokémon.</span>'}</div>`;

    panel.querySelectorAll("[data-move]").forEach(btn => btn.addEventListener("click", () => this.beginMove(moves.find(m => m.id === btn.dataset.move))));
    panel.querySelectorAll("[data-switch]").forEach(btn => btn.addEventListener("click", () => this.commitSwitch(Number(btn.dataset.switch))));
    panel.querySelector("#cancelTarget")?.addEventListener("click", () => { this.targeting = null; this.render(); });
  }

  renderParty(forceOpen = false) {
    if (!this.els.party) return;
    if (!forceOpen && !this.battle.awaitingPlayerSwitch) {
      this.els.party.classList.add("hidden");
      return;
    }

    this.els.party.classList.remove("hidden");
    const activeSet = new Set(this.slots("player"));
    this.els.party.innerHTML = `<div class="party-overlay"><div class="party-window">
      <div class="party-head"><div><span class="eyebrow">YOUR TEAM</span><h3>${this.battle.awaitingPlayerSwitch ? "Choose a replacement" : "Switch Pokémon"}</h3></div>
      <button id="closeParty" class="plain-button">Close</button></div>
      <div class="party-grid">${(this.battle.player?.team || []).map((p, i) => `<button class="party-card" data-party="${i}" ${!p?.canBattle() || activeSet.has(i) || this.battle.over || (this.battle.busy && !this.battle.awaitingPlayerSwitch) ? "disabled" : ""}>
        <img src="${this.escape(p.sprites?.front || p.sprites?.back || "")}" alt="">
        <span><strong>${this.escape(p.name)}</strong><small>${p.hp}/${p.maxHP}</small></span>
      </button>`).join("")}</div>
    </div></div>`;

    this.els.party.querySelector("#closeParty")?.addEventListener("click", () => {
      if (!this.battle.awaitingPlayerSwitch) this.els.party.classList.add("hidden");
    });
    this.els.party.querySelectorAll("[data-party]").forEach(btn => btn.addEventListener("click", () => this.commitSwitch(Number(btn.dataset.party))));
  }

  renderLog() {
    if (!this.els.log) return;
    const lines = Array.isArray(this.battle.log) ? this.battle.log.slice(-120) : [];
    const mine = this.pending("player").length;
    const theirs = this.battle.networkRole ? Number(this.battle.remoteActionsCount || 0) : this.pending("opponent").length;
    const need = this.isMulti() ? (this.battle.requiredSlots?.("player")?.length || this.slots("player").length) : 1;
    let footer = "";
    if (!this.battle.over) {
      if (this.battle.busy) footer = `<div class="log-state">Resolving turn…</div>`;
      else if (this.isMulti() && mine >= need) footer = `<div class="log-state">Your side is ready. Waiting for the opponent (${Math.min(theirs, need)}/${need}).</div>`;
      else footer = `<div class="log-state">${this.isMulti() ? `Choose actions for ${Math.max(0, need - mine)} Pokémon.` : "Choose a move."}</div>`;
    }
    this.els.log.innerHTML = lines.map(line => `<div class="log-line">${this.escape(line)}</div>`).join("") + footer;
    this.els.log.scrollTop = this.els.log.scrollHeight;
  }

  renderHeader() {
    if (this.els.turn) this.els.turn.textContent = `Turn ${this.battle.turn}${this.isMulti() ? ` · ${this.battle.battleSize}v${this.battle.battleSize}` : ""}`;
    if (this.els.field) this.els.field.textContent = this.battle.field || "No Field";
  }

  render() {
    this.cache();
    this.renderHeader();
    this.renderField("opponent");
    this.renderField("player");
    this.renderCommands();
    this.renderLog();
    this.renderParty();
    this.els.arena?.setAttribute("data-count", String(this.isMulti() ? this.battle.battleSize : 1));
  }
}
