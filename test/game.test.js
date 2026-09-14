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
  const { room } = controlledRoom(['host', 'rival']);
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
  const { room } = controlledRoom(['host', 'rival']);
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
  const { room } = controlledRoom(['host', 'rival']);
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
  const { room, advance } = controlledRoom(['host', 'rival']);
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
  // Teammates cannot hurt each other, so put the two killers opposite their
  // victims; this test is about the spectator chain, not the team split.
  host.team = 'blue';
  room.players.get('third').team = 'blue';
  guest.team = 'red';
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

test('empty rifles reload automatically and ammo pickup starts an empty weapon reload', () => {
  const { room, now, advance } = controlledRoom(['host', 'rival']);
  room.start('host');
  const host = room.players.get('host');
  Object.assign(host, { hasRifle: true, magazine: 1, reserveAmmo: 30 });

  assert.equal(room.requestFire('host', { shotId: 'last-round', aim: 0 }), 'fired');
  assert.equal(host.magazine, 0);
  assert.equal(host.reloadEndsAt, now() + CONFIG.rifle.reloadMs);
  assert.ok(room.events.some((event) => event.type === 'reload_started' && event.reason === 'empty_magazine'));
  advance(CONFIG.rifle.reloadMs);
  room.finishReload(host, now());
  assert.equal(host.magazine, CONFIG.rifle.magazineSize);
  assert.equal(host.reserveAmmo, 0);

  host.magazine = 0;
  room.map.pickups = [{ id: 'ammo', kind: 'ammo', x: host.x, y: host.y, radius: 15 }];
  room.collectPickups(host, now());
  assert.equal(host.reserveAmmo, CONFIG.rifle.magazineSize);
  assert.ok(host.reloadEndsAt > now());
  assert.ok(room.events.some((event) => event.type === 'reload_started' && event.reason === 'ammo_pickup'));
});

test('firing an empty rifle emits feedback and starts reload when reserve ammo exists', () => {
  const { room, now } = controlledRoom(['host', 'rival']);
  room.start('host');
  const host = room.players.get('host');
  Object.assign(host, { hasRifle: true, magazine: 0, reserveAmmo: 30 });
  assert.equal(room.requestFire('host', { shotId: 'dry-1', aim: 1 }), 'empty');
  assert.equal(room.bullets.length, 0);
  assert.deepEqual(room.events.slice(-2).map((event) => event.type), ['empty_fire', 'reload_started']);
  assert.equal(room.events.at(-2).clientShotId, 'dry-1');
  assert.equal(host.reloadEndsAt, now() + CONFIG.rifle.reloadMs);
});

// Starting loot is finite, and a long match spends it. Survivors who cannot
// shoot each other leave the storm to decide the match, so ammunition keeps
// arriving while one is running.
test('ammunition keeps arriving once the arena runs low', () => {
  const { room, advance } = controlledRoom(['host', 'guest']);
  room.start('host');
  room.map.pickups = room.map.pickups.filter((pickup) => pickup.kind !== 'ammo');
  room.events.length = 0;

  const ammo = () => room.map.pickups.filter((pickup) => pickup.kind === 'ammo').length;
  assert.equal(ammo(), 0, 'the arena starts this test with nothing to shoot');

  for (let drop = 0; drop < 4; drop += 1) {
    advance(CONFIG.ammoDrop.intervalMs);
    room.tick(1 / CONFIG.tickRate);
  }
  assert.ok(ammo() > 0, 'ammunition should have been dropped in');

  // Clients keep their own loot list, so an arrival has to be announced.
  const announced = room.events.filter((event) => event.type === 'pickup_spawned');
  assert.equal(announced.length, ammo());
  for (const event of announced) {
    assert.equal(event.pickup.kind, 'ammo');
    assert.ok(room.map.pickups.some((pickup) => pickup.id === event.pickup.id));
  }
});

