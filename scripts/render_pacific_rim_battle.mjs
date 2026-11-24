import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Usage: place next to a checkout of https://github.com/patch-gg/pixelfx
// or set PIXELFX_DIR=/path/to/pixelfx before running:
//   PIXELFX_DIR=./pixelfx node scripts/render_pacific_rim_battle.mjs
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PIXELFX_DIR = process.env.PIXELFX_DIR ? path.resolve(process.env.PIXELFX_DIR) : path.resolve(REPO_ROOT, "pixelfx");

const { createFrame, clearFrame, createFx, composite, PAL } = await import(path.join(PIXELFX_DIR, "src/core/index.js"));
const chargeUp = await import(path.join(PIXELFX_DIR, "src/fx/lightning/charge-up.js"));
const thunderclap = await import(path.join(PIXELFX_DIR, "src/fx/lightning/thunderclap.js"));
const plasmaExplosion = await import(path.join(PIXELFX_DIR, "src/fx/explosions/plasma-explosion.js"));
const smallExplosion = await import(path.join(PIXELFX_DIR, "src/fx/explosions/small-explosion.js"));
const bigExplosion = await import(path.join(PIXELFX_DIR, "src/fx/explosions/big-explosion.js"));
const groundSlam = await import(path.join(PIXELFX_DIR, "src/fx/impacts/ground-slam.js"));
const swordSlash = await import(path.join(PIXELFX_DIR, "src/fx/melee/sword-slash.js"));
const spinSlash = await import(path.join(PIXELFX_DIR, "src/fx/melee/spin-slash.js"));
const homingMissile = await import(path.join(PIXELFX_DIR, "src/fx/projectiles/homing-missile.js"));
const empBlast = await import(path.join(PIXELFX_DIR, "src/fx/scifi/emp-blast.js"));
const arcaneBeam = await import(path.join(PIXELFX_DIR, "src/fx/arcane/arcane-beam.js"));

const JAEGER_SHEET = path.join(REPO_ROOT, "assets/sprites/jaeger_hd_8frame_sheet_2048x256.png");
const KAIJU_SHEET = path.join(REPO_ROOT, "assets/sprites/kaiju_hd_12frame_sheet_3072x256.png");

const OUT_MP4 = path.join(REPO_ROOT, "assets/previews/pacific_rim_pixelfx_battle.mp4");
const OUT_GIF = path.join(REPO_ROOT, "assets/previews/pacific_rim_pixelfx_battle.gif");
const OUT_BOARD = path.join(REPO_ROOT, "assets/previews/pacific_rim_pixelfx_storyboard.png");

// Arena logical pixel resolution (16:9 widescreen, upscaled 2x nearest-neighbor -> 960x540 HD!)
const W = 480;
const H = 270;
const FLOOR_Y = 232;
const FPS = 24;
const DURATION = 11.2;
const TOTAL_FRAMES = Math.round(FPS * DURATION);

// Load sprite sheets scaled cleanly to 164x164 per frame (keeps crisp detail + gives huge room for pixelfx explosions & beams!)
const SPR = 164;
function loadSheetFrames(path, count) {
  const raw = execFileSync("ffmpeg", [
    "-v", "error", "-i", path,
    "-vf", `scale=${SPR * count}:${SPR}:flags=lanczos`,
    "-f", "rawvideo", "-pix_fmt", "rgba", "-"
  ], { maxBuffer: 64 * 1024 * 1024 });

  const frames = [];
  for (let i = 0; i < count; i++) {
    const f = new Uint32Array(SPR * SPR);
    for (let y = 0; y < SPR; y++) {
      for (let x = 0; x < SPR; x++) {
        const off = (y * (SPR * count) + (i * SPR + x)) * 4;
        const r = raw[off], g = raw[off + 1], b = raw[off + 2], a = raw[off + 3];
        if (a >= 115) {
          f[y * SPR + x] = (255 << 24) | (b << 16) | (g << 8) | r;
        }
      }
    }
    frames.push(f);
  }
  return frames;
}

