# Data-driven Status and Field Rules

Persistent statuses use standard Pokémon names: Burn, Paralysis, Freeze, Poison, Bad Poison, and Sleep.

Status definitions and battlefield field definitions are stored in `data/types.json` rather than being encoded as custom type statuses.

Moves explicitly declare their target (`self`, `ally`, or `opponent`) and their reusable battle flags (`charge`, `recharge`, and `multiHit`) in their JSON files.
