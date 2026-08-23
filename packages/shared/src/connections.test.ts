import { describe, expect, it } from "vitest";
import {
  completeConnectionSchema,
  connectionCallbackPath,
  connectionProviderFromPath,
  connectionProviderSchema,
  ownConnectionSchema,
  visibleConnectionSchema,
} from "./connections.js";

describe("connectionProviderFromPath", () => {
  it("reads the three providers and nothing else", () => {
    expect(connectionProviderFromPath("/app/connections/callback/steam")).toBe(
      "steam",
    );
    expect(
      connectionProviderFromPath("/app/connections/callback/battlenet"),
    ).toBe("battlenet");
    expect(connectionProviderFromPath("/app/connections/callback/twitch")).toBe(
      "twitch",
    );
    expect(connectionProviderFromPath("/app/connections/callback/xbox")).toBeNull();
    expect(connectionProviderFromPath("/app/connections/callback/steam/extra")).toBeNull();
    expect(connectionProviderFromPath("/app/invite/abc")).toBeNull();
  });

  it("agrees with the path builder", () => {
    for (const provider of connectionProviderSchema.options) {
      expect(connectionProviderFromPath(connectionCallbackPath(provider))).toBe(
        provider,
      );
    }
  });
});

describe("completeConnectionSchema", () => {
  it("accepts a Steam-sized OpenID callback", () => {
    const parsed = completeConnectionSchema.safeParse({
      params: {
        "openid.mode": "id_res",
        "openid.claimed_id":
          "https://steamcommunity.com/openid/id/76561198000000000",
        state: "abc",
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a stuffed parameter map", () => {
    const params: Record<string, string> = {};
    for (let i = 0; i < 41; i += 1) {
      params[`k${i}`] = "v";
    }
    expect(completeConnectionSchema.safeParse({ params }).success).toBe(false);
  });
});

describe("visible vs own connection shapes", () => {
  it("refuses a javascript: profile URL", () => {
    const row = {
      provider: "steam" as const,
      displayName: "Alice",
      avatarUrl: null,
      profileUrl: "javascript:alert(1)",
    };
    expect(visibleConnectionSchema.safeParse(row).success).toBe(false);
  });

  it("keeps the provider user id off the public shape", () => {
    expect(Object.keys(visibleConnectionSchema.shape).sort()).toEqual([
      "avatarUrl",
      "displayName",
      "profileUrl",
      "provider",
    ]);
    expect(ownConnectionSchema.shape).toHaveProperty("providerUserId");
    expect(ownConnectionSchema.shape).toHaveProperty("visibility");
  });
});
