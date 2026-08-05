import { test, expect } from "bun:test";
import { plan, hexToInt, buildScene, upsertScene, NAMED_COLOURS, type Scenes } from "./lamp";
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
  expect(() => plan("chartreuse", scenes, "on")).toThrow();
});

test("named colours resolve to a set_rgb", () => {
  expect(plan("red", scenes, "on")).toEqual([{ method: "set_rgb", params: [0xff0000, "smooth", 500] }]);
  expect(plan("magenta", scenes, "on")[0]!.params[0]).toBe(0xff00ff);
});

test("colour names are case-insensitive", () => {
  expect(plan("Blue", scenes, "on")).toEqual(plan("blue", scenes, "on"));
});

test("a named colour on an off lamp turns it on first", () => {
  expect(plan("green", scenes, "off").map((c) => c.method)).toEqual(["set_power", "set_rgb"]);
});

test("config colours override the built-ins one at a time", () => {
  const custom = plan("blue", scenes, "on", { ...NAMED_COLOURS, blue: "#001188" });
  expect(custom[0]!.params[0]).toBe(0x001188);
  // Overriding blue must not remove the others.
  expect(plan("red", scenes, "on", { ...NAMED_COLOURS, blue: "#001188" })[0]!.params[0]).toBe(0xff0000);
});

test("a six-letter hex word is read as hex, not shadowed by a config colour", () => {
  // "abcdef" is both a valid hex colour and a legal config key.
  const shadowed = plan("abcdef", scenes, "on", { ...NAMED_COLOURS, abcdef: "#111111" });
  expect(shadowed[0]!.params[0]).toBe(0xabcdef);
});

test("a near miss suggests the colours it could have meant", () => {
  expect(() => plan("blu", scenes, "on")).toThrow(/blue/);
});

const CONFIG = `# lamp: keep this comment
ip = "192.168.1.4"

[scenes.read]
brightness = 80
kelvin = 4000

[scenes.sleep]
brightness = 5
rgb = "#ff3000"
`;

test("scene values merge across words", () => {
  expect(buildScene(["80", "4000k"])).toEqual({ brightness: 80, kelvin: 4000 });
  expect(buildScene(["60", "red"])).toEqual({ brightness: 60, rgb: "#ff0000" });
  expect(buildScene(["warm"])).toEqual({ kelvin: 2700 });
});

test("colour and temperature are one dimension, so the last one named wins", () => {
  expect(buildScene(["80", "red", "2700k"])).toEqual({ brightness: 80, kelvin: 2700 });
  expect(buildScene(["80", "2700k", "red"])).toEqual({ brightness: 80, rgb: "#ff0000" });
});

test("a scene must say something", () => {
  expect(() => buildScene([])).toThrow();
  expect(() => buildScene(["nonsense"])).toThrow(/nonsense/);
});

test("adding a scene leaves every other line, comments included, untouched", () => {
  const out = upsertScene(CONFIG, "focus", { brightness: 60, kelvin: 5000 });
  expect(out).toContain("# lamp: keep this comment");
  expect(out).toContain('ip = "192.168.1.4"');
  expect(out).toContain("[scenes.read]");
  expect(out).toContain("[scenes.sleep]");
  expect(out).toContain("[scenes.focus]\nbrightness = 60\nkelvin = 5000\n");
});

test("overwriting a scene replaces it rather than duplicating it", () => {
  const out = upsertScene(CONFIG, "read", { brightness: 90, rgb: "#ffffff" });
  expect(out.match(/\[scenes\.read\]/g)).toHaveLength(1);
  expect(out).toContain('rgb = "#ffffff"');
  expect(out).not.toContain("kelvin = 4000");
  // The scene that was not touched must survive intact.
  expect(out).toContain("[scenes.sleep]\nbrightness = 5\nrgb = \"#ff3000\"");
});

test("removing a scene removes only that scene", () => {
  const out = upsertScene(CONFIG, "read", null);
  expect(out).not.toContain("[scenes.read]");
  expect(out).toContain("[scenes.sleep]");
  expect(out).toContain('ip = "192.168.1.4"');
});

test("a rewritten config still parses back to the same scenes", async () => {
  const out = upsertScene(CONFIG, "focus", { brightness: 60, kelvin: 5000 });
  const path = `${process.env.TMPDIR ?? "/tmp"}/lamp-test-${Date.now()}.toml`;
  await Bun.write(path, out);
  const parsed = (await import(path)).default;
  expect(Object.keys(parsed.scenes).sort()).toEqual(["focus", "read", "sleep"]);
  expect(parsed.scenes.focus).toEqual({ brightness: 60, kelvin: 5000 });
  expect(parsed.scenes.read).toEqual({ brightness: 80, kelvin: 4000 });
  expect(parsed.ip).toBe("192.168.1.4");
});

test("scene names that would corrupt the file are rejected", () => {
  expect(() => upsertScene(CONFIG, "my scene", { brightness: 10 })).toThrow();
  expect(() => upsertScene(CONFIG, "a]b", { brightness: 10 })).toThrow();
  expect(() => upsertScene(CONFIG, "night-2", { brightness: 10 })).not.toThrow();
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
