// The assembled character aims east in local (forward, sideways) coordinates.
// Pin arms at their shoulders and hands instead of rotating their crop centers.
const SOURCE_TO_PLAYER = 34 / 300.55;
const SHEET_TURN = -Math.PI / 2;
const ARM_PIVOTS = {
  bent: { shoulder: [0.34, 0.18], hand: [0.7425, 0.8635] },
  long: { shoulder: [0.74, 0.16], hand: [0.1951, 0.8883] },
};

export function drawCharacter(context, player, radius, art, options = {}) {
  const variants = art.atlas.skins.variants;
  const variant = variants[((player.skin ?? 0) % variants.length + variants.length) % variants.length];
  const recoil = Math.max(0, Math.min(1, options.recoil ?? 0)) * 1.6;
  const stride = Math.max(-1, Math.min(1, options.stride ?? 0));

  context.save();
  context.rotate(player.aim);
  context.scale(radius / 16, radius / 16);

  const drawPart = (image, rect, forward, side, size = 1) => {
    context.save();
    context.translate(forward, side);
    context.rotate(SHEET_TURN);
    context.scale(SOURCE_TO_PLAYER * size, SOURCE_TO_PLAYER * size);
    context.drawImage(
      image, rect.x, rect.y, rect.w, rect.h,
      -rect.w / 2, -rect.h / 2, rect.w, rect.h,
    );
    context.restore();
  };

  const drawArm = (rect, pivots, shoulder, hand) => {
    const sourceX = (pivots.hand[0] - pivots.shoulder[0]) * rect.w;
    const sourceY = (pivots.hand[1] - pivots.shoulder[1]) * rect.h;
    const targetX = hand[0] - shoulder[0];
    const targetY = hand[1] - shoulder[1];
    const scale = Math.hypot(targetX, targetY) / Math.hypot(sourceX, sourceY);
    context.save();
    context.translate(...shoulder);
    context.rotate(Math.atan2(targetY, targetX) - Math.atan2(sourceY, sourceX));
    context.scale(scale, scale);
    context.drawImage(art.skins, rect.x, rect.y, rect.w, rect.h,
      -pivots.shoulder[0] * rect.w, -pivots.shoulder[1] * rect.h, rect.w, rect.h);
    context.restore();
  };

  // The bag sits behind the shoulders. The separate flat body sprite provides
  // the shoulder silhouette beneath the head; the bag never stands in for it.
  drawPart(art.skins, variant.backpack, -13, 0, 0.78);
  drawPart(art.skins, variant.body, -2, 0);

  if (player.hasRifle) {
    // Keep the muzzle at the server's forward=34, side=1.75 attachment. The
    // support hand stays on the far foregrip and the bent arm on the near grip.
    drawPart(art.weapons, art.atlas.weapons.items.rifle,
      132.55 * SOURCE_TO_PLAYER - recoil, 15.49 * SOURCE_TO_PLAYER);
    drawArm(variant.armLong, ARM_PIVOTS.long, [-3, -9], [21.5 - recoil, -1.2]);
    drawArm(variant.armBent, ARM_PIVOTS.bent, [-3, 9], [11.5 - recoil, 4.5]);
  } else {
    // Rest each hand outside its own shoulder. They stay apart at every aim
    // angle, including during the small opposing walking swing.
    drawArm(variant.armLong, ARM_PIVOTS.long, [-3, -9], [12 + stride, -14]);
    drawArm(variant.armBent, ARM_PIVOTS.bent, [-3, 9], [10 - stride, 14]);
  }

  drawPart(art.skins, variant.head, 2.11 * SOURCE_TO_PLAYER, 3.23 * SOURCE_TO_PLAYER);
  context.restore();
}
