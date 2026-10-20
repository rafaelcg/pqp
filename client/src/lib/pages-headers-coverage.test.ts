import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  headersFor,
  parseHeadersFile,
  type HeaderRule,
} from "../../e2e/stale-bundle/pages-headers";

/**
 * EVERY CLASS OF FILE THE BUILD EMITS HAS A DELIBERATE CACHE POLICY.
 *
 * The zone in front of Pages applies its Browser Cache TTL (4 h) to cacheable
 * extensions that a response is not explicit about. Setting it to "Respect
 * Existing Headers" hands every such file back to Pages' default,
 * `public, max-age=0, must-revalidate`, a revalidation on every load (icons, the
 * four sounds, the favicon). So that setting is only safe once no emitted file
 * relies on the default. These tests walk what the build puts in `dist/` (when
 * there is one: `vite build` and the stale-bundle e2e leave it) and `public/`
 * (always), and fail on a file no rule gives a Cache-Control, and on one that
 * two rules would give two of, because Pages JOINS the values of every matching
 * rule. `pages-headers.test.ts` pins the build-deciding files one by one.
 */
const root = path.resolve(import.meta.dirname, "../..");
const rules = parseHeadersFile(
  readFileSync(path.join(root, "public/_headers"), "utf8"),
);

function cacheControl(url: string, type = "text/html"): string | undefined {
  return headersFor(rules, url, type)["cache-control"];
}

function cacheRulesFor(pathname: string): HeaderRule[] {
  return rules.filter(
    (rule) =>
      rule.pattern.test(pathname) &&
      rule.headers.some(([name]) => name === "cache-control"),
  );
}

function walk(dir: string, base = ""): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = `${base}/${entry.name}`;
    return entry.isDirectory() ? walk(path.join(dir, entry.name), rel) : [rel];
  });
}

/** Files Pages reads and never serves. */
const NOT_SERVED = new Set(["/_headers", "/_redirects"]);

/**
 * What `vite build` writes that `public/` does not have, so a checkout with no
 * `dist/` still checks the names (the hashed ones are shaped like the real ones).
 */
const GENERATED = [
  "/index.html",
  "/sw.js",
  "/workbox-0bb07689.js",
  "/sw-build-abcdef0123456789.js",
  "/version.json",
  "/manifest.webmanifest",
  "/edge-config.json",
  "/changes.json",
  // Written by the build (`pqp-static-pages`), no longer a file in `public/`.
  "/sitemap.xml",
  "/feed.xml",
  "/feed.en.xml",
  "/blog.md",
  "/blog.en.md",
  "/blog/some-guide.md",
  "/blog/some-guide.en.md",
  "/blog/some-guide.es.md",
  "/prerender/blog/some-guide.pt-BR.json",
  "/assets/index-C1HA6RSd.js",
  "/assets/index-DsYbySKw.css",
  "/assets/gabarito-latin-DUTn1jtq.woff2",
  "/assets/App-v6yXaRNW.js",
];

/** The request paths a file answers: its own, `/` for the shell, the pretty URL of a page. */
function servedPaths(file: string): string[] {
  const out = [file];
  if (file === "/index.html") {
    out.push("/");
  }
  // (`/index` is not a URL: Pages answers `/index.html` and `/`.)
  if (file.endsWith(".html") && file !== "/index.html") {
    out.push(file.slice(0, -".html".length));
  }
  return out;
}

const files = [
  ...new Set([
    ...walk(path.join(root, "public")),
    ...walk(path.join(root, "dist")),
    ...GENERATED,
  ]),
]
  .filter((file) => !NOT_SERVED.has(file))
  .sort();

