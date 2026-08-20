# Ground-up battle rewrite notes

## Rules/data
- Reverted species to official Pokémon types.
- Reverted move types to official Pokémon types.
- Replaced custom type chart with the official 18-type chart.
- Replaced custom persistent statuses with Burn, Paralysis, Freeze, Poison, Bad Poison, and Sleep.
- Converted Koraidon and Miraidon field effects to Sun and Electric Terrain.
- Move targeting is stored on move JSON (`target`).
- Common move flow flags (charge/recharge/multi-hit) are stored on move JSON instead of module-level sets.

## Battle UI
- Replaced the old single/multi battle renderers with one shared responsive renderer.
- Enemy sprites always prefer `front`; your sprites always prefer `back`.
- Battle cards, HP bars, type badges, target highlighting, commands, team switching, and battle log now share one layout.
- 1v1 and 2v2/3v3 use the same renderer and responsive CSS.
- Mobile layouts stack multi-battle slots vertically instead of hiding the opposing side.

## Validation
- All JSON files parse successfully.
- All manifest-referenced species/moves/abilities/items exist.
- All JavaScript files pass `node --check`.
- Battle-engine smoke test successfully instantiated Charizard vs Venusaur and verified official type effectiveness and move targets.

A browser-level screenshot test could not be run in the build environment because a Playwright browser binary is not installed.
