import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectilePlayback } from '../public/projectile-playback.js';

const openMap = { width: 500, height: 100, obstacles: [] };

function shot(overrides = {}) {
  return {
    type: 'shot', bulletId: 'bullet', ownerId: 'shooter',
    x: 10, y: 50, vx: 1_000, vy: 0, spawnedAt: 1_000,
    ...overrides,
  };
}

function impact(overrides = {}) {
  return {
    type: 'bullet_impact', bulletId: 'bullet', ownerId: 'shooter',
    x: 30, y: 50, vx: 1_000, vy: 0, impactedAt: 1_020, hit: 'wall',
    ...overrides,
  };
}

function liveBullet(overrides = {}) {
  return {
    id: 'bullet', ownerId: 'shooter', x: 10, y: 50,
    vx: 1_000, vy: 0, spawnedAt: 1_000, updatedAt: 1_000,
    ...overrides,
  };
}

function receive(playback, serverTime, arrival, bullets = [], events = []) {
  playback.receive({ serverTime, bullets, events }, arrival);
}

function onlyBullet(frame) {
  assert.equal(frame.bullets.length, 1);
  return frame.bullets[0];
}

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `expected ${expected}, got ${actual}`);
}

test('a short shot absent from every live snapshot still renders its complete flight', () => {
  const playback = new ProjectilePlayback();
  const map = { ...openMap, obstacles: [{ x: 32, y: 0, width: 1, height: 100 }] };
  // Both endpoints arrive together; the shot lived only 20 ms between packets.
  receive(playback, 1_050, 2_050, [], [shot(), impact()]);

  assert.deepEqual(playback.frame(1_999, map), { bullets: [], impacts: [], trails: [] });
  near(onlyBullet(playback.frame(2_000, map)).x, 10);
  near(onlyBullet(playback.frame(2_010, map)).x, 20);
  near(onlyBullet(playback.frame(2_019.5, map)).x, 29.5);
  assert.equal(playback.frame(2_019.5, map).impacts.length, 0);

  const contact = playback.frame(2_020, map);
  assert.equal(contact.bullets.length, 0);
  assert.equal(contact.impacts.length, 1);
  assert.equal(contact.impacts[0].x, 30);
  assert.equal(contact.impacts[0].age, 0);
  assert.equal(contact.impacts[0].hit, 'wall');
});

test('removal from the newest snapshot preserves the final segment until render time reaches impact', () => {
  const playback = new ProjectilePlayback();
  const map = { ...openMap, obstacles: [{ x: 87, y: 0, width: 1, height: 100 }] };
  receive(playback, 1_000, 2_000, [liveBullet()], [shot()]);
  receive(playback, 1_050, 2_050, [liveBullet({ x: 60, updatedAt: 1_050 })]);
  receive(playback, 1_100, 2_100, [], [impact({ x: 85, impactedAt: 1_075 })]);

  // The client is rendering behind receipt time, after the last live sample.
  near(onlyBullet(playback.frame(2_060, map)).x, 70);
  near(onlyBullet(playback.frame(2_074, map)).x, 84);
  assert.equal(playback.frame(2_074, map).impacts.length, 0);
  const contact = playback.frame(2_075, map);
  assert.equal(contact.bullets.length, 0);
  assert.equal(contact.impacts[0].x, 85);
  assert.equal(contact.impacts[0].age, 0);
});

test('sample updatedAt determines interpolation and extrapolation independently of snapshot publication', () => {
  const playback = new ProjectilePlayback();
  // This packet publishes a position simulated 20 ms before publication.
  receive(playback, 1_100, 5_000,
    [liveBullet({ x: 90, updatedAt: 1_080 })], [shot()]);
  near(onlyBullet(playback.frame(4_980, openMap)).x, 90);
  near(onlyBullet(playback.frame(5_000, openMap)).x, 110);

  receive(playback, 1_140, 5_040, [liveBullet({ x: 130, updatedAt: 1_120 })]);
  near(onlyBullet(playback.frame(5_000, openMap)).x, 110);
  near(onlyBullet(playback.frame(5_020, openMap)).x, 130);
  assert.equal(playback.shotAge('shooter', 4_899), Infinity);
  assert.equal(playback.shotAge('shooter', 5_000), 100);
  assert.equal(playback.shotAge('someone-else', 5_000), Infinity);
});

