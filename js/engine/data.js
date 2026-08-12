const DATA_ROOT = new URL("../../data/", import.meta.url);

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

  const results = [];
  for (const id of normalized) {
    const file = `${folder}/${id}.json`;
    results.push(await fetchJSON(file));
  }
  return results;
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
