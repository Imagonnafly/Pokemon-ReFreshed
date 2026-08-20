# Battle Data Model

The game now uses the official 18 Pokémon types:

Normal, Fire, Water, Electric, Grass, Ice, Fighting, Poison, Ground, Flying, Psychic, Bug, Rock, Ghost, Dragon, Dark, Steel, Fairy.

Type matchups live in `data/types.json`; species and moves carry their own type data. Battle UI and engine logic do not define a custom type system.

Move targets and common battle flags are stored directly on move JSON objects, so those properties can be edited without changing the UI renderer.
