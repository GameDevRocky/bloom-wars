import { CONFIG } from './config.js';
import { circleIntersectsRect, distanceSquared, pointInsideRect } from './geometry.js';
import { createRandom, randomBetween, shuffle } from './random.js';

function candidateIsClear(candidate, obstacles, reserved, padding = 18) {
  const circle = { ...candidate, radius: candidate.radius ?? padding };
  return !obstacles.some((obstacle) => circleIntersectsRect(circle, obstacle, padding))
    && !reserved.some((point) => distanceSquared(candidate, point) < (point.radius + circle.radius + padding) ** 2);
}

function createSpawns(size, count, random) {
  const center = size / 2;
  const ringRadius = Math.min(size * 0.36, 360 + count * 24);
  const startAngle = random() * Math.PI * 2;
  return shuffle(random, Array.from({ length: count }, (_, index) => {
    const angle = startAngle + (index / count) * Math.PI * 2;
    return {
      x: center + Math.cos(angle) * ringRadius,
      y: center + Math.sin(angle) * ringRadius,
      radius: CONFIG.map.spawnClearance,
    };
  }));
}

function insideGuaranteedCorridor(candidate, size, padding) {
  const center = size / 2;
  const half = CONFIG.map.corridorHalfWidth + padding;
  return Math.abs(candidate.x - center) < half || Math.abs(candidate.y - center) < half;
}

function placeObstacles(size, count, random, spawns, obstacles = [], protectedRegion = null) {
  let attempts = 0;
  while (obstacles.length < count && attempts < count * 80) {
    attempts += 1;
    const width = randomBetween(random, 45, 125);
    const height = randomBetween(random, 38, 105);
    const obstacle = {
      id: `o${obstacles.length}`,
      kind: random() < 0.58 ? 'hedge' : random() < 0.7 ? 'rock' : 'wall',
      x: randomBetween(random, 55, size - width - 55),
      y: randomBetween(random, 55, size - height - 55),
      width,
      height,
    };
    const center = { x: obstacle.x + width / 2, y: obstacle.y + height / 2, radius: Math.hypot(width, height) / 2 };
    if (protectedRegion
      && obstacle.x < protectedRegion.x + protectedRegion.width + 24
      && obstacle.x + width + 24 > protectedRegion.x
      && obstacle.y < protectedRegion.y + protectedRegion.height + 24
      && obstacle.y + height + 24 > protectedRegion.y) continue;
    if (insideGuaranteedCorridor(center, size, center.radius)) continue;
    if (spawns.some((spawn) => circleIntersectsRect(spawn, obstacle, 35))) continue;
    if (obstacles.some((existing) => (
      obstacle.x < existing.x + existing.width + 24
      && obstacle.x + obstacle.width + 24 > existing.x
      && obstacle.y < existing.y + existing.height + 24
      && obstacle.y + obstacle.height + 24 > existing.y
    ))) continue;
    obstacles.push(obstacle);
  }
  return obstacles;
}

function placePickups(size, random, obstacles, spawns, kind, count, startIndex) {
  const pickups = [];
  let attempts = 0;
  while (pickups.length < count && attempts < count * 100) {
    attempts += 1;
    const candidate = {
      id: `p${startIndex + pickups.length}`,
      kind,
      x: randomBetween(random, 45, size - 45),
      y: randomBetween(random, 45, size - 45),
      radius: 15,
    };
    if (!candidateIsClear(candidate, obstacles, [...spawns, ...pickups], 16)) continue;
    pickups.push(candidate);
  }
  return pickups;
}

export function generateMap(playerCount, seed = `${Date.now()}`) {
  const count = Math.max(1, Math.min(CONFIG.maxRoomPlayers, playerCount));
  const random = createRandom(seed);
  const size = Math.round(CONFIG.map.minimumSize + Math.max(0, count - 4) * CONFIG.map.sizePerExtraPlayer);
  // Preserve the populated starting garden at normal gameplay scale. Simply
  // distributing its loot over the expanded world would put the first rifle
  // minutes away from unarmed players.
  const startingSize = size / CONFIG.map.worldScale;
  const offset = (size - startingSize) / 2;
  const translate = (item) => ({ ...item, x: item.x + offset, y: item.y + offset });
  const localSpawns = createSpawns(startingSize, count, random);
  const obstacleTarget = CONFIG.map.obstacleBase + count * CONFIG.map.obstaclesPerPlayer;
  const localObstacles = placeObstacles(startingSize, obstacleTarget, random, localSpawns);
  let localPickups = placePickups(startingSize, random, localObstacles, localSpawns, 'rifle', Math.max(count, 4), 0);
  localPickups = localPickups.concat(placePickups(startingSize, random, localObstacles, [...localSpawns, ...localPickups], 'ammo', Math.max(count * 4, 16), localPickups.length));
  localPickups = localPickups.concat(placePickups(startingSize, random, localObstacles, [...localSpawns, ...localPickups], 'seed', Math.max(count, 6), localPickups.length));
  const spawns = localSpawns.map(translate);
  const startingRegion = { x: offset, y: offset, width: startingSize, height: startingSize };
  // Additional outer cover stays bounded by population rather than exploding
  // with the world's 400-fold area. The protected central garden stays intact.
  const obstacles = placeObstacles(size, obstacleTarget * 6, random, spawns, localObstacles.map(translate), startingRegion);
  let pickups = localPickups.map(translate);
  for (const [kind, target] of [['rifle', Math.max(count, 4)], ['ammo', Math.max(count * 4, 16)], ['seed', Math.max(count, 6)]]) {
    pickups = pickups.concat(placePickups(size, random, obstacles, [...spawns, ...pickups], kind, target, pickups.length));
  }
  return {
    seed: String(seed),
    width: size,
    height: size,
    startingRegion,
    obstacles,
    pickups,
    spawns: spawns.map(({ x, y }) => ({ x, y })),
  };
}

export function validateMap(map) {
  const issues = [];
  for (const spawn of map.spawns) {
    if (map.obstacles.some((obstacle) => circleIntersectsRect({ ...spawn, radius: CONFIG.map.spawnClearance }, obstacle))) {
      issues.push('An obstacle overlaps a protected spawn radius.');
    }
  }
  for (const pickup of map.pickups) {
    if (map.obstacles.some((obstacle) => pointInsideRect(pickup, obstacle, pickup.radius))) {
      issues.push(`Pickup ${pickup.id} overlaps an obstacle.`);
    }
  }
  if (map.obstacles.some((obstacle) => insideGuaranteedCorridor(
    { x: obstacle.x + obstacle.width / 2, y: obstacle.y + obstacle.height / 2 },
    map.width,
    Math.min(obstacle.width, obstacle.height) / 2,
  ))) {
    issues.push('An obstacle blocks the guaranteed connected corridor.');
  }
  return { valid: issues.length === 0, issues };
}
