export class TeamBuilder {
  constructor({ root, data, onStart, onMultiplayer }) {
    this.root = root;
    this.data = data;
    this.onStart = onStart;
    this.onMultiplayer = onMultiplayer || (() => {});
    this.team = [];
    this.battleSize = 1;
    this.editingIndex = null;

    this.speciesById = new Map(data.species.map(p => [p.id, p]));
    this.movesById = new Map(data.moves.map(m => [m.id, m]));
    this.abilitiesById = new Map(data.abilities.map(a => [a.id, a]));
    this.itemsById = new Map((data.items ?? []).map(i => [i.id, i]));
  }

  mount() {
    this.root.innerHTML = `
      <div class="builder-page">
        <header class="builder-header">
          <div>
            <div><h1>Build Your Team</h1>
            <p>Choose your squad, tune their loadouts, then enter the arena.</p></div>
          </div>
          <div class="builder-count" id="builderCount">0 / 10 Pokémon</div>
        </header>

        <section class="builder-toolbar">
          <label class="search-wrap">
            <span>Search Pokémon</span>
            <input id="speciesSearch" type="search" placeholder="Search by name or ID...">
          </label>

          <label class="battle-size-wrap">
            <span>Battle size</span>
            <select id="battleSize" aria-label="Battle size"></select>
          </label>
          <button id="clearTeam" class="builder-secondary" type="button">Clear Team</button>
          <button id="startBattle" class="builder-primary" type="button">Enter Battle →</button>
          <button id="createRoom" class="builder-secondary" type="button">Create Multiplayer Room</button>
          <button id="joinRoom" class="builder-secondary" type="button">Join Room</button>
        </section>

        <section class="builder-layout">
          <div class="species-browser">
            <div class="section-title">
              <h2>Pokémon</h2>
              <span id="speciesResultCount"></span>
            </div>
            <div id="speciesGrid" class="species-grid"></div>
          </div>

          <aside class="team-panel">
            <div class="section-title">
              <h2>Your Team</h2>
              <span>Up to 10</span>
            </div>
            <div id="teamSlots" class="team-slots"></div>
          </aside>
        </section>
      </div>

      <div id="pokemonEditor" class="builder-modal hidden" aria-hidden="true">
        <div class="builder-modal-card">
          <div class="builder-modal-header">
            <div>
              <h2 id="editorTitle">Configure Pokémon</h2>
              <p id="editorSubtitle"></p>
            </div>
            <button id="closeEditor" class="icon-button" type="button">×</button>
          </div>

          <div id="editorBody"></div>

          <div class="builder-modal-footer">
            <button id="removePokemon" class="danger-button" type="button">Remove</button>
            <div>
              <button id="cancelEditor" class="builder-secondary" type="button">Cancel</button>
              <button id="savePokemon" class="builder-primary" type="button">Save Pokémon</button>
            </div>
          </div>
        </div>
      </div>
    `;

    this.bind();
    const sizeSelect = this.root.querySelector("#battleSize");
    sizeSelect.innerHTML = Array.from({length: 10}, (_, i) => `<option value="${i + 1}">${i + 1}v${i + 1}</option>`).join("");
    sizeSelect.value = String(this.battleSize);
    sizeSelect.addEventListener("change", () => {
      this.battleSize = Math.max(1, Math.min(10, Number(sizeSelect.value) || 1));
      this.renderTeam();
    });
    this.renderSpecies();
    this.renderTeam();
  }