test('dropped ammunition lands in the closing zone and clear of cover', () => {
  const { room, advance } = controlledRoom(['host', 'guest']);
  room.start('host');
  room.map.pickups = room.map.pickups.filter((pickup) => pickup.kind !== 'ammo');

  let checked = 0;
  for (let drop = 0; drop < 12; drop += 1) {
    room.events.length = 0;
    advance(CONFIG.ammoDrop.intervalMs);
    room.tick(1 / CONFIG.tickRate);
    // Checked as each lands: the storm keeps shrinking, so a drop that was
    // correctly placed will later sit outside the zone it was aimed at.
    for (const event of room.events.filter((e) => e.type === 'pickup_spawned')) {
      const { pickup } = event;
      const target = room.storm.to;
      const distance = Math.hypot(pickup.x - target.x, pickup.y - target.y);
      assert.ok(distance <= target.radius,
        `drop ${pickup.id} landed ${Math.round(distance)} from a zone closing to ${Math.round(target.radius)}`);
      assert.ok(!room.map.obstacles.some((obstacle) => (
        pickup.x > obstacle.x && pickup.x < obstacle.x + obstacle.width
        && pickup.y > obstacle.y && pickup.y < obstacle.y + obstacle.height
      )), `drop ${pickup.id} landed inside cover`);
      checked += 1;
    }
  }
  assert.ok(checked > 0, 'expected at least one drop to inspect');
});

test('ammunition drops stop once enough is on the ground', () => {
  const { room, advance } = controlledRoom(['host', 'guest']);
  room.start('host');
  const living = [...room.players.values()].filter((player) => player.alive).length;
  const target = living * CONFIG.ammoDrop.perLivingPlayer;

  // Far more than the target, so nothing further is warranted.
  assert.ok(room.map.pickups.filter((p) => p.kind === 'ammo').length > target);
  const before = room.map.pickups.length;
  for (let drop = 0; drop < 6; drop += 1) {
    advance(CONFIG.ammoDrop.intervalMs);
    room.tick(1 / CONFIG.tickRate);
  }
  assert.equal(room.map.pickups.length, before, 'a well-stocked arena should get no drops');
});

test('a match needs two players and splits them into even sides', () => {
  const { room } = controlledRoom(['host']);
  assert.throws(() => room.start('host'), /At least 2 players/);

  const { room: full } = controlledRoom(['host', 'b', 'c', 'd', 'e']);
  full.start('host');
  const teams = [...full.players.values()].map((player) => player.team);
  const blue = teams.filter((team) => team === 'blue').length;
  assert.equal(teams.length, 5);
  assert.ok(Math.abs(blue - (teams.length - blue)) <= 1, `uneven split: ${teams}`);
  for (const player of full.players.values()) {
    assert.ok(CONFIG.teams[player.team].skins.includes(player.skin),
      'a player should wear their own side\'s colours');
  }
});

test('teams start on opposite sides of the arena', () => {
  const { room } = controlledRoom(['host', 'b', 'c', 'd']);
  room.start('host');
  for (const player of room.players.values()) {
    const onLeft = player.x < room.map.width / 2;
    assert.equal(onLeft, player.team === 'blue',
      `${player.team} player started at x=${player.x} on a ${room.map.width} map`);
  }
});

test('teammates cannot shoot each other but opponents can', () => {
  const { room } = controlledRoom(['host', 'b']);
  room.start('host');
  const [first, second] = [...room.players.values()];
  first.team = 'blue';
  second.team = 'blue';

  room.damage(second, 40, first.id, 'rifle');
  assert.equal(second.hp, CONFIG.maxHp, 'friendly fire should do nothing');

  second.team = 'red';
  room.damage(second, 40, first.id, 'rifle');
  assert.equal(second.hp, CONFIG.maxHp - 40, 'an opponent should take the hit');

  // The storm has no attacker and must still hurt.
  room.damage(second, 10, null, 'storm');
  assert.equal(second.hp, CONFIG.maxHp - 50);
});

test('a match ends when one side is wiped out, and the room restarts itself', () => {
  const { room, advance, now } = controlledRoom(['host', 'b', 'c', 'd']);
  room.start('host');
  const blue = [...room.players.values()].filter((p) => p.team === 'blue');
  const red = [...room.players.values()].filter((p) => p.team === 'red');

  for (const player of red) room.damage(player, CONFIG.maxHp, blue[0].id, 'rifle');
  room.tick(0);
  assert.equal(room.phase, 'ended');
  assert.equal(room.winningTeam, 'blue', 'the surviving side should win');

  assert.equal(room.restartIfDue(now()), null, 'should not restart before the delay');
  advance(CONFIG.restartDelayMs);
  const restarted = room.restartIfDue(now());
  assert.ok(restarted, 'the room should start the next match on its own');
  assert.equal(room.phase, 'playing');
  for (const player of room.players.values()) assert.equal(player.alive, true);
});

