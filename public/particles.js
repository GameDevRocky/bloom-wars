// Drifting motes of pollen and dust. Purely decorative and purely local: the
// server never sees them, so two players watching the same spot see different
// motes, and nothing here can affect play.

const COUNT = 90;
// Kept a little wider than the viewport so motes drift in from off-screen
// instead of appearing at the edge.
const MARGIN = 60;

function spawn(random, bounds) {
  return {
    x: bounds.left + random() * bounds.width,
    y: bounds.top + random() * bounds.height,
    // Mostly horizontal drift, as if on a slow draught.
    vx: (random() - 0.5) * 13,
    vy: (random() - 0.5) * 9 - 3,
    radius: 0.7 + random() * 1.9,
    alpha: 0.16 + random() * 0.3,
    // Offsets the sway and the twinkle so the field never pulses in unison.
    phase: random() * Math.PI * 2,
    sway: 4 + random() * 11,
  };
}

export class Particles {
  constructor(random = Math.random) {
    this.random = random;
    this.particles = [];
    this.elapsed = 0;
  }

  // The world rectangle currently on screen, padded by MARGIN.
  bounds(camera, scale, width, height) {
    const halfWidth = width / (2 * scale) + MARGIN;
    const halfHeight = height / (2 * scale) + MARGIN;
    return {
      left: camera.x - halfWidth,
      top: camera.y - halfHeight,
      width: halfWidth * 2,
      height: halfHeight * 2,
    };
  }

  update(delta, camera, scale, width, height) {
    if (!(scale > 0)) return;
    this.elapsed += delta;
    const bounds = this.bounds(camera, scale, width, height);
    while (this.particles.length < COUNT) this.particles.push(spawn(this.random, bounds));

    for (const particle of this.particles) {
      particle.x += particle.vx * delta;
      particle.y += particle.vy * delta;
      // Recycle rather than allocate: a mote that leaves the view, or that the
      // camera outruns, reappears somewhere else in the padded rectangle.
      if (particle.x < bounds.left || particle.x > bounds.left + bounds.width
        || particle.y < bounds.top || particle.y > bounds.top + bounds.height) {
        Object.assign(particle, spawn(this.random, bounds));
      }
    }
  }

  draw(context, camera, scale, width, height) {
    if (!(scale > 0) || this.particles.length === 0) return;
    context.save();
    context.fillStyle = '#d8e4c8';
    for (const particle of this.particles) {
      const drift = Math.sin(this.elapsed * 0.8 + particle.phase) * particle.sway;
      const x = (particle.x + drift - camera.x) * scale + width / 2;
      const y = (particle.y - camera.y) * scale + height / 2;
      const twinkle = 0.65 + 0.35 * Math.sin(this.elapsed * 1.7 + particle.phase);
      context.globalAlpha = particle.alpha * twinkle;
      context.beginPath();
      context.arc(x, y, Math.max(0.6, particle.radius * scale), 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  }
}
