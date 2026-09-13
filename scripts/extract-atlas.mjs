// Derives sprite rectangles from the character and weapon sheets by finding
// connected runs of opaque pixels, then writes public/assets/atlas.json.
//
// The sheets are hand-laid-out: cells are close to a 4x4 grid but not exact, so
// assuming a fixed pitch clips sprites. Detection avoids that entirely.
//
// Requires ffmpeg on PATH. Run it only when the source sheets change:
//   node scripts/extract-atlas.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_DIR = process.env.BLOOM_ART_DIR
  ?? "C:/Users/rockl/Coding Projects/RockEngine/Domain/sandbox/assets/Content";
const OUT_DIR = "public/assets";
const ALPHA_THRESHOLD = 16;
const MIN_AREA = 400;

function readPixels(file) {
  const probe = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0", file,
  ]).toString().trim();
  const [width, height] = probe.split(",").map(Number);
  const raw = execFileSync("ffmpeg", [
    "-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-",
  ], { maxBuffer: 1 << 30 });
  return { width, height, raw };
}

// Iterative flood fill: these sheets are ~5.7M pixels, deep enough to blow the
// call stack with recursion.
function findComponents({ width, height, raw }) {
  const seen = new Uint8Array(width * height);
  const components = [];
  const stack = [];

  for (let start = 0; start < width * height; start += 1) {
    if (seen[start] || raw[start * 4 + 3] < ALPHA_THRESHOLD) continue;
    let minX = width, minY = height, maxX = -1, maxY = -1, area = 0;
    stack.push(start);
    seen[start] = 1;

    while (stack.length > 0) {
      const index = stack.pop();
      const x = index % width;
      const y = (index - x) / width;
      area += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (seen[next] || raw[next * 4 + 3] < ALPHA_THRESHOLD) continue;
          seen[next] = 1;
          stack.push(next);
        }
      }
    }

    if (area >= MIN_AREA) {
      components.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area });
    }
  }
  return { width, height, components };
}

// Parts within one skin cell, left to right: [torso over legs], head, bent arm,
// straight arm. Torso and legs share a column, so they split on y.
function classifySkin(parts) {
  const byX = [...parts].sort((a, b) => a.x - b.x);
  const [first, second] = byX.slice(0, 2).sort((a, b) => a.y - b.y);
  const rest = byX.slice(2);
  return { torso: first, legs: second, head: rest[0], armBent: rest[1], armLong: rest[2] };
}

const skinSheet = findComponents(readPixels(join(SOURCE_DIR, "Skins.png")));
const cellWidth = skinSheet.width / 4;
const cellHeight = skinSheet.height / 4;
const cells = new Map();
for (const part of skinSheet.components) {
  const column = Math.min(3, Math.floor((part.x + part.w / 2) / cellWidth));
  const row = Math.min(3, Math.floor((part.y + part.h / 2) / cellHeight));
  const key = row * 4 + column;
  if (!cells.has(key)) cells.set(key, []);
  cells.get(key).push(part);
}

const skins = [...cells.entries()]
  .sort((a, b) => a[0] - b[0])
  .filter(([, parts]) => parts.length >= 5)
  .map(([, parts]) => classifySkin(parts));

const weaponSheet = findComponents(readPixels(join(SOURCE_DIR, "Weapons.png")));
// Left to right on the sheet. "rifle" is the dark assault rifle the character
// carries; "sniper" is the orange long gun.
const weaponNames = ["canister", "grenade", "magazine", "rifle", "sniper"];
const weapons = Object.fromEntries(
  weaponSheet.components
    .sort((a, b) => a.x - b.x)
    .slice(0, weaponNames.length)
    .map((rect, index) => [weaponNames[index], rect]),
);

mkdirSync(OUT_DIR, { recursive: true });
const atlas = {
  skins: { image: "assets/skins.png", size: [skinSheet.width, skinSheet.height], variants: skins },
  weapons: { image: "assets/weapons.png", size: [weaponSheet.width, weaponSheet.height], items: weapons },
};
writeFileSync(join(OUT_DIR, "atlas.json"), `${JSON.stringify(atlas, null, 2)}\n`);

console.log(`skins: ${skins.length} variants from ${skinSheet.components.length} parts`);
console.log(`weapons: ${Object.keys(weapons).length} of ${weaponSheet.components.length} parts`);
for (const [name, rect] of Object.entries(weapons)) {
  console.log(`  ${name.padEnd(9)} ${rect.w}x${rect.h} @ ${rect.x},${rect.y}`);
}
