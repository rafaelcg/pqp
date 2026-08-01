import { createHash, createHmac } from "node:crypto";

/**
 * S3-compatible object storage: presigned URLs for the browser, plus the two
 * operations the server performs itself (HEAD to find out how big an upload
 * really was, DELETE to sweep an orphan).
 *
 * Signed by hand with AWS SigV4 over node:crypto rather than pulled from
 * `@aws-sdk/client-s3`, which is roughly fifty packages in the Railway image
 * for four operations, in a server that otherwise runs raw node:http with no
 * framework. The algorithm is fixed and public; the dependency is not.
 *
 * No object bytes ever pass through this process — the browser PUTs and GETs
 * directly — so Railway pays neither the egress nor the memory for a 10 MiB
 * upload. That is the whole reason presigning exists here.
 *
 * A signature that is wrong in a single byte produces a perfectly well-formed
 * URL and fails at the bucket as `SignatureDoesNotMatch`, which reads like a
 * credentials problem and is not one. `s3.test.ts` pins the canonical request
 * directly for that reason, and carries an opt-in round trip against a real
 * MinIO.
 */

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";

/** SigV4 rejects a presigned URL outside this window; callers are clamped. */
const MIN_EXPIRES_SECONDS = 1;
const MAX_EXPIRES_SECONDS = 7 * 24 * 60 * 60;

/** The server's own HEAD/DELETE URLs are spent milliseconds after minting. */
const INTERNAL_URL_TTL_SECONDS = 60;

/** A hung bucket must not hold a request — or the sweeper — open forever. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Storage reachable but unusable, or not configured at all. */
export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

interface StorageConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Where the bytes live. Uploads and server-side calls always go here. */
  endpoint: URL;
  forcePathStyle: boolean;
  /** Custom domain bound to the bucket. Reads only; see `objectTarget`. */
  publicBaseUrl: URL | null;
}

function parseUrl(raw: string | undefined): URL | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
}

/**
 * Read on every call rather than cached at import, matching `isGifSearchConfigured`.
 * It is four string reads and a URL parse against a per-request presign, and
 * caching would freeze the answer for the whole process — which is exactly
 * wrong for a test that configures storage per case.
 */
function readConfig(): StorageConfig | null {
  const endpoint = parseUrl(process.env.S3_ENDPOINT);
  const bucket = process.env.S3_BUCKET?.trim();
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return {
    bucket,
    // R2 ignores the region but still signs with it, and "auto" is the literal
    // its own console hands out. An empty region would sign a malformed scope.
    region: process.env.S3_REGION?.trim() || "auto",
    accessKeyId,
    secretAccessKey,
    endpoint,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    publicBaseUrl: parseUrl(process.env.S3_PUBLIC_BASE_URL),
  };
}

/** False turns the whole attachments feature off, the way a missing GIF key does. */
export function isStorageConfigured(): boolean {
  return readConfig() !== null;
}

function requireConfig(): StorageConfig {
  const config = readConfig();
  if (!config) {
    throw new StorageError("Object storage is not configured");
  }
  return config;
}

// ------------------------------------------------------------------ encoding

const UNRESERVED = /[A-Za-z0-9\-._~]/;

/**
 * RFC 3986 percent-encoding, which is *not* what `encodeURIComponent` does: it
 * leaves `!'()*` alone, and every one of those is a legal character in an S3
 * object key. A key containing one would be signed one way and requested
 * another.
 *
 * `encodeSlash` is the entire difference between the two places this is used.
 * The canonical URI keeps `/` as a path separator; the canonical query string
 * encodes it, which is why the credential scope arrives as `%2F`-separated.
 * S3 is also the one SigV4 service that does not double-encode its path, so
 * the canonical URI is this and nothing further.
 */
