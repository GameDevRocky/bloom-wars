import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { CONFIG } from './config.js';
import { GameManager } from './game.js';

const port = Number(process.env.PORT) || 8080;
const app = express();
app.disable('x-powered-by');
app.use(express.static('public', { extensions: ['html'] }));
app.get('/health', (_request, response) => response.json({ ok: true, rooms: manager.rooms.size }));

const server = http.createServer(app);
const sockets = new Map();
const manager = new GameManager();
const websocketServer = new WebSocketServer({ server, path: '/play', maxPayload: 16 * 1024 });

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function broadcastRoom(room, message) {
  const payload = JSON.stringify(message);
  for (const [socket, session] of sockets) {
    if (session.room === room && socket.readyState === WebSocket.OPEN) socket.send(payload);
  }
}

function fail(socket, message) {
  send(socket, { type: 'error', message });
}

function handleMessage(socket, raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    fail(socket, 'Message must be valid JSON.');
    return;
  }
  const session = sockets.get(socket);
  try {
    if (message.type === 'create_room' || message.type === 'join_room') {
      if (session.room) throw new Error('Already joined to a room.');
      const room = message.type === 'create_room'
        ? manager.createRoom(session.playerId, message.name)
        : manager.joinRoom(message.roomCode, session.playerId, message.name);
      session.room = room;
      send(socket, { type: 'joined', playerId: session.playerId, roomCode: room.code, isHost: room.hostId === session.playerId });
      broadcastRoom(room, room.lobbyState());
      if (room.phase === 'playing') {
        send(socket, room.matchStartedMessage());
        send(socket, room.snapshot({ includeEvents: false }));
      }
      return;
    }
    if (!session.room) throw new Error('Join or create a room first.');
    if (message.type === 'start_match') {
      const started = session.room.start(session.playerId);
      broadcastRoom(session.room, started);
    } else if (message.type === 'input') {
      session.room.receiveInput(session.playerId, message);
    } else if (message.type === 'reload') {
      session.room.requestReload(session.playerId);
    } else if (message.type === 'consume_flower') {
      session.room.consumeFlower(session.playerId);
    } else if (message.type === 'ping') {
      send(socket, { type: 'pong', sentAt: message.sentAt, serverTime: Date.now() });
    }
  } catch (error) {
    fail(socket, error.message || 'Request failed.');
  }
}

websocketServer.on('connection', (socket) => {
  const playerId = crypto.randomUUID();
  sockets.set(socket, { playerId, room: null });
  send(socket, { type: 'connected', playerId, config: CONFIG });
  socket.on('message', (raw) => handleMessage(socket, raw));
  socket.on('close', () => {
    const session = sockets.get(socket);
    if (session?.room) {
      session.room.removePlayer(session.playerId);
      broadcastRoom(session.room, session.room.phase === 'lobby' ? session.room.lobbyState() : session.room.snapshot());
    }
    sockets.delete(socket);
  });
  socket.on('error', () => socket.close());
});

let previousTick = performance.now();
setInterval(() => {
  const now = performance.now();
  const delta = Math.min(0.1, (now - previousTick) / 1_000);
  previousTick = now;
  manager.tick(delta);
}, 1_000 / CONFIG.tickRate);

setInterval(() => {
  for (const room of manager.rooms.values()) {
    if (room.phase !== 'lobby') broadcastRoom(room, room.snapshot());
  }
}, 1_000 / CONFIG.snapshotRate);

setInterval(() => manager.prune(), 60_000).unref();

server.listen(port, '0.0.0.0', () => {
  console.log(`Bloom server listening on http://0.0.0.0:${port}`);
});

function shutdown() {
  websocketServer.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
