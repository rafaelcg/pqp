import { describe, expect, it } from "vitest";
import { currentRoute, runWithRoute } from "./route-context.js";

describe("route-context", () => {
  it("answers 'other' with nothing running", () => {
    expect(currentRoute()).toBe("other");
  });

  it("carries the route label through the async call inside runWithRoute", async () => {
    await runWithRoute("GET /api/servers/:serverId/members", async () => {
      await Promise.resolve();
      expect(currentRoute()).toBe("GET /api/servers/:serverId/members");
    });
  });

  it("does not leak the route label after the call returns", async () => {
    await runWithRoute("GET /api/me", async () => {});
    expect(currentRoute()).toBe("other");
  });

  it("keeps two concurrent calls on their own route label", async () => {
    const seen: string[] = [];
    await Promise.all([
      runWithRoute("GET /api/a", async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        seen.push(currentRoute());
      }),
      runWithRoute("GET /api/b", async () => {
        seen.push(currentRoute());
      }),
    ]);
    expect(seen.sort()).toEqual(["GET /api/a", "GET /api/b"]);
  });
});
