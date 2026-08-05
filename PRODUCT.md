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

## Where it's headed

**v2, the reactive layer.** A single `lamp tick` reconciler on a 30s launchd
interval — not a daemon, not a set of calendar jobs. Rules divide by dimension
rather than by priority, so all three coexist instead of shadowing each other:

- **swatch owns colour.** `lamp` reads swatch's existing state; swatch is never
  modified. The dependency points this way on purpose.
- **Time of day owns the brightness baseline and warmth.**
- **Media (Cider on :10767) overrides brightness downward** while playing.

Two rules keep it from feeling haunted:

- The reconciler **never turns the lamp on**, only adjusts one already on. It
  cannot switch itself on in an empty room, and an unreachable lamp is a silent
  no-op rather than an error.
- A manual command **pins the state** until `lamp off` or two hours pass, so
  automation can never stomp a deliberate action.

Precedence lives in one pure function, testable without hardware, the same way
`plan()` is now.

## Not doing

- Remote control from outside the network. That needs a home hub; same-Wi-Fi is
  enough.
- A menu bar app. The terminal is the surface.
- Multiple lamps. There is one lamp.
