#!/usr/bin/env bun
// lamp — local control for the Mi Bedside Lamp 2 over miIO.

import { homedir } from "node:os";
import { join } from "node:path";
import { Device, LampUnreachable } from "./miio";

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
  lamp #ffb300         set colour
  lamp @<scene>        apply a scene from config.toml
  lamp status          show current state

Config: ~/.config/lamp/config.toml
`;

export type Cmd = { method: string; params: (string | number)[] };
export type Scene = { brightness?: number; kelvin?: number; rgb?: string };
export type Scenes = Record<string, Scene>;

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
export function plan(arg: string | undefined, scenes: Scenes, power: string): Cmd[] {
  const on = (cmds: Cmd[]): Cmd[] =>
    // A brightness or colour change typed by hand implies "and turn it on".
    // The v2 reconciler deliberately does not get this behaviour.
    power === "on" ? cmds : [{ method: "set_power", params: ["on", "smooth", TRANSITION_MS] }, ...cmds];

  const off: Cmd = { method: "set_power", params: ["off", "smooth", TRANSITION_MS] };

  if (arg === undefined) return power === "on" ? [off] : [{ method: "set_power", params: ["on", "smooth", TRANSITION_MS] }];
  if (arg === "off") return [off];
  if (arg === "on") return [{ method: "set_power", params: ["on", "smooth", TRANSITION_MS] }];
  if (arg === "warm") return on(sceneCmds({ kelvin: 2700 }));
  if (arg === "cool") return on(sceneCmds({ kelvin: 5000 }));

  const kelvin = arg.match(/^(\d{3,5})k$/i);
  if (kelvin) return on(sceneCmds({ kelvin: Number(kelvin[1]) }));

  if (/^\d+$/.test(arg)) {
    const n = Number(arg);
    if (n === 0) return [off];
    if (n > 100) throw new Error(`brightness must be 0-100 (for colour temperature write ${arg}k)`);
    return on(sceneCmds({ brightness: n }));
  }

  if (/^#?[0-9a-f]{6}$/i.test(arg)) return on(sceneCmds({ rgb: arg }));

  if (arg.startsWith("@")) {
    const name = arg.slice(1);
    const scene = scenes[name];
    if (!scene) {
      const known = Object.keys(scenes);
      throw new Error(`no scene "${name}"${known.length ? ` (have: ${known.map((s) => "@" + s).join(", ")})` : ""}`);
    }
    return on(sceneCmds(scene));
  }

  throw new Error(`don't understand "${arg}" — try: lamp --help`);
}

type Config = { ip?: string; token?: string; scenes?: Scenes };

async function loadConfig(): Promise<Required<Pick<Config, "ip" | "token">> & { scenes: Scenes }> {
  let cfg: Config;
  try {
    cfg = ((await import(CONFIG_PATH)) as { default: Config }).default;
  } catch {
    throw new Error(`cannot read ${CONFIG_PATH}\nCreate it with 'ip' and 'token' — see the README.`);
  }
  if (!cfg.ip) throw new Error(`${CONFIG_PATH}: missing 'ip'`);
  if (!cfg.token) throw new Error(`${CONFIG_PATH}: missing 'token'`);
  if (!/^[0-9a-f]{32}$/i.test(cfg.token)) throw new Error(`${CONFIG_PATH}: 'token' must be 32 hex characters`);
  return { ip: cfg.ip, token: cfg.token, scenes: cfg.scenes ?? {} };
}

async function main() {
  const arg = process.argv[2];
  if (arg === "-h" || arg === "--help") {
    console.log(HELP);
    return;
  }

  const cfg = await loadConfig();
  const dev = new Device(cfg.ip, Buffer.from(cfg.token, "hex"));

  const props = (await dev.call("get_prop", ["power", "bright", "ct", "rgb", "color_mode"])) as (string | number)[];
  const [power, bright, ct, rgb, mode] = props;

  if (arg === "status") {
    const colour = String(mode) === "2" ? `${ct}K` : `#${Number(rgb).toString(16).padStart(6, "0")}`;
    console.log(`${power}  ${bright}%  ${colour}`);
    return;
  }

  for (const cmd of plan(arg, cfg.scenes, String(power))) {
    await dev.call(cmd.method, cmd.params);
  }
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
