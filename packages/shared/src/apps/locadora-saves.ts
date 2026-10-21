import { z } from "zod";

/**
 * SAVES NA CONTA (Locadora, flag `locadora_save_sync`, per server, default
 * off). The HTTP contract between the pqp page (the bridge host) and the API.
 * The app frame never speaks it: it asks the host through the bridge's
 * `sync.*` requests (`bridge.ts`), and the host, which holds the token, talks
 * to these routes. Contract and limits in one place so the server, the host
 * and the tests read the same numbers.
 *
 * What is stored: battery saves (SRAM) and save states and their small
 * thumbnails. NEVER the game file, never its title, never box art. A save is
 * keyed by `gameKey = HMAC-SHA256(accountSalt, romSha256)`, computed by the
 * host: the raw hash of the game never reaches the server, and a save only
 * shows up on a device that holds the same file. The server holds the salt,
 * so it COULD test a known hash against a key; the policy is to never build
 * or keep such a list (docs/EMULATOR_ROOM.md, rule 7).
 */

export const LOCADORA_APP_ID = "pqp-locadora";

export const LOCADORA_SAVE_LIMITS = {
  /** A gzipped save state. */
  stateBytes: 1024 * 1024,
  /** A battery save. */
  sramBytes: 256 * 1024,
  /** A slot's PNG thumbnail. */
  thumbBytes: 16 * 1024,
  /** Everything one account keeps: saves, their thumbnails, the SRAM history and uploads in flight. */
  accountBytes: 8 * 1024 * 1024,
  /** Uploads and deletes per account per minute. */
  writesPerMinute: 30,
  /** Older battery saves kept per game (an undo for "used the other one"), counted in the quota. */
  sramHistory: 3,
  /** A save not written for this long is deleted by the sweep. */
  retentionDays: 365,
  /** With the flag turned off, reads (and deletes) keep working this long after the last write. */
  readOnlyDays: 30,
  /** An upload that was never committed is dropped after this. */
  uploadTtlMinutes: 60,
} as const;

/** base64url of a 32 byte HMAC-SHA256, no padding. */
export const locadoraGameKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** The per-account salt, base64url of 32 random bytes. */
export const locadoraSaltSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const locadoraSaveKindSchema = z.enum(["sram", "state"]);
export type LocadoraSaveKind = z.infer<typeof locadoraSaveKindSchema>;
/** 0 is the battery save (always) and the rolling autosave; 1 to 4 are the manual slots. */
export const locadoraSaveSlotSchema = z.number().int().min(0).max(4);
/** A coarse kind, so a person reads "do computador" or "do celular". Never a model or a name. */
export const locadoraDeviceKindSchema = z.enum(["computer", "phone", "tablet"]);
export type LocadoraDeviceKind = z.infer<typeof locadoraDeviceKindSchema>;
/** A random id the host keeps per browser, so "from another device" can be told. Not a fingerprint. */
export const locadoraDeviceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,32}$/);
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
/** Free-form but tame: `nes`, `fceumm`, `0.9.1`. */
const tagSchema = z.string().regex(/^[A-Za-z0-9._+-]{1,32}$/);

export const locadoraSaveUsageSchema = z
  .object({ used: z.number().int().min(0), cap: z.number().int().min(0) })
  .strip();
export type LocadoraSaveUsage = z.infer<typeof locadoraSaveUsageSchema>;

/** One save as the routes describe it. Never carries an object key or a user id. */
export const locadoraSaveRowSchema = z
  .object({
    id: z.string().uuid(),
    kind: locadoraSaveKindSchema,
    slot: locadoraSaveSlotSchema,
    rev: z.number().int().min(1),
    size: z.number().int().min(0),
    sha256: sha256HexSchema,
    hasThumb: z.boolean(),
    platform: tagSchema,
    core: tagSchema,
    coreVersion: tagSchema,
    deviceKind: locadoraDeviceKindSchema,
    deviceId: locadoraDeviceIdSchema,
    /** Epoch ms of the commit. */
    updatedAt: z.number().int().min(0),
    /** Only for a battery save: how many older versions the account keeps for it. */
    history: z.number().int().min(0).default(0),
  })
  .strip();
