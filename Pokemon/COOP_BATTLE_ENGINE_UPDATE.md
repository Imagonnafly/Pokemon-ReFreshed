# Cooperative Battle Engine Update

The team battle system now treats the two matchmaking dimensions independently:

- **Battle Size** = active Pokémon per human trainer (1–10).
- **Battle Type** = human trainers per team (1–10).

The active field size per side is `battleSize × teamSize`.

Examples:
- 3v3 + 2 trainers/team = 6 active Pokémon per side.
- 10v10 + 10 trainers/team = up to 100 active Pokémon per side.

Every trainer controls all of their own active slots. Each active Pokémon selects one move and one target every turn. A fainted active slot is refilled from that trainer's personal bench, without reusing a Pokémon already on the field.

Multiplayer snapshots serialize each trainer's active team indices as an array, and actions are keyed by `trainerId:slot` so multiple actions from the same human can be submitted in a turn.