  bind() {
    this.root.querySelector("#speciesSearch").addEventListener("input", () => {
      this.renderSpecies();
    });

    this.root.querySelector("#clearTeam").addEventListener("click", () => {
      if (!this.team.length || confirm("Clear your entire team?")) {
        this.team = [];
        this.renderTeam();
      }
    });

    this.root.querySelector("#createRoom").addEventListener("click", () => {
      if (!this.team.length) return alert("Add at least one Pokémon to your team first.");
      if (this.team.length < this.battleSize) {
        return alert(`Add at least ${this.battleSize} Pokémon for a ${this.battleSize}v${this.battleSize} battle.`);
      }
      this.onMultiplayer("create", {
        battleSize: this.battleSize,
        team: this.team.map(p => ({ species: p.species, level: p.level, moveset: [...(p.moveset ?? p.moves ?? [])], ability: p.ability, item: p.item ?? null }))
      });
    });

    this.root.querySelector("#joinRoom").addEventListener("click", () => {
      if (!this.team.length) return alert("Add at least one Pokémon to your team first.");
      const code = prompt("Enter the 5-character room code:");
      if (this.team.length < this.battleSize) {
        return alert(`Add at least ${this.battleSize} Pokémon for a ${this.battleSize}v${this.battleSize} battle.`);
      }
      if (code?.trim()) this.onMultiplayer("join", {
        code: code.trim().toUpperCase(),
        battleSize: this.battleSize,
        team: this.team.map(p => ({ species: p.species, level: p.level, moveset: [...(p.moveset ?? p.moves ?? [])], ability: p.ability, item: p.item ?? null }))
      });
    });

    this.root.querySelector("#startBattle").addEventListener("click", () => {
      if (!this.team.length) {
        alert("Add at least one Pokémon to your team.");
        return;
      }

      if (this.team.length < this.battleSize) {
        alert(`Add at least ${this.battleSize} Pokémon for a ${this.battleSize}v${this.battleSize} battle.`);
        return;
      }
      this.onStart({
        battleSize: this.battleSize,
        team: this.team.map(p => ({
          species: p.species,
          level: p.level,
          moveset: [...(p.moveset ?? p.moves ?? [])],
          ability: p.ability,
          item: p.item ?? null
        }))
      });
    });

    for (const id of ["closeEditor", "cancelEditor"]) {
      this.root.querySelector(`#${id}`).addEventListener("click", () => this.closeEditor());
    }

    this.root.querySelector("#removePokemon").addEventListener("click", () => {
      if (this.editingIndex !== null) {
        this.team.splice(this.editingIndex, 1);
        this.closeEditor();
        this.renderTeam();
      }
    });

    this.root.querySelector("#savePokemon").addEventListener("click", () => {
      this.saveEditor();
    });
  }

  renderSpecies() {
    const query = this.root.querySelector("#speciesSearch").value.trim().toLowerCase();
    const grid = this.root.querySelector("#speciesGrid");

    const species = [...this.data.species]
      .filter(p =>
        !query ||
        p.name.toLowerCase().includes(query) ||
        p.id.toLowerCase().includes(query)
      )
      .sort((a, b) => a.name.localeCompare(b.name));

    this.root.querySelector("#speciesResultCount").textContent = `${species.length} available`;

    grid.innerHTML = species.map(p => {
      const selected = this.team.some(t => t.species === p.id);
      const types = p.types.map(t => `<span class="builder-type">${this.escape(t)}</span>`).join("");

      return `
        <button class="species-card ${selected ? "selected" : ""}" data-species="${this.escape(p.id)}" type="button">
          <div class="species-sprite">
            <img src="${this.escape(p.sprites?.front ?? "")}" alt="">
          </div>
          <div class="species-card-info">
            <strong>${this.escape(p.name)}</strong>
            <div class="builder-types">${types}</div>
            ${selected ? `<span class="selected-label">In team</span>` : ""}
          </div>
        </button>
      `;
    }).join("");

    grid.querySelectorAll("[data-species]").forEach(button => {
      button.addEventListener("click", () => {
        this.openEditor(button.dataset.species, null);
      });
    });
  }

  renderTeam() {
    const slots = this.root.querySelector("#teamSlots");
    this.root.querySelector("#builderCount").textContent = `${this.team.length} / 10 Pokémon`;

    slots.innerHTML = "";

    for (let i = 0; i < 10; i++) {
      const p = this.team[i];

      if (!p) {
        const empty = document.createElement("button");
        empty.type = "button";
        empty.className = "empty-team-slot";
        empty.innerHTML = `<span>+</span><strong>Empty Slot</strong><small>Choose a Pokémon</small>`;
        empty.addEventListener("click", () => {
          const first = this.filteredSpecies()[0];
          if (first) this.openEditor(first.id, null);
          else alert("Search for a Pokémon first.");
        });
        slots.appendChild(empty);
        continue;
      }

      const species = this.speciesById.get(p.species);
      const ability = this.abilitiesById.get(p.ability);
      const item = this.itemsById.get(p.item);

      const card = document.createElement("div");
      card.className = "team-card";
      card.innerHTML = `
        <img src="${this.escape(species.sprites?.front ?? "")}" alt="">
        <div class="team-card-main">
          <strong>${this.escape(species.name)}</strong>
          <span>Lv. ${p.level}</span>
          <small>${this.escape(ability?.name ?? "No ability")} · ${this.escape(item?.name ?? "No item")} · ${(p.moveset ?? p.moves ?? []).length} / 4 battle moves</small>
        </div>
        <button class="edit-team-button" type="button">Edit</button>
      `;

      card.querySelector(".edit-team-button").addEventListener("click", () => {
        this.openEditor(p.species, i);
      });

      slots.appendChild(card);
    }

    this.renderSpecies();
  }

