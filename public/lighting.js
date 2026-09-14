import { segmentRectHitTime, segmentBoundsExitTime, sweptCircleRectHitTime } from './shared/projectiles.js';
import { obstacleGridFor } from './shared/obstacle-grid.js';

export function clippedMuzzle(player, rifle, map) {
  const cos = Math.cos(player.aim), sin = Math.sin(player.aim);
  const end = {
    x: player.x + rifle.muzzleForward * cos - rifle.muzzleSide * sin,
    y: player.y + rifle.muzzleForward * sin + rifle.muzzleSide * cos,
  };
  let fraction = segmentBoundsExitTime(player, end, map.width, map.height, rifle.bulletRadius) ?? 1;
  obstacleGridFor(map).forEachAlong(player, end, rifle.bulletRadius, (obstacle) => {
    fraction = Math.min(fraction, sweptCircleRectHitTime(player, end, rifle.bulletRadius, obstacle) ?? 1);
  });
  return { x: player.x + (end.x - player.x) * fraction, y: player.y + (end.y - player.y) * fraction };
}

// A light stops at the same rectangular cover and arena bounds as gameplay.
// Corner rays keep hard shadow edges stable as the player moves and aims.
export function lightVisibility(origin, radius, map) {
  const obstacles = obstacleGridFor(map).collectAround(origin, radius).filter((rect) => {
    const x = Math.max(rect.x, Math.min(origin.x, rect.x + rect.width));
    const y = Math.max(rect.y, Math.min(origin.y, rect.y + rect.height));
    return (origin.x - x) ** 2 + (origin.y - y) ** 2 <= radius ** 2;
  });
  const angles = Array.from({ length: 64 }, (_, i) => -Math.PI + i * Math.PI / 32);
  for (const rect of obstacles) {
    for (const x of [rect.x, rect.x + rect.width]) {
      for (const y of [rect.y, rect.y + rect.height]) {
        const angle = Math.atan2(y - origin.y, x - origin.x);
        angles.push(angle - 0.0001, angle, angle + 0.0001);
      }
    }
  }
  angles.sort((a, b) => a - b);
  return angles.map((angle) => {
    const end = { x: origin.x + Math.cos(angle) * radius, y: origin.y + Math.sin(angle) * radius };
    let fraction = segmentBoundsExitTime(origin, end, map.width, map.height) ?? 1;
    for (const obstacle of obstacles) fraction = Math.min(fraction, segmentRectHitTime(origin, end, obstacle) ?? 1);
    return { x: origin.x + (end.x - origin.x) * fraction, y: origin.y + (end.y - origin.y) * fraction };
  });
}

// Ambient light, multiplied over the world. This is the only thing lighting an
// unarmed player, who casts none of their own, so it sets how dark the game can
// go before the opening of a match stops being playable.
const AMBIENT = '#4a5468';

export class WorldLighting {
  constructor() {
    this.surface = null;
    this.context = null;
  }

