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

test('expanded worlds preserve the populated starting garden and add outer cover and loot', () => {
  for (const count of [1, 8, 64]) {
    const map = generateMap(count, `expanded-${count}`);
    const previousSize = 1_550 + Math.max(0, count - 4) * 115;
    assert.equal(map.width, previousSize * 20);
    assert.equal(map.height, previousSize * 20);
    const region = map.startingRegion;
    const inside = (point) => point.x >= region.x && point.x <= region.x + region.width
      && point.y >= region.y && point.y <= region.y + region.height;
    assert.ok(map.spawns.every(inside));
    assert.ok(map.obstacles.filter(inside).length >= 40 + count * 6);
    assert.equal(map.obstacles.length, (40 + count * 6) * 20);
    assert.ok(map.obstacles.some((obstacle) => !inside(obstacle)));
    for (const kind of ['rifle', 'ammo', 'seed']) {
      assert.ok(map.pickups.filter((pickup) => pickup.kind === kind && inside(pickup)).length >= count,
        `${kind} must remain available in the starting garden`);
      assert.ok(map.pickups.some((pickup) => pickup.kind === kind && !inside(pickup)));
    }
    assert.ok(map.pickups.filter((pickup) => pickup.kind === 'ammo' && inside(pickup)).length >= Math.max(count * 4, 16));
    assert.deepEqual(validateMap(map), { valid: true, issues: [] });
  }
});

test('twenty-times cover is distributed throughout every outer-world quadrant', () => {
  const map = generateMap(1, 'outer-distribution');
  const center = map.width / 2;
  const quadrants = [0, 0, 0, 0];
  for (const obstacle of map.obstacles) {
    const x = obstacle.x + obstacle.width / 2;
    const y = obstacle.y + obstacle.height / 2;
    quadrants[Number(x >= center) + Number(y >= center) * 2] += 1;
  }
  assert.ok(quadrants.every((count) => count > 150), `expected broad random coverage, got ${quadrants}`);
});
