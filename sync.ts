// lamp sync: follow the Mac screen's colour while it runs, put the lamp back on exit.
//
// Foreground only, on purpose. The deleted reactive layer felt haunted because it
// ran when nobody asked; this runs exactly as long as its terminal does.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Device, LampUnreachable } from "./miio";

// Calibration knobs. The right values depend on the room and the film, so they
// are named here rather than buried in the maths.
const INTERVAL_MS = 250; // one capture takes about 0.15 s, and the lamp took 30 commands in 0.76 s
const FADE_MS = 250; // fade as long as the gap, so the light glides instead of stepping
const MIN_BRIGHTNESS = 5; // a black frame dims the lamp, it never goes dark
const MAX_BRIGHTNESS = 100;
const MIN_CHANGE = 12; // skip updates smaller than this, so a still frame sends nothing
const VIVID_WEIGHT = 6; // how much more a saturated, bright pixel counts than a grey one

export type Rgb = [number, number, number];

/** Every pixel of an uncompressed 24- or 32-bit BMP, the format sips writes. */
export function bmpPixels(bmp: Buffer): Rgb[] {
  if (bmp.toString("ascii", 0, 2) !== "BM") throw new Error("not a BMP");
  const dataStart = bmp.readUInt32LE(10);
  const width = bmp.readInt32LE(18);
  const height = Math.abs(bmp.readInt32LE(22)); // negative means top-down, same pixels
  const bytesPerPixel = bmp.readUInt16LE(28) / 8;
  const rowSize = Math.ceil((width * bytesPerPixel) / 4) * 4; // rows are padded to 4 bytes

  const pixels: Rgb[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = dataStart + y * rowSize + x * bytesPerPixel;
      pixels.push([bmp[i + 2]!, bmp[i + 1]!, bmp[i]!]); // stored blue first
    }
  }
  return pixels;
}

/**
 * The colour the screen "feels" like. A plain average turns a red car on a grey
 * road into beige, so saturated, bright pixels count more than grey ones. A
 * grey screen still averages to grey, because every pixel keeps a weight of 1.
 */
export function dominantColour(pixels: Rgb[]): Rgb {
  let r = 0;
  let g = 0;
  let b = 0;
  let total = 0;
  for (const [pr, pg, pb] of pixels) {
    const max = Math.max(pr, pg, pb);
    const min = Math.min(pr, pg, pb);
    const saturation = max === 0 ? 0 : (max - min) / max;
    const weight = 1 + VIVID_WEIGHT * saturation * (max / 255);
    r += pr * weight;
    g += pg * weight;
    b += pb * weight;
    total += weight;
  }
  return [r / total, g / total, b / total];
}

/** Screen values are gamma-encoded; an LED mixes light linearly. */
function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * Split a screen colour into what the lamp can show: a hue at full strength,
 * and a brightness. The hue is taken in linear light, which keeps an orange
 * orange on the LED instead of washing out to peach. Brightness follows the
 * brightest channel rather than luminance, so a deep blue scene lights the
 * room instead of nearly switching the lamp off.
 */
export function screenToLamp([r, g, b]: Rgb): { rgb: number; brightness: number } {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const max = Math.max(lr, lg, lb, 1e-6);
  const rgb = (Math.round((lr / max) * 255) << 16) | (Math.round((lg / max) * 255) << 8) | Math.round((lb / max) * 255);

  const value = Math.max(r, g, b) / 255; // 0 to 1, already perceptual
  const brightness = Math.round(MIN_BRIGHTNESS + value * (MAX_BRIGHTNESS - MIN_BRIGHTNESS));
  return { rgb: Math.max(1, rgb), brightness };
}

/** True when the new reading differs enough from the last one sent to be worth a packet. */
export function changedEnough(last: { rgb: number; brightness: number } | null, next: { rgb: number; brightness: number }): boolean {
  if (!last) return true;
  const channelDiff =
    Math.abs((last.rgb >> 16) - (next.rgb >> 16)) +
    Math.abs(((last.rgb >> 8) & 0xff) - ((next.rgb >> 8) & 0xff)) +
    Math.abs((last.rgb & 0xff) - (next.rgb & 0xff));
  return channelDiff >= MIN_CHANGE || Math.abs(last.brightness - next.brightness) >= 3;
}

/** Grab the screen and shrink it to 32x18. About 0.15 s. */
function sampleScreen(dir: string, display: number | undefined): Rgb[] {
  const jpg = join(dir, "screen.jpg");
  const bmp = join(dir, "screen.bmp");
  const shot = ["screencapture", "-x", "-t", "jpg"];
  if (display !== undefined) shot.push("-D", String(display));
  shot.push(jpg);

  if (!Bun.spawnSync(shot).success) {
    throw new Error("screencapture failed. Give your terminal Screen Recording permission in System Settings > Privacy & Security");
  }
  if (!Bun.spawnSync(["sips", "-z", "18", "32", "-s", "format", "bmp", jpg, "--out", bmp]).success) {
    throw new Error("sips could not shrink the screenshot");
  }
  return bmpPixels(readFileSync(bmp));
}

export async function sync(dev: Device, display: number | undefined): Promise<void> {
  // Remember how the lamp was, so stopping sync puts it back exactly.
  const props = (await dev.call("get_prop", ["power", "bright", "ct", "rgb", "color_mode"])) as (string | number)[];
  const before = {
    power: String(props[0]),
    brightness: Number(props[1]),
    kelvin: Number(props[2]),
    rgb: Number(props[3]),
    temperatureMode: String(props[4]) === "2",
  };

  let stopping = false;
  const stop = () => {
    // A second Ctrl-C while restoring means "just quit".
    if (stopping) process.exit(130);
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop); // closing the terminal tab should restore too

  const dir = mkdtempSync(join(tmpdir(), "lamp-sync-"));
  console.log(`Syncing ${display === undefined ? "the main display" : `display ${display}`} to the lamp. Ctrl-C to stop.`);

  if (before.power !== "on") await dev.call("set_power", ["on", "smooth", 500]);

  let last: { rgb: number; brightness: number } | null = null;
  while (!stopping) {
    const started = Date.now();
    try {
      const next = screenToLamp(dominantColour(sampleScreen(dir, display)));
      if (changedEnough(last, next)) {
        // Two packets rather than one set_scene: set_scene cannot fade, and
        // instant jumps four times a second read as flicker. Each call is ~25 ms.
        await dev.call("set_rgb", [next.rgb, "smooth", FADE_MS]);
        await dev.call("set_bright", [next.brightness, "smooth", FADE_MS]);
        last = next;
      }
    } catch (err) {
      // A dropped packet is normal on Wi-Fi; skip this frame and try the next.
      if (!(err instanceof LampUnreachable)) {
        rmSync(dir, { recursive: true, force: true });
        throw err;
      }
    }
    const wait = INTERVAL_MS - (Date.now() - started);
    if (wait > 0 && !stopping) await Bun.sleep(wait);
  }

  rmSync(dir, { recursive: true, force: true });
  console.log("\nPutting the lamp back.");
  if (before.power !== "on") {
    await dev.call("set_power", ["off", "smooth", 500]);
  } else if (before.temperatureMode) {
    await dev.call("set_ct_abx", [before.kelvin, "smooth", 500]);
    await dev.call("set_bright", [before.brightness, "smooth", 500]);
  } else {
    await dev.call("set_rgb", [Math.max(1, before.rgb), "smooth", 500]);
    await dev.call("set_bright", [before.brightness, "smooth", 500]);
  }
}
