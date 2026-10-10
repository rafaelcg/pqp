import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRECACHE_GLOB_IGNORES, PRECACHE_GLOB_PATTERNS } from "./sw-precache";
import { isUnknownSpaPath } from "./spa-routes";

/**
 * A precache entry that Pages redirects or the edge 404s fails every service
 * worker install (2026-09-30 to 2026-10-10: `share-diagnostic.html`). These
 * read the lists `vite.config.ts` hands to Workbox and apply them to `public/`,
 * which is copied into the build as is.
 */

const PUBLIC_DIR = path.resolve(import.meta.dirname, "../../public");

function walk(dir: string, base = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walk(path.join(dir, entry.name), rel) : [rel];
  });
}

function matches(file: string, globs: string[]): boolean {
  return globs.some((glob) => path.posix.matchesGlob(file, glob));
}

const publicFiles = walk(PUBLIC_DIR);
const publicHtml = publicFiles.filter((f) => f.endsWith(".html"));
// `index.html` is emitted by Vite, not copied from `public/`.
const buildFiles = [...publicFiles, "index.html"];
const precached = buildFiles.filter(
  (f) =>
    matches(f, PRECACHE_GLOB_PATTERNS) && !matches(f, PRECACHE_GLOB_IGNORES),
);

describe("service worker precache", () => {
  it("found public HTML to check (a vacuous test proves nothing)", () => {
    expect(publicHtml.length).toBeGreaterThan(0);
  });

  it("precaches index.html and no other HTML file", () => {
    expect(precached.filter((f) => f.endsWith(".html"))).toEqual(["index.html"]);
  });

  it("still precaches the shell's scripts and styles", () => {
    expect(matches("assets/index-abc.js", PRECACHE_GLOB_PATTERNS)).toBe(true);
    expect(matches("assets/index-abc.css", PRECACHE_GLOB_PATTERNS)).toBe(true);
    expect(matches("assets/font-latin-400.woff2", PRECACHE_GLOB_PATTERNS)).toBe(true);
    expect(matches("assets/workletProcessor-abc.js", PRECACHE_GLOB_IGNORES)).toBe(true);
  });

  it("lets the edge serve every public HTML page, with and without .html", () => {
    // Existing links to these pages must keep working, so the edge middleware
    // may never turn them into a 404.
    for (const file of publicHtml) {
      const withExt = `/${file}`;
      const pretty = withExt.replace(/\.html$/, "");
      expect(isUnknownSpaPath(withExt), withExt).toBe(false);
      expect(isUnknownSpaPath(pretty), pretty).toBe(false);
    }
  });
});
