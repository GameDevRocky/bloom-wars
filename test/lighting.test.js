import test from 'node:test';
import assert from 'node:assert/strict';
import { clippedMuzzle, lightVisibility } from '../public/lighting.js';
import { CONFIG } from '../server/config.js';

const EPSILON = 1e-7;

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < EPSILON, `${actual} should equal ${expected}`);
}

// Check the filled light polygon, including the edges between corner rays.
function contains(polygon, point) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

test('unobstructed light reaches its full radius in every sampled direction', () => {
  const origin = { x: 500, y: 500 };
  const polygon = lightVisibility(origin, 200, { width: 1_000, height: 1_000, obstacles: [] });
  assert.ok(polygon.length >= 32);
  for (const point of polygon) near(Math.hypot(point.x - origin.x, point.y - origin.y), 200);
  for (const point of [{ x: 310, y: 500 }, { x: 690, y: 500 }, { x: 500, y: 310 }, { x: 500, y: 690 }]) {
    assert.ok(contains(polygon, point));
  }
  assert.equal(contains(polygon, { x: 701, y: 500 }), false);
});

test('a one-unit wall stops light at its near face before more distant cover', () => {
  const origin = { x: 500, y: 500 };
  const nearWall = { x: 600, y: 100, width: 1, height: 800 };
  const farWall = { x: 650, y: 100, width: 40, height: 800 };
  const map = { width: 1_000, height: 1_000, obstacles: [farWall, nearWall] };
  const polygon = lightVisibility(origin, 300, map);
  for (const point of polygon) assert.ok(point.x <= 600 + EPSILON, 'ray crossed the thin wall');
  const forwardRay = polygon.find((point) => point.x > origin.x && Math.abs(point.y - origin.y) < EPSILON);
  near(forwardRay.x, 600);
  assert.ok(contains(polygon, { x: 599, y: 500 }));
  assert.equal(contains(polygon, { x: 602, y: 500 }), false);
  assert.deepEqual(lightVisibility(origin, 300, { ...map, obstacles: [nearWall, farWall] }), polygon);
});

test('light stays within all four arena edges when its radius exceeds the map', () => {
  const origin = { x: 10, y: 20 };
  const polygon = lightVisibility(origin, 150, { width: 80, height: 65, obstacles: [] });
  for (const point of polygon) {
    assert.ok(point.x >= -EPSILON && point.x <= 80 + EPSILON);
    assert.ok(point.y >= -EPSILON && point.y <= 65 + EPSILON);
  }
  for (const [axis, expected] of [['x', 0], ['x', 80], ['y', 0], ['y', 65]]) {
    assert.ok(polygon.some((point) => Math.abs(point[axis] - expected) < EPSILON));
  }
  assert.equal(contains(polygon, { x: -1, y: 20 }), false);
  assert.equal(contains(polygon, { x: 81, y: 20 }), false);
  assert.equal(contains(polygon, { x: 10, y: -1 }), false);
  assert.equal(contains(polygon, { x: 10, y: 66 }), false);
});

test('corner rays preserve illuminated space beside cover and shadow behind it', () => {
  const map = { width: 1_000, height: 1_000, obstacles: [{ x: 200, y: 150, width: 20, height: 100 }] };
  for (const displacement of [-0.00001, 0, 0.00001]) {
    const origin = { x: 100 + displacement, y: 100 - displacement };
    const polygon = lightVisibility(origin, 350, map);
    assert.deepEqual(lightVisibility(origin, 350, map), polygon);
    assert.ok(polygon.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
    assert.ok(contains(polygon, { x: 180, y: 180 }), 'space in front of cover should be lit');
    assert.ok(contains(polygon, { x: 300, y: 175 }), 'space above the upper shadow edge should be lit');
    assert.ok(contains(polygon, { x: 245, y: 340 }), 'space below the lower shadow edge should be lit');
    assert.equal(contains(polygon, { x: 210, y: 200 }), false, 'cover interior should not be lit');
    assert.equal(contains(polygon, { x: 300, y: 225 }), false, 'space behind cover should be in shadow');
  }
});

test('cover beyond the viewport still blocks an offscreen light shining toward the camera', () => {
  // The camera sees x=400..600. Both the light and wall are offscreen,
  // but excluding that wall would incorrectly illuminate the visible floor.
  const origin = { x: 250, y: 500 };
  const map = { width: 1_000, height: 1_000, obstacles: [{ x: 350, y: 100, width: 10, height: 800 }] };
  const polygon = lightVisibility(origin, 350, map);
  assert.equal(contains(polygon, { x: 450, y: 500 }), false);
  assert.ok(contains(lightVisibility(origin, 350, { ...map, obstacles: [] }), { x: 450, y: 500 }));
  for (const point of polygon) assert.ok(point.x <= 350 + EPSILON);
});

test('distant cover cannot alter light inside an unobstructed radius', () => {
  const origin = { x: 500, y: 500 };
  const map = { width: 31_000, height: 31_000, obstacles: [] };
  const expected = lightVisibility(origin, 165, map);
  map.obstacles.push(
    { x: 800, y: 400, width: 100, height: 200 },
    { x: 30_000, y: 30_000, width: 120, height: 120 },
  );
  assert.deepEqual(lightVisibility(origin, 165, map), expected);
});

test('an obstructed barrel casts its muzzle light from the near side of thin cover', () => {
  const player = { x: 100, y: 500, aim: 0 };
  const map = { width: 1_000, height: 1_000, obstacles: [{ x: 120, y: 100, width: 1, height: 800 }] };
  const muzzle = clippedMuzzle(player, CONFIG.rifle, map);
  near(muzzle.x, 120 - CONFIG.rifle.bulletRadius);
  assert.ok(muzzle.x < map.obstacles[0].x);
  assert.ok(player.x + CONFIG.rifle.muzzleForward > 121, 'unclipped barrel should extend through this wall');
  const polygon = lightVisibility(muzzle, 155, map);
  assert.ok(contains(polygon, { x: 110, y: 500 }));
  assert.equal(contains(polygon, { x: 140, y: 500 }), false);
});

test('an unobstructed muzzle rotates its forward and side offsets with the weapon', () => {
  const map = { width: 1_000, height: 1_000, obstacles: [] };
  const forward = clippedMuzzle({ x: 500, y: 500, aim: 0 }, CONFIG.rifle, map);
  near(forward.x, 500 + CONFIG.rifle.muzzleForward);
  near(forward.y, 500 + CONFIG.rifle.muzzleSide);
  const turned = clippedMuzzle({ x: 500, y: 500, aim: Math.PI / 2 }, CONFIG.rifle, map);
  near(turned.x, 500 - CONFIG.rifle.muzzleSide);
  near(turned.y, 500 + CONFIG.rifle.muzzleForward);
});

test('a muzzle aimed out of the arena remains inside the projectile boundary', () => {
  const map = { width: 200, height: 200, obstacles: [] };
  for (const player of [
    { x: 20, y: 100, aim: Math.PI, axis: 'x', edge: CONFIG.rifle.bulletRadius },
    { x: 180, y: 100, aim: 0, axis: 'x', edge: 200 - CONFIG.rifle.bulletRadius },
    { x: 100, y: 20, aim: -Math.PI / 2, axis: 'y', edge: CONFIG.rifle.bulletRadius },
    { x: 100, y: 180, aim: Math.PI / 2, axis: 'y', edge: 200 - CONFIG.rifle.bulletRadius },
  ]) {
    near(clippedMuzzle(player, CONFIG.rifle, map)[player.axis], player.edge);
  }
});
