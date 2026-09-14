import { sweptCircleRectHitTime, segmentBoundsExitTime, segmentCircleHitTime } from './shared/projectiles.js';
import { obstacleGridFor } from './shared/obstacle-grid.js';

const TRAIL_FLIGHT_MS = 90;
const TRAIL_FADE_MS = 120;

// Sample the same world-space path for both the projectile and its trail. A
// late joiner has no path before the first received position, even if the shot
// was born much earlier; never invent a tail behind that known position.
function positionAt(track, time, map, radius, blockers = null) {
  let before = null;
  let after = null;
  for (const sample of track.samples) {
    if (sample.at <= time) before = sample;
    else { after = sample; break; }
  }
  if (!before) return null;
  let position;
  let extrapolated = false;
  if (after) {
    const ratio = Math.max(0, Math.min(1, (time - before.at) / (after.at - before.at)));
    position = { x: before.x + (after.x - before.x) * ratio, y: before.y + (after.y - before.y) * ratio };
  } else {
    // A projectile holds constant velocity for its whole flight, so carrying it
    // forward from the last known sample is exact rather than a guess. Capping
    // that would strand a shot in mid-air -- a locally predicted one never gets
    // another sample at all, so it would simply stop a few hundred units out.
    // Shots the server has ended are removed by their impact event or by the
    // missing-track timeout, not by running out of extrapolation.
    const seconds = Math.max(0, time - before.at) / 1_000;
    position = { x: before.x + before.vx * seconds, y: before.y + before.vy * seconds };
    extrapolated = true;
  }
  // Even during a late packet, visual extrapolation stops at solid cover.
  // Only the server's impact event decides damage and the impact effect.
  if (map && (position.x !== before.x || position.y !== before.y)) {
    let fraction = segmentBoundsExitTime(before, position, map.width, map.height, radius) ?? 1;
    obstacleGridFor(map).forEachAlong(before, position, radius, (obstacle) => {
      fraction = Math.min(fraction, sweptCircleRectHitTime(before, position, radius, obstacle) ?? 1);
    });
    // Stop at a body the same way the server does, but only while guessing
    // ahead of known data. Between two received positions the server has
    // already told us the shot travelled that far, so anyone it passed was a
    // genuine miss and clipping there would stall bullets on near misses.
    if (extrapolated && blockers) {
      for (const blocker of blockers.targets) {
        if (!blocker.alive || blocker.id === track.ownerId) continue;
        const hit = segmentCircleHitTime(before, position, {
          x: blocker.x, y: blocker.y, radius: blockers.radius + radius,
        });
        if (hit !== null) fraction = Math.min(fraction, hit);
      }
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

  predictShot({ clientShotId, ownerId, x, y, vx, vy, at }) {
    const id = `predicted:${clientShotId}`;
    this.tracks.set(id, {
      id, clientShotId, ownerId, predicted: true, localImmediate: true,
      bornAt: at, samples: [{ x, y, vx, vy, at }],
    });
    return id;
  }

  rejectPrediction(clientShotId) {
    this.tracks.delete(`predicted:${clientShotId}`);
  }

  receive(snapshot, arrival) {
    const localTime = (serverTime) => arrival + serverTime - snapshot.serverTime;
    for (const event of snapshot.events ?? []) {
      if (event.type !== 'shot' && event.type !== 'bullet_impact') continue;
      const id = event.bulletId;
      let track = this.tracks.get(id);
      if (!track && event.type === 'shot' && event.clientShotId) {
        const predictedId = `predicted:${event.clientShotId}`;
        track = this.tracks.get(predictedId);
        if (track) {
          this.tracks.delete(predictedId);
          track.id = id;
          track.predicted = false;
          this.tracks.set(id, track);
        }
      }
      if (!track) {
        track = { id, ownerId: event.ownerId, samples: [], bornAt: Infinity };
        this.tracks.set(id, track);
      }
      if (event.type === 'shot') {
        const authoritativeBornAt = localTime(event.spawnedAt);
        track.bornAt = Math.min(track.bornAt, authoritativeBornAt);
        // A confirmed prediction keeps its immediate local birth time while
        // adopting the server's spread. The server player is behind the local
        // movement prediction by network transit time, so replacing the local
        // muzzle here would visibly rewind every shot while the player moves.
        if (track.localImmediate) {
          const predictedMuzzle = track.samples[0];
          track.samples = [{
            ...event,
            x: predictedMuzzle.x,
            y: predictedMuzzle.y,
            at: track.bornAt,
          }];
        }
        else track.samples.push({ ...event, at: authoritativeBornAt });
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
      // A locally predicted projectile has constant velocity, so its confirmed
      // launch sample is sufficient. Server position samples originate from an
      // older player transform and would drag the visual projectile backward.
      // The authoritative impact event still ends it at the real collision.
      if (!track.localImmediate) track.samples.push({ ...bullet, at });
      track.missingAt = null;
    }
    for (const [id, track] of this.tracks) {
      track.samples.sort((a, b) => a.at - b.at);
      // Retain enough history for delayed playback without retaining an entire
      // cross-map flight in memory.
      while (track.samples.length > 2 && track.samples[1].at < arrival - 1_000) track.samples.shift();
      if (!live.has(id) && !track.impact) {
        // Give an unconfirmed local shot enough time for a slow round trip.
        if (!track.predicted || arrival - track.bornAt > 600) track.missingAt ??= arrival;
      }
      const endedAt = track.impact?.at ?? track.missingAt;
      if (endedAt != null && arrival - endedAt > 1_000) this.tracks.delete(id);
    }
  }

  frame(time, map, radius = 2, { immediateOwnerId = null, immediateTime = time, blockers = null } = {}) {
    const bullets = [];
    const impacts = [];
    const trails = [];
    for (const track of this.tracks.values()) {
      const trackTime = track.localImmediate && track.ownerId === immediateOwnerId ? immediateTime : time;
      const impactAge = trackTime - (track.impact?.at ?? Infinity);
      if (impactAge >= 0 && impactAge < 180) impacts.push({ ...track.impact, age: impactAge });
      if (trackTime < track.bornAt || impactAge >= TRAIL_FADE_MS) continue;
      if (!track.impact && track.missingAt != null && trackTime > track.missingAt + 250) continue;
      // Freeze the final segment at contact, then fade it without moving its
      // tail. This also preserves shots that start and end between snapshots.
      const flightTime = impactAge >= 0 ? track.impact.at : trackTime;
      const head = positionAt(track, flightTime, map, radius, blockers);
      if (!head) continue;
      const tailTime = Math.max(track.bornAt, track.samples[0].at, flightTime - TRAIL_FLIGHT_MS);
      const tail = positionAt(track, tailTime, map, radius, blockers);
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