console.log("Loading HD Jaeger (8f) and Kaiju (12f) sheets...");
const jaegerFrames = loadSheetFrames(JAEGER_SHEET, 8);
const kaijuFrames = loadSheetFrames(KAIJU_SHEET, 12);

// Build atmospheric Pacific Rim night-harbor / battle-deck pixel background (Uint32Array ABGR)
function makeArenaBg() {
  const bg = new Uint32Array(W * H);
  const set = (x, y, r, g, b) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    bg[y * W + x] = (255 << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255);
  };
  // Stormy night sky gradient
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (y < FLOOR_Y - 14) {
        const t = y / (FLOOR_Y - 14);
        const r = Math.round(7 + 10 * t);
        const g = Math.round(12 + 16 * t);
        const b = Math.round(24 + 26 * t);
        set(x, y, r, g, b);
      } else if (y < FLOOR_Y) {
        // Distant dark ocean horizon band
        const t = (y - (FLOOR_Y - 14)) / 14;
        const ripple = ((x + y * 5) % 19 === 0) ? 10 : 0;
        set(x, y, 8 + ripple, 18 + Math.round(8 * t) + ripple, 34 + Math.round(12 * t) + ripple);
      } else {
        // Battle deck concrete/metal floor with perspective grid lines
        const dy = y - FLOOR_Y;
        const shade = Math.max(0, 1 - dy / (H - FLOOR_Y));
        const r = Math.round(18 + 12 * shade);
        const g = Math.round(24 + 16 * shade);
        const b = Math.round(36 + 22 * shade);
        set(x, y, r, g, b);
      }
    }
  }
  // Distant Hong Kong / harbor city skyline silhouettes with tiny lit windows
  const towers = [
    [12, 34, 62], [50, 26, 88], [82, 42, 54], [134, 22, 74], [164, 38, 48],
    [290, 30, 68], [326, 24, 94], [358, 44, 58], [410, 28, 78], [444, 32, 52]
  ];
  for (const [tx, tw, th] of towers) {
    const top = FLOOR_Y - 14 - th;
    for (let y = top; y < FLOOR_Y - 14; y++) {
      for (let x = tx; x < tx + tw; x++) {
        set(x, y, 10, 16, 28);
        if ((y - top) % 5 === 2 && (x - tx) % 4 === 1 && ((x * 7 + y * 13) % 5 === 0)) {
          const warm = (x + y) % 3 === 0;
          set(x, y, warm ? 95 : 42, warm ? 72 : 92, warm ? 38 : 115);
        }
      }
    }
  }
  // Deck rim highlight & perspective tiles
  for (let x = 0; x < W; x++) {
    set(x, FLOOR_Y, 54, 92, 128);
    set(x, FLOOR_Y + 1, 28, 48, 70);
  }
  for (let y = FLOOR_Y + 2; y < H; y++) {
    if ((y - FLOOR_Y) % 10 === 0) {
      for (let x = 0; x < W; x++) set(x, y, 28, 40, 58);
    }
  }
  return bg;
}

const arenaBg = makeArenaBg();

// Blit a 164x164 sprite frame directly into pixelfx frame.color with optional horizontal flip & white hit-flash
function blitSprite(frame, sprBuf, cx, footY, flipX = false, flashWhite = false) {
  // In our 256x256 sheet, feet sit at y=244 -> scaled to SPR=164, feet sit at y=156
  const footOffset = Math.round((244 / 256) * SPR);
  const anchorOffset = Math.round((114 / 256) * SPR);
  const ox = Math.round(cx - (flipX ? (SPR - anchorOffset) : anchorOffset));
  const oy = Math.round(footY - footOffset);

  for (let y = 0; y < SPR; y++) {
    const dy = oy + y;
    if (dy < 0 || dy >= frame.h) continue;
    const rowOff = dy * frame.w;
    for (let x = 0; x < SPR; x++) {
      const sx = flipX ? (SPR - 1 - x) : x;
      const col = sprBuf[y * SPR + sx];
      if (col === 0) continue;
      const dx = ox + x;
      if (dx < 0 || dx >= frame.w) continue;
      if (flashWhite) {
        const r = Math.min(255, ((col & 255) + 170));
        const g = Math.min(255, (((col >> 8) & 255) + 170));
        const b = Math.min(255, (((col >> 16) & 255) + 170));
        frame.color[rowOff + dx] = (255 << 24) | (b << 16) | (g << 8) | r;
      } else {
        frame.color[rowOff + dx] = col;
      }
    }
  }
}

