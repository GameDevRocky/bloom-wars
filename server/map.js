import { CONFIG } from './config.js';
import { circleIntersectsRect, distanceSquared, pointInsideRect } from './geometry.js';
import { createRandom, randomBetween, shuffle } from './random.js';
import { ObstacleGrid } from '../public/shared/obstacle-grid.js';

function candidateIsClear(candidate, obstacles, reserved, padding = 18) {
  const circle = { ...candidate, radius: candidate.radius ?? padding };
  return !obstacles.some((obstacle) => circleIntersectsRect(circle, obstacle, padding))
    && !reserved.some((point) => distanceSquared(candidate, point) < (point.radius + circle.radius + padding) ** 2);
}

// One column of starting positions per team, set against opposite edges and
// spread down the map. `side` is -1 for the left (blue) and 1 for the right
// (red). Columns are returned in order so each team's roster maps onto its own.
function createTeamSpawns(size, count, random, side) {
  if (count === 0) return [];
  const inset = size * CONFIG.map.teamSpawnInset;
  const x = side < 0 ? inset : size - inset;
  const spread = size * CONFIG.map.teamSpawnSpread;
  const top = (size - spread) / 2;
  return Array.from({ length: count }, (_, index) => ({
    // A single player starts mid-column rather than at its top.
    x: Math.round(x + (random() - 0.5) * size * 0.05),
    y: Math.round(top + (count === 1 ? spread / 2 : (index / (count - 1)) * spread)),
    radius: CONFIG.map.spawnClearance,
  }));
}

function insideGuaranteedCorridor(candidate, size, padding) {
  const center = size / 2;
  const half = CONFIG.map.corridorHalfWidth + padding;
  return Math.abs(candidate.x - center) < half || Math.abs(candidate.y - center) < half;
}

// A coarse bucket index over already-placed items, so each new candidate is
// only compared against its neighbours. Placement is otherwise quadratic, which
// an evenly populated arena of tens of thousands of obstacles cannot afford.
function createIndex(cellSize) {
  const cells = new Map();
  const key = (x, y) => `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`;
  return {
    add(item, x, y) {
      const bucket = cells.get(key(x, y));
      if (bucket) bucket.push(item);
      else cells.set(key(x, y), [item]);
    },
    near(x, y, reach = cellSize) {
      const found = [];
      const span = Math.ceil(reach / cellSize);
      const cx = Math.floor(x / cellSize);
      const cy = Math.floor(y / cellSize);
      for (let dy = -span; dy <= span; dy += 1) {
        for (let dx = -span; dx <= span; dx += 1) {
          const bucket = cells.get(`${cx + dx}:${cy + dy}`);
          if (bucket) found.push(...bucket);
        }
      }
      return found;
    },
  };
}

