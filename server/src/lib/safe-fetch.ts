import { promises as dns } from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";

/**
 * Fetching a URL a user pasted into a message is the one place this server
 * ever makes a network request whose destination somebody else chose. Every
 * decision in this file is about what that person is not allowed to make the
 * server do: reach an internal service, read the cloud metadata endpoint,
 * probe the private network this process happens to run on, or exfiltrate
 * data via a redirect to somewhere the caller could never have reached
 * directly. This is the same class of problem as the attachment host
 * allowlist and the GIF-provider allowlist elsewhere in this codebase, except
 * here the "host" is not a short vetted list — it is the entire internet
 * minus the parts of it that are actually somebody's internal network.
 */

/** Hard ceiling regardless of what a server claims via Content-Length. */
const MAX_BODY_BYTES = 512 * 1024;

/** Long enough for a slow news site, short enough that a hung connection
 * cannot hold a socket open through an unrelated request's timeout budget. */
const TIMEOUT_MS = 5_000;

/** A redirect chain this short is never a legitimate CDN hop and always
 * either a mistake or an attempt to walk out of the address a caller checked
 * and into one they did not. */
const MAX_REDIRECTS = 3;

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export class FetchTooLargeError extends Error {
  constructor() {
    super("Response exceeded the size limit");
    this.name = "FetchTooLargeError";
  }
}

/**
 * Every IPv4 range that is not supposed to be reachable from the open
 * internet: RFC 1918 private space, loopback, link-local (includes the cloud
 * metadata address, 169.254.169.254, which is exactly why this list exists),
 * the 0.0.0.0/8 "this network" block, CGNAT space, multicast, and the
 * reserved 240.0.0.0/4 block. Written as [start, end] integer ranges rather
 * than CIDR parsing because there are few enough of them to just enumerate,
 * and an enumerated range cannot have an off-by-one in a prefix-length
 * calculation that a test failed to exercise.
 */
const BLOCKED_IPV4_RANGES: Array<[string, string]> = [
  ["0.0.0.0", "0.255.255.255"],
  ["10.0.0.0", "10.255.255.255"],
  ["100.64.0.0", "100.127.255.255"],
  ["127.0.0.0", "127.255.255.255"],
  ["169.254.0.0", "169.254.255.255"],
  ["172.16.0.0", "172.31.255.255"],
  ["192.0.0.0", "192.0.0.255"],
  ["192.168.0.0", "192.168.255.255"],
  ["198.18.0.0", "198.19.255.255"],
  ["224.0.0.0", "255.255.255.255"],
];

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return (
    (parts[0]! << 24) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!
  );
}

const BLOCKED_IPV4_INT_RANGES = BLOCKED_IPV4_RANGES.map(
  ([start, end]) => [ipv4ToInt(start), ipv4ToInt(end)] as const,
);

function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip) >>> 0;
  return BLOCKED_IPV4_INT_RANGES.some(
    ([start, end]) => value >= (start >>> 0) && value <= (end >>> 0),
  );
}

/**
 * IPv6 has the same shape of problem in different clothes: `::1` is
 * loopback, `fe80::/10` is link-local (the IPv6 path to the same metadata
 * services), `fc00::/7` is unique local (IPv6's RFC 1918), and
 * `::ffff:0:0/96` is an IPv4 address wearing an IPv6 costume — unwrap it and
 * check the wrapped address against the IPv4 list, or every one of the
 * ranges above is reachable again through a `::ffff:` prefix.
 */
function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") {
    return true;
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) {
    return isBlockedIpv4(mapped[1]!);
  }
  if (lower.startsWith("fe80:") || lower.startsWith("fe8") || lower.startsWith("fe9")) {
    return true;
  }
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) {
    return true;
  }
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    return isBlockedIpv4(ip);
  }
  if (version === 6) {
    return isBlockedIpv6(ip);
  }
  // Not a literal address at all — the caller passed something that failed to
  // resolve, or a malformed value slipped through. Treat as blocked: refusing
  // a URL we cannot classify is the safe failure mode here, not fetching one.
  return true;
}

/**
 * Resolve a hostname and return the first address that is not in a blocked
 * range, or null if every address it has is blocked (or it has none). Real
 * DNS, not a cache — a URL is only unfurled once per TTL window, so the
 * extra round trip costs nothing that matters.
 *
 * `allowPrivate` is the local-dev hatch for outgoing webhooks: a receiver
 * running on loopback is the whole point of a laptop test, and the same
 * check that stops SSRF would also stop that. Production never passes it.
 */
export async function resolveSafeAddress(
  hostname: string,
  options: { allowPrivate?: boolean } = {},
): Promise<{ address: string; family: 4 | 6 } | null> {
  const literal = isIP(hostname);
  if (literal) {
    if (!options.allowPrivate && isBlockedAddress(hostname)) {
      return null;
    }
    return { address: hostname, family: literal as 4 | 6 };
  }
  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return null;
  }
  if (options.allowPrivate) {
    const first = records[0];
    return first
      ? { address: first.address, family: first.family as 4 | 6 }
      : null;
  }
  const safe = records.find((record) => !isBlockedAddress(record.address));
  return safe ? { address: safe.address, family: safe.family as 4 | 6 } : null;
}

export interface SafeFetchResult {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** The URL the response actually came from, after any redirects. */
  finalUrl: string;
}