// Keyframe track helper for smooth fighter position & pose choreography
function sampleTrack(track, t) {
  let prev = track[0];
  for (let i = 1; i < track.length; i++) {
    if (t < track[i].t) {
      const next = track[i];
      const u = Math.max(0, Math.min(1, (t - prev.t) / Math.max(0.0001, next.t - prev.t)));
      // Smoothstep for x/y, discrete for frame index
      const s = u * u * (3 - 2 * u);
      return {
        f: prev.f,
        x: prev.x + (next.x - prev.x) * s,
        y: prev.y + (next.y - prev.y) * s,
        flash: !!prev.flash
      };
    }
    prev = track[i];
  }
  return { f: prev.f, x: prev.x, y: prev.y, flash: !!prev.flash };
}

// === CHOREOGRAPHY (11.2 seconds of non-stop Pacific Rim action!) ===
// Jaeger (left, facing right, frames 0..7):
// 0=stance, 1=overdrive, 2=rocket ignition, 3=fire charge, 4=rocket punch, 5=dual swords deploy, 6=fiery sword slash, 7=follow-through
const jaegerTrack = [
  { t: 0.00, f: 0, x: 138, y: FLOOR_Y },
  { t: 0.50, f: 1, x: 138, y: FLOOR_Y }, // Reactor overdrive!
  { t: 1.40, f: 2, x: 134, y: FLOOR_Y }, // Elbow rocket ignition
  { t: 2.00, f: 3, x: 130, y: FLOOR_Y }, // Fire gauntlets charged
  { t: 2.55, f: 4, x: 186, y: FLOOR_Y }, // ROCKET PUNCH LUNGE!
  { t: 3.10, f: 4, x: 188, y: FLOOR_Y },
  { t: 3.60, f: 0, x: 152, y: FLOOR_Y }, // Step back
  { t: 4.55, f: 0, x: 146, y: FLOOR_Y, flash: true }, // Hit by Kaiju slash!
  { t: 4.75, f: 0, x: 132, y: FLOOR_Y },
  { t: 5.20, f: 0, x: 126, y: FLOOR_Y, flash: true }, // Hit by Kaiju uppercut!
  { t: 5.45, f: 0, x: 122, y: FLOOR_Y },
  { t: 6.15, f: 1, x: 112, y: FLOOR_Y, flash: true }, // Knocked back by Ground Slam!
  { t: 6.45, f: 1, x: 118, y: FLOOR_Y },
  { t: 6.95, f: 5, x: 138, y: FLOOR_Y }, // Deploys DUAL CHAIN SWORDS!
  { t: 7.45, f: 6, x: 186, y: FLOOR_Y }, // FIERY SWORD SLASH!
  { t: 7.95, f: 7, x: 192, y: FLOOR_Y }, // Follow-through
  { t: 8.35, f: 3, x: 162, y: FLOOR_Y }, // Final overdrive charge!
  { t: 8.85, f: 4, x: 176, y: FLOOR_Y }, // FINAL PLASMA/FIRE BEAM CLASH!
  { t: 9.55, f: 4, x: 168, y: FLOOR_Y, flash: true },
  { t: 9.85, f: 7, x: 146, y: FLOOR_Y }, // Braces through mega explosion
  { t: 10.45, f: 0, x: 140, y: FLOOR_Y }, // Standing tall in smoke
  { t: 11.20, f: 0, x: 140, y: FLOOR_Y },
];

