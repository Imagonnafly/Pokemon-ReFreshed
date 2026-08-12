# Internet multiplayer deployment

This build uses Supabase Realtime Broadcast instead of a local Node/WebSocket server. That means the game can be hosted as static files on Vercel, GitHub Pages, or another static host, while Supabase provides the cross-network realtime connection.

## 1. Create a Supabase project

Create a project at https://supabase.com/ and open **Project Settings → API**.
Copy:
- Project URL
- Publishable key (the `sb_publishable_...` key)

Supabase Realtime supports Broadcast over WebSockets and is explicitly suitable for multiplayer game events.

## 2. Configure the game

Open `js/network.js` and replace:

```js
const SUPABASE_URL = "https://YOUR_PROJECT_REF.supabase.co";
const SUPABASE_KEY = "YOUR_SUPABASE_PUBLISHABLE_KEY";
```

with your project URL and publishable key.

For a static frontend, the publishable key is intended to be exposed to browser code. Do not put a service-role/secret key in this file.

## 3. Deploy

### Vercel

Push the project to GitHub and import the repository into Vercel. No Node server is required.

### GitHub Pages

This architecture also works on GitHub Pages because the multiplayer transport is hosted by Supabase rather than by your website host.

## How rooms work

The 5-character room code becomes a Supabase Realtime channel name. The host sends the guest the initial teams through the channel, and battle actions/snapshots are broadcast over the same channel.

## Important security note

This version is designed for friendly/private games, not competitive anti-cheat play. The host remains authoritative for battle resolution, but the client still contains game data and can be modified by a malicious player. If you later want ranked/competitive battles, move battle validation and RNG to a trusted backend.