  draw(context, { map, camera, scale, width, height, players, pickups, impacts, focusId, rifle, shotAge }) {
    if (!map || !(scale > 0)) return;
    if (!this.surface) {
      this.surface = document.createElement('canvas');
      this.context = this.surface.getContext('2d');
    }
    // Allocate for the viewport, never for the enormous world. Lighting can
    // run at half resolution while characters and HUD keep their full detail.
    const resolution = 0.5;
    const bufferWidth = Math.max(1, Math.ceil(width * resolution));
    const bufferHeight = Math.max(1, Math.ceil(height * resolution));
    if (this.surface.width !== bufferWidth || this.surface.height !== bufferHeight) {
      this.surface.width = bufferWidth;
      this.surface.height = bufferHeight;
    }
    const lightContext = this.context;
    lightContext.setTransform(resolution, 0, 0, resolution, 0, 0);
    lightContext.globalCompositeOperation = 'source-over';
    lightContext.fillStyle = AMBIENT;
    lightContext.fillRect(0, 0, width, height);
    lightContext.globalCompositeOperation = 'lighter';

    const screen = (point) => ({ x: (point.x - camera.x) * scale + width / 2, y: (point.y - camera.y) * scale + height / 2 });
    const visible = (point, radius) => Math.abs(point.x - camera.x) < width / (2 * scale) + radius
      && Math.abs(point.y - camera.y) < height / (2 * scale) + radius;
    const distance = (point) => (point.x - camera.x) ** 2 + (point.y - camera.y) ** 2;
    const glows = [];

    const paintLight = (light) => {
      if (!visible(light, light.radius)) return;
      const polygon = lightVisibility(light, light.radius, map).map(screen);
      const position = screen(light);
      lightContext.save();
      lightContext.beginPath();
      for (let i = 0; i < polygon.length; i += 1) {
        const point = polygon[i];
        if (i === 0) lightContext.moveTo(point.x, point.y);
        else lightContext.lineTo(point.x, point.y);
      }
      lightContext.closePath();
      lightContext.clip();

      const radial = (radius, color, strength) => {
        const r = radius * scale;
        const gradient = lightContext.createRadialGradient(position.x, position.y, 0, position.x, position.y, r);
        gradient.addColorStop(0, `rgba(${color},${strength})`);
        gradient.addColorStop(0.3, `rgba(${color},${strength * 0.7})`);
        gradient.addColorStop(1, `rgba(${color},0)`);
        lightContext.fillStyle = gradient;
        lightContext.fillRect(position.x - r, position.y - r, 2 * r, 2 * r);
      };
      // halo: null means the light has no glow of its own and is purely the
      // aimed cone below, so a player carries a torch rather than wearing one.
      if (light.halo !== null) radial(light.halo ?? light.radius, light.color, light.strength);
      if (light.aim !== undefined) {
        lightContext.save();
        lightContext.beginPath();
        lightContext.moveTo(position.x, position.y);
        lightContext.arc(position.x, position.y, light.radius * scale, light.aim - 0.38, light.aim + 0.38);
        lightContext.closePath();
        lightContext.clip();
        radial(light.radius, '175, 153, 115', 0.92);
        lightContext.restore();
      }
      lightContext.restore();
      if (light.glow) glows.push({ ...light, polygon, position });
    };

    // Keep lighting work bounded even with a crowded room or sustained fire.
    const nearbyPlayers = players.filter((player) => player.alive && visible(player, 380))
      .sort((a, b) => Number(b.id === focusId) - Number(a.id === focusId) || distance(a) - distance(b)).slice(0, 6);
    for (const player of nearbyPlayers) {
      // Only an armed player lights anything, and only along the barrel.
      // Unarmed players are lit by ambient alone.
      if (!player.hasRifle) continue;
      paintLight({ ...player, radius: 380, halo: null,
        color: '137, 157, 180', strength: 0.95, aim: player.aim });
      const age = shotAge(player.id);
      if (player.hasRifle && age >= 0 && age < 95) {
        paintLight({
          ...clippedMuzzle(player, rifle, map),
          radius: 155, color: '255, 176, 78', strength: (1 - age / 95) * 1.5, glow: 0.22,
        });
      }
    }
    for (const pickup of pickups.filter((item) => visible(item, 70)).sort((a, b) => distance(a) - distance(b)).slice(0, 10)) {
      paintLight({ ...pickup, radius: pickup.kind === 'seed' ? 70 : 52,
        color: pickup.kind === 'seed' ? '220, 77, 116' : '173, 154, 96', strength: 0.48, glow: 0.055 });
    }
    for (const impact of impacts.filter((item) => item.age < 150 && visible(item, 85)).slice(0, 8)) {
      paintLight({ ...impact, radius: 85, color: impact.hit === 'player' ? '255, 95, 122' : '255, 178, 81',
        strength: (1 - impact.age / 150) * 1.3, glow: 0.18 });
    }

    context.save();
    context.globalCompositeOperation = 'multiply';
    context.drawImage(this.surface, 0, 0, width, height);
    // Local bloom adds colored illumination to nearby floor tiles, rather
    // than only making the small muzzle or pickup sprite glow by itself.
    context.globalCompositeOperation = 'screen';
    for (const light of glows) {
      context.save();
      context.beginPath();
      light.polygon.forEach((point, i) => i ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
      context.closePath();
      context.clip();
      const radius = light.radius * scale * 0.65;
      const gradient = context.createRadialGradient(light.position.x, light.position.y, 0, light.position.x, light.position.y, radius);
      gradient.addColorStop(0, `rgba(${light.color},${light.glow * Math.min(1, light.strength)})`);
      gradient.addColorStop(1, `rgba(${light.color},0)`);
      context.fillStyle = gradient;
      context.fillRect(light.position.x - radius, light.position.y - radius, radius * 2, radius * 2);
      context.restore();
    }
    context.restore();
  }
}