// Kaiju (right, flipped facing left, frames 0..11):
// 0=stance, 1=lightning charge, 2=roar, 3=charged arm lunge, 4=overhead orb, 5=giant crescent slash, 6=rising uppercut, 7=twin claw apex, 8=leap, 9=plasma slam, 10=mist, 11=recover
const kaijuTrack = [
  { t: 0.00, f: 0, x: 342, y: FLOOR_Y },
  { t: 0.40, f: 1, x: 342, y: FLOOR_Y }, // Bioluminescent charge
  { t: 0.90, f: 2, x: 342, y: FLOOR_Y }, // PLASMA ROAR!
  { t: 1.75, f: 3, x: 334, y: FLOOR_Y }, // Coiled
  { t: 2.60, f: 1, x: 348, y: FLOOR_Y, flash: true }, // Takes Jaeger Rocket Punch!
  { t: 2.95, f: 0, x: 358, y: FLOOR_Y },
  { t: 3.30, f: 1, x: 360, y: FLOOR_Y, flash: true }, // Hit by homing missile!
  { t: 3.65, f: 3, x: 336, y: FLOOR_Y }, // Counter-attack charge!
  { t: 4.10, f: 4, x: 312, y: FLOOR_Y }, // Overhead plasma orb
  { t: 4.50, f: 5, x: 288, y: FLOOR_Y }, // GIANT CYAN CRESCENT SLASH!
  { t: 5.05, f: 6, x: 282, y: FLOOR_Y }, // RISING UPPERCUT SLASH!
  { t: 5.45, f: 7, x: 286, y: FLOOR_Y }, // Twin-claw lightning apex
  { t: 5.75, f: 8, x: 274, y: FLOOR_Y - 14 }, // LEAP!
  { t: 6.10, f: 9, x: 266, y: FLOOR_Y }, // CATACLYSMIC GROUND SLAM!
  { t: 6.75, f: 10, x: 278, y: FLOOR_Y }, // Smoking mist
  { t: 7.45, f: 10, x: 298, y: FLOOR_Y, flash: true }, // Hit by Jaeger Chain Sword!
  { t: 7.80, f: 11, x: 318, y: FLOOR_Y },
  { t: 8.30, f: 2, x: 326, y: FLOOR_Y }, // Final roar overdrive!
  { t: 8.85, f: 9, x: 314, y: FLOOR_Y }, // FINAL EMP / PLASMA CLASH!
  { t: 9.55, f: 10, x: 334, y: FLOOR_Y, flash: true },
  { t: 9.95, f: 10, x: 342, y: FLOOR_Y },
  { t: 10.50, f: 11, x: 342, y: FLOOR_Y },
  { t: 11.20, f: 0, x: 342, y: FLOOR_Y },
];

// === PIXELFX EVENT SCHEDULE (real pixelfx code-generated VFX with back/front layers & additive light!) ===
const fxEvents = [
  // Act 1: Dual Power-Up!
  { t: 0.45, mod: chargeUp, opts: { x: 142, y: FLOOR_Y - 58, palette: PAL.fire, light: 1.2, seed: 11 } },
  { t: 0.55, mod: chargeUp, opts: { x: 336, y: FLOOR_Y - 58, flip: true, palette: PAL.ice, light: 1.25, seed: 22 } },

  // Act 2: Jaeger Rocket Punch + Homing Missile Barrage!
  { t: 1.50, mod: homingMissile, opts: { x: 348, y: FLOOR_Y - 46, seed: 33, light: 1.1 } },
  { t: 2.55, mod: smallExplosion, opts: { x: 270, y: FLOOR_Y - 50, palette: PAL.fire, light: 1.35, seed: 44 } },
  { t: 2.60, mod: groundSlam, opts: { x: 252, y: FLOOR_Y, light: 0.9, seed: 45 } },

  // Act 3: Kaiju Twin-Claw Plasma Frenzy + Thunderclap Ground Slam!
  { t: 4.48, mod: swordSlash, opts: { x: 235, y: FLOOR_Y - 56, flip: true, palette: PAL.ice, light: 1.4, seed: 55 } },
  { t: 5.05, mod: spinSlash, opts: { x: 220, y: FLOOR_Y - 52, flip: true, palette: PAL.electric, light: 1.3, seed: 56 } },
  { t: 6.10, mod: groundSlam, opts: { x: 245, y: FLOOR_Y, light: 1.2, seed: 66 } },
  { t: 6.12, mod: thunderclap, opts: { x: 245, y: FLOOR_Y - 12, palette: PAL.ice, light: 1.4, seed: 67 } },
  { t: 6.18, mod: plasmaExplosion, opts: { x: 245, y: FLOOR_Y - 36, palette: PAL.ice, light: 1.35, seed: 68 } },

  // Act 4: Jaeger Dual Chain Sword + Final Beam/EMP Clash + Mega Explosion!
  { t: 7.42, mod: swordSlash, opts: { x: 248, y: FLOOR_Y - 54, palette: PAL.fire, light: 1.45, seed: 77 } },
  { t: 7.50, mod: smallExplosion, opts: { x: 282, y: FLOOR_Y - 44, palette: PAL.fire, light: 1.25, seed: 78 } },
  { t: 8.80, mod: arcaneBeam, opts: { x: 196, y: FLOOR_Y - 62, palette: PAL.fire, light: 1.45, seed: 88 }, stopAt: 9.55 },
  { t: 8.85, mod: empBlast, opts: { x: 276, y: FLOOR_Y - 54, palette: PAL.ice, light: 1.4, seed: 89 } },
  { t: 9.35, mod: bigExplosion, opts: { x: 244, y: FLOOR_Y, light: 1.45, seed: 99 } },
];

