#!/usr/bin/env bun
// lamp: local control for the Mi Bedside Lamp 2 over miIO.

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { Device, LampUnreachable } from "./miio";
import { passwordLogin, devicesOn, ask, SERVERS, type CloudDevice } from "./cloud";

const CONFIG_PATH = join(homedir(), ".config", "lamp", "config.toml");
// The device token is a credential, so it lives in the environment rather than
// in a config file that is easy to commit by accident.
const TOKEN_ENV = "LAMP_TOKEN";

// The lamp's own limits. Kelvin outside this range is rejected by the device,
// and set_rgb treats 0 as an error rather than as black.
const KELVIN_MIN = 1700;
const KELVIN_MAX = 6500;
const TRANSITION_MS = 500;

const HELP = `lamp: control the Mi Bedside Lamp 2

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

Scenes:
  lamp scene <name>            save the lamp's current state as <name>
  lamp scene <name> 80 2700k   save explicit values instead
  lamp scene rm <name>         delete it
  lamp scenes                  list them

Setup:
  lamp setup           fetch the device token from Xiaomi

Colours:
  red orange amber yellow lime green mint teal cyan
  azure blue indigo violet purple magenta pink white

Token:  $LAMP_TOKEN (put it in ~/.zsh_secrets, not in the config file)
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
 * actually shows. Override any of them under [colours] in config.toml. The
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
 * Read one value word (a brightness, a temperature, or a colour) into the
 * dimension it sets. Returns null if the word is not a value at all.
 *
 * The single definition of what "80", "2700k", "warm" and "red" mean, shared by
 * the command line and by scene building so the two can never disagree.
 */
export function parseValue(arg: string, colours: Colours = NAMED_COLOURS): Scene | null {
  if (arg === "warm") return { kelvin: 2700 };
  if (arg === "cool") return { kelvin: 5000 };

  const kelvin = arg.match(/^(\d{3,5})k$/i);
  if (kelvin) return { kelvin: clamp(Number(kelvin[1]), KELVIN_MIN, KELVIN_MAX) };

  if (/^\d+$/.test(arg)) {
    const n = Number(arg);
    if (n > 100) throw new Error(`brightness must be 0-100 (for colour temperature write ${arg}k)`);
    return { brightness: clamp(n, 1, 100) };
  }

  // Before the named lookup, so a configured colour called "abcdef" cannot
  // shadow the hex literal it looks like.
  if (/^#?[0-9a-f]{6}$/i.test(arg)) return { rgb: `#${arg.replace(/^#/, "").toLowerCase()}` };

  const named = colours[arg.toLowerCase()];
  return named ? { rgb: named } : null;
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
  if (arg === "off" || arg === "0") return [powerOff];
  if (arg === "on") return [powerOn];

  if (arg.startsWith("@")) {
    const name = arg.slice(1);
    const scene = scenes[name];
    if (!scene) {
      const known = Object.keys(scenes);
      throw new Error(`no scene "${name}"${known.length ? ` (have: ${known.map((s) => "@" + s).join(", ")})` : ""}`);
    }
    return on(sceneCmds(scene));
  }

  const value = parseValue(arg, colours);
  if (value) return on(sceneCmds(value));

  const close = Object.keys(colours).filter((c) => c.startsWith(arg.slice(0, 2).toLowerCase()));
  const hint = close.length ? `. Did you mean ${close.join(", ")}?` : ". Try: lamp --help";
  throw new Error(`don't understand "${arg}"${hint}`);
}

/** Merge value words into one scene, e.g. ["80", "4000k"] or ["60", "red"]. */
export function buildScene(words: string[], colours: Colours = NAMED_COLOURS): Scene {
  const scene: Scene = {};
  for (const word of words) {
    const value = parseValue(word, colours);
    if (!value) throw new Error(`don't understand "${word}". Expected a brightness, a temperature like 2700k, or a colour`);
    // Colour and temperature are the same dimension on this lamp, so the last
    // one named wins rather than both being stored.
    if (value.kelvin !== undefined) delete scene.rgb;
    if (value.rgb !== undefined) delete scene.kelvin;
    Object.assign(scene, value);
  }
  if (Object.keys(scene).length === 0) throw new Error("a scene needs at least one value");
  return scene;
}

const TOML_KEY = /^[A-Za-z0-9_-]+$/;

export function sceneToToml(name: string, scene: Scene): string {
  const lines = [`[scenes.${name}]`];
  if (scene.brightness !== undefined) lines.push(`brightness = ${scene.brightness}`);
  if (scene.kelvin !== undefined) lines.push(`kelvin = ${scene.kelvin}`);
  if (scene.rgb !== undefined) lines.push(`rgb = "${scene.rgb}"`);
  return lines.join("\n") + "\n";
}

/**
 * Replace, add or (with a null scene) remove one scene in the config text,
 * leaving every other line, comments included, exactly as it was.
 *
 * A section runs until the next "[", which is true for scenes because their
 * values are only numbers and strings. It would not hold for a section
 * containing an array.
 */
export function upsertScene(text: string, name: string, scene: Scene | null): string {
  if (!TOML_KEY.test(name)) throw new Error(`scene name "${name}" must be letters, digits, dashes or underscores`);

  const existing = new RegExp(`(^|\\n)\\[scenes\\.${name}\\][^\\[]*`);
  let out = text.replace(existing, "$1").replace(/\n{3,}/g, "\n\n");
  out = out.trimEnd() + "\n";
  return scene ? `${out}\n${sceneToToml(name, scene)}` : out;
}