function uriEncode(value: string, encodeSlash: boolean): string {
  let encoded = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    if (UNRESERVED.test(char) || (char === "/" && !encodeSlash)) {
      encoded += char;
    } else {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return encoded;
}

/**
 * Sorted by the *encoded* name, byte order. Every name here is ASCII after
 * encoding, so JavaScript's UTF-16 comparison and a byte comparison agree.
 */
function canonicalQueryString(params: Record<string, string>): string {
  return Object.entries(params)
    .map(
      ([name, value]) =>
        [uriEncode(name, true), uriEncode(value, true)] as const,
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

/** RFC 5987 attr-char. Everything outside it is percent-encoded. */
const ATTR_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/;

/**
 * `attachment; filename="..."; filename*=UTF-8''...`
 *
 * Two spellings of the same name because the plain one is the fallback for
 * clients that never implemented RFC 5987, and it sits inside double quotes —
 * a quote or a backslash in it would close the parameter early and let the
 * rest of the filename be read as header syntax. Non-ASCII survives only in
 * the `filename*` form, so the fallback is flattened to printable ASCII.
 */
function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");

  let encoded = "";
  for (const byte of Buffer.from(filename, "utf8")) {
    const char = String.fromCharCode(byte);
    encoded += ATTR_CHAR.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// ------------------------------------------------------------------- signing

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

/**
 * `20260801T124500Z` and its `20260801` prefix. SigV4 accepts these two
 * formats and nothing else — a stray millisecond field or a `:` invalidates
 * the signature, since the same strings appear in both the query and the
 * credential scope.
 */
function timestamps(now: Date): { amzDate: string; date: string } {
  const amzDate = `${now.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
  return { amzDate, date: amzDate.slice(0, 8) };
}

function signingKey(config: StorageConfig, date: string): Buffer {
  const kDate = hmac(`AWS4${config.secretAccessKey}`, date);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, "aws4_request");
}

/**
 * A presigned URL's lifetime, clamped rather than rejected. A non-finite TTL
 * is a caller bug, and collapsing it to one second fails immediately and
 * visibly instead of minting a week-long grant nobody meant to hand out.
 */
function clampExpires(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds)) {
    return MIN_EXPIRES_SECONDS;
  }
  return Math.min(
    Math.max(Math.floor(ttlSeconds), MIN_EXPIRES_SECONDS),
    MAX_EXPIRES_SECONDS,
  );
}

/**
 * The two addressing styles an S3 client must choose between.
 *
 * MinIO puts the bucket in the path (`http://host:9000/bucket/key`); R2 and
 * modern AWS put it in the hostname (`https://bucket.host/key`). Choosing
 * wrong does not 404: the canonical URI is part of the signature, so the
 * request comes back `SignatureDoesNotMatch` and looks like bad credentials.
 *
 * A custom domain is bound to exactly one bucket at the DNS layer, so on that
 * host the bucket name appears in neither place — but any path the base URL
 * carries is kept as a prefix, since that is the operator saying the bucket is
 * mounted under a subpath.
 */
function objectTarget(
  config: StorageConfig,
  key: string,
  forRead: boolean,
): { origin: string; host: string; canonicalUri: string } {
  const useCustomDomain = forRead && config.publicBaseUrl !== null;
  const base = useCustomDomain ? config.publicBaseUrl! : config.endpoint;
  const prefix = base.pathname.replace(/\/+$/, "");

  let host = base.host;
  let path = `${prefix}/${key}`;

  if (!useCustomDomain) {
    if (config.forcePathStyle) {
      path = `${prefix}/${config.bucket}/${key}`;
    } else {
      host = `${config.bucket}.${base.host}`;
    }
  }

  return {
    // `URL.host` carries the port when there is a non-default one, and the
    // signed `host` header must match what the client actually sends.
    origin: `${base.protocol}//${host}`,
    host,
    canonicalUri: uriEncode(path, false),
  };
}

export interface PresignRequest {
  method: "GET" | "PUT" | "HEAD" | "DELETE";
  /** Storage key, no leading slash. */
  key: string;
  ttlSeconds: number;
  /** Extra query parameters to sign in, e.g. S3 `response-*` overrides. */
  query?: Record<string, string>;
  /** Headers beyond `host` that the eventual request must send verbatim. */
  headers?: Record<string, string>;
  /** Reads may be signed for the custom domain; writes never are. */
  forRead?: boolean;
  /** Injectable clock. Tests only. */
  now?: Date;
}

export interface SignedRequest {
  /** The finished URL, signature included. */
  url: string;
  /** Exactly what was hashed into the signature. */
  canonicalRequest: string;
  stringToSign: string;
}

/**
 * SigV4 query presigning.
 *
 * Exported whole — rather than only the URL — because the canonical request is
 * the artefact a signing bug actually corrupts, and the URL it produces looks
 * fine either way. `s3.test.ts` asserts on these strings.
 */
export function signRequest(request: PresignRequest): SignedRequest {
  const config = requireConfig();
  const { origin, host, canonicalUri } = objectTarget(
    config,
    request.key,
    request.forRead ?? false,
  );
  const { amzDate, date } = timestamps(request.now ?? new Date());
  const scope = `${date}/${config.region}/${SERVICE}/aws4_request`;

  // Header names are matched case-insensitively and signed lowercase; `host`
  // is always signed because it is the only header a browser cannot be talked
  // out of sending.
  const headers = new Map<string, string>([["host", host]]);
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    headers.set(name.toLowerCase(), value);
  }
  const signedHeaders = [...headers.keys()].sort();
  const canonicalHeaders = signedHeaders
    .map((name) => `${name}:${headers.get(name)!.trim().replace(/\s+/g, " ")}\n`)
    .join("");

  const query: Record<string, string> = {
    ...(request.query ?? {}),
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${config.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(clampExpires(request.ttlSeconds)),
    "X-Amz-SignedHeaders": signedHeaders.join(";"),
  };
  const signedQuery = canonicalQueryString(query);

  // Query-presigned S3 requests hash the payload as the literal string
  // `UNSIGNED-PAYLOAD`. The empty-payload digest (`e3b0c442…`) is what a
  // *header*-signed request with no body uses; substituting it here signs a
  // different canonical request and every URL comes back 403. It is also why
  // HEAD and DELETE below go out as presigned URLs rather than signed headers
  // — one signing path, one chance to get this wrong.
  const canonicalRequest = [
    request.method,
    canonicalUri,
    signedQuery,
    canonicalHeaders,
    signedHeaders.join(";"),
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = createHmac("sha256", signingKey(config, date))
    .update(stringToSign, "utf8")
    .digest("hex");

  // Assembled by hand: `URLSearchParams` encodes a space as `+`, which is form
  // encoding rather than RFC 3986, so the query on the wire would no longer be
  // the query that was signed.
  return {
    url: `${origin}${canonicalUri}?${signedQuery}&X-Amz-Signature=${signature}`,
    canonicalRequest,
    stringToSign,
  };
}

// ---------------------------------------------------------------- operations

/**
 * Upload URL. `Content-Type` and `Content-Length` are both signed, so the
 * bucket itself rejects a PUT that sends either one differently.
 *
 * The type is signed because that is the difference between a bucket that can
 * only hold the allowlist and one that will happily accept `text/html`. The
 * length is signed because without it the grant is unbounded: a row that
 * declared one byte could be used to store 5 GiB, and since nothing ever
 * claims that row, the claim-time HEAD never runs and the object sits there
 * for the sweeper's full grace period.
 *
 * Browsers set `Content-Length` from the body themselves and forbid a script
 * from touching it, so the value on the wire is exactly the value signed here.
 *
 * Residual, deliberately left open: the URL stays valid for its whole TTL and
 * an S3 PUT is an unconditional overwrite, so the object can still be replaced
 * by a *different body of the same length* — including after the row is
 * claimed, where no sweeper predicate will ever look at it again. That is
 * bounded and cannot blow up storage. Closing it fully would take a
 * conditional PUT (`If-None-Match: *`) or a server-side key rotation at claim
 * time, and neither is worth its cost here.
 */
export function presignPut(
  key: string,
  contentType: string,
  byteSize: number,
  ttlSeconds: number,
): string {
  return signRequest({
    method: "PUT",
    key,
    ttlSeconds,
    headers: {
      "content-type": contentType,
      "content-length": String(byteSize),
    },
  }).url;
}

export interface PresignGetOptions {
  ttlSeconds: number;
  /**
   * Set to force a download instead of inline rendering. Everything that is
   * not an image gets one: a stored `application/pdf` or `text/plain` opened
   * as a top-level document renders in the bucket's own origin.
   */
  downloadFilename?: string;
}

export function presignGet(key: string, options: PresignGetOptions): string {
  return signRequest({
    method: "GET",
    key,
    ttlSeconds: options.ttlSeconds,
    forRead: true,
    ...(options.downloadFilename
      ? {
          query: {
            "response-content-disposition": contentDisposition(
              options.downloadFilename,
            ),
          },
        }
      : {}),
  }).url;
}

export interface ObjectHead {
  contentLength: number;
  /** Lowercased, parameters stripped — `text/plain; charset=utf-8` is `text/plain`. */
  contentType: string;
}

/**
 * The only honest answer to "how big is this object". Returns null when the
 * object is not there; throws for anything else, so a caller can tell "never
 * uploaded" apart from "storage is down" and refuse the upload either way.
 */
export async function headObject(key: string): Promise<ObjectHead | null> {
  const url = signRequest({
    method: "HEAD",
    key,
    ttlSeconds: INTERNAL_URL_TTL_SECONDS,
  }).url;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new StorageError(
      error instanceof Error ? error.message : "Storage unreachable",
    );
  }

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new StorageError(`Storage returned HTTP ${response.status} for HEAD`);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (!Number.isFinite(contentLength)) {
    // Without a length there is no size enforcement at all, and accepting the
    // client's claimed size instead is exactly the hole HEAD exists to close.
    throw new StorageError("Storage returned no Content-Length");
  }

  return {
    contentLength,
    contentType: (response.headers.get("content-type") ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase(),
  };
}

/** Idempotent: an object that is already gone is a success, not an error. */
export async function deleteObject(key: string): Promise<void> {
  const url = signRequest({
    method: "DELETE",
    key,
    ttlSeconds: INTERNAL_URL_TTL_SECONDS,
  }).url;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "DELETE",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new StorageError(
      error instanceof Error ? error.message : "Storage unreachable",
    );
  }

  if (!response.ok && response.status !== 404) {
    throw new StorageError(
      `Storage returned HTTP ${response.status} for DELETE`,
    );
  }
}
