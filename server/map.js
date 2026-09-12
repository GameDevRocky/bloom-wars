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

function placeObstacles(size, count, random, spawns) {
  const obstacles = [];
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
  const spawns = createSpawns(size, count, random);
  const obstacleTarget = CONFIG.map.obstacleBase + count * CONFIG.map.obstaclesPerPlayer;
  const obstacles = placeObstacles(size, obstacleTarget, random, spawns);
  let pickups = placePickups(size, random, obstacles, spawns, 'rifle', Math.max(count, 4), 0);
  pickups = pickups.concat(placePickups(size, random, obstacles, [...spawns, ...pickups], 'ammo', Math.max(count * 2, 8), pickups.length));
  pickups = pickups.concat(placePickups(size, random, obstacles, [...spawns, ...pickups], 'seed', Math.max(count, 6), pickups.length));
  return {
    seed: String(seed),
    width: size,
    height: size,
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