function placeObstacles(size, count, random, spawns, obstacles = [], protectedRegion = null) {
  const index = createIndex(180);
  for (const existing of obstacles) index.add(existing, existing.x, existing.y);
  const spawnIndex = createIndex(400);
  for (const spawn of spawns) spawnIndex.add(spawn, spawn.x, spawn.y);

  let attempts = 0;
  while (obstacles.length < count && attempts < count * 40) {
    attempts += 1;
    // Whole units throughout: cover is metres across, so fractional positions
    // buy nothing and each one costs a dozen characters in a map message that
    // now carries thousands of obstacles.
    const width = Math.round(randomBetween(random, 45, 125));
    const height = Math.round(randomBetween(random, 38, 105));
    const obstacle = {
      id: `o${obstacles.length}`,
      kind: random() < 0.58 ? 'hedge' : random() < 0.7 ? 'rock' : 'wall',
      x: Math.round(randomBetween(random, 55, size - width - 55)),
      y: Math.round(randomBetween(random, 55, size - height - 55)),
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
    if (spawnIndex.near(obstacle.x, obstacle.y, 500).some((spawn) => circleIntersectsRect(spawn, obstacle, 35))) continue;
    if (index.near(obstacle.x, obstacle.y, 300).some((existing) => (
      obstacle.x < existing.x + existing.width + 24
      && obstacle.x + obstacle.width + 24 > existing.x
      && obstacle.y < existing.y + existing.height + 24
      && obstacle.y + obstacle.height + 24 > existing.y
    ))) continue;
    obstacles.push(obstacle);
    index.add(obstacle, obstacle.x, obstacle.y);
  }
  return obstacles;
}

function placePickups(size, random, obstacleGrid, reservedIndex, kind, count, startIndex) {
  const pickups = [];
  let attempts = 0;
  while (pickups.length < count && attempts < count * 60) {
    attempts += 1;
    const candidate = {
      id: `p${startIndex + pickups.length}`,
      kind,
      x: Math.round(randomBetween(random, 45, size - 45)),
      y: Math.round(randomBetween(random, 45, size - 45)),
      radius: 15,
    };
    const nearbyObstacles = obstacleGrid.collectAround(candidate, 180);
    const reserved = reservedIndex.near(candidate.x, candidate.y, 400);
    if (!candidateIsClear(candidate, nearbyObstacles, reserved, 16)) continue;
    pickups.push(candidate);
    reservedIndex.add(candidate, candidate.x, candidate.y);
  }
  return pickups;
}

export function generateMap(playerCount, seed = `${Date.now()}`) {
  const count = Math.max(1, Math.min(CONFIG.maxRoomPlayers, playerCount));
  const random = createRandom(seed);
  const size = Math.round(CONFIG.map.minimumSize + Math.max(0, count - 4) * CONFIG.map.sizePerExtraPlayer);
  // Enough starting positions on each side for the whole room, so any team
  // split can be seated without regenerating the map.
  const teamSpawns = {
    blue: createTeamSpawns(size, count, random, CONFIG.teams.blue.side),
    red: createTeamSpawns(size, count, random, CONFIG.teams.red.side),
  };
  const spawns = [...teamSpawns.blue, ...teamSpawns.red];

  // Counts scale with area, not with the world's linear expansion. Scaling
  // linearly is what left the arena with a crowded middle and bare outskirts:
  // a 20x wider world holds 400x the space, so 20x the cover spread over it is
  // twenty times thinner than the centre it was tuned for.
  const areaInMillions = (size * size) / 1_000_000;
  const obstacleTarget = Math.min(
    CONFIG.map.maxObstacles,
    Math.round(areaInMillions * CONFIG.map.obstaclesPerMillion),
  );
  const obstacles = placeObstacles(size, obstacleTarget, random, spawns);
  const obstacleGrid = new ObstacleGrid(obstacles, size, size);

  const reserved = createIndex(400);
  for (const spawn of spawns) reserved.add(spawn, spawn.x, spawn.y);
  const perMillion = CONFIG.map.pickupsPerMillion;
  const perPlayer = CONFIG.map.pickupsPerPlayer;
  const floors = CONFIG.map.pickupFloor;
  const totalDensity = perMillion.rifle + perMillion.ammo + perMillion.seed;
  const pickupBudget = Math.min(CONFIG.map.maxPickups, Math.round(areaInMillions * totalDensity));
  let pickups = [];
  // Rifles are deliberately absent: every player spawns with one and there is
  // no way to lose it, so a rifle on the ground could never be picked up and
  // would only be scenery in the way of the loot that matters.
  for (const [kind, density, floor] of [
    ['ammo', perMillion.ammo, Math.max(count * perPlayer.ammo, floors.ammo)],
    ['seed', perMillion.seed, Math.max(count * perPlayer.seed, floors.seed)],
  ]) {
    // Each kind keeps its share of the budget, so capping thins the loot table
    // evenly instead of starving whichever kind is placed last.
    const target = Math.max(floor, Math.round(pickupBudget * (density / totalDensity)));
    pickups = pickups.concat(placePickups(size, random, obstacleGrid, reserved, kind, target, pickups.length));
  }

  return {
    seed: String(seed),
    width: size,
    height: size,
    obstacles,
    pickups,
    spawns: spawns.map(({ x, y }) => ({ x, y })),
    teamSpawns: {
      blue: teamSpawns.blue.map(({ x, y }) => ({ x, y })),
      red: teamSpawns.red.map(({ x, y }) => ({ x, y })),
    },
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
