import {
  locadoraSaveDeleteSchema,
  locadoraSaveDownloadSchema,
  locadoraSaveListSchema,
  locadoraSaveStatusSchema,
  locadoraSaveUploadSchema,
  locadoraSaveCommitSchema,
  locadoraSaveRowSchema,
  type BridgeSyncEntry,
  type LocadoraDeviceKind,
  type LocadoraSaveRow,
} from "@pqp/shared";
import { apiFetch } from "@/lib/api";

/**
 * SAVES NA CONTA, the host half (flag `locadora_save_sync`): what the bridge
 * host does for Locadora's `sync.*` requests. The app frame hands over the
 * SHA-256 of the game file it holds and the bytes of one save; THIS module,
 * on the pqp page, turns the hash into the account's key and moves the bytes:
 *
 *  - `gameKey = base64url(HMAC-SHA256(salt, sha256 bytes))`, with the salt the
 *    API keeps for this account and hands to it alone. The raw hash never
 *    leaves the page, so the server never learns which game a save is for.
 *  - the bytes go to the bucket and come back from it with presigned URLs
 *    (`PUT`, then a commit the server checks with a HEAD), never through the
 *    API, exactly like attachments.
 *  - the device is a coarse kind (computer, phone, tablet) and a random id
 *    this browser keeps for itself in `localStorage`, so "Tu parou no
 *    computador" can be said. Not a fingerprint: it is minted here and
 *    nothing else is read to make it.
 *
 * The app never sees a token, a user id, a salt or a key.
 */

export type SaveSyncErrorCode = "off" | "stale" | "too-large" | "rate-limited" | "unavailable";

export class SaveSyncError extends Error {
  constructor(
    readonly code: SaveSyncErrorCode,
    /** With `stale`: what is on the account now, or null when it was deleted. */
    readonly current: LocadoraSaveRow | null = null,
  ) {
    super(`save sync: ${code}`);
    this.name = "SaveSyncError";
  }
}

export interface SyncStatusResult {
  mode: "on" | "read-only";
  used: number;
  cap: number;
  device: LocadoraDeviceKind;
}

export interface SyncPutInput {
  game: string;
  kind: "sram" | "state";
  slot: number;
  baseRev: number;
  bytes: ArrayBuffer;
  thumb?: ArrayBuffer;
  platform: string;
  core: string;
  coreVersion: string;
}

export interface SaveSyncClient {
  status(sessionId: string): Promise<SyncStatusResult>;
  list(sessionId: string, game: string): Promise<BridgeSyncEntry[]>;
  get(sessionId: string, id: string): Promise<{ rev: number; bytes: ArrayBuffer; thumb: ArrayBuffer | null }>;
  put(sessionId: string, input: SyncPutInput): Promise<{ id: string; rev: number; used: number; cap: number }>;
  remove(sessionId: string, id: string): Promise<{ used: number; cap: number }>;
  restore(sessionId: string, id: string, baseRev: number): Promise<{ id: string; rev: number }>;
  clear(sessionId: string, game: string | null): Promise<{ deleted: number; used: number; cap: number }>;
}

export type ApiCall = (path: string, init?: RequestInit) => Promise<unknown>;

export interface SaveSyncOptions {
  api?: ApiCall;
  fetchImpl?: typeof fetch;
  device?: { kind: LocadoraDeviceKind; id: string };
  subtle?: SubtleCrypto;
}

const BASE = "/api/apps/pqp-locadora/saves";
const DEVICE_KEY = "pqp:apps:save-sync-device";

