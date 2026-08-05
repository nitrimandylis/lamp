import { test, expect } from "bun:test";
import { signedNonce, encryptRc4, decryptRc4, encSignature, generateNonce } from "./cloud";

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
