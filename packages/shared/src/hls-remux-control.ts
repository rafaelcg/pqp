import { z } from "zod";

/**
 * The control-plane contract between `pqp-api` and `pqp-remux`
 * (`docs/plans/LL_HLS.md`, task L1.5 defines it, L1.6 implements the Go side).
 *
 * `pqp-remux` runs on the egress box and, per its `README.md`, one *process*
 * subscribes to one LiveKit room today (`ROOM` is a single env var). The
 * control API this file describes is what turns that into something
 * `pqp-api` can drive for however many parties are live at once: a small
 * HTTP surface a **supervisor** on the egress box exposes, fronting one
 * `pqp-remux` subscriber per session. `pqp-api` never spawns a process or
 * touches the box directly — it only ever speaks this HTTP contract, pointed
 * at `LIVE_HLS_REMUX_CONTROL_URL`.
 *
 * Three routes, every one authenticated the same way (see "Signing" below):
 *
 *   POST   /sessions       Start a session. Body: {@link remuxStartSessionRequestSchema}.
 *                          201 with {@link remuxSessionInfoSchema}, or a 4xx/5xx
 *                          with {@link remuxErrorResponseSchema}. A `sessionId`
 *                          already running answers 409 with the existing info
 *                          (idempotent restart-safety for a retried start).
 *   DELETE /sessions/:id   Stop a session by `sessionId`. 204 on success (also
 *                          on "already gone" — stopping is idempotent), 4xx/5xx
 *                          with {@link remuxErrorResponseSchema} otherwise.
 *   GET    /sessions       Every session the box currently holds. 200 with
 *                          {@link remuxListSessionsResponseSchema}. This is
 *                          what `pqp-api` reconciles against `hls_sessions` on
 *                          boot (`docs/plans/LL_HLS.md` §5, "adoption is free").
 *
 * ## Signing
 *
 * A shared secret (`LIVE_HLS_REMUX_CONTROL_SECRET`), never a bearer token
 * pasted into a header: the box and the API are two processes on two boxes
 * with no PKI between them, and HMAC over the request is what a Go binary and
 * a Node one can both produce byte-for-byte from nothing but the secret and
 * the request itself.
 *
 * Three headers on every request:
 *
 *   X-Pqp-Remux-Timestamp   Unix milliseconds, as a decimal string, of when
 *                           the request was signed.
 *   X-Pqp-Remux-Nonce       A random, per-request token (16+ bytes of hex, a
 *                           UUID — anything sufficiently unlikely to repeat
 *                           by accident). Folded into the signed payload so
 *                           a captured request cannot be replayed even
 *                           inside the clock-skew window: `pqp-remux`
 *                           remembers every nonce it has accepted for
 *                           2×{@link REMUX_CONTROL_CLOCK_SKEW_MS} and refuses
 *                           an exact repeat (L1.6, `nonceCache` /
 *                           `nonce_cache.go`). This side only has to
 *                           generate one and sign it — the replay store
 *                           lives entirely on the box.
 *   X-Pqp-Remux-Signature   Lowercase hex HMAC-SHA256, computed as described
 *                           below.
 *
 * The signed payload is built by {@link remuxControlSignaturePayload} — kept
 * pure and dependency-free (no `node:crypto`) so this file stays isomorphic
 * and so the exact string either side hashes is defined ONCE, here, rather
 * than redescribed in two languages and drifting:
 *
 *   `${method.toUpperCase()}\n${path}\n${timestampMs}\n${nonce}\n${rawBody}`
 *
 * `method` is the HTTP verb. `path` is the request path with no scheme, host
 * or query string (these routes take none) — for `DELETE /sessions/:id` that
 * is the literal path including the id, e.g. `/sessions/abc123`. `nonce` is
 * the exact string sent in `X-Pqp-Remux-Nonce`, byte for byte — it is signed
 * so a middlebox or a replaying attacker cannot swap it out from under an
 * otherwise-valid signature. `rawBody` is the exact UTF-8 bytes sent on the
 * wire, `""` for a body-less request (GET, DELETE): re-serializing JSON
 * after signing (key reorder, whitespace) invalidates the signature, the
 * same rule `webhook-sign.ts` documents for outgoing webhooks.
 *
 * The receiver computes the same payload from what it actually received,
 * HMACs it with the shared secret, and compares in constant time. A request
 * is refused (401, `remuxErrorResponseSchema`) when the signature does not
 * match, when `timestampMs` is more than {@link REMUX_CONTROL_CLOCK_SKEW_MS}
 * away from the receiver's own clock, or when the nonce has already been
 * used inside that same window.
 */

