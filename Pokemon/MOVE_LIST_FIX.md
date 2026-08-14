# Move list fix

The move editor now loads every move ID listed in `data/manifest.json`, with `data/moves/index.json` kept in sync as a second source of truth. Koraidon also has a defensive embedded 72-move learnset fallback so stale species JSON cannot cause the editor to report that it has no learnset.

After deploying, open the Koraidon editor. It should say `Learnset: 72 moves · Move database: 93 moves`.
