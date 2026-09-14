import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../server/config.js';
import { Room } from '../server/game.js';
import { EMPTY_INPUT, stepPlayer } from '../public/shared/simulation.js';

const STEP = 1 / CONFIG.tickRate;

function assertClear(body, map, tolerance = 1e-7) {
  for (const obstacle of map.obstacles) {
    const x = Math.max(obstacle.x, Math.min(body.x, obstacle.x + obstacle.width));
    const y = Math.max(obstacle.y, Math.min(body.y, obstacle.y + obstacle.height));
    assert.ok(Math.hypot(body.x - x, body.y - y) >= CONFIG.playerRadius - tolerance,
      `player at (${body.x}, ${body.y}) must stay outside cover`);
  }
}

test('holding against cover rests, diagonal input slides, and turning away has no stored impulse', () => {
  const map = {
    width: 2_000, height: 2_000,
    obstacles: [{ x: 300, y: 100, width: 64, height: 1_500 }],
  };
  const body = { x: 300 - CONFIG.playerRadius, y: 250, vx: 0, vy: 0 };
  for (let tick = 0; tick < 120; tick += 1) {
    stepPlayer(body, { ...EMPTY_INPUT, right: true }, CONFIG, map, STEP);
    assert.equal(body.x, 300 - CONFIG.playerRadius);
    assert.equal(body.vx, 0);
  }

  for (let tick = 0; tick < 90; tick += 1) {
    stepPlayer(body, { ...EMPTY_INPUT, right: true, down: true }, CONFIG, map, STEP);
    assert.equal(body.x, 300 - CONFIG.playerRadius);
    assert.equal(body.vx, 0);
    assertClear(body, map);
  }
  assert.ok(body.y > 600, 'the wall must allow movement along its face');
  assert.ok(Math.abs(body.vy - CONFIG.playerSpeed / Math.SQRT2) < 0.001);

  for (let tick = 0; tick < 60; tick += 1) {
    stepPlayer(body, EMPTY_INPUT, CONFIG, map, STEP);
  }
  assert.ok(Math.hypot(body.vx, body.vy) < 0.001, 'releasing input must come to rest');
  const beforeTurn = body.x;
  stepPlayer(body, { ...EMPTY_INPUT, left: true }, CONFIG, map, STEP);
  assert.ok(body.x < beforeTurn, 'turning away should respond on the next tick');
  assert.ok(-body.vx > 0 && -body.vx < CONFIG.playerSpeed * 0.5,
    'pressing against cover must not store a burst of speed');
});

test('diagonal movement stays within the same speed limit as straight movement', () => {
  const map = { width: 4_000, height: 4_000, obstacles: [] };
  const straight = { x: 500, y: 500, vx: 0, vy: 0 };
  const diagonal = { ...straight };
  for (let tick = 0; tick < 180; tick += 1) {
    stepPlayer(straight, { ...EMPTY_INPUT, right: true }, CONFIG, map, STEP);
    stepPlayer(diagonal, { ...EMPTY_INPUT, right: true, down: true }, CONFIG, map, STEP);
    assert.ok(Math.hypot(diagonal.vx, diagonal.vy) <= CONFIG.playerSpeed + 1e-7);
    assert.ok(Math.abs(Math.hypot(straight.vx, straight.vy) - Math.hypot(diagonal.vx, diagonal.vy)) < 1e-7);
  }
  assert.ok(Math.abs(Math.hypot(diagonal.vx, diagonal.vy) - CONFIG.playerSpeed) < 0.001);
  assert.ok(Math.abs(diagonal.x - diagonal.y) < 1e-7);
});

test('a gap narrower than the player stops at both corners regardless of obstacle order', () => {
  const obstacles = [
    { x: 300, y: 300, width: 64, height: 64 },
    { x: 388, y: 300, width: 64, height: 64 },
  ];
  const outcomes = [];
  for (const ordered of [obstacles, [...obstacles].reverse()]) {
    const map = { width: 2_000, height: 2_000, obstacles: ordered };
    const body = { x: 376, y: 250, vx: 0, vy: 0 };
    for (let tick = 0; tick < 60; tick += 1) {
      stepPlayer(body, { ...EMPTY_INPUT, down: true }, CONFIG, map, STEP);
      assertClear(body, map, 1e-4);
    }
    assert.ok(body.y < 300, 'the 32-unit body cannot enter a 24-unit gap');
    outcomes.push(body);
  }
  assert.ok(Math.hypot(outcomes[0].x - outcomes[1].x, outcomes[0].y - outcomes[1].y) < 0.01,
    'map obstacle ordering must not change the contact position');
});

test('client prediction and queued server inputs agree while stopping at and rounding a cover corner', () => {
  const room = new Room('WALLS', 'host', { now: () => 1_000, seedFactory: () => 'movement-corner' });
  room.addPlayer('host', 'Host');
  room.addPlayer('rival', 'Rival');
  room.start('host');
  room.map = {
    width: 2_000, height: 2_000,
    obstacles: [{ x: 300, y: 300, width: 64, height: 64 }],
  };
  const host = room.players.get('host');
  Object.assign(host, { x: 250, y: 250, vx: 0, vy: 0 });
  const predicted = { x: 250, y: 250, vx: 0, vy: 0 };

  for (let tick = 0; tick < 250; tick += 1) {
    const input = {
      ...EMPTY_INPUT, sequence: tick + 1,
      right: tick < 110, down: tick < 70 || (tick >= 110 && tick < 180), left: tick >= 180,
    };
    stepPlayer(predicted, input, CONFIG, room.map, STEP);
    room.receiveInput('host', input);
    room.consumeInputs(host, 1_000 + tick * STEP * 1_000);
    assertClear(predicted, room.map);
    assert.ok(Math.hypot(predicted.vx, predicted.vy) <= CONFIG.playerSpeed + 1e-7,
      'corner resolution must not accelerate the player');
    for (const axis of ['x', 'y', 'vx', 'vy']) assert.equal(host[axis], predicted[axis]);

    if (tick === 69) {
      assert.ok(predicted.x < 300 && predicted.y < 300, 'diagonal approach must stop before the corner');
      assert.ok(Math.hypot(predicted.vx, predicted.vy) < 0.001);
    }
  }
  assert.equal(host.lastProcessedSequence, 250);
  assert.ok(predicted.y > 364 + CONFIG.playerRadius, 'the player must be able to round the cover');
});
