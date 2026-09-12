import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../server/config.js';
import { flowerHealAt, Room } from '../server/game.js';

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

test('storm contracts for sixty seconds, holds for ten, then chooses a nested target', () => {
  const { room, advance } = controlledRoom(['host']);
  room.start('host');
  const initialRadius = room.storm.from.radius;
  advance(60_000);
  room.tick(0);
  assert.equal(room.storm.phase, 'holding');
  assert.ok(room.currentStorm().radius < initialRadius);
  advance(10_000);
  room.tick(0);
  assert.equal(room.storm.phase, 'contracting');
  assert.equal(room.storm.cycle, 2);
  assert.ok(room.storm.to.radius <= room.storm.from.radius);
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
