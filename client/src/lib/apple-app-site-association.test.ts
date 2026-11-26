import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  headersFor,
  parseHeadersFile,
} from "../../e2e/stale-bundle/pages-headers";

/**
 * WHICH pqp.gg PATHS THE iPHONE APP CLAIMS.
 *
 * A path in this file is a promise that the app opens it. A link the app is
 * handed and cannot open is worse than one the web opens, so the list is short
 * on purpose: the invite and a jam song's own link, both of which the app
 * parses (`DeepLink.target`) and ends somewhere on, even when the answer is a
 * sentence. The plain `/app/server/<s>/channel/<c>` path is NOT claimed: a
 * channel can be a voice room or a watch party, which the app does not open
 * from a link, and `/*` would take every page of the site.
 *
 * Apple's CDN caches this file for about a day, so a change here reaches
 * devices late: see docs/IOS.md, "Invite links".
 */
const root = path.resolve(import.meta.dirname, "../..");
const file = path.join(root, "public/.well-known/apple-app-site-association");

type Aasa = {
  applinks: {
    details: { appIDs: string[]; components: { "/": string }[] }[];
  };
};

const aasa = JSON.parse(readFileSync(file, "utf8")) as Aasa;
const claimed = aasa.applinks.details.flatMap((d) =>
  d.components.map((c) => c["/"]),
);

/** Apple's `*` matches any run of characters, `/` included; `?` one. */
function matches(pattern: string, pathname: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(pathname);
}

describe("apple-app-site-association", () => {
  it("claims the invite and the jam song, and nothing else", () => {
    expect(claimed).toEqual([
      "/app/invite/*",
      "/app/server/*/channel/*/song/*",
    ]);
  });

  it("covers the links the apps hand out", () => {
    expect(matches("/app/server/*/channel/*/song/*", "/app/server/s1/channel/j1/song/g1")).toBe(true);
    const owns = (p: string) => claimed.some((pattern) => matches(pattern, p));
    expect(owns("/app/invite/AbCd1234")).toBe(true);
    expect(owns("/app/server/s1/channel/j1/song/g1")).toBe(true);
    // Percent-encoded ids, as `jamSongRoutePath` writes them.
    expect(owns("/app/server/s%201/channel/j%2F1/song/g%201")).toBe(true);
  });

  it("does not capture a path the app cannot open", () => {
    const owns = (p: string) => claimed.some((pattern) => matches(pattern, p));
    // The plain channel link (text, forum, jam, voice, watch party alike).
    expect(owns("/app/server/s1/channel/c1")).toBe(false);
    // Another route with a song-shaped tail is not a song.
    expect(owns("/app/server/s1/channel/c1/post/p1")).toBe(false);
    expect(owns("/app/server/s1/channel/c1/message/m1")).toBe(false);
    expect(owns("/app/server/s1/channel/j1/song")).toBe(false);
    // The rest of the site and the web app's own screens.
    for (const p of ["/", "/app", "/app/dm/d1", "/app/server/s1", "/jam/abc", "/blog/x", "/@rafa", "/c/slug"]) {
      expect(owns(p), p).toBe(false);
    }
  });

  it("names the app once", () => {
    expect(aasa.applinks.details).toHaveLength(1);
    expect(aasa.applinks.details[0]?.appIDs).toEqual(["WXBFUF9WMA.gg.pqp.app"]);
  });

  it("is served as JSON at a short cache, as it was before", () => {
    const rules = parseHeadersFile(
      readFileSync(path.join(root, "public/_headers"), "utf8"),
    );
    const headers = headersFor(
      rules,
      "/.well-known/apple-app-site-association",
      "application/octet-stream",
    );
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["cache-control"]).toBe("public, max-age=300");
  });
});
