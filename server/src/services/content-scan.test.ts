import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  contentScanProvider,
  failsClosed,
  isContentScanConfigured,
  isScannableContentType,
  normaliseSightengine,
  scanAllowsAttachment,
  scanImage,
  type ScanResult,
} from "./content-scan.js";

/**
 * The tests that matter here are the failure ones.
 *
 * A scanner's happy path is easy and is not where the risk is. The risk is that
 * some shape of failure — a provider down, a 500, a captive portal serving
 * HTML, a schema change that renames one field, a key that was never set —
 * comes back looking enough like "nothing wrong with this image" that the
 * caller attaches it. Every one of those has to be an `error` verdict, and
 * `scanAllowsAttachment` has to refuse an `error` under the default fail mode.
 *
 * Nothing here touches the network. `fetch` is stubbed per case, which is also
 * the only way to produce "provider returns garbage" reliably.
 */

const ENV_KEYS = [
  "CONTENT_SCAN_PROVIDER",
  "CONTENT_SCAN_URL",
  "CONTENT_SCAN_TOKEN",
  "CONTENT_SCAN_FAIL_MODE",
  "CONTENT_SCAN_TIMEOUT_MS",
  "CONTENT_SCAN_REJECT_THRESHOLD",
  "CONTENT_SCAN_FLAG_THRESHOLD",
  "CONTENT_SCAN_FLAG_MINORS",
  "OPENAI_API_KEY",
  "OPENAI_MODERATION_MODEL",
  "SIGHTENGINE_API_USER",
  "SIGHTENGINE_API_SECRET",
  "SIGHTENGINE_MODELS",
] as const;

const saved = new Map<string, string | undefined>();

