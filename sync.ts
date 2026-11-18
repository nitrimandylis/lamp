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
const INTERVAL_MS = 1500;
const MIN_BRIGHTNESS = 3; // a black frame dims the lamp, it never goes dark
const MAX_BRIGHTNESS = 80; // full brightness next to a TV is too much
const MIN_CHANGE = 12; // skip updates smaller than this, so a still frame sends nothing

export type Rgb = [number, number, number];

/**
 * Average colour of an uncompressed 24- or 32-bit BMP, the format sips writes.
 * Rows are padded to 4 bytes and pixels are stored blue first.
 */
export function averageBmp(bmp: Buffer): Rgb {
  if (bmp.toString("ascii", 0, 2) !== "BM") throw new Error("not a BMP");
  const dataStart = bmp.readUInt32LE(10);
  const width = bmp.readInt32LE(18);
  const height = Math.abs(bmp.readInt32LE(22)); // negative means top-down, same pixels
  const bytesPerPixel = bmp.readUInt16LE(28) / 8;
  const rowSize = Math.ceil((width * bytesPerPixel) / 4) * 4;

  let r = 0;
  let g = 0;
  let b = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = dataStart + y * rowSize + x * bytesPerPixel;
      b += bmp[i]!;
      g += bmp[i + 1]!;
      r += bmp[i + 2]!;
    }
  }
  const n = width * height;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/**
 * Split a screen colour into what the lamp can show: a hue at full strength,
 * and a brightness from how light the screen is. The lamp has its own
 * brightness control, so a dark red frame becomes a dim, pure red rather than
 * a muddy one.
 */
export function screenToLamp([r, g, b]: Rgb): { rgb: number; brightness: number } {
  const max = Math.max(r, g, b, 1);
  const scale = 255 / max;
  const rgb = (Math.round(r * scale) << 16) | (Math.round(g * scale) << 8) | Math.round(b * scale);

  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; // 0 to 1
  const brightness = Math.round(MIN_BRIGHTNESS + luminance * (MAX_BRIGHTNESS - MIN_BRIGHTNESS));
  return { rgb, brightness };
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

/** Grab the screen and shrink it to 16x9 so the average costs nothing. About 0.5 s. */
function sampleScreen(dir: string, display: number | undefined): Rgb {
  const jpg = join(dir, "screen.jpg");
  const bmp = join(dir, "screen.bmp");
  const shot = ["screencapture", "-x", "-t", "jpg"];
  if (display !== undefined) shot.push("-D", String(display));
  shot.push(jpg);

  if (!Bun.spawnSync(shot).success) {
    throw new Error("screencapture failed. Give your terminal Screen Recording permission in System Settings > Privacy & Security");
  }
  if (!Bun.spawnSync(["sips", "-z", "9", "16", "-s", "format", "bmp", jpg, "--out", bmp]).success) {
    throw new Error("sips could not shrink the screenshot");
  }
  return averageBmp(readFileSync(bmp));
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
      const next = screenToLamp(sampleScreen(dir, display));
      if (changedEnough(last, next)) {
        // The fade lasts as long as the gap between samples, so the light
        // drifts continuously instead of stepping.
        await dev.call("set_rgb", [Math.max(1, next.rgb), "smooth", INTERVAL_MS]);
        await dev.call("set_bright", [next.brightness, "smooth", INTERVAL_MS]);
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
