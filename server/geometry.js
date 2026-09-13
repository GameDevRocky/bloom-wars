import { clamp } from '../public/shared/simulation.js';

export { clamp, resolveCircleRect } from '../public/shared/simulation.js';

export function distanceSquared(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function circleIntersectsRect(circle, rect, padding = 0) {
  const nearestX = clamp(circle.x, rect.x - padding, rect.x + rect.width + padding);
  const nearestY = clamp(circle.y, rect.y - padding, rect.y + rect.height + padding);
  const dx = circle.x - nearestX;
  const dy = circle.y - nearestY;
  return dx * dx + dy * dy < circle.radius * circle.radius;
}

export function pointInsideRect(point, rect, padding = 0) {
  return point.x >= rect.x - padding
    && point.x <= rect.x + rect.width + padding
    && point.y >= rect.y - padding
    && point.y <= rect.y + rect.height + padding;
}

export function segmentCircleHit(start, end, circle) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distanceSquared(start, circle) <= circle.radius * circle.radius;
  const projection = clamp(
    ((circle.x - start.x) * dx + (circle.y - start.y) * dy) / lengthSquared,
    0,
    1,
  );
  const nearest = { x: start.x + projection * dx, y: start.y + projection * dy };
  return distanceSquared(nearest, circle) <= circle.radius * circle.radius;
}