export type LocadoraSaveRow = z.infer<typeof locadoraSaveRowSchema>;

/**
 * `GET /api/apps/pqp-locadora/saves/status?sessionId=`. `on`: reads and writes;
 * `read-only`: the flag was turned off and this account wrote something in the
 * last `readOnlyDays`, so it can still take its saves back (and delete them).
 * Anything else is a 404.
 */
export const locadoraSaveStatusSchema = z
  .object({
    mode: z.enum(["on", "read-only"]),
    salt: locadoraSaltSchema,
    usage: locadoraSaveUsageSchema,
  })
  .strip();
export type LocadoraSaveStatus = z.infer<typeof locadoraSaveStatusSchema>;

/** `GET /api/apps/pqp-locadora/saves?sessionId=&gameKey=` */
export const locadoraSaveListSchema = z
  .object({ saves: z.array(locadoraSaveRowSchema).max(16) })
  .strip();

/** `POST /api/apps/pqp-locadora/saves/upload`. Strict: it comes from a client. */
export const locadoraSaveUploadBodySchema = z
  .object({
    sessionId: z.string().uuid(),
    gameKey: locadoraGameKeySchema,
    kind: locadoraSaveKindSchema,
    slot: locadoraSaveSlotSchema,
    /** The rev this write replaces, 0 for "there is none". A mismatch is 409 `stale_rev`. */
    baseRev: z.number().int().min(0),
    size: z.number().int().min(1).max(LOCADORA_SAVE_LIMITS.stateBytes),
    sha256: sha256HexSchema,
    /** 0 means no thumbnail. */
    thumbSize: z.number().int().min(0).max(LOCADORA_SAVE_LIMITS.thumbBytes),
    platform: tagSchema,
    core: tagSchema,
    coreVersion: tagSchema,
    deviceKind: locadoraDeviceKindSchema,
    deviceId: locadoraDeviceIdSchema,
  })
  .strict()
  .refine((body) => body.kind !== "sram" || body.slot === 0, { message: "a battery save is slot 0" })
  .refine((body) => body.kind !== "sram" || body.size <= LOCADORA_SAVE_LIMITS.sramBytes, {
    message: "a battery save is at most 256 KB",
  });
export type LocadoraSaveUploadBody = z.infer<typeof locadoraSaveUploadBodySchema>;

/** The presigned PUTs, signed with these exact headers. */
export const locadoraSaveUploadSchema = z
  .object({
    uploadId: z.string().uuid(),
    put: z.object({ url: z.string().url(), contentType: z.string() }).strip(),
    thumbPut: z.object({ url: z.string().url(), contentType: z.string() }).strip().nullable(),
  })
  .strip();
export type LocadoraSaveUpload = z.infer<typeof locadoraSaveUploadSchema>;

/** `POST /api/apps/pqp-locadora/saves/uploads/:uploadId/commit` */
export const locadoraSaveCommitBodySchema = z.object({ sessionId: z.string().uuid() }).strict();
export const locadoraSaveCommitSchema = z
  .object({ save: locadoraSaveRowSchema, usage: locadoraSaveUsageSchema })
  .strip();

/** `GET /api/apps/pqp-locadora/saves/:saveId/download?sessionId=` */
export const locadoraSaveDownloadSchema = z
  .object({ rev: z.number().int().min(1), url: z.string().url(), thumbUrl: z.string().url().nullable() })
  .strip();

/** `POST /api/apps/pqp-locadora/saves/:saveId/restore` `{ sessionId, baseRev }`: the newest older battery save comes back. */
export const locadoraSaveRestoreBodySchema = z
  .object({ sessionId: z.string().uuid(), baseRev: z.number().int().min(1) })
  .strict();

/** The DELETE routes answer what is left. */
export const locadoraSaveDeleteSchema = z
  .object({ deleted: z.number().int().min(0), usage: locadoraSaveUsageSchema })
  .strip();

/** The 409 body: what is on the account now, so the conflict sheet can show it. `null` when it was deleted. */
export const locadoraSaveConflictSchema = z
  .object({ error: z.literal("stale_rev"), save: locadoraSaveRowSchema.nullable() })
  .strip();
