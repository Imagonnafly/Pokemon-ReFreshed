# Data Architecture

All game content is data-driven.

## Collections

- `species/` — one JSON file per Pokémon species
- `moves/` — one JSON file per move
- `abilities/` — one JSON file per ability
- `types.json` — shared type definitions and type chart
- `teams.json` — team compositions/reference IDs

Each collection has an `index.json`. The browser loads the index and then loads every referenced file.

## Adding a species

Create:

`data/species/examplemon.json`

Then add:

`examplemon`

to `data/species/index.json`.

## Adding a move

Create:

`data/moves/example-move.json`

Then add:

`example-move`

to `data/moves/index.json`.

## Adding an ability

Create:

`data/abilities/example-ability.json`

Then add:

`example-ability`

to `data/abilities/index.json`.

The battle engine should not need to be modified just because a new species, move, or ability is added.
