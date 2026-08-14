# Party & Matchmaking Update

## New online systems

### Quick Match 2v2
A trainer enters a shared matchmaking queue. The queue groups four trainers into two teams of two. Each trainer controls one active Pokémon at a time and keeps their own bench of up to 9 Pokémon.

### Party System
Create a two-trainer party and share the five-character party code with a friend. The party leader can queue the party for a 2v2 Team Battle once both trainers are present.

### Cooperative 2v2 rules
- Two human trainers share each side.
- Each trainer controls exactly one active Pokémon.
- Each trainer can bring up to 9 Pokémon.
- Each trainer chooses one move per turn and targets one opposing active Pokémon.
- A fainted Pokémon is automatically replaced from that trainer's own bench.
- A side wins when both trainers on the opposing side have no usable Pokémon remaining.
- The coordinator resolves turns authoritatively and broadcasts snapshots through Supabase Realtime.

## Deployment
No Node server is required for this feature. It uses Supabase Realtime broadcast channels for parties, matchmaking tickets, match readiness, actions, and battle snapshots.

## Notes
The matchmaking queue is intentionally lightweight and client-coordinated for casual play. For a production-ranked ladder, replace the queue coordinator with a trusted server/database transaction layer so race conditions, queue persistence, and anti-abuse controls can be enforced server-side.
