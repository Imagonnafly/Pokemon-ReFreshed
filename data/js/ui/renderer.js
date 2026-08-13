export class Renderer {
  constructor({root, battle}) {
    this.root = root;
    this.battle = battle;
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
      restart: root.querySelector("#restartButton")
    };
  }

  bind() {
    this.battle.onUpdate = () => this.render();

    this.els.restart.onclick = () => location.reload();

    this.els.switchButton.onclick = () => {
      if (this.battle.busy || this.battle.over) return;
      this.els.party.classList.toggle("hidden");
      this.renderParty();
    };
  }

  render() {
    const player = this.battle.active("player");
    const opponent = this.battle.active("opponent");

    this.renderPokemon(player, "player");
    this.renderPokemon(opponent, "opp");
    this.renderMoves();
    this.renderParty();

    if (this.battle.awaitingPlayerSwitch) {
      this.els.party.classList.remove("hidden");
      this.els.switchButton.disabled = true;
      this.els.switchButton.textContent = "Choose a Pokémon...";
    } else {
      this.els.switchButton.disabled = this.battle.busy || this.battle.over;
      this.els.switchButton.textContent = "Switch Pokémon";
    }

    this.els.turn.textContent = `Turn ${this.battle.turn}`;
    if (this.els.field) {
      const field = this.battle.field;
      const turns = this.battle.fieldTurns ?? 0;
      this.els.field.textContent = field ? `${field}${turns ? ` · ${turns}T` : ""}` : "No Field";
      this.els.field.title = field ? (this.battle.getFieldDef?.(field)?.description || "") : "The battlefield is neutral.";
    }

    const visibleLog = this.battle.log.filter(x => {
      const text = String(x);
      return !text.includes("Waiting for your opponent's move...") &&
        !text.includes("You chose your move. Waiting for your opponent to choose...") &&
        !text.includes("Opponent selected a move.") &&
        !text.includes("Your move is locked in — waiting for the opponent to choose.") &&
        !text.includes("The opponent has chosen a move — choose yours.") &&
        !text.includes("You won the battle!") &&
        !text.includes("You lost the battle!");
    });

    let status = "";
    if (this.battle.over && this.battle.result?.winnerRole) {
      const winner = this.battle.result.winnerRole === "host" ? "Player 1" :
        this.battle.result.winnerRole === "guest" ? "Player 2" :
        this.battle.result.winnerRole === "local" ? "You" : "Opponent";
      const localWon =
        this.battle.networkRole === "host"
          ? this.battle.result.winnerRole === "host"
          : this.battle.networkRole === "guest"
            ? this.battle.result.winnerRole === "guest"
            : this.battle.result.winnerRole === "local";
      const personal = this.battle.networkRole
        ? (localWon ? "You won!" : "You lost!")
        : (localWon ? "You won!" : "You lost!");
      status = `<div class="log-line result-line"><strong>${this.escape(winner)} won the battle!</strong> ${this.escape(personal)}</div>`;
    } else if (this.battle.networkRole && this.battle.localMoveSubmitted && this.battle.remoteMoveSubmitted) {
      status = `<div class="log-line">Both trainers have chosen — resolving the turn...</div>`;
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

  renderPokemon(p, side) {
    const name = this.els[`${side}Name`];
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
    types.innerHTML = p.types
      .map(t => `<span class="type">${this.escape(t)}</span>`)
      .join("") +
      (p.status ? ` <span class="type status-badge">${this.escape(p.status)}</span>` : "");

    fill.style.width = `${Math.max(0, (p.hp / p.maxHP) * 100)}%`;
    text.textContent = `${p.hp} / ${p.maxHP}`;

    const nextSrc = p.sprites?.[side === "player" ? "back" : "front"];
    if (nextSrc && sprite.dataset.src !== nextSrc) {
      sprite.dataset.src = nextSrc;
      sprite.src = nextSrc;
    }

    sprite.style.opacity = p.canBattle() ? "1" : ".35";
  }

  renderMoves() {
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

        // Render immediately so the locked state is visible.
        this.render();

        try {
          await this.battle.playerMove(move.id);
        } catch (error) {
          console.error("Move failed:", error);
          this.battle.busy = false;
          this.battle.locked = false;
          this.battle.write(`Error executing ${move.name}: ${error.message || error}`);
        }

        this.render();
      });

      this.els.moves.appendChild(button);
    }
  }

  renderParty() {
    const grid = document.createElement("div");
    grid.className = "party-grid";

    this.battle.player.team.forEach((p, i) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "party-card";
      button.disabled =
        !p.canBattle() ||
        i === this.battle.player.active ||
        this.battle.over ||
        (this.battle.networkRole === "guest" && !this.battle.ready) ||
        (this.battle.busy && !this.battle.awaitingPlayerSwitch);

      button.innerHTML = `
        <img src="${p.sprites?.front ?? ""}" alt="">
        <span>${this.escape(p.name)}<br><small>${p.hp}/${p.maxHP}</small></span>
      `;

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

    if (this.battle.awaitingPlayerSwitch) {
      this.els.party.classList.remove("hidden");
    }
  }

  escape(value) {
    return String(value).replace(/[&<>"']/g, c => ({
      "&":"&amp;",
      "<":"&lt;",
      ">":"&gt;",
      '"':"&quot;",
      "'":"&#039;"
    }[c]));
  }
}
