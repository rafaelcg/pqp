import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, setAuthTokenProvider, setMemberVoiceMuted } from "./api";

/**
 * Regression coverage for the moderator "cannot un-mute" report: a server
 * owner server-muted a member as a joke, then every unmute attempt showed
 * "Network error reaching API." even though pqp's API was healthy the whole
 * time.
 *
 * `apiFetch` used to call Clerk's `getToken` (the token provider) inside the
 * same `try` block that turns a `TypeError` into "Network error reaching
 * API.". Clerk's own token refresh is a network call in its own right (a
 * session JWT lives about a minute), so a one-off blip reaching *Clerk*
 * threw the same `TypeError` a blip reaching *pqp* would, and got the same
 * misleading message — which is exactly what let a mute (issued on a still-
 * cached token) succeed and an unmute moments later (needing a refresh) fail
 * with a message that named the wrong service and gave the moderator nothing
 * to act on.
 */

let fetchSpy: ReturnType<typeof vi.fn>;

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  fetchSpy = vi.fn(async () => okResponse({ ok: true }));
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("apiFetch token-provider resilience", () => {
  it("retries a token fetch that throws once, and the unmute request still succeeds", async () => {
    const getToken = vi
      .fn()
      // The first call (mirrors Clerk's getToken during a live refresh)
      // throws a TypeError, same shape as a real network failure.
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce("fresh-token");
    setAuthTokenProvider(getToken);

    await expect(
      setMemberVoiceMuted("server-1", "user-1", false),
    ).resolves.toEqual({ ok: true });

    // One failed attempt, one retry that supplied a token, one actual
    // request to pqp's API carrying it.
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("names the session, not the API, when the token provider keeps failing", async () => {
    setAuthTokenProvider(async () => {
      throw new TypeError("Failed to fetch");
    });

    let caught: unknown;
    try {
      await setMemberVoiceMuted("server-1", "user-1", false);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).message).toContain("session");
    expect((caught as ApiError).message).not.toContain("Network error reaching API");
    // Never blamed on the API: the actual request never had to go out.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still reports a real network failure honestly once the token is fine", async () => {
    setAuthTokenProvider(async () => "fresh-token");
    fetchSpy.mockRejectedValue(new TypeError("Failed to fetch"));

    let caught: unknown;
    try {
      await setMemberVoiceMuted("server-1", "user-1", false);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).message).toContain("Network error reaching API");
  });
});
