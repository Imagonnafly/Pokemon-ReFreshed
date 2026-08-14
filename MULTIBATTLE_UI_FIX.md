# Multibattle UI rebuild / viewport fix

This version fixes the current `.sd-page` multibattle layout without touching the working 1v1 renderer.

Key fixes:
- Restores the battlefield when the command panel is present.
- Keeps arena + commands + battle log visible at 100% zoom.
- Uses a narrower 292px battle-log column on desktop.
- Removes the white HUD-card background while retaining name, level, HP, types, and status.
- Uses a responsive field grid for 2v2/3v3.
- Keeps the switch row visible in the command dock.
- Adds dedicated tablet/mobile sizing rules.
