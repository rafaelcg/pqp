import { createPrivateKey, sign as cryptoSign } from "node:crypto";

/**
 * FCM — the transport half of native Android pushes.
 *
 * This is the third sibling of `web-push` and `apns.ts` in services/push.ts,
 * and it exists as its own module for the same reason those do: everything
 * here is protocol plumbing (a signed service-account JWT, an OAuth2 token
 * exchange, one HTTPS POST) and nothing here decides *who* gets a push. That
 * decision is made once, in push.ts, and all three legs are handed its
 * conclusion.
 *
 * WHY NO FIREBASE SDK. Firebase Cloud Messaging's HTTP v1 API, like APNs and
 * unlike Web Push, has no payload encryption: the body is plain JSON over TLS.
 * The only cryptography is an RS256 JWT over the service-account credentials,
 * which Node signs in one call, and an OAuth2 token exchange that is a plain
 * form POST. `firebase-admin` would pull ~40 transitive packages (gRPC, the
 * whole Google API client) into a process that needs exactly one endpoint. The
 * same reasoning that keeps `apns.ts` free of a library keeps this free of one;
 * `web-push` earns its place with RFC 8291 payload encryption, which has no
 * equivalent here.
 *
 * INERT WHEN UNCONFIGURED, like every optional subsystem in this codebase. No
 * service account means `readFcmConfig()` is null, `isFcmEnabled()` is false,
 * the registration route refuses FCM tokens, and nothing is ever sent. There
 * is no partial mode: two of the three credentials is not "half enabled", it
 * is off.
 *
 * DATA-ONLY, ALWAYS. Every message this sends carries a `data` block and never
 * a `notification` block. A `notification` message is drawn by the Android
 * Firebase SDK itself while the app is backgrounded, without the app deciding
 * whether the announced channel is already open on screen — which is the "1
 * nova mensagem with nothing to look at" bug the web client shipped once. The
 * Android client's `PqpMessagingService.onMessageReceived` is only called for
 * data messages; see `docs/ANDROID.md` and `gg.pqp.app.push.PushMessage`.
 *
 * FULL-SCREEN INCOMING CALLS ARE OUT OF SCOPE HERE, the same way PushKit /
 * CallKit is out of scope for `apns.ts`. A call push this leg sends is an
 * ordinary high-priority data message; it reaches the phone and (once the
 * client grows a call-routing branch — see `docs/ANDROID.md` §Push) can wake a
 * full-screen ring. Making a *backgrounded* Android phone ring with the system
 * call UI is client work plus a `kind` discriminator on the payload, not a
 * flag on this module.
 */

// ------------------------------------------------------------ configuration

export interface FcmConfig {
  /** The Firebase project id — `messages:send` is scoped to it in the URL. */
  projectId: string;
  /** The service account's `client_email`, the JWT's `iss`. */
  clientEmail: string;
  /** PEM contents of the service account's `private_key`, not a path. */
  privateKey: string;
}

const FCM_TOKEN_URI = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

