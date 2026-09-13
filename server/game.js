import crypto from 'node:crypto';
import { CONFIG } from './config.js';
import { clamp, distanceSquared, pointInsideRect } from './geometry.js';
import { generateMap, validateMap } from './map.js';
import { createRandom, randomBetween } from './random.js';
import { EMPTY_INPUT, readInput, stepPlayer } from '../public/shared/simulation.js';

// Every input is simulated as exactly one step of this length on both sides, so
// the client can replay its unacknowledged inputs and arrive at the same
// position the server did. A variable step would make the two drift apart.
const FIXED_STEP = 1 / CONFIG.tickRate;

function cleanName(value) {
  const result = String(value ?? '').trim().replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 18);
  return result || 'Gardener';
}

function publicPlayer(player, now) {
  return {
    id: player.id,
    name: player.name,
    skin: player.skin,
    x: Math.round(player.x * 10) / 10,
    y: Math.round(player.y * 10) / 10,
    // Velocity lets clients keep a player moving when the next packet is late
    // instead of freezing them in place until it lands.
    vx: Math.round(player.vx),
    vy: Math.round(player.vy),
    // The last input this player sent that is baked into the position above.
    ack: player.lastProcessedSequence,
    aim: player.input.aim,
    hp: Math.max(0, Math.round(player.hp * 10) / 10),
    alive: player.alive,
    connected: player.connected,
    hasRifle: player.hasRifle,
    magazine: player.magazine,
    reserveAmmo: player.reserveAmmo,
    reloading: player.reloadEndsAt > now,
    flowerHeal: player.flowerCollectedAt === null ? null : flowerHealAt(player, now),
    spectatorTargetId: player.spectatorTargetId,
  };
}

export function flowerHealAt(player, now) {
  if (player.flowerCollectedAt === null) return 0;
  const elapsed = Math.max(0, now - player.flowerCollectedAt);
  return Math.min(
    CONFIG.flower.maxHeal,
    CONFIG.flower.startingHeal + Math.floor(elapsed / (CONFIG.flower.secondsPerHp * 1_000)),
  );
}

export class Room {
  constructor(code, hostId, options = {}) {
    this.code = code;
    this.hostId = hostId;
    this.phase = 'lobby';
    this.players = new Map();
    this.map = null;
    this.bullets = [];
    this.events = [];
    this.random = createRandom(code);
    this.now = options.now ?? (() => Date.now());
    this.seedFactory = options.seedFactory ?? (() => crypto.randomBytes(8).toString('hex'));
    this.storm = null;
    this.startedWith = 0;
    this.winnerId = null;
    this.endedAt = null;
  }

  addPlayer(id, name, connected = true) {
    const lateJoin = this.phase === 'playing';
    const player = {
      id,
      name: cleanName(name),
      x: this.map?.width / 2 ?? 0,
      y: this.map?.height / 2 ?? 0,
      vx: 0,
      vy: 0,
      hp: CONFIG.maxHp,
      alive: !lateJoin,
      connected,
      input: { ...EMPTY_INPUT },
      inputQueue: [],
      inputCredits: 0,
      lastProcessedSequence: 0,
      skin: this.nextSkinIndex(),
      hasRifle: false,
      magazine: 0,
      reserveAmmo: 0,
      lastShotAt: -Infinity,
      reloadEndsAt: 0,
      flowerCollectedAt: null,
      spectatorTargetId: lateJoin ? this.randomLivingPlayerId() : null,
      stormDamageCarry: 0,
      killerId: null,
    };
    this.players.set(id, player);
    return player;
  }

  // Hand out the lowest unused skin so a room of players stays visually
  // distinct; past CONFIG.skinCount they start repeating.
  nextSkinIndex() {
    const taken = new Set([...this.players.values()].map((player) => player.skin));
    for (let index = 0; index < CONFIG.skinCount; index += 1) {
      if (!taken.has(index)) return index;
    }
    return this.players.size % CONFIG.skinCount;
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return;
    player.connected = false;
    if (this.phase === 'lobby') {
      this.players.delete(id);
      if (this.hostId === id) this.hostId = this.players.keys().next().value ?? null;
      return;
    }
    if (player.alive) this.eliminate(player, null, 'disconnect');
    this.transferSpectators(id, player.killerId);
  }

