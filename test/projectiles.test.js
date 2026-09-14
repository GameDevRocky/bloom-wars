import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/game.js';
import { CONFIG } from '../server/config.js';
import {
  segmentCircleHitTime, sweptCircleRectHitTime, segmentBoundsExitTime,
} from '../public/shared/projectiles.js';

function arena(ids = ['host']) {
  let now = 1_000;
  const room = new Room('SHOTS', 'host', { now: () => now });
  room.phase = 'playing';
  room.map = { width: 4_000, height: 2_000, obstacles: [], pickups: [] };
  room.random = () => 0.5;
  room.storm = {
    phase: 'holding', phaseStartedAt: now, cycle: 1,
    to: { x: 2_000, y: 1_000, radius: 10_000 },
  };
  // Opposite sides by default: these exercise shots landing on people, and
  // teammates deliberately do not stop or take each other's fire.
  ids.forEach((id, index) => {
    const player = room.addPlayer(id, id);
    Object.assign(player, {
      x: 100, y: 100, alive: true, hasRifle: true, magazine: 30,
      team: index === 0 ? 'blue' : 'red',
    });
  });
  return {
    room,
    now: () => now,
    advance(seconds) {
      now += seconds * 1_000;
      room.updateBullets(seconds, now);
    },
    tick(seconds) {
      now += seconds * 1_000;
      room.tick(seconds);
    },
    bullet(values = {}) {
      const bullet = {
        id: 'test-bullet', ownerId: 'host', x: 100, y: 100, vx: 920, vy: 0,
        spawnedAt: now, simulatedAt: now, ...values,
      };
      room.bullets.push(bullet);
      return bullet;
    },
  };
}

