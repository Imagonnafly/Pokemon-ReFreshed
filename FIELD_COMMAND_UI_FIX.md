# Field-first command UI fix

- Removed the redundant bottom active-Pokemon tab/selector strip from the N-vs-N single-trainer battle UI.
- Your active Pokémon cards on the battlefield are now the command selectors.
- Click your own active Pokémon to open its move/switch controls.
- Click an opposing active Pokémon, ally, or teammate target when the selected move supports that target scope.
- Added switch actions to the N-vs-N battle engine and remote battle client.
- Switch actions resolve before attack actions and synchronize over the existing multiplayer action channel.
- Added compact viewport-aware styling so the command dock remains visible on desktop while the battlefield scales down for large battles.
