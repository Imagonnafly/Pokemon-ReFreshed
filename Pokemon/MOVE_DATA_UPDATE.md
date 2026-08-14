# Move data update

Added every move supplied in the Koraidon level-up/TM lists as move data, including power, type, category, accuracy, and PP. Level/TM numbers are intentionally not stored as learnset restrictions. Koraidon's learnset contains the complete supplied move pool; its four battle moves remain separate in `moveset`.

Note: moves are now available as data. Moves whose special secondary effects (e.g. Protect, Counter, Rest, weather/terrain, multi-hit behavior) are not yet implemented by the battle engine will still need effect handlers for exact in-game behavior.
