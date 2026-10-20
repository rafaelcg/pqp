import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

/**
 * Five tiny servers on 127.0.0.1, one origin each (an origin is scheme, host
 * and port, so a port is all that tells them apart):
 *
 * - host: the page that embeds the app (`/` and `/page.js`)
 * - apps: the stand-in for the apps origin. Its frame documents carry the SAME
 *   CSP as production (`tools/apps-build/src/headers.mts`, copied here because
 *   this workspace does not depend on that one), with `frame-ancestors` set to
 *   the host, and `Access-Control-Allow-Origin: *`
 * - canary: records every request and every WebSocket upgrade it receives, and
 *   answers 200. Anything that reaches it left the sandbox.
 * - legit: an origin the client legitimately frames (passed to the policy as an
 *   extra origin, standing in for youtube.com and friends)
 * - other: an origin the policy does not list
 */
export interface Servers {
  host: string;
  apps: string;
  canary: string;
  legit: string;
  other: string;
  /** Every request path (with query) the canary has received, and upgrades prefixed `UPGRADE `. */
  hits: string[];
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

function serveDir(root: string, extra: (req: IncomingMessage) => Record<string, string>) {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, extra(req));
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", ...extra(req) });
    res.end(readFileSync(file));
  });
}

/** The production CSP of an app frame with no sandbox knobs (`cspFor` in tools/apps-build). */
export function appCsp(hostOrigin: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "media-src blob:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${hostOrigin}`,
  ].join("; ");
}

export async function startServers(dir: string): Promise<Servers> {
  const hits: string[] = [];

  const canary = createServer((req, res) => {
    hits.push(req.url ?? "/");
    res.writeHead(200, { "access-control-allow-origin": "*", "content-type": "text/plain" });
    res.end("canary");
  });
  canary.on("upgrade", (req, socket) => {
    hits.push(`UPGRADE ${req.url ?? "/"}`);
    socket.destroy();
  });
  canary.on("connection", () => {
    // a bare TCP connect with no request (a preconnect) is not a hit: it carries no data
  });

  const embedPage = (title: string) =>
    createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>${title}</title><p id="x">${title}-embed</p>`);
    });

  const appsRef = { host: "" };
  const apps = serveDir(path.join(dir, "apps"), () => ({
    "content-security-policy": appCsp(appsRef.host),
    "access-control-allow-origin": "*",
    "cross-origin-resource-policy": "cross-origin",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  }));
  // the host page itself: `/` is generated, `/page.js` is the bundle
  const host = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end('<!doctype html><html><head><meta charset="utf-8"><title>host</title></head><body><div id="root"></div><script type="module" src="/page.js"></script></body></html>');
      return;
    }
    if (url.pathname === "/same.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end('<!doctype html><title>same</title><p id="x">same-embed</p>');
      return;
    }
    const file = path.join(dir, "host", url.pathname);
    if (!file.startsWith(path.join(dir, "host")) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(readFileSync(file));
  });
  const legit = embedPage("legit");
  const other = embedPage("other");

  const [hostOrigin, appsOrigin, canaryOrigin, legitOrigin, otherOrigin] = await Promise.all([
    listen(host),
    listen(apps),
    listen(canary),
    listen(legit),
    listen(other),
  ]);
  appsRef.host = hostOrigin;

  return {
    host: hostOrigin,
    apps: appsOrigin,
    canary: canaryOrigin,
    legit: legitOrigin,
    other: otherOrigin,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        const all = [host, apps, canary, legit, other];
        let open = all.length;
        for (const server of all) {
          server.closeAllConnections();
          server.close(() => {
            open -= 1;
            if (open === 0) resolve();
          });
        }
      }),
  };
}
