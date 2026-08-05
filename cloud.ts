// One-time token retrieval from the Xiaomi cloud, by QR code.
//
// Ported from PiotrMachowski/Xiaomi-cloud-tokens-extractor (MIT). Only the
// QR-code path is here: the password path is what breaks with "Access denied"
// once an account has two-factor verification on it, which is most of them.
//
// Nothing in here is needed after the token is in config.toml.

import { createHash, createHmac, createCipheriv, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOGIN_URL = "https://account.xiaomi.com/longPolling/loginUrl";
// The servers Xiaomi runs, in the order worth trying from Europe.
export const SERVERS = ["de", "i2", "ru", "sg", "us", "cn"];

export type CloudDevice = { name: string; did: string; token: string; ip: string; model: string };

const b64 = (b: Buffer) => b.toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64");

function randomAgent(): string {
  const letters = (n: number, from: number, to: number) =>
    Array.from({ length: n }, () => String.fromCharCode(from + Math.floor(Math.random() * (to - from + 1)))).join("");
  return `${letters(18, 97, 122)}-${letters(13, 65, 69)} APP/com.xiaomi.mihome APPV/10.5.201`;
}

export function generateNonce(millis: number): string {
  const stamp = Buffer.alloc(4);
  stamp.writeUInt32BE(Math.floor(millis / 60000));
  return b64(Buffer.concat([randomBytes(8), stamp]));
}

export function signedNonce(ssecurity: string, nonce: string): string {
  return b64(createHash("sha256").update(Buffer.concat([unb64(ssecurity), unb64(nonce)])).digest());
}

/**
 * RC4 as Xiaomi uses it: the first 1024 bytes of keystream are discarded
 * before any real data goes through. A fresh cipher per call, never reused.
 */
function rc4(keyB64: string, data: Buffer): Buffer {
  const cipher = createCipheriv("rc4", unb64(keyB64), null);
  cipher.update(Buffer.alloc(1024));
  return cipher.update(data);
}

export const encryptRc4 = (key: string, text: string) => b64(rc4(key, Buffer.from(text, "utf8")));
export const decryptRc4 = (key: string, payload: string) => rc4(key, unb64(payload)).toString("utf8");

export function encSignature(url: string, method: string, nonceSigned: string, params: Record<string, string>): string {
  const path = url.split("com")[1]!.replace("/app/", "/");
  const parts = [method.toUpperCase(), path];
  for (const [k, v] of Object.entries(params)) parts.push(`${k}=${v}`);
  parts.push(nonceSigned);
  return b64(createHash("sha1").update(parts.join("&"), "utf8").digest());
}

/**
 * Build the query Xiaomi expects: a hash over the plaintext, then every value
 * RC4-encrypted, then a signature over the *encrypted* values. Key order is
 * part of both signatures, so it must not be rearranged.
 */
function encParams(url: string, nonceSigned: string, nonce: string, data: string, ssecurity: string) {
  const params: Record<string, string> = { data };
  params.rc4_hash__ = encSignature(url, "POST", nonceSigned, params);
  for (const key of Object.keys(params)) params[key] = encryptRc4(nonceSigned, params[key]!);
  params.signature = encSignature(url, "POST", nonceSigned, params);
  params.ssecurity = ssecurity;
  params._nonce = nonce;
  return params;
}

/** Follow redirects by hand, collecting Set-Cookie from every hop. */
async function fetchCollectingCookies(url: string): Promise<Map<string, string>> {
  const jar = new Map<string, string>();
  let next = url;
  for (let hop = 0; hop < 6; hop++) {
    const res = await fetch(next, {
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const idx = pair!.indexOf("=");
      if (idx > 0) jar.set(pair!.slice(0, idx).trim(), pair!.slice(idx + 1).trim());
    }
    const location = res.headers.get("location");
    if (!location) return jar;
    next = new URL(location, next).toString();
  }
  return jar;
}

const stripPrefix = (text: string) => JSON.parse(text.replace("&&&START&&&", ""));

export type Session = { userId: string; ssecurity: string; serviceToken: string; agent: string };

/**
 * Sign in by QR code. Deliberately not password-based: this path never touches
 * a password and never triggers the two-factor email loop, which is subject to
 * a 3-5 per day cap per region.
 */
export async function qrLogin(log: (s: string) => void): Promise<Session> {
  const agent = randomAgent();

  const query = new URLSearchParams({
    _qrsize: "480",
    qs: "%3Fsid%3Dxiaomiio%26_json%3Dtrue",
    callback: "https://sts.api.io.mi.com/sts",
    _hasLogo: "false",
    sid: "xiaomiio",
    serviceParam: "",
    _locale: "en_GB",
    _dc: String(Date.now()),
  });
  const start = await fetch(`${LOGIN_URL}?${query}`, { headers: { "User-Agent": agent } });
  if (!start.ok) throw new Error(`could not start login (HTTP ${start.status})`);
  const info = stripPrefix(await start.text()) as { qr: string; loginUrl: string; lp: string; timeout: number };
  if (!info.qr) throw new Error("Xiaomi did not return a QR code");

  const image = await fetch(info.qr);
  const path = join(tmpdir(), "lamp-login-qr.png");
  await Bun.write(path, await image.arrayBuffer());
  Bun.spawn(["open", path]).unref();

  log("Scan the QR code that just opened with the Xiaomi Home app.");
  log(`If it did not open: ${path}`);
  log(`Or visit: ${info.loginUrl}`);
  log("Waiting...");

  // Long poll: the server holds the request open until the phone confirms, so
  // a timeout is normal and simply means "ask again".
  const deadline = Date.now() + (info.timeout ?? 300) * 1000;
  let confirmed: { userId: number; ssecurity: string; location: string } | null = null;
  while (Date.now() < deadline) {
    try {
      const poll = await fetch(info.lp, { headers: { "User-Agent": agent }, signal: AbortSignal.timeout(10_000) });
      if (poll.ok) {
        confirmed = stripPrefix(await poll.text());
        break;
      }
    } catch {
      // timed out waiting for the scan; poll again
    }
  }
  if (!confirmed) throw new Error("timed out waiting for the QR code to be scanned");

  const jar = await fetchCollectingCookies(confirmed.location);
  const serviceToken = jar.get("serviceToken");
  if (!serviceToken) throw new Error("signed in, but no service token came back");

  return { userId: String(confirmed.userId), ssecurity: confirmed.ssecurity, serviceToken, agent };
}

async function apiCall(session: Session, country: string, path: string, data: string): Promise<any> {
  const base = `https://${country === "cn" ? "" : country + "."}api.io.mi.com/app`;
  const url = base + path;
  const nonce = generateNonce(Date.now());
  const nonceSigned = signedNonce(session.ssecurity, nonce);
  const params = encParams(url, nonceSigned, nonce, data, session.ssecurity);

  const cookies = [
    `userId=${session.userId}`,
    `yetAnotherServiceToken=${session.serviceToken}`,
    `serviceToken=${session.serviceToken}`,
    "locale=en_GB",
    "timezone=GMT+02:00",
    "is_daylight=1",
    "dst_offset=3600000",
    "channel=MI_APP_STORE",
  ].join("; ");

  // The parameters go in the query string, not the body — that is what the
  // signature was computed over.
  const res = await fetch(`${url}?${new URLSearchParams(params)}`, {
    method: "POST",
    headers: {
      "Accept-Encoding": "identity",
      "User-Agent": session.agent,
      "Content-Type": "application/x-www-form-urlencoded",
      "x-xiaomi-protocal-flag-cli": "PROTOCAL-HTTP2",
      "MIOT-ENCRYPT-ALGORITHM": "ENCRYPT-RC4",
      Cookie: cookies,
    },
  });
  if (!res.ok) return null;
  return JSON.parse(decryptRc4(nonceSigned, await res.text()));
}

/** Every device on one regional server, across all of the account's homes. */
export async function devicesOn(session: Session, country: string): Promise<CloudDevice[]> {
  const homes = await apiCall(session, country, "/v2/homeroom/gethome", '{"fg": true, "fetch_share": true, "fetch_share_dev": true, "limit": 300, "app_ver": 7}');
  const list = homes?.result?.homelist ?? [];
  const found: CloudDevice[] = [];

  for (const home of list) {
    const data = `{"home_owner": ${home.uid},"home_id": ${home.id},  "limit": 200,  "get_split_device": true, "support_smart_home": true}`;
    const devices = await apiCall(session, country, "/v2/home/home_device_list", data);
    for (const d of devices?.result?.device_info ?? []) {
      if (d.token) found.push({ name: d.name ?? "?", did: d.did, token: d.token, ip: d.localip ?? "", model: d.model ?? "" });
    }
  }
  return found;
}