test('joining during an existing bullet flight does not replay a fresh muzzle flash', () => {
  const playback = new ProjectilePlayback();
  // A late joiner receives a live bullet, but its original shot event has
  // already been delivered to the existing clients one second earlier.
  receive(playback, 2_000, 3_000, [liveBullet({ x: 200, updatedAt: 2_000 })]);
  assert.equal(playback.shotAge('shooter', 3_000), 1_000);
  near(onlyBullet(playback.frame(3_000, openMap)).x, 200);
});

test('a packet gap cannot extrapolate through thin cover or invent an authoritative impact', () => {
  const playback = new ProjectilePlayback();
  const map = {
    ...openMap,
    obstacles: [
      { x: 80, y: 0, width: 1, height: 100 },
      { x: 50, y: 0, width: 1, height: 100 },
    ],
  };
  receive(playback, 1_000, 2_000, [liveBullet()], [shot()]);
  near(onlyBullet(playback.frame(2_005, map)).x, 15);
  for (const time of [2_090, 2_200, 2_400]) {
    const frame = playback.frame(time, map);
    near(onlyBullet(frame).x, 48);
    assert.equal(frame.impacts.length, 0);
  }
});

test('packet-gap extrapolation stays inside every arena edge, including diagonal travel', () => {
  const map = { width: 100, height: 100, obstacles: [] };
  const cases = [
    { vx: 1_000, vy: 0, x: 98, y: 50 },
    { vx: -1_000, vy: 0, x: 2, y: 50 },
    { vx: 0, vy: 1_000, x: 50, y: 98 },
    { vx: 0, vy: -1_000, x: 50, y: 2 },
    { vx: 1_000, vy: 500, x: 98, y: 74 },
  ];
  for (const expected of cases) {
    const playback = new ProjectilePlayback();
    receive(playback, 1_000, 2_000, [liveBullet({ x: 50, vx: expected.vx, vy: expected.vy })]);
    const frame = playback.frame(2_100, map, 2);
    const bullet = onlyBullet(frame);
    near(bullet.x, expected.x);
    near(bullet.y, expected.y);
    assert.equal(frame.impacts.length, 0);
  }
});

test('visual cover clipping uses rounded bullet contact at a corner without invisible square padding', () => {
  const map = { width: 100, height: 100, obstacles: [{ x: 50, y: 50, width: 10, height: 10 }] };
  const contactPlayback = new ProjectilePlayback();
  receive(contactPlayback, 1_000, 2_000, [liveBullet({ x: 45, y: 48.5 })]);
  const contact = onlyBullet(contactPlayback.frame(2_010, map, 2));
  near(contact.x, 50 - Math.sqrt(2 ** 2 - 1.5 ** 2));
  near(contact.y, 48.5);

  const clearPlayback = new ProjectilePlayback();
  receive(clearPlayback, 1_000, 2_000, [liveBullet({ x: 45, y: 47.9 })]);
  near(onlyBullet(clearPlayback.frame(2_010, map, 2)).x, 55);
});

