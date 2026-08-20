# Pokémon Battle Engine

A browser-based Pokémon-style battle engine with a soft-coded, data-driven rules layer, modern responsive battle UI, and optional real-time multiplayer.

## Run locally

Multiplayer requires the included Node server.

```bash
npm install
npm start
```

Then open `http://localhost:3000` in two browser tabs/windows.

> Do not open `index.html` directly with `file://` if you want multiplayer.

## Multiplayer

1. Build a team.
2. Click **Create Multiplayer Room**.
3. Send the 5-character room code to another player.
4. The other player builds a team and clicks **Join Room**.
5. Both players then battle in real time.

The host currently acts as the lightweight authoritative battle simulator and broadcasts battle snapshots to the guest. The server relays moves/switches and does not need to know Pokémon rules.

## Battle readability QOL

Battle messages now distinguish sides, for example:

- `Your Pokémon Charizard used Flamethrower!`
- `The opposing Pokémon Charizard used Flamethrower!`
- `The opposing side sent out Blastoise!`

This makes mirror matches much easier to follow.
"# Pokemon-ReFreshed" 

## Data-driven rules

Species types live in `data/species/*.json`, move types/targets/flags live in `data/moves/*.json`, and the official type chart, statuses, and battlefield fields live in `data/types.json`. The battle renderer reads those definitions instead of carrying a separate custom type table.
