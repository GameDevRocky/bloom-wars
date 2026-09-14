// All coordinates supplied to these helpers are world coordinates. camera is
// the viewport center in world units; width/height are CSS pixels, matching the
// game's worldToScreen transform. Context state is restored after every call.
const TILE_SIZE = 64;
const art = { image: null, atlas: null, ready: false };
let loading;

export function loadWorldArt() {
  if (loading) return loading;
  loading = (async () => {
    try {
      const response = await fetch(new URL('./assets/tiles.json', import.meta.url));
      if (!response.ok) throw new Error(`World atlas returned ${response.status}`);
      const atlas = await response.json();
      const image = new Image();
      image.src = new URL(atlas.image, import.meta.url).href;
      await image.decode();
      Object.assign(art, { image, atlas, ready: true });
      return true;
    } catch (error) {
      console.warn('World art unavailable; using the fallback floor and cover.', error);
      return false;
    }
  })();
  return loading;
}

function screenPoint(point, camera, scale, width, height) {
  return {
    x: (point.x - camera.x) * scale + width / 2,
    y: (point.y - camera.y) * scale + height / 2,
  };
}

function visibleRect(rect, camera, scale, width, height, padding = 12) {
  return rect.x + rect.width + padding >= camera.x - width / (2 * scale)
    && rect.x - padding <= camera.x + width / (2 * scale)
    && rect.y + rect.height + padding >= camera.y - height / (2 * scale)
    && rect.y - padding <= camera.y + height / (2 * scale);
}

function drawTile(context, tile, x, y, width, height) {
  context.drawImage(art.image, tile.x, tile.y, tile.w, tile.h, x, y, width, height);
}

export function drawWorldFloor(context, map, camera, scale, width, height) {
  context.save();
  context.fillStyle = '#10171e';
  context.fillRect(0, 0, width, height);
  if (!map || !(scale > 0)) {
    context.restore();
    return;
  }

  const topLeft = screenPoint({ x: 0, y: 0 }, camera, scale, width, height);
  context.beginPath();
  context.rect(topLeft.x, topLeft.y, map.width * scale, map.height * scale);
  context.clip();
  context.fillStyle = '#242c34';
  context.fillRect(topLeft.x, topLeft.y, map.width * scale, map.height * scale);

  // Anchor the grid to the center so the two lighter tile lanes follow the
  // map generator's guaranteed connected central corridors for every map size.
  const centerX = map.width / 2;
  const centerY = map.height / 2;
  const left = Math.max(0, camera.x - width / (2 * scale));
  const right = Math.min(map.width, camera.x + width / (2 * scale));
  const top = Math.max(0, camera.y - height / (2 * scale));
  const bottom = Math.min(map.height, camera.y + height / (2 * scale));
  const firstColumn = Math.floor((left - centerX) / TILE_SIZE);
  const lastColumn = Math.floor((right - centerX) / TILE_SIZE);
  const firstRow = Math.floor((top - centerY) / TILE_SIZE);
  const lastRow = Math.floor((bottom - centerY) / TILE_SIZE);
  const seam = 0.5 * scale;
  const tilePixels = TILE_SIZE * scale;

  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const world = { x: centerX + column * TILE_SIZE, y: centerY + row * TILE_SIZE };
      const screen = screenPoint(world, camera, scale, width, height);
      const corridor = (column === -1 || column === 0 || row === -1 || row === 0);
      // A stable, irregular selection avoids a conspicuous checkerboard.
      const alternate = ((Math.imul(column, 73856093) ^ Math.imul(row, 19349663)) >>> 0) % 5 === 0;
      if (art.ready) {
        const tile = corridor ? art.atlas.items.corridor
          : alternate ? art.atlas.items.floorAlternate : art.atlas.items.floor;
        context.globalAlpha = corridor ? 0.52 : 0.9;
        drawTile(context, tile, screen.x + seam, screen.y + seam, tilePixels - seam, tilePixels - seam);
      } else {
        context.fillStyle = corridor ? '#41474d' : alternate ? '#2b333b' : '#29313a';
        context.fillRect(screen.x + seam, screen.y + seam, tilePixels - seam, tilePixels - seam);
      }
    }
  }

  context.restore();
}

