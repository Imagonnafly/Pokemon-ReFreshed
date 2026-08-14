# Multi-Battle Showdown Layout Rebuild

This build replaces the previous multi-battle presentation for battle sizes 2v2 and 3v3 and for cooperative team battles using 1–3 trainers per team.

- 1v1 remains on the original single-battle renderer.
- Multi-battle field units are free-standing sprites with floating name/HP HUDs; no large cards behind the sprites.
- Desktop uses a Showdown-style left battlefield + right battle log + bottom-left command dock.
- Mobile collapses the same regions vertically without changing the command/target flow.
- The 2v2/3v3 field uses 2 or 3 columns automatically.
- Cooperative team battles reuse the same field/log/command geometry and support 1–3 trainers/team × 1–3 active Pokémon/trainer.
