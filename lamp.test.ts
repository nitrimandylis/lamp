import { test, expect } from "bun:test";
import { plan, hexToInt, type Scenes } from "./lamp";
import { buildPacket, parsePacket } from "./miio";

const scenes: Scenes = {
  read: { brightness: 80, kelvin: 4000 },
  sleep: { brightness: 5, rgb: "#ff3000" },
};

const methods = (arg: string | undefined, power: string) => plan(arg, scenes, power).map((c) => c.method);

test("bare lamp toggles both ways", () => {
  expect(methods(undefined, "on")).toEqual(["set_power"]);
  expect(plan(undefined, scenes, "on")[0]!.params[0]).toBe("off");
  expect(plan(undefined, scenes, "off")[0]!.params[0]).toBe("on");
});

test("brightness on an off lamp turns it on first", () => {
  expect(methods("20", "off")).toEqual(["set_power", "set_bright"]);
  expect(methods("20", "on")).toEqual(["set_bright"]);
});

test("zero brightness means off, not a dim lamp", () => {
  expect(plan("0", scenes, "on")).toEqual([{ method: "set_power", params: ["off", "smooth", 500] }]);
});

test("kelvin needs the k suffix, and a bare big number says so", () => {
  expect(methods("2700k", "on")).toEqual(["set_ct_abx"]);
  expect(() => plan("2700", scenes, "on")).toThrow(/2700k/);
});

test("values are clamped to what the device accepts", () => {
  expect(plan("9000k", scenes, "on")[0]!.params[0]).toBe(6500);
  expect(plan("1000k", scenes, "on")[0]!.params[0]).toBe(1700);
  expect(hexToInt("#000000")).toBe(1); // set_rgb rejects 0
  expect(hexToInt("#ffb300")).toBe(0xffb300);
});

test("scenes apply every dimension they set", () => {
  expect(methods("@read", "on")).toEqual(["set_bright", "set_ct_abx"]);
  expect(methods("@sleep", "on")).toEqual(["set_bright", "set_rgb"]);
});

test("an unknown scene lists the ones that exist", () => {
  expect(() => plan("@nope", scenes, "on")).toThrow(/@read, @sleep/);
});

test("colour is accepted with or without the hash", () => {
  expect(methods("#ffb300", "on")).toEqual(["set_rgb"]);
  expect(methods("ffb300", "on")).toEqual(["set_rgb"]);
});

test("garbage is rejected rather than silently doing nothing", () => {
  expect(() => plan("purple", scenes, "on")).toThrow();
});

test("a packet survives a build/parse round trip", () => {
  const token = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
  const json = JSON.stringify({ id: 1, method: "get_prop", params: ["power"] });
  const parsed = parsePacket(buildPacket(0x158df9f4, 1234, token, json), token);
  expect(parsed.deviceId).toBe(0x158df9f4);
  expect(parsed.stamp).toBe(1234);
  expect(parsed.body).toBe(json);
});

test("the checksum covers the body, so tampering is detectable", () => {
  const token = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
  const a = buildPacket(1, 1, token, '{"id":1}');
  const b = buildPacket(1, 1, token, '{"id":2}');
  expect(a.subarray(16, 32).equals(b.subarray(16, 32))).toBe(false);
});
