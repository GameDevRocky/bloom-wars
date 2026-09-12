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
