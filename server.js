import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const root = fileURLToPath(new URL(".", import.meta.url));
const rooms = new Map();
const clients = new Map();

function code() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  do out = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  while (rooms.has(out));
  return out;
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function broadcast(room, message, except) {
  for (const ws of [room.host, room.guest]) if (ws && ws !== except) send(ws, message);
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); }
  catch { res.writeHead(400); return res.end("Bad request"); }
  if (pathname === "/health") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ok: true, rooms: rooms.size })); }

  const safe = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^\.\.[\\/]/, "");
  const file = join(root, safe);
  try {
    const body = await readFile(file);
    const ext = extname(file);
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp" };
    res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("Not found");
  }
});

const wss = new WebSocketServer({ server });
wss.on("connection", ws => {
  clients.set(ws, null);

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "create_room") {
      const roomCode = code();
      const room = { code: roomCode, host: ws, guest: null, hostTeam: msg.team, guestTeam: null };
      rooms.set(roomCode, room); clients.set(ws, room);
      send(ws, { type: "room_created", code: roomCode });
      return;
    }

    const room = clients.get(ws);
    if (msg.type === "join_room") {
      const target = rooms.get(String(msg.code || "").toUpperCase());
      if (!target) return send(ws, { type: "error", message: "Room not found." });
      if (target.guest) return send(ws, { type: "error", message: "That room is already full." });
      target.guest = ws; target.guestTeam = msg.team; clients.set(ws, target);
      send(ws, { type: "room_joined", code: target.code, hostTeam: target.hostTeam });
      send(target.host, { type: "opponent_joined", guestTeam: target.guestTeam });
      return;
    }

    if (!room) return send(ws, { type: "error", message: "Join or create a room first." });

    if (msg.type === "move") {
      if (ws === room.guest) send(room.host, { type: "remote_move", moveId: msg.moveId });
      return;
    }
    if (msg.type === "switch") {
      if (ws === room.guest) send(room.host, { type: "remote_switch", index: msg.index });
      return;
    }
    if (msg.type === "snapshot" && ws === room.host) {
      broadcast(room, { type: "snapshot", snapshot: msg.snapshot }, ws);
      return;
    }
    if (msg.type === "start" && ws === room.host) {
      broadcast(room, { type: "match_start" });
      return;
    }
    if (msg.type === "leave") ws.close();
  });

  ws.on("close", () => {
    const room = clients.get(ws);
    clients.delete(ws);
    if (!room) return;
    if (room.host === ws) {
      if (room.guest) send(room.guest, { type: "opponent_left" });
      rooms.delete(room.code);
    } else if (room.guest === ws) {
      room.guest = null; room.guestTeam = null;
      send(room.host, { type: "opponent_left" });
    }
  });
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`Pokémon Battle Engine running at http://localhost:${port}`));
