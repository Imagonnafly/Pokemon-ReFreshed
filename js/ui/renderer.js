export class Renderer {
  constructor({root, battle}) {
    this.root = root;
    this.battle = battle;
    this.isMulti = !!battle.isMulti && Number(battle.battleSize) > 1;
    this.multiSelectedSlot = 0;
    this.multiTargeting = null;
    this.multiHoverTarget = null;
    this.els = {
      turn: root.querySelector("#turnLabel"),
      field: root.querySelector("#fieldLabel"),
      oppName: root.querySelector("#oppName"),
      playerName: root.querySelector("#playerName"),
      oppTypes: root.querySelector("#oppTypes"),
      playerTypes: root.querySelector("#playerTypes"),
      oppHPFill: root.querySelector("#oppHPFill"),
      playerHPFill: root.querySelector("#playerHPFill"),
      oppHPText: root.querySelector("#oppHPText"),
      playerHPText: root.querySelector("#playerHPText"),
      oppSprite: root.querySelector("#oppSprite"),
      playerSprite: root.querySelector("#playerSprite"),
      log: root.querySelector("#battleLog"),
      moves: root.querySelector("#moveButtons"),
      party: root.querySelector("#partyPanel"),
      switchButton: root.querySelector("#switchButton"),
      restart: root.querySelector("#restartButton"),
      multiOppGrid: root.querySelector("#multiOppGrid"),
      multiPlayerGrid: root.querySelector("#multiPlayerGrid"),
      multiActionPanel: root.querySelector("#multiActionPanel"),
      multiActiveTabs: root.querySelector("#multiActiveTabs"),
      multiTargetHint: root.querySelector("#multiTargetHint")
    };
  }

  bind() {
    this.battle.onUpdate = () => this.render();

    this.els.restart?.addEventListener("click", () => location.reload());
    this.els.backToBuilder?.addEventListener("click", () => location.reload());

    if (!this.isMulti && this.els.switchButton) {
      this.els.switchButton.onclick = () => {
        if (this.battle.busy || this.battle.over) return;
        this.els.party.classList.toggle("hidden");
        this.renderParty();
      };
    }
  }

  render() {
    if (this.isMulti) return this.renderMulti();
    return this.renderSingle();
  }

  renderSingle() {
    const player = this.battle.active("player");
    const opponent = this.battle.active("opponent");
    this.renderPokemon(player, "player");
    this.renderPokemon(opponent, "opp");
    this.renderMoves();
    this.renderParty();

    if (this.battle.awaitingPlayerSwitch) {
      this.els.party?.classList.remove("hidden");
      if (this.els.switchButton) {
        this.els.switchButton.disabled = true;
        this.els.switchButton.textContent = "Choose a Pokémon...";
      }
    } else if (this.els.switchButton) {
      this.els.switchButton.disabled = this.battle.busy || this.battle.over;
      this.els.switchButton.textContent = "Switch Pokémon";
    }

    this.renderTurnAndField();
    this.renderLog();
  }

  renderMulti() {
    this.normalizeMultiSelection();
    this.renderTurnAndField();
    this.renderMultiGrid("opponent", this.els.multiOppGrid);
    this.renderMultiGrid("player", this.els.multiPlayerGrid);
    this.renderMultiControls();
    this.renderLog();
  }

  normalizeMultiSelection() {
    const active = this.battle.activeIndices("player") || [];
    const pending = this.getLocalPendingActions();
    const submittedSlots = new Set(pending.map(a => a.slot));
    const currentTeamIndex = this.battle.player?.active?.[this.multiSelectedSlot];
    if (!active.includes(currentTeamIndex)) this.multiSelectedSlot = 0;
    const selectedTeamIndex = this.battle.player?.active?.[this.multiSelectedSlot];
    if (submittedSlots.has(this.multiSelectedSlot) || !this.battle.player?.team?.[selectedTeamIndex]?.canBattle()) {
      const next = active.findIndex((teamIndex, slot) => {
        const p = this.battle.player.team[teamIndex];
        return p?.canBattle() && !submittedSlots.has(slot);
      });
      if (next >= 0) this.multiSelectedSlot = next;
    }
    if (this.multiTargeting && submittedSlots.has(this.multiTargeting.slot)) this.multiTargeting = null;
  }

  getLocalPendingActions() {
    if (Array.isArray(this.battle.pendingActions?.player)) return this.battle.pendingActions.player;
    return Array.isArray(this.battle.localActions) ? this.battle.localActions : [];
  }

  getSelfTargetMoves() {
    return new Set([
      "agility", "bulk-up", "dragon-cheer", "endure", "protect", "rest", "roost",
      "substitute", "sunny-day", "swords-dance", "sleep-talk"
    ]);
  }

  getTargetMode(move) {
    const explicit = String(move?.target || move?.targeting || "").toLowerCase();
    if (["self"].includes(explicit) || this.getSelfTargetMoves().has(move.id)) return "self";
    if (["ally", "ally-one", "teammate", "player"].includes(explicit) || move.id === "helping-hand") return "ally";
    if (["any", "all"].includes(explicit)) return "any";
    return "opponent";
  }

  getValidTargetSides(move) {
    const mode = this.getTargetMode(move);
    if (mode === "self") return ["player"];
    if (mode === "ally") return ["player"];
    if (mode === "any") return ["player", "opponent"];
    return ["opponent"];
  }

  getTargetIndexesForMove(slot, move) {
    const mode = this.getTargetMode(move);
    const own = this.battle.player.team[this.battle.player.active[slot]];
    const ownIndex = this.battle.player.active[slot];
    if (mode === "self") return { player: own?.canBattle() ? [ownIndex] : [] };
    if (mode === "ally") return { player: (this.battle.activeIndices("player") || []).filter(i => i !== ownIndex) };
    if (mode === "any") {
      return {
        player: (this.battle.activeIndices("player") || []),
        opponent: (this.battle.activeIndices("opponent") || [])
      };
    }
    return { opponent: (this.battle.activeIndices("opponent") || []) };
  }

  renderTurnAndField() {
    if (this.els.turn) this.els.turn.textContent = `Turn ${this.battle.turn}${this.isMulti ? ` · ${this.battle.battleSize}v${this.battle.battleSize}` : ""}`;
    if (this.els.field) {
      const field = this.battle.field;
      const turns = this.battle.fieldTurns ?? 0;
      this.els.field.textContent = field ? `${field}${turns ? ` · ${turns}T` : ""}` : "No Field";
      this.els.field.title = field ? (this.battle.getFieldDef?.(field)?.description || "") : "The battlefield is neutral.";
    }
  }

  renderLog() {
    if (!this.els.log) return;
    const visibleLog = this.battle.log.filter(x => {
      const text = String(x);
      return !text.includes("Waiting for your opponent's move...") &&
        !text.includes("You chose your move. Waiting for your opponent to choose...") &&
        !text.includes("Opponent selected a move.");
    });

    let status = "";
    if (this.battle.over && this.battle.result?.winnerRole) {
      const winner = this.battle.result.winnerRole === "host" ? "Player 1" :
        this.battle.result.winnerRole === "guest" ? "Player 2" :
        this.battle.result.winnerRole === "local" ? "You" : "Opponent";
      const localWon = this.battle.networkRole
        ? this.battle.result.winnerRole === this.battle.networkRole
        : this.battle.result.winnerRole === "local";
      status = `<div class="log-line result-line"><strong>${this.escape(winner)} won the battle!</strong> ${localWon ? "You won!" : "You lost!"}</div>`;
    } else if (this.isMulti && this.battle.networkRole) {
      const needed = this.battle.activeIndices?.("player")?.length ?? this.battle.battleSize;
      const submitted = this.getLocalPendingActions().length;
      const remoteSubmitted = this.battle.remoteActionsSubmitted || (this.battle.pendingActions?.opponent?.length ?? 0) >= needed;
      if (submitted >= needed && !remoteSubmitted) {
        status = `<div class="log-line">Your side is locked in — waiting for the opponent to choose.</div>`;
      } else if (submitted < needed && remoteSubmitted) {
        status = `<div class="log-line">The opponent has chosen all actions — choose yours.</div>`;
      } else if (submitted >= needed && remoteSubmitted) {
        status = `<div class="log-line">Both trainers have chosen — resolving the turn...</div>`;
      }
    } else if (this.battle.networkRole && this.battle.localMoveSubmitted && !this.battle.remoteMoveSubmitted) {
      status = `<div class="log-line">Your move is locked in — waiting for the opponent to choose.</div>`;
    } else if (this.battle.networkRole && !this.battle.localMoveSubmitted && this.battle.remoteMoveSubmitted) {
      status = `<div class="log-line">The opponent has chosen a move — choose yours.</div>`;
    }

    this.els.log.innerHTML = visibleLog
      .map(x => `<div class="log-line">${this.escape(x)}</div>`)
      .join("") + status;
    this.els.log.scrollTop = this.els.log.scrollHeight;
  }

  renderMultiGrid(side, container) {
    if (!container) return;
    const battleSize = this.battle.battleSize;
    const columns = Math.min(5, Math.max(2, battleSize));
    const rows = Math.max(1, Math.ceil(battleSize / columns));
    container.style.setProperty("--multi-cols", String(columns));
    container.style.setProperty("--multi-rows", String(rows));
    container.innerHTML = "";
    const slots = Array.isArray(this.battle[side]?.active) ? this.battle[side].active : [this.battle[side]?.active];
    const pending = side === "player" ? this.getLocalPendingActions() : (Array.isArray(this.battle.pendingActions?.opponent) ? this.battle.pendingActions.opponent : []);
    const pendingSlots = new Set(pending.map(a => a.slot));
    const selectedTargetIndex = this.multiTargeting?.targetSide === side ? this.multiTargeting.targetIndex : null;
    const allowedTargetSides = this.multiTargeting?.targetSides || [];

    for (let slot = 0; slot < battleSize; slot++) {
      const teamIndex = slots[slot];
      const p = teamIndex !== undefined ? this.battle[side].team[teamIndex] : null;
      const card = document.createElement("button");
      card.type = "button";
      card.className = `multi-active-card ${p?.canBattle() ? "" : "fainted"}`;
      if (side === "player" && p?.canBattle()) card.classList.add("own-card");
      if (side === "opponent" && p?.canBattle()) card.classList.add("opponent-card");
      const isTargetSide = allowedTargetSides.includes(side);
      if (this.multiTargeting && isTargetSide && teamIndex === this.multiHoverTarget) card.classList.add("target-hover");
      if (this.multiTargeting && this.multiTargeting.targetSide === side && teamIndex === selectedTargetIndex) card.classList.add("target-selected");
      if (this.multiTargeting && isTargetSide && p?.canBattle()) card.classList.add("targetable");
      if (!this.multiTargeting && side === "player" && p?.canBattle() && !pendingSlots.has(slot)) card.classList.add("field-selectable");
      if (side === "player" && slot === this.multiSelectedSlot && p?.canBattle() && !this.multiTargeting) card.classList.add("field-selected");
      if (!this.multiTargeting && side === "player" && pendingSlots.has(slot)) card.classList.add("action-ready");
      card.disabled = !p?.canBattle() || (!!this.multiTargeting ? !card.classList.contains("targetable") : false);
      card.innerHTML = p ? `
        <div class="multi-card-glow"></div>
        <div class="multi-slot-number">${slot + 1}</div>
        <img src="${this.escape(p.sprites?.[side === "player" ? "back" : "front"] ?? "")}" alt="">
        <div class="multi-card-info">
          <div class="multi-card-title"><strong>${this.escape(p.name)}</strong><span class="multi-level">Lv.${p.level}</span></div>
          <div class="types">${(p.types || []).map(t => `<span class="type">${this.escape(t)}</span>`).join("")}${p.status ? `<span class="type status-badge">${this.escape(p.status)}</span>` : ""}</div>
          <div class="hp-row"><div class="hpbar"><div style="width:${Math.max(0,(p.hp/p.maxHP)*100)}%"></div></div><span class="hp-text">${p.hp}/${p.maxHP}</span></div>
        </div>
        ${pendingSlots.has(slot) ? `<div class="action-check">✓</div>` : ""}
      ` : `<div class="multi-empty">Empty</div>`;

      card.addEventListener("mouseenter", () => {
        if (this.multiTargeting && this.multiTargeting.targetSide === side && p?.canBattle()) {
          this.multiHoverTarget = teamIndex;
          card.classList.add("target-hover");
        }
      });
      card.addEventListener("mouseleave", () => {
        if (this.multiHoverTarget === teamIndex) this.multiHoverTarget = null;
        card.classList.remove("target-hover");
      });
      card.addEventListener("click", () => this.handleMultiCardClick(side, slot, teamIndex));
      container.appendChild(card);
    }
  }

  handleMultiCardClick(side, slot, teamIndex) {
    if (this.battle.busy || this.battle.over) return;
    const p = this.battle[side]?.team?.[teamIndex];
    if (!p?.canBattle()) return;

    if (!this.multiTargeting) {
      if (side !== "player") return;
      const pending = this.getLocalPendingActions();
      if (pending.some(a => a.slot === slot)) return;
      this.multiSelectedSlot = slot;
      this.render();
      return;
    }

    const allowed = this.multiTargeting.targetSides || [this.multiTargeting.targetSide];
    if (!allowed.includes(side)) return;
    this.multiTargeting.targetSide = side;
    this.multiTargeting.targetIndex = teamIndex;
    this.multiHoverTarget = teamIndex;
    this.commitMultiTarget();
  }

  commitMultiTarget() {
    const target = this.multiTargeting;
    if (!target) return;
    const { slot, move, targetSide, targetIndex } = target;
    const actionOk = this.battle.setLocalAction
      ? this.battle.setLocalAction(slot, move.id, targetSide, targetIndex)
      : this.battle.submitAction(slot, move.id, targetSide, targetIndex);
    if (actionOk) {
      this.multiTargeting = null;
      this.multiHoverTarget = null;
      const nextSlot = this.findNextUnsubmittedSlot();
      if (nextSlot >= 0) this.multiSelectedSlot = nextSlot;
      this.render();
    }
  }

  findNextUnsubmittedSlot() {
    const active = this.battle.activeIndices("player") || [];
    const pending = new Set(this.getLocalPendingActions().map(a => a.slot));
    return active.findIndex((_, slot) => !pending.has(slot));
  }

  renderMultiControls() {
    const panel = this.els.multiActionPanel;
    if (!panel) return;
    panel.innerHTML = "";
    const active = this.battle.activeIndices("player") || [];
    const pending = this.getLocalPendingActions();
    const bySlot = new Map(pending.map(a => [a.slot, a]));

    if (this.battle.over) {
      panel.innerHTML = `<div class="multi-finish-panel"><strong>Battle complete</strong><span>Return to Team Builder to start another match.</span></div>`;
      this.updateTargetHint();
      return;
    }

    const slot = this.multiSelectedSlot;
    const teamIndex = this.battle.player.active?.[slot];
    const pokemon = this.battle.player.team?.[teamIndex];
    if (!pokemon?.canBattle()) {
      panel.innerHTML = `<div class="multi-empty-panel">Click one of your active Pokémon to command it.</div>`;
      this.updateTargetHint();
      return;
    }

    const selected = bySlot.get(slot);
    const moves = this.battle.getAvailableMovesFor(pokemon);
    const selectedMoveId = this.multiTargeting?.slot === slot ? this.multiTargeting.move.id : selected?.moveId;

    const header = document.createElement("div");
    header.className = "multi-command-header";
    header.innerHTML = `<div><span class="eyebrow">COMMANDING</span><h2>${this.escape(pokemon.name)}</h2></div><div class="command-progress">${pending.length}/${active.length} actions</div>`;
    panel.appendChild(header);

    if (selected) {
      const locked = document.createElement("div");
      locked.className = "multi-locked-banner";
      locked.innerHTML = `<span>✓</span><div><strong>Action locked in</strong><small>${this.escape(selected.kind === "switch" ? `Switch to ${this.battle.player.team[selected.targetIndex]?.name || "Pokémon"}` : (pokemon.moves.find(m => m.id === selected.moveId)?.name || selected.moveId))}</small></div>`;
      panel.appendChild(locked);
    } else {
      const moveGrid = document.createElement("div");
      moveGrid.className = "multi-move-grid polished-moves";
      moves.forEach(move => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `multi-move-button ${selectedMoveId === move.id ? "move-selected" : ""}`;
        btn.dataset.category = move.category || "status";
        btn.disabled = this.battle.busy;
        btn.innerHTML = `<span class="move-name">${this.escape(move.name)}</span><span class="move-meta"><b>${this.escape((move.types || []).join(" / "))}</b><i>${this.escape(move.category || "status")}</i></span><span class="move-pp">${move.pp ?? "—"} PP</span>`;
        btn.addEventListener("click", () => this.beginMultiMoveTarget(slot, move));
        moveGrid.appendChild(btn);
      });
      panel.appendChild(moveGrid);
    }

    const bench = Array.from(this.battle.player.team || []).map((p, i) => ({ p, i }))
      .filter(({p, i}) => p?.canBattle() && !active.includes(i));
    if (bench.length && !selected && !this.multiTargeting) {
      const switchSection = document.createElement("div");
      switchSection.className = "multi-switch-section";
      switchSection.innerHTML = `<div class="switch-title"><span>SWITCH</span><small>Replace ${this.escape(pokemon.name)}</small></div>`;
      const switchRow = document.createElement("div");
      switchRow.className = "multi-switch-row";
      for (const {p, i} of bench) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "multi-switch-button";
        btn.innerHTML = `<img src="${this.escape(p.sprites?.front || "")}" alt=""><span>${this.escape(p.name)}</span>`;
        btn.disabled = this.battle.busy;
        btn.addEventListener("click", () => {
          const ok = this.battle.setLocalSwitch?.(slot, i);
          if (ok) this.render();
        });
        switchRow.appendChild(btn);
      }
      switchSection.appendChild(switchRow);
      panel.appendChild(switchSection);
    }

    const queue = document.createElement("div");
    queue.className = "multi-command-queue";
    active.forEach((teamIndex2, actionSlot) => {
      const action = bySlot.get(actionSlot);
      if (!action) return;
      const p = this.battle.player.team[teamIndex2];
      const label = action.kind === "switch" ? `Switch → ${this.battle.player.team[action.targetIndex]?.name || "Pokémon"}` : (p?.moves?.find(m => m.id === action.moveId)?.name || action.moveId);
      const chip = document.createElement("span");
      chip.className = "action-chip";
      chip.innerHTML = `<strong>${this.escape(p?.name || "Pokémon")}</strong><span>${this.escape(label)}</span>`;
      queue.appendChild(chip);
    });
    if (queue.childElementCount) panel.appendChild(queue);

    this.updateTargetHint();
  }

  beginMultiMoveTarget(slot, move) {
    if (this.battle.busy || this.battle.over) return;
    const mode = this.getTargetMode(move);
    const sides = this.getValidTargetSides(move);
    const targets = this.getTargetIndexesForMove(slot, move);

    if (mode === "self") {
      const targetIndex = targets.player?.[0];
      if (targetIndex === undefined) return;
      const actionOk = this.battle.setLocalAction
        ? this.battle.setLocalAction(slot, move.id, "player", targetIndex)
        : this.battle.submitAction(slot, move.id, "player", targetIndex);
      if (actionOk) { this.multiTargeting = null; this.render(); }
      return;
    }

    const hasTarget = sides.some(side => (targets[side] || []).length);
    if (!hasTarget) return;
    this.multiTargeting = { slot, move, targetSides: sides, targetSide: sides.length === 1 ? sides[0] : null, targetIndex: null };
    this.multiHoverTarget = null;
    this.updateTargetHint();
    this.renderMultiGrid("opponent", this.els.multiOppGrid);
    this.renderMultiGrid("player", this.els.multiPlayerGrid);
    this.renderMultiControls();
  }

  updateTargetHint() {
    if (!this.els.multiTargetHint) return;
    if (!this.multiTargeting) {
      this.els.multiTargetHint.innerHTML = `<span class="hint-dot"></span><span>Click one of your active Pokémon to command it.</span>`;
      this.els.multiTargetHint.classList.remove("active");
      return;
    }
    const sideLabel = this.multiTargeting.targetSides?.length === 2 ? "either side" : (this.multiTargeting.targetSides?.[0] === "player" ? "your side" : "the opponent's side");
    this.els.multiTargetHint.innerHTML = `<span class="hint-pulse"></span><span><strong>${this.escape(this.multiTargeting.move.name)}</strong> — choose a target on ${sideLabel}.</span><button type="button" class="cancel-target">Cancel</button>`;
    this.els.multiTargetHint.classList.add("active");
    this.els.multiTargetHint.querySelector(".cancel-target")?.addEventListener("click", () => {
      this.multiTargeting = null;
      this.multiHoverTarget = null;
      this.render();
    });
  }

  renderPokemon(p, side) {
    const name = this.els[`${side}Name`];
    if (!name) return;
    if (!p) {
      name.textContent = "Waiting…";
      this.els[`${side}Types`].innerHTML = "";
      this.els[`${side}HPFill`].style.width = "0%";
      this.els[`${side}HPText`].textContent = "— / —";
      this.els[`${side}Sprite`].removeAttribute("src");
      return;
    }
    const types = this.els[`${side}Types`];
    const fill = this.els[`${side}HPFill`];
    const text = this.els[`${side}HPText`];
    const sprite = this.els[`${side}Sprite`];
    const ability = this.battle.abilitiesData.find(a => a.id === p.ability);
    const item = this.battle.itemsData.find(i => i.id === p.item);

    name.textContent = `${p.name} Lv.${p.level}${ability ? ` • ${ability.name}` : ""}${item ? ` • ${item.name}` : ""}`;
    types.innerHTML = p.types.map(t => `<span class="type">${this.escape(t)}</span>`).join("") +
      (p.status ? ` <span class="type status-badge">${this.escape(p.status)}</span>` : "");
    fill.style.width = `${Math.max(0,(p.hp/p.maxHP)*100)}%`;
    text.textContent = `${p.hp} / ${p.maxHP}`;
    const nextSrc = p.sprites?.[side === "player" ? "back" : "front"];
    if (nextSrc && sprite.dataset.src !== nextSrc) {
      sprite.dataset.src = nextSrc;
      sprite.src = nextSrc;
    }
    sprite.style.opacity = p.canBattle() ? "1" : ".35";
  }

  renderMoves() {
    if (!this.els.moves) return;
    this.els.moves.innerHTML = "";
    const moves = this.battle.getAvailableMoves();
    for (const move of moves) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.category = move.category || "status";
      button.innerHTML = `<strong>${this.escape(move.name)}</strong><span style="display:block;margin-top:4px;font-size:10px;color:#8a97a8;font-weight:800;text-transform:uppercase;letter-spacing:.05em">${this.escape(move.types.join(" / "))} · ${move.category || "status"}</span>`;
      button.disabled =
        (!this.battle.ready && this.battle.networkRole === "guest") ||
        this.battle.busy ||
        this.battle.over ||
        (this.battle.networkRole && this.battle.localMoveSubmitted);
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        if (this.battle.busy || this.battle.over) return;
        try { await this.battle.playerMove(move.id); }
        catch (error) {
          console.error("Move failed:", error);
          this.battle.busy = false; this.battle.locked = false;
          this.battle.write(`Error executing ${move.name}: ${error.message || error}`);
        }
        this.render();
      });
      this.els.moves.appendChild(button);
    }
  }

  renderParty() {
    if (!this.els.party) return;
    const grid = document.createElement("div");
    grid.className = "party-grid";
    this.battle.player.team.forEach((p, i) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "party-card";
      const activeIndices = Array.isArray(this.battle.player.active) ? this.battle.player.active : [this.battle.player.active];
      button.disabled = !p.canBattle() || activeIndices.includes(i) || this.battle.over ||
        (this.battle.networkRole === "guest" && !this.battle.ready) ||
        (this.battle.busy && !this.battle.awaitingPlayerSwitch);
      button.innerHTML = `<img src="${p.sprites?.front ?? ""}" alt=""><span>${this.escape(p.name)}<br><small>${p.hp}/${p.maxHP}</small></span>`;
      button.onclick = async () => {
        if (this.battle.over) return;
        if (this.battle.busy && !this.battle.awaitingPlayerSwitch) return;
        await this.battle.switchPlayer(i);
        this.els.party.classList.add("hidden");
        this.render();
      };
      grid.appendChild(button);
    });
    this.els.party.replaceChildren(grid);
    if (this.battle.awaitingPlayerSwitch) this.els.party.classList.remove("hidden");
  }

  escape(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
    }[c]));
  }
}