test('impact effects expire and completed tracks are pruned while current shots remain', () => {
  const playback = new ProjectilePlayback();
  receive(playback, 1_050, 2_050, [], [shot(), impact()]);
  const fading = playback.frame(2_199, openMap);
  assert.equal(fading.bullets.length, 0);
  assert.equal(fading.impacts.length, 1);
  assert.equal(fading.impacts[0].age, 179);
  assert.deepEqual(playback.frame(2_200, openMap), { bullets: [], impacts: [], trails: [] });

  receive(playback, 2_021, 3_021, [liveBullet({
    id: 'new-bullet', ownerId: 'other', x: 100, spawnedAt: 2_000, updatedAt: 2_021,
  })]);
  assert.equal(playback.tracks.has('bullet'), false);
  assert.equal(playback.shotAge('shooter', 3_021), Infinity);
  assert.equal(onlyBullet(playback.frame(3_021, openMap)).id, 'new-bullet');

  playback.clear();
  assert.equal(playback.tracks.size, 0);
  assert.deepEqual(playback.frame(3_021, openMap), { bullets: [], impacts: [], trails: [] });
  assert.equal(playback.shotAge('other', 3_021), Infinity);
});

test('a removed bullet with no impact event stops extrapolating and is eventually discarded', () => {
  const playback = new ProjectilePlayback();
  receive(playback, 1_000, 2_000, [liveBullet()], [shot()]);
  receive(playback, 1_100, 2_100);
  assert.equal(playback.frame(2_200, openMap).bullets.length, 1);
  assert.deepEqual(playback.frame(2_351, openMap), { bullets: [], impacts: [], trails: [] });
  receive(playback, 2_101, 3_101);
  assert.equal(playback.tracks.size, 0);
});

test('trails grow from the muzzle and retain only the last 90 ms of known flight', () => {
  const playback = new ProjectilePlayback();
  receive(playback, 1_000, 2_000, [liveBullet()], [shot()]);
  assert.deepEqual(playback.frame(2_000, openMap).trails, []);
  assert.deepEqual(playback.frame(2_010, openMap).trails, [{
    id: 'bullet', x1: 10, y1: 50, x2: 20, y2: 50, alpha: 1,
  }]);
  receive(playback, 1_050, 2_050, [liveBullet({ x: 60, updatedAt: 1_050 })]);
  receive(playback, 1_100, 2_100, [liveBullet({ x: 110, updatedAt: 1_100 })]);
  const frame = playback.frame(2_120, openMap);
  assert.deepEqual(frame.trails, [{
    id: 'bullet', x1: 40, y1: 50, x2: 130, y2: 50, alpha: 1,
  }]);
  near(frame.trails[0].x2, onlyBullet(frame).x);
});

test('a late joiner never draws a trail behind the first known projectile position', () => {
  const playback = new ProjectilePlayback();
  receive(playback, 2_000, 3_000, [liveBullet({ x: 200, updatedAt: 2_000 })]);
  assert.deepEqual(playback.frame(2_999, openMap).trails, []);
  assert.deepEqual(playback.frame(3_000, openMap).trails, []);
  assert.deepEqual(playback.frame(3_020, openMap).trails, [{
    id: 'bullet', x1: 200, y1: 50, x2: 220, y2: 50, alpha: 1,
  }]);
});

test('short shots retain their actual segment at impact and fade without changing endpoints', () => {
  const playback = new ProjectilePlayback();
  const map = { ...openMap, obstacles: [{ x: 32, y: 0, width: 1, height: 100 }] };
  receive(playback, 1_050, 2_050, [], [shot(), impact()]);
  assert.deepEqual(playback.frame(2_010, map).trails, [{
    id: 'bullet', x1: 10, y1: 50, x2: 20, y2: 50, alpha: 1,
  }]);
  for (const age of [0, 30, 60, 119]) {
    const frame = playback.frame(2_020 + age, map);
    assert.equal(frame.bullets.length, 0);
    assert.deepEqual(frame.trails, [{
      id: 'bullet', x1: 10, y1: 50, x2: 30, y2: 50, alpha: 1 - age / 120,
    }]);
  }
  assert.deepEqual(playback.frame(2_140, map).trails, []);
  assert.deepEqual(playback.frame(2_200, map).trails, []);
});

