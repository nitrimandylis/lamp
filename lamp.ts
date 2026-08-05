#!/usr/bin/env bun
// lamp — local control for the Mi Bedside Lamp 2 over miIO.

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { Device, LampUnreachable } from "./miio";
import { passwordLogin, devicesOn, ask, SERVERS, type CloudDevice } from "./cloud";

const CONFIG_PATH = join(homedir(), ".config", "lamp", "config.toml");

// The lamp's own limits. Kelvin outside this range is rejected by the device,
// and set_rgb treats 0 as an error rather than as black.
const KELVIN_MIN = 1700;
const KELVIN_MAX = 6500;
const TRANSITION_MS = 500;

const HELP = `lamp — control the Mi Bedside Lamp 2

Usage:
  lamp                 toggle on/off
  lamp on | off        set power
  lamp <0-100>         set brightness (0 turns it off)
  lamp <n>k            set colour temperature, e.g. lamp 2700k
  lamp warm | cool     2700k / 5000k
  lamp red | blue      a named colour (see below)
  lamp #ffb300         set colour by hex
  lamp @<scene>        apply a scene from config.toml
  lamp status          show current state
  lamp setup           fetch the device token from Xiaomi

Colours:
  red orange amber yellow lime green mint teal cyan
  azure blue indigo violet purple magenta pink white

Config: ~/.config/lamp/config.toml
`;

export type Cmd = { method: string; params: (string | number)[] };
export type Scene = { brightness?: number; kelvin?: number; rgb?: string };
export type Scenes = Record<string, Scene>;
export type Colours = Record<string, string>;

/**
 * Named colours, tuned for an RGB LED rather than a screen.
 *
 * Screen values do not carry over: #0000ff on this lamp reads as a dim violet,
 * and #ffff00 washes out to near-white. These are pulled towards what the lamp
 * actually shows. Override any of them under [colours] in config.toml — the
 * right values depend on the bulb and the room.
 */
