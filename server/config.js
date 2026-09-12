export const CONFIG = Object.freeze({
  tickRate: 30,
  snapshotRate: 15,
  maxRoomPlayers: 64,
  playerRadius: 16,
  playerSpeed: 225,
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

