# Normal Matchmaking Update

Adds a standard solo-trainer matchmaking queue driven by the selected battle size.

- 1v1 -> pairs two solo trainers for a 1v1 battle
- 2v2 -> pairs two solo trainers for a 2v2 battle
- ...
- 10v10 -> pairs two solo trainers for a 10v10 battle

Each trainer can bring up to 10 Pokemon. The selected battle size is the number of simultaneously active Pokemon. The existing Party / Team Match 2v2 queue remains separate.

Normal matches use the same Supabase Realtime match channel and the existing authoritative host + remote snapshot architecture.
