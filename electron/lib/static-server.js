const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

/** CSP for locally served client builds (not applied to remote URLs). */
const LOCAL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' http: https: ws: wss:",
  "media-src 'self' blob: mediadevices:",
  "worker-src 'self' blob:",
  "frame-src 'self' https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

function contentType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent((urlPath || "/").split("?")[0]);
  const relative = decoded.replace(/^\/+/, "");
  const resolved = path.normalize(path.join(root, relative));
  if (!resolved.startsWith(root)) {
    return null;
  }
  return resolved;
}

/**
 * Serve a Vite (or similar) SPA from disk on 127.0.0.1 so absolute `/assets`
 * paths work without changing the client's `base`.
 */
function startStaticServer(rootDir) {
  const root = path.resolve(rootDir);

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const target = safeJoin(root, req.url ?? "/");
      if (!target) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      let filePath = target;
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        const asIndex = path.join(filePath, "index.html");
        if (fs.existsSync(asIndex)) {
          filePath = asIndex;
        } else {
          filePath = path.join(root, "index.html");
        }
      }

      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      res.writeHead(200, {
        "Content-Type": contentType(filePath),
        "Content-Security-Policy": LOCAL_CSP,
        "X-Content-Type-Options": "nosniff",
      });
      fs.createReadStream(filePath).pipe(res);
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((resClose) => {
            server.close(() => resClose());
          }),
      });
    });
  });
}

module.exports = {
  LOCAL_CSP,
  startStaticServer,
};
