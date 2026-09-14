import { sweptCircleRectHitTime, segmentBoundsExitTime } from './shared/projectiles.js';

const TRAIL_FLIGHT_MS = 90;
const TRAIL_FADE_MS = 120;

// Sample the same world-space path for both the projectile and its trail. A
// late joiner has no path before the first received position, even if the shot
// was born much earlier; never invent a tail behind that known position.
function positionAt(track, time, map, radius) {
  let before = null;
  let after = null;
  for (const sample of track.samples) {
    if (sample.at <= time) before = sample;
    else { after = sample; break; }
  }
  if (!before) return null;
  let position;
  if (after) {
    const ratio = Math.max(0, Math.min(1, (time - before.at) / (after.at - before.at)));
    position = { x: before.x + (after.x - before.x) * ratio, y: before.y + (after.y - before.y) * ratio };
  } else {
    const seconds = Math.min(250, Math.max(0, time - before.at)) / 1_000;
    position = { x: before.x + before.vx * seconds, y: before.y + before.vy * seconds };
  }
  // Even during a late packet, visual extrapolation stops at solid cover.
  // Only the server's impact event decides damage and the impact effect.
  if (map && (position.x !== before.x || position.y !== before.y)) {
    let fraction = segmentBoundsExitTime(before, position, map.width, map.height, radius) ?? 1;
    for (const obstacle of map.obstacles) {
      fraction = Math.min(fraction, sweptCircleRectHitTime(before, position, radius, obstacle) ?? 1);
    }
    position = { x: before.x + (position.x - before.x) * fraction, y: before.y + (position.y - before.y) * fraction };
  }
  return { ...before, ...position };
}

// Keep shot and impact endpoints, including shots that live for less than one
// snapshot. Removing a bullet from a snapshot must not erase its final flight.
export class ProjectilePlayback {
  constructor() { this.tracks = new Map(); }

  clear() { this.tracks.clear(); }

  receive(snapshot, arrival) {
    const localTime = (serverTime) => arrival + serverTime - snapshot.serverTime;
    for (const event of snapshot.events ?? []) {
      if (event.type !== 'shot' && event.type !== 'bullet_impact') continue;
      const id = event.bulletId;
      let track = this.tracks.get(id);
      if (!track) {
        track = { id, ownerId: event.ownerId, samples: [], bornAt: Infinity };
        this.tracks.set(id, track);
      }
      if (event.type === 'shot') {
        track.bornAt = localTime(event.spawnedAt);
        track.samples.push({ ...event, at: track.bornAt });
      } else {
        track.impact = { ...event, at: localTime(event.impactedAt) };
        track.samples.push(track.impact);
      }
    }
    const live = new Set();
    for (const bullet of snapshot.bullets ?? []) {
      live.add(bullet.id);
      let track = this.tracks.get(bullet.id);
      if (!track) {
        track = {
          id: bullet.id, ownerId: bullet.ownerId, samples: [],
          bornAt: localTime(bullet.spawnedAt ?? bullet.updatedAt ?? snapshot.serverTime),
        };
        this.tracks.set(bullet.id, track);
      }
      const at = localTime(bullet.updatedAt ?? snapshot.serverTime);
      track.bornAt = Math.min(track.bornAt, at);
      track.samples.push({ ...bullet, at });
      track.missingAt = null;
    }
    for (const [id, track] of this.tracks) {
      track.samples.sort((a, b) => a.at - b.at);
      // Retain enough history for delayed playback without retaining an entire
      // cross-map flight in memory.
      while (track.samples.length > 2 && track.samples[1].at < arrival - 1_000) track.samples.shift();
      if (!live.has(id) && !track.impact) track.missingAt ??= arrival;
      const endedAt = track.impact?.at ?? track.missingAt;
      if (endedAt != null && arrival - endedAt > 1_000) this.tracks.delete(id);
    }
  }

  frame(time, map, radius = 2) {
    const bullets = [];
    const impacts = [];
    const trails = [];
    for (const track of this.tracks.values()) {
      const impactAge = time - (track.impact?.at ?? Infinity);
      if (impactAge >= 0 && impactAge < 180) impacts.push({ ...track.impact, age: impactAge });
      if (time < track.bornAt || impactAge >= TRAIL_FADE_MS) continue;
      if (!track.impact && track.missingAt != null && time > track.missingAt + 250) continue;
      // Freeze the final segment at contact, then fade it without moving its
      // tail. This also preserves shots that start and end between snapshots.
      const flightTime = impactAge >= 0 ? track.impact.at : time;
      const head = positionAt(track, flightTime, map, radius);
      if (!head) continue;
      const tailTime = Math.max(track.bornAt, track.samples[0].at, flightTime - TRAIL_FLIGHT_MS);
      const tail = positionAt(track, tailTime, map, radius);
      if (tail && Math.hypot(head.x - tail.x, head.y - tail.y) > 0.001) {
        trails.push({
          id: track.id, x1: tail.x, y1: tail.y, x2: head.x, y2: head.y,
          alpha: impactAge >= 0 ? 1 - impactAge / TRAIL_FADE_MS : 1,
        });
      }
      if (impactAge < 0) bullets.push({ ...head, id: track.id, ownerId: track.ownerId });
    }
    return { bullets, impacts, trails };
  }

  shotAge(ownerId, time) {
    let age = Infinity;
    for (const track of this.tracks.values()) {
      if (track.ownerId === ownerId && time >= track.bornAt) age = Math.min(age, time - track.bornAt);
    }
    return age;
  }
}