  filteredSpecies() {
    const query = this.root.querySelector("#speciesSearch").value.trim().toLowerCase();
    return [...this.data.species]
      .filter(p => !query || p.name.toLowerCase().includes(query) || p.id.toLowerCase().includes(query))
      .sort((a,b) => a.name.localeCompare(b.name));
  }

  openEditor(speciesId, teamIndex) {
    const species = this.speciesById.get(speciesId);
    if (!species) return;

    if (teamIndex === null && this.team.length >= 10) {
      alert("Your team already has 10 Pokémon.");
      return;
    }

    const existing = teamIndex === null
      ? null
      : this.team[teamIndex];

    if (teamIndex === null && this.team.some(p => p.species === speciesId)) {
      alert("You already have that Pokémon on your team.");
      return;
    }

    this.editingIndex = teamIndex;
    const defaultAbility = existing?.ability ?? species.abilities?.[0] ?? null;
    const defaultItem = existing?.item ?? null;
    const legalMoveIds = new Set(this.availableMoves(species).map(m => m.id));
    const defaultMoves = existing
      ? [...new Set((existing.moveset ?? existing.moves ?? []).filter(id => legalMoveIds.has(id)))].slice(0, 4)
      : [...(species.moveset ?? [])].filter(id => legalMoveIds.has(id)).slice(0, 4);
    if (!defaultMoves.length) defaultMoves.push(...this.availableMoves(species).slice(0, 4).map(m => m.id));
    const level = existing?.level ?? 50;

    const abilityOptions = (species.abilities ?? []).map(id => {
      const ability = this.abilitiesById.get(id);
      return ability
        ? `<option value="${this.escape(id)}" ${id === defaultAbility ? "selected" : ""}>${this.escape(ability.name)}</option>`
        : "";
    }).join("");

    const itemOptions = [
      `<option value="">— No held item —</option>`,
      ...(this.data.items ?? []).map(item =>
        `<option value="${this.escape(item.id)}" ${item.id === defaultItem ? "selected" : ""}>${this.escape(item.name)}</option>`
      )
    ].join("");

    const movePool = this.availableMoves(species);
    const moveOptions = movePool.map(move => `
      <option value="${this.escape(move.id)}">${this.escape(move.name)} — ${this.escape(move.types.join("/"))}</option>
    `).join("");

    const selectedMoves = [...defaultMoves];

    this.root.querySelector("#editorTitle").textContent = `${species.name}`;
    this.root.querySelector("#editorSubtitle").textContent =
      `${species.types.join(" / ")} · Configure level, ability, and up to 4 moves.`;

    this.root.querySelector("#editorBody").innerHTML = `
      <div class="editor-pokemon-preview">
        <img src="${this.escape(species.sprites?.front ?? "")}" alt="">
        <div>
          <strong>${this.escape(species.name)}</strong>
          <div class="builder-types">${species.types.map(t => `<span class="builder-type">${this.escape(t)}</span>`).join("")}</div>
        </div>
      </div>

      <div class="editor-grid">
        <label>
          <span>Level</span>
          <input id="editorLevel" type="number" min="1" max="100" value="${level}">
        </label>

        <label>
          <span>Ability</span>
          <select id="editorAbility">${abilityOptions}</select>
        </label>

        <label>
          <span>Held Item</span>
          <select id="editorItem">${itemOptions}</select>
        </label>
      </div>

      <div class="move-editor">
        <div class="move-editor-heading">
          <h3>Battle Moveset</h3>
          <span id="moveCount">${selectedMoves.length} / 4</span>
        </div>
        <div id="moveRows"></div>
        <button id="addMove" class="add-move-button" type="button">+ Add Move</button>
        <small class="editor-note">
          Learnset: ${this.escape(String(species.learnset?.length ?? 0))} moves · Move database: ${this.escape(String(this.data.moves.length))} moves · Battle moveset: up to 4 moves.<br>
          ${species.learnset?.length
            ? "Showing moves listed in this Pokémon's learnset."
            : "No learnset has been defined for this species yet, so all currently loaded moves are available."}
        </small>
      </div>
    `;

    const moveRows = this.root.querySelector("#moveRows");

    const renderMoveRows = () => {
      moveRows.innerHTML = selectedMoves.map((moveId, index) => `
        <div class="move-row">
          <span class="move-number">${index + 1}</span>
          <select data-move-index="${index}">
            <option value="">— Select a move —</option>
            ${moveOptions}
          </select>
          <button class="remove-move" data-remove-move="${index}" type="button" aria-label="Remove move">×</button>
        </div>
      `).join("");

      moveRows.querySelectorAll("select").forEach(select => {
        select.value = selectedMoves[Number(select.dataset.moveIndex)] ?? "";
        select.addEventListener("change", () => {
          selectedMoves[Number(select.dataset.moveIndex)] = select.value;
          updateMoveControls();
        });
      });

      moveRows.querySelectorAll("[data-remove-move]").forEach(button => {
        button.addEventListener("click", () => {
          selectedMoves.splice(Number(button.dataset.removeMove), 1);
          renderMoveRows();
          updateMoveControls();
        });
      });

      updateMoveControls();
    };

    const updateMoveControls = () => {
      this.root.querySelector("#moveCount").textContent = `${selectedMoves.length} / 4`;
      this.root.querySelector("#addMove").disabled = selectedMoves.length >= 4 || movePool.length === 0;
    };

    this.root.querySelector("#addMove").addEventListener("click", () => {
      if (selectedMoves.length >= 4) return;
      const unused = movePool.find(m => !selectedMoves.includes(m.id));
      if (!unused) return;
      selectedMoves.push(unused.id);
      renderMoveRows();
    });

    renderMoveRows();

    this.root.querySelector("#removePokemon").style.display =
      teamIndex === null ? "none" : "inline-flex";

    const modal = this.root.querySelector("#pokemonEditor");
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");

    // Store current editor state on the instance for save.
    this.editorState = { speciesId, selectedMoves, teamIndex };
  }

