// One-time token retrieval from the Xiaomi cloud, by username and password.
//
// Ported from PiotrMachowski/Xiaomi-cloud-tokens-extractor (MIT).
//
// The naive password login — the one `miiocli cloud` uses — fails with "Access
// denied" on any account that has a captcha or two-factor verification on it,
// which is most of them now. What makes this work is answering both challenges:
// the captcha image and the emailed code are handled below.
//
// Nothing in here is needed once the token is in config.toml.

import { createHash, createCipheriv, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const randomDeviceId = () =>
  Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");

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

// --- cookies -----------------------------------------------------------------

type Cookie = { name: string; value: string; domain: string };

/**
 * The login walks across account.xiaomi.com, sts.api.io.mi.com and back, and
 * each hop depends on cookies the previous one set. Bun's fetch has no cookie
 * jar, so this is the smallest one that keeps domains apart — which matters,
 * because `serviceToken` is set by more than one host and only the STS one is
 * the credential the API wants.
 */
export class Jar {
  private cookies: Cookie[] = [];

  static hostMatches(host: string, domain: string): boolean {
    if (!domain.startsWith(".")) return host === domain;
    return host === domain.slice(1) || host.endsWith(domain);
  }

  set(name: string, value: string, domain: string): void {
    const existing = this.cookies.find((c) => c.name === name && c.domain === domain);
    if (existing) existing.value = value;
    else this.cookies.push({ name, value, domain });
  }

  absorb(response: Response, requestUrl: string): void {
    const host = new URL(requestUrl).hostname;
    for (const raw of response.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";");
      const eq = pair!.indexOf("=");
      if (eq <= 0) continue;
      const domainAttr = attrs.map((a) => a.trim()).find((a) => a.toLowerCase().startsWith("domain="));
      const domain = domainAttr ? domainAttr.slice(7).trim() : host;
      this.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim(), domain);
    }
  }

  header(url: string): string {
    const host = new URL(url).hostname;
    return this.cookies
      .filter((c) => Jar.hostMatches(host, c.domain))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  get(name: string, domainSuffix?: string): string | undefined {
    const matches = this.cookies.filter((c) => c.name === name && (!domainSuffix || c.domain.endsWith(domainSuffix)));
    return matches[matches.length - 1]?.value;
  }
}

// --- terminal prompts ---------------------------------------------------------

export async function ask(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  for await (const line of console) return line.trim();
  return "";
}

