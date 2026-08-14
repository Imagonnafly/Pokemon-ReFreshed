import { calculateStats } from "./formulas.js";

export class BattlePokemon {
  constructor(species, level = 50, moves = [], ability = null, item = null) {
    this.speciesId = species.id;
    this.name = species.name;
    this.level = level;
    this.types = [...species.types]; // unlimited type list
    this.originalTypes = [...species.types];
    this.baseStats = {...species.baseStats};
    this.stats = calculateStats(species, level);
    this.maxHP = this.stats.hp;
    this.hp = this.maxHP;
    this.moves = moves.map(m => ({...m}));
    this.ability = ability;
    this.item = item;
    this.itemUsed = false;
    this.choiceMove = null;
    this.statStages = { attack: 0, defense: 0, specialAttack: 0, specialDefense: 0, speed: 0, accuracy: 0, evasion: 0 };
    this.status = null;
    this.statusData = {};
    this.volatile = {
      protected: false,
      endure: false,
      substitute: 0,
      charging: null,
      recharge: false,
      focusPunch: false,
      focusPunchHit: false,
      confusedTurns: 0,
      flinched: false,
      tauntTurns: 0,
      trapTurns: 0,
      trapSource: null,
      encoreTurns: 0,
      lastMove: null,
      lastMoveFailed: false,
      lastDamagingMove: null,
      lastDamageTaken: 0,
      critStage: 0,
      teraType: null
    };
    this.fainted = false;
    this.sprites = {...species.sprites};
  }

  canBattle() {
    return this.hp > 0 && !this.fainted;
  }

  receiveDamage(amount) {
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp === 0) this.fainted = true;
  }
}