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
].map((id) => [id, document.getElementById(id)]));

const context = elements.game.getContext('2d');
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
  keys: new Set(),
  firing: false,
  aim: 0,
  inputSequence: 0,
  camera: { x: 0, y: 0 },
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
  } else if (message.type === 'lobby') {
    state.isHost = message.hostId === state.playerId;
    updateLobby(message);
  } else if (message.type === 'match_started') {
    state.map = message.map;
    state.phase = 'playing';
    elements.menu.hidden = true;
    elements.lobby.hidden = true;
    elements.hud.hidden = false;
    elements.controls.hidden = false;
    elements.announcement.hidden = true;
    elements['hud-room'].textContent = state.roomCode;
    const me = state.snapshot?.players?.find((player) => player.id === state.playerId);
    state.camera.x = me?.x ?? state.map.width / 2;
    state.camera.y = me?.y ?? state.map.height / 2;
    toast(`Garden ${message.map.seed.slice(0, 6).toUpperCase()} generated`);
  } else if (message.type === 'snapshot') {
    state.snapshot = message;
    state.phase = message.phase;
    updateHud();
  } else if (message.type === 'pong') {
    elements.ping.textContent = `${Date.now() - message.sentAt} ms`;
  } else if (message.type === 'error') {
    toast(message.message);
  }
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
  elements.start.hidden = !state.isHost;
  elements.waiting.hidden = state.isHost;
}

function me() {
  return state.snapshot?.players?.find((player) => player.id === state.playerId);
}

function cameraTarget() {
  const player = me();
  if (!player) return null;
  if (player.alive) return player;
  return state.snapshot.players.find((candidate) => candidate.id === player.spectatorTargetId) ?? player;
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
  elements['flower-icon'].className = `flower-icon ${heal === null ? '' : heal <= 16 ? 'seed' : heal <= 33 ? 'budding' : 'bloomed'}`;
  elements['flower-card'].style.opacity = heal === null ? '0.46' : '1';

  const storm = state.snapshot.storm;
  if (storm) {
    elements['storm-label'].textContent = `STORM / CYCLE ${storm.cycle}`;
    const duration = storm.phase === 'contracting' ? state.config.storm.contractionMs : state.config.storm.holdMs;
    const remaining = storm.phase === 'contracting'
      ? duration * (1 - storm.progress)
      : duration;
    elements['storm-time'].textContent = storm.phase === 'contracting'
      ? `${Math.max(0, Math.ceil(remaining / 1_000))}s · CLOSING`
      : '10s · HOLD';
  }

  if (!player.alive && state.snapshot.phase === 'playing') {
    const target = state.snapshot.players.find((candidate) => candidate.id === player.spectatorTargetId);
    announce('ELIMINATED', 'The garden grows on', target ? `Spectating ${target.name}` : 'Waiting for the next match');
  } else if (state.snapshot.phase === 'ended') {
    const winner = state.snapshot.players.find((candidate) => candidate.id === state.snapshot.winnerId);
    announce('MATCH COMPLETE', winner?.id === state.playerId ? 'You survived' : `${winner?.name ?? 'No one'} survived`, 'The host can create a new room for another garden.');
  } else {
    elements.announcement.hidden = true;
  }

  for (const event of state.snapshot.events ?? []) {
    if (event.type === 'pickup' && event.playerId === state.playerId) toast(event.kind === 'seed' ? 'Seed carried - press E to heal' : `${event.kind} collected`);
  }
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
}

function worldToScreen(point) {
  return {
    x: (point.x - state.camera.x) * state.scale + innerWidth / 2,
    y: (point.y - state.camera.y) * state.scale + innerHeight / 2,
  };
}

function drawWorld() {
  context.fillStyle = PALETTE.leaf;
  context.fillRect(0, 0, innerWidth, innerHeight);
  if (!state.map || !state.snapshot) return;

  const topLeft = worldToScreen({ x: 0, y: 0 });
  context.fillStyle = PALETTE.moss;
  context.fillRect(topLeft.x, topLeft.y, state.map.width * state.scale, state.map.height * state.scale);
  drawPaths();
  drawStorm();
  for (const obstacle of state.map.obstacles) drawObstacle(obstacle);
  for (const pickup of state.snapshot.pickups ?? []) drawPickup(pickup);
  for (const bullet of state.snapshot.bullets ?? []) drawBullet(bullet);
  for (const player of state.snapshot.players ?? []) if (player.alive) drawPlayer(player);
  drawMapBorder(topLeft);
}

