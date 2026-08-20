export async function loadGameData() {
  const manifest = await getJson('data/manifest.json');
  const [config, types, statuses, speciesIds, moveIds, teams] = await Promise.all([
    getJson(manifest.config), getJson(manifest.types), getJson(manifest.statuses),
    getJson(manifest.species), getJson(manifest.moves), getJson(manifest.teams)
  ]);
  const [speciesEntries, moveEntries] = await Promise.all([
    Promise.all(speciesIds.map(id => getJson(`data/species/${id}.json`))),
    Promise.all(moveIds.map(id => getJson(`data/moves/${id}.json`)))
  ]);
  return {
    config, types, statuses,
    species: Object.fromEntries(speciesEntries.map(x => [x.id, x])),
    moves: Object.fromEntries(moveEntries.map(x => [x.id, x])),
    teams
  };
}

async function getJson(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Failed to load ${path} (${response.status})`);
  return response.json();
}