/** Read a line without echoing it, so the password never lands on screen. */
async function askHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  if (!process.stdin.isTTY) return ask("");

  process.stdin.setRawMode(true);
  process.stdin.resume();
  let out = "";
  try {
    for await (const chunk of process.stdin) {
      for (const byte of chunk as Buffer) {
        if (byte === 3) throw new Error("cancelled");
        if (byte === 13 || byte === 10) {
          process.stdout.write("\n");
          return out;
        }
        if (byte === 127 || byte === 8) out = out.slice(0, -1);
        else out += String.fromCharCode(byte);
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  return out;
}

// --- HTTP ---------------------------------------------------------------------

type ReqOptions = {
  method?: "GET" | "POST";
  query?: Record<string, string>;
  form?: Record<string, string>;
  follow?: boolean;
};

/** One jar-aware request, with redirects followed by hand so cookies are collected at every hop. */
async function req(jar: Jar, agent: string, url: string, opts: ReqOptions = {}): Promise<{ res: Response; url: string; body: string }> {
  let target = opts.query ? `${url}?${new URLSearchParams(opts.query)}` : url;
  let method = opts.method ?? "GET";
  let body = opts.form ? new URLSearchParams(opts.form).toString() : undefined;

  for (let hop = 0; hop < 8; hop++) {
    const res = await fetch(target, {
      method,
      body,
      redirect: "manual",
      headers: {
        "User-Agent": agent,
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: jar.header(target),
      },
    });
    jar.absorb(res, target);

    const location = res.headers.get("location");
    if (!opts.follow || !location) return { res, url: target, body: await res.text() };

    target = new URL(location, target).toString();
    // A redirect after a POST continues as a GET, exactly as a browser would.
    method = "GET";
    body = undefined;
  }
  throw new Error("too many redirects while signing in");
}

const stripPrefix = (text: string) => JSON.parse(text.replace("&&&START&&&", ""));

async function showImage(bytes: ArrayBuffer, name: string, label: string): Promise<void> {
  const path = join(tmpdir(), name);
  await Bun.write(path, bytes);
  Bun.spawn(["open", path]).unref();
  console.log(`${label} (opened ${path})`);
}

// --- login --------------------------------------------------------------------

export type Session = { userId: string; ssecurity: string; serviceToken: string; agent: string };

/**
 * The email two-factor flow, reached when the server answers the password with
 * a notificationUrl instead of an ssecurity.
 *
 * The prize is buried oddly: `ssecurity` comes back in an `extension-pragma`
 * response *header* on the Auth2/end hop, not in any body, and it is only there
 * if that hop is inspected without following its redirect.
 */
async function twoFactor(jar: Jar, agent: string, notificationUrl: string): Promise<string> {
  const context = new URL(notificationUrl).searchParams.get("context");
  if (!context) throw new Error("two-factor URL had no context");

  await req(jar, agent, notificationUrl, { follow: true });
  await req(jar, agent, "https://account.xiaomi.com/identity/list", {
    query: { sid: "xiaomiio", context, _locale: "en_US" },
  });

  await req(jar, agent, "https://account.xiaomi.com/identity/auth/sendEmailTicket", {
    method: "POST",
    query: { _dc: String(Date.now()), sid: "xiaomiio", context, mask: "0", _locale: "en_US" },
    form: { retry: "0", icode: "", _json: "true", ick: jar.get("ick") ?? "" },
  });

  console.log("\nTwo-factor verification required. Xiaomi has emailed you a code.");
  const code = await ask("Code from the email: ");

  const verify = await req(jar, agent, "https://account.xiaomi.com/identity/auth/verifyEmail", {
    method: "POST",
    query: { _flag: "8", _json: "true", sid: "xiaomiio", context, mask: "0", _locale: "en_US" },
    form: { _flag: "8", ticket: code, trust: "false", _json: "true", ick: jar.get("ick") ?? "" },
  });

  let finish: string | undefined;
  try {
    finish = stripPrefix(verify.body).location;
  } catch {
    finish = verify.res.headers.get("location") ?? undefined;
  }
  if (!finish) {
    const check = await req(jar, agent, "https://account.xiaomi.com/identity/result/check", {
      query: { sid: "xiaomiio", context, _locale: "en_US" },
    });
    finish = check.res.headers.get("location") ?? undefined;
  }
  if (!finish) throw new Error("wrong or expired code");

  let endUrl = finish;
  if (finish.includes("identity/result/check")) {
    const hop = await req(jar, agent, finish);
    endUrl = hop.res.headers.get("location") ?? "";
  }
  if (!endUrl) throw new Error("could not follow the verification through");

  let end = await req(jar, agent, endUrl);
  // The first call sometimes returns an interstitial page; the redirect and the
  // extension-pragma header only appear on the second.
  if (end.res.status === 200 && end.body.includes("Xiaomi Account - Tips")) end = await req(jar, agent, endUrl);

  const pragma = end.res.headers.get("extension-pragma");
  const ssecurity = pragma ? JSON.parse(pragma).ssecurity : undefined;
  if (!ssecurity) throw new Error("verification finished but no ssecurity came back");

  let sts = end.res.headers.get("location");
  if (!sts) {
    const found = end.body.match(/https:\/\/sts\.api\.io\.mi\.com\/sts[^"']*/);
    sts = found?.[0] ?? null;
  }
  if (!sts) throw new Error("verification finished but no service-token redirect came back");
  await req(jar, agent, sts, { follow: true });

  return ssecurity;
}

export async function passwordLogin(): Promise<Session> {
  const agent = randomAgent();
  const deviceId = randomDeviceId();
  const jar = new Jar();
  for (const domain of [".mi.com", ".xiaomi.com"]) {
    jar.set("sdkVersion", "accountsdk-18.8.15", domain);
    jar.set("deviceId", deviceId, domain);
  }

  const username = await ask("Xiaomi account (email, phone or user ID): ");
  const password = await askHidden("Password (not shown): ");
  if (!username || !password) throw new Error("username and password are both required");

  // Step 1: ask what this account needs. Either a signing token comes back, or
  // the account is somehow already authenticated and we are done early.
  jar.set("userId", username, "account.xiaomi.com");
  const first = await req(jar, agent, "https://account.xiaomi.com/pass/serviceLogin", {
    query: { sid: "xiaomiio", _json: "true" },
  });
  const start = stripPrefix(first.body);
  let ssecurity: string | undefined = start.ssecurity;
  let userId: string | undefined = start.userId ? String(start.userId) : undefined;
  let location: string | undefined = start.location;

  if (!ssecurity) {
    if (!start._sign) throw new Error("unknown account — check the email, phone number or user ID");

    // Step 2: the password itself, sent as an uppercase MD5.
    const fields: Record<string, string> = {
      sid: "xiaomiio",
      hash: createHash("md5").update(password, "utf8").digest("hex").toUpperCase(),
      callback: "https://sts.api.io.mi.com/sts",
      qs: "%3Fsid%3Dxiaomiio%26_json%3Dtrue",
      user: username,
      _sign: start._sign,
      _json: "true",
    };

    let auth = await req(jar, agent, "https://account.xiaomi.com/pass/serviceLoginAuth2", { method: "POST", query: fields });
    let result = stripPrefix(auth.body);

    if (result.captchaUrl) {
      const captchaUrl = result.captchaUrl.startsWith("/") ? `https://account.xiaomi.com${result.captchaUrl}` : result.captchaUrl;
      const image = await fetch(captchaUrl, { headers: { "User-Agent": agent, Cookie: jar.header(captchaUrl) } });
      jar.absorb(image, captchaUrl);
      await showImage(await image.arrayBuffer(), "lamp-captcha.png", "Captcha required.");
      fields.captCode = await ask("Captcha as shown (case-sensitive): ");

      auth = await req(jar, agent, "https://account.xiaomi.com/pass/serviceLoginAuth2", { method: "POST", query: fields });
      result = stripPrefix(auth.body);
      if (result.code === 87001) throw new Error("captcha was wrong");
    }

    if (result.ssecurity && String(result.ssecurity).length > 4) {
      ssecurity = result.ssecurity;
      userId = result.userId ? String(result.userId) : undefined;
      location = result.location;
    } else if (result.notificationUrl) {
      ssecurity = await twoFactor(jar, agent, result.notificationUrl);
      userId = userId ?? jar.get("userId", ".xiaomi.com") ?? jar.get("userId", ".mi.com");
    } else {
      throw new Error("wrong password, or the account is locked");
    }
  }

  // Step 3: trade the location for the service token, unless two-factor
  // already walked through the STS hop and left one in the jar.
  if (location && !jar.get("serviceToken", ".mi.com")) await req(jar, agent, location, { follow: true });

  const serviceToken = jar.get("serviceToken", ".mi.com") ?? jar.get("serviceToken");
  if (!serviceToken) throw new Error("signed in, but no service token came back");
  if (!ssecurity) throw new Error("signed in, but no ssecurity came back");
  if (!userId) throw new Error("signed in, but no user id came back");

  return { userId, ssecurity, serviceToken, agent };
}

// --- device list --------------------------------------------------------------

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
