#!/usr/bin/env bun
// lamp — local control for the Mi Bedside Lamp 2 over miIO.

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { Device, LampUnreachable } from "./miio";
import { resolve as resolveTarget, changesOnly, type Slot, type Current } from "./rules";
import { qrLogin, devicesOn, SERVERS, type CloudDevice } from "./cloud";

const CONFIG_PATH = join(homedir(), ".config", "lamp", "config.toml");
const STATE_PATH = join(homedir(), ".local", "state", "lamp", "state.json");
const AGENT_PATH = join(homedir(), "Library", "LaunchAgents", "com.nick.lamp.plist");
const GHOSTTY_CONFIG = join(homedir(), ".config", "ghostty", "config");
const SWATCH_THEMES = join(homedir(), ".config", "swatch", "themes");

// The lamp's own limits. Kelvin outside this range is rejected by the device,
// and set_rgb treats 0 as an error rather than as black.
const KELVIN_MIN = 1700;
const KELVIN_MAX = 6500;
const TRANSITION_MS = 500;
// How long a command typed by hand keeps the reconciler at bay.
const OVERRIDE_MS = 2 * 60 * 60 * 1000;
const TICK_SECONDS = 30;

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

Automation:
  lamp auto            hand control back to the reconciler now
  lamp tick            apply the rules once (what the launch agent runs)
  lamp agent on|off    install or remove the ${TICK_SECONDS}s launch agent

Setup:
  lamp setup           fetch the device token from Xiaomi by QR code

Any command typed by hand holds off automation for 2 hours, or until 'lamp off'.

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
  const powerOn: Cmd = { method: "set_power", params: ["on", "smooth", TRANSITION_MS] };
  const powerOff: Cmd = { method: "set_power", params: ["off", "smooth", TRANSITION_MS] };

  const on = (cmds: Cmd[]): Cmd[] =>
    // A brightness or colour change typed by hand implies "and turn it on".
    // The reconciler deliberately does not get this behaviour.
    power === "on" ? cmds : [powerOn, ...cmds];

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

/** True if any process is holding the audio device: Cider, Music, a browser, jazz. */
export function audioPlaying(): boolean {
  try {
    const out = Bun.spawnSync(["pmset", "-g", "assertions"]).stdout.toString();
    return /coreaudiod/.test(out);
  } catch {
    return false;
  }
}

/**
 * The accent colour of the active swatch theme.
 *
 * Read out of swatch's own files rather than asking swatch to publish anything:
 * the theme name lives in the Ghostty config it generates, and the palette next
 * to it. Nothing here writes, so swatch never has to know this exists.
 */
export function themeAccent(): string | undefined {
  try {
    const config = readFileSync(GHOSTTY_CONFIG, "utf8");
    const line = config.match(/^\s*theme\s*=\s*(.+)$/m);
    if (!line) return undefined;
    // Ghostty allows "dark:a,light:b" as well as a plain name.
    const value = line[1]!.trim();
    const name = (value.match(/dark:([^,]+)/)?.[1] ?? value.split(",")[0] ?? "").trim();
    if (!name) return undefined;

    const palette = readFileSync(join(SWATCH_THEMES, name, "palette.toml"), "utf8");
    return palette.match(/^\s*accent\s*=\s*"(#[0-9a-fA-F]{6})"/m)?.[1];
  } catch {
    return undefined;
  }
}

function readOverrideUntil(): number {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")).overrideUntil ?? 0;
  } catch {
    return 0;
  }
}

function writeOverrideUntil(until: number): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify({ overrideUntil: until }));
}

type Config = {
  ip?: string;
  token?: string;
  scenes?: Scenes;
  schedule?: Slot[];
  media?: { brightness?: number };
};

type Loaded = { ip: string; token: string; scenes: Scenes; schedule: Slot[]; mediaBrightness?: number };

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
    schedule: cfg.schedule ?? [],
    mediaBrightness: cfg.media?.brightness,
  };
}

type Reading = Current & { power: string };

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

