import http2 from "node:http2";
import { createPrivateKey, sign as cryptoSign } from "node:crypto";

/**
 * APNs — the transport half of native iOS pushes.
 *
 * This is the sibling of `web-push` in services/push.ts, and it exists as its
 * own module for the same reason the VAPID work is not inlined: everything here
 * is protocol plumbing (a signed JWT, five headers, one HTTP/2 stream) and
 * nothing here decides *who* gets a push. That decision is made once, in
 * push.ts, and both legs are handed its conclusion.
 *
 * WHY NO APNs LIBRARY. Unlike Web Push, APNs has no payload encryption: the
 * body is plain JSON over TLS, and the only cryptography is an ES256 JWT over
 * two short claims. Node signs that in one call. What a dependency would buy is
 * connection pooling and retry, which is ~60 lines here and would otherwise be
 * ~40 transitive packages in a process that already pins its own http2 session.
 * The `web-push` dependency is justified by RFC 8291 payload encryption (see
 * push.ts); there is no equivalent justification here.
 *
 * INERT WHEN UNCONFIGURED, like every optional subsystem in this codebase. No
 * key means `readApnsConfig()` is null, `isApnsEnabled()` is false, the
 * registration route refuses device tokens, and nothing is ever sent. There is
 * no partial mode: a topic without a key is not "half enabled", it is off.
 *
 * VoIP / PushKit IS OUT OF SCOPE. A call push here is an ordinary
 * `apns-push-type: alert` at priority 10 with a 50s expiration — the same ring
 * the web leg sends, arriving as a notification the user taps. PushKit would
 * let the app wake and present the system call UI (CallKit) before the user
 * touches anything, which is a materially better ring; it also requires a
 * second push certificate type, a `PKPushRegistry`, and a hard OS rule that
 * every VoIP push MUST report a CallKit call or the app is killed. That is its
 * own round of work, not a flag on this one.
 */

// ------------------------------------------------------------ configuration

export interface ApnsConfig {
  /** The 10-character key id from the developer portal (the `.p8` filename). */
  keyId: string;
  teamId: string;
  /** PEM contents of the `.p8`, not a path — see `readApnsConfig`. */
  privateKey: string;
  /** The app's bundle id. Apple rejects a mismatch with 400 `TopicDisallowed`. */
  topic: string;
  environment: ApnsEnvironment;
}

export type ApnsEnvironment = "sandbox" | "production";

export const APNS_DEFAULT_TOPIC = "gg.pqp.app";

const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  // Development builds (Xcode, and only Xcode) get tokens the production
  // gateway answers with 400 BadDeviceToken. A TestFlight or App Store build
  // is always production. There is no way to tell from the token itself, which
  // is why this is an explicit env var rather than something inferred.
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

export function apnsHost(environment: ApnsEnvironment): string {
  return APNS_HOSTS[environment];
}

/**
 * Read the env on every call rather than caching at import — same reasoning as
 * `readVapidConfig`: this module loads before dotenv has necessarily run in
 * some entrypoints, and tests flip the variables per case.
 *
 * `APNS_PRIVATE_KEY` carries the PEM *contents*, because the deploy target sets
 * it with `fly secrets set` and there is no filesystem to put a `.p8` on. A
 * shell that cannot hold literal newlines writes them as the two characters
 * `\n`, so those are un-escaped here; a PEM that already has real newlines is
 * unaffected.
 */
export function readApnsConfig(): ApnsConfig | null {
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const rawKey = process.env.APNS_PRIVATE_KEY;
  if (!keyId || !teamId || !rawKey) {
    return null;
  }
  const environment: ApnsEnvironment =
    process.env.APNS_ENVIRONMENT === "sandbox" ? "sandbox" : "production";
  return {
    keyId,
    teamId,
    privateKey: rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey,
    topic: process.env.APNS_TOPIC || APNS_DEFAULT_TOPIC,
    environment,
  };
}

export function isApnsEnabled(): boolean {
  return readApnsConfig() !== null;
}

// -------------------------------------------------------------------- token

/**
 * Apple rejects a provider token older than one hour and rate-limits providers
 * that mint a fresh one per request. Forty minutes is the usual compromise:
 * comfortably inside the hour even with clock skew, and ~36 signatures a day.
 */
export const APNS_JWT_LIFETIME_MS = 40 * 60 * 1000;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * The provider token, as JWS compact serialization.
 *
 * Two things about the signature are easy to get wrong and fail only against
 * the real gateway. It must be **ES256 over P-256** — an `.p8` from the portal
 * always is, but a key pasted from somewhere else may not be, and this throws
 * rather than sending something Apple answers `InvalidProviderToken` to. And it
 * must be the **raw 64-byte R‖S** form, not the ASN.1 DER envelope OpenSSL
 * produces by default: that is what `dsaEncoding: "ieee-p1363"` selects, and
 * omitting it yields a token that is well-formed, verifiably signed, and
 * rejected by every JWS implementation on earth.
 */
