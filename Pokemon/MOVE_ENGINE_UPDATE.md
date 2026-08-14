# Move Engine Update

The battle engine now implements the mechanics for all 93 currently loaded moves.

Implemented groups include:
- Priority: Aqua Jet, Quick Attack, Protect, Endure, Helping Hand, Counter, Focus Punch, Roar, Dragon Tail.
- Stat changes: Agility, Bulk Up, Ancient Power, Breaking Swipe, Bulldoze, Close Combat, Crunch, Draco Meteor, Flame Charge, Focus Blast, Growl, Low Sweep, Mud Shot, Mud-Slap, Overheat, Rock Smash, Scale Shot, Scary Face, Screech, Snarl, Swords Dance.
- Status/volatile effects: Burn, Paralysis, Freeze, Sleep, Confusion, Taunt, Flinch, Protect, Endure, Substitute, trapping, Uproar, Outrage.
- Multi-turn: Dig, Fly, Meteor Beam, Solar Beam, Focus Punch, Outrage, Uproar, Hyper Beam, Giga Impact.
- Variable power: Acrobatics, Facade, Heat Crash, Heavy Slam, Low Kick, Reversal, Stomping Tantrum, Temper Flare.
- Multi-hit: Double Kick, Dual Wingbeat, Scale Shot.
- Recoil/drain: Double-Edge, Flare Blitz, Take Down, Wild Charge, Drain Punch, Parabolic Charge.
- Weather/terrain: Sunny Day, Koraidon/Miraidon field effects, Solar Beam, Fire/Water/Electric modifiers.
- Special mechanics: Body Press, Counter, Collision Course, Electro Drift, Roost type change, U-turn switching, phazing from Roar/Dragon Tail, critical-hit stages from Razor Leaf/Shadow Claw/Dragon Cheer.

The host remains authoritative for multiplayer battle resolution; volatile state is included in snapshots so the guest UI remains synchronized.