  saveEditor() {
    const state = this.editorState;
    if (!state) return;

    const species = this.speciesById.get(state.speciesId);
    const levelInput = this.root.querySelector("#editorLevel");
    const abilityInput = this.root.querySelector("#editorAbility");

    const level = Math.max(1, Math.min(100, Number(levelInput.value) || 50));
    const ability = abilityInput.value || species.abilities?.[0] || null;
    const item = this.root.querySelector("#editorItem")?.value || null;

    const legalMoveIds = new Set(this.availableMoves(species).map(m => m.id));
    const moves = state.selectedMoves.filter(id => id && legalMoveIds.has(id));
    const uniqueMoves = [...new Set(moves)];

    if (!uniqueMoves.length) {
      alert("Choose at least one move.");
      return;
    }

    const entry = {
      species: state.speciesId,
      level,
      moveset: uniqueMoves.slice(0, 4),
      ability,
      item
    };

    if (state.teamIndex === null) {
      this.team.push(entry);
    } else {
      this.team[state.teamIndex] = entry;
    }

    this.closeEditor();
    this.renderTeam();
  }

  closeEditor() {
    const modal = this.root.querySelector("#pokemonEditor");
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    this.editingIndex = null;
    this.editorState = null;
  }

  availableMoves(species) {
    const learnset = Array.isArray(species.learnset) ? species.learnset : [];
    const pool = learnset.length
      ? learnset.map(id => this.movesById.get(id)).filter(Boolean)
      : this.data.moves;

    return [...pool].sort((a,b) => a.name.localeCompare(b.name));
  }

  escape(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({
      "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;"
    }[c]));
  }
}
