# lamp

Terminal control for the Mi Bedside Lamp 2 (MJCTD02YL), spoken directly over
miIO on the local network.

## What it is

A single Bun-compiled binary that puts the bedside lamp one word away from the
keyboard. It exists because the Home app on the Mac is crippled without a home
hub, and buying a HomePod to dim a lamp on the same Wi-Fi is absurd.

## Why miIO

Three local paths were probed on the device itself:

| Path | Result |
| --- | --- |
| Yeelight LAN control, tcp/55443 | Closed. Disabled at the factory on the Mi-branded SKU; no firmware or app setting restores it. |
| HomeKit HAP, tcp/80 | Open, but a second controller pairing means unpairing from the Home app first. |
| miIO, udp/54321 | Open. Needs a per-device token, and leaves the HomeKit pairing alone. |

miIO wins on the last point: the phone keeps working through the Home app
exactly as it did before, and nothing had to be factory reset.

## Shape

- One argument, one intent: `lamp 20`, `lamp 2700k`, `lamp @read`.
- Scenes are captured from the lamp, not typed: `lamp scene desk` saves what you
  are looking at. Explicit values are there too, but they are the fallback, not
  the main path — the values worth keeping are ones arrived at by eye.
- Scenes are namespaced behind `@` so they can never collide with a built-in.
- Colour temperature requires a `k` suffix, so `20` and `2700` can't be confused.
- Setting brightness or colour on a lamp that is off also turns it on. Typing a
  command is an unambiguous statement of intent.
- Named colours are tuned for an LED rather than a screen, and every one is
  overridable in config. Hardware never matches the ideal on paper, so the
  calibration knob stays.
- The device token lives in `$LAMP_TOKEN`, never in a file. That split is the
  point: `config.toml` then contains nothing secret, so it can be read, synced
  and committed freely, and there is no file whose permissions have to be right
  for the tool to be safe.

## Deliberately not automated

An earlier version had a reconciler on a 30 second launch agent: time-of-day
brightness, dimming while audio played, colour following the active swatch
theme. It worked, and it was removed.

The reason is that a lamp is not a system that benefits from converging on a
desired state. Every rule needed a guard to stop it feeling haunted — never
power on, hold off for two hours after a manual command, hand back control on
`lamp off` — and the guards existed entirely to make automation stop doing
things. When the guards are the interesting part, the feature is arguing with
its user. Typing `lamp red` is already fast.

What the attempt did establish, for anyone tempted again:

- The lamp has a single colour *mode*, so kelvin and RGB cannot both apply.
  "Colour and brightness are separate dimensions" is only half true.
- `pmset -g assertions | grep coreaudiod` is a zero-config "is audio playing"
  signal on macOS, covering Cider, Music.app and the browser at once.
- The active swatch theme is readable without modifying swatch: the theme name
  from the Ghostty config it generates, the accent from the palette beside it.

## Not doing

- Remote control from outside the network. That needs a home hub; same-Wi-Fi is
  enough.
- A menu bar app. The terminal is the surface.
- Multiple lamps. There is one lamp.
