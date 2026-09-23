/**
 * The smallest S3 that the playlist proxy and a browser need: path-style
 * GETs of `/<bucket>/<key>` served from a directory, signatures ignored,
 * CORS open. The API reads the playlist through it; the browser fetches the
 * presigned segment URLs from it. No Postgres anywhere on this path, which
 * is the point: storage keeps working through a database outage.
 */
import http from "node:http";
import { createReadStream, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";

const TYPES = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".m4s": "video/iso.segment",
  ".mp4": "video/mp4",
};

export function startFakeS3({ port, root, bucket }) {
  const server = http.createServer((req, res) => {
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const prefix = `/${bucket}/`;
    if (!path.startsWith(prefix)) {
      res.writeHead(404, headers);
      res.end();
      return;
    }
    const file = normalize(join(root, path.slice(prefix.length)));
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) {
      res.writeHead(403, headers);
      res.end();
      return;
    }
    let size;
    try {
      size = statSync(file).size;
    } catch {
      res.writeHead(404, headers);
      res.end();
      return;
    }
    const ext = file.slice(file.lastIndexOf("."));
    res.writeHead(200, {
      ...headers,
      "Content-Type": TYPES[ext] ?? "application/octet-stream",
      "Content-Length": String(size),
      "Cache-Control": "no-store",
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () =>
      resolve({ stop: () => new Promise((done) => server.close(() => done())) }),
    ),
  );
}
