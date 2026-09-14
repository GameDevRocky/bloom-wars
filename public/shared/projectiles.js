// Continuous collision helpers shared by authoritative simulation and visual extrapolation.
// A hit is a fraction of the segment [0, 1]; null means the path is clear.

export function segmentCircleHit(start, end, circle) {
  return segmentCircleHitTime(start, end, circle) !== null;
}

// Return the first point of contact as a fraction of the segment, or null.
// Testing the complete path prevents a fast projectile skipping thin cover.
export function segmentCircleHitTime(start, end, circle) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const offsetX = start.x - circle.x;
  const offsetY = start.y - circle.y;
  const c = offsetX * offsetX + offsetY * offsetY - circle.radius * circle.radius;
  if (c <= 0) return 0;
  const a = dx * dx + dy * dy;
  if (a === 0) return null;
  const b = offsetX * dx + offsetY * dy;
  const discriminant = b * b - a * c;
  if (discriminant < 0) return null;
  const time = (-b - Math.sqrt(discriminant)) / a;
  return time >= 0 && time <= 1 ? time : null;
}

export function segmentRectHitTime(start, end, rect) {
  let entry = 0;
  let exit = 1;
  for (const [axis, size] of [['x', 'width'], ['y', 'height']]) {
    const delta = end[axis] - start[axis];
    if (delta === 0) {
      if (start[axis] < rect[axis] || start[axis] > rect[axis] + rect[size]) return null;
      continue;
    }
    const a = (rect[axis] - start[axis]) / delta;
    const b = (rect[axis] + rect[size] - start[axis]) / delta;
    entry = Math.max(entry, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
    if (entry > exit) return null;
  }
  return entry;
}

// A swept circle meets a rectangle's faces or rounded corners. Using the
// rounded corners avoids invisible square collision padding around cover.
export function sweptCircleRectHitTime(start, end, radius, rect) {
  // Most cover is nowhere near this segment. Reject it without constructing
  // face/corner candidates, especially useful in large multiplayer arenas.
  if (Math.max(start.x, end.x) < rect.x - radius
    || Math.min(start.x, end.x) > rect.x + rect.width + radius
    || Math.max(start.y, end.y) < rect.y - radius
    || Math.min(start.y, end.y) > rect.y + rect.height + radius) return null;
  const candidates = [
    segmentRectHitTime(start, end, {
      x: rect.x - radius, y: rect.y, width: rect.width + radius * 2, height: rect.height,
    }),
    segmentRectHitTime(start, end, {
      x: rect.x, y: rect.y - radius, width: rect.width, height: rect.height + radius * 2,
    }),
  ];
  for (const x of [rect.x, rect.x + rect.width]) {
    for (const y of [rect.y, rect.y + rect.height]) {
      candidates.push(segmentCircleHitTime(start, end, { x, y, radius }));
    }
  }
  const hits = candidates.filter((time) => time !== null);
  return hits.length ? Math.min(...hits) : null;
}

export function segmentBoundsExitTime(start, end, width, height, radius = 0) {
  const bounds = { x: radius, y: radius, width: width - radius * 2, height: height - radius * 2 };
  if (start.x < bounds.x || start.x > width - radius || start.y < bounds.y || start.y > height - radius) return 0;
  let exit = null;
  for (const [axis, size] of [['x', 'width'], ['y', 'height']]) {
    const delta = end[axis] - start[axis];
    const low = bounds[axis];
    const high = low + bounds[size];
    let time = null;
    if (delta < 0 && end[axis] <= low) time = (low - start[axis]) / delta;
    if (delta > 0 && end[axis] >= high) time = (high - start[axis]) / delta;
    if (time !== null && (exit === null || time < exit)) exit = time;
  }
  return exit;
}
