---
name: lamp-cli
description: Control a Mi Bedside Lamp 2 from the terminal with the `lamp` CLI. Turn the lamp or light on and off, dim it, set brightness, set a colour or colour temperature, make it warm or cool, and save or apply named scenes. Use whenever the user asks to change, dim, brighten, colour or check their lamp, bedside lamp, or bedroom light, mentions `lamp`, or wants a lighting scene saved or recalled.
---

# lamp

`lamp` controls a Mi Bedside Lamp 2 (MJCTD02YL) over the miIO protocol on the
local network. Every command is one UDP round trip to the lamp; there is no
cloud service involved.

## Setup

Requires `$LAMP_TOKEN`, a 32-character hex device credential, exported in the
user's shell. **Never read, print, or echo this value.** Not to test it, not to
confirm it is set. To check whether it is set, run a real command like
`lamp status` and read the error.

If `lamp` is not on PATH, run it from a clone with `bun run lamp.ts <args>`.

The lamp's address and scenes live in `~/.config/lamp/config.toml`. That file
holds no credentials and is safe to read.

## Commands you can run unattended

All of these are non-interactive and return immediately.

| Command | Effect |
| --- | --- |
| `lamp status` | `on  80%  4000K` or `on  80%  #ff1f6b` |
| `lamp status --json` | `{power, brightness, mode, kelvin, rgb}` — parse this rather than the line above |
| `lamp on` / `lamp off` | Set power. Idempotent. |
| `lamp <0-100>` | Brightness. `lamp 0` turns it off. |
| `lamp <n>k` | Colour temperature, 1700–6500K, e.g. `lamp 2700k` |
| `lamp warm` / `lamp cool` | 2700K / 5000K |
| `lamp <colour>` | `red orange amber yellow lime green mint teal cyan azure blue indigo violet purple magenta pink white` |
| `lamp #rrggbb` | Colour by hex |
| `lamp @<scene>` | Apply a saved scene |
| `lamp scenes` | List scenes and what each sets |
| `lamp scenes --json` | `[{name, brightness, kelvin, rgb}]`, empty array if none |
| `lamp scene <name> <values>` | Save a scene from explicit values |
| `lamp scene <name>` | Save the lamp's *current* state as a scene |

Setting a brightness or colour on a lamp that is off also turns it on, so
`lamp red` is enough, with no need to send `lamp on` first.

## Commands you must NOT run

**`lamp setup`** prompts for a Xiaomi username and password, puts the terminal
into raw mode to read the password without echoing, and may then ask for a
captcha and an emailed two-factor code. Run from a tool call it will hang until
it times out. Hand the user the command and let them run it themselves.

It is only ever needed once, or again if the lamp is factory reset.

## Writes to the user's config

`lamp scene <name>` and `lamp scene rm <name>` rewrite
`~/.config/lamp/config.toml`. Both are silent about what they replace:
saving over an existing scene overwrites it with no confirmation, and `rm`
deletes without asking. Show the user what `lamp scenes` currently holds before
overwriting or deleting one they did not explicitly name.

## Things that will bite you

- **"Unreachable" does not mean the token is wrong.** A lamp switched off at the
  wall, a lamp asleep, and an incorrect token all present identically as a
  timeout, because the device silently drops packets that fail their checksum.
  Do not tell the user their token is bad on the strength of a timeout.
- **The lamp's Wi-Fi sleeps.** The first command after an idle spell can take
  up to 6 seconds while the radio wakes (three 2-second attempts). This is
  normal, not a fault. Do not add your own retry loop on top.
- **`$LAMP_TOKEN` must be exported.** A bare `LAMP_TOKEN=...` line in a shell
  file is a shell variable, and `lamp`, a child process, never sees it. This
  presents as "$LAMP_TOKEN is not set" even though the user can see the
  variable in their own shell.
- **Colour temperature needs the `k` suffix.** `lamp 2700` is an error, not
  2700K, because it would be ambiguous with brightness.
- **Colour and temperature are the same dimension.** The lamp has one colour
  mode, so a scene or command naming both keeps only the last one. There is no
  way to set an RGB colour and a kelvin value at once.
- **Bare `lamp` toggles.** If the goal is to turn the lamp on, send `lamp on`,
  which is idempotent. Never use bare `lamp` to reach a known state.
- **`lamp scene <name>` with no values reads the lamp**, so it needs
  `$LAMP_TOKEN` and a reachable lamp. With values it does not.
- **Colour overrides** go under `[colours]` in the config; `[colors]` is accepted as an alias (it wins if both set the same name).
- **Scene names** accept only letters, digits, dashes and underscores.
- **`--json` is reads only.** `status` and `scenes` take it; every other command
  is an action and signals through its exit code. Passing `--json` to an action
  is accepted and ignored, so a zero exit with no output is success, not a
  silent failure.
- **`null` in JSON is meaningful, not missing.** `kelvin: null` on a status
  means the lamp is in colour mode, not that the value could not be read.
- Applying a scene that does not exist fails and lists the ones that do, so
  `lamp scenes` is rarely needed first.

## What it cannot do

- **No control from outside the local network.** Same Wi-Fi only. There is no
  cloud or remote mode to fall back on.
- **No scheduling or automation.** No timers, no sunrise, no "dim at 11pm". This
  was built and deliberately removed; do not offer it, and do not reimplement it
  with `cron` or `launchd` unless the user asks for exactly that.
- **One lamp.** No multi-device support, no device selection.
- **It does not touch HomeKit.** The lamp's Home app pairing is independent and
  unaffected; `lamp` cannot read or change anything in Home.
- **No transitions or effects** beyond the built-in half-second fade.