export function buildApnsJwt(config: ApnsConfig, nowMs: number = Date.now()): string {
  const key = createPrivateKey(config.privateKey);
  if (key.asymmetricKeyType !== "ec") {
    throw new Error(
      `APNS_PRIVATE_KEY must be an EC (P-256) key, got ${key.asymmetricKeyType ?? "unknown"}`,
    );
  }
  const header = base64url(
    JSON.stringify({ alg: "ES256", kid: config.keyId, typ: "JWT" }),
  );
  const claims = base64url(
    JSON.stringify({ iss: config.teamId, iat: Math.floor(nowMs / 1000) }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = cryptoSign("sha256", Buffer.from(signingInput), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64url(signature)}`;
}

interface CachedJwt {
  token: string;
  /** The exact config it was minted for — a key rotation must invalidate it. */
  fingerprint: string;
  mintedAtMs: number;
}

let cachedJwt: CachedJwt | null = null;

function fingerprintOf(config: ApnsConfig): string {
  // The key itself is not in the fingerprint; its id is, and a new key means a
  // new id. Keeping the PEM out of a long-lived module variable is free here.
  return `${config.teamId}:${config.keyId}`;
}

/** The cached provider token, re-minted once it is `APNS_JWT_LIFETIME_MS` old. */
export function apnsJwt(config: ApnsConfig, nowMs: number = Date.now()): string {
  const fingerprint = fingerprintOf(config);
  if (
    cachedJwt &&
    cachedJwt.fingerprint === fingerprint &&
    nowMs - cachedJwt.mintedAtMs < APNS_JWT_LIFETIME_MS
  ) {
    return cachedJwt.token;
  }
  const token = buildApnsJwt(config, nowMs);
  cachedJwt = { token, fingerprint, mintedAtMs: nowMs };
  return token;
}

export function resetApnsJwtCacheForTests(): void {
  cachedJwt = null;
}

// ------------------------------------------------------------------ headers

/**
 * How one APNs push should travel. The caller decides; this module only
 * serialises.
 */
export interface ApnsDelivery {
  /**
   * Always `alert` in this codebase — see the VoIP note in the module banner.
   * Apple requires the header to agree with the payload: an `alert` push type
   * with no `aps.alert` is dropped, silently, on a real device.
   */
  pushType: "alert";
  /**
   * 10 = deliver now. 5 = "at a time that conserves power", which in practice
   * means APNs may sit on it for minutes.
   *
   * BOTH message and call pushes use 10, even though the web leg calls a
   * message's urgency `normal`. RFC 8030's `normal` is a hint a push service
   * may ignore; APNs priority 5 is a throttle it honours. A direct message
   * that buzzes a quarter of an hour late is not a quieter notification, it is
   * a wrong one — and this whole feature only fires for someone with no live
   * socket, i.e. exactly the person who needs to be told now.
   */
  priority: 5 | 10;
  /**
   * Absolute UNIX seconds after which APNs stops trying and discards. Derived
   * from the same TTL the web leg sends, so a call push expires with the ring
   * (see `CALL_PUSH_TTL_SECONDS`) instead of arriving after it.
   */
  expirationSeconds: number;
  /**
   * At most 64 bytes. Replaces any undelivered *and any displayed* notification
   * with the same id, which is how "Incoming call" becomes "missed call"
   * instead of stacking. Null means no collapsing.
   */
  collapseId: string | null;
}

export const APNS_COLLAPSE_ID_MAX_BYTES = 64;

/**
 * The five headers, plus authorization. `:method` and `:path` are added by the
 * transport — they are pseudo-headers, not application ones, and mixing the two
 * in the same object is how an http2 request ends up rejected before it is sent.
 */
export function apnsHeaders(
  config: ApnsConfig,
  delivery: ApnsDelivery,
  nowMs: number = Date.now(),
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `bearer ${apnsJwt(config, nowMs)}`,
    "apns-topic": config.topic,
    "apns-push-type": delivery.pushType,
    "apns-priority": String(delivery.priority),
    "apns-expiration": String(delivery.expirationSeconds),
  };
  if (delivery.collapseId) {
    // Truncated by *bytes*, not characters: the ids this carries are UUIDs, so
    // this can only ever matter if a caller starts passing something else.
    const collapse = Buffer.from(delivery.collapseId, "utf8");
    headers["apns-collapse-id"] =
      collapse.byteLength <= APNS_COLLAPSE_ID_MAX_BYTES
        ? delivery.collapseId
        : collapse.subarray(0, APNS_COLLAPSE_ID_MAX_BYTES).toString("utf8");
  }
  return headers;
}

// ---------------------------------------------------------------- transport

export interface ApnsSendResult {
  status: number;
  /** Apple's machine-readable `reason` from the JSON body, when there was one. */
  reason: string | null;
}

export interface ApnsRequest {
  host: string;
  deviceToken: string;
  headers: Record<string, string>;
  body: string;
}

type ApnsTransport = (request: ApnsRequest) => Promise<ApnsSendResult>;

/**
 * One HTTP/2 session per host, reused across pushes.
 *
 * A session per notification would mean a TLS handshake per notification, and
 * Apple explicitly asks providers not to do that. The session is dropped on any
 * error, close or GOAWAY so the next push reconnects rather than writing into a
 * dead socket — which is the failure this arrangement has to get right, because
 * a stale session presents as every push silently failing after some idle
 * period rather than as one error.
 */
const sessions = new Map<string, http2.ClientHttp2Session>();

const APNS_REQUEST_TIMEOUT_MS = 10_000;

function sessionFor(host: string): http2.ClientHttp2Session {
  const existing = sessions.get(host);
  if (existing && !existing.closed && !existing.destroyed) {
    return existing;
  }
  const session = http2.connect(host);
  sessions.set(host, session);
  const drop = () => {
    if (sessions.get(host) === session) {
      sessions.delete(host);
    }
  };
  // An unhandled 'error' on an http2 session is a process-level crash
  // (CLAUDE.md pitfall #9); these listeners are the whole reason a push vendor
  // cannot take the server down.
  session.on("error", (error) => {
    console.error("[apns] session error:", error.message);
    drop();
  });
  session.on("goaway", drop);
  session.on("close", drop);
  // Without this the session keeps the event loop alive and a SIGTERM drain
  // hangs on an idle connection to Apple.
  session.unref();
  return session;
}

/** Best-effort teardown, called from the server's shutdown path. */
export function closeApnsSessions(): void {
  for (const session of sessions.values()) {
    session.close();
  }
  sessions.clear();
}

const realTransport: ApnsTransport = async (request) => {
  const session = sessionFor(request.host);
  return await new Promise<ApnsSendResult>((resolve, reject) => {
    const stream = session.request({
      ...request.headers,
      [http2.constants.HTTP2_HEADER_METHOD]: "POST",
      [http2.constants.HTTP2_HEADER_PATH]: `/3/device/${request.deviceToken}`,
    });
    let status = 0;
    let body = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    stream.setEncoding("utf8");
    stream.on("response", (headers) => {
      status = Number(headers[http2.constants.HTTP2_HEADER_STATUS] ?? 0);
    });
    stream.on("data", (chunk: string) => {
      body += chunk;
    });
    stream.on("end", () => {
      settle(() => resolve({ status, reason: readReason(body) }));
    });
    stream.on("error", (error) => {
      settle(() => reject(error));
    });
    stream.setTimeout(APNS_REQUEST_TIMEOUT_MS, () => {
      stream.close(http2.constants.NGHTTP2_CANCEL);
      settle(() => reject(new Error("APNs request timed out")));
    });
    stream.end(request.body);
  });
};

/**
 * Apple's error body is `{"reason":"BadDeviceToken"}`. A 200 has no body at
 * all, and a gateway in front of it could answer with anything, so a parse
 * failure is "no reason given" rather than an error of its own.
 */
function readReason(body: string): string | null {
  if (!body) {
    return null;
  }
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : null;
  } catch {
    return null;
  }
}

let transport: ApnsTransport = realTransport;

export function setApnsTransportForTests(next: ApnsTransport | null): void {
  transport = next ?? realTransport;
}

export async function sendApnsPush(args: {
  config: ApnsConfig;
  deviceToken: string;
  /** Already-serialised JSON, so the caller owns the payload shape. */
  payload: string;
  delivery: ApnsDelivery;
  nowMs?: number;
}): Promise<ApnsSendResult> {
  return await transport({
    host: apnsHost(args.config.environment),
    deviceToken: args.deviceToken,
    headers: apnsHeaders(args.config, args.delivery, args.nowMs ?? Date.now()),
    body: args.payload,
  });
}

/**
 * Whether this result means the stored device token is dead and the row should
 * go — the APNs equivalent of Web Push's 404/410.
 *
 * `410 Unregistered` is the clean signal: the app was deleted, or the token was
 * re-issued. `400 BadDeviceToken` has to count too, and it is the one people
 * get wrong: it is *also* what the production gateway answers for a perfectly
 * valid *sandbox* token. Pruning it is still right — that token will never
 * work against this deployment's configured environment, so keeping the row
 * only means failing on it forever — but it means a misconfigured
 * `APNS_ENVIRONMENT` presents as "registration seems to work, notifications
 * never arrive, and the row quietly disappears". Hence the log line at the
 * call site in push.ts.
 */
export function isApnsTokenGone(result: ApnsSendResult): boolean {
  if (result.status === 410) {
    return true;
  }
  return result.status === 400 && result.reason === "BadDeviceToken";
}
