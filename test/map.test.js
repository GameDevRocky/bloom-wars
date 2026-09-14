import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMap, validateMap } from '../server/map.js';

test('map generation is deterministic for one seed', () => {
  assert.deepEqual(generateMap(8, 'same-seed'), generateMap(8, 'same-seed'));
});

test('maps scale with population and preserve valid spawn routes', () => {
  const small = generateMap(2, 'small');
  const large = generateMap(24, 'large');
  assert.ok(large.width > small.width);
  assert.ok(large.obstacles.length > small.obstacles.length);
  assert.equal(small.spawns.length, 2);
  assert.equal(large.spawns.length, 24);
  assert.deepEqual(validateMap(small), { valid: true, issues: [] });
  assert.deepEqual(validateMap(large), { valid: true, issues: [] });
});

test('generated loot covers rifles, ammunition, and seeds', () => {
  const map = generateMap(6, 'loot');
  for (const kind of ['rifle', 'ammo', 'seed']) {
    assert.ok(map.pickups.filter((pickup) => pickup.kind === kind).length >= 6);
  }
});

// The arena used to be built as a dense central garden plus a thin scatter
// outside it, which left the middle twenty times richer in cover than the edges
// and the outskirts all but empty of loot. Density is now per unit of area, so
// it has to hold up wherever you are on the map.
test('cover and loot are spread evenly across the whole arena', () => {
  for (const count of [1, 8, 64]) {
    const map = generateMap(count, `even-${count}`);
    const previousSize = 1_550 + Math.max(0, count - 4) * 115;
    assert.equal(map.width, previousSize * 20);

    const tiles = 4;
    const tileSize = map.width / tiles;
    const tileArea = (tileSize * tileSize) / 1_000_000;
    const densities = (items) => {
      const grid = Array.from({ length: tiles * tiles }, () => 0);
      for (const item of items) {
        const column = Math.min(tiles - 1, Math.floor(item.x / tileSize));
        const row = Math.min(tiles - 1, Math.floor(item.y / tileSize));
        grid[row * tiles + column] += 1;
      }
      return grid.map((n) => n / tileArea);
    };

    for (const [label, items, spread] of [
      ['obstacles', map.obstacles, 2],
      ['pickups', map.pickups, 4],
    ]) {
      const density = densities(items);
      const low = Math.min(...density);
      const high = Math.max(...density);
      assert.ok(low > 0, `${label}: every region of the map must be populated`);
      assert.ok(high / low < spread,
        `${label}: densest region is ${(high / low).toFixed(1)}x the sparsest (${density.map((d) => d.toFixed(2))})`);
    }
    assert.deepEqual(validateMap(map), { valid: true, issues: [] });
  }
});

test('map scales its contents with area rather than with width', () => {
  // Both of these sit under the population cap, where density is the only
  // thing deciding the count.
  const small = generateMap(1, 'area-small');
  const large = generateMap(8, 'area-large');
  const areaRatio = (large.width * large.width) / (small.width * small.width);
  const obstacleRatio = large.obstacles.length / small.obstacles.length;
  // Counts follow area closely; placement rejections keep it from being exact.
  assert.ok(Math.abs(obstacleRatio - areaRatio) / areaRatio < 0.2,
    `obstacles grew ${obstacleRatio.toFixed(1)}x while area grew ${areaRatio.toFixed(1)}x`);
});