// Camera shake impulses (start time, duration, amplitude px)
const shakes = [
  { t: 0.95, d: 0.35, amp: 3 },
  { t: 2.55, d: 0.35, amp: 7 },
  { t: 3.30, d: 0.25, amp: 5 },
  { t: 4.50, d: 0.30, amp: 6 },
  { t: 5.05, d: 0.25, amp: 5 },
  { t: 6.10, d: 0.50, amp: 9 },
  { t: 7.45, d: 0.30, amp: 6 },
  { t: 9.35, d: 0.70, amp: 11 },
];

// Hit-stop freeze windows (start time, duration) for authentic arcade fighting game punch!
const hitStops = [
  { t: 2.58, d: 0.12 },
  { t: 6.14, d: 0.14 },
  { t: 7.46, d: 0.10 },
  { t: 9.40, d: 0.14 },
];

function getShake(t) {
  let sx = 0, sy = 0;
  for (const s of shakes) {
    if (t >= s.t && t < s.t + s.d) {
      const k = 1 - (t - s.t) / s.d;
      const amp = s.amp * k * k;
      sx += Math.round(Math.sin(t * 97 + s.t * 31) * amp);
      sy += Math.round(Math.cos(t * 113 + s.t * 17) * amp);
    }
  }
  return [sx, sy];
}

function inHitStop(t) {
  for (const h of hitStops) {
    if (t >= h.t && t < h.t + h.d) return true;
  }
  return false;
}

// Spawn ffmpeg to write 960x540 HD MP4 directly from stdin raw RGBA
console.log(`Rendering ${TOTAL_FRAMES} frames (${DURATION}s @ ${FPS}fps) with pixelfx...`);
const ff = spawn("ffmpeg", [
  "-y", "-v", "error",
  "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-",
  "-vf", "scale=960:540:flags=neighbor",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-preset", "fast",
  OUT_MP4
]);
ff.stderr.on("data", (d) => process.stderr.write(d));

const frame = createFrame(W, H, 0, 0);
const outRgba = new Uint8ClampedArray(W * H * 4);
const shiftedRgba = new Uint8ClampedArray(W * H * 4);

const activeFx = [];
let nextEv = 0;
let simT = 0;
const dt = 1 / FPS;

// Capture 6 key storyboard moments for visual inspection!
const boardTimes = [1.05, 2.65, 4.58, 6.22, 7.52, 9.52];
const boardFrames = [];
let nextBoard = 0;

