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

export {
  segmentCircleHit, segmentCircleHitTime, segmentRectHitTime,
  sweptCircleRectHitTime, segmentBoundsExitTime,
} from '../public/shared/projectiles.js';
