# N-vs-N V2 rebuild

The 1v1 Battle engine remains unchanged. Battles larger than 1v1 now use the rebuilt `MultiBattleV2` + `MultiRendererV2` stack.

## Rules
- Team size: up to 10 Pokémon.
- Battle size: 2v2 through 10v10 for this multi engine.
- Every active slot requires exactly one action before a turn can resolve.
- Switches are queued as actions and resolve before attacks.
- Targets are selected directly on the field.
- Self, ally, and opponent targets are supported.
- Fainted active slots are refilled from the bench after resolution.
- Host remains authoritative in online matches; guests submit a complete action set.

## Responsive UI
The rebuilt UI is independent from the older multi-battle layout and is based on the stable 1v1 shell. It uses a field grid plus a command/log dock and has dedicated desktop/mobile landscape/portrait breakpoints.
