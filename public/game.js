const PALETTE = {
  forest: '#18392b',
  forestDark: '#10271e',
  leaf: '#3f6b3a',
  moss: '#7b9e57',
  stone: '#a7a58e',
  pink: '#ff5d73',
  cream: '#f3f0e7',
};

const elements = Object.fromEntries([
  'game', 'menu', 'name', 'create', 'room-code', 'join', 'connection-dot', 'connection-label',
  'lobby', 'copy-code', 'player-list', 'start', 'waiting', 'hud', 'hud-room', 'storm-label',
  'storm-time', 'ping', 'health-fill', 'health', 'flower-card', 'flower-icon', 'flower', 'ammo',
  'announcement', 'announcement-kicker', 'announcement-title', 'announcement-copy', 'toast', 'controls',
  'room-list', 'rooms-empty', 'refresh-rooms', 'lobby-host-name',
  'countdown', 'countdown-label', 'countdown-value',
].map((id) => [id, document.getElementById(id)]));

import { EMPTY_INPUT, stepPlayer } from './shared/simulation.js';
import { drawCharacter as drawSpriteCharacter } from './character-renderer.js';
import { ProjectilePlayback } from './projectile-playback.js';
import { loadWorldArt, drawWorldFloor, drawWorldObstacle, drawWorldBorder, drawTeamTint } from './world-renderer.js';
import { WorldLighting, clippedMuzzle } from './lighting.js';
import { GameAudio } from './audio.js';
import { Particles } from './particles.js';
import { obstacleGridFor } from './shared/obstacle-grid.js';

// Other players are drawn this far in the past, so there is always a pair of
// received snapshots to slide between instead of a single latest position to
// jump to. It has to exceed the gap between snapshots or playback runs dry.
const INTERPOLATION_DELAY_MS = 110;
// How long to keep extrapolating from the last known velocity when no newer
// snapshot arrives. Beyond this a guess is more wrong than standing still.
const EXTRAPOLATION_LIMIT_MS = 250;
// Prediction errors below this are eased away invisibly; above it the player is
// too far out of place to fix gently and is snapped.
const RECONCILE_SMOOTH_LIMIT = 90;

// Recoil kick, in world units, applied to the view every time this player fires.
// Purely local: it is never sent, never simulated, and moves nobody's position.
const SHAKE_RECOIL = 4.5;
// A little scatter across the barrel so repeated shots do not kick identically.
const SHAKE_JITTER = 2.2;
// How fast the view returns to centre, per second. Fast enough that a single
// shot has settled before the next, so sustained fire reaches a steady tremble
// instead of walking the camera off the player.
const SHAKE_DECAY = 12;
// Ceiling on the accumulated kick, so holding the trigger cannot swing the view.
const SHAKE_LIMIT = 9;

const context = elements.game.getContext('2d');
const projectiles = new ProjectilePlayback();
const lighting = new WorldLighting();
const audio = new GameAudio();
const particles = new Particles();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const state = {
  socket: null,
  connected: false,
  playerId: null,
  roomCode: null,
  isHost: false,
  phase: 'menu',
  map: null,
  snapshot: null,
  config: null,
  // Loot by id, seeded from the map and pruned as pickups are collected.
  pickups: new Map(),
  // Last drawn flower stage. Undefined until the first HUD update, so joining
  // mid-match with a grown flower does not play the opening animation.
  flowerStage: undefined,
  // Local deadline for the next match, derived from the server's remaining time
  // so the count ticks every frame instead of twice a second with snapshots.
  restartDeadline: null,
  countdownShown: null,
  keys: new Set(),
  firing: false,
  shotSequence: 0,
  lastLocalShotAt: -Infinity,
  lastEmptyAt: -Infinity,
  predictedShots: new Map(),
  predictedEmpty: new Set(),
  hitFlashes: new Map(),
  aim: 0,
  inputSequence: 0,
  // Local simulation of our own player, run ahead of the server.
  predicted: null,
  // Inputs sent but not yet confirmed, replayed on top of each server update.
  pending: [],
  // Leftover prediction error, decayed to zero over a few frames so corrections
  // read as drift rather than a jolt.
  correction: { x: 0, y: 0 },
  // Recent snapshots with local arrival times, for interpolating other players.
  history: [],
  // Entities as positioned for the current frame, shared by drawing and camera.
  frameTargets: [],
  frameBullets: [],
  frameImpacts: [],
  frameTrails: [],
  renderTime: 0,
  // Where the camera is actually following. `camera` is this plus the recoil
  // offset and is what everything renders from; keeping them apart stops the
  // shake feeding back into the follow and slowly dragging the view off centre.
  cameraAnchor: { x: 0, y: 0 },
  camera: { x: 0, y: 0 },
  shake: { x: 0, y: 0 },
  scale: 1,
  mouse: { x: 0, y: 0 },
  lastFrame: performance.now(),
  pingTimer: null,
  toastTimer: null,
};

