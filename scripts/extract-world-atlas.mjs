// Copy the supplied art unchanged and describe its 256px tile cells.
// Run after updating the source sheet: node scripts/extract-world-atlas.mjs
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sourceDirectory = process.env.BLOOM_ART_DIR
  ?? 'C:/Users/rockl/Coding Projects/RockEngine/Domain/sandbox/assets/Content';
const outputDirectory = 'public/assets';
const rect = (x, y, w, h) => ({ x, y, w, h });

mkdirSync(outputDirectory, { recursive: true });
copyFileSync(join(sourceDirectory, 'Tileset with cell size 256x256.png'), join(outputDirectory, 'tiles.png'));

const atlas = {
  image: 'assets/tiles.png',
  size: [3648, 1792],
  cellSize: 256,
  items: {
    // The source's broad gray tile outlines are omitted from the floor crops;
    // the renderer spaces these interiors with a quiet half-unit seam instead.
    floor: rect(1542, 774, 244, 244),
    floorAlternate: rect(2054, 774, 244, 244),
    corridor: rect(1798, 774, 244, 244),
    wall: { ...rect(2304, 512, 512, 512), border: 8 },
    // Crop the empty black margin so the visible crate meets its collision box.
    crate: rect(12, 1548, 232, 232),
    ammo: rect(332, 1356, 104, 104),
    medical: rect(76, 1356, 104, 104),
    supply: rect(588, 1356, 104, 104),
  },
};

writeFileSync(join(outputDirectory, 'tiles.json'), `${JSON.stringify(atlas, null, 2)}\n`);
console.log('World atlas: 3 floor tiles, wall, crate, and 3 pickup icons.');
