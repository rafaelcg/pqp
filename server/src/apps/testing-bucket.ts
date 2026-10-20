import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The smallest S3 a presigned PUT, GET, HEAD and DELETE need, for tests and a
 * local checkout without MinIO: path-style `/<bucket>/<key>`, objects in
 * memory, signatures ignored (so the length signed into a PUT is NOT checked
 * here; the commit's HEAD is what the tests lean on), CORS open. Test support
 * only: excluded from the build like the other `testing*` files.
 */
export interface TestBucket {
  readonly endpoint: string;
  readonly bucket: string;
  readonly objects: Map<string, { body: Buffer; contentType: string }>;
  /** Point `S3_*` at this bucket. */
  configure(): void;
  close(): Promise<void>;
}

export async function startTestBucket(bucket = "test-bucket", port = 0): Promise<TestBucket> {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const server = http.createServer((req, res) => {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET, PUT, HEAD, DELETE",
      "Access-Control-Expose-Headers": "ETag, Content-Length",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://bucket");
    const prefix = `/${bucket}/`;
    if (!url.pathname.startsWith(prefix)) {
      res.writeHead(404, cors);
      res.end();
      return;
    }
    const key = decodeURIComponent(url.pathname.slice(prefix.length));
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        objects.set(key, { body, contentType: String(req.headers["content-type"] ?? "application/octet-stream") });
        res.writeHead(200, { ...cors, ETag: '"x"' });
        res.end();
      });
      return;
    }
    const found = objects.get(key);
    if (req.method === "DELETE") {
      objects.delete(key);
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (!found) {
      res.writeHead(404, cors);
      res.end();
      return;
    }
    res.writeHead(200, { ...cors, "Content-Type": found.contentType, "Content-Length": String(found.body.length) });
    res.end(req.method === "HEAD" ? undefined : found.body);
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    endpoint,
    bucket,
    objects,
    configure() {
      process.env.S3_ENDPOINT = endpoint;
      process.env.S3_BUCKET = bucket;
      process.env.S3_REGION = "auto";
      process.env.S3_ACCESS_KEY_ID = "test";
      process.env.S3_SECRET_ACCESS_KEY = "test-secret";
      process.env.S3_FORCE_PATH_STYLE = "true";
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