export function fcmSendUrl(projectId: string): string {
  return `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
}

/**
 * Read the env on every call rather than caching at import — same reasoning as
 * `readVapidConfig` / `readApnsConfig`: this module loads before dotenv has
 * necessarily run in some entrypoints, and tests flip the variables per case.
 *
 * The three variables are exactly the three fields a `service account JSON`
 * carries that this leg needs: `project_id`, `client_email`, `private_key`.
 * `FCM_PRIVATE_KEY` carries the PEM *contents*, because the deploy target sets
 * it with `fly secrets set` and there is no filesystem to put a JSON on. A
 * shell that cannot hold literal newlines writes them as the two characters
 * `\n`, so those are un-escaped here; a PEM with real newlines is unaffected.
 */
export function readFcmConfig(): FcmConfig | null {
  const projectId = process.env.FCM_PROJECT_ID;
  const clientEmail = process.env.FCM_CLIENT_EMAIL;
  const rawKey = process.env.FCM_PRIVATE_KEY;
  if (!projectId || !clientEmail || !rawKey) {
    return null;
  }
  return {
    projectId,
    clientEmail,
    privateKey: rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey,
  };
}

export function isFcmEnabled(): boolean {
  return readFcmConfig() !== null;
}

// -------------------------------------------------------------- access token

/**
 * Google rejects an assertion whose lifetime is over an hour and the access
 * token it returns lives an hour. Fifty minutes of reuse keeps the token comfortably
 * inside that window even with clock skew while minting ~29 tokens a day.
 */
export const FCM_TOKEN_LIFETIME_MS = 50 * 60 * 1000;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * The service-account assertion, as JWS compact serialization.
 *
 * It must be **RS256 over an RSA key** — the `private_key` in a Google service
 * account JSON always is, but a key pasted from somewhere else may not be, and
 * this throws rather than sending something Google answers `invalid_grant` to.
 * Unlike APNs's ES256 there is no `dsaEncoding` subtlety: RSA PKCS#1 v1.5 is
 * the one and only encoding, which is what `crypto.sign("RSA-SHA256", …)`
 * produces.
 */
export function buildFcmJwt(config: FcmConfig, nowMs: number = Date.now()): string {
  const key = createPrivateKey(config.privateKey);
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error(
      `FCM_PRIVATE_KEY must be an RSA key, got ${key.asymmetricKeyType ?? "unknown"}`,
    );
  }
  const iat = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: config.clientEmail,
      scope: FCM_SCOPE,
      aud: FCM_TOKEN_URI,
      iat,
      exp: iat + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = cryptoSign("RSA-SHA256", Buffer.from(signingInput), key);
  return `${signingInput}.${base64url(signature)}`;
}

/**
 * Exchange the assertion for an OAuth2 access token. A seam so tests never
 * touch the network; the real implementation is a plain form POST.
 */
export type FcmTokenFetcher = (config: FcmConfig, nowMs: number) => Promise<string>;

const realTokenFetcher: FcmTokenFetcher = async (config, nowMs) => {
  const assertion = buildFcmJwt(config, nowMs);
  const response = await fetch(FCM_TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(FCM_REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`FCM token exchange failed (${response.status}): ${text}`);
  }
  const parsed = JSON.parse(text) as { access_token?: unknown };
  if (typeof parsed.access_token !== "string") {
    throw new Error("FCM token exchange returned no access_token");
  }
  return parsed.access_token;
};

let tokenFetcher: FcmTokenFetcher = realTokenFetcher;

export function setFcmTokenFetcherForTests(next: FcmTokenFetcher | null): void {
  tokenFetcher = next ?? realTokenFetcher;
}

interface CachedToken {
  token: string;
  /** The exact credentials it was minted for — a rotation must invalidate it. */
  fingerprint: string;
  mintedAtMs: number;
}

let cachedToken: CachedToken | null = null;

function fingerprintOf(config: FcmConfig): string {
  // The key itself is not in the fingerprint; the account it belongs to is,
  // and a rotated key normally arrives with the same client_email. So the PEM
  // *is* included, hashed cheaply, because unlike an APNs key id there is no
  // separate identifier that changes with the key.
  return `${config.projectId}:${config.clientEmail}:${config.privateKey.length}`;
}

/** The cached access token, re-minted once it is `FCM_TOKEN_LIFETIME_MS` old. */
export async function fcmAccessToken(
  config: FcmConfig,
  nowMs: number = Date.now(),
): Promise<string> {
  const fingerprint = fingerprintOf(config);
  if (
    cachedToken &&
    cachedToken.fingerprint === fingerprint &&
    nowMs - cachedToken.mintedAtMs < FCM_TOKEN_LIFETIME_MS
  ) {
    return cachedToken.token;
  }
  const token = await tokenFetcher(config, nowMs);
  cachedToken = { token, fingerprint, mintedAtMs: nowMs };
  return token;
}

export function resetFcmTokenCacheForTests(): void {
  cachedToken = null;
}

// ------------------------------------------------------------------ payload

/**
 * How one FCM push should travel. The caller decides; this module only
 * serialises. Mirrors `ApnsDelivery`'s role.
 */
export interface FcmDelivery {
  /**
   * `high` asks FCM to deliver immediately and wake a device in doze; `normal`
   * lets it batch and delay. A call push is `high`, a message follows the same
   * per-event urgency the web leg decides in push.ts.
   *
   * A data-only `normal`-priority message can be held for a long time in doze,
   * which is the deliberate trade for a message (see `PushMessage` on the
   * client): a late message notification beats a wrong one, and force-stopped
   * apps get nothing regardless.
   */
  priority: "normal" | "high";
  /**
   * How long FCM may hold the message for an unreachable device, in seconds.
   * Derived from the same TTL the other legs send, so a call push expires with
   * the ring instead of arriving after it.
   */
  ttlSeconds: number;
}

/**
 * The `messages:send` request body, built from the payload all legs share.
 *
 * DATA-ONLY (see the module banner): every field goes under `data`, whose
 * values must be strings, and there is no `notification` block. The four keys
 * are exactly the ones `PqpMessagingService` reads (`gg.pqp.app.push.PushMessage`).
 * `collapseKey` is the conversation id, doing the job `apns-collapse-id` does:
 * one live notification per channel instead of a stack, and the missed-call
 * message replacing the ring.
 */
export function buildFcmMessage(input: {
  token: string;
  title: string;
  body: string;
  path: string;
  tag: string;
  delivery: FcmDelivery;
}): Record<string, unknown> {
  const data: Record<string, string> = {
    title: input.title,
    body: input.body,
    path: input.path,
    tag: input.tag,
  };
  return {
    message: {
      token: input.token,
      data,
      android: {
        priority: input.delivery.priority.toUpperCase(),
        ttl: `${input.delivery.ttlSeconds}s`,
        // The collapse key groups replaced notifications the way the tag does
        // on the tray; FCM also uses it to collapse undelivered messages in
        // doze, which is exactly right for "one per conversation".
        collapse_key: input.tag,
      },
    },
  };
}

// ---------------------------------------------------------------- transport

export interface FcmSendResult {
  status: number;
  /**
   * FCM v1's machine-readable error status (`NOT_FOUND`, `INVALID_ARGUMENT`,
   * …) or the messaging `errorCode` (`UNREGISTERED`), whichever the body
   * carried. Null on success or an unparseable body.
   */
  errorCode: string | null;
}

export interface FcmRequest {
  url: string;
  accessToken: string;
  body: string;
}

type FcmTransport = (request: FcmRequest) => Promise<FcmSendResult>;

export const FCM_REQUEST_TIMEOUT_MS = 10_000;

const realTransport: FcmTransport = async (request) => {
  const response = await fetch(request.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${request.accessToken}`,
      "content-type": "application/json",
    },
    body: request.body,
    signal: AbortSignal.timeout(FCM_REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  return { status: response.status, errorCode: readErrorCode(text) };
};

