import crypto from 'node:crypto';
import { CONFIG } from './config.js';
import {
  circleIntersectsRect, clamp, distanceSquared, segmentBoundsExitTime,
  segmentCircleHitTime, sweptCircleRectHitTime,
} from './geometry.js';
import { generateMap, validateMap } from './map.js';
import { createRandom, randomBetween } from './random.js';
import { EMPTY_INPUT, readInput, stepPlayer } from '../public/shared/simulation.js';
import { obstacleGridFor } from '../public/shared/obstacle-grid.js';

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
    team: player.team,
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
    this.winningTeam = null;
    this.restartAt = null;
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
      // Seated on the smaller side straight away. Teams are reassigned when a
      // match starts, but leaving this unset would make everyone who has not
      // been assigned yet count as everyone else's teammate, and friendly fire
      // would quietly stop working between them.
      team: this.smallerTeam(),
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

  smallerTeam() {
    let blue = 0;
    let red = 0;
    for (const player of this.players.values()) {
      if (player.team === 'red') red += 1;
      else blue += 1;
    }
    return red < blue ? 'red' : 'blue';
  }

  // Splits the roster into two sides as evenly as possible, alternating so the
  // extra player on an odd roster is not always the same seat. Each player also
  // takes a skin from their team's palette, so who is friendly is readable at a
  // glance rather than only from a nameplate.
  assignTeams(roster) {
    const order = [...roster];
    for (let index = order.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(this.random() * (index + 1));
      [order[index], order[swap]] = [order[swap], order[index]];
    }
    const counts = { blue: 0, red: 0 };
    order.forEach((player, index) => {
      const team = index % 2 === 0 ? 'blue' : 'red';
      player.team = team;
      const palette = CONFIG.teams[team].skins;
      player.skin = palette[counts[team] % palette.length];
      counts[team] += 1;
    });
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
    if (roster.length < CONFIG.minRoomPlayers) {
      throw new Error(`At least ${CONFIG.minRoomPlayers} players are required to start.`);
    }

    const seed = this.seedFactory();
    const map = generateMap(roster.length, seed);
    const validation = validateMap(map);
    if (!validation.valid) throw new Error(`Generated map is invalid: ${validation.issues.join(' ')}`);
    this.map = map;
    this.bullets = [];
    this.events = [];
    this.nextAmmoDropAt = null;
    this.droppedPickups = 0;
    this.phase = 'playing';
    this.winnerId = null;
    this.winningTeam = null;
    this.restartAt = null;
    this.endedAt = null;
    this.startedWith = roster.length;
    this.random = createRandom(seed);
    const now = this.now();
    this.assignTeams(roster);
    const seated = { blue: 0, red: 0 };
    for (const player of roster) {
      const column = map.teamSpawns[player.team];
      const position = column[seated[player.team]] ?? column[column.length - 1];
      seated[player.team] += 1;
      this.resetPlayer(player, position, now);
    }
    // The opening circle has to reach the arena's corners, not just its edges:
    // teams start against opposite sides, and the furthest of those positions
    // sat outside a circle inscribed in the map, so a player could begin a
    // match already taking storm damage.
    const centre = { x: map.width / 2, y: map.height / 2 };
    const halfDiagonal = Math.hypot(map.width, map.height) / 2;
    this.storm = {
      phase: 'contracting',
      phaseStartedAt: now,
      from: { ...centre, radius: halfDiagonal * CONFIG.storm.openingMargin },
      to: null,
      cycle: 1,
    };
    // Measured from the inscribed circle rather than that oversized opening, so
    // the first contraction still finishes where it always did. Sizing it off
    // the opening instead would spend a whole cycle shrinking through corners
    // nobody is standing in.
    this.storm.to = this.nextStormTarget({ ...centre, radius: map.width * 0.49 });
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
    return this.startReload(player, now, 'manual');
  }

  startReload(player, now, reason = 'automatic') {
    if (!player?.alive || !player.hasRifle || player.reloadEndsAt > now) return false;
    if (player.magazine >= CONFIG.rifle.magazineSize || player.reserveAmmo <= 0) return false;
    player.reloadEndsAt = now + CONFIG.rifle.reloadMs;
    this.events.push({ type: 'reload_started', playerId: player.id, reason });
    return true;
  }

  requestFire(playerId, raw = {}) {
    const player = this.players.get(playerId);
    if (!player?.alive || this.phase !== 'playing') return 'unavailable';
    const requestedAim = Number(raw.aim);
    const aim = Number.isFinite(requestedAim)
      ? Math.atan2(Math.sin(requestedAim), Math.cos(requestedAim))
      : player.input.aim;
    player.input = { ...player.input, aim };
    const clientShotId = typeof raw.shotId === 'string' ? raw.shotId.slice(0, 80) : null;
    return this.fire(player, this.now(), { aim, clientShotId });
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
    const playerStarts = new Map([...this.players.values()].map((player) => [
      player.id, { x: player.x, y: player.y },
    ]));
    this.updateStorm(now);
    for (const player of this.players.values()) {
      if (!player.alive) continue;
      this.finishReload(player, now);
      this.consumeInputs(player, now);
      this.collectPickups(player, now);
      this.applyStormDamage(player, deltaSeconds, now);
    }
    this.updateBullets(deltaSeconds, now, playerStarts);
    this.dropAmmo(now);
    this.checkWinner(now);
  }

  // Tops the arena back up with ammunition while a match runs. Starting loot is
  // finite and a drawn-out match spends it; survivors who cannot shoot each
  // other leave the storm to settle the match, which is not much of a fight.
  dropAmmo(now) {
    this.nextAmmoDropAt ||= now + CONFIG.ammoDrop.intervalMs;
    if (now < this.nextAmmoDropAt) return;
    this.nextAmmoDropAt = now + CONFIG.ammoDrop.intervalMs;

    const living = [...this.players.values()].filter((player) => player.alive).length;
    if (living === 0) return;
    const wanted = living * CONFIG.ammoDrop.perLivingPlayer;
    const available = this.map.pickups.reduce((total, pickup) => total + (pickup.kind === 'ammo' ? 1 : 0), 0);
    if (available >= wanted) return;

    const pickup = this.findAmmoDropSite();
    if (!pickup) return;
    this.map.pickups.push(pickup);
    // Clients hold the loot list themselves and prune it from pickup events, so
    // an arrival has to be announced the same way a collection is.
    this.events.push({ type: 'pickup_spawned', pickup });
  }

  findAmmoDropSite() {
    // Aim at where the zone is heading rather than where it is. A drop placed
    // against the present edge is swallowed by the storm within a cycle, so it
    // would spend its life somewhere nobody can safely go.
    const storm = this.storm.to ?? this.currentStorm();
    const grid = obstacleGridFor(this.map);
    const radius = 15;
    for (let attempt = 0; attempt < CONFIG.ammoDrop.placementAttempts; attempt += 1) {
      // Square-rooting the random radius spreads drops evenly over the circle
      // rather than bunching them around the middle.
      const angle = this.random() * Math.PI * 2;
      const distance = Math.sqrt(this.random()) * storm.radius * CONFIG.ammoDrop.zoneFraction;
      const candidate = {
        id: `d${this.droppedPickups = (this.droppedPickups ?? 0) + 1}`,
        kind: 'ammo',
        x: Math.round(clamp(storm.x + Math.cos(angle) * distance, 45, this.map.width - 45)),
        y: Math.round(clamp(storm.y + Math.sin(angle) * distance, 45, this.map.height - 45)),
        radius,
      };
      const blocked = grid.collectAround(candidate, 120)
        .some((obstacle) => circleIntersectsRect(candidate, obstacle, 16));
      if (blocked) continue;
      // Landing on top of someone would hand them a free magazine.
      const onPlayer = [...this.players.values()].some((player) => player.alive
        && distanceSquared(player, candidate) < (CONFIG.playerRadius + radius + 30) ** 2);
      if (onPlayer) continue;
      return candidate;
    }
    return null;
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
        if (player.magazine === 0) this.startReload(player, now, 'ammo_pickup');
      } else if (pickup.kind === 'seed' && player.flowerCollectedAt === null) {
        player.flowerCollectedAt = now;
      } else {
        continue;
      }
      collected.push(pickup.id);
      this.events.push({ type: 'pickup', playerId: player.id, kind: pickup.kind, pickupId: pickup.id });
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

  fire(player, now, { aim = player.input.aim, clientShotId = null } = {}) {
    if (!player.hasRifle) return 'unarmed';
    if (player.reloadEndsAt > now) return 'reloading';
    if (player.magazine <= 0) {
      this.events.push({ type: 'empty_fire', playerId: player.id, clientShotId });
      this.startReload(player, now, 'empty');
      return 'empty';
    }
    if (now - player.lastShotAt < CONFIG.rifle.fireIntervalMs) return 'cooldown';
    player.lastShotAt = now;
    player.magazine -= 1;
    const direction = aim + randomBetween(this.random, -CONFIG.rifle.spreadRadians, CONFIG.rifle.spreadRadians);
    const forward = CONFIG.rifle.muzzleForward;
    const side = CONFIG.rifle.muzzleSide;
    const bullet = {
      id: crypto.randomUUID(),
      ownerId: player.id,
      x: player.x + Math.cos(aim) * forward - Math.sin(aim) * side,
      y: player.y + Math.sin(aim) * forward + Math.cos(aim) * side,
      vx: Math.cos(direction) * CONFIG.rifle.bulletSpeed,
      vy: Math.sin(direction) * CONFIG.rifle.bulletSpeed,
      spawnedAt: now,
      simulatedAt: now,
      clientShotId,
    };
    // The barrel can protrude through cover while the body is against it.
    // Trace from the body to the muzzle so those shots hit that cover first.
    const obstruction = this.firstBulletHit(player, bullet, bullet.ownerId);
    if (obstruction) {
      bullet.x = player.x + (bullet.x - player.x) * obstruction.time;
      bullet.y = player.y + (bullet.y - player.y) * obstruction.time;
    }
    this.events.push({
      type: 'shot', bulletId: bullet.id, playerId: player.id, ownerId: player.id,
      clientShotId, x: bullet.x, y: bullet.y, vx: bullet.vx, vy: bullet.vy, spawnedAt: now,
    });
    if (obstruction) this.impactBullet(bullet, obstruction, now);
    else this.bullets.push(bullet);
    if (player.magazine === 0) this.startReload(player, now, 'empty_magazine');
    return 'fired';
  }

  firstBulletHit(start, end, ownerId, playerStarts = null, startFraction = 0) {
    let nearest = null;
    const consider = (time, hit, playerId) => {
      if (time !== null && (!nearest || time < nearest.time)) nearest = { time, hit, playerId };
    };
    const radius = CONFIG.rifle.bulletRadius;
    consider(segmentBoundsExitTime(start, end, this.map.width, this.map.height, radius), 'bounds');
    obstacleGridFor(this.map).forEachAlong(start, end, radius, (obstacle) => {
      consider(sweptCircleRectHitTime(start, end, radius, obstacle), 'wall');
    });
    const owner = ownerId ? this.players.get(ownerId) : null;
    for (const player of this.players.values()) {
      if (!player.alive || player.id === ownerId) continue;
      // Shots pass through teammates rather than stopping harmlessly in them,
      // which would otherwise let a team wall off a corridor with their bodies.
      if (owner && player.team === owner.team) continue;
      const previous = playerStarts?.get(player.id) ?? player;
      const playerStart = {
        x: previous.x + (player.x - previous.x) * startFraction,
        y: previous.y + (player.y - previous.y) * startFraction,
      };
      // Sweep in the moving player's frame of reference. A player crossing
      // the path between ticks can be hit even if both endpoints are clear.
      const relativeStart = { x: start.x - playerStart.x, y: start.y - playerStart.y };
      const relativeEnd = { x: end.x - player.x, y: end.y - player.y };
      consider(segmentCircleHitTime(relativeStart, relativeEnd, {
        x: 0, y: 0, radius: CONFIG.playerRadius + radius,
      }), 'player', player.id);
    }
    return nearest;
  }

  impactBullet(bullet, collision, now) {
    this.events.push({
      type: 'bullet_impact', bulletId: bullet.id, ownerId: bullet.ownerId,
      x: bullet.x, y: bullet.y, vx: bullet.vx, vy: bullet.vy,
      hit: collision.hit, playerId: collision.playerId, impactedAt: now,
    });
    if (collision.hit === 'player') {
      this.damage(this.players.get(collision.playerId), CONFIG.rifle.damage, bullet.ownerId, 'rifle');
    }
  }

  updateBullets(deltaSeconds, now, playerStarts = null) {
    const active = [];
    for (const bullet of this.bullets) {
      // A shot created at the end of this tick starts at the muzzle; it must
      // not get a full tick of travel before its published spawn timestamp.
      const elapsed = bullet.simulatedAt === undefined ? deltaSeconds : (now - bullet.simulatedAt) / 1_000;
      const step = Math.max(0, Math.min(deltaSeconds, elapsed));
      const end = { x: bullet.x + bullet.vx * step, y: bullet.y + bullet.vy * step };
      const startFraction = deltaSeconds > 0 ? 1 - step / deltaSeconds : 1;
      const collision = this.firstBulletHit(bullet, end, bullet.ownerId, playerStarts, startFraction);
      if (collision) {
        bullet.x += (end.x - bullet.x) * collision.time;
        bullet.y += (end.y - bullet.y) * collision.time;
        this.impactBullet(bullet, collision, now - step * 1_000 * (1 - collision.time));
        continue;
      }
      bullet.x = end.x;
      bullet.y = end.y;
      bullet.simulatedAt = now;
      active.push(bullet);
    }
    this.bullets = active;
  }

  stormContractionDuration() {
    const { from, to } = this.storm;
    // The fastest side moves by the radius loss plus the center's travel.
    // Allow time to outrun that edge, even on the largest population map.
    const boundaryTravel = Math.max(0, from.radius - to.radius)
      + Math.hypot(to.x - from.x, to.y - from.y);
    return Math.max(CONFIG.storm.contractionMs, Math.ceil(
      boundaryTravel / (CONFIG.playerSpeed * CONFIG.storm.maxBoundarySpeedRatio) * 1_000,
    ));
  }

  currentStorm(now = this.now()) {
    if (!this.storm) return null;
    if (this.storm.phase === 'holding') return {
      ...this.storm.to, phase: 'holding', cycle: this.storm.cycle,
      progress: 1, durationMs: CONFIG.storm.holdMs,
    };
    const durationMs = this.stormContractionDuration();
    const progress = clamp((now - this.storm.phaseStartedAt) / durationMs, 0, 1);
    return {
      x: this.storm.from.x + (this.storm.to.x - this.storm.from.x) * progress,
      y: this.storm.from.y + (this.storm.to.y - this.storm.from.y) * progress,
      radius: this.storm.from.radius + (this.storm.to.radius - this.storm.from.radius) * progress,
      phase: 'contracting',
      cycle: this.storm.cycle,
      progress,
      durationMs,
    };
  }

  updateStorm(now) {
    if (this.storm.phase === 'contracting' && now - this.storm.phaseStartedAt >= this.stormContractionDuration()) {
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
    // Teammates cannot hurt each other. The storm has no attacker, so it is
    // unaffected by this.
    const attacker = attackerId ? this.players.get(attackerId) : null;
    if (attacker && attacker.id !== player.id && attacker.team === player.team) return;
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

  // A side wins by being the only one left standing, so a match ends when one
  // team is wiped out rather than when a single player remains.
  checkWinner(now) {
    if (this.startedWith < CONFIG.minRoomPlayers) return;
    const living = [...this.players.values()].filter((player) => player.alive);
    const standing = new Set(living.map((player) => player.team));
    if (standing.size > 1) return;
    this.phase = 'ended';
    this.winningTeam = [...standing][0] ?? null;
    // Kept for the scoreboard and spectator chain: the last player upright.
    this.winnerId = living[0]?.id ?? null;
    this.endedAt = now;
    this.restartAt = now + CONFIG.restartDelayMs;
    this.events.push({
      type: 'match_ended',
      winnerId: this.winnerId,
      winningTeam: this.winningTeam,
      winningTeam: this.winningTeam,
      restartInMs: CONFIG.restartDelayMs,
    });
  }

  // Rooms start the next match on their own, so a lobby does not stall waiting
  // on a host who has already closed the tab.
  restartIfDue(now) {
    if (this.phase !== 'ended' || this.restartAt === null || now < this.restartAt) return null;
    this.restartAt = null;
    const roster = [...this.players.values()].filter((player) => player.connected);
    if (roster.length < CONFIG.minRoomPlayers) {
      // Not enough players to run another match; fall back to the lobby so the
      // room is still usable when someone else arrives.
      this.phase = 'lobby';
      this.winnerId = null;
      this.winningTeam = null;
      return { type: 'lobby_returned', ...this.lobbyState() };
    }
    // The host may have left during the result screen.
    if (!this.players.get(this.hostId)?.connected) this.hostId = roster[0].id;
    return this.start(this.hostId);
  }

  matchStartedMessage() {
    return {
      type: 'match_started',
      map: this.map,
      storm: this.currentStorm(),
    };
  }

  snapshot({ includeEvents = true } = {}) {
    const now = this.now();
    // A single-client initial state must not drain events owed to the room.
    // It receives the next broadcast's events together with everyone else.
    const events = includeEvents ? this.events.splice(0) : [];
    return {
      type: 'snapshot',
      serverTime: now,
      roomCode: this.code,
      phase: this.phase,
      hostId: this.hostId,
      winnerId: this.winnerId,
      winningTeam: this.winningTeam,
      players: [...this.players.values()].map((player) => publicPlayer(player, now)),
      // Loot is static and numerous, so it is sent once with the map and then
      // maintained from `pickup` events. Repeating thousands of unchanged items
      // in every snapshot costs more bandwidth than everything else combined.
      pickupCount: this.map?.pickups.length ?? 0,
      // Velocity travels with each bullet so clients can slide it between
      // updates; at 920 u/s it would otherwise jump a body-length per snapshot.
      bullets: this.bullets.map(({ id, ownerId, clientShotId, x, y, vx, vy, spawnedAt, simulatedAt }) => ({
        id, ownerId, clientShotId, spawnedAt, updatedAt: simulatedAt,
        x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, vx, vy,
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
      hostName: this.players.get(this.hostId)?.name ?? null,
      minPlayers: CONFIG.minRoomPlayers,
      players: [...this.players.values()].map((player) => ({
        id: player.id, name: player.name, connected: player.connected, team: player.team ?? null,
      })),
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

  // Open rooms a player could join, newest first. Only the details the welcome
  // screen shows, so this stays cheap to send on every refresh.
  roomListing() {
    const rooms = [...this.rooms.values()]
      .filter((room) => [...room.players.values()].some((player) => player.connected))
      .filter((room) => room.players.size < CONFIG.maxRoomPlayers)
      .map((room) => ({
        code: room.code,
        hostName: room.players.get(room.hostId)?.name ?? 'Gardener',
        players: [...room.players.values()].filter((player) => player.connected).length,
        capacity: CONFIG.maxRoomPlayers,
        phase: room.phase,
      }))
      .sort((a, b) => b.players - a.players)
      .slice(0, 20);
    return { type: 'room_list', rooms };
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
