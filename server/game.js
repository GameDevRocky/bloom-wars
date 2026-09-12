import crypto from 'node:crypto';
import { CONFIG } from './config.js';
import { clamp, distanceSquared, pointInsideRect, resolveCircleRect } from './geometry.js';
import { generateMap, validateMap } from './map.js';
import { createRandom, randomBetween } from './random.js';

const EMPTY_INPUT = Object.freeze({ up: false, down: false, left: false, right: false, firing: false, aim: 0 });

function cleanName(value) {
  const result = String(value ?? '').trim().replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 18);
  return result || 'Gardener';
}

function publicPlayer(player, now) {
  return {
    id: player.id,
    name: player.name,
    x: Math.round(player.x * 10) / 10,
    y: Math.round(player.y * 10) / 10,
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
      hp: CONFIG.maxHp,
      alive: !lateJoin,
      connected,
      input: { ...EMPTY_INPUT },
      lastInputSequence: 0,
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
      hp: CONFIG.maxHp,
      alive: true,
      input: { ...EMPTY_INPUT },
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

  receiveInput(playerId, input) {
    const player = this.players.get(playerId);
    if (!player || !player.alive || this.phase !== 'playing') return;
    const sequence = Number(input.sequence) || 0;
    if (sequence < player.lastInputSequence) return;
    player.lastInputSequence = sequence;
    player.input = {
      up: Boolean(input.up),
      down: Boolean(input.down),
      left: Boolean(input.left),
      right: Boolean(input.right),
      firing: Boolean(input.firing),
      aim: Number.isFinite(input.aim) ? input.aim : player.input.aim,
    };
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
      this.movePlayer(player, deltaSeconds);
      this.collectPickups(player, now);
      if (player.input.firing) this.fire(player, now);
      this.applyStormDamage(player, deltaSeconds, now);
    }
    this.updateBullets(deltaSeconds, now);
    this.checkWinner(now);
  }

  movePlayer(player, deltaSeconds) {
    let dx = Number(player.input.right) - Number(player.input.left);
    let dy = Number(player.input.down) - Number(player.input.up);
    const magnitude = Math.hypot(dx, dy) || 1;
    dx /= magnitude;
    dy /= magnitude;
    let position = {
      x: clamp(player.x + dx * CONFIG.playerSpeed * deltaSeconds, CONFIG.playerRadius, this.map.width - CONFIG.playerRadius),
      y: clamp(player.y + dy * CONFIG.playerSpeed * deltaSeconds, CONFIG.playerRadius, this.map.height - CONFIG.playerRadius),
    };
    for (const obstacle of this.map.obstacles) {
      position = resolveCircleRect(position, CONFIG.playerRadius, obstacle);
    }
    player.x = clamp(position.x, CONFIG.playerRadius, this.map.width - CONFIG.playerRadius);
    player.y = clamp(position.y, CONFIG.playerRadius, this.map.height - CONFIG.playerRadius);
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
      bullets: this.bullets.map(({ id, x, y }) => ({ id, x, y })),
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
