import { test, expect } from "bun:test";
import { resolve, slotAt, parseClock, changesOnly, type Slot, type Inputs, type Current } from "./rules";

const schedule: Slot[] = [
  { from: "07:00", brightness: 70 },
  { from: "18:00", brightness: 50 },
  { from: "23:00", brightness: 25, kelvin: 2200 },
  { from: "01:00", brightness: 5, kelvin: 1700 },
];

const settings = { schedule, mediaBrightness: 30 };

const at = (hhmm: string, over: Partial<Inputs> = {}): Inputs => ({
  minutes: parseClock(hhmm),
  power: "on",
  audioPlaying: false,
  overrideUntil: 0,
  now: 1_000_000,
  ...over,
});

test("the slot in force is the last one to have started", () => {
  expect(slotAt(parseClock("08:00"), schedule)!.from).toBe("07:00");
  expect(slotAt(parseClock("22:59"), schedule)!.from).toBe("18:00");
  expect(slotAt(parseClock("23:30"), schedule)!.from).toBe("23:00");
});

test("before the first slot, last night's slot is still in force", () => {
  // 03:00 is after 01:00, which is the earliest slot of the day.
  expect(slotAt(parseClock("03:00"), schedule)!.from).toBe("01:00");
  // 00:30 is before every slot, so it wraps to the last one of the previous day.
  expect(slotAt(parseClock("00:30"), schedule)!.from).toBe("23:00");
});

test("an off lamp is never touched — the reconciler cannot light a room", () => {
  expect(resolve(at("20:00", { power: "off" }), settings)).toBeNull();
});

test("a manual override holds the reconciler off until it expires", () => {
  expect(resolve(at("20:00", { overrideUntil: 2_000_000 }), settings)).toBeNull();
  expect(resolve(at("20:00", { overrideUntil: 999_999 }), settings)).not.toBeNull();
});

test("media dims, and never brightens", () => {
  // 18:00 baseline is 50, media caps at 30.
  expect(resolve(at("19:00", { audioPlaying: true }), settings)!.brightness).toBe(30);
  // 01:30 baseline is 5, already below the media cap — music must not raise it.
  expect(resolve(at("01:30", { audioPlaying: true }), settings)!.brightness).toBe(5);
});

test("a slot naming a kelvin takes the colour dimension from the theme", () => {
  const late = resolve(at("23:30", { themeAccent: "#ff1f6b" }), settings)!;
  expect(late.kelvin).toBe(2200);
  expect(late.rgb).toBeUndefined();
});

test("a slot with no kelvin lets the swatch accent through", () => {
  const day = resolve(at("12:00", { themeAccent: "#ff1f6b" }), settings)!;
  expect(day.rgb).toBe("#ff1f6b");
  expect(day.kelvin).toBeUndefined();
});

test("with no theme and no kelvin, only brightness is set", () => {
  const day = resolve(at("12:00"), settings)!;
  expect(day).toEqual({ brightness: 70 });
});

test("an empty schedule means the reactive layer does nothing at all", () => {
  expect(resolve(at("12:00"), { schedule: [] })).toBeNull();
});

const current: Current = { brightness: 70, kelvin: 4000, rgb: "ff1f6b", colorMode: "2" };

test("a steady state sends nothing", () => {
  expect(changesOnly({ brightness: 70, kelvin: 4000 }, current)).toBeNull();
});

test("a colour change is forced when the lamp is in the wrong mode", () => {
  // Same rgb value, but the lamp is in colour-temperature mode.
  const delta = changesOnly({ brightness: 70, rgb: "#ff1f6b" }, current);
  expect(delta).toEqual({ brightness: 70, rgb: "#ff1f6b" });
});

test("brightness alone changes without re-sending the colour", () => {
  expect(changesOnly({ brightness: 30, kelvin: 4000 }, current)).toEqual({ brightness: 30 });
});

test("bad clock strings are rejected rather than silently treated as midnight", () => {
  expect(() => parseClock("25:00")).toThrow();
  expect(() => parseClock("7pm")).toThrow();
});