/** One pass of the reactive layer. Exits quietly whenever there is nothing to do. */
async function tick(cfg: Loaded): Promise<void> {
  if (cfg.schedule.length === 0) return;

  const dev = new Device(cfg.ip, Buffer.from(cfg.token, "hex"));
  const current = await readCurrent(dev);
  const now = new Date();

  const target = resolveTarget(
    {
      minutes: now.getHours() * 60 + now.getMinutes(),
      power: current.power,
      audioPlaying: audioPlaying(),
      themeAccent: themeAccent(),
      overrideUntil: readOverrideUntil(),
      now: now.getTime(),
    },
    { schedule: cfg.schedule, mediaBrightness: cfg.mediaBrightness },
  );
  if (!target) return;

  const delta = changesOnly(target, current);
  if (!delta) return;

  for (const cmd of sceneCmds(delta)) await dev.call(cmd.method, cmd.params);
}

async function setup(): Promise<void> {
  const session = await qrLogin((s) => console.log(s));
  console.log("Signed in. Looking for devices...");

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
  process.stdout.write("\nWhich one is the lamp? ");

  const answer = (await new Promise<string>((r) => process.stdin.once("data", (d) => r(d.toString())))).trim();
  const chosen = devices[Number(answer) - 1];
  if (!chosen) throw new Error(`no device ${answer}`);

  // Keep any scenes and schedule the user already wrote; only the credentials
  // are being replaced.
  const existing = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "";
  const rest = existing.replace(/^\s*(ip|token)\s*=.*$/gm, "").replace(/^#.*$/gm, "").trimStart();
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `ip = "${chosen.ip}"\ntoken = "${chosen.token}"\n\n${rest}`);
  chmodSync(CONFIG_PATH, 0o600);

  console.log(`\nWrote ${CONFIG_PATH} (mode 600). Try: lamp status`);
  process.exit(0);
}

function agent(action: string | undefined): void {
  if (action === "off") {
    Bun.spawnSync(["launchctl", "unload", AGENT_PATH]);
    if (existsSync(AGENT_PATH)) rmSync(AGENT_PATH);
    console.log("Launch agent removed.");
    return;
  }
  if (action !== "on") throw new Error("usage: lamp agent on|off");

  const binary = process.execPath;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.nick.lamp</string>
  <key>ProgramArguments</key>
  <array><string>${binary}</string><string>tick</string></array>
  <key>StartInterval</key><integer>${TICK_SECONDS}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>${join(homedir(), "Library", "Logs", "lamp.log")}</string>
</dict>
</plist>
`;
  mkdirSync(dirname(AGENT_PATH), { recursive: true });
  writeFileSync(AGENT_PATH, plist);
  Bun.spawnSync(["launchctl", "unload", AGENT_PATH]);
  Bun.spawnSync(["launchctl", "load", AGENT_PATH]);
  console.log(`Launch agent installed, running every ${TICK_SECONDS}s.\nLog: ~/Library/Logs/lamp.log`);
}

async function main() {
  const arg = process.argv[2];

  if (arg === "-h" || arg === "--help") return void console.log(HELP);
  if (arg === "setup") return void (await setup());
  if (arg === "agent") return void agent(process.argv[3]);
  if (arg === "auto") {
    writeOverrideUntil(0);
    return void console.log("Automation resumed.");
  }

  const cfg = await loadConfig();

  if (arg === "tick") return void (await tick(cfg));

  const dev = new Device(cfg.ip, Buffer.from(cfg.token, "hex"));
  const current = await readCurrent(dev);

  if (arg === "status") {
    const colour = current.colorMode === "2" ? `${current.kelvin}K` : `#${current.rgb}`;
    const held = readOverrideUntil() - Date.now();
    const suffix = held > 0 ? `  (manual for another ${Math.ceil(held / 60000)}m)` : "";
    return void console.log(`${current.power}  ${current.brightness}%  ${colour}${suffix}`);
  }

  const cmds = plan(arg, cfg.scenes, current.power);
  for (const cmd of cmds) await dev.call(cmd.method, cmd.params);

  // Switching off is the natural "I'm done" signal, so it hands the lamp back
  // to automation. Everything else claims it for a while.
  const turnedOff = cmds.some((c) => c.method === "set_power" && c.params[0] === "off");
  writeOverrideUntil(turnedOff ? 0 : Date.now() + OVERRIDE_MS);
}

// Importing this file for tests must not fire a command at the lamp.
if (import.meta.main) {
  main().catch((err) => {
    // An unreachable lamp is a normal condition (lamp off at the wall, not
    // home), and the reconciler must not spam the log with it every 30s.
    if (err instanceof LampUnreachable && process.argv[2] === "tick") process.exit(0);
    console.error(err instanceof LampUnreachable ? `lamp: unreachable — ${err.message}` : `lamp: ${err.message}`);
    process.exit(1);
  });
}
