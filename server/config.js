export const CONFIG = Object.freeze({
  tickRate: 30,
  snapshotRate: 15,
  maxRoomPlayers: 64,
  skinCount: 16,
  playerRadius: 16,
  playerSpeed: 225,
  // Velocity eases toward the input direction rather than snapping to it, so
  // starting and stopping carry weight. This is the rate of that approach, in
  // units of 1/second: ~95% of top speed after 3 / playerResponse seconds.
  // Higher is snappier, lower is more slippery.
  playerResponse: 12,
  // Each input a client sends is simulated as exactly one tick, so the client
  // can replay them and land on the same answer. Credits refill one per tick
  // and cap the burst, which is what stops a client sending inputs faster than
  // the tick rate from moving faster than everyone else.
  input: Object.freeze({
    queueLimit: 8,
    creditLimit: 6,
  }),
  maxHp: 100,
  rifle: Object.freeze({
    magazineSize: 30,
    damage: 5,
    fireIntervalMs: 120,
    reloadMs: 1_350,
    bulletSpeed: 920,
    bulletLifetimeMs: 900,
    spreadRadians: 0.035,
  }),
  flower: Object.freeze({
    startingHeal: 1,
    secondsPerHp: 2,
    maxHeal: 50,
  }),
  storm: Object.freeze({
    contractionMs: 60_000,
    holdMs: 10_000,
    damagePerSecond: 1,
    radiusScale: 0.58,
    minimumRadius: 105,
  }),
  map: Object.freeze({
    minimumSize: 1_550,
    sizePerExtraPlayer: 115,
    obstacleBase: 26,
    obstaclesPerPlayer: 4,
    spawnClearance: 90,
    corridorHalfWidth: 55,
  }),
});