/** What this device is, coarsely. Only the kind of device, from what the browser already says about itself. */
export function deviceKindOf(nav: Pick<Navigator, "userAgent" | "maxTouchPoints"> & { userAgentData?: { mobile?: boolean } }): LocadoraDeviceKind {
  const ua = nav.userAgent ?? "";
  if (/iPad|Tablet/i.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1)) return "tablet";
  if (/Android/i.test(ua) && !/Mobile/i.test(ua)) return "tablet";
  if (nav.userAgentData?.mobile === true || /iPhone|iPod|Android.*Mobile|Mobile Safari/i.test(ua)) return "phone";
  return "computer";
}

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function hexOf(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The random id this browser keeps for itself; in memory where storage is blocked. */
export function deviceId(storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage()): string {
  try {
    const kept = storage?.getItem(DEVICE_KEY);
    if (kept && /^[A-Za-z0-9_-]{16,32}$/.test(kept)) return kept;
  } catch {
    // blocked: a fresh one for this page
  }
  const fresh = base64url(crypto.getRandomValues(new Uint8Array(16)));
  try {
    storage?.setItem(DEVICE_KEY, fresh);
  } catch {
    // the page forgets it on close; the saves still sync, only "from this device" is lost
  }
  return fresh;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The API's refusal, as one of the codes the bridge speaks. */
function mapError(error: unknown): SaveSyncError {
  if (error instanceof SaveSyncError) return error;
  const status = (error as { status?: unknown } | null)?.status;
  const details = (error as { details?: unknown } | null)?.details as { save?: unknown } | undefined;
  if (status === 404) return new SaveSyncError("off");
  if (status === 409) {
    const parsed = locadoraSaveRowSchema.safeParse(details?.save);
    return new SaveSyncError("stale", parsed.success ? parsed.data : null);
  }
  if (status === 413) return new SaveSyncError("too-large");
  if (status === 429) return new SaveSyncError("rate-limited");
  return new SaveSyncError("unavailable");
}

export function createSaveSync(options: SaveSyncOptions = {}): SaveSyncClient {
  const api: ApiCall = options.api ?? ((path, init) => apiFetch<unknown>(path, init ?? {}));
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const subtle = options.subtle ?? crypto.subtle;
  let device: { kind: LocadoraDeviceKind; id: string } | null = options.device ?? null;
  const thisDevice = () => (device ??= { kind: deviceKindOf(navigator), id: deviceId() });
  let salt: Promise<CryptoKey> | null = null;
  const keys = new Map<string, Promise<string>>();

  async function call<T>(path: string, init: RequestInit | undefined, parse: (raw: unknown) => T): Promise<T> {
    let raw: unknown;
    try {
      raw = await api(path, init);
    } catch (error) {
      throw mapError(error);
    }
    try {
      return parse(raw);
    } catch {
      throw new SaveSyncError("unavailable");
    }
  }

  const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
  const q = (sessionId: string) => `sessionId=${encodeURIComponent(sessionId)}`;

  async function statusOf(sessionId: string) {
    return call(`${BASE}/status?${q(sessionId)}`, undefined, (raw) => locadoraSaveStatusSchema.parse(raw));
  }

  async function keyFor(sessionId: string, game: string): Promise<string> {
    let found = keys.get(game);
    if (!found) {
      found = (async () => {
        salt ??= statusOf(sessionId).then((status) =>
          subtle.importKey("raw", fromBase64url(status.salt) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
        );
        let hmac: CryptoKey;
        try {
          hmac = await salt;
        } catch (error) {
          salt = null;
          throw error;
        }
        return base64url(new Uint8Array(await subtle.sign("HMAC", hmac, hexBytes(game) as BufferSource)));
      })();
      keys.set(game, found);
      found.catch(() => keys.delete(game));
    }
    return found;
  }

  async function fetchBytes(url: string): Promise<ArrayBuffer> {
    let res: Response;
    try {
      res = await fetchImpl(url, { credentials: "omit" });
    } catch {
      throw new SaveSyncError("unavailable");
    }
    if (!res.ok) throw new SaveSyncError("unavailable");
    return res.arrayBuffer();
  }

  async function putBytes(target: { url: string; contentType: string }, bytes: ArrayBuffer): Promise<void> {
    let res: Response;
    try {
      res = await fetchImpl(target.url, {
        method: "PUT",
        headers: { "Content-Type": target.contentType },
        body: bytes,
        credentials: "omit",
      });
    } catch {
      throw new SaveSyncError("unavailable");
    }
    if (!res.ok) throw new SaveSyncError("unavailable");
  }

  function entryOf(row: LocadoraSaveRow): BridgeSyncEntry {
    return {
      id: row.id,
      kind: row.kind,
      slot: row.slot,
      rev: row.rev,
      size: row.size,
      hash: row.sha256,
      savedAt: row.updatedAt,
      device: row.deviceKind,
      thisDevice: row.deviceId === thisDevice().id,
      thumb: row.hasThumb,
      platform: row.platform,
      core: row.core,
      coreVersion: row.coreVersion,
      history: row.history,
    };
  }

  return {
    async status(sessionId) {
      const status = await statusOf(sessionId);
      return { mode: status.mode, used: status.usage.used, cap: status.usage.cap, device: thisDevice().kind };
    },
    async list(sessionId, game) {
      const gameKey = await keyFor(sessionId, game);
      const list = await call(`${BASE}?${q(sessionId)}&gameKey=${gameKey}`, undefined, (raw) => locadoraSaveListSchema.parse(raw));
      return list.saves.map(entryOf);
    },
    async get(sessionId, id) {
      const down = await call(`${BASE}/${encodeURIComponent(id)}/download?${q(sessionId)}`, undefined, (raw) =>
        locadoraSaveDownloadSchema.parse(raw),
      );
      const [bytes, thumb] = await Promise.all([fetchBytes(down.url), down.thumbUrl ? fetchBytes(down.thumbUrl) : Promise.resolve(null)]);
      return { rev: down.rev, bytes, thumb };
    },
    async put(sessionId, input) {
      const gameKey = await keyFor(sessionId, input.game);
      const me = thisDevice();
      const sha256 = hexOf(await subtle.digest("SHA-256", input.bytes));
      const upload = await call(
        `${BASE}/upload`,
        post({
          sessionId,
          gameKey,
          kind: input.kind,
          slot: input.slot,
          baseRev: input.baseRev,
          size: input.bytes.byteLength,
          sha256,
          thumbSize: input.thumb?.byteLength ?? 0,
          platform: input.platform,
          core: input.core,
          coreVersion: input.coreVersion,
          deviceKind: me.kind,
          deviceId: me.id,
        }),
        (raw) => locadoraSaveUploadSchema.parse(raw),
      );
      await putBytes(upload.put, input.bytes);
      if (upload.thumbPut && input.thumb) await putBytes(upload.thumbPut, input.thumb);
      const done = await call(`${BASE}/uploads/${encodeURIComponent(upload.uploadId)}/commit`, post({ sessionId }), (raw) =>
        locadoraSaveCommitSchema.parse(raw),
      );
      return { id: done.save.id, rev: done.save.rev, used: done.usage.used, cap: done.usage.cap };
    },
    async remove(sessionId, id) {
      const out = await call(`${BASE}/${encodeURIComponent(id)}?${q(sessionId)}`, { method: "DELETE" }, (raw) =>
        locadoraSaveDeleteSchema.parse(raw),
      );
      return out.usage;
    },
    async restore(sessionId, id, baseRev) {
      const out = await call(`${BASE}/${encodeURIComponent(id)}/restore`, post({ sessionId, baseRev }), (raw) =>
        locadoraSaveRowSchema.parse((raw as { save?: unknown } | null)?.save),
      );
      return { id: out.id, rev: out.rev };
    },
    async clear(sessionId, game) {
      const gameKey = game ? `&gameKey=${await keyFor(sessionId, game)}` : "";
      const out = await call(`${BASE}?${q(sessionId)}${gameKey}`, { method: "DELETE" }, (raw) => locadoraSaveDeleteSchema.parse(raw));
      return { deleted: out.deleted, used: out.usage.used, cap: out.usage.cap };
    },
  };
}
