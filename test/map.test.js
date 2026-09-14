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
  // A full column per side, so any split of the roster can be seated without
  // regenerating the map.
  for (const [map, players] of [[small, 2], [large, 24]]) {
    assert.equal(map.teamSpawns.blue.length, players);
    assert.equal(map.teamSpawns.red.length, players);
    assert.equal(map.spawns.length, players * 2);
    // Sides start apart: every blue position is left of every red one.
    const rightmostBlue = Math.max(...map.teamSpawns.blue.map((s) => s.x));
    const leftmostRed = Math.min(...map.teamSpawns.red.map((s) => s.x));
    assert.ok(rightmostBlue < leftmostRed,
      `blue should start left of red, got ${rightmostBlue} and ${leftmostRed}`);
    assert.ok(leftmostRed - rightmostBlue > map.width * 0.5,
      'teams should start on opposite sides of the arena');
  }
  assert.deepEqual(validateMap(small), { valid: true, issues: [] });
  assert.deepEqual(validateMap(large), { valid: true, issues: [] });
});

test('generated loot covers ammunition and seeds, and scatters no rifles', () => {
  const map = generateMap(6, 'loot');
  // Players spawn armed and cannot lose a rifle, so one on the ground could
  // never be collected.
  assert.equal(map.pickups.filter((pickup) => pickup.kind === 'rifle').length, 0);
  for (const kind of ['ammo', 'seed']) {
    assert.ok(map.pickups.filter((pickup) => pickup.kind === kind).length >= 6);
  }
});

// The arena used to be built as a dense central garden plus a thin scatter
// outside it, which left the middle twenty times richer in cover than the edges
// and the outskirts all but empty of loot. Density is now per unit of area, so
// the middle of the map should be no richer than the rim. Comparing two large
// regions rather than many small ones keeps this measuring distribution instead
// of the ordinary clumping of a few hundred random placements.
test('cover and loot are no denser at the centre than at the rim', () => {
  for (const count of [1, 8, 64]) {
    const map = generateMap(count, `even-${count}`);
    assert.equal(map.width, (1_550 + Math.max(0, count - 4) * 115) * 3);

    // The centred square holding a quarter of the arena's area.
    const half = map.width / 2;
    const inset = map.width / 4;
    const middle = (item) => Math.abs(item.x - half) < inset && Math.abs(item.y - half) < inset;
    const innerArea = (map.width / 2) ** 2 / 1_000_000;
    const outerArea = (map.width ** 2) / 1_000_000 - innerArea;

    for (const [label, items] of [['obstacles', map.obstacles], ['pickups', map.pickups]]) {
      const inner = items.filter(middle).length / innerArea;
      const outer = (items.length - items.filter(middle).length) / outerArea;
      assert.ok(inner > 0 && outer > 0, `${label}: both regions must be populated`);
      const ratio = Math.max(inner, outer) / Math.min(inner, outer);
      // The guaranteed corridor deliberately keeps a clear cross through the
      // middle, which thins the centre a little, and more so on a small map
      // where that fixed-width cross is a larger share of it. This bound still
      // sits far below the twenty-fold skew it is here to catch.
      assert.ok(ratio < 2.2,
        `${label} at ${count} players: centre ${inner.toFixed(2)}/Mu² vs rim ${outer.toFixed(2)}/Mu² (${ratio.toFixed(1)}x)`);
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
