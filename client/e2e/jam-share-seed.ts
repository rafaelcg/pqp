/**
 * The room the Jam share specs (and a person trying it by hand) start from:
 *
 *   - three accounts: `host` (owns the server and wrote the songs), `member`
 *     (joined by invite) and `outsider` (never joined: the person a pasted link
 *     must show as a plain link, never a card);
 *   - a server with `jam_channels` on, a text channel `geral` and `musica`, and a Jam;
 *   - songs: "In Bloom" (a cover, a video, three takes), "Meu Riff" (open to a bass
 *     that nobody has recorded: "Falta baixo") and "Rascunho" (no take: its author's alone).
 *
 * Plain `fetch` and nothing from Playwright, so a script can call it too.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const CLIP = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "jam-clip.webm"));
const DEV_TOKEN = "dev-local-token";

export interface JamShareSeed {
  api: string;
  host: string;
  member: string;
  outsider: string;
  serverId: string;
  generalId: string;
  musicaId: string;
  jamId: string;
  uploads: boolean;
  bloom: string;
  riff: string;
  draft: string;
}

const headersFor = (suffix: string) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
});

export async function call<T>(api: string, suffix: string, method: string, route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${api}${route}`, {
    method,
    headers: headersFor(suffix),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${method} ${route} -> ${response.status} ${await response.text()}`);
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

export async function materialise(api: string, suffix: string): Promise<void> {
  const headers = headersFor(suffix);
  const me = await fetch(`${api}/api/me`, { headers });
  const body = (await me.json()) as { ageGate?: string };
  if (body.ageGate && body.ageGate !== "passed") {
    await fetch(`${api}/api/me/age-check`, { method: "POST", headers, body: JSON.stringify({ dateOfBirth: "1990-01-01" }) });
  }
  await fetch(`${api}/api/me/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ onboardedAt: new Date().toISOString(), firstRunDismissedAt: new Date().toISOString() }),
  });
}

/** A few seconds of a plucked note as a 16-bit mono WAV (declared as FLAC: the server never decodes audio). */
function wav(seconds: number, note: number): Buffer {
  const rate = 8000;
  const samples = rate * seconds;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const t = i / rate;
    data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * note * t) * Math.exp(-(t % 0.5) * 5) * 9000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** A square RGBA PNG with a diagonal band pattern, so a cover has something to look at. */
function png(size: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(6, 9);
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x += 1) {
      const band = Math.floor((x + y) / (size / 6)) % 2 === 0;
      row[1 + x * 4] = band ? 200 : 40;
      row[2 + x * 4] = Math.round((y / size) * 160) + 30;
      row[3 + x * 4] = band ? 60 : 150;
      row[4 + x * 4] = 255;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function upload(api: string, who: string, songId: string, kind: "audio" | "video" | "cover", bytes: Buffer): Promise<string> {
  const contentType = kind === "audio" ? "audio/flac" : kind === "video" ? "video/webm" : "image/png";
  const ticket = await call<{ uploadId: string; uploadUrl: string }>(api, who, "POST", `/api/jam-songs/${songId}/uploads`, {
    kind,
    contentType,
    byteSize: bytes.length,
  });
  const put = await fetch(ticket.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType, "Content-Length": String(bytes.length) },
    body: bytes,
  });
  if (!put.ok) {
    throw new Error(`PUT ${kind} -> ${put.status}`);
  }
  return ticket.uploadId;
}

async function addTrack(api: string, who: string, songId: string, instrument: string, withVideo: boolean, note: number): Promise<string> {
  const audioUploadId = await upload(api, who, songId, "audio", wav(10, note));
  const videoUploadId = withVideo ? await upload(api, who, songId, "video", CLIP) : null;
  const { track } = await call<{ track: { id: string } }>(api, who, "POST", `/api/jam-songs/${songId}/tracks`, {
    instrument,
    audioUploadId,
    ...(videoUploadId ? { videoUploadId } : {}),
    durationMs: 10_000,
    peaks: [0.2, 0.8, 0.5, 0.9, 0.3, 0.7, 0.4, 0.9, 0.2, 0.6],
  });
  return track.id;
}

export async function seedJamShare(api: string, adminToken: string, tag: string): Promise<JamShareSeed> {
  const host = `jshost${tag}`;
  const member = `jsmember${tag}`;
  const outsider = `jsoutsider${tag}`;
  await Promise.all([host, member, outsider].map((who) => materialise(api, who)));
  const { server } = await call<{ server: { id: string } }>(api, host, "POST", "/api/servers", { name: `Ensaio ${tag}` });
  const { invite } = await call<{ invite: { code: string } }>(api, host, "POST", `/api/servers/${server.id}/invites`, {});
  await call(api, member, "POST", `/api/invites/${invite.code}/join`);
  const flip = await fetch(`${api}/api/admin/flag-overrides`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ key: "jam_channels", serverId: server.id, enabled: true }),
  });
  if (flip.status !== 200) {
    throw new Error(`flag-overrides -> ${flip.status}`);
  }
  const channels = await call<{ channels: { id: string; name: string; type: string }[] }>(api, host, "GET", `/api/servers/${server.id}/channels`);
  const general = channels.channels.find((channel) => channel.type === "text");
  const { channel: musica } = await call<{ channel: { id: string } }>(api, host, "POST", `/api/servers/${server.id}/channels`, { name: "musica", type: "text" });
  const { channel: jam } = await call<{ channel: { id: string } }>(api, host, "POST", `/api/servers/${server.id}/channels`, { name: "jam", type: "jam" });
  const config = await call<{ uploads: boolean }>(api, host, "GET", `/api/jam/config?serverId=${server.id}`);
  const empty: JamShareSeed = {
    api,
    host,
    member,
    outsider,
    serverId: server.id,
    generalId: general?.id ?? "",
    musicaId: musica.id,
    jamId: jam.id,
    uploads: config.uploads,
    bloom: "",
    riff: "",
    draft: "",
  };
  const make = async (body: Record<string, unknown>) => (await call<{ song: { id: string } }>(api, host, "POST", `/api/channels/${jam.id}/jam-songs`, body)).song.id;
  const draft = await make({ title: "Rascunho" });
  if (!config.uploads) {
    return { ...empty, draft };
  }
  const bloom = await make({ title: "In Bloom", artist: "Nirvana" });
  await addTrack(api, host, bloom, "drums", false, 98);
  await addTrack(api, member, bloom, "guitar", true, 196);
  await addTrack(api, host, bloom, "vocals", false, 220);
  const coverUpload = await upload(api, host, bloom, "cover", png(512));
  await call(api, host, "PUT", `/api/jam-songs/${bloom}/cover`, { uploadId: coverUpload });
  const riff = await make({ title: "Meu Riff", joinMode: "wanted", wantedInstruments: ["bass", "guitar", "drums"] });
  await addTrack(api, host, riff, "guitar", false, 165);
  await addTrack(api, member, riff, "drums", false, 98);
  return { ...empty, bloom, riff, draft };
}