/** JSON body, 200, the way a healthy provider answers. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const spy = vi.fn(
    (input: string | URL | Request, init?: RequestInit) =>
      impl(String(input), init),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

async function scanPng(): Promise<ScanResult> {
  return scanImage({
    imageUrl: "https://bucket.test/object.png?sig=x",
    contentType: "image/png",
  });
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  // Every failure path below logs, and a passing suite that prints stack traces
  // trains people to ignore the output.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  saved.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("configuration", () => {
  it("is off with nothing set, and that is not an error", async () => {
    expect(isContentScanConfigured()).toBe(false);
    expect(contentScanProvider()).toBeNull();

    const fetchSpy = stubFetch(async () => jsonResponse({}));
    const result = await scanPng();

    // The whole "harmless when unconfigured" contract: no call, no verdict, no
    // provider, and a status that does not claim anything was checked.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "unscanned",
      provider: null,
      score: null,
      labels: [],
      illegal: false,
    });
    expect(scanAllowsAttachment(result)).toBe(true);
  });

  it("reads a provider named without its credentials as off, not as broken", async () => {
    // The half-configured deployment: one variable typed, the rest not. Failing
    // closed here would brick every upload on an instance whose operator was
    // mid-setup, and there is nothing to fail closed *about* — no scanner was
    // ever reachable.
    process.env.CONTENT_SCAN_PROVIDER = "openai";
    expect(contentScanProvider()).toBeNull();
    expect(await scanPng()).toMatchObject({ status: "unscanned" });

    process.env.CONTENT_SCAN_PROVIDER = "sightengine";
    process.env.SIGHTENGINE_API_USER = "user";
    // Secret still missing.
    expect(contentScanProvider()).toBeNull();

    process.env.CONTENT_SCAN_PROVIDER = "webhook";
    expect(contentScanProvider()).toBeNull();
  });

  it("ignores a provider name nobody implements", () => {
    process.env.CONTENT_SCAN_PROVIDER = "magic-vision";
    process.env.OPENAI_API_KEY = "sk-test";
    expect(contentScanProvider()).toBeNull();
  });

  it("fails closed unless the operator says otherwise, out loud", () => {
    expect(failsClosed()).toBe(true);

    process.env.CONTENT_SCAN_FAIL_MODE = "closed";
    expect(failsClosed()).toBe(true);

    // Anything that is not exactly "open" keeps the safe default: a typo must
    // not be the reason unscanned images start publishing.
    process.env.CONTENT_SCAN_FAIL_MODE = "opne";
    expect(failsClosed()).toBe(true);

    process.env.CONTENT_SCAN_FAIL_MODE = "OPEN";
    expect(failsClosed()).toBe(false);
  });

  it("scans rasters and skips everything else", async () => {
    expect(isScannableContentType("image/png")).toBe(true);
    expect(isScannableContentType("image/webp")).toBe(true);
    // Not a prefix test, for the same reason `isImageContentType` is not.
    expect(isScannableContentType("image/svg+xml")).toBe(false);
    expect(isScannableContentType("video/mp4")).toBe(false);
    expect(isScannableContentType("application/pdf")).toBe(false);

    process.env.CONTENT_SCAN_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchSpy = stubFetch(async () => jsonResponse({}));

    const result = await scanImage({
      imageUrl: "https://bucket.test/clip.mp4",
      contentType: "video/mp4",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    // `skipped`, never `pass`: no classifier looked at this file.
    expect(result.status).toBe("skipped");
    expect(result.provider).toBe("openai");
    expect(scanAllowsAttachment(result)).toBe(true);
  });
});

describe("the fail-closed path", () => {
  beforeEach(() => {
    process.env.CONTENT_SCAN_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
  });

  it("calls a provider that cannot be reached an error, and refuses the image", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const result = await scanPng();

    expect(result.status).toBe("error");
    expect(result.provider).toBe("openai");
    expect(result.labels).toEqual(["scan_error:unreachable"]);
    // The line this whole file exists for.
    expect(scanAllowsAttachment(result)).toBe(false);
  });

  it("calls a provider that never answers an error, and does not hang", async () => {
    process.env.CONTENT_SCAN_TIMEOUT_MS = "20";
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          // Exactly what fetch does when its AbortSignal fires.
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("The operation was aborted");
            error.name = "TimeoutError";
            reject(error);
          });
        }),
    );

    const result = await scanPng();

    expect(result.status).toBe("error");
    expect(result.labels).toEqual(["scan_error:timeout"]);
    expect(scanAllowsAttachment(result)).toBe(false);
  });

  it("calls a rejected key an error rather than a pass", async () => {
    stubFetch(async () => jsonResponse({ error: "invalid api key" }, 401));

    const result = await scanPng();

    expect(result.status).toBe("error");
    expect(result.labels).toEqual(["scan_error:http_401"]);
    expect(scanAllowsAttachment(result)).toBe(false);
  });

  it("calls a body that is not JSON an error", async () => {
    // A captive portal, a proxy error page, a CDN maintenance screen: 200 OK
    // and not a verdict.
    stubFetch(
      async () =>
        new Response("<html><body>Gateway</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );

    const result = await scanPng();

    expect(result.status).toBe("error");
    expect(result.labels).toEqual(["scan_error:malformed"]);
    expect(scanAllowsAttachment(result)).toBe(false);
  });

  it("calls JSON with no scores an error, not a clean image", async () => {
    // The dangerous shape. Every field the adapter reads is absent, so every
    // score reads `undefined`, so nothing crosses a threshold — which without
    // the empty guard would look exactly like a spotless picture.
    for (const body of [{}, [], { results: [] }, { results: [{}] }, null]) {
      stubFetch(async () => jsonResponse(body));
      const result = await scanPng();
      expect(result.status).toBe("error");
      expect(scanAllowsAttachment(result)).toBe(false);
    }
  });

  it("calls scores of the wrong type an error", async () => {
    // A schema change that turns floats into strings, or into the bucket words
    // Google's SafeSearch uses. `probability` refuses both, which empties the
    // category set, which is an error rather than a pass.
    stubFetch(async () =>
      jsonResponse({
        results: [
          {
            category_scores: {
              sexual: "VERY_UNLIKELY",
              "violence/graphic": null,
              "sexual/minors": 42,
            },
          },
        ],
      }),
    );

    const result = await scanPng();

    expect(result.status).toBe("error");
    expect(scanAllowsAttachment(result)).toBe(false);
  });

  it("lets an operator opt into failing open, and only then", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const closed = await scanPng();
    expect(scanAllowsAttachment(closed)).toBe(false);

    process.env.CONTENT_SCAN_FAIL_MODE = "open";
    const open = await scanPng();
    // Still recorded as an error — failing open changes what happens to the
    // image, never what the row says happened.
    expect(open.status).toBe("error");
    expect(scanAllowsAttachment(open)).toBe(true);
  });

  it("never lets a rejection through, whatever the fail mode says", () => {
    process.env.CONTENT_SCAN_FAIL_MODE = "open";
    expect(
      scanAllowsAttachment({
        status: "rejected",
        provider: "openai",
        score: 0.99,
        labels: ["csam_suspected"],
        illegal: true,
      }),
    ).toBe(false);
  });
});

describe("openai", () => {
  beforeEach(() => {
    process.env.CONTENT_SCAN_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
  });

  it("hands over a URL and never any bytes", async () => {
    const fetchSpy = stubFetch(async () =>
      jsonResponse({
        results: [{ category_scores: { sexual: 0.01, "violence/graphic": 0.0 } }],
      }),
    );

    await scanPng();

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/moderations");
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      input: Array<{ type: string; image_url: { url: string } }>;
    };
    // The architectural invariant, asserted: the request carries a link to the
    // object, not the object. Nothing in this process ever read the file.
    expect(body.input[0]!.type).toBe("image_url");
    expect(body.input[0]!.image_url.url).toBe(
      "https://bucket.test/object.png?sig=x",
    );
    expect(body.model).toBe("omni-moderation-latest");
  });

  it("passes an image nothing scored", async () => {
    stubFetch(async () =>
      jsonResponse({
        results: [
          {
            category_scores: {
              sexual: 0.002,
              "sexual/minors": 0.0001,
              "violence/graphic": 0.01,
            },
          },
        ],
      }),
    );

    const result = await scanPng();

    expect(result).toMatchObject({
      status: "pass",
      provider: "openai",
      labels: [],
      illegal: false,
    });
    expect(scanAllowsAttachment(result)).toBe(true);
  });

  it("does not flag adult sexual content, because the terms permit it", async () => {
    // pqp.gg is 18+ and its acceptable-use list does not ban adult nudity. A
    // scanner that queued every explicit image would build a queue no moderator
    // can action, and train them to clear it unread.
    stubFetch(async () =>
      jsonResponse({
        results: [
          {
            category_scores: {
              sexual: 0.99,
              "sexual/minors": 0.0001,
              "violence/graphic": 0.01,
            },
          },
        ],
      }),
    );

    const result = await scanPng();

    expect(result.status).toBe("pass");
    expect(result.labels).toEqual([]);
  });

  it("rejects sexual content involving an apparent minor", async () => {
    stubFetch(async () =>
      jsonResponse({
        results: [
          {
            category_scores: {
              sexual: 0.97,
              "sexual/minors": 0.96,
              "violence/graphic": 0.0,
            },
          },
        ],
      }),
    );

    const result = await scanPng();

    expect(result.status).toBe("rejected");
    expect(result.labels).toContain("csam_suspected");
    // The flag that stops the object being auto-deleted 30 days later.
    expect(result.illegal).toBe(true);
    expect(scanAllowsAttachment(result)).toBe(false);
  });

  it("flags a middling minors score without blocking, and still marks it legally loaded", async () => {
    stubFetch(async () =>
      jsonResponse({
        results: [{ category_scores: { sexual: 0.8, "sexual/minors": 0.7 } }],
      }),
    );

    const result = await scanPng();

    expect(result.status).toBe("flagged");
    expect(result.illegal).toBe(true);
    // A flag posts the image and files a report — the block threshold is for
    // confidence a human may never revisit.
    expect(scanAllowsAttachment(result)).toBe(true);
  });

  it("flags graphic violence without blocking it", async () => {
    stubFetch(async () =>
      jsonResponse({
        results: [{ category_scores: { sexual: 0.01, "violence/graphic": 0.93 } }],
      }),
    );

    const result = await scanPng();

    expect(result.status).toBe("flagged");
    expect(result.labels).toEqual(["gore"]);
    expect(result.illegal).toBe(false);
    expect(scanAllowsAttachment(result)).toBe(true);
  });

  it("honours thresholds the operator moved", async () => {
    process.env.CONTENT_SCAN_FLAG_THRESHOLD = "0.2";
    process.env.CONTENT_SCAN_REJECT_THRESHOLD = "0.4";
    stubFetch(async () =>
      jsonResponse({
        results: [{ category_scores: { "sexual/minors": 0.5 } }],
      }),
    );

    expect((await scanPng()).status).toBe("rejected");
  });

  it("ignores a threshold outside 0..1 rather than trusting it", async () => {
    // `0` would reject every image ever uploaded; `12` would reject none. Both
    // fall back to the shipped default.
    process.env.CONTENT_SCAN_REJECT_THRESHOLD = "0";
    process.env.CONTENT_SCAN_FLAG_THRESHOLD = "12";
    stubFetch(async () =>
      jsonResponse({
        results: [{ category_scores: { sexual: 0.5, "sexual/minors": 0.5 } }],
      }),
    );

    expect((await scanPng()).status).toBe("pass");
  });
});

describe("webhook", () => {
  beforeEach(() => {
    process.env.CONTENT_SCAN_PROVIDER = "webhook";
    process.env.CONTENT_SCAN_URL = "https://scan.example.workers.dev/";
    process.env.CONTENT_SCAN_TOKEN = "shared-secret";
  });

  it("sends the URL and the bearer token the operator configured", async () => {
    const fetchSpy = stubFetch(async () => jsonResponse({ verdict: "pass" }));

    await scanPng();

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://scan.example.workers.dev/");
    expect(
      (init?.headers as Record<string, string>).authorization,
    ).toBe("Bearer shared-secret");
    expect(JSON.parse(String(init?.body))).toEqual({
      imageUrl: "https://bucket.test/object.png?sig=x",
      contentType: "image/png",
    });
  });

  it("carries an illegal-content match through untouched", async () => {
    // This is the contract a CSAM hash-matching adapter fulfils: the endpoint
    // is the only component that could ever know, so its answer is taken.
    stubFetch(async () =>
      jsonResponse({
        verdict: "reject",
        score: 1,
        labels: ["illegal"],
        illegal: true,
        provider: "iwf-image-intercept",
      }),
    );

    const result = await scanPng();

    expect(result.status).toBe("rejected");
    expect(result.illegal).toBe(true);
    // The endpoint's own name is recorded, not "webhook" — a dispute months
    // later needs to know which list matched.
    expect(result.provider).toBe("iwf-image-intercept");
    expect(scanAllowsAttachment(result)).toBe(false);
  });

  it("calls a missing or unknown verdict an error", async () => {
    for (const body of [
      {},
      { verdict: "ok" },
      { verdict: true },
      { score: 0.1 },
      [{ verdict: "pass" }],
      "pass",
    ]) {
      stubFetch(async () => jsonResponse(body));
      const result = await scanPng();
      expect(result.status).toBe("error");
      expect(scanAllowsAttachment(result)).toBe(false);
    }
  });

  it("does not let a half-deployed endpoint read as a pass", async () => {
    // A Worker route that exists but has not been written yet.
    stubFetch(async () => new Response("", { status: 200 }));

    const result = await scanPng();

    expect(result.status).toBe("error");
    expect(scanAllowsAttachment(result)).toBe(false);
  });

  it("drops labels that are not strings instead of failing on them", async () => {
    stubFetch(async () =>
      jsonResponse({ verdict: "flag", labels: ["gore", 7, null, "spam"] }),
    );

    const result = await scanPng();

    expect(result.status).toBe("flagged");
    expect(result.labels).toEqual(["gore", "spam"]);
  });

  it("refuses to treat a truthy non-true `illegal` as a legal hold", async () => {
    stubFetch(async () =>
      jsonResponse({ verdict: "reject", illegal: "yes", labels: ["gore"] }),
    );

    expect((await scanPng()).illegal).toBe(false);
  });
});

describe("sightengine", () => {
  beforeEach(() => {
    process.env.CONTENT_SCAN_PROVIDER = "sightengine";
    process.env.SIGHTENGINE_API_USER = "user";
    process.env.SIGHTENGINE_API_SECRET = "secret";
  });

  it("asks the provider to fetch the object, credentials in the query", async () => {
    const fetchSpy = stubFetch(async () =>
      jsonResponse({ status: "success", gore: { prob: 0.01 } }),
    );

    await scanPng();

    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe(
      "https://api.sightengine.com/1.0/check.json",
    );
    expect(url.searchParams.get("url")).toBe(
      "https://bucket.test/object.png?sig=x",
    );
    expect(url.searchParams.get("api_user")).toBe("user");
  });

  it("calls anything but an explicit success an error", async () => {
    for (const body of [
      { status: "failure", error: { message: "bad key" } },
      { status: "success" },
      { nudity: { sexual_activity: 0.9 } },
    ]) {
      stubFetch(async () => jsonResponse(body));
      const result = await scanPng();
      expect(result.status).toBe("error");
      expect(scanAllowsAttachment(result)).toBe(false);
    }
  });

  it("blocks only on the conjunction of minor and sexual content", async () => {
    stubFetch(async () =>
      jsonResponse({
        status: "success",
        nudity: { sexual_activity: 0.98, none: 0.01 },
        faces: [{ attributes: { minor: 0.97 } }],
      }),
    );

    const result = await scanPng();

    expect(result.status).toBe("rejected");
    expect(result.labels).toContain("csam_suspected");
    expect(result.illegal).toBe(true);
  });

  it("does not block an explicit image of adults", async () => {
    stubFetch(async () =>
      jsonResponse({
        status: "success",
        nudity: { sexual_activity: 0.99, none: 0.0 },
        faces: [{ attributes: { minor: 0.02 } }],
      }),
    );

    expect((await scanPng()).status).toBe("pass");
  });

  it("flags an apparent minor on its own, and stops when told to", async () => {
    const body = {
      status: "success",
      nudity: { sexual_activity: 0.01, none: 0.99 },
      faces: [{ attributes: { minor: 0.91 } }],
    };

    stubFetch(async () => jsonResponse(body));
    const flagged = await scanPng();
    expect(flagged.status).toBe("flagged");
    expect(flagged.labels).toEqual(["minor_present"]);

    process.env.CONTENT_SCAN_FLAG_MINORS = "false";
    stubFetch(async () => jsonResponse(body));
    expect((await scanPng()).status).toBe("pass");
  });
});

describe("normaliseSightengine", () => {
  /**
   * Pinned directly because this mapping is where a provider's schema change
   * turns into a silent pass: a renamed field reads `undefined`, `undefined`
   * never crosses a threshold, and the image sails through. The empty-set guard
   * catches "I understood nothing"; only these catch "I understood half".
   */
  it("takes the strongest explicit nudity class, ignoring the suggestive ones", () => {
    expect(
      normaliseSightengine({
        nudity: {
          sexual_activity: 0.1,
          sexual_display: 0.7,
          erotica: 0.2,
          very_suggestive: 0.99,
          none: 0.01,
        },
      }),
    ).toEqual({ sexual_activity: 0.7 });
  });

  it("reads the flat minor shape and the per-face one alike", () => {
    expect(normaliseSightengine({ minor: { prob: 0.4 } })).toEqual({
      minor_present: 0.4,
    });
    expect(
      normaliseSightengine({
        faces: [{ attributes: { minor: 0.2 } }, { attributes: { minor: 0.8 } }],
      }),
    ).toEqual({ minor_present: 0.8 });
  });

  it("multiplies the two signals rather than taking either alone", () => {
    const scores = normaliseSightengine({
      nudity: { sexual_activity: 0.8 },
      minor: { prob: 0.5 },
    });
    expect(scores.csam_suspected).toBeCloseTo(0.4);
  });

  it("finds nothing in a response it does not recognise", () => {
    // Which is what turns a renamed schema into an error upstream, rather than
    // a clean bill of health.
    expect(normaliseSightengine({ nudity_v3: { raw: 0.99 } })).toEqual({});
    expect(normaliseSightengine({ nudity: "very" })).toEqual({});
    expect(normaliseSightengine({ faces: "two" })).toEqual({});
  });
});
