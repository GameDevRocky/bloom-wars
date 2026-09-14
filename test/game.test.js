import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../server/config.js';
import { flowerHealAt, Room } from '../server/game.js';
import { readInput, stepPlayer } from '../public/shared/simulation.js';

function controlledRoom(playerIds = ['host', 'guest']) {
  let time = 1_000;
  const room = new Room('ABCDE', 'host', {
    now: () => time,
    seedFactory: () => 'test-seed',
  });
  for (const id of playerIds) room.addPlayer(id, id);
  return { room, now: () => time, advance: (milliseconds) => { time += milliseconds; } };
}

test('only the host can start and all players begin unarmed at full health', () => {
  const { room } = controlledRoom();
  assert.throws(() => room.start('guest'), /Only the host/);
  room.start('host');
  for (const player of room.players.values()) {
    assert.equal(player.hp, 100);
    assert.equal(player.hasRifle, false);
    assert.equal(player.alive, true);
  }
});

test('movement accelerates toward terminal speed instead of starting at it', () => {
  const { room } = controlledRoom();
  room.start('host');
  const host = room.players.get('host');
  host.x = room.map.width / 2;
  host.y = room.map.height / 2;
  host.input = { ...host.input, right: true };

  const step = 1 / 30;
  room.movePlayer(host, step);
  const afterOneTick = Math.hypot(host.vx, host.vy);
  assert.ok(afterOneTick > 0, 'player should be moving after one tick');

  assert.ok(
    afterOneTick < CONFIG.playerSpeed * 0.75,
    `one tick should not reach top speed, got ${afterOneTick}`,
  );

  for (let i = 0; i < 60; i += 1) room.movePlayer(host, step);
  const settled = Math.hypot(host.vx, host.vy);
  assert.ok(
    Math.abs(settled - CONFIG.playerSpeed) < CONFIG.playerSpeed * 0.02,
    `expected ~${CONFIG.playerSpeed}, got ${settled}`,
  );

  // Releasing the key should coast to a stop rather than halting dead.
  host.input = { ...host.input, right: false };
  room.movePlayer(host, step);
  const coasting = Math.hypot(host.vx, host.vy);
  assert.ok(coasting > 0 && coasting < settled, `expected decay, got ${coasting} from ${settled}`);

  for (let i = 0; i < 30; i += 1) room.movePlayer(host, step);
  assert.ok(Math.hypot(host.vx, host.vy) < 1, 'player should come to rest within a second');
});

// The client draws its own player from a local prediction and only corrects it
// when the server disagrees. If the two simulations drift, every input produces
// a correction and the player rubberbands constantly, so they must agree
// exactly for the same inputs.
test('server movement lands where the client predicted for the same inputs', () => {
  const { room } = controlledRoom(['host']);
  room.start('host');
  const host = room.players.get('host');

  const inputs = [];
  for (let sequence = 1; sequence <= 45; sequence += 1) {
    inputs.push({
      sequence,
      up: sequence % 7 === 0,
      down: sequence > 24,
      left: sequence % 5 === 0,
      right: sequence <= 24,
      firing: false,
      aim: sequence / 9,
    });
  }

  const predicted = { x: host.x, y: host.y, vx: 0, vy: 0 };
  const step = 1 / CONFIG.tickRate;
  for (const input of inputs) stepPlayer(predicted, readInput(input), CONFIG, room.map, step);

  for (const input of inputs) {
    room.receiveInput('host', input);
    room.consumeInputs(host, 1_000);
  }

  assert.equal(host.lastProcessedSequence, 45);
  assert.ok(Math.hypot(host.x - predicted.x, host.y - predicted.y) < 1e-9,
    `server (${host.x}, ${host.y}) should match prediction (${predicted.x}, ${predicted.y})`);
});

