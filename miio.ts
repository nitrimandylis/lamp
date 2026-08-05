// The miIO protocol, as spoken by Xiaomi devices on udp/54321.
//
// A packet is a 32-byte header followed by an AES-128-CBC encrypted JSON body.
// The header is: magic(2) length(2) unknown(4) deviceId(4) stamp(4) checksum(16).
// The checksum is md5 over the header with the raw token sitting in the checksum
// slot, followed by the encrypted body.

import { createHash, createCipheriv, createDecipheriv } from "node:crypto";
import { createSocket } from "node:dgram";

const PORT = 54321;

// A "hello" is a header with an all-0xff unknown field and no body. The device
// replies with its id and its own clock, which every later packet must echo.
const HELLO = Buffer.concat([Buffer.from("21310020", "hex"), Buffer.alloc(28, 0xff)]);

export class LampUnreachable extends Error {}

function keys(token: Buffer) {
  const key = createHash("md5").update(token).digest();
  const iv = createHash("md5").update(Buffer.concat([key, token])).digest();
  return { key, iv };
}

export function encrypt(plain: Buffer, token: Buffer): Buffer {
  const { key, iv } = keys(token);
  const c = createCipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([c.update(plain), c.final()]);
}

export function decrypt(body: Buffer, token: Buffer): Buffer {
  const { key, iv } = keys(token);
  const d = createDecipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([d.update(body), d.final()]);
}

export function buildPacket(deviceId: number, stamp: number, token: Buffer, json: string): Buffer {
  const body = encrypt(Buffer.from(json, "utf8"), token);
  const header = Buffer.alloc(16);
  header.writeUInt16BE(0x2131, 0);
  header.writeUInt16BE(32 + body.length, 2);
  header.writeUInt32BE(0, 4);
  header.writeUInt32BE(deviceId, 8);
  header.writeUInt32BE(stamp, 12);
  const checksum = createHash("md5").update(Buffer.concat([header, token, body])).digest();
  return Buffer.concat([header, checksum, body]);
}

export function parsePacket(packet: Buffer, token: Buffer): { deviceId: number; stamp: number; body: string } {
  const deviceId = packet.readUInt32BE(8);
  const stamp = packet.readUInt32BE(12);
  const body = packet.subarray(32);
  if (body.length === 0) return { deviceId, stamp, body: "" };
  // Devices null-pad the decrypted JSON, so trim before handing it back.
  return { deviceId, stamp, body: decrypt(body, token).toString("utf8").replace(/\0+$/, "") };
}

function send(ip: string, packet: Buffer, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock = createSocket("udp4");
    const timer = setTimeout(() => {
      sock.close();
      reject(new LampUnreachable(`no reply from ${ip} within ${timeoutMs}ms`));
    }, timeoutMs);
    sock.on("message", (msg) => {
      clearTimeout(timer);
      sock.close();
      resolve(msg);
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      sock.close();
      reject(new LampUnreachable(err.message));
    });
    sock.send(packet, PORT, ip);
  });
}

export class Device {
  private deviceId = 0;
  private stamp = 0;
  // Local clock reading at the moment the device reported `stamp`, so we can
  // advance its clock ourselves instead of doing a handshake per command.
  private stampReadAt = 0;
  private nextId = 1;

  constructor(private ip: string, private token: Buffer, private timeoutMs = 3000) {}

  async handshake(): Promise<void> {
    const reply = await send(this.ip, HELLO, this.timeoutMs);
    this.deviceId = reply.readUInt32BE(8);
    this.stamp = reply.readUInt32BE(12);
    this.stampReadAt = Date.now();
  }

  async call(method: string, params: unknown[] = []): Promise<unknown> {
    if (!this.stampReadAt) await this.handshake();
    const stamp = this.stamp + Math.floor((Date.now() - this.stampReadAt) / 1000);
    const json = JSON.stringify({ id: this.nextId++, method, params });
    const reply = await send(this.ip, buildPacket(this.deviceId, stamp, this.token, json), this.timeoutMs);
    const { body } = parsePacket(reply, this.token);
    if (!body) throw new Error(`empty reply to ${method}`);
    const parsed = JSON.parse(body) as { result?: unknown; error?: { message?: string } };
    if (parsed.error) throw new Error(`${method}: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
    return parsed.result;
  }
}
