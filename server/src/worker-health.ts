import { createServer, type Server } from "node:http";
import { getPool } from "./db.js";
import { SECURITY_HEADERS } from "./lib/http.js";

/**
 * The worker's only listener. No `/api`, no `/ws`, no static files: a request
 * for anything but `/health` is a 404, so a mis-pointed hostname fails loudly
 * instead of serving half a product.
 *
 * `/health` mirrors the API's: 200 with the deployed commit when the pool can
 * run `SELECT 1`, 503 otherwise, so Fly's check restarts a worker whose pool
 * is dead the same way it restarts the API. `role` is in the body so a person
 * curling the wrong app finds out in one line.
 */
export function createWorkerHealthServer(): Server {
  return createServer((req, res) => {
    void (async () => {
      const pathname = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      ).pathname;
      const headers = {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...SECURITY_HEADERS,
      };
      if (pathname !== "/health") {
        res.writeHead(404, headers);
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      try {
        await getPool().query("SELECT 1");
        res.writeHead(200, headers);
        res.end(
          JSON.stringify({
            ok: true,
            role: "worker",
            version: process.env.APP_VERSION ?? "dev",
          }),
        );
      } catch {
        res.writeHead(503, headers);
        res.end(
          JSON.stringify({
            ok: false,
            role: "worker",
            error: "database unavailable",
          }),
        );
      }
    })().catch((error) => {
      console.error("[worker] health request failed:", error);
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
  });
}
