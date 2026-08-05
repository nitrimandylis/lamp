// The reactive layer's decision-making, kept free of I/O so it can be tested
// without a lamp, a clock, or music playing.

export type Slot = { from: string; brightness: number; kelvin?: number };

export type Inputs = {
  /** Minutes since local midnight. */
  minutes: number;
  /** "on" or "off", as reported by the lamp. */
  power: string;
  audioPlaying: boolean;
  /** Accent colour of the active swatch theme, if one could be read. */
  themeAccent?: string;
  /** Epoch ms until which a manual command owns the lamp. 0 for none. */
  overrideUntil: number;
  now: number;
};

export type Settings = {
  schedule: Slot[];
  /** Brightness ceiling while audio is playing. */
  mediaBrightness?: number;
};

export type Target = { brightness: number; kelvin?: number; rgb?: string };

export function parseClock(hhmm: string): number {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`bad time "${hhmm}", expected HH:MM`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`bad time "${hhmm}"`);
  return h * 60 + min;
}

/**
 * The slot in force at `minutes`: the last one to have started.
 *
 * Wrapping matters — at 02:00 with slots at 07:00 and 23:00, the one in force
 * is 23:00 from the night before, so an empty "before the first slot" result
 * falls back to the last slot of the day.
 */
export function slotAt(minutes: number, schedule: Slot[]): Slot | null {
  if (schedule.length === 0) return null;
  const sorted = [...schedule].sort((a, b) => parseClock(a.from) - parseClock(b.from));
  let current: Slot = sorted[sorted.length - 1]!;
  for (const slot of sorted) {
    if (parseClock(slot.from) <= minutes) current = slot;
  }
  return current;
}

/**
 * What the lamp should look like, or null to leave it alone.
 *
 * Colour and brightness are separate dimensions, but the lamp can only be in
 * one colour *mode* at a time, so they cannot both be set independently. The
 * schedule breaks the tie: a slot that names a `kelvin` takes the colour
 * dimension for itself (this is what makes the lamp go warm late at night even
 * under a bright theme), and a slot that does not lets the swatch accent show.
 */
export function resolve(inputs: Inputs, settings: Settings): Target | null {
  // Never power the lamp on. The reconciler only ever adjusts a lamp that a
  // person already turned on, so it cannot light an empty room.
  if (inputs.power !== "on") return null;

  // A manual command owns the lamp until it expires or the lamp is switched off.
  if (inputs.overrideUntil > inputs.now) return null;

  const slot = slotAt(inputs.minutes, settings.schedule);
  if (!slot) return null;

  let brightness = slot.brightness;
  if (inputs.audioPlaying && settings.mediaBrightness !== undefined) {
    // Media only ever dims. It must not brighten a lamp the schedule has
    // deliberately taken down for the night.
    brightness = Math.min(brightness, settings.mediaBrightness);
  }

  if (slot.kelvin !== undefined) return { brightness, kelvin: slot.kelvin };
  if (inputs.themeAccent) return { brightness, rgb: inputs.themeAccent };
  return { brightness };
}

export type Current = { brightness: number; kelvin: number; rgb: string; colorMode: string };

/**
 * Drop the parts of `target` the lamp is already showing, so a steady state
 * sends no packets at all and the lamp never visibly re-applies what it has.
 */
export function changesOnly(target: Target, current: Current): Target | null {
  const out: Target = { brightness: target.brightness };
  let changed = target.brightness !== current.brightness;

  if (target.kelvin !== undefined) {
    // colorMode 2 is colour-temperature mode; anything else means the lamp is
    // showing an RGB colour and must be switched over regardless of the value.
    if (current.colorMode !== "2" || current.kelvin !== target.kelvin) {
      out.kelvin = target.kelvin;
      changed = true;
    }
  } else if (target.rgb !== undefined) {
    const wanted = target.rgb.replace(/^#/, "").toLowerCase();
    if (current.colorMode !== "1" || current.rgb.toLowerCase() !== wanted) {
      out.rgb = target.rgb;
      changed = true;
    }
  }

  return changed ? out : null;
}
