import { describe, expect, it } from "vitest";
import { onRequest } from "../../functions/_middleware";
import { jamHostRedirect } from "./jam-meta";

/**
 * `jam.pqp.gg` serves the whole build, so anything that is not the jam site
 * (`/`, `/m/<id>`, its static files) would be an indexable duplicate of the
 * main site. It is a permanent redirect to the same path on `pqp.gg` instead.
 */

const ID = "0b8f1c52-3e0a-4a55-9c1e-6a1f0c2d9e77";
const SHELL = '<!doctype html><html lang="en"><head><title>x</title></head><body><div id="root"></div></body></html>';

function ctx(url: string, method = "GET") {
  return {
    request: new Request(url, { method }),
    env: {},
    next: async () => new Response(SHELL, { headers: { "content-type": "text/html; charset=utf-8" } }),
  };
}

describe("jam host redirect (pure)", () => {
  const at = (pathname: string, search = "") => jamHostRedirect({ protocol: "https:", hostname: "jam.pqp.gg", port: "", pathname, search });

  it("sends a path that is not the jam site to the same path on the main site", () => {
    expect(at("/download")).toBe("https://pqp.gg/download");
    expect(at("/app", "?jam=new")).toBe("https://pqp.gg/app?jam=new");
    expect(at("/@rafa")).toBe("https://pqp.gg/@rafa");
    expect(at("/m")).toBe("https://pqp.gg/m");
    expect(at("/m/a/b")).toBe("https://pqp.gg/m/a/b");
  });

  it("carries ref and utm_* through, so a hand-over to the app keeps its attribution", () => {
    const search = "?jam=new&ref=clip-ana&utm_source=tiktok&utm_campaign=jam-nov";
    expect(at("/app", search)).toBe(`https://pqp.gg/app${search}`);
    // the site's own address is served as it is, query and all
    expect(at(`/m/${ID}`, "?ref=clip-ana")).toBeNull();
  });

  it("keeps the jam site's own addresses and its static files", () => {
    for (const path of ["/", `/m/${ID}`, `/m/${ID}/`, "/assets/jam-site-abc.js", "/icons/favicon-32.png", "/images/og-image.jpg", "/favicon.ico", "/manifest.webmanifest", "/robots.txt"]) {
      expect(at(path), path).toBeNull();
    }
  });

  it("is only for a jam host", () => {
    expect(jamHostRedirect({ protocol: "https:", hostname: "pqp.gg", port: "", pathname: "/download", search: "" })).toBeNull();
    expect(jamHostRedirect({ protocol: "http:", hostname: "jam.localhost", port: "5173", pathname: "/download", search: "" })).toBe(
      "http://localhost:5173/download",
    );
  });
});

describe("jam host redirect (middleware)", () => {
  it("answers 301 with the main site's address for a page that is not the jam site", async () => {
    const res = await onRequest(ctx("https://jam.pqp.gg/download?x=1"));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://pqp.gg/download?x=1");
  });

  it("redirects a HEAD the same way", async () => {
    const res = await onRequest(ctx("https://jam.pqp.gg/vs-discord", "HEAD"));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://pqp.gg/vs-discord");
  });

  it("does not touch the main site, the jam mount at /jam, or a jam static file", async () => {
    expect((await onRequest(ctx("https://pqp.gg/download"))).status).not.toBe(301);
    expect((await onRequest(ctx("https://pqp.gg/jam"))).status).not.toBe(301);
    const icon = ctx("https://jam.pqp.gg/icons/favicon-32.png");
    expect((await onRequest(icon)).status).not.toBe(301);
  });
});
