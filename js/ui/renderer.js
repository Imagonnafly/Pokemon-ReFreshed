export class Renderer {
  constructor({root, battle}) {
    this.root = root;
    this.battle = battle;
    this.isMulti = !!battle.isMulti && Number(battle.battleSize) > 1;
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
      multiActionPanel: root.querySelector("#multiActionPanel")
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
    this.renderTurnAndField();
    this.renderMultiGrid("opponent", this.els.multiOppGrid);
    this.renderMultiGrid("player", this.els.multiPlayerGrid);
    this.renderMultiActions();
    this.renderLog();
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
      const submitted = this.battle.localActions?.length ?? this.battle.pendingActions?.player?.length ?? 0;
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
    container.innerHTML = "";
    const indices = this.battle.activeIndices(side) || [];
    const all = this.battle[side]?.active || [];
    const slots = Array.isArray(all) ? all : [all];

    for (let slot = 0; slot < this.battle.battleSize; slot++) {
      const teamIndex = slots[slot];
      const p = teamIndex !== undefined ? this.battle[side].team[teamIndex] : null;
      const card = document.createElement("div");
      card.className = `multi-active-card ${p?.canBattle() ? "" : "fainted"}`;
      card.innerHTML = p ? `
        <img src="${this.escape(p.sprites?.[side === "player" ? "back" : "front"] ?? "")}" alt="">
        <div class="multi-card-info">
          <strong>${this.escape(p.name)}</strong>
          <div class="types">${(p.types || []).map(t => `<span class="type">${this.escape(t)}</span>`).join("")}${p.status ? `<span class="type status-badge">${this.escape(p.status)}</span>` : ""}</div>
          <div class="hp-row"><div class="hpbar"><div style="width:${Math.max(0,(p.hp/p.maxHP)*100)}%"></div></div><span class="hp-text">${p.hp}/${p.maxHP}</span></div>
        </div>
      ` : `<div class="multi-empty">No Pokémon</div>`;
      container.appendChild(card);
    }
  }

  renderMultiActions() {
    const panel = this.els.multiActionPanel;
    if (!panel) return;
    panel.innerHTML = "";
    if (this.battle.over) return;

    const playerActive = this.battle.activeIndices("player") || [];
    const pending = this.battle.pendingActions?.player || this.battle.localActions || [];
    const bySlot = new Map(pending.map(a => [a.slot, a]));

    playerActive.forEach((teamIndex, slot) => {
      const p = this.battle.player.team[teamIndex];
      if (!p?.canBattle()) return;
      const row = document.createElement("div");
      row.className = "multi-action-row";
      const selected = bySlot.get(slot);
      const moves = this.battle.getAvailableMovesFor(p);

      row.innerHTML = `<div class="multi-action-head"><strong>${this.escape(p.name)}</strong><span>${selected ? "Action locked" : "Choose action"}</span></div>`;
      const moveGrid = document.createElement("div");
      moveGrid.className = "multi-move-grid";

      for (const move of moves) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = selected?.moveId === move.id ? "move-selected" : "";
        btn.dataset.category = move.category || "status";
        btn.disabled = !!selected || this.battle.busy;
        btn.innerHTML = `<strong>${this.escape(move.name)}</strong><small>${this.escape((move.types||[]).join(" / "))} · ${this.escape(move.category||"status")}</small>`;

        btn.addEventListener("click", () => {
          const SELF_TARGET_MOVES = new Set(["agility","bulk-up","dragon-cheer","endure","protect","rest","roost","substitute","sunny-day","swords-dance"]);
          let targetSide = SELF_TARGET_MOVES.has(move.id) ? "player" : "opponent";
          if (move.id === "helping-hand") targetSide = "player";
          let targets = this.battle.getAvailableTargets("player", targetSide);
          if (!targets.length) return;
          let targetIndex = targets[0].index;
          if (move.id === "helping-hand" && targets.length > 1) {
            // Helping Hand targets an ally in N-vs-N.
          } else if (targets.length > 1) {
            const choice = prompt(`Choose target for ${move.name}:\n${targets.map((t,i)=>`${i+1}. ${t.label}`).join("\n")}`, "1");
            const n = Number(choice);
            if (!Number.isInteger(n) || n < 1 || n > targets.length) return;
            targetIndex = targets[n - 1].index;
          }
          const actionOk = this.battle.setLocalAction
            ? this.battle.setLocalAction(slot, move.id, targetSide, targetIndex)
            : this.battle.submitAction(slot, move.id, targetSide, targetIndex);
          if (actionOk) this.render();
        });
        moveGrid.appendChild(btn);
      }
      row.appendChild(moveGrid);
      panel.appendChild(row);
    });

    const needed = playerActive.length;
    const submitted = pending.length;
    const hint = document.createElement("div");
    hint.className = "multi-action-hint";
    hint.textContent = submitted >= needed
      ? "All actions selected. Waiting for the other trainer…"
      : `${submitted}/${needed} active Pokémon have chosen an action.`;
    panel.appendChild(hint);
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
