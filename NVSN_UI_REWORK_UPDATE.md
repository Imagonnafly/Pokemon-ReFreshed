# N-vs-N Field Selection + Compact Command Dock

## Changes
- Removed the redundant active-Pokémon command tab strip from the bottom UI.
- Your active Pokémon are now selected directly by clicking their field cards.
- The selected field Pokémon gets an `ACTIVE` marker and highlighted card state.
- The command dock updates to show the selected Pokémon's moves.
- Targets are selected directly by clicking highlighted opponent/ally Pokémon on the field.
- Added a compact bench/switch section to the command dock.
- Voluntary switching is now a turn action for each active slot in cooperative battles.
- Switch actions synchronize through the existing Supabase Realtime party/match action channel.
- Switching resolves before normal moves, matching the intended battle-order semantics.
- Desktop party battles are constrained to the viewport so the field and command dock are available without page scrolling.
- 10v10 field cards are condensed automatically; mobile retains natural scrolling for usability.
