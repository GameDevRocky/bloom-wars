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
  minRoomPlayers: 2,
  skinCount: 16,
  teams: Object.freeze({
    blue: Object.freeze({ id: 'blue', name: 'Blue', side: -1, skins: Object.freeze([1, 4, 15, 11]) }),
    red: Object.freeze({ id: 'red', name: 'Red', side: 1, skins: Object.freeze([2, 10, 13, 0]) }),
  }),
  // How long the result is shown before the room restarts on its own.
  restartDelayMs: 10_000,
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
    // Everyone starts armed, so the opening minutes are about position rather
    // than a scramble to find a weapon. A spare magazine covers the first
    // engagement; anything beyond that still has to be scavenged.
    startingReserveAmmo: 30,
  }),
  flower: Object.freeze({
    startingHeal: 1,
    secondsPerHp: 2,
    maxHeal: 50,
  }),
  // Ammunition keeps arriving during a match. However much is scattered at the
  // start, a long fight can still spend all of it, and a room of survivors who
  // cannot shoot each other has no way to end except by the storm.
  ammoDrop: Object.freeze({
    intervalMs: 9_000,
    // Live ammo pickups to keep available, as a multiple of living players.
    perLivingPlayer: 3,
    // Drops land inside the safe zone: loot in the storm is loot nobody can
    // reach. Kept off the very edge, which is about to close anyway.
    zoneFraction: 0.82,
    placementAttempts: 24,
  }),
  storm: Object.freeze({
    contractionMs: 60_000,
    holdMs: 10_000,
    damagePerSecond: 1,
    // Added to the above for every cycle the storm has already closed, so
    // staying outside late in a match costs far more than it did early on and
    // a stalemate cannot be waited out on the edge of the zone.
    damagePerSecondPerCycle: 1,
    radiusScale: 0.58,
    minimumRadius: 105,
    maxBoundarySpeedRatio: 0.65,
    // Slack on the opening circle, which is sized to the arena's half-diagonal
    // so every corner is inside it at the start of a match.
    openingMargin: 1.02,
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
    // Loot guaranteed per player, whichever is the greater of this and the
    // density above. Winning an eight-player match means roughly a hundred and
    // forty hits landed, so the old four magazines each ran a match dry long
    // before it was decided.
    pickupsPerPlayer: Object.freeze({ rifle: 5, ammo: 20, seed: 1 }),
    pickupFloor: Object.freeze({ rifle: 5, ammo: 20, seed: 6 }),
    // Ceilings on what one match may contain. The arena widens with population
    // while these densities are per unit of area, so without a cap the contents
    // grow with the square of the player count: a full room would ask for over
    // a hundred thousand obstacles and a multi-megabyte map message. Past the
    // cap the arena stays evenly covered, just more thinly.
    maxObstacles: 14_000,
    maxPickups: 4_000,
    spawnClearance: 90,
    corridorHalfWidth: 55,
    // Teams start against opposite edges, spread down their own side. Eight
    // players used to share one small ring in the middle and open fire
    // instantly; a side each gives them room to arm themselves first.
    teamSpawnInset: 0.12,
    teamSpawnSpread: 0.62,
  }),
});
