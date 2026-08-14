# Centralized Game Configuration

The current build keeps the main gameplay limits in `js/config.js` so they can be changed in one place.

- Maximum Pokémon per trainer: **9**
- Battle Size: **1–3 active Pokémon per trainer**
- Battle Type: **1–3 trainers per team**
- Maximum active Pokémon per side: **9** (3 active × 3 trainers)
- Battle moveset size: **4**

Matchmaking, room creation, party matchmaking, local battles, remote snapshots, team builder limits, and the multi-battle engines clamp incoming values through this shared configuration.
