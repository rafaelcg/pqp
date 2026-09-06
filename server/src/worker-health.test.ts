import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("./db.js", () => ({
  getPool: () => ({ query }),
}));

import { createWorkerHealthServer } from "./worker-health.js";

describe("worker /health", () => {
  let server: ReturnType<typeof createWorkerHealthServer>;
  let base: string;

  beforeEach(async () => {
    query.mockReset();
    server = createWorkerHealthServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  it("answers 200 with the role and the deployed commit when the DB is up", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.role).toBe("worker");
    expect(typeof body.version).toBe("string");
    expect(query).toHaveBeenCalledWith("SELECT 1");
  });

  it("answers 503 when the pool cannot reach Postgres", async () => {
    query.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.role).toBe("worker");
  });

  it("serves nothing else: no /api, no /ws, no SPA", async () => {
    for (const path of ["/", "/api/servers", "/ws", "/status.json", "/up"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(404);
    }
    expect(query).not.toHaveBeenCalled();
  });
});
