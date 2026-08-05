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
- Scenes are namespaced behind `@` so they can never collide with a built-in.
- Colour temperature requires a `k` suffix, so `20` and `2700` can't be confused.
- Setting brightness or colour on a lamp that is off also turns it on. Typing a
  command is an unambiguous statement of intent.

## The reactive layer

A single `lamp tick` reconciler on a 30s launch agent — not a daemon, not a set
of calendar jobs. Three inputs, decided in one pure function (`resolve()` in
`rules.ts`) that needs no hardware to test:

- **Time of day** sets the brightness baseline.
- **Media** caps brightness while audio plays. Only ever dims.
- **Theme** supplies the colour, read out of swatch's own files.

### The one thing the design got wrong

"Colour and brightness are separate dimensions, so they can't fight" is only
half true: the lamp has a single colour *mode*, so a kelvin and an RGB value
cannot both apply. The schedule breaks the tie — a slot that names a `kelvin`
claims the colour dimension, a slot without one lets the theme accent through.
That is a better answer than a priority order would have given, because it is
what actually wanted expressing: theme colour by day, warm by night.

### Guards

- The reconciler **never turns the lamp on**, only adjusts one already on. It
  cannot light an empty room, and an unreachable lamp is a silent no-op.
- A manual command **pins the state** for two hours or until `lamp off`, so
  automation can never stomp a deliberate action.
- Only the difference is sent, so a steady state is completely silent on the
  wire.

### Detecting media

Not Cider's API. The `coreaudiod` power assertion covers Cider, Music.app,
`jazz` and the browser at once, needs no application token, and cannot be
broken by Cider changing its API. A short system sound could in principle
trigger a dim, but with a 30 second tick the odds of sampling one are slight
and the cost is a brief dim.

## Where it's headed

Nothing planned. The remaining known softness is that `lamp setup` is only
exercised by its unit tests and one live login.

## Not doing

- Remote control from outside the network. That needs a home hub; same-Wi-Fi is
  enough.
- A menu bar app. The terminal is the surface.
- Multiple lamps. There is one lamp.