/** How far a signed request's timestamp may drift before it is refused. */
export const REMUX_CONTROL_CLOCK_SKEW_MS = 60_000;

/** Request header carrying the unix-millisecond signing timestamp. */
export const REMUX_CONTROL_TIMESTAMP_HEADER = "x-pqp-remux-timestamp";
/** Request header carrying the hex HMAC-SHA256 signature. */
export const REMUX_CONTROL_SIGNATURE_HEADER = "x-pqp-remux-signature";
/** Request header carrying the per-request replay-resistance nonce. */
export const REMUX_CONTROL_NONCE_HEADER = "x-pqp-remux-nonce";

/**
 * The exact string both sides HMAC. No crypto here on purpose (see the file
 * header) — this function is the shared definition, the actual `createHmac`
 * call is `server/src/voice/hls-remux.ts`'s job on the TS side and L1.6's on
 * the Go side.
 */
export function remuxControlSignaturePayload(
  method: string,
  path: string,
  timestampMs: string,
  nonce: string,
  rawBody: string,
): string {
  return `${method.toUpperCase()}\n${path}\n${timestampMs}\n${nonce}\n${rawBody}`;
}

/**
 * `natural`: never send a PLI, the `L0.2` branch-A default. `pli`: paced,
 * gated requests per `docs/plans/LL_HLS.md` §3 branch B. Mirrors
 * `pqp-remux`'s own `KEYFRAME_POLICY` env var one for one — see
 * `tools/pqp-remux/README.md`.
 */
export const remuxKeyframePolicySchema = z.enum(["natural", "pli"]);
export type RemuxKeyframePolicy = z.infer<typeof remuxKeyframePolicySchema>;

/**
 * `POST /sessions`. One row per field of `pqp-remux`'s own config table
 * (`tools/pqp-remux/README.md` "Config"), so starting a session over HTTP
 * asks for exactly what running the binary with those env vars would have
 * asked for — this request is the API's replacement for setting them by
 * hand.
 */
export const remuxStartSessionRequestSchema = z.object({
  /** This process's id for the session. Idempotency key for a retried start. */
  sessionId: z.string().uuid(),
  /** The LiveKit room to subscribe to — this codebase's voice channel id. */
  room: z.string().min(1),
  /** Carried through for the box's own logs; not interpreted by the contract. */
  channelId: z.string().uuid(),
  /**
   * THE API'S OWN `started_at`, AND THEREFORE THE R2 KEY PREFIX BOTH SIDES
   * MUST AGREE ON.
   *
   * Until this field existed the box stamped its own `time.Now()` at the
   * moment it built the session, and `hls_sessions.object_prefix` carried
   * `Date.now()` from the moment the API inserted the row. The two are always
   * close (24 ms apart on the 2026-09-21 broadcast that exposed this) and
   * never equal, so nothing that reads the row could find the objects: the
   * retention sweep listed an empty prefix and marked the session cleaned
   * while every byte stayed in the bucket, `keep_replay` protected a prefix
   * with nothing under it, and a replay lookup found no playlist at all.
   *
   * Optional so an older box (one that predates this field) still validates
   * the request and falls back to its own clock, which is exactly what it
   * does today.
   */
  startedAtMs: z.number().int().nonnegative().optional(),
  /** CMAF part target, ms. `PART_MS` on the box, default `500`. */
  partMs: z.number().int().positive(),
  /** CMAF segment target, ms. `SEGMENT_MS` on the box, default `4000`. */
  segmentMs: z.number().int().positive(),
  /** How many sealed segments (plus the live one) stay in the ring. `RING_SEGMENTS`. */
  ringSegments: z.number().int().positive(),
  /** `KEYFRAME_POLICY`. */
  keyframePolicy: remuxKeyframePolicySchema,
  /** Minimum spacing between repeated PLI requests, ms. `PLI_PACE_MS`. */
  pliPaceMs: z.number().int().positive(),
  /** Multiple of `segmentMs` to wait with no IDR before asking. `PLI_GATE_FACTOR`. */
  pliGateFactor: z.number().positive(),
});
export type RemuxStartSessionRequest = z.infer<
  typeof remuxStartSessionRequestSchema
