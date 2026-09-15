import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
  actor: { id: "11111111-1111-4111-8111-111111111111", clerk_id: "clerk_music" },
  searchMusicCandidates: vi.fn(),
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
    searchMusicCandidates: (...args: unknown[]) => stubs.searchMusicCandidates(...args),
  };
});

const { handleApi, resetApiRateLimits } = await import("./index.js");

describe("GET /api/music/search", () => {
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
    stubs.searchMusicCandidates.mockReset();
  });

  async function call(path: string) {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: "Bearer test" },
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {} };
  }

  it("returns InnerTube-mapped tracks", async () => {
    stubs.searchMusicCandidates.mockResolvedValue([
      {
        provider: "youtube",
        videoId: "aaaaaaaaaaa",
        title: "Hit",
        sourceUrl: null,
        thumbnailUrl: null,
        durationMs: 120_000,
      },
    ]);
    const res = await call("/api/music/search?q=legia");
    expect(res.status).toBe(200);
    expect(res.body.tracks).toHaveLength(1);
    expect(res.body.tracks[0].title).toBe("Hit");
    expect(stubs.searchMusicCandidates).toHaveBeenCalledWith("legia");
  });

  it("keeps ã and ç in the JSON body", async () => {
    stubs.searchMusicCandidates.mockResolvedValue([
      {
        provider: "youtube",
        videoId: "bbbbbbbbbbb",
        title: "Canção da Legião",
        sourceUrl: null,
        thumbnailUrl: null,
        durationMs: 180_000,
      },
    ]);
    const response = await fetch(`${baseUrl}/api/music/search?q=cancao`, {
      headers: { Authorization: "Bearer test" },
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("Canção da Legião");
    expect(JSON.parse(text).tracks[0].title).toBe("Canção da Legião");
  });

  it("answers 400 when q is missing", async () => {
    const res = await call("/api/music/search");
    expect(res.status).toBe(400);
    expect(stubs.searchMusicCandidates).not.toHaveBeenCalled();
  });

  it("answers 404 when nothing is found", async () => {
    const { MusicResolveError } = await import("../services/music.js");
    stubs.searchMusicCandidates.mockRejectedValue(
      new MusicResolveError("not_found", "Nothing on YouTube for \"x\""),
    );
    const res = await call("/api/music/search?q=x");
    expect(res.status).toBe(404);
  });
});