function websocketUrl() {
  const override = new URLSearchParams(location.search).get('server') || window.BLOOM_SERVER_URL;
  if (override) {
    const url = new URL(override, location.href);
    if (!url.pathname || url.pathname === '/') url.pathname = '/play';
    return url.toString();
  }
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/play`;
}

function connect() {
  setConnection('connecting', 'Connecting...');
  const socket = new WebSocket(websocketUrl());
  state.socket = socket;
  socket.addEventListener('open', () => {
    state.connected = true;
    setConnection('online', 'Server online');
    requestRooms();
    clearInterval(state.pingTimer);
    state.pingTimer = setInterval(() => send({ type: 'ping', sentAt: Date.now() }), 3_000);
  });
  socket.addEventListener('message', (event) => receive(JSON.parse(event.data)));
  socket.addEventListener('close', () => {
    state.connected = false;
    setConnection('offline', 'Disconnected - retrying');
    clearInterval(state.pingTimer);
    if (state.phase === 'menu') setTimeout(connect, 1_500);
    else announce('CONNECTION LOST', 'The garden went quiet', 'Refresh to reconnect to the server.');
  });
  socket.addEventListener('error', () => socket.close());
}

function setConnection(className, label) {
  elements['connection-dot'].className = className;
  elements['connection-label'].textContent = label;
  elements.create.disabled = className !== 'online';
  elements.join.disabled = className !== 'online';
}

function send(message) {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(message));
}

function receive(message) {
  if (message.type === 'connected') {
    state.playerId = message.playerId;
    state.config = message.config;
  } else if (message.type === 'joined') {
    state.playerId = message.playerId;
    state.roomCode = message.roomCode;
    state.isHost = message.isHost;
    showLobby();
  } else if (message.type === 'room_closed') {
    returnToWelcome(message.reason ?? 'The room closed.');
  } else if (message.type === 'room_list') {
    renderRoomList(message.rooms ?? []);
  } else if (message.type === 'lobby') {
    state.isHost = message.hostId === state.playerId;
    updateLobby(message);
  } else if (message.type === 'match_started') {
    projectiles.clear();
    state.history = [];
    state.pending = [];
    state.predictedShots.clear();
    state.predictedEmpty.clear();
    state.hitFlashes.clear();
    state.lastLocalShotAt = -Infinity;
    state.predicted = null;
    state.correction = { x: 0, y: 0 };
    state.restartDeadline = null;
    state.countdownShown = null;
    elements.countdown.hidden = true;
    state.map = message.map;
    // Loot arrives once with the map and is then maintained locally from
    // `pickup` events, rather than being resent in full every snapshot.
    state.pickups = new Map((message.map.pickups ?? []).map((pickup) => [pickup.id, pickup]));
    state.phase = 'playing';
    elements.menu.hidden = true;
    elements.lobby.hidden = true;
    elements.hud.hidden = false;
    elements.controls.hidden = false;
    elements.announcement.hidden = true;
    elements.game.style.cursor = 'none';
    elements['hud-room'].textContent = state.roomCode;
    const me = state.snapshot?.players?.find((player) => player.id === state.playerId);
    state.cameraAnchor.x = me?.x ?? state.map.width / 2;
    state.cameraAnchor.y = me?.y ?? state.map.height / 2;
    state.camera.x = state.cameraAnchor.x;
    state.camera.y = state.cameraAnchor.y;
    state.shake.x = 0;
    state.shake.y = 0;
    toast(`Garden ${message.map.seed.slice(0, 6).toUpperCase()} generated`);
  } else if (message.type === 'snapshot') {
    state.snapshot = message;
    state.phase = message.phase;
    const arrival = performance.now();
    const locallyPredicted = new Set((message.events ?? [])
      .filter((event) => event.type === 'shot' && event.clientShotId && state.predictedShots.has(event.clientShotId))
      .map((event) => event.clientShotId));
    const locallyEmpty = new Set((message.events ?? [])
      .filter((event) => event.type === 'empty_fire' && event.clientShotId && state.predictedEmpty.has(event.clientShotId))
      .map((event) => event.clientShotId));
    projectiles.receive(message, arrival);
    for (const clientShotId of locallyPredicted) state.predictedShots.delete(clientShotId);
    for (const event of message.events ?? []) {
      if (event.type === 'empty_fire' && event.clientShotId) state.predictedEmpty.delete(event.clientShotId);
      if (event.type === 'damage') state.hitFlashes.set(event.playerId, { at: arrival, amount: event.amount });
      if (event.type === 'pickup' && event.pickupId) state.pickups.delete(event.pickupId);
      if (event.type === 'pickup_spawned' && event.pickup) state.pickups.set(event.pickup.id, event.pickup);
    }
    for (const [playerId, flash] of state.hitFlashes) {
      if (arrival - flash.at > 1_000) state.hitFlashes.delete(playerId);
    }

    // Timestamped on arrival: interpolation runs on the local clock, so it
    // needs no clock synchronisation with the server.
    state.history.push({
      at: arrival,
      players: message.players ?? [],
      bullets: message.bullets ?? [],
    });
    const cutoff = performance.now() - 1_000;
    while (state.history.length > 2 && state.history[0].at < cutoff) state.history.shift();

    state.restartDeadline = typeof message.restartInMs === 'number'
      ? arrival + message.restartInMs
      : null;

    const mine = message.players?.find((player) => player.id === state.playerId);
    if (mine?.alive) {
      if (state.predicted) reconcile(mine);
      else state.predicted = { x: mine.x, y: mine.y, vx: mine.vx ?? 0, vy: mine.vy ?? 0 };
    } else {
      state.predicted = null;
      state.pending = [];
    }
    handleAudioEvents(message.events ?? [], locallyPredicted, locallyEmpty);
    updateHud();
  } else if (message.type === 'pong') {
    elements.ping.textContent = `${Date.now() - message.sentAt} ms`;
  } else if (message.type === 'error') {
    toast(message.message);
  }
}

// Tears down a finished match and puts the player back on the welcome screen.
// Reached when a room closes under them, so every trace of the old match has to
// go or the next one inherits its map, loot and half-applied prediction state.
function returnToWelcome(reason) {
  state.phase = 'menu';
  state.roomCode = null;
  state.isHost = false;
  state.map = null;
  state.snapshot = null;
  state.predicted = null;
  state.pending = [];
  state.correction = { x: 0, y: 0 };
  state.history = [];
  state.frameTargets = [];
  state.frameBullets = [];
  state.frameImpacts = [];
  state.frameTrails = [];
  state.pickups = new Map();
  state.flowerStage = undefined;
  state.restartDeadline = null;
  state.countdownShown = null;
  elements.countdown.hidden = true;
  state.keys.clear();
  state.firing = false;
  projectiles.clear();

  elements.hud.hidden = true;
  elements.controls.hidden = true;
  elements.announcement.hidden = true;
  elements.lobby.hidden = true;
  elements.menu.hidden = false;
  elements.game.style.cursor = '';
  if (reason) toast(reason);
  requestRooms();
}

function showLobby() {
  state.phase = 'lobby';
  elements.menu.hidden = true;
  elements.lobby.hidden = false;
  elements['copy-code'].textContent = state.roomCode;
  elements.start.hidden = !state.isHost;
  elements.waiting.hidden = state.isHost;
}

function updateLobby(message) {
  if (state.phase !== 'lobby') return;
  elements['lobby-host-name'].textContent = message.hostName ?? '—';
  elements['player-list'].replaceChildren(...message.players.map((player) => {
    const item = document.createElement('li');
    item.append(document.createTextNode(player.name));
    if (player.id === message.hostId) {
      const badge = document.createElement('span');
      badge.textContent = 'HOST';
      item.append(badge);
    }
    return item;
  }));
  // A match needs two sides, so the host cannot start alone.
  const minimum = message.minPlayers ?? 2;
  const ready = message.players.filter((player) => player.connected !== false).length >= minimum;
  elements.start.hidden = !state.isHost;
  elements.start.disabled = !ready;
  elements.start.textContent = ready ? 'Start match' : `Waiting for ${minimum} players`;
  elements.waiting.hidden = state.isHost;
}

// ── room browser ────────────────────────────────────────────────────────────
function requestRooms() {
  if (state.phase === 'menu') send({ type: 'list_rooms' });
}

function renderRoomList(rooms) {
  const open = rooms.filter((room) => room.phase !== 'ended');
  elements['rooms-empty'].hidden = open.length > 0;
  elements['room-list'].replaceChildren(...open.map((room) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'room-entry';

    const code = document.createElement('span');
    code.className = 'room-code-tag';
    code.textContent = room.code;

    const host = document.createElement('span');
    host.className = 'room-host';
    host.textContent = room.hostName;

    const count = document.createElement('span');
    count.className = 'room-count';
    count.textContent = `${room.players} ${room.players === 1 ? 'player' : 'players'}`;

    const status = document.createElement('span');
    status.className = `room-status ${room.phase}`;
    status.textContent = room.phase === 'playing' ? 'In progress' : 'Open';

    button.append(code, host, count, status);
    button.addEventListener('click', () => {
      elements['room-code'].value = room.code;
      send({ type: 'join_room', name: elements.name.value, roomCode: room.code });
    });
    item.append(button);
    return item;
  }));
}

function me() {
  return state.snapshot?.players?.find((player) => player.id === state.playerId);
}

function handleAudioEvents(events, locallyPredicted, locallyEmpty) {
  const listener = localPlayer() ?? me();
  for (const event of events) {
    if (event.type === 'shot' && !locallyPredicted.has(event.clientShotId)) {
      audio.play('shot', event, listener);
    } else if (event.type === 'pickup' && event.playerId === state.playerId) {
      audio.play(event.kind === 'rifle' ? 'item' : 'money');
    } else if (event.type === 'empty_fire' && event.playerId === state.playerId
      && !locallyEmpty.has(event.clientShotId)) {
      audio.play('empty');
    } else if (event.type === 'reload_started' && event.playerId === state.playerId) {
      audio.play('reload');
    }
  }
}

function cameraTarget() {
  const player = me();
  if (!player) return null;
  // Follow the same positions being drawn, so the camera never lags the sprite.
  const drawn = state.frameTargets ?? [];
  if (player.alive) return drawn.find((candidate) => candidate.id === player.id) ?? player;
  return drawn.find((candidate) => candidate.id === player.spectatorTargetId)
    ?? state.snapshot.players.find((candidate) => candidate.id === player.spectatorTargetId)
    ?? player;
}

function updateHud() {
  const player = me();
  if (!player) return;
  elements.health.textContent = Math.ceil(player.hp);
  elements['health-fill'].style.width = `${player.hp}%`;
  elements.ammo.textContent = player.hasRifle
    ? player.reloading ? 'RELOADING' : `${player.magazine} / ${player.reserveAmmo}`
    : 'UNARMED';

  const heal = player.flowerHeal;
  elements.flower.textContent = heal === null ? 'EMPTY' : `${heal} HP`;
  elements['flower-card'].style.opacity = heal === null ? '0.46' : '1';
  updateFlowerIcon(heal);

  const storm = state.snapshot.storm;
  if (storm) {
    // The storm bites harder each cycle, so the rate is shown rather than left
    // to be discovered by dying to it.
    const rate = storm.damagePerSecond;
    elements['storm-label'].textContent = rate
      ? `STORM / CYCLE ${storm.cycle} · ${rate} HP/S`
      : `STORM / CYCLE ${storm.cycle}`;
    const duration = storm.durationMs ?? (storm.phase === 'contracting' ? state.config.storm.contractionMs : state.config.storm.holdMs);
    const remaining = storm.phase === 'contracting'
      ? duration * (1 - storm.progress)
      : duration;
    elements['storm-time'].textContent = storm.phase === 'contracting'
      ? `${Math.max(0, Math.ceil(remaining / 1_000))}s · CLOSING`
      : '10s · HOLD';
  }

  if (!watchingMatch()) {
    elements.announcement.hidden = true;
  } else if (!player.alive && state.snapshot.phase === 'playing') {
    const target = state.snapshot.players.find((candidate) => candidate.id === player.spectatorTargetId);
    announce('ELIMINATED', 'The garden grows on', target ? `Spectating ${target.name}` : 'Waiting for the next match');
  } else if (state.snapshot.phase === 'ended') {
    // Won by a side now, not a lone survivor, and the room restarts itself, so
    // the result screen counts down rather than asking the host to do anything.
    const winning = state.snapshot.winningTeam;
    const mine = state.snapshot.players.find((candidate) => candidate.id === state.playerId)?.team;
    const title = !winning ? 'Nobody survived'
      : winning === mine ? `${TEAM_NAMES[winning]} team wins` : `${TEAM_NAMES[winning]} team wins`;
    const kicker = winning && winning === mine ? 'VICTORY' : winning ? 'DEFEAT' : 'MATCH COMPLETE';
    announce(kicker, title, '');
  } else {
    elements.announcement.hidden = true;
  }

  for (const event of state.snapshot.events ?? []) {
    if (event.type === 'pickup' && event.playerId === state.playerId) toast(event.kind === 'seed' ? 'Seed carried - press E to heal' : `${event.kind} collected`);
  }
}

// The carried flower matures from seed to bloom over roughly a hundred seconds,
// so the inventory shows it growing rather than only naming a number: it scales
// steadily with the healing it holds, and plays a one-off opening when it
// reaches the next stage. Deciding whether to spend it now or wait is the
// choice the whole flower mechanic rests on, so that growth needs to be visible.
function updateFlowerIcon(heal) {
  const icon = elements['flower-icon'];
  const stage = heal === null ? '' : heal <= 16 ? 'seed' : heal <= 33 ? 'budding' : 'bloomed';
  const maxHeal = state.config?.flower.maxHeal ?? 50;
  icon.dataset.stage = stage;
  icon.style.setProperty('--flower-grow', heal === null ? '1' : (0.58 + 0.42 * Math.min(1, heal / maxHeal)).toFixed(3));

  if (stage && stage !== state.flowerStage && state.flowerStage !== undefined) {
    // Restarting a running animation needs the class dropped and the element
    // reflowed, or the browser treats it as still the same animation.
    icon.classList.remove('blooming');
    void icon.offsetWidth;
    icon.classList.add('blooming');
  }
  state.flowerStage = stage;
}

// True only while the arena is what the player is looking at. The server sends
// snapshots to everyone in a room that is not in its lobby phase, so somebody
// sitting on the lobby screen of a room that is mid-result still receives them
// and their phase turns to 'ended' underneath them. Anything drawn over the
// match has to check what is actually on screen, not just the match phase.
function watchingMatch() {
  return elements.menu.hidden && elements.lobby.hidden;
}

// Counts the result screen down to the next match. Driven from a local deadline
// rather than straight from snapshots, so the number falls once a second
// instead of lurching whenever a packet lands.
// Shoves the view back down the barrel each time this player fires, then lets
// it settle. Fired from the local shot prediction, so it lands on the same
// frame as the trigger rather than a round trip later.
function kickCamera(aim) {
  if (reducedMotion.matches) return;
  const scatter = () => (Math.random() - 0.5) * SHAKE_JITTER;
  state.shake.x += -Math.cos(aim) * SHAKE_RECOIL + scatter();
  state.shake.y += -Math.sin(aim) * SHAKE_RECOIL + scatter();
  const reach = Math.hypot(state.shake.x, state.shake.y);
  if (reach > SHAKE_LIMIT) {
    state.shake.x *= SHAKE_LIMIT / reach;
    state.shake.y *= SHAKE_LIMIT / reach;
  }
}

function updateCountdown(now) {
  if (state.restartDeadline === null || state.phase !== 'ended' || !watchingMatch()) {
    if (!elements.countdown.hidden) {
      elements.countdown.hidden = true;
      state.countdownShown = null;
    }
    return;
  }
  const seconds = Math.max(0, Math.ceil((state.restartDeadline - now) / 1_000));
  elements.countdown.hidden = false;
  if (seconds === state.countdownShown) return;
  state.countdownShown = seconds;
  elements['countdown-value'].textContent = seconds;
  elements['countdown-label'].textContent = seconds > 0 ? 'Next match in' : 'Starting';
  elements['countdown-value'].classList.remove('tick');
  void elements['countdown-value'].offsetWidth;
  elements['countdown-value'].classList.add('tick');
}

function announce(kicker, title, copy) {
  elements.announcement.hidden = false;
  elements['announcement-kicker'].textContent = kicker;
  elements['announcement-title'].textContent = title;
  elements['announcement-copy'].textContent = copy;
}

function toast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => elements.toast.classList.remove('visible'), 2_300);
}

function resize() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  elements.game.width = Math.floor(innerWidth * ratio);
  elements.game.height = Math.floor(innerHeight * ratio);
  elements.game.style.width = `${innerWidth}px`;
  elements.game.style.height = `${innerHeight}px`;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  if (state.mouse.x || state.mouse.y) {
    state.aim = Math.atan2(state.mouse.y - innerHeight / 2, state.mouse.x - innerWidth / 2);
  }
}

function worldToScreen(point) {
  return {
    x: (point.x - state.camera.x) * state.scale + innerWidth / 2,
    y: (point.y - state.camera.y) * state.scale + innerHeight / 2,
  };
}

// ── character sprites ───────────────────────────────────────────────────────
const art = { atlas: null, skins: null, weapons: null, ready: false };

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener('load', () => resolve(image));
    image.addEventListener('error', () => reject(new Error(`could not load ${source}`)));
    image.src = source;
  });
}

async function loadArt() {
  try {
    const atlas = await (await fetch('assets/atlas.json')).json();
    const [skins, weapons, seed] = await Promise.all([
      loadImage(atlas.skins.image),
      loadImage(atlas.weapons.image),
      loadImage('assets/flower-seed.png'),
    ]);
    Object.assign(art, { atlas, skins, weapons, seed, ready: true });
  } catch (error) {
    // Flat shapes still render, so a missing sheet costs looks, not play.
    console.warn('character art unavailable, falling back to shapes', error);
  }
}

function drawSprite(image, rect, angle, scale, anchorX, anchorY) {
  context.save();
  context.rotate(angle);
  context.drawImage(
    image, rect.x, rect.y, rect.w, rect.h,
    -anchorX * rect.w * scale, -anchorY * rect.h * scale,
    rect.w * scale, rect.h * scale,
  );
  context.restore();
}

function drawWorld() {
  context.fillStyle = '#161f25';
  context.fillRect(0, 0, innerWidth, innerHeight);
  if (!state.map || !state.snapshot) return;

  drawWorldFloor(context, state.map, state.camera, state.scale, innerWidth, innerHeight);
  drawStorm();
  // Only the cover in view, rather than every piece in a world that now holds
  // tens of thousands of them.
  obstacleGridFor(state.map).forEachInBox(
    state.camera.x - innerWidth / (2 * state.scale) - 200,
    state.camera.y - innerHeight / (2 * state.scale) - 200,
    state.camera.x + innerWidth / (2 * state.scale) + 200,
    state.camera.y + innerHeight / (2 * state.scale) + 200,
    (obstacle) => drawWorldObstacle(context, obstacle, state.camera, state.scale, innerWidth, innerHeight),
  );
  for (const pickup of state.pickups.values()) drawPickup(pickup);
  for (const player of state.frameTargets ?? []) if (player.alive) drawPlayer(player);
  // Before the lighting pass, so motes are dimmed by the dark like everything
  // else rather than glowing through it.
  particles.draw(context, state.camera, state.scale, innerWidth, innerHeight);
  drawWorldBorder(context, state.map, state.camera, state.scale, innerWidth, innerHeight);
  lighting.draw(context, {
    map: state.map, camera: state.camera, scale: state.scale, width: innerWidth, height: innerHeight,
    players: state.frameTargets, pickups: [...state.pickups.values()], impacts: state.frameImpacts,
    focusId: me()?.alive ? state.playerId : me()?.spectatorTargetId,
    rifle: state.config.rifle,
    shotAge: (id) => projectiles.shotAge(id, id === state.playerId ? performance.now() : state.renderTime),
  });
  // After the lighting pass so the wash is not multiplied away, and before the
  // projectiles so shots and impacts stay crisp on top of it.
  drawTeamTint(context, state.map, state.camera, state.scale, innerWidth, innerHeight);
  for (const trail of state.frameTrails) drawBulletTrail(trail);
  for (const bullet of state.frameBullets) drawBullet(bullet);
  for (const impact of state.frameImpacts) drawImpact(impact);
  drawCrosshair();
}

function drawStorm() {
  const storm = state.snapshot.storm;
  if (!storm) return;
  const center = worldToScreen(storm);
  context.save();
  context.fillStyle = 'rgba(16, 39, 30, 0.58)';
  context.beginPath();
  context.rect(0, 0, innerWidth, innerHeight);
  context.arc(center.x, center.y, storm.radius * state.scale, 0, Math.PI * 2, true);
  context.fill('evenodd');
  context.strokeStyle = PALETTE.pink;
  context.lineWidth = 3;
  context.setLineDash([10, 8]);
  context.beginPath();
  context.arc(center.x, center.y, storm.radius * state.scale, 0, Math.PI * 2);
  context.stroke();
  context.restore();
}

const PICKUP_ART = { rifle: 'rifle', ammo: 'magazine' };
const TEAM_COLOURS = { blue: '#5aa3ff', red: '#ff5d5d' };
const TEAM_NAMES = { blue: 'Blue', red: 'Red' };

function drawPickup(pickup) {
  const position = worldToScreen(pickup);
  context.save();
  context.translate(position.x, position.y);
  context.fillStyle = 'rgba(15, 23, 29, 0.7)';
  context.strokeStyle = pickup.kind === 'seed' ? '#ff8c9c' : '#cdb56b';
  context.lineWidth = 1;
  context.beginPath();
  context.arc(0, 0, 24 * state.scale, 0, Math.PI * 2);
  context.fill();
  context.stroke();

  // Seeds are a fraction of the loot on the ground and were a small flat disc
  // among hundreds of weapon sprites, which made them near impossible to spot.
  // They now use the same artwork the inventory shows them growing from.
  if (pickup.kind === 'seed' && art.seed) {
    const height = state.config.playerRadius * state.scale * 1.9;
    const seedWidth = art.seed.width / art.seed.height * height;
    context.drawImage(art.seed, -seedWidth / 2, -height / 2, seedWidth, height);
    context.restore();
    return;
  }

  const artName = PICKUP_ART[pickup.kind];
  if (art.ready && artName) {
    const rect = art.atlas.weapons.items[artName];
    const height = state.config.playerRadius * state.scale * (pickup.kind === 'rifle' ? 2.4 : 1.5);
    drawSprite(art.weapons, rect, -0.45, height / rect.h, 0.5, 0.5);
    context.restore();
    return;
  }

  if (pickup.kind === 'rifle') {
    context.rotate(-0.45);
    context.fillStyle = PALETTE.forestDark;
    context.fillRect(-18, -4, 36, 8);
    context.fillStyle = PALETTE.cream;
    context.fillRect(-2, 4, 8, 9);
  } else if (pickup.kind === 'ammo') {
    context.fillStyle = PALETTE.stone;
    context.fillRect(-10, -10, 20, 20);
    context.fillStyle = PALETTE.forestDark;
    context.fillRect(-5, -6, 3, 12);
    context.fillRect(2, -6, 3, 12);
  } else {
    context.fillStyle = PALETTE.pink;
    context.beginPath();
    context.arc(0, 0, 8, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = PALETTE.forest;
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(0, 6);
    context.lineTo(0, 17);
    context.stroke();
  }
  context.restore();
}

function drawBulletTrail(trail) {
  const tail = worldToScreen({ x: trail.x1, y: trail.y1 });
  const head = worldToScreen({ x: trail.x2, y: trail.y2 });
  if (Math.max(tail.x, head.x) < -12 || Math.min(tail.x, head.x) > innerWidth + 12
    || Math.max(tail.y, head.y) < -12 || Math.min(tail.y, head.y) > innerHeight + 12) return;
  context.save();
  context.globalCompositeOperation = 'screen';
  context.globalAlpha = trail.alpha;
  // Square endpoints stop at actual flight positions; broad glow fades into
  // a narrow bright core, including during the final fade at a wall.
  context.lineCap = 'butt';
  const gradient = context.createLinearGradient(tail.x, tail.y, head.x, head.y);
  gradient.addColorStop(0, 'rgba(255, 161, 65, 0)');
  gradient.addColorStop(0.35, 'rgba(255, 181, 87, 0.38)');
  gradient.addColorStop(1, 'rgba(255, 231, 171, 0.98)');
  context.strokeStyle = gradient;
  context.beginPath();
  context.moveTo(tail.x, tail.y);
  context.lineTo(head.x, head.y);
  context.lineWidth = 7 * state.scale;
  context.globalAlpha = trail.alpha * 0.2;
  context.stroke();
  context.lineWidth = 2 * state.scale;
  context.globalAlpha = trail.alpha;
  context.stroke();
  context.restore();
}

function drawBullet(bullet) {
  const position = worldToScreen(bullet);
  context.save();
  context.translate(position.x, position.y);
  context.rotate(Math.atan2(bullet.vy, bullet.vx));
  context.scale(state.scale, state.scale);
  if (art.ready) {
    // This is the projectile assigned to BulletPrefab in the reference scene.
    const rect = art.atlas.weapons.items.magazine;
    context.shadowColor = '#ffe1a0';
    context.shadowBlur = 3;
    drawSprite(art.weapons, rect, -Math.PI / 2, 11 / rect.h, 0.5, 1);
  } else {
    context.fillStyle = '#f2cf7c';
    context.fillRect(-10, -2, 10, 4);
  }
  context.restore();
}

function drawFallbackCharacter(player, radius) {
  context.strokeStyle = PALETTE.forestDark;
  context.lineWidth = 5;
  context.beginPath();
  context.moveTo(Math.cos(player.aim) * radius * 0.5, Math.sin(player.aim) * radius * 0.5);
  context.lineTo(Math.cos(player.aim) * radius * 1.9, Math.sin(player.aim) * radius * 1.9);
  context.stroke();
  context.fillStyle = player.id === state.playerId ? PALETTE.cream : PALETTE.forest;
  context.beginPath();
  context.arc(0, 0, radius, 0, Math.PI * 2);
  context.fill();
  context.lineWidth = 3;
  context.strokeStyle = player.id === state.playerId ? PALETTE.pink : PALETTE.cream;
  context.stroke();
}

function drawPlayer(player) {
  const position = worldToScreen(player);
  const radius = state.config.playerRadius * state.scale;
  context.save();
  context.translate(position.x, position.y);
  context.fillStyle = 'rgba(0, 0, 0, 0.28)';
  context.beginPath();
  context.ellipse(0, 3 * state.scale, radius * 1.04, radius * 0.88, player.aim, 0, Math.PI * 2);
  context.fill();
  const shotAge = projectiles.shotAge(player.id, player.id === state.playerId ? performance.now() : state.renderTime);
  const hitAge = performance.now() - (state.hitFlashes.get(player.id)?.at ?? -Infinity);
  const hitStrength = Math.max(0, 1 - hitAge / 180);
  context.save();
  if (hitStrength > 0) {
    context.filter = `brightness(${1 + hitStrength * 2.4}) saturate(${1 - hitStrength * 0.72}) drop-shadow(0 0 ${5 * hitStrength}px #ff5d73)`;
  }
  if (art.ready) drawSpriteCharacter(context, player, radius, art, {
    recoil: Math.max(0, 1 - shotAge / 110),
    stride: Math.sin(state.lastFrame / 85) * Math.min(1, Math.hypot(player.vx ?? 0, player.vy ?? 0) / 225),
  });
  else drawFallbackCharacter(player, radius);
  context.restore();
  if (hitStrength > 0) drawHitFlash(radius, hitAge, hitStrength);
  if (player.hasRifle && shotAge < 65) drawMuzzleFlash(player, shotAge);
  context.restore();

  if (player.id === state.playerId) {
    // Own-player ring: 16 near-identical silhouettes are hard to tell apart in a
    // crowd, and the skin colour alone does not survive a panicked glance.
    context.strokeStyle = 'rgba(255, 132, 151, 0.65)';
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(position.x, position.y, radius * 1.3, player.aim + 0.8, player.aim + Math.PI * 2 - 0.8);
    context.stroke();
  }

  // Cleared the sprite, which is wider than the collision radius.
  // Health and name in the player's own team colour, and marked when they are
  // on your side: with two sides in matching kit, telling a teammate from an
  // opponent has to be possible in the instant before you decide to fire.
  const labelGap = radius * 1.8;
  const mine = state.frameTargets?.find((candidate) => candidate.id === state.playerId);
  const friendly = Boolean(player.team) && player.team === mine?.team;
  const teamColour = TEAM_COLOURS[player.team] ?? PALETTE.pink;
  context.fillStyle = 'rgba(9, 14, 19, 0.75)';
  context.fillRect(position.x - 20, position.y - labelGap - 10, 40, 4);
  context.fillStyle = teamColour;
  context.fillRect(position.x - 20, position.y - labelGap - 10, 40 * player.hp / 100, 4);
  context.fillStyle = friendly ? teamColour : PALETTE.cream;
  context.font = '700 11px system-ui';
  context.textAlign = 'center';
  context.fillText(player.name, position.x, position.y + labelGap + 14);
}