>;

/**
 * One session as the box reports it — the shape `GET /healthz` already
 * answers per session per `docs/plans/LL_HLS.md` §5, lifted to the
 * multi-session control surface. What `pqp-api`'s watchdog (`L1.6`) will
 * read `lastPartAtMs` / `lastIdrAtMs` / `openSegmentMs` from to run
 * `PART_STUCK_MS` and the keyframe-stall ladder; this task only stores and
 * surfaces them.
 */
export const remuxSessionInfoSchema = z.object({
  sessionId: z.string().uuid(),
  room: z.string().min(1),
  channelId: z.string().uuid(),
  /** Whether the subscriber has found and bound the presenter's screen track. */
  subscribed: z.boolean(),
  startedAtMs: z.number().int().nonnegative(),
  lastPartAtMs: z.number().int().nonnegative().nullable(),
  lastIdrAtMs: z.number().int().nonnegative().nullable(),
  /** How long the currently-open segment has been accumulating, ms. */
  openSegmentMs: z.number().int().nonnegative().nullable(),
  partsWritten: z.number().int().nonnegative(),
  /** Bytes served to viewers, NOT bytes written into the ring (see the Go README). */
  bytesServed: z.number().int().nonnegative(),
  /**
   * THE DEMOTION CONTRACT, AND WHY THESE THREE ARE OPTIONAL.
   *
   * `tools/pqp-remux/README.md` §"Watchdog and the demotion contract": a
   * session the box has given up on is NOT dropped from `GET /sessions`. Its
   * pipeline is closed (no LiveKit subscription, no CPU) and it stays listed
   * with `demoted: true` and a `demotedReason` until an explicit `DELETE`
   * removes it, precisely so `pqp-api` can notice on its next poll, end the
   * `hls_sessions` row and fall the party back to the conventional ladder.
   *
   * Until 2026-09-14 this schema did not name them, and a `z.object()` with
   * no `.strict()` STRIPS what it does not name (Zod's documented default).
   * So the box said `demoting (idr-gap-exceeded)` fourteen seconds into the
   * first real LL party, `pqp-api` parsed the field away, kept the row open
   * and kept handing viewers an LL playlist nothing was writing: no picture
   * at all until an unrelated restart. The fields were on the wire the whole
   * time; nothing on this side could see them.
   *
   * Optional rather than required so an older `pqp-remuxd` (one that predates
   * the watchdog) still parses: absent is read as "not demoted", which is
   * what such a box means.
   */
  state: z.string().min(1).optional(),
  demoted: z.boolean().optional(),
  demotedReason: z.string().nullable().optional(),
  /** How long since the last IDR, ms. Diagnostic; the box decides, not us. */
  lastIdrAgeMs: z.number().int().nonnegative().nullable().optional(),
});
export type RemuxSessionInfo = z.infer<typeof remuxSessionInfoSchema>;

/** `GET /sessions`. */
export const remuxListSessionsResponseSchema = z.object({
  sessions: z.array(remuxSessionInfoSchema),
});
export type RemuxListSessionsResponse = z.infer<
  typeof remuxListSessionsResponseSchema
>;

/** Every non-2xx response from the control API. */
export const remuxErrorResponseSchema = z.object({
  error: z.string(),
});
export type RemuxErrorResponse = z.infer<typeof remuxErrorResponseSchema>;