describe("_headers: every file the build emits has exactly one cache rule", () => {
  it("sees the file classes there are (the walk is not silently empty)", () => {
    expect(files.length).toBeGreaterThan(40);
    for (const needle of [
      "/sounds/message.mp3",
      "/icons/icon-192.png",
      "/favicon.ico",
      "/images/og-image.jpg",
      "/llms.txt",
      "/sitemap.xml",
      "/.well-known/security.txt",
      "/assets/index-C1HA6RSd.js",
    ]) {
      expect(files, needle).toContain(needle);
    }
  });

  it("gives every served path a Cache-Control of its own, and only one", () => {
    const missing: string[] = [];
    const doubled: string[] = [];
    for (const file of files) {
      for (const served of servedPaths(file)) {
        const matching = cacheRulesFor(served);
        if (matching.length === 0) {
          missing.push(served);
        } else if (matching.length > 1) {
          doubled.push(`${served} (${matching.length} rules)`);
        }
      }
    }
    expect(missing, "files with no Cache-Control rule").toEqual([]);
    expect(doubled, "files two rules would join into one value").toEqual([]);
  });

  it("never lets a rule meant for files answer a page", () => {
    // `/blog/<slug>`, `/c/<slug>`, `/@handle`, `/app/...` are the SPA shell, not files.
    for (const page of [
      "/app",
      "/app/server/x",
      "/blog/watch-party-e-o-aa",
      "/c/valorant",
      "/@rafa",
      "/vem",
      "/status",
    ]) {
      expect(cacheRulesFor(page), page).toEqual([]);
      expect(cacheControl(page), page).toBe("public, max-age=0, must-revalidate");
    }
  });
});

describe("_headers: the never-cache set", () => {
  const NEVER = [
    "/",
    "/index.html",
    "/sw.js",
    "/sw-notification-click.js",
    "/manifest.webmanifest",
    "/version.json",
    "/changes.json",
    "/edge-config.json",
    "/workbox-0bb07689.js",
    "/sw-build-abcdef0123456789.js",
    "/share-diagnostic",
    "/share-audio-tone",
  ];

  it("is revalidated or not stored, and never carries a max-age", () => {
    for (const url of NEVER) {
      expect(cacheControl(url), url).toMatch(/^(no-cache|no-store)$/);
    }
  });

  it("keeps the build-deciding files exactly as they were", () => {
    expect(cacheControl("/")).toBe("no-cache");
    expect(cacheControl("/index.html")).toBe("no-cache");
    expect(cacheControl("/sw.js")).toBe("no-cache");
    expect(cacheControl("/sw-notification-click.js")).toBe("no-cache");
    expect(cacheControl("/manifest.webmanifest")).toBe("no-cache");
    expect(cacheControl("/version.json")).toBe("no-store");
    expect(cacheControl("/changes.json")).toBe("no-store");
  });
});

describe("_headers: the long and the short policies", () => {
  const maxAge = (url: string) =>
    Number(/max-age=(\d+)/.exec(cacheControl(url) ?? "")?.[1] ?? Number.NaN);

  it("hashed assets are immutable for a year", () => {
    for (const url of [
      "/assets/index-C1HA6RSd.js",
      "/assets/index-DsYbySKw.css",
      "/assets/gabarito-latin-DUTn1jtq.woff2",
    ]) {
      expect(cacheControl(url), url).toBe("public, max-age=31536000, immutable");
    }
  });

  it("sounds and the favicon are kept a week and served stale while revalidating", () => {
    for (const url of [
      "/sounds/message.mp3",
      "/sounds/voice-join.ogg",
      "/sounds/soundboard/buzina.mp3",
      "/favicon.ico",
    ]) {
      expect(cacheControl(url), url).toBe(
        "public, max-age=604800, stale-while-revalidate=2592000",
      );
    }
  });

  it("icons, pictures and loops are kept a day and served stale while revalidating", () => {
    for (const url of [
      "/icons/icon-192.png",
      "/images/og-image.jpg",
      "/images/hero/hero-1200.webp",
      "/media/bubbles-loop.mp4",
      "/blog/watch-party-e-o-aa/atalhos.webp",
      "/blog/bau-e-o-dm-na-barra/bau.jpg",
      "/blog/dados-discord-e-cargos/ficha.gif",
    ]) {
      expect(cacheControl(url), url).toBe(
        "public, max-age=86400, stale-while-revalidate=604800",
      );
    }
  });

  it("what crawlers and agents read is short: an hour", () => {
    for (const url of [
      "/robots.txt",
      "/sitemap.xml",
      "/llms.txt",
      "/llms-full.txt",
      "/index.md",
      "/.well-known/security.txt",
      "/.well-known/api-catalog",
      "/.well-known/ai-catalog.json",
      "/.well-known/agent-skills/index.json",
      "/.well-known/agent-skills/pqp-public-surfaces/SKILL.md",
    ]) {
      expect(maxAge(url), url).toBe(3600);
    }
  });

  it("keeps the app-link files at five minutes", () => {
    expect(cacheControl("/.well-known/apple-app-site-association")).toBe(
      "public, max-age=300",
    );
    expect(cacheControl("/.well-known/assetlinks.json")).toBe(
      "public, max-age=300",
    );
  });
});