  start(requestingPlayerId) {
    if (requestingPlayerId !== this.hostId) throw new Error('Only the host can start the match.');
    if (this.phase === 'playing') throw new Error('The match has already started.');
    const roster = [...this.players.values()].filter((player) => player.connected);
    if (roster.length === 0) throw new Error('At least one connected player is required.');

    const seed = this.seedFactory();
    const map = generateMap(roster.length, seed);
    const validation = validateMap(map);
    if (!validation.valid) throw new Error(`Generated map is invalid: ${validation.issues.join(' ')}`);
    this.map = map;
    this.bullets = [];
    this.events = [];
    this.phase = 'playing';
    this.winnerId = null;
    this.endedAt = null;
    this.startedWith = roster.length;
    this.random = createRandom(seed);
    const now = this.now();
    roster.forEach((player, index) => this.resetPlayer(player, map.spawns[index], now));
    this.storm = {
      phase: 'contracting',
      phaseStartedAt: now,
      from: { x: map.width / 2, y: map.height / 2, radius: map.width * 0.49 },
      to: null,
      cycle: 1,
    };
    this.storm.to = this.nextStormTarget(this.storm.from);
    return this.matchStartedMessage();
  }

  resetPlayer(player, spawn, now) {
    Object.assign(player, {
      x: spawn.x,
      y: spawn.y,
      vx: 0,
      vy: 0,
      hp: CONFIG.maxHp,
      alive: true,
      input: { ...EMPTY_INPUT },
      inputQueue: [],
      inputCredits: 0,
      hasRifle: false,
      magazine: 0,
      reserveAmmo: 0,
      lastShotAt: -Infinity,
      reloadEndsAt: 0,
      flowerCollectedAt: null,
      spectatorTargetId: null,
      stormDamageCarry: 0,
      killerId: null,
      matchJoinedAt: now,
    });
  }

  nextStormTarget(from) {
    const radius = Math.max(CONFIG.storm.minimumRadius, from.radius * CONFIG.storm.radiusScale);
    const travel = Math.max(0, from.radius - radius);
    const angle = this.random() * Math.PI * 2;
    const offset = this.random() * travel * 0.85;
    return {
      x: clamp(from.x + Math.cos(angle) * offset, radius, this.map.width - radius),
      y: clamp(from.y + Math.sin(angle) * offset, radius, this.map.height - radius),
      radius,
    };
  }

  receiveInput(playerId, raw) {
    const player = this.players.get(playerId);
    if (!player || !player.alive || this.phase !== 'playing') return;
    const input = readInput(raw, player.input);
    // Replays and out-of-order arrivals would move the player twice for the
    // same moment, so only ever accept inputs that advance the sequence.
    const newest = player.inputQueue.at(-1)?.sequence ?? player.lastProcessedSequence;
    if (input.sequence <= newest) return;
    // A client sending faster than the tick rate would otherwise buy itself
    // extra movement, so the backlog is capped and the oldest input dropped.
    // Acknowledging the dropped one matters: the client replays everything the
    // server has not confirmed, so an input that is silently discarded stays in
    // its prediction forever and the two never agree again. Acking it turns a
    // permanent desync into one small correction that smoothing absorbs.
    if (player.inputQueue.length >= CONFIG.input.queueLimit) {
      const dropped = player.inputQueue.shift();
      player.lastProcessedSequence = Math.max(player.lastProcessedSequence, dropped.sequence);
    }
    player.inputQueue.push(input);
  }

  requestReload(playerId) {
    const player = this.players.get(playerId);
    const now = this.now();
    if (!player?.alive || !player.hasRifle || player.reloadEndsAt > now) return;
    if (player.magazine >= CONFIG.rifle.magazineSize || player.reserveAmmo <= 0) return;
    player.reloadEndsAt = now + CONFIG.rifle.reloadMs;
  }

  consumeFlower(playerId) {
    const player = this.players.get(playerId);
    if (!player?.alive || player.flowerCollectedAt === null) return 0;
    const heal = flowerHealAt(player, this.now());
    const restored = Math.min(heal, CONFIG.maxHp - player.hp);
    player.hp += restored;
    player.flowerCollectedAt = null;
    this.events.push({ type: 'flower_used', playerId, amount: restored });
    return restored;
  }

  tick(deltaSeconds) {
    if (this.phase !== 'playing') return;
    const now = this.now();
    this.updateStorm(now);
    for (const player of this.players.values()) {
      if (!player.alive) continue;
      this.finishReload(player, now);
      this.consumeInputs(player, now);
      this.collectPickups(player, now);
      this.applyStormDamage(player, deltaSeconds, now);
    }
    this.updateBullets(deltaSeconds, now);
    this.checkWinner(now);
  }

  // Simulates the inputs waiting for this player, one fixed step each. Nothing
  // happens on a tick with no input: skipping is what keeps the server's step
  // sequence identical to the one the client predicted, so a late packet costs
  // a moment of stillness rather than a correction. The backlog is then drained
  // in a burst when it arrives.
  consumeInputs(player, now) {
    player.inputCredits = Math.min(CONFIG.input.creditLimit, player.inputCredits + 1);
    while (player.inputQueue.length > 0 && player.inputCredits > 0) {
      const input = player.inputQueue.shift();
      player.input = input;
      player.inputCredits -= 1;
      player.lastProcessedSequence = input.sequence;
      this.movePlayer(player, FIXED_STEP);
      if (input.firing) this.fire(player, now);
    }
  }

