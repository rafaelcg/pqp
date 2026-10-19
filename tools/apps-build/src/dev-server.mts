import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { headersFor, parseHeaders } from "./headers.mts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function listing(root: string): string {
  const rows: string[] = [];
  if (existsSync(root)) {
    for (const id of readdirSync(root).sort()) {
      const folder = join(root, id);
      if (id.startsWith("_") || !statSync(folder).isDirectory()) continue;
      for (const version of readdirSync(folder).sort()) {
        rows.push(`<li><a href="/${id}/${version}/index.html">${id} ${version}</a></li>`);
      }
    }
  }
  return `<!doctype html><meta charset="utf-8"><title>pqp apps (dev)</title><h1>pqp apps (dev)</h1><ul>${rows.join("")}</ul>`;
}

/**
 * Serves the built `dist-apps` folder the way the apps origin will: the same
 * `_headers` rules, read on every request so a rebuild is picked up. The one
 * deliberate difference is `Cache-Control: no-store`, because a dev rebuild
 * keeps the version and an immutable year would pin the old bytes in the browser.
 */
export function startDevServer(root: string, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = decodeURIComponent(url.pathname);
    const headersFile = join(root, "_headers");
    const rules = existsSync(headersFile) ? parseHeaders(readFileSync(headersFile, "utf8")) : [];

    const send = (status: number, body: string | Buffer, type: string, extra?: Map<string, string>) => {
      const headers: Record<string, string> = { "content-type": type, "cache-control": "no-store" };
      for (const [name, value] of extra ?? []) if (name !== "cache-control") headers[name] = value;
      res.writeHead(status, headers);
      res.end(req.method === "HEAD" ? undefined : body);
    };

    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "method not allowed", "text/plain");
    if (path === "/") return send(200, listing(root), TYPES[".html"]!);

    const file = normalize(join(root, path));
    if (!file.startsWith(root + sep) || file.endsWith(`${sep}_headers`)) return send(404, "not found", "text/plain");
    if (!existsSync(file) || !statSync(file).isFile()) return send(404, "not found", "text/plain");
    return send(200, readFileSync(file), TYPES[extname(file)] ?? "application/octet-stream", headersFor(rules, path));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
