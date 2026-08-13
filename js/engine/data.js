const DATA_ROOT = new URL("../../data/", import.meta.url);

const KORAIDON_FULL_LEARNSET = [
  "acrobatics",
  "agility",
  "ancient-power",
  "body-press",
  "body-slam",
  "breaking-swipe",
  "brick-break",
  "bulk-up",
  "bulldoze",
  "close-combat",
  "collision-course",
  "counter",
  "crunch",
  "dig",
  "double-edge",
  "draco-meteor",
  "dragon-cheer",
  "dragon-claw",
  "dragon-pulse",
  "dragon-tail",
  "drain-punch",
  "dual-wingbeat",
  "endure",
  "facade",
  "fire-blast",
  "fire-fang",
  "fire-spin",
  "flame-charge",
  "flamethrower",
  "flare-blitz",
  "focus-blast",
  "focus-punch",
  "giga-impact",
  "heat-crash",
  "heat-wave",
  "heavy-slam",
  "helping-hand",
  "hyper-beam",
  "ice-fang",
  "iron-head",
  "low-kick",
  "low-sweep",
  "meteor-beam",
  "mud-shot",
  "mud-slap",
  "outrage",
  "overheat",
  "protect",
  "rest",
  "reversal",
  "roar",
  "rock-smash",
  "scale-shot",
  "scary-face",
  "screech",
  "shadow-claw",
  "sleep-talk",
  "snarl",
  "solar-beam",
  "stomping-tantrum",
  "substitute",
  "sunny-day",
  "swords-dance",
  "take-down",
  "taunt",
  "temper-flare",
  "tera-blast",
  "thunder-fang",
  "u-turn",
  "uproar",
  "wild-charge",
  "zen-headbutt"
];

async function fetchJSON(relativePath) {
  const url = new URL(relativePath, DATA_ROOT);
  const response = await fetch(url.href, {
    cache: "no-store",
    headers: { "Accept": "application/json" }
  });

  if (!response.ok) {
    throw new Error(`Failed to load ${relativePath} (${response.status})`);
  }

  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in ${relativePath}`);
  }
}

async function loadCollection(folder, ids = []) {
  const normalized = [...new Set((ids || []).filter(Boolean))];
  if (!normalized.length) return [];

  // Load the collection concurrently. The previous sequential loader could
  // take longer than the 15s startup guard on a fresh Vercel deployment
  // because it performs one HTTP request per species/move/ability/item.
  return Promise.all(
    normalized.map(id => fetchJSON(`${folder}/${id}.json`))
  );
}

function getIds(manifest, name) {
  const collection = manifest?.collections?.[name];
  if (Array.isArray(collection)) return collection;

  // Support alternate manifest formats used by older versions.
  if (Array.isArray(manifest?.[name])) return manifest[name];
  return [];
}

export const DataRepository = {
  async load() {
    const manifest = await fetchJSON("manifest.json");

    const speciesIds = getIds(manifest, "species");
    const moveIds = getIds(manifest, "moves");
    const abilityIds = getIds(manifest, "abilities");
    const itemIds = getIds(manifest, "items");

    if (!speciesIds.length) {
      throw new Error("No species are listed in data/manifest.json.");
    }
    if (!moveIds.length) {
      throw new Error("No moves are listed in data/manifest.json.");
    }
    if (!abilityIds.length) {
      throw new Error("No abilities are listed in data/manifest.json.");
    }

    const [types, teams, species, moves, abilities, items] = await Promise.all([
      fetchJSON("types.json"),
      fetchJSON("teams.json"),
      loadCollection("species", speciesIds),
      loadCollection("moves", moveIds),
      loadCollection("abilities", abilityIds),
      loadCollection("items", itemIds)
    ]);

    // Defensive data migration: Koraidon's complete learnset is authoritative.
    // This also repairs deployments where an older koraidon.json was cached or uploaded.
    const koraidon = species.find(s => s?.id === "koraidon");
    if (koraidon && (!Array.isArray(koraidon.learnset) || koraidon.learnset.length < 72)) {
      koraidon.learnset = KORAIDON_FULL_LEARNSET.filter(id => moves.some(m => m.id === id));
    }

    return {
      types,
      teams,
      species,
      moves,
      abilities,
      items
    };
  }
};