  movePlayer(player, deltaSeconds) {
    stepPlayer(player, player.input, CONFIG, this.map, deltaSeconds);
  }

  collectPickups(player, now) {
    const collected = [];
    for (const pickup of this.map.pickups) {
      if (distanceSquared(player, pickup) > (CONFIG.playerRadius + pickup.radius) ** 2) continue;
      if (pickup.kind === 'rifle' && !player.hasRifle) {
        player.hasRifle = true;
        player.magazine = CONFIG.rifle.magazineSize;
      } else if (pickup.kind === 'ammo' && player.hasRifle) {
        player.reserveAmmo += CONFIG.rifle.magazineSize;
      } else if (pickup.kind === 'seed' && player.flowerCollectedAt === null) {
        player.flowerCollectedAt = now;
      } else {
        continue;
      }
      collected.push(pickup.id);
      this.events.push({ type: 'pickup', playerId: player.id, kind: pickup.kind });
    }
    if (collected.length) this.map.pickups = this.map.pickups.filter((pickup) => !collected.includes(pickup.id));
  }

  finishReload(player, now) {
    if (!player.reloadEndsAt || player.reloadEndsAt > now) return;
    const needed = CONFIG.rifle.magazineSize - player.magazine;
    const loaded = Math.min(needed, player.reserveAmmo);
    player.magazine += loaded;
    player.reserveAmmo -= loaded;
    player.reloadEndsAt = 0;
  }

  fire(player, now) {
    if (!player.hasRifle || player.magazine <= 0 || player.reloadEndsAt > now) return;
    if (now - player.lastShotAt < CONFIG.rifle.fireIntervalMs) return;
    player.lastShotAt = now;
    player.magazine -= 1;
    const aim = player.input.aim + randomBetween(this.random, -CONFIG.rifle.spreadRadians, CONFIG.rifle.spreadRadians);
    const muzzle = CONFIG.playerRadius + 7;
    this.bullets.push({
      id: crypto.randomUUID(),
      ownerId: player.id,
      x: player.x + Math.cos(aim) * muzzle,
      y: player.y + Math.sin(aim) * muzzle,
      vx: Math.cos(aim) * CONFIG.rifle.bulletSpeed,
      vy: Math.sin(aim) * CONFIG.rifle.bulletSpeed,
      expiresAt: now + CONFIG.rifle.bulletLifetimeMs,
    });
  }

  updateBullets(deltaSeconds, now) {
    const active = [];
    for (const bullet of this.bullets) {
      if (bullet.expiresAt <= now) continue;
      bullet.x += bullet.vx * deltaSeconds;
      bullet.y += bullet.vy * deltaSeconds;
      if (bullet.x < 0 || bullet.x > this.map.width || bullet.y < 0 || bullet.y > this.map.height) continue;
      if (this.map.obstacles.some((obstacle) => pointInsideRect(bullet, obstacle, 2))) continue;
      const target = [...this.players.values()].find((player) => (
        player.alive
        && player.id !== bullet.ownerId
        && distanceSquared(player, bullet) <= (CONFIG.playerRadius + 3) ** 2
      ));
      if (target) {
        this.damage(target, CONFIG.rifle.damage, bullet.ownerId, 'rifle');
        continue;
      }
      active.push(bullet);
    }
    this.bullets = active;
  }

  currentStorm(now = this.now()) {
    if (!this.storm) return null;
    if (this.storm.phase === 'holding') return { ...this.storm.to, phase: 'holding', cycle: this.storm.cycle, progress: 1 };
    const progress = clamp((now - this.storm.phaseStartedAt) / CONFIG.storm.contractionMs, 0, 1);
    return {
      x: this.storm.from.x + (this.storm.to.x - this.storm.from.x) * progress,
      y: this.storm.from.y + (this.storm.to.y - this.storm.from.y) * progress,
      radius: this.storm.from.radius + (this.storm.to.radius - this.storm.from.radius) * progress,
      phase: 'contracting',
      cycle: this.storm.cycle,
      progress,
    };
  }

  updateStorm(now) {
    if (this.storm.phase === 'contracting' && now - this.storm.phaseStartedAt >= CONFIG.storm.contractionMs) {
      this.storm.phase = 'holding';
      this.storm.phaseStartedAt = now;
    } else if (this.storm.phase === 'holding' && now - this.storm.phaseStartedAt >= CONFIG.storm.holdMs) {
      this.storm.from = { ...this.storm.to };
      this.storm.to = this.nextStormTarget(this.storm.from);
      this.storm.phase = 'contracting';
      this.storm.phaseStartedAt = now;
      this.storm.cycle += 1;
    }
  }

