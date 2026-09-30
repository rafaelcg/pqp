import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  headersFor,
  parseHeadersFile,
} from "../../e2e/stale-bundle/pages-headers";

/**
 * The cache policy of everything that decides WHICH BUILD somebody runs, read
 * from the real `client/public/_headers` the way Cloudflare Pages applies it.
 *
 * What this cannot see is the Cloudflare zone in front of Pages, which on
 * 2026-09-30 answered `/sw.js` with `max-age=14400` on `pqp.gg` while
 * `pqp-3yr.pages.dev` answered `no-cache` (see the note at the top of the file).
 * That one is a dashboard setting and is in the PR's "needs a human".
 */
const rules = parseHeadersFile(
  readFileSync(path.resolve(import.meta.dirname, "../../public/_headers"), "utf8"),
);

function cacheControl(url: string, type = "text/html"): string | undefined {
  const pathname = url === "/index.html" ? "/index.html" : url;
  return headersFor(rules, pathname, type)["cache-control"];
}

describe("_headers: what decides the build is never cached", () => {
  it("serves the page that names the bundle revalidated, at / and at /index.html", () => {
    expect(cacheControl("/")).toBe("no-cache");
    expect(cacheControl("/index.html")).toBe("no-cache");
  });

  it("keeps the homepage's Link header beside that", () => {
    expect(headersFor(rules, "/", "text/html")["link"]).toContain("api-catalog");
  });

  it("serves the service worker and what it imports revalidated", () => {
    expect(cacheControl("/sw.js")).toBe("no-cache");
    expect(cacheControl("/sw-notification-click.js")).toBe("no-cache");
  });

  it("serves the manifest revalidated", () => {
    expect(cacheControl("/manifest.webmanifest")).toBe("no-cache");
  });

  it("serves the version file with no-store", () => {
    expect(cacheControl("/version.json")).toBe("no-store");
  });

  it("still caches hashed assets hard, and ONLY them", () => {
    expect(cacheControl("/assets/index-C1HA6RSd.js")).toBe(
      "public, max-age=31536000, immutable",
    );
    // A rule that matched `/` AND `/assets/*` would join the two values.
    expect(cacheControl("/assets/index-C1HA6RSd.js")).not.toContain("no-cache");
  });

  it("leaves an SPA route on the Pages default: revalidated", () => {
    expect(cacheControl("/app")).toBe("public, max-age=0, must-revalidate");
  });
});
