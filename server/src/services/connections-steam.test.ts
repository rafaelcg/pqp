import { afterEach, describe, expect, it, vi } from "vitest";
import {
  steamAuthorizeUrl,
  steamIdFromClaimedId,
  STEAM_OPENID_ENDPOINT,
  verifySteamAssertion,
  SteamAuthError,
} from "./connections-steam.js";

describe("steamIdFromClaimedId", () => {
  it("accepts Valve's documented claimed_id form", () => {
    expect(
      steamIdFromClaimedId(
        "https://steamcommunity.com/openid/id/76561198000000001",
      ),
    ).toBe("76561198000000001");
    expect(
      steamIdFromClaimedId(
        "http://steamcommunity.com/openid/id/76561197960265728",
      ),
    ).toBe("76561197960265728");
  });

  it("refuses a lookalike host or a short id", () => {
    expect(
      steamIdFromClaimedId(
        "https://evilsteamcommunity.com/openid/id/76561198000000001",
      ),
    ).toBeNull();
    expect(
      steamIdFromClaimedId("https://steamcommunity.com/openid/id/123"),
    ).toBeNull();
  });
});

describe("steamAuthorizeUrl", () => {
  it("points at Valve and carries return_to plus realm", () => {
    const url = new URL(
      steamAuthorizeUrl(
        "http://localhost:5173/app/connections/callback/steam?state=abc",
        "http://localhost:5173",
      ),
    );
    expect(url.origin + url.pathname).toBe(STEAM_OPENID_ENDPOINT);
    expect(url.searchParams.get("openid.mode")).toBe("checkid_setup");
    expect(url.searchParams.get("openid.return_to")).toContain("state=abc");
    expect(url.searchParams.get("openid.realm")).toBe("http://localhost:5173");
  });
});

describe("verifySteamAssertion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const validParams = {
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": STEAM_OPENID_ENDPOINT,
    "openid.claimed_id":
      "https://steamcommunity.com/openid/id/76561198000000001",
    "openid.identity":
      "https://steamcommunity.com/openid/id/76561198000000001",
    "openid.return_to":
      "http://localhost:5173/app/connections/callback/steam?state=abc",
    "openid.response_nonce": "2026-08-23T00:00:00Zunique",
    "openid.assoc_handle": "none",
    "openid.signed":
      "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": "aaaa",
  };

  it("POSTs check_authentication and returns the SteamID when valid", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      expect(body).toContain("openid.mode=check_authentication");
      expect(body).not.toContain("openid.mode=id_res");
      return new Response("ns:http://specs.openid.net/auth/2.0\nis_valid:true\n", {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      verifySteamAssertion(
        validParams,
        "http://localhost:5173/app/connections/callback/steam?state=abc",
      ),
    ).resolves.toBe("76561198000000001");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("refuses a return_to that is not the pending one", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      verifySteamAssertion(
        validParams,
        "https://attacker.example/app/connections/callback/steam?state=abc",
      ),
    ).rejects.toBeInstanceOf(SteamAuthError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses is_valid:false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("is_valid:false\n", { status: 200 })),
    );
    await expect(
      verifySteamAssertion(
        validParams,
        "http://localhost:5173/app/connections/callback/steam?state=abc",
      ),
    ).rejects.toBeInstanceOf(SteamAuthError);
  });
});