// Territory wash: blue owns the left half of the arena, red the right.
//
// Drawn after the lighting pass rather than with the floor. Lighting multiplies
// over the whole scene, so a tint laid down with the tiles is darkened along
// with them and all but disappears once ambient light is low.
export function drawTeamTint(context, map, camera, scale, width, height) {
  if (!map || !(scale > 0)) return;
  const topLeft = screenPoint({ x: 0, y: 0 }, camera, scale, width, height);
  const middle = topLeft.x + (map.width / 2) * scale;
  const right = topLeft.x + map.width * scale;
  const top = topLeft.y;
  const arenaHeight = map.height * scale;

  context.save();
  // Clipped to the arena so the wash stops at the border rather than colouring
  // the void beyond it.
  context.beginPath();
  context.rect(topLeft.x, top, map.width * scale, arenaHeight);
  context.clip();
  for (const [from, to, colour] of [
    [topLeft.x, middle, 'rgba(74, 143, 255, 0.10)'],
    [middle, right, 'rgba(255, 74, 84, 0.10)'],
  ]) {
    const span = to - from;
    if (span <= 0) continue;
    context.fillStyle = colour;
    context.fillRect(from, top, span, arenaHeight);
  }
  // A seam down the halfway line, so the border between the two is legible
  // even when both halves are off screen.
  if (middle > topLeft.x && middle < right) {
    context.fillStyle = 'rgba(233, 240, 250, 0.16)';
    context.fillRect(middle - Math.max(1, scale), top, Math.max(2, 2 * scale), arenaHeight);
  }
  context.restore();
}

function drawWall(context, x, y, width, height, scale) {
  if (!art.ready) {
    context.fillStyle = '#bba64c';
    context.fillRect(x, y, width, height);
    context.fillStyle = '#2b4357';
    context.fillRect(x + 2 * scale, y + 2 * scale, width - 4 * scale, height - 4 * scale);
    return;
  }

  // Nine-slice the source square, keeping its yellow outline equally thick on
  // narrow and wide cover. Every outer edge is exactly the collision rectangle.
  const tile = art.atlas.items.wall;
  const edge = Math.min(1.6 * scale, width / 3, height / 3);
  const sourceX = [tile.x, tile.x + tile.border, tile.x + tile.w - tile.border];
  const sourceY = [tile.y, tile.y + tile.border, tile.y + tile.h - tile.border];
  const sourceWidths = [tile.border, tile.w - 2 * tile.border, tile.border];
  const sourceHeights = [tile.border, tile.h - 2 * tile.border, tile.border];
  const targetX = [x, x + edge, x + width - edge];
  const targetY = [y, y + edge, y + height - edge];
  const targetWidths = [edge, width - 2 * edge, edge];
  const targetHeights = [edge, height - 2 * edge, edge];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      context.drawImage(art.image,
        sourceX[column], sourceY[row], sourceWidths[column], sourceHeights[row],
        targetX[column], targetY[row], targetWidths[column], targetHeights[row]);
    }
  }
}

function drawCrates(context, obstacle, x, y, width, height, scale) {
  context.fillStyle = '#5a3d29';
  context.fillRect(x, y, width, height);
  if (!art.ready) return;

  // A stack of small crates preserves the art's proportions while filling the
  // original solid rectangle; there are no apparent walkable gaps inside it.
  const columns = Math.max(1, Math.round(obstacle.width / 56));
  const rows = Math.max(1, Math.round(obstacle.height / 56));
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  const gap = 1.2 * scale;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const insetX = column === 0 ? 0 : gap;
      const insetY = row === 0 ? 0 : gap;
      drawTile(context, art.atlas.items.crate,
        x + column * cellWidth + insetX, y + row * cellHeight + insetY,
        cellWidth - insetX, cellHeight - insetY);
    }
  }
}

export function drawWorldObstacle(context, obstacle, camera, scale, width, height) {
  if (!(scale > 0) || !visibleRect(obstacle, camera, scale, width, height)) return;
  const position = screenPoint(obstacle, camera, scale, width, height);
  const obstacleWidth = obstacle.width * scale;
  const obstacleHeight = obstacle.height * scale;
  context.save();
  context.fillStyle = 'rgba(0, 0, 0, 0.3)';
  context.fillRect(position.x + 3 * scale, position.y + 5 * scale, obstacleWidth, obstacleHeight);
  if (obstacle.kind === 'rock') {
    drawCrates(context, obstacle, position.x, position.y, obstacleWidth, obstacleHeight, scale);
  } else {
    drawWall(context, position.x, position.y, obstacleWidth, obstacleHeight, scale);
  }
  context.restore();
}

export function drawWorldBorder(context, map, camera, scale, width, height) {
  if (!map || !(scale > 0)) return;
  const topLeft = screenPoint({ x: 0, y: 0 }, camera, scale, width, height);
  context.save();
  // The solid rim is inside the playable boundary, where the collision occurs.
  const rim = 3 * scale;
  context.lineWidth = rim;
  context.strokeStyle = '#bba14b';
  context.strokeRect(topLeft.x + rim / 2, topLeft.y + rim / 2,
    map.width * scale - rim, map.height * scale - rim);
  context.restore();
}
