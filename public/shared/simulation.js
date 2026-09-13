// Movement simulation shared by the server and the browser client.
//
// The client predicts its own movement with this exact code and the server
// re-runs it as the authority. Any drift between the two shows up as a visible
// correction on the player's screen, so this file must stay free of anything
// that differs between environments: no Date.now(), no Math.random(), no
// server-only modules.

export const EMPTY_INPUT = Object.freeze({
  sequence: 0, up: false, down: false, left: false, right: false, firing: false, aim: 0,
});

export function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function resolveCircleRect(position, radius, rect) {
  const nearestX = clamp(position.x, rect.x, rect.x + rect.width);
  const nearestY = clamp(position.y, rect.y, rect.y + rect.height);
  const dx = position.x - nearestX;
  const dy = position.y - nearestY;
  const squared = dx * dx + dy * dy;
  if (squared >= radius * radius) return position;

  if (squared > 0.0001) {
    const distance = Math.sqrt(squared);
    const push = radius - distance;
    return { x: position.x + (dx / distance) * push, y: position.y + (dy / distance) * push };
  }

  const choices = [
    { gap: Math.abs(position.x - rect.x), x: rect.x - radius, y: position.y },
    { gap: Math.abs(position.x - (rect.x + rect.width)), x: rect.x + rect.width + radius, y: position.y },
    { gap: Math.abs(position.y - rect.y), x: position.x, y: rect.y - radius },
    { gap: Math.abs(position.y - (rect.y + rect.height)), x: position.x, y: rect.y + rect.height + radius },
  ].sort((a, b) => a.gap - b.gap);
  return { x: choices[0].x, y: choices[0].y };
}

// Coerces a raw input message from the wire into a well-formed input.
export function readInput(raw, previous = EMPTY_INPUT) {
  return {
    sequence: Number(raw.sequence) || 0,
    up: Boolean(raw.up),
    down: Boolean(raw.down),
    left: Boolean(raw.left),
    right: Boolean(raw.right),
    firing: Boolean(raw.firing),
    aim: Number.isFinite(raw.aim) ? raw.aim : previous.aim,
  };
}

// Advances a body {x, y, vx, vy} by one step under `input`, in place.
export function stepPlayer(body, input, config, map, deltaSeconds) {
  if (deltaSeconds <= 0) return body;
  let dx = Number(input.right) - Number(input.left);
  let dy = Number(input.down) - Number(input.up);
  const magnitude = Math.hypot(dx, dy);
  const targetVx = magnitude > 0 ? (dx / magnitude) * config.playerSpeed : 0;
  const targetVy = magnitude > 0 ? (dy / magnitude) * config.playerSpeed : 0;

  // Exact solution of dv/dt = response * (target - v). Solving it rather than
  // stepping it means top speed is the same at any tick length; a per-tick
  // impulse would make the cap drift with frame time.
  const decay = Math.exp(-config.playerResponse * deltaSeconds);
  body.vx = targetVx + (body.vx - targetVx) * decay;
  body.vy = targetVy + (body.vy - targetVy) * decay;

  const radius = config.playerRadius;
  const fromX = body.x;
  const fromY = body.y;
  let position = {
    x: clamp(body.x + body.vx * deltaSeconds, radius, map.width - radius),
    y: clamp(body.y + body.vy * deltaSeconds, radius, map.height - radius),
  };
  for (const obstacle of map.obstacles) {
    position = resolveCircleRect(position, radius, obstacle);
  }
  body.x = clamp(position.x, radius, map.width - radius);
  body.y = clamp(position.y, radius, map.height - radius);

  // Rebuild velocity from the distance actually travelled. Without this a
  // player held against a wall keeps accumulating speed and slingshots away
  // the moment they turn; this also preserves sliding along the wall.
  body.vx = (body.x - fromX) / deltaSeconds;
  body.vy = (body.y - fromY) / deltaSeconds;
  return body;
}
