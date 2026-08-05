import { test, expect } from "bun:test";
import { signedNonce, encryptRc4, decryptRc4, encSignature, generateNonce, Jar } from "./cloud";

test("a dotted cookie domain matches subdomains and the bare domain", () => {
  expect(Jar.hostMatches("sts.api.io.mi.com", ".mi.com")).toBe(true);
  expect(Jar.hostMatches("mi.com", ".mi.com")).toBe(true);
  expect(Jar.hostMatches("account.xiaomi.com", ".mi.com")).toBe(false);
  // The trap: a suffix match alone would wrongly accept this.
  expect(Jar.hostMatches("evilmi.com", ".mi.com")).toBe(false);
});

test("a host cookie is not sent to subdomains", () => {
  expect(Jar.hostMatches("account.xiaomi.com", "account.xiaomi.com")).toBe(true);
  expect(Jar.hostMatches("sub.account.xiaomi.com", "account.xiaomi.com")).toBe(false);
});

test("cookies are only offered to hosts they belong to", () => {
  const jar = new Jar();
  jar.set("serviceToken", "sts-one", ".sts.api.io.mi.com");
  jar.set("sdkVersion", "accountsdk", ".xiaomi.com");
  expect(jar.header("https://sts.api.io.mi.com/sts")).toBe("serviceToken=sts-one");
  expect(jar.header("https://account.xiaomi.com/pass/serviceLogin")).toBe("sdkVersion=accountsdk");
});

test("the same cookie name on two domains stays separate", () => {
  // account.xiaomi.com also sets a serviceToken; only the mi.com one is the
  // credential the device API accepts, so they must not overwrite each other.
  const jar = new Jar();
  jar.set("serviceToken", "wrong", ".xiaomi.com");
  jar.set("serviceToken", "right", ".mi.com");
  expect(jar.get("serviceToken", ".mi.com")).toBe("right");
  expect(jar.get("serviceToken", ".xiaomi.com")).toBe("wrong");
});

test("re-setting a cookie on the same domain replaces it", () => {
  const jar = new Jar();
  jar.set("ick", "first", ".xiaomi.com");
  jar.set("ick", "second", ".xiaomi.com");
  expect(jar.get("ick")).toBe("second");
});

test("Set-Cookie without a Domain attribute is scoped to the host that sent it", () => {
  const jar = new Jar();
  const res = new Response("", { headers: { "set-cookie": "ick=abc; Path=/; HttpOnly" } });
  jar.absorb(res, "https://account.xiaomi.com/identity/list");
  expect(jar.header("https://account.xiaomi.com/x")).toBe("ick=abc");
  expect(jar.header("https://sts.api.io.mi.com/sts")).toBe("");
});

// Reference values produced by the Python implementation this was ported from
// (PiotrMachowski/Xiaomi-cloud-tokens-extractor, using pycryptodome's ARC4).
// If any of these change, the port has drifted and cloud login will fail with
// an opaque server error rather than anything readable.
const SSECURITY = Buffer.from("0123456789abcdef").toString("base64");
const NONCE = Buffer.from("aaaaaaaabbbb").toString("base64");
const SIGNED = "MJh1XFMFfrURCWF2svE5/nvF5LIbAy+qGgIkx8HiAGs=";
const PAYLOAD = '{"home_id": 1}';
const URL = "https://de.api.io.mi.com/app/v2/home/home_device_list";

test("signed nonce matches the Python implementation", () => {
  expect(signedNonce(SSECURITY, NONCE)).toBe(SIGNED);
});

test("RC4 with the 1024-byte keystream drop matches Python", () => {
  expect(encryptRc4(SIGNED, PAYLOAD)).toBe("/VHUK18HIUD4xhzhhNo=");
});

test("RC4 round trips", () => {
  expect(decryptRc4(SIGNED, encryptRc4(SIGNED, PAYLOAD))).toBe(PAYLOAD);
});

test("encrypted-call signature matches Python", () => {
  expect(encSignature(URL, "POST", SIGNED, { data: PAYLOAD })).toBe("IEpA7kfdAywREWk0aFwFEKhDPQM=");
});

test("the signature covers the /app/ prefix being stripped", () => {
  // A signature over the raw path would not match what the server computes.
  const withApp = encSignature(URL, "POST", SIGNED, {});
  const other = encSignature("https://de.api.io.mi.com/app/v2/homeroom/gethome", "POST", SIGNED, {});
  expect(withApp).not.toBe(other);
});

test("the nonce carries a 12-byte payload ending in the minute counter", () => {
  const raw = Buffer.from(generateNonce(60_000 * 5), "base64");
  expect(raw.length).toBe(12);
  expect(raw.readUInt32BE(8)).toBe(5);
});