test('replayed and out-of-order inputs are ignored', () => {
  const { room } = controlledRoom(['host']);
  room.start('host');
  const host = room.players.get('host');

  room.receiveInput('host', { sequence: 5, right: true, aim: 0 });
  room.consumeInputs(host, 1_000);
  const afterFirst = { x: host.x, y: host.y };

  // Both of these are in the past and must not move the player again.
  room.receiveInput('host', { sequence: 5, right: true, aim: 0 });
  room.receiveInput('host', { sequence: 2, right: true, aim: 0 });
  room.consumeInputs(host, 1_000);

  assert.equal(host.inputQueue.length, 0);
  assert.deepEqual({ x: host.x, y: host.y }, afterFirst);
});

test('a flood of inputs cannot buy extra movement', () => {
  const { room } = controlledRoom(['host']);
  room.start('host');
  const host = room.players.get('host');

  for (let sequence = 1; sequence <= 200; sequence += 1) {
    room.receiveInput('host', { sequence, right: true, aim: 0 });
  }
  assert.ok(host.inputQueue.length <= CONFIG.input.queueLimit,
    `queue should stay bounded, got ${host.inputQueue.length}`);

  room.consumeInputs(host, 1_000);
  assert.ok(host.inputQueue.length >= CONFIG.input.queueLimit - CONFIG.input.creditLimit - 1,
    'a single tick should not drain an unbounded backlog');
});

test('each player in a room gets a distinct skin', () => {
  const { room } = controlledRoom(['a', 'b', 'c']);
  const skins = [...room.players.values()].map((player) => player.skin);
  assert.equal(new Set(skins).size, skins.length);
  for (const skin of skins) {
    assert.ok(Number.isInteger(skin) && skin >= 0 && skin < CONFIG.skinCount);
  }
});

test('flower healing starts at one, grows every two seconds, and caps at fifty', () => {
  const player = { flowerCollectedAt: 1_000 };
  assert.equal(flowerHealAt(player, 1_000), 1);
  assert.equal(flowerHealAt(player, 2_999), 1);
  assert.equal(flowerHealAt(player, 3_000), 2);
  assert.equal(flowerHealAt(player, 200_000), 50);
});

test('consuming a flower heals without passing max HP and empties the slot', () => {
  const { room, now, advance } = controlledRoom();
  room.start('host');
  const host = room.players.get('host');
  host.hp = 82;
  host.flowerCollectedAt = now();
  advance(40_000);
  assert.equal(room.consumeFlower('host'), 18);
  assert.equal(host.hp, CONFIG.maxHp);
  assert.equal(host.flowerCollectedAt, null);
});

test('storm finishes its published contraction duration, holds for ten seconds, then chooses a nested target', () => {
  const { room, advance } = controlledRoom(['host']);
  room.start('host');
  const initialRadius = room.storm.from.radius;
  advance(room.currentStorm().durationMs);
  room.tick(0);
  assert.equal(room.storm.phase, 'holding');
  assert.ok(room.currentStorm().radius < initialRadius);
  advance(10_000);
  room.tick(0);
  assert.equal(room.storm.phase, 'contracting');
  assert.equal(room.storm.cycle, 2);
  assert.ok(room.storm.to.radius <= room.storm.from.radius);
  assert.ok(Math.hypot(room.storm.to.x - room.storm.from.x, room.storm.to.y - room.storm.from.y)
    + room.storm.to.radius <= room.storm.from.radius + 1e-9);
});

test('spectators transfer atomically down the killer chain', () => {
  const { room } = controlledRoom(['host', 'guest', 'third']);
  room.start('host');
  const host = room.players.get('host');
  const guest = room.players.get('guest');
  room.damage(host, 100, 'guest', 'rifle');
  assert.equal(host.spectatorTargetId, 'guest');
  room.damage(guest, 100, 'third', 'rifle');
  room.tick(0);
  assert.equal(guest.spectatorTargetId, 'third');
  assert.equal(host.spectatorTargetId, 'third');
  assert.equal(room.phase, 'ended');
  assert.equal(room.winnerId, 'third');
});

test('late joiners spectate a living player until the next match', () => {
  const { room } = controlledRoom();
  room.start('host');
  const late = room.addPlayer('late', 'Late Gardener');
  assert.equal(late.alive, false);
  assert.ok(['host', 'guest'].includes(late.spectatorTargetId));
});