function impact(room) {
  return room.events.find((event) => event.type === 'bullet_impact');
}

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} should equal ${expected}`);
}

test('fast bullets stop at the face of a one-unit wall between tick endpoints', () => {
  const state = arena();
  state.room.map.obstacles.push({ x: 180, y: 50, width: 1, height: 100 });
  state.bullet();
  state.advance(0.2);
  assert.equal(state.room.bullets.length, 0);
  assert.equal(impact(state.room).hit, 'wall');
  near(impact(state.room).x, 178);
  near(impact(state.room).impactedAt, 1_000 + 78 / 920 * 1_000);
});

test('collision chooses the nearest player regardless of roster ordering', () => {
  const state = arena(['host', 'far', 'near']);
  state.room.players.get('far').x = 260;
  state.room.players.get('near').x = 180;
  state.bullet({ vx: 2_000 });
  state.advance(0.2);
  assert.equal(state.room.players.get('near').hp, 100 - CONFIG.rifle.damage);
  assert.equal(state.room.players.get('far').hp, 100);
  assert.equal(impact(state.room).playerId, 'near');
  near(impact(state.room).x, 180 - CONFIG.playerRadius - CONFIG.rifle.bulletRadius);
});

test('the nearest wall wins even when obstacles are in reverse order', () => {
  const state = arena();
  state.room.map.obstacles.push(
    { x: 260, y: 50, width: 4, height: 100 },
    { x: 180, y: 50, width: 4, height: 100 },
  );
  state.bullet({ vx: 2_000 });
  state.advance(0.2);
  near(impact(state.room).x, 178);
});

test('a wall shields a player, while a player in front of the wall is hit first', () => {
  for (const targetX of [150, 250]) {
    const state = arena(['host', 'target']);
    state.room.players.get('target').x = targetX;
    state.room.map.obstacles.push({ x: 200, y: 50, width: 4, height: 100 });
    state.bullet({ vx: 2_000 });
    state.advance(0.2);
    assert.equal(impact(state.room).hit, targetX < 200 ? 'player' : 'wall');
    assert.equal(state.room.players.get('target').hp, targetX < 200 ? 100 - CONFIG.rifle.damage : 100);
  }
});

test('bullets persist beyond 900 milliseconds and travel until distant cover', () => {
  const state = arena();
  state.room.map.obstacles.push({ x: 3_200, y: 50, width: 4, height: 100 });
  state.bullet();
  for (let i = 0; i < 20; i += 1) state.advance(0.1);
  assert.equal(state.room.bullets.length, 1);
  near(state.room.bullets[0].x, 1_940);
  assert.equal(impact(state.room), undefined);
  for (let i = 0; i < 20; i += 1) state.advance(0.1);
  assert.equal(state.room.bullets.length, 0);
  near(impact(state.room).x, 3_198);
});

test('a protruding muzzle cannot spawn a projectile through thin cover', () => {
  const state = arena(['host', 'target']);
  state.room.players.get('target').x = 165;
  state.room.map.obstacles.push({ x: 120, y: 50, width: 1, height: 100 });
  state.room.fire(state.room.players.get('host'), state.now());
  assert.equal(state.room.bullets.length, 0);
  assert.equal(state.room.players.get('target').hp, 100);
  assert.equal(state.room.players.get('host').magazine, 29);
  const shot = state.room.events.find((event) => event.type === 'shot');
  assert.equal(impact(state.room).hit, 'wall');
  assert.equal(impact(state.room).bulletId, shot.bulletId);
  near(shot.x, 118);
  near(impact(state.room).x, shot.x);
  assert.equal(impact(state.room).impactedAt, shot.spawnedAt);
});

test('muzzle position rotates with the assembled weapon and spread changes only flight', () => {
  const state = arena();
  const host = state.room.players.get('host');
  host.input.aim = Math.PI / 2;
  state.room.random = () => 1;
  state.room.fire(host, state.now());
  const bullet = state.room.bullets[0];
  near(bullet.x, host.x - CONFIG.rifle.muzzleSide);
  near(bullet.y, host.y + CONFIG.rifle.muzzleForward);
  near(bullet.vx, Math.cos(Math.PI / 2 + CONFIG.rifle.spreadRadians) * CONFIG.rifle.bulletSpeed);
  near(bullet.vy, Math.sin(Math.PI / 2 + CONFIG.rifle.spreadRadians) * CONFIG.rifle.bulletSpeed);
});

test('newly created shots have no travel before their spawn timestamp', () => {
  const state = arena();
  const host = state.room.players.get('host');
  state.room.requestFire(host.id, { shotId: 'client-1', aim: 0 });
  const bullet = state.room.bullets[0];
  const shot = state.room.events.find((event) => event.type === 'shot');
  near(bullet.x, shot.x);
  near(bullet.y, shot.y);
  assert.equal(bullet.spawnedAt, state.now());
  assert.equal(shot.clientShotId, 'client-1');
  state.tick(1 / CONFIG.tickRate);
  state.advance(0.1);
  near(bullet.x, shot.x + bullet.vx * (0.1 + 1 / CONFIG.tickRate));
});

test('shots that hit between snapshots still publish their complete visual lifecycle', () => {
  const state = arena();
  state.room.map.obstacles.push({ x: 150, y: 50, width: 4, height: 100 });
  state.room.fire(state.room.players.get('host'), state.now());
  state.advance(1 / CONFIG.tickRate);
  const snapshot = state.room.snapshot();
  assert.equal(snapshot.bullets.length, 0);
  const shot = snapshot.events.find((event) => event.type === 'shot');
  const hit = snapshot.events.find((event) => event.type === 'bullet_impact');
  assert.equal(shot.bulletId, hit.bulletId);
  assert.ok(hit.impactedAt > shot.spawnedAt && hit.impactedAt < snapshot.serverTime);
  assert.equal(shot.ownerId, 'host');
  assert.equal(shot.playerId, 'host');
  assert.deepEqual(state.room.snapshot().events, []);
});

test('snapshot bullet positions retain their simulation timestamp between ticks', () => {
  const state = arena();
  state.room.fire(state.room.players.get('host'), state.now());
  state.advance(0.1);
  const snapshot = state.room.snapshot();
  assert.equal(snapshot.bullets[0].updatedAt, state.now());
  assert.equal(snapshot.bullets[0].spawnedAt, state.now() - 100);
  assert.equal(snapshot.bullets[0].ownerId, 'host');
});

test('a late-join initial snapshot leaves shot and impact events for the room broadcast', () => {
  const state = arena();
  state.room.map.obstacles.push({ x: 150, y: 50, width: 4, height: 100 });
  state.room.fire(state.room.players.get('host'), state.now());
  state.advance(1 / CONFIG.tickRate);
  state.room.addPlayer('late', 'Late Gardener');
  const initial = state.room.snapshot({ includeEvents: false });
  assert.deepEqual(initial.events, []);
  const broadcast = state.room.snapshot();
  assert.deepEqual(broadcast.events.map((event) => event.type), ['shot', 'bullet_impact']);
  assert.equal(broadcast.events[0].bulletId, broadcast.events[1].bulletId);
  assert.deepEqual(state.room.snapshot().events, []);
});

test('bullets stop at all four map edges, accounting for their radius', () => {
  const radius = CONFIG.rifle.bulletRadius;
  const cases = [
    { vx: -2_000, vy: 0, x: radius, y: 100 },
    { vx: 2_000, vy: 0, x: 200 - radius, y: 100 },
    { vx: 0, vy: -2_000, x: 100, y: radius },
    { vx: 0, vy: 2_000, x: 100, y: 200 - radius },
  ];
  for (const direction of cases) {
    const state = arena();
    state.room.map.width = 200;
    state.room.map.height = 200;
    state.bullet({ vx: direction.vx, vy: direction.vy });
    state.advance(0.1);
    assert.equal(state.room.bullets.length, 0);
    assert.equal(impact(state.room).hit, 'bounds');
    near(impact(state.room).x, direction.x);
    near(impact(state.room).y, direction.y);
  }
});

test('a muzzle pointed beyond the map hits the boundary immediately', () => {
  const state = arena();
  const host = state.room.players.get('host');
  host.x = CONFIG.playerRadius;
  host.input.aim = Math.PI;
  state.room.fire(host, state.now());
  assert.equal(state.room.bullets.length, 0);
  assert.equal(impact(state.room).hit, 'bounds');
  near(impact(state.room).x, CONFIG.rifle.bulletRadius);
});

test('relative sweep hits a moving player crossing between clear endpoints', () => {
  const state = arena(['host', 'target']);
  Object.assign(state.room.players.get('target'), { x: 150, y: 150 });
  state.bullet({ vx: 1_000 });
  const playerStarts = new Map([['target', { x: 150, y: 50 }]]);
  state.room.updateBullets(0.1, state.now() + 100, playerStarts);
  assert.equal(state.room.bullets.length, 0);
  assert.equal(impact(state.room).playerId, 'target');
  assert.ok(impact(state.room).x > 100 && impact(state.room).x < 150);
});

test('crossing a bullet path at a different time does not cause a false hit', () => {
  const state = arena(['host', 'target']);
  Object.assign(state.room.players.get('target'), { x: 190, y: 150 });
  state.bullet({ vx: 1_000 });
  const playerStarts = new Map([['target', { x: 190, y: 50 }]]);
  state.room.updateBullets(0.1, state.now() + 100, playerStarts);
  assert.equal(state.room.bullets.length, 1);
  assert.equal(impact(state.room), undefined);
});

test('room ticks capture actual player movement for continuous collision', () => {
  const state = arena(['host', 'target']);
  const target = state.room.players.get('target');
  Object.assign(target, { x: 117, y: 81, vy: CONFIG.playerSpeed });
  state.room.receiveInput('target', { sequence: 1, down: true, aim: 0 });
  state.bullet({ vx: 1_000 });
  state.tick(1 / CONFIG.tickRate);
  assert.equal(impact(state.room).playerId, 'target');
  assert.equal(target.hp, 100 - CONFIG.rifle.damage);
});

test('sweeps handle corner grazing, tangency, overlap, and stationary segments', () => {
  const rect = { x: 10, y: 10, width: 20, height: 20 };
  assert.equal(sweptCircleRectHitTime({ x: 7, y: 8.1 }, { x: 8.1, y: 8.1 }, 2, rect), null);
  near(sweptCircleRectHitTime({ x: 0, y: 8 }, { x: 20, y: 8 }, 2, rect), 0.5);
  assert.equal(sweptCircleRectHitTime({ x: 15, y: 15 }, { x: 15, y: 15 }, 2, rect), 0);
  assert.equal(segmentCircleHitTime({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 5, y: 0, radius: 1 }), null);
  assert.equal(segmentCircleHitTime({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0, radius: 1 }), 0);
  assert.equal(segmentBoundsExitTime({ x: 1, y: 50 }, { x: 1, y: 50 }, 100, 100, 2), 0);
});
