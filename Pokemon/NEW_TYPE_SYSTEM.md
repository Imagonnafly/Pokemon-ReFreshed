# New Type System

The game now uses the 14 custom types and the supplied matchup chart:

Fire, Water, Earth, Air, Electric, Ice, Nature, Metal, Light, Dark, Mind, Spirit, Cosmos, Time.

Legacy type conversion used for the existing data:
- Normal -> Time
- Fighting -> Earth
- Poison -> Dark
- Ground -> Earth
- Flying -> Air
- Psychic -> Mind
- Bug -> Nature
- Rock -> Earth
- Ghost -> Spirit
- Dragon -> Cosmos
- Steel -> Metal
- Fairy -> Light
- Grass -> Nature
- Fire, Water, Electric, Ice, Dark remain unchanged.

All species, move definitions, ability type references, and the battle engine's type-specific checks were migrated.