function drawPaths() {
  const center = state.map.width / 2;
  const horizontal = worldToScreen({ x: 0, y: center - 35 });
  const vertical = worldToScreen({ x: center - 35, y: 0 });
  context.fillStyle = PALETTE.stone;
  context.globalAlpha = 0.38;
  context.fillRect(horizontal.x, horizontal.y, state.map.width * state.scale, 70 * state.scale);
  context.fillRect(vertical.x, vertical.y, 70 * state.scale, state.map.height * state.scale);
  context.globalAlpha = 1;
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

function drawObstacle(obstacle) {
  const position = worldToScreen(obstacle);
  const colors = obstacle.kind === 'hedge'
    ? [PALETTE.forest, PALETTE.leaf]
    : obstacle.kind === 'rock' ? [PALETTE.stone, '#777763'] : [PALETTE.forestDark, PALETTE.stone];
  context.fillStyle = colors[0];
  context.fillRect(position.x, position.y, obstacle.width * state.scale, obstacle.height * state.scale);
  context.strokeStyle = colors[1];
  context.lineWidth = Math.max(2, 4 * state.scale);
  context.strokeRect(position.x + 2, position.y + 2, obstacle.width * state.scale - 4, obstacle.height * state.scale - 4);
}

function drawPickup(pickup) {
  const position = worldToScreen(pickup);
  context.save();
  context.translate(position.x, position.y);
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

function drawBullet(bullet) {
  const position = worldToScreen(bullet);
  context.fillStyle = PALETTE.cream;
  context.beginPath();
  context.arc(position.x, position.y, 3, 0, Math.PI * 2);
  context.fill();
}

function drawPlayer(player) {
  const position = worldToScreen(player);
  const radius = state.config.playerRadius * state.scale;
  context.save();
  context.translate(position.x, position.y);
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
  context.restore();

  context.fillStyle = PALETTE.forestDark;
  context.fillRect(position.x - 20, position.y - radius - 13, 40, 4);
  context.fillStyle = PALETTE.pink;
  context.fillRect(position.x - 20, position.y - radius - 13, 40 * player.hp / 100, 4);
  context.fillStyle = PALETTE.cream;
  context.font = '700 11px system-ui';
  context.textAlign = 'center';
  context.fillText(player.name, position.x, position.y + radius + 18);
}

function drawMapBorder(topLeft) {
  context.strokeStyle = PALETTE.forestDark;
  context.lineWidth = 12;
  context.strokeRect(topLeft.x, topLeft.y, state.map.width * state.scale, state.map.height * state.scale);
}

function frame(now) {
  const delta = Math.min(0.1, (now - state.lastFrame) / 1_000);
  state.lastFrame = now;
  const target = cameraTarget();
  if (target) {
    const interpolation = 1 - Math.exp(-8 * delta);
    state.camera.x += (target.x - state.camera.x) * interpolation;
    state.camera.y += (target.y - state.camera.y) * interpolation;
  }
  drawWorld();
  requestAnimationFrame(frame);
}

function sendInput() {
  if (state.phase !== 'playing') return;
  send({
    type: 'input',
    sequence: ++state.inputSequence,
    up: state.keys.has('KeyW'),
    down: state.keys.has('KeyS'),
    left: state.keys.has('KeyA'),
    right: state.keys.has('KeyD'),
    firing: state.firing,
    aim: state.aim,
  });
}

elements.create.addEventListener('click', () => send({ type: 'create_room', name: elements.name.value }));
elements.join.addEventListener('click', () => send({ type: 'join_room', name: elements.name.value, roomCode: elements['room-code'].value }));
elements['room-code'].addEventListener('input', (event) => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
elements['room-code'].addEventListener('keydown', (event) => { if (event.key === 'Enter') elements.join.click(); });
elements.start.addEventListener('click', () => send({ type: 'start_match' }));
elements['copy-code'].addEventListener('click', async () => {
  await navigator.clipboard.writeText(state.roomCode);
  toast('Room code copied');
});

window.addEventListener('keydown', (event) => {
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
elements.game.addEventListener('mousedown', (event) => { if (event.button === 0) state.firing = true; });
window.addEventListener('mouseup', (event) => { if (event.button === 0) state.firing = false; });
window.addEventListener('contextmenu', (event) => event.preventDefault());
window.addEventListener('resize', resize);

resize();
setInterval(sendInput, 1_000 / 30);
connect();
requestAnimationFrame(frame);
