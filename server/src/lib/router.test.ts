import { describe, expect, it } from "vitest";
import { HttpError } from "./http.js";
import { createRouter } from "./router.js";

const UUID = "11111111-2222-4333-8444-555555555555";
const OTHER_UUID = "99999999-8888-4777-8666-555555555555";

function build() {
  const router = createRouter();
  const noop = async () => ({ ok: true });
  router.get("/api/servers", noop);
  router.post("/api/servers", noop);
  router.get("/api/servers/:serverId/members", noop);
  router.delete("/api/servers/:serverId/members/:userId", noop);
  router.get("/api/invites/:code", noop);
  return router;
}

describe("createRouter", () => {
  it("matches a static path for the right method", () => {
    const router = build();
    expect(router.match("GET", "/api/servers")).not.toBeNull();
  });

  it("extracts params", () => {
    const router = build();
    const matched = router.match(
      "DELETE",
      `/api/servers/${UUID}/members/${OTHER_UUID}`,
    );
    expect(matched?.params).toEqual({ serverId: UUID, userId: OTHER_UUID });
  });

  it("returns null for an unknown path", () => {
    const router = build();
    expect(router.match("GET", "/api/nope")).toBeNull();
  });

  it("reports 405 when the path exists under another method", () => {
    const router = build();
    expect(() => router.match("PATCH", "/api/servers")).toThrowError(HttpError);
    try {
      router.match("PATCH", "/api/servers");
    } catch (error) {
      expect((error as HttpError).status).toBe(405);
    }
  });

  it("rejects a non-UUID id param with 404 instead of passing it to Postgres", () => {
    const router = build();
    try {
      router.match("GET", "/api/servers/not-a-uuid/members");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(404);
    }
  });

  it("allows non-id params to be arbitrary strings", () => {
    const router = build();
    const matched = router.match("GET", "/api/invites/aB3-x_9");
    expect(matched?.params.code).toBe("aB3-x_9");
  });

  it("decodes percent-encoded params", () => {
    const router = build();
    const matched = router.match("GET", "/api/invites/a%20b");
    expect(matched?.params.code).toBe("a b");
  });

  it("does not let a param swallow a path separator", () => {
    const router = build();
    expect(
      router.match("DELETE", `/api/servers/${UUID}/members/${OTHER_UUID}/extra`),
    ).toBeNull();
    expect(router.match("GET", `/api/servers/${UUID}`)).toBeNull();
  });
});
