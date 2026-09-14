// How much wider the arena is than the original single garden. Three is the
// largest that still squeezes players together on the storm's second cycle:
// at four the safe zone needs a third contraction, pushing first contact past
// three minutes. Cover and loot are placed per unit of area, so changing this
// resizes the world without thinning it out.
const WORLD_SCALE = 3;

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
    bulletSpeed: 1_840,
    bulletRadius: 2,
    // Local aim coordinates, shared with the assembled character renderer.
    // Positive side is to the right of the barrel in screen coordinates.
    muzzleForward: 34,
    muzzleSide: 1.75,
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
    maxBoundarySpeedRatio: 0.65,
  }),
  map: Object.freeze({
    // Twenty times the previous width and height; player and tile sizes stay
    // in world units so this adds explorable space instead of zooming the view.
    worldScale: WORLD_SCALE,
    minimumSize: 1_550 * WORLD_SCALE,
    sizePerExtraPlayer: 115 * WORLD_SCALE,
    // Densities per million square units, so cover and loot stay as thick at
    // the far edge of the arena as they are at the middle. One screen is
    // roughly two million square units, which puts about twelve pieces of
    // cover and one item in view.
    obstaclesPerMillion: 6,
    pickupsPerMillion: Object.freeze({ rifle: 0.12, ammo: 0.3, seed: 0.14 }),
    // Ceilings on what one match may contain. The arena widens with population
    // while these densities are per unit of area, so without a cap the contents
    // grow with the square of the player count: a full room would ask for over
    // a hundred thousand obstacles and a multi-megabyte map message. Past the
    // cap the arena stays evenly covered, just more thinly.
    maxObstacles: 14_000,
    maxPickups: 1_400,
    spawnClearance: 90,
    corridorHalfWidth: 55,
  }),
});