type Config = { ip?: string; token?: string; scenes?: Scenes; colours?: Colours; colors?: Colours };
type Loaded = { ip: string; token: string; scenes: Scenes; colours: Colours };

async function loadConfig(requireToken = true): Promise<Loaded> {
  let cfg: Config;
  try {
    cfg = ((await import(CONFIG_PATH)) as { default: Config }).default;
  } catch {
    throw new Error(`cannot read ${CONFIG_PATH}\nRun 'lamp setup' to create it.`);
  }
  if (!cfg.ip) throw new Error(`${CONFIG_PATH}: missing 'ip'`);

  const token = process.env[TOKEN_ENV];
  if (!token && !requireToken) return { ip: cfg.ip, token: "", scenes: cfg.scenes ?? {}, colours: { ...NAMED_COLOURS, ...cfg.colours, ...cfg.colors } };
  if (!token) {
    // A token left behind in the config file is the likeliest reason to land
    // here, and silently ignoring it would look like the lamp was broken.
    const stale = cfg.token
      ? `\n${CONFIG_PATH} still has a 'token' line. It is no longer read. Move it and delete the line.`
      : "";
    throw new Error(`$${TOKEN_ENV} is not set.\nRun 'lamp setup', or add it to ~/.zsh_secrets.${stale}`);
  }
  if (!/^[0-9a-f]{32}$/i.test(token)) throw new Error(`$${TOKEN_ENV} must be 32 hex characters`);

  return {
    ip: cfg.ip,
    token,
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

export function describeScene(scene: Scene): string {
  const parts: string[] = [];
  if (scene.brightness !== undefined) parts.push(`${scene.brightness}%`);
  if (scene.kelvin !== undefined) parts.push(`${scene.kelvin}K`);
  if (scene.rgb !== undefined) parts.push(scene.rgb);
  return parts.join("  ");
}

function listScenes(cfg: Loaded): void {
  const names = Object.keys(cfg.scenes);
  if (names.length === 0) return void console.log("No scenes yet. Set the lamp how you like it, then: lamp scene <name>");
  const width = Math.max(...names.map((n) => n.length));
  for (const name of names) console.log(`  @${name.padEnd(width)}  ${describeScene(cfg.scenes[name]!)}`);
}

/**
 * Save, overwrite or remove a scene.
 *
 * With no values, the lamp's current state is captured, which is the point:
 * the values worth saving are the ones you arrived at by eye, not ones guessed
 * in a text editor.
 */
async function saveScene(cfg: Loaded, words: string[]): Promise<void> {
  const usage = "usage: lamp scene <name> [brightness] [colour|temperature]\n       lamp scene rm <name>";
  if (words.length === 0) throw new Error(usage);

  // "rm" only deletes when a name follows it, so a scene may still be called rm.
  if (words[0] === "rm" && words.length > 1) {
    const name = words[1]!;
    if (!cfg.scenes[name]) throw new Error(`no scene "${name}"`);
    writeFileSync(CONFIG_PATH, upsertScene(readFileSync(CONFIG_PATH, "utf8"), name, null));
    return void console.log(`Removed @${name}.`);
  }

  const name = words[0]!;
  const values = words.slice(1);
  let scene: Scene;

  if (values.length > 0) {
    scene = buildScene(values, cfg.colours);
  } else {
    if (!cfg.token) throw new Error(`$${TOKEN_ENV} is not set, and it is needed to read the lamp's current state`);
    const current = await readCurrent(new Device(cfg.ip, Buffer.from(cfg.token, "hex")));
    scene = {
      brightness: Math.max(1, current.brightness),
      // colorMode 2 is colour-temperature mode; anything else is an RGB colour.
      ...(current.colorMode === "2" ? { kelvin: current.kelvin } : { rgb: `#${current.rgb}` }),
    };
  }

  const existed = cfg.scenes[name] !== undefined;
  writeFileSync(CONFIG_PATH, upsertScene(readFileSync(CONFIG_PATH, "utf8"), name, scene));
  console.log(`${existed ? "Updated" : "Saved"} @${name}:  ${describeScene(scene)}`);
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

  // Only the address goes to disk. Keep any scenes and colours already written,
  // and strip a token line left over from an older version.
  const existing = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "";
  const rest = existing.replace(/^\s*(ip|token)\s*=.*$/gm, "").replace(/^#.*$/gm, "").trimStart();
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `ip = "${chosen.ip}"\n\n${rest}`);
  chmodSync(CONFIG_PATH, 0o600);
  console.log(`\nWrote the address to ${CONFIG_PATH}.`);

  // The token is a credential and is deliberately never written to a file. It
  // goes to the clipboard so it does not sit in terminal scrollback either.
  const copied = Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(chosen.token) }).success;
  console.log(`\nThe device token is ${copied ? "on your clipboard" : `: ${chosen.token}`}.`);
  console.log(`Add it to your shell, then start a new shell:\n`);
  console.log(`  echo 'export ${TOKEN_ENV}=<paste>' >> ~/.zsh_secrets\n`);
  console.log("Then: lamp status");
  process.exit(0);
}

async function main() {
  const arg = process.argv[2];

  if (arg === "-h" || arg === "--help") return void console.log(HELP);
  if (arg === "setup") return void (await setup());

  // Listing and defining scenes are the two things that can work without a
  // token, so they do not demand one.
  if (arg === "scenes") return void listScenes(await loadConfig(false));
  if (arg === "scene") return void (await saveScene(await loadConfig(false), process.argv.slice(3)));

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
    console.error(err instanceof LampUnreachable ? `lamp: unreachable, ${err.message}` : `lamp: ${err.message}`);
    process.exit(1);
  });
}
