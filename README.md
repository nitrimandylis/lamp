```
 ┃  ▄▄▄   ▗▄▄▄▖ ▗▖  ▗▖ ▗▄▄▖
 ┃ ▐▌  ▜▌ ▐▌ ▝▘ ▐▛▚▞▜▌ ▐▌ ▐▌
 ┃ ▐▌  ▐▌ ▐▛▀▀▘ ▐▌▝▘▐▌ ▐▛▀▘
 ┻ ▝▀▀▀▘ ▝▘     ▝▘  ▝▘ ▐▌
```

# lamp

Control the Mi Bedside Lamp 2 from the terminal. Entirely on your own network.

[![Bun](https://img.shields.io/badge/runtime-Bun-000?logo=bun)](https://bun.sh)
[![deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)]()
[![macOS](https://img.shields.io/badge/macOS-first-black?logo=apple)]()
[![MIT](https://img.shields.io/badge/license-MIT-blue)]()

```
lamp            # toggle
lamp 20         # 20% brightness
lamp 2700k      # warm white
lamp red        # a named colour
lamp #ff3000    # or hex
lamp @read      # a scene from your config
lamp status     # on  80%  4000K
```

## Scenes

Set the lamp by eye until it looks right, then name it:

```bash
lamp 42 && lamp teal
lamp scene desk          # Saved @desk:  42%  #00ccaa
lamp @desk               # and back to it any time
```

Or state the values outright:

```bash
lamp scene evening 40 2200k
lamp scene alarm 100 red
lamp scenes              # list them
lamp scene rm alarm      # delete one
```

Capturing beats typing here: the values worth keeping are the ones you arrived
at by looking at the lamp, not ones guessed in a text editor.

Scenes live in `config.toml`, and editing is surgical. Comments, ordering and
every other section survive untouched. Colour and temperature are one dimension
on this lamp, so if a scene names both, the last one wins.

No cloud round trip, no hub, no Xiaomi or Yeelight app in the loop. The lamp's
HomeKit pairing is untouched, so the Home app keeps working on your phone
exactly as before.

## Run it

```bash
git clone https://github.com/nitrimandylis/lamp.git
cd lamp
bun run compile   # → ~/.bun/bin/lamp, man lamp, and the agent skill
lamp --help
man lamp          # full reference, offline
```

## Driving it from an agent

`lamp-cli/SKILL.md` is the agent-facing doc, installed by `bun run compile` if
you have a `~/.claude/skills` directory. It covers what `--help` has no room
for: that every command except `lamp setup` is safe to run unattended, and that
`setup` is not, because it reads a password in raw mode and will hang a tool
call waiting for input that never comes.

It also carries the traps worth knowing before breaking something: that a
timeout means an unreachable lamp *or* a wrong token and cannot tell you which,
that `lamp scene rm` deletes without asking, and that the automation the tool
deliberately does not have should not be reimplemented with `cron`.

## Setting it up

```bash
lamp setup
```

Asks for your Xiaomi account and password, answers the captcha and emailed
two-factor code if the account demands them, writes the device address to
`~/.config/lamp/config.toml`, and puts the device token on your clipboard.

Handling both challenges is the whole point. The naive password login, the one
`miiocli cloud` performs, returns `Access denied` on any account with
verification enabled, which is most of them.

The token goes in the environment, never in a file:

```bash
echo 'export LAMP_TOKEN=<paste>' >> ~/.zsh_secrets
```

Pick a file your shell exports but your dotfiles repo does **not** track. The
`export` matters: a bare `LAMP_TOKEN=...` is a shell variable, and child
processes never see it.

Keeping it out of the config file means `config.toml` holds nothing secret, so
it can be read, synced and committed without care. Neither the password nor the
token is ever written to disk by `lamp`.

## Colours

```
red  orange  amber  yellow  lime  green  mint  teal  cyan
azure  blue  indigo  violet  purple  magenta  pink  white
```

Tuned for an LED, not a screen: `#0000ff` reads as a dim violet on this lamp and
`#ffff00` washes out to near-white, so the built-ins are pulled towards what the
device actually shows. Yours will differ by bulb and by room, so override the
ones you disagree with:

```toml
[colours]
blue = "#0033cc"
```

Overrides apply one at a time, so changing `blue` leaves the rest alone.

## Under the hood

```mermaid
flowchart LR
  A["lamp 20"] --> B["plan()"]
  B -->|"set_bright"| C["build packet"]
  C --> D["AES-128-CBC<br/>key = md5(token)<br/>iv = md5(key+token)"]
  D --> E["udp/54321"]
  E --> F["Mi Bedside Lamp 2"]
```

A miIO packet is a 32-byte header (magic, length, device id, the device's own
clock, and an md5 checksum) wrapped around an encrypted JSON body. The first
datagram is a handshake that asks the lamp for its id and clock; everything
after that is a `set_bright` / `set_ct_abx` / `set_rgb` call.

Argument parsing is two pure functions. `parseValue()` is the single definition
of what `80`, `2700k`, `warm` and `red` mean, and `plan()` turns one argument
into the list of calls that carry it out. Scene building reuses `parseValue()`,
so `lamp red` and `lamp scene x red` can never disagree about what red is. Both
are tested without a lamp on the network.

## Why not the Yeelight LAN protocol

The Mi-branded MJCTD02YL ships with Yeelight's LAN control (tcp/55443) disabled
at the factory, and no firmware or app setting turns it back on. miIO on
udp/54321 is the only local path this device has.

## Development

```bash
bun test                     # pure logic, no lamp required
bunx --bun tsc --noEmit
mandoc -T lint man/lamp.1
```

MIT.