export const NAMED_COLOURS: Colours = {
  red: "#ff0000",
  orange: "#ff4400",
  amber: "#ff8800",
  yellow: "#ffc400",
  lime: "#88ff00",
  green: "#00ff00",
  mint: "#00ff88",
  teal: "#00ccaa",
  cyan: "#00ffff",
  azure: "#0088ff",
  blue: "#0044ff",
  indigo: "#3300ff",
  violet: "#7700ff",
  purple: "#aa00ff",
  magenta: "#ff00ff",
  pink: "#ff3399",
  white: "#ffffff",
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function hexToInt(hex: string): number {
  const h = hex.replace(/^#/, "");
  // set_rgb rejects 0, so pure black becomes the darkest colour it will accept.
  return Math.max(1, parseInt(h, 16));
}

function sceneCmds(scene: Scene): Cmd[] {
  const cmds: Cmd[] = [];
  if (scene.brightness !== undefined)
    cmds.push({ method: "set_bright", params: [clamp(scene.brightness, 1, 100), "smooth", TRANSITION_MS] });
  if (scene.kelvin !== undefined)
    cmds.push({ method: "set_ct_abx", params: [clamp(scene.kelvin, KELVIN_MIN, KELVIN_MAX), "smooth", TRANSITION_MS] });
  if (scene.rgb !== undefined)
    cmds.push({ method: "set_rgb", params: [hexToInt(scene.rgb), "smooth", TRANSITION_MS] });
  if (cmds.length === 0) throw new Error("scene sets nothing");
  return cmds;
}

/**
 * Turn one argument into the miIO calls that carry it out.
 *
 * Pure on purpose: `power` is passed in rather than fetched, so the whole
 * command vocabulary can be tested without a lamp on the network.
 */
export function plan(arg: string | undefined, scenes: Scenes, power: string, colours: Colours = NAMED_COLOURS): Cmd[] {
  const powerOn: Cmd = { method: "set_power", params: ["on", "smooth", TRANSITION_MS] };
  const powerOff: Cmd = { method: "set_power", params: ["off", "smooth", TRANSITION_MS] };

  // A brightness or colour change implies "and turn it on".
  const on = (cmds: Cmd[]): Cmd[] => (power === "on" ? cmds : [powerOn, ...cmds]);

  if (arg === undefined) return power === "on" ? [powerOff] : [powerOn];
  if (arg === "off") return [powerOff];
  if (arg === "on") return [powerOn];
  if (arg === "warm") return on(sceneCmds({ kelvin: 2700 }));
  if (arg === "cool") return on(sceneCmds({ kelvin: 5000 }));

  const kelvin = arg.match(/^(\d{3,5})k$/i);
  if (kelvin) return on(sceneCmds({ kelvin: Number(kelvin[1]) }));

  if (/^\d+$/.test(arg)) {
    const n = Number(arg);
    if (n === 0) return [powerOff];
    if (n > 100) throw new Error(`brightness must be 0-100 (for colour temperature write ${arg}k)`);
    return on(sceneCmds({ brightness: n }));
  }

  if (/^#?[0-9a-f]{6}$/i.test(arg)) return on(sceneCmds({ rgb: arg }));

  // After the hex check, so a config colour named "abcdef" cannot shadow the
  // literal it looks like.
  const named = colours[arg.toLowerCase()];
  if (named) return on(sceneCmds({ rgb: named }));

  if (arg.startsWith("@")) {
    const name = arg.slice(1);
    const scene = scenes[name];
    if (!scene) {
      const known = Object.keys(scenes);
      throw new Error(`no scene "${name}"${known.length ? ` (have: ${known.map((s) => "@" + s).join(", ")})` : ""}`);
    }
    return on(sceneCmds(scene));
  }

  const close = Object.keys(colours).filter((c) => c.startsWith(arg.slice(0, 2).toLowerCase()));
  const hint = close.length ? ` — did you mean ${close.join(", ")}?` : " — try: lamp --help";
  throw new Error(`don't understand "${arg}"${hint}`);
}

type Config = { ip?: string; token?: string; scenes?: Scenes; colours?: Colours; colors?: Colours };
type Loaded = { ip: string; token: string; scenes: Scenes; colours: Colours };

async function loadConfig(): Promise<Loaded> {
  let cfg: Config;
  try {
    cfg = ((await import(CONFIG_PATH)) as { default: Config }).default;
  } catch {
    throw new Error(`cannot read ${CONFIG_PATH}\nRun 'lamp setup' to create it.`);
  }
  if (!cfg.ip) throw new Error(`${CONFIG_PATH}: missing 'ip'`);
  if (!cfg.token) throw new Error(`${CONFIG_PATH}: missing 'token' — run 'lamp setup'`);
  if (!/^[0-9a-f]{32}$/i.test(cfg.token)) throw new Error(`${CONFIG_PATH}: 'token' must be 32 hex characters`);
  return {
    ip: cfg.ip,
    token: cfg.token,
    scenes: cfg.scenes ?? {},
    // Config entries override the built-ins one at a time, so tuning "blue"
    // does not mean re-listing every other colour. Both spellings accepted.
    colours: { ...NAMED_COLOURS, ...cfg.colours, ...cfg.colors },
  };
}

type Reading = { power: string; brightness: number; kelvin: number; rgb: string; colorMode: string };

async function readCurrent(dev: Device): Promise<Reading> {
  const props = (await dev.call("get_prop", ["power", "bright", "ct", "rgb", "color_mode"])) as (string | number)[];
  return {
    power: String(props[0]),
    brightness: Number(props[1]),
    kelvin: Number(props[2]),
    rgb: Number(props[3]).toString(16).padStart(6, "0"),
    colorMode: String(props[4]),
  };
}

async function setup(): Promise<void> {
  const session = await passwordLogin();
  console.log("\nSigned in. Looking for devices...");

  let devices: CloudDevice[] = [];
  for (const server of SERVERS) {
    devices = await devicesOn(session, server);
    if (devices.length > 0) {
      console.log(`Found ${devices.length} device(s) on the "${server}" server.\n`);
      break;
    }
  }
  if (devices.length === 0) throw new Error("no devices found on any Xiaomi server");

  devices.forEach((d, i) => console.log(`  ${i + 1}. ${d.name}  ${d.model}  ${d.ip || "(no ip)"}`));
  const answer = await ask("\nWhich one is the lamp? ");
  const chosen = devices[Number(answer) - 1];
  if (!chosen) throw new Error(`no device ${answer}`);

  // Keep any scenes the user already wrote; only the credentials are replaced.
  const existing = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "";
  const rest = existing.replace(/^\s*(ip|token)\s*=.*$/gm, "").replace(/^#.*$/gm, "").trimStart();
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `ip = "${chosen.ip}"\ntoken = "${chosen.token}"\n\n${rest}`);
  chmodSync(CONFIG_PATH, 0o600);

  console.log(`\nWrote ${CONFIG_PATH} (mode 600). Try: lamp status`);
  process.exit(0);
}

async function main() {
  const arg = process.argv[2];

  if (arg === "-h" || arg === "--help") return void console.log(HELP);
  if (arg === "setup") return void (await setup());

  const cfg = await loadConfig();
  const dev = new Device(cfg.ip, Buffer.from(cfg.token, "hex"));
  const current = await readCurrent(dev);

  if (arg === "status") {
    const colour = current.colorMode === "2" ? `${current.kelvin}K` : `#${current.rgb}`;
    return void console.log(`${current.power}  ${current.brightness}%  ${colour}`);
  }

  for (const cmd of plan(arg, cfg.scenes, current.power, cfg.colours)) await dev.call(cmd.method, cmd.params);
}

// Importing this file for tests must not fire a command at the lamp.
if (import.meta.main) {
  main().catch((err) => {
    // An unreachable lamp is a normal condition (lamp off at the wall, not
    // home), not something worth a stack trace.
    console.error(err instanceof LampUnreachable ? `lamp: unreachable — ${err.message}` : `lamp: ${err.message}`);
    process.exit(1);
  });
}
