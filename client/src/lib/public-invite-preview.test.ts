import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPublicInvitePreview, parsePublicInvitePreview } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchPublicInvitePreview", () => {
  it("reads #779's envelope, sends no auth header, and asks once per code", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          invite: { serverName: "Panelinha", iconUrl: null, memberCount: 7 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const first = await fetchPublicInvitePreview("abc");
    const second = await fetchPublicInvitePreview("abc");
    expect(first).toEqual({ serverName: "Panelinha", iconUrl: null, memberCount: 7 });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
  });

  it("is no preview on 404, 429 or a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    expect(await fetchPublicInvitePreview("gone")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429 })));
    expect(await fetchPublicInvitePreview("slow")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("offline");
    }));
    expect(await fetchPublicInvitePreview("down")).toBeNull();
  });
});

describe("parsePublicInvitePreview", () => {
  it("reads the #779 envelope", () => {
    expect(
      parsePublicInvitePreview({
        invite: { serverName: "Panelinha", iconUrl: "https://x/icon.png", memberCount: 12 },
      }),
    ).toEqual({ serverName: "Panelinha", iconUrl: "https://x/icon.png", memberCount: 12 });
  });

  it("is no preview for anything the shared schema refuses", () => {
    expect(parsePublicInvitePreview(null)).toBeNull();
    expect(parsePublicInvitePreview({ error: "not found" })).toBeNull();
    expect(parsePublicInvitePreview({ serverName: "bare, no envelope" })).toBeNull();
    expect(
      parsePublicInvitePreview({ invite: { serverName: "  ", iconUrl: null, memberCount: 1 } }),
    ).toBeNull();
    expect(
      parsePublicInvitePreview({ invite: { serverName: "A", iconUrl: null, memberCount: -1 } }),
    ).toBeNull();
  });
});