// Teams start against opposite edges, and the furthest of those positions sat
// outside a circle inscribed in the map, so players began matches already
// losing health. The opening circle now has to contain the arena's corners.
test('nobody starts a match outside the storm', () => {
  for (const size of [2, 8, 24]) {
    const ids = Array.from({ length: size }, (_, index) => (index === 0 ? 'host' : `p${index}`));
    const { room } = controlledRoom(ids);
    room.start('host');

    const opening = room.storm.from;
    const corner = Math.hypot(room.map.width, room.map.height) / 2;
    assert.ok(opening.radius >= corner,
      `opening circle ${Math.round(opening.radius)} must reach the corner at ${Math.round(corner)}`);

    for (const player of room.players.values()) {
      const distance = Math.hypot(player.x - opening.x, player.y - opening.y);
      assert.ok(distance <= opening.radius,
        `${size} players: one spawned ${Math.round(distance)} out in a ${Math.round(opening.radius)} circle`);
    }

    // Nobody should be taking damage on the first tick either.
    room.tick(1 / CONFIG.tickRate);
    for (const player of room.players.values()) {
      assert.equal(player.hp, CONFIG.maxHp, 'a player took storm damage at the start of a match');
    }
  }
});

// A room that cannot field two sides used to drop back to a lobby that still
// listed the players who had left. It showed enough players to enable the start
// button and never enough to actually start, which left whoever remained stuck
// in a room they could not play or leave.
test('a room with too few players left closes instead of stranding them', () => {
  const { room, advance, now } = controlledRoom(['host', 'guest']);
  room.start('host');
  room.damage(room.players.get('guest'), CONFIG.maxHp, 'host', 'rifle');
  room.tick(0);
  assert.equal(room.phase, 'ended');

  room.removePlayer('guest');
  advance(CONFIG.restartDelayMs);
  const outcome = room.restartIfDue(now());

  assert.equal(outcome?.type, 'room_closed');
  assert.equal(room.phase, 'closed');
  // Whoever left is off the roster, so nothing counts players who are not there.
  assert.equal(room.players.size, 1);
  assert.ok(room.players.has('host'));
});

test('a room with enough players still restarts, and rehosts if the host left', () => {
  const { room, advance, now } = controlledRoom(['host', 'guest', 'third']);
  room.start('host');
  for (const player of room.players.values()) player.team = player.id === 'host' ? 'red' : 'blue';
  room.damage(room.players.get('host'), CONFIG.maxHp, 'guest', 'rifle');
  room.tick(0);
  assert.equal(room.phase, 'ended');

  room.removePlayer('host');
  advance(CONFIG.restartDelayMs);
  const outcome = room.restartIfDue(now());

  assert.equal(outcome?.type, 'match_started');
  assert.equal(room.phase, 'playing');
  assert.equal(room.players.size, 2, 'the player who left should be gone');
  assert.ok(room.players.has(room.hostId), 'the room should have rehosted');
});

// Standing outside has to get worse as a match goes on, or a late stalemate can
// be waited out on the edge of the zone for the price of the opening cycle.
test('the storm hurts more with every cycle it closes', () => {
  const { room } = controlledRoom(['host', 'guest']);
  room.start('host');
  const host = room.players.get('host');

  const rateOn = (cycle) => {
    room.storm.cycle = cycle;
    return room.stormDamagePerSecond();
  };
  assert.equal(rateOn(1), CONFIG.storm.damagePerSecond);
  assert.equal(rateOn(2), CONFIG.storm.damagePerSecond + CONFIG.storm.damagePerSecondPerCycle);
  assert.equal(rateOn(5), CONFIG.storm.damagePerSecond + 4 * CONFIG.storm.damagePerSecondPerCycle);

  // And it is the rate actually applied, not just reported.
  room.storm.cycle = 4;
  const outside = room.currentStorm();
  host.x = outside.x + outside.radius + 500;
  host.y = outside.y;
  host.hp = CONFIG.maxHp;
  host.stormDamageCarry = 0;
  room.applyStormDamage(host, 1, room.now());
  assert.equal(CONFIG.maxHp - host.hp, room.stormDamagePerSecond(),
    'one second outside on cycle four should cost the cycle-four rate');

  // Anyone inside the zone is untouched however far the storm has closed.
  host.hp = CONFIG.maxHp;
  host.x = outside.x;
  host.y = outside.y;
  room.applyStormDamage(host, 1, room.now());
  assert.equal(host.hp, CONFIG.maxHp);
});