for (let fi = 0; fi < TOTAL_FRAMES; fi++) {
  const realT = fi * dt;
  const frozen = inHitStop(realT);

  if (!frozen) {
    // Trigger any scheduled pixelfx
    while (nextEv < fxEvents.length && fxEvents[nextEv].t <= simT + 1e-6) {
      const ev = fxEvents[nextEv++];
      const inst = createFx(ev.mod, ev.opts);
      activeFx.push({ inst, stopAt: ev.stopAt ?? Infinity });
    }
    // Step all active pixelfx
    for (let i = activeFx.length - 1; i >= 0; i--) {
      const a = activeFx[i];
      if (simT >= a.stopAt) {
        a.inst.stop();
        a.stopAt = Infinity;
      }
      a.inst.update(dt);
      if (a.inst.done()) activeFx.splice(i, 1);
    }
    simT += dt;
  }

  // Render composite: back pixelfx -> HD Jaeger & Kaiju sprites -> front pixelfx -> additive light glow!
  clearFrame(frame);
  for (const a of activeFx) a.inst.draw(frame, "back");

  const j = sampleTrack(jaegerTrack, simT);
  const k = sampleTrack(kaijuTrack, simT);
  blitSprite(frame, jaegerFrames[j.f], j.x, j.y, false, j.flash);
  blitSprite(frame, kaijuFrames[k.f], k.x, k.y, true, k.flash);

  for (const a of activeFx) a.inst.draw(frame, "front");
  composite(frame, outRgba, arenaBg);

  // Apply camera shake
  const [sx, sy] = getShake(realT);
  let finalBuf = outRgba;
  if (sx !== 0 || sy !== 0) {
    shiftedRgba.fill(0);
    for (let y = 0; y < H; y++) {
      const sy2 = Math.max(0, Math.min(H - 1, y - sy));
      for (let x = 0; x < W; x++) {
        const sx2 = Math.max(0, Math.min(W - 1, x - sx));
        const di = (y * W + x) * 4;
        const si = (sy2 * W + sx2) * 4;
        shiftedRgba[di] = outRgba[si];
        shiftedRgba[di + 1] = outRgba[si + 1];
        shiftedRgba[di + 2] = outRgba[si + 2];
        shiftedRgba[di + 3] = 255;
      }
    }
    finalBuf = shiftedRgba;
  }

  // Save storyboard snapshot if due
  if (nextBoard < boardTimes.length && realT >= boardTimes[nextBoard]) {
    boardFrames.push(new Uint8ClampedArray(finalBuf));
    nextBoard++;
  }

  ff.stdin.write(Buffer.from(finalBuf.buffer, finalBuf.byteOffset, finalBuf.byteLength));
}

ff.stdin.end();
await new Promise((res, rej) => ff.on("close", (code) => code === 0 ? res() : rej(new Error(`ffmpeg exit ${code}`))));
console.log("MP4 rendered:", OUT_MP4);

// Convert MP4 -> crisp 640x360 @ 18fps GIF for inline Markdown preview
execFileSync("ffmpeg", [
  "-y", "-v", "error", "-i", OUT_MP4,
  "-vf", "fps=18,scale=640:360:flags=neighbor,split[s0][s1];[s0]palettegen=max_colors=160:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=2",
  "-loop", "0", OUT_GIF
]);
console.log("GIF rendered:", OUT_GIF);

// Build 3x2 Storyboard Contact Sheet (1440x540 -> 3 cols x 2 rows of 480x270)
const bw = W * 3, bh = H * 2;
const board = new Uint8ClampedArray(bw * bh * 4);
for (let bi = 0; bi < boardFrames.length; bi++) {
  const col = bi % 3, row = Math.floor(bi / 3);
  const src = boardFrames[bi];
  for (let y = 0; y < H; y++) {
    const dstOff = ((row * H + y) * bw + col * W) * 4;
    const srcOff = (y * W) * 4;
    board.set(src.subarray(srcOff, srcOff + W * 4), dstOff);
  }
}
execFileSync("ffmpeg", [
  "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${bw}x${bh}`, "-i", "-", OUT_BOARD
], { input: Buffer.from(board.buffer), maxBuffer: 32 * 1024 * 1024 });
console.log("Storyboard saved:", OUT_BOARD);
