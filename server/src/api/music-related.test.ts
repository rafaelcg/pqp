import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
  actor: { id: "11111111-1111-4111-8111-111111111111", clerk_id: "clerk_music" },
  relatedMusicTracks: vi.fn(),
}));

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  forgetAuthUser: () => {},
  deleteClerkUser: async () => {},
  resolveAuthUser: async () => ({ user: stubs.actor }),
  resolveAuthSession: async () => ({ user: stubs.actor, ageGate: "passed" as const }),
  verifyAuthHeader: async () => null,
}));

vi.mock("../services/music.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/music.js")>();
  return {
    ...actual,
    relatedMusicTracks: (...args: unknown[]) => stubs.relatedMusicTracks(...args),
  };
});

const { handleApi, resetApiRateLimits } = await import("./index.js");

describe("GET /api/music/related", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => server.listen(0, done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  afterEach(() => {
    resetApiRateLimits();
    stubs.relatedMusicTracks.mockReset();
  });

  async function call(path: string) {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: "Bearer test" },
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {} };
  }

  it("returns InnerTube-mapped tracks", async () => {
    stubs.relatedMusicTracks.mockResolvedValue([
      {
        provider: "youtube",
        videoId: "relWeb00001",
        title: "Parecida",
        sourceUrl: null,
        thumbnailUrl: null,
        durationMs: 180_000,
      },
    ]);
    const res = await call("/api/music/related?videoId=dQw4w9WgXcQ");
    expect(res.status).toBe(200);
    expect(res.body.tracks).toHaveLength(1);
    expect(res.body.tracks[0].title).toBe("Parecida");
    expect(stubs.relatedMusicTracks).toHaveBeenCalledWith("dQw4w9WgXcQ");
  });

  it("answers 400 when videoId is missing or the wrong shape", async () => {
    expect((await call("/api/music/related")).status).toBe(400);
    expect((await call("/api/music/related?videoId=short")).status).toBe(400);
    expect(stubs.relatedMusicTracks).not.toHaveBeenCalled();
  });

  it("answers 404 when nothing is related", async () => {
    const { MusicResolveError } = await import("../services/music.js");
    stubs.relatedMusicTracks.mockRejectedValue(
      new MusicResolveError("not_found", "No related videos"),
    );
    const res = await call("/api/music/related?videoId=dQw4w9WgXcQ");
    expect(res.status).toBe(404);
  });

  it("answers 502 when InnerTube is down", async () => {
    const { MusicResolveError } = await import("../services/music.js");
    stubs.relatedMusicTracks.mockRejectedValue(
      new MusicResolveError("upstream", "next answered 500"),
    );
    const res = await call("/api/music/related?videoId=dQw4w9WgXcQ");
    expect(res.status).toBe(502);
  });
});