  applyStormDamage(player, deltaSeconds, now) {
    const storm = this.currentStorm(now);
    if (distanceSquared(player, storm) <= storm.radius * storm.radius) {
      player.stormDamageCarry = 0;
      return;
    }
    player.stormDamageCarry += CONFIG.storm.damagePerSecond * deltaSeconds;
    const wholeDamage = Math.floor(player.stormDamageCarry);
    if (wholeDamage > 0) {
      player.stormDamageCarry -= wholeDamage;
      this.damage(player, wholeDamage, null, 'storm');
    }
  }

  damage(player, amount, attackerId, cause) {
    if (!player.alive) return;
    player.hp -= amount;
    this.events.push({ type: 'damage', playerId: player.id, attackerId, amount, cause });
    if (player.hp <= 0) this.eliminate(player, attackerId, cause);
  }

  eliminate(player, killerId, cause) {
    player.hp = 0;
    player.alive = false;
    player.killerId = killerId;
    player.spectatorTargetId = this.validSpectatorTarget(killerId, player.id) ?? this.randomLivingPlayerId(player.id);
    this.transferSpectators(player.id, player.spectatorTargetId);
    this.events.push({ type: 'eliminated', playerId: player.id, killerId, cause });
  }

  validSpectatorTarget(id, excludedId) {
    const candidate = this.players.get(id);
    return candidate?.alive && candidate.id !== excludedId ? candidate.id : null;
  }

  randomLivingPlayerId(excludedId = null) {
    const living = [...this.players.values()].filter((player) => player.alive && player.id !== excludedId);
    return living.length ? living[Math.floor(this.random() * living.length)].id : null;
  }

  transferSpectators(oldTargetId, preferredTargetId) {
    const next = this.validSpectatorTarget(preferredTargetId, oldTargetId) ?? this.randomLivingPlayerId(oldTargetId);
    for (const player of this.players.values()) {
      if (!player.alive && player.spectatorTargetId === oldTargetId) player.spectatorTargetId = next;
    }
  }

  checkWinner(now) {
    if (this.startedWith < 2) return;
    const living = [...this.players.values()].filter((player) => player.alive);
    if (living.length > 1) return;
    this.phase = 'ended';
    this.winnerId = living[0]?.id ?? null;
    this.endedAt = now;
    this.events.push({ type: 'match_ended', winnerId: this.winnerId });
  }

  matchStartedMessage() {
    return {
      type: 'match_started',
      map: this.map,
      storm: this.currentStorm(),
    };
  }

  snapshot() {
    const now = this.now();
    const events = this.events.splice(0);
    return {
      type: 'snapshot',
      serverTime: now,
      roomCode: this.code,
      phase: this.phase,
      hostId: this.hostId,
      winnerId: this.winnerId,
      players: [...this.players.values()].map((player) => publicPlayer(player, now)),
      pickups: this.map?.pickups ?? [],
      // Velocity travels with each bullet so clients can slide it between
      // updates; at 920 u/s it would otherwise jump a body-length per snapshot.
      bullets: this.bullets.map(({ id, x, y, vx, vy }) => ({
        id, x: Math.round(x), y: Math.round(y), vx: Math.round(vx), vy: Math.round(vy),
      })),
      storm: this.currentStorm(now),
      events,
    };
  }

  lobbyState() {
    return {
      type: 'lobby',
      roomCode: this.code,
      hostId: this.hostId,
      phase: this.phase,
      players: [...this.players.values()].map((player) => ({ id: player.id, name: player.name, connected: player.connected })),
    };
  }
}

export class GameManager {
  constructor() {
    this.rooms = new Map();
  }

  createRoom(playerId, name) {
    let code;
    do code = this.createRoomCode(); while (this.rooms.has(code));
    const room = new Room(code, playerId);
    room.addPlayer(playerId, name);
    this.rooms.set(code, room);
    return room;
  }

  joinRoom(code, playerId, name) {
    const room = this.rooms.get(String(code ?? '').trim().toUpperCase());
    if (!room) throw new Error('Room not found. Check the room code.');
    if (room.players.size >= CONFIG.maxRoomPlayers) throw new Error('This room is at the tested safety limit.');
    room.addPlayer(playerId, name);
    return room;
  }

  createRoomCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length: 5 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  }

  tick(deltaSeconds) {
    for (const room of this.rooms.values()) room.tick(deltaSeconds);
  }

  prune() {
    for (const [code, room] of this.rooms) {
      if ([...room.players.values()].every((player) => !player.connected)) this.rooms.delete(code);
    }
  }
}
