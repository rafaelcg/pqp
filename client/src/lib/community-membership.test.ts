import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupCommunityMembership } from "./api";

/**
 * The membership read the public Baú post page makes for a signed-in visitor.
 * It sends the token it is GIVEN (the app's provider is not installed on a
 * public page) and answers null for every failure, so the page falls back to
 * the join button instead of guessing.
 */
describe("lookupCommunityMembership", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the token it was given and reads id and joined", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ community: { id: "srv-1", joined: true } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const found = await lookupCommunityMembership("mesa", async () => "tok");
    expect(found).toEqual({ serverId: "srv-1", joined: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/communities/by-slug/mesa");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("is not joined unless the API says exactly true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ community: { id: "srv-1", joined: "yes" } })),
    );
    expect(await lookupCommunityMembership("mesa", async () => "tok")).toEqual({
      serverId: "srv-1",
      joined: false,
    });
  });

  it("asks nothing without a token, and answers null on every failure", async () => {
    const fetchMock = vi.fn(async () => new Response("no", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await lookupCommunityMembership("mesa", async () => null)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await lookupCommunityMembership("mesa", async () => "tok")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ community: {} })));
    expect(await lookupCommunityMembership("mesa", async () => "tok")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    expect(await lookupCommunityMembership("mesa", async () => "tok")).toBeNull();
    expect(
      await lookupCommunityMembership("mesa", async () => {
        throw new Error("clerk down");
      }),
    ).toBeNull();
  });
});
