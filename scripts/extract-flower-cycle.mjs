// Cuts public/assets/flower-cycle.png into one image per growth stage, trimmed
// to its own artwork so the HUD can scale each without inheriting the wide
// transparent margins of the source sheet.
//
// Requires ffmpeg on PATH. Run only when the source art changes:
//   node scripts/extract-flower-cycle.mjs
import { execFileSync } from "node:child_process";

const SOURCE = "public/assets/flower-cycle.png";
const STAGES = ["seed", "budding", "bloomed"];
const ALPHA_THRESHOLD = 24;
const MIN_AREA = 200;

const [width, height] = execFileSync("ffprobe", [
  "-v", "error", "-select_streams", "v:0",
  "-show_entries", "stream=width,height", "-of", "csv=p=0", SOURCE,
]).toString().trim().split(",").map(Number);

const raw = execFileSync("ffmpeg", [
  "-v", "error", "-i", SOURCE, "-f", "rawvideo", "-pix_fmt", "rgba", "-",
], { maxBuffer: 1 << 30 });

// The three stages are separated by clear vertical gaps, so opaque columns are
// enough to find them; no need for full connected-component labelling.
const columnHasArt = new Uint8Array(width);
for (let x = 0; x < width; x += 1) {
  for (let y = 0; y < height; y += 1) {
    if (raw[(y * width + x) * 4 + 3] >= ALPHA_THRESHOLD) { columnHasArt[x] = 1; break; }
  }
}

const spans = [];
let start = -1;
for (let x = 0; x <= width; x += 1) {
  if (x < width && columnHasArt[x]) { if (start < 0) start = x; }
  else if (start >= 0) { spans.push([start, x - 1]); start = -1; }
}

const rects = spans.map(([x0, x1]) => {
  let top = height;
  let bottom = -1;
  for (let x = x0; x <= x1; x += 1) {
    for (let y = 0; y < height; y += 1) {
      if (raw[(y * width + x) * 4 + 3] < ALPHA_THRESHOLD) continue;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return { x: x0, y: top, w: x1 - x0 + 1, h: bottom - top + 1 };
}).filter((rect) => rect.w * rect.h >= MIN_AREA);

if (rects.length !== STAGES.length) {
  throw new Error(`expected ${STAGES.length} stages in ${SOURCE}, found ${rects.length}`);
}

// These are HUD icons a few dozen pixels across. Shipping the full-resolution
// crops would cost a third of a megabyte to draw a flower the size of a thumb.
const MAX_EDGE = 128;

// Left to right is youngest to oldest in the source sheet.
rects.forEach((rect, index) => {
  const out = `public/assets/flower-${STAGES[index]}.png`;
  const longest = Math.max(rect.w, rect.h);
  // Stages keep their relative sizes: a seed should look small beside a bloom.
  const scale = Math.min(1, MAX_EDGE / longest);
  const outWidth = Math.max(1, Math.round(rect.w * scale));
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-i", SOURCE,
    "-vf", `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y},scale=${outWidth}:-1:flags=lanczos`,
    out,
  ]);
  console.log(`${STAGES[index].padEnd(8)} ${rect.w}x${rect.h} -> ${outWidth}px  ${out}`);
});
