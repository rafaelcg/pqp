import { readFileSync, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { isUnknownSpaPath } from "../../src/lib/spa-routes";
import { headersFor, parseHeadersFile } from "./pages-headers";

/**
 * A stand-in for Cloudflare Pages, small enough to read in one go, faithful in
 * the four ways that decide whether a browser keeps a stale bundle:
 *
 *  - it serves whichever build directory is CURRENT, and `serve()` swaps it, so
 *    a spec can deploy a new build under a page that is already open;
 *  - a file with no matching rule in `client/public/_headers` gets what Pages
 *    gives every asset by default, `public, max-age=0, must-revalidate`;
 *  - the REAL `_headers` file is parsed and applied (not a copy of it), with
 *    Pages' rule that several matching rules ADD to a header rather than
 *    replace it. A rule that wrongly matched `/assets/*` and `/*` would show up
 *    here as a comma-joined Cache-Control, which is what production would send;
 *  - an unknown path answers `index.html` with a 200, the SPA fallback;
 *  - Pages' "pretty URLs": a request for `/x.html` is a 308 to `/x`, and `/x`
 *    is answered from `x.html`. This is what turned `public/*.html` into a
 *    redirect for the service worker's precache fetch;
 *  - the edge not-found middleware (`functions/_middleware.ts`): a GET that
 *    would be answered with HTML for a path `isUnknownSpaPath` says the SPA has
 *    no route for becomes a 404 with the body kept. The REAL predicate is
 *    imported, not copied. A `HEAD` is not touched, which is exactly why
 *    `curl -I` said everything was fine while every worker install failed
 *    (see docs/PWA.md, 2026-10-10).
 *
 * `/api/*` answers 404 and `/ws` is not served: the specs that use this are
 * about the shell, and a missing API must be survivable by the client anyway.
 */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".wasm": "application/wasm",
};

export interface PagesServer {
  origin: string;
  /** Make `dir` the deployed build. Already-open pages keep what they loaded. */
  serve: (dir: string) => void;
  /**
   * Answer `pathname` from `file` whatever build is deployed (null undoes it).
   * This is a CDN holding on to one file past a deploy: the stale `sw.js` that
   * `pqp.gg` can serve while Pages itself is already on the new build.
   */
  pin: (pathname: string, file: string | null) => void;
  /** Requests answered, oldest first, for asserting what a browser re-fetched. */
  requests: () => string[];
  close: () => Promise<void>;
}

export async function startPagesServer(options: {
  headersFile: string;
  port?: number;
}): Promise<PagesServer> {
  const rules = parseHeadersFile(readFileSync(options.headersFile, "utf8"));
  let root = "";
  const log: string[] = [];
  const pinned = new Map<string, string>();

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = decodeURIComponent(url.pathname);
    log.push(pathname);
    if (pathname.startsWith("/api/")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    // Pages' pretty URLs. `/index.html` is a 308 to `/` like any other page.
    if (!pinned.has(pathname) && pathname.endsWith(".html")) {
      const pretty = pathname.endsWith("/index.html")
        ? pathname.slice(0, -"index.html".length)
        : pathname.slice(0, -".html".length);
      res.writeHead(308, { location: pretty + url.search });
      res.end();
      return;
    }
    let file =
      pinned.get(pathname) ??
      path.join(root, pathname === "/" ? "index.html" : pathname);
    if (
      !pinned.has(pathname) &&
      pathname !== "/" &&
      !path.extname(pathname) &&
      existsSync(`${file}.html`)
    ) {
      file = `${file}.html`;
    }
    if (
      !pinned.has(pathname) &&
      (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile())
    ) {
      // The SPA fallback. A path with an extension that is missing is a 404,
      // which is what Pages does for a chunk that a deploy removed.
      if (path.extname(pathname) !== "") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      file = path.join(root, "index.html");
    }
    const type = TYPES[path.extname(file)] ?? "application/octet-stream";
    // The edge middleware: GET only, HTML only, unknown-to-the-SPA paths only.
    const status =
      req.method === "GET" && type.startsWith("text/html") && isUnknownSpaPath(pathname)
        ? 404
        : 200;
    res.writeHead(status, headersFor(rules, pathname, type));
    res.end(req.method === "HEAD" ? undefined : readFileSync(file));
  });

  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, "127.0.0.1", resolve),
  );
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://localhost:${port}`,
    serve(dir) {
      root = path.resolve(dir);
    },
    pin(pathname, file) {
      if (file === null) {
        pinned.delete(pathname);
      } else {
        pinned.set(pathname, path.resolve(file));
      }
    },
    requests: () => [...log],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
