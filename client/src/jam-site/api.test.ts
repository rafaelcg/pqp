import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJam, fetchJamList, normaliseSong, resolveApiUrl } from "./api";

const API = "https://api.pqp.gg";

const song = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  title: "Minuano",
  coverUrl: null,
  startedBy: { name: "Leco", handle: "leco", avatarUrl: "/api/avatars/u1" },
  origin: { name: "Garagem", iconUrl: "/api/servers/x/icon", slug: null },
  parts: [
    { instrument: "drums", hasVideo: false, person: { name: "Zeca", handle: null, avatarUrl: "/api/avatars/u2" } },
    { instrument: "bass", hasVideo: false, person: { name: "Nanda", handle: null, avatarUrl: "https://img.clerk.com/n.png" } },
    { instrument: "keys", hasVideo: false, person: { name: "Gui", handle: null, avatarUrl: null } },
  ],
  needs: [],
  ...over,
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("resolveApiUrl", () => {
  it("points a root-relative API path at the API origin, because the site is another origin", () => {
    expect(resolveApiUrl("/api/avatars/u1", API)).toBe("https://api.pqp.gg/api/avatars/u1");
    expect(resolveApiUrl("/api/avatars/u1", `${API}/`)).toBe("https://api.pqp.gg/api/avatars/u1");
  });

  it("leaves an absolute address, a protocol-relative one and nothing as they are", () => {
    expect(resolveApiUrl("https://img.clerk.com/a.png", API)).toBe("https://img.clerk.com/a.png");
    expect(resolveApiUrl("//cdn.example/a.png", API)).toBe("//cdn.example/a.png");
    expect(resolveApiUrl(null, API)).toBeNull();
    expect(resolveApiUrl(undefined, API)).toBeUndefined();
  });

  it("is a no-op when the API is the same origin (no base)", () => {
    expect(resolveApiUrl("/api/avatars/u1", "")).toBe("/api/avatars/u1");
  });
});

describe("what the public routes return", () => {
  it("resolves every person's picture, the origin icon and the cover on a song", () => {
    vi.stubEnv("VITE_API_URL", API);
    const out = normaliseSong(song({ coverUrl: "/api/covers/c1" }));
    expect(out.parts.map((part) => part.person.avatarUrl)).toEqual([
      "https://api.pqp.gg/api/avatars/u2",
      "https://img.clerk.com/n.png",
      null,
    ]);
    expect(out.startedBy.avatarUrl).toBe("https://api.pqp.gg/api/avatars/u1");
    expect(out.origin?.iconUrl).toBe("https://api.pqp.gg/api/servers/x/icon");
    expect(out.coverUrl).toBe("https://api.pqp.gg/api/covers/c1");
  });

  it("does it for a list and for a song's tracks, so the mosaic's faces load on jam.pqp.gg", async () => {
    vi.stubEnv("VITE_API_URL", API);
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        const body = url.includes("/api/public/jams/s1")
          ? {
              song: song(),
              tracks: [
                {
                  id: "t1",
                  audioUrl: "https://bucket/a.mp3",
                  instrument: "drums",
                  person: { name: "Zeca", handle: null, avatarUrl: "/api/avatars/u2" },
                },
              ],
              mediaExpiresAt: "2030-01-01T00:00:00Z",
            }
          : { songs: [song()], nextCursor: null };
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const list = await fetchJamList({});
    expect(list.songs[0]!.parts[0]!.person.avatarUrl).toBe("https://api.pqp.gg/api/avatars/u2");
    const detail = await fetchJam("s1");
    expect(detail.tracks[0]!.person.avatarUrl).toBe("https://api.pqp.gg/api/avatars/u2");
    expect(calls.every((url) => url.startsWith(API))).toBe(true);
  });
});
