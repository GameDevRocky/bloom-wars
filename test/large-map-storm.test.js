import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../server/config.js';
import { Room } from '../server/game.js';

function startRoom(playerCount) {
  const room = new Room('STORM', 'p0', {
    now: () => 1_000,
    seedFactory: () => 'large-storm',
  });
  for (let index = 0; index < playerCount; index += 1) room.addPlayer(`p${index}`, `Player ${index}`);
  room.start('p0');
  return room;
}

test('players can outrun the fastest contracting storm edge at every supported map size', () => {
  for (const count of [2, 8, CONFIG.maxRoomPlayers]) {
    const room = startRoom(count);
    // Check successive circles, including the eventual minimum-size circle.
    for (let cycle = 0; cycle < 16; cycle += 1) {
      const { from, to } = room.storm;
      const duration = room.currentStorm().durationMs;
      const edgeTravel = from.radius - to.radius + Math.hypot(to.x - from.x, to.y - from.y);
      const boundarySpeed = edgeTravel / (duration / 1_000);
      assert.ok(duration >= CONFIG.storm.contractionMs);
      assert.ok(boundarySpeed <= CONFIG.playerSpeed * CONFIG.storm.maxBoundarySpeedRatio + 1e-9,
        `${count} players, cycle ${cycle}: storm edge moves at ${boundarySpeed}`);
      room.storm.from = to;
      room.storm.to = room.nextStormTarget(to);
    }
  }
});

test('an extended storm contraction reports progress and phase against its own duration', () => {
  const room = startRoom(CONFIG.maxRoomPlayers);
  const startedAt = room.storm.phaseStartedAt;
  // A contraction wide enough that outrunning it needs longer than the sixty
  // second minimum. Set explicitly rather than relying on the largest generated
  // map, whose size is a gameplay decision and has been reduced before.
  room.storm.from = { x: 40_000, y: 40_000, radius: 30_000 };
  room.storm.to = { x: 40_000, y: 40_000, radius: 6_000 };
  const { durationMs } = room.currentStorm();
  assert.ok(durationMs > CONFIG.storm.contractionMs,
    `expected the wide contraction to be extended past the floor, got ${durationMs}`);

  const halfway = room.currentStorm(startedAt + durationMs / 2);
  assert.equal(halfway.progress, 0.5);
  assert.equal(halfway.radius, (room.storm.from.radius + room.storm.to.radius) / 2);
  room.updateStorm(startedAt + durationMs - 1);
  assert.equal(room.storm.phase, 'contracting');
  room.updateStorm(startedAt + durationMs);
  assert.equal(room.storm.phase, 'holding');
  assert.equal(room.currentStorm().durationMs, CONFIG.storm.holdMs);
  assert.equal(room.currentStorm().radius, room.storm.to.radius);

  room.updateStorm(startedAt + durationMs + CONFIG.storm.holdMs);
  assert.equal(room.storm.phase, 'contracting');
  assert.equal(room.storm.cycle, 2);
  assert.equal(room.currentStorm(room.storm.phaseStartedAt).progress, 0);
});

test('small storm circles retain the sixty-second contraction minimum', () => {
  const room = startRoom(2);
  room.storm.from = { x: 5_000, y: 5_000, radius: 500 };
  room.storm.to = { x: 5_020, y: 5_000, radius: 290 };
  assert.equal(room.currentStorm().durationMs, CONFIG.storm.contractionMs);
  assert.equal(room.currentStorm(room.storm.phaseStartedAt + 30_000).progress, 0.5);
});