/**
 * FCM v1's error body is `{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}`.
 * A 200 carries a `{name: …}` with no error. The `errorCode` in `details` is
 * the precise messaging signal; `status` is the coarser gRPC one. Prefer the
 * former, fall back to the latter, and treat an unparseable body as "no code".
 */
export function readErrorCode(body: string): string | null {
  if (!body) {
    return null;
  }
  try {
    const parsed = JSON.parse(body) as {
      error?: { status?: unknown; details?: Array<{ errorCode?: unknown }> };
    };
    const error = parsed.error;
    if (!error) {
      return null;
    }
    const detail = error.details?.find(
      (d) => typeof d.errorCode === "string",
    )?.errorCode;
    if (typeof detail === "string") {
      return detail;
    }
    return typeof error.status === "string" ? error.status : null;
  } catch {
    return null;
  }
}

let transport: FcmTransport = realTransport;

export function setFcmTransportForTests(next: FcmTransport | null): void {
  transport = next ?? realTransport;
}

export async function sendFcmPush(args: {
  config: FcmConfig;
  deviceToken: string;
  title: string;
  body: string;
  path: string;
  tag: string;
  delivery: FcmDelivery;
  nowMs?: number;
}): Promise<FcmSendResult> {
  const accessToken = await fcmAccessToken(args.config, args.nowMs ?? Date.now());
  const body = JSON.stringify(
    buildFcmMessage({
      token: args.deviceToken,
      title: args.title,
      body: args.body,
      path: args.path,
      tag: args.tag,
      delivery: args.delivery,
    }),
  );
  return await transport({
    url: fcmSendUrl(args.config.projectId),
    accessToken,
    body,
  });
}

/**
 * Whether this result means the stored FCM token is dead and the row should go
 * — the FCM equivalent of Web Push's 404/410 and APNs's 410 Unregistered.
 *
 * Two codes, and NO more. `UNREGISTERED` (404) is the clean signal: the app was
 * uninstalled, its data was cleared, or FCM rotated the token.
 * `SENDER_ID_MISMATCH` (403) means the token was minted for a different Firebase
 * sender and will never work against this project's credentials — the FCM twin
 * of an APNs sandbox token hitting the production gateway, which `apns.ts`
 * prunes for the same reason, loudly, at the call site.
 *
 * `INVALID_ARGUMENT` (400) is deliberately NOT here, and this is the trap the
 * comment on `isApnsTokenGone` warns about in its own words: it is also FCM's
 * answer to a malformed *message body*, so pruning on it would let one payload
 * bug delete every Android subscription in the table on the next fan-out. A
 * bare `401 UNAUTHENTICATED` or a `5xx` is a server/transport problem, not a
 * token one, and stays.
 */
export function isFcmTokenGone(result: FcmSendResult): boolean {
  return (
    result.errorCode === "UNREGISTERED" ||
    result.errorCode === "SENDER_ID_MISMATCH" ||
    // Belt and braces: the canonical HTTP status for a token that names no
    // registration, in case a gateway ever answers it without the detail code.
    (result.status === 404 && result.errorCode === "NOT_FOUND")
  );
}