test('an impact trail samples the last flight interval, including multiple received positions', () => {
  const playback = new ProjectilePlayback();
  receive(playback, 1_000, 2_000, [liveBullet()], [shot()]);
  receive(playback, 1_100, 2_100, [liveBullet({ x: 110, updatedAt: 1_100 })]);
  receive(playback, 1_200, 2_200, [], [impact({ x: 160, impactedAt: 1_150 })]);
  assert.deepEqual(playback.frame(2_180, openMap).trails, [{
    id: 'bullet', x1: 70, y1: 50, x2: 160, y2: 50, alpha: 0.75,
  }]);
});

test('packet-gap trails stop at cover and shrink away instead of crossing a wall', () => {
  const playback = new ProjectilePlayback();
  const map = { ...openMap, obstacles: [{ x: 50, y: 0, width: 1, height: 100 }] };
  receive(playback, 1_000, 2_000, [liveBullet()], [shot()]);
  assert.deepEqual(playback.frame(2_090, map).trails, [{
    id: 'bullet', x1: 10, y1: 50, x2: 48, y2: 50, alpha: 1,
  }]);
  assert.deepEqual(playback.frame(2_100, map).trails, [{
    id: 'bullet', x1: 20, y1: 50, x2: 48, y2: 50, alpha: 1,
  }]);
  assert.deepEqual(playback.frame(2_200, map).trails, []);
  assert.equal(playback.frame(2_200, map).impacts.length, 0);
});

test('diagonal trails share the projectile endpoint at the arena boundary', () => {
  const playback = new ProjectilePlayback();
  const map = { width: 100, height: 100, obstacles: [] };
  receive(playback, 1_000, 2_000, [liveBullet({ x: 50, vx: 1_000, vy: 500 })]);
  const frame = playback.frame(2_070, map);
  assert.deepEqual(frame.trails, [{
    id: 'bullet', x1: 50, y1: 50, x2: 98, y2: 74, alpha: 1,
  }]);
  near(frame.trails[0].x2, onlyBullet(frame).x);
  near(frame.trails[0].y2, onlyBullet(frame).y);
});

test('a local prediction renders at the current frame and reconciles to one authoritative track', () => {
  const playback = new ProjectilePlayback();
  playback.predictShot({
    clientShotId: 'client-1', ownerId: 'me', x: 10, y: 50,
    vx: 1_000, vy: 0, at: 2_000,
  });

  const immediate = playback.frame(1_890, openMap, 2, { immediateOwnerId: 'me', immediateTime: 2_020 });
  assert.equal(immediate.bullets.length, 1);
  near(immediate.bullets[0].x, 30);

  receive(playback, 1_010, 2_040, [liveBullet({
    id: 'server-bullet', ownerId: 'me', clientShotId: 'client-1', x: -10,
    spawnedAt: 1_000, updatedAt: 1_010,
  })], [shot({
    bulletId: 'server-bullet', ownerId: 'me', clientShotId: 'client-1',
    x: -20, clientShotId: 'client-1',
  })]);

  assert.equal(playback.tracks.size, 1);
  assert.equal(playback.tracks.has('predicted:client-1'), false);
  assert.equal(playback.tracks.has('server-bullet'), true);
  const reconciled = playback.frame(1_930, openMap, 2, { immediateOwnerId: 'me', immediateTime: 2_050 });
  assert.equal(reconciled.bullets.length, 1);
  assert.equal(reconciled.bullets[0].id, 'server-bullet');
  near(reconciled.bullets[0].x, 60);
});

test('a rejected local prediction can be removed without affecting other shots', () => {
  const playback = new ProjectilePlayback();
  playback.predictShot({ clientShotId: 'rejected', ownerId: 'me', x: 10, y: 50, vx: 1_000, vy: 0, at: 2_000 });
  playback.predictShot({ clientShotId: 'kept', ownerId: 'me', x: 10, y: 60, vx: 1_000, vy: 0, at: 2_000 });
  playback.rejectPrediction('rejected');
  assert.equal(playback.tracks.has('predicted:rejected'), false);
  assert.equal(playback.tracks.has('predicted:kept'), true);
});
