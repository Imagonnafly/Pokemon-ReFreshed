# Matchmaking UI Update

The Team Builder now uses two selectors and one matchmaking action:

- Battle Size: 1v1 through 10v10 active battle size.
- Battle Type: 1 through 10 trainers on each team.
- Find Match: queues using both selected dimensions; only identical combinations are matched.

Examples:
- Battle Size 1v1 + Battle Type 1 = normal single-trainer 1v1.
- Battle Size 1v1 + Battle Type 2 = 2 trainers per team, cooperative doubles.
- Battle Size 3v3 + Battle Type 1 = normal 3v3 multi-Pokemon battle.
- Battle Size 3v3 + Battle Type 4 = 4 trainers per team, matched as a 4v4 trainer battle with the selected 3v3 battle size metadata.

The existing Create Party / Join Party flow is preserved and carries the selected matchmaking dimensions into the party queue.
