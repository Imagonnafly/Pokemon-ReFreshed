# Pokémon ReFreshed — Clean Rewrite

Ground-up replacement for the previous battle project.

## Run locally

```powershell
npm start
```
Open http://localhost:8000

Or directly:

```powershell
python -m http.server 8000
```

## Architecture

- `data/` — configurable game data.
- `src/engine/` — battle state machine and battle rules.
- `src/ui/` — renderer and controls.
- `css/` — presentation only.

A turn does not depend on an unresolved network promise. Every living active slot must have a choice. Once both sides are ready, the same resolver runs and the battle returns to `choosing`, or becomes `finished`/`error`.

## Soft-coded locations

- Battle sizes/team cap/damage tuning: `data/config.json`
- Status definitions: `data/statuses.json`
- Official 18-type list + chart: `data/types.json`
- Species typing/stats/sprites/moves: `data/species/*.json`
- Move type/power/accuracy/PP/effects: `data/moves/*.json`
- Demo teams: `data/teams.json`

## Test

```powershell
node smoke-test.mjs
```

This exercises 1v1, 2v2 and 3v3 turn resolution.
