// A uniform grid over the arena's cover, so the work of a query scales with the
// obstacles near it rather than with every obstacle in the world.
//
// Bullet collision, light occlusion and map generation all previously walked
// the whole obstacle list. That is affordable for a few dozen pieces of cover
// and not for the tens of thousands an evenly populated arena needs: a single
// tick would otherwise test every live bullet against every obstacle.

const DEFAULT_CELL = 256;

export class ObstacleGrid {
  constructor(obstacles = [], width = 0, height = 0, cellSize = DEFAULT_CELL) {
    this.obstacles = obstacles;
    this.cellSize = Math.max(32, cellSize);
    this.columns = Math.max(1, Math.ceil(width / this.cellSize));
    this.rows = Math.max(1, Math.ceil(height / this.cellSize));
    this.cells = new Map();
    // Marks obstacles already yielded by the current query, so cover spanning
    // several cells is still only reported once without allocating a Set per call.
    this.stamps = new Int32Array(obstacles.length);
    this.stamp = 0;
    for (let index = 0; index < obstacles.length; index += 1) this.insert(index, obstacles[index]);
  }

  cellRange(minX, minY, maxX, maxY) {
    return {
      x0: Math.max(0, Math.floor(minX / this.cellSize)),
      y0: Math.max(0, Math.floor(minY / this.cellSize)),
      x1: Math.min(this.columns - 1, Math.floor(maxX / this.cellSize)),
      y1: Math.min(this.rows - 1, Math.floor(maxY / this.cellSize)),
    };
  }

  insert(index, rect) {
    const { x0, y0, x1, y1 } = this.cellRange(rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const key = y * this.columns + x;
        let bucket = this.cells.get(key);
        if (!bucket) { bucket = []; this.cells.set(key, bucket); }
        bucket.push(index);
      }
    }
  }

  // Visits every obstacle whose cell overlaps the box, at most once each.
  forEachInBox(minX, minY, maxX, maxY, visit) {
    const { x0, y0, x1, y1 } = this.cellRange(minX, minY, maxX, maxY);
    this.stamp += 1;
    const stamp = this.stamp;
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const bucket = this.cells.get(y * this.columns + x);
        if (!bucket) continue;
        for (const index of bucket) {
          if (this.stamps[index] === stamp) continue;
          this.stamps[index] = stamp;
          visit(this.obstacles[index]);
        }
      }
    }
  }

  // Cover that could intersect the travel of a circle of `padding` radius.
  forEachAlong(start, end, padding, visit) {
    this.forEachInBox(
      Math.min(start.x, end.x) - padding,
      Math.min(start.y, end.y) - padding,
      Math.max(start.x, end.x) + padding,
      Math.max(start.y, end.y) + padding,
      visit,
    );
  }

  forEachAround(point, radius, visit) {
    this.forEachInBox(point.x - radius, point.y - radius, point.x + radius, point.y + radius, visit);
  }

  collectAround(point, radius) {
    const found = [];
    this.forEachAround(point, radius, (obstacle) => found.push(obstacle));
    return found;
  }
}

// Grids are keyed off the map object so callers can ask for one without
// threading construction through every layer; a regenerated map gets a new one.
const cache = new WeakMap();

export function obstacleGridFor(map) {
  if (!map) return null;
  let grid = cache.get(map);
  if (!grid || grid.obstacles !== map.obstacles) {
    grid = new ObstacleGrid(map.obstacles, map.width, map.height);
    cache.set(map, grid);
  }
  return grid;
}