function drawHitFlash(radius, age, strength) {
  const progress = Math.min(1, age / 180);
  context.save();
  context.globalCompositeOperation = 'screen';
  context.globalAlpha = strength;
  const glow = context.createRadialGradient(0, 0, radius * 0.15, 0, 0, radius * (1.25 + progress * 0.65));
  glow.addColorStop(0, 'rgba(255, 255, 255, 0.72)');
  glow.addColorStop(0.42, 'rgba(255, 93, 115, 0.35)');
  glow.addColorStop(1, 'rgba(255, 93, 115, 0)');
  context.fillStyle = glow;
  context.beginPath();
  context.arc(0, 0, radius * (1.25 + progress * 0.65), 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = '#fff0e8';
  context.lineWidth = Math.max(1, 2.2 * state.scale * strength);
  context.beginPath();
  context.arc(0, 0, radius * (1.05 + progress * 0.8), 0, Math.PI * 2);
  context.stroke();
  context.restore();
}

function drawMuzzleFlash(player, age) {
  context.save();
  const muzzle = clippedMuzzle(player, state.config.rifle, state.map);
  context.translate((muzzle.x - player.x) * state.scale, (muzzle.y - player.y) * state.scale);
  context.rotate(player.aim);
  context.scale(state.scale, state.scale);
  context.globalAlpha = 1 - age / 65;
  context.fillStyle = '#ffe3a5';
  context.shadowColor = '#ffd272';
  context.shadowBlur = 12;
  context.beginPath();
  context.moveTo(0, -3);
  context.lineTo(9, -5);
  context.lineTo(6, -1);
  context.lineTo(16, 0);
  context.lineTo(6, 2);
  context.lineTo(9, 5);
  context.lineTo(0, 3);
  context.closePath();
  context.fill();
  context.restore();
}

function drawImpact(impact) {
  const position = worldToScreen(impact);
  const progress = impact.age / 180;
  const angle = Math.atan2(-impact.vy, -impact.vx);
  context.save();
  context.translate(position.x, position.y);
  context.scale(state.scale, state.scale);
  context.globalAlpha = 1 - progress;
  context.strokeStyle = impact.hit === 'player' ? '#ff879a' : '#ffdc96';
  context.lineWidth = 1.6;
  for (let i = -2; i <= 2; i += 1) {
    const direction = angle + i * 0.55;
    const distance = 3 + progress * (10 + (i % 2) * 3);
    context.beginPath();
    context.moveTo(Math.cos(direction) * distance, Math.sin(direction) * distance);
    context.lineTo(Math.cos(direction) * (distance + 4), Math.sin(direction) * (distance + 4));
    context.stroke();
  }
  context.restore();
}

function drawCrosshair() {
  if (state.phase !== 'playing' || !me()?.alive) return;
  const { x, y } = state.mouse;
  if (!x && !y) return;
  context.save();
  context.translate(x, y);
  context.strokeStyle = '#f3ead2';
  context.lineWidth = 1.5;
  context.shadowColor = '#10181e';
  context.shadowBlur = 3;
  context.beginPath();
  for (let i = 0; i < 4; i += 1) {
    const angle = i * Math.PI / 2;
    context.moveTo(Math.cos(angle) * 5, Math.sin(angle) * 5);
    context.lineTo(Math.cos(angle) * 10, Math.sin(angle) * 10);
  }
  context.stroke();
  context.restore();
}

function frame(now) {
  const delta = Math.min(0.1, (now - state.lastFrame) / 1_000);
  state.lastFrame = now;

  // Bleed off any leftover prediction error. Fast enough to stay current,
  // slow enough that a correction reads as drift instead of a jolt.
  const settle = Math.exp(-14 * delta);
  state.correction.x *= settle;
  state.correction.y *= settle;

  attemptFire(now);
  const renderTime = now - INTERPOLATION_DELAY_MS;
  state.renderTime = renderTime;
  state.frameTargets = renderedPlayers(renderTime);
  const projectileFrame = projectiles.frame(renderTime, state.map, state.config?.rifle.bulletRadius, {
    immediateOwnerId: state.playerId,
    immediateTime: now,
    // So a shot stops on a body instead of sliding through it while the
    // server's impact event is still in flight.
    blockers: state.config
      ? { targets: state.frameTargets, radius: state.config.playerRadius }
      : null,
  });
  state.frameBullets = projectileFrame.bullets;
  state.frameImpacts = projectileFrame.impacts;
  state.frameTrails = projectileFrame.trails;
  const target = cameraTarget();
  if (target) {
    // The camera snaps to our own predicted position rather than easing toward
    // it: easing toward a position that is already correct only adds lag.
    const interpolation = target.id === state.playerId ? 1 : 1 - Math.exp(-8 * delta);
    state.cameraAnchor.x += (target.x - state.cameraAnchor.x) * interpolation;
    state.cameraAnchor.y += (target.y - state.cameraAnchor.y) * interpolation;
  }
  const recoilSettle = Math.exp(-SHAKE_DECAY * delta);
  state.shake.x *= recoilSettle;
  state.shake.y *= recoilSettle;
  state.camera.x = state.cameraAnchor.x + state.shake.x;
  state.camera.y = state.cameraAnchor.y + state.shake.y;
  updateCountdown(now);
  particles.update(delta, state.camera, state.scale, innerWidth, innerHeight);
  drawWorld();
  requestAnimationFrame(frame);
}

// ── client-side prediction ──────────────────────────────────────────────────
// Inputs are applied locally the moment they are sent, so the player responds
// to the keyboard immediately instead of after a server round trip. The server
// still decides the real outcome; see reconcile().

function sendInput() {
  if (state.phase !== 'playing') return;
  const input = {
    sequence: ++state.inputSequence,
    up: state.keys.has('KeyW'),
    down: state.keys.has('KeyS'),
    left: state.keys.has('KeyA'),
    right: state.keys.has('KeyD'),
    // Firing has its own immediate message and prediction path. Keeping this
    // false prevents the movement stream from creating a second server shot.
    firing: false,
    aim: state.aim,
  };
  send({ type: 'input', ...input });

  if (!state.predicted || !state.map || !state.config) return;
  // One input, one fixed step -- matching how the server consumes them, so a
  // replay of the same inputs lands in the same place.
  stepPlayer(state.predicted, input, state.config, state.map, 1 / state.config.tickRate);
  state.pending.push(input);
}

function attemptFire(now = performance.now()) {
  if (!state.firing || state.phase !== 'playing' || !state.map || !state.config) return;
  if (now - state.lastLocalShotAt < state.config.rifle.fireIntervalMs) return;
  const player = localPlayer();
  if (!player?.alive || !player.hasRifle || player.reloading) return;
  const available = player.magazine - state.predictedShots.size;
  const clientShotId = `${state.playerId}:${++state.shotSequence}`;
  state.lastLocalShotAt = now;

  if (available <= 0) {
    if (now - state.lastEmptyAt < 400) return;
    state.lastEmptyAt = now;
    state.predictedEmpty.add(clientShotId);
    send({ type: 'fire', shotId: clientShotId, aim: state.aim });
    audio.play('empty');
    setTimeout(() => state.predictedEmpty.delete(clientShotId), 1_000);
    return;
  }

  const muzzle = clippedMuzzle({ ...player, aim: state.aim }, state.config.rifle, state.map);
  projectiles.predictShot({
    clientShotId,
    ownerId: state.playerId,
    x: muzzle.x,
    y: muzzle.y,
    vx: Math.cos(state.aim) * state.config.rifle.bulletSpeed,
    vy: Math.sin(state.aim) * state.config.rifle.bulletSpeed,
    at: now,
  });
  state.predictedShots.set(clientShotId, now);
  send({ type: 'fire', shotId: clientShotId, aim: state.aim });
  audio.play('shot');
  kickCamera(state.aim);
  setTimeout(() => {
    if (!state.predictedShots.delete(clientShotId)) return;
    projectiles.rejectPrediction(clientShotId);
  }, 1_000);
}

// Re-runs everything the server has not confirmed yet, starting from the
// position it did confirm. Whatever the server changed underneath us (a wall,
// a dropped packet) survives; everything we have sent since is reapplied.
function reconcile(authoritative) {
  if (!state.map || !state.config) return;
  const body = {
    x: authoritative.x,
    y: authoritative.y,
    vx: authoritative.vx ?? 0,
    vy: authoritative.vy ?? 0,
  };
  state.pending = state.pending.filter((input) => input.sequence > (authoritative.ack ?? 0));
  const step = 1 / state.config.tickRate;
  for (const input of state.pending) stepPlayer(body, input, state.config, state.map, step);

  if (state.predicted) {
    // Carry the old prediction's error forward as a visual offset, then let it
    // decay. Without this every correction, however small, is a visible jump.
    const errorX = state.predicted.x + state.correction.x - body.x;
    const errorY = state.predicted.y + state.correction.y - body.y;
    const drift = Math.hypot(errorX, errorY);
    if (drift > RECONCILE_SMOOTH_LIMIT) {
      // Too far gone to hide: snap, and accept the rubberband.
      state.correction.x = 0;
      state.correction.y = 0;
    } else {
      state.correction.x = errorX;
      state.correction.y = errorY;
    }
  }
  state.predicted = body;
}

// Where our own player should be drawn this frame.
function localPlayer() {
  const player = me();
  if (!player) return null;
  if (!player.alive || !state.predicted) return player;
  return {
    ...player,
    x: state.predicted.x + state.correction.x,
    y: state.predicted.y + state.correction.y,
    aim: state.aim,
  };
}

// ── entity interpolation and dead reckoning ─────────────────────────────────
// Everyone else is drawn slightly in the past, slid between the two snapshots
// that bracket that moment. If no newer snapshot has arrived, their last known
// velocity carries them for a short while rather than leaving them frozen.
function bracket(renderTime) {
  const history = state.history;
  if (history.length === 0) return null;
  let older = history[0];
  let newer = null;
  for (const entry of history) {
    if (entry.at <= renderTime) older = entry;
    else { newer = entry; break; }
  }
  const span = newer ? newer.at - older.at : 0;
  return { older, newer, ratio: span > 0 ? (renderTime - older.at) / span : 1 };
}

// Slides entities between the two snapshots either side of renderTime. With no
// newer snapshot to aim at -- a dropped or late packet -- their last known
// velocity carries them, which is what keeps motion smooth through a hiccup
// instead of stalling and then teleporting.
function interpolate(renderTime, key, blend) {
  const frames = bracket(renderTime);
  if (!frames) return [];
  const { older, newer, ratio } = frames;

  if (!newer) {
    const ahead = Math.min(renderTime - older.at, EXTRAPOLATION_LIMIT_MS) / 1_000;
    return older[key].map((entity) => ({
      ...entity,
      x: entity.x + (entity.vx ?? 0) * ahead,
      y: entity.y + (entity.vy ?? 0) * ahead,
    }));
  }

  const previous = new Map(older[key].map((entity) => [entity.id, entity]));
  return newer[key].map((entity) => {
    const before = previous.get(entity.id);
    if (!before) return entity;
    return blend(before, entity, ratio);
  });
}

function interpolatedPlayers(renderTime) {
  return interpolate(renderTime, 'players', (before, after, ratio) => ({
    ...after,
    x: before.x + (after.x - before.x) * ratio,
    y: before.y + (after.y - before.y) * ratio,
    aim: before.aim + angleDelta(before.aim, after.aim) * ratio,
  }));
}

// Shortest way round the circle, so aim never spins the long way at the seam.
function angleDelta(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

// Players as they should be drawn: everyone interpolated, ourselves predicted.
function renderedPlayers(renderTime) {
  const players = interpolatedPlayers(renderTime);
  const local = localPlayer();
  if (!local) return players;
  return players.map((player) => (player.id === state.playerId ? local : player));
}

elements.create.addEventListener('click', () => { audio.unlock(); send({ type: 'create_room', name: elements.name.value }); });
elements.join.addEventListener('click', () => { audio.unlock(); send({ type: 'join_room', name: elements.name.value, roomCode: elements['room-code'].value }); });
elements['room-code'].addEventListener('input', (event) => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
elements['room-code'].addEventListener('keydown', (event) => { if (event.key === 'Enter') elements.join.click(); });
elements.start.addEventListener('click', () => send({ type: 'start_match' }));
elements['copy-code'].addEventListener('click', async () => {
  await navigator.clipboard.writeText(state.roomCode);
  toast('Room code copied');
});

window.addEventListener('keydown', (event) => {
  audio.unlock();
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(event.code)) {
    state.keys.add(event.code);
    event.preventDefault();
  }
  if (event.code === 'KeyR' && !event.repeat) send({ type: 'reload' });
  if (event.code === 'KeyE' && !event.repeat) send({ type: 'consume_flower' });
});
window.addEventListener('keyup', (event) => state.keys.delete(event.code));
window.addEventListener('blur', () => { state.keys.clear(); state.firing = false; });
elements.game.addEventListener('mousemove', (event) => {
  state.mouse.x = event.clientX;
  state.mouse.y = event.clientY;
  state.aim = Math.atan2(event.clientY - innerHeight / 2, event.clientX - innerWidth / 2);
});
elements.game.addEventListener('mousedown', (event) => {
  audio.unlock();
  if (event.button === 0) {
    state.firing = true;
    attemptFire(performance.now());
  }
});
window.addEventListener('mouseup', (event) => { if (event.button === 0) state.firing = false; });
window.addEventListener('contextmenu', (event) => event.preventDefault());
window.addEventListener('resize', resize);

elements['refresh-rooms'].addEventListener('click', requestRooms);

resize();
setInterval(sendInput, 1_000 / 30);
// The welcome screen keeps its list of open gardens current on its own.
setInterval(requestRooms, 4_000);
loadArt();
loadWorldArt();
connect();
requestAnimationFrame(frame);