/**
 * Fetch a user-supplied URL with the destination pinned to an address this
 * function already vetted.
 *
 * The pinning is the point, not the vetting alone: resolving a hostname,
 * checking the result, and then handing the *hostname* to `http.request` for
 * it to resolve a second time at connect time is a TOCTOU window a hostile
 * DNS server walks through by answering the check with a public address and
 * the real connection with an internal one. Passing a `lookup` override that
 * always answers with the one address already checked closes that window —
 * Node never resolves the name again.
 *
 * Redirects are not followed automatically by Node in this mode (a custom
 * `lookup` only pins the *first* connection), so every hop is re-validated by
 * hand through this same function, capped at `MAX_REDIRECTS`. A redirect
 * straight from a public address to a blocked one is exactly the attack this
 * exists to stop — a working page that closes with `if (location) { redirect
 * to whatever }` gets a public front door and a private back one.
 */
export async function safeFetch(
  targetUrl: string,
  options: { accept: string; timeoutMs?: number } = { accept: "*/*" },
): Promise<SafeFetchResult> {
  let current = targetUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const url = parseHttpUrl(current);
    const resolved = await resolveSafeAddress(url.hostname, {});
    if (!resolved) {
      throw new UnsafeUrlError(
        `${url.hostname} does not resolve to a public address`,
      );
    }

    const result = await fetchPinnedAddress(url, resolved, options);
    if (
      result.statusCode >= 300 &&
      result.statusCode < 400 &&
      result.headers.location
    ) {
      current = new URL(result.headers.location, url).toString();
      continue;
    }
    return { ...result, finalUrl: url.toString() };
  }
  throw new UnsafeUrlError("Too many redirects");
}

export function parseHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnsafeUrlError("Not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeUrlError("Only http and https are fetchable");
  }
  // Embedded credentials are the classic way to make a hostile host read as a
  // trusted one to a human skimming a link, and they have no legitimate use
  // in something posted for other people to click.
  if (url.username || url.password) {
    throw new UnsafeUrlError("URLs with embedded credentials are refused");
  }
  return url;
}

/**
 * The connection mechanics — redirect status detection, the size cap, the
 * timeout — with the address-safety check already done by the caller.
 * Exported (only) so the mechanics can be exercised against a real local
 * server in tests without that server's loopback address being rejected by
 * the SSRF check the tests are not exercising here; `safe-fetch.test.ts`
 * covers `isBlockedAddress` and the full `safeFetch` pipeline separately.
 */
export interface FetchPinnedOptions {
  accept?: string;
  timeoutMs?: number;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string | Buffer;
}

export function fetchPinnedAddress(
  url: URL,
  resolved: { address: string; family: 4 | 6 },
  options: FetchPinnedOptions,
): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}> {
  const transport = url.protocol === "https:" ? https : http;
  const method = options.method ?? "GET";
  const body =
    options.body === undefined
      ? undefined
      : typeof options.body === "string"
        ? Buffer.from(options.body, "utf8")
        : options.body;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        // The one line that matters: never let this request resolve the
        // hostname again. Whatever Node asks to look up, hand back exactly
        // the address already checked, regardless of what it asked for.
        //
        // `dns.lookup`-shaped callbacks have two incompatible shapes and
        // Node's own HTTP agent picks between them per call depending on
        // internal happy-eyeballs behaviour: `options.all` asks for
        // `callback(err, [{address, family}])`, its absence asks for
        // `callback(err, address, family)`. Answering only one shape works
        // until the one time Node asks for the other, and then this becomes
        // "Invalid IP address: undefined" several layers down with nothing
        // pointing back at the real cause.
        lookup: (_hostname, opts, callback) => {
          if (typeof opts === "function") {
            callback = opts;
          }
          if (typeof opts === "object" && opts?.all) {
            callback(null, [
              { address: resolved.address, family: resolved.family },
            ]);
            return;
          }
          callback(null, resolved.address, resolved.family);
        },
        headers: {
          "user-agent": "pqpBot/1.0 (+https://pqp.gg)",
          ...(options.accept ? { accept: options.accept } : {}),
          ...(body ? { "content-length": String(body.length) } : {}),
          ...options.headers,
        },
        timeout: options.timeoutMs ?? TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let settled = false;

        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_BODY_BYTES) {
            settled = true;
            res.destroy();
            reject(new FetchTooLargeError());
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (!settled) {
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            });
          }
        });
        res.on("error", (error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
    if (body) {
      req.end(body);
    } else {
      req.end();
    }
  });
}

const OUTGOING_POST_TIMEOUT_MS = 15_000;

/**
 * POST a caller-supplied body to a user-chosen URL with the destination
 * pinned the same way `safeFetch` pins GETs. Redirects are not followed:
 * a 3xx is a failed delivery, not a hop. That is load-bearing for webhooks
 * — a 302 to an internal host is the classic SSRF second step, and Standard
 * Webhooks treats anything other than 2xx as failure anyway.
 */
export async function safePost(
  targetUrl: string,
  options: {
    body: string | Buffer;
    headers?: Record<string, string>;
    timeoutMs?: number;
    allowPrivate?: boolean;
    requireHttps?: boolean;
  },
): Promise<SafeFetchResult> {
  const url = parseHttpUrl(targetUrl);
  if (options.requireHttps && url.protocol !== "https:") {
    throw new UnsafeUrlError("Outgoing webhooks require HTTPS");
  }
  const resolved = await resolveSafeAddress(url.hostname, {
    allowPrivate: options.allowPrivate === true,
  });
  if (!resolved) {
    throw new UnsafeUrlError(
      `${url.hostname} does not resolve to a public address`,
    );
  }
  const result = await fetchPinnedAddress(url, resolved, {
    method: "POST",
    headers: options.headers,
    body: options.body,
    timeoutMs: options.timeoutMs ?? OUTGOING_POST_TIMEOUT_MS,
  });
  return { ...result, finalUrl: url.toString() };
}
