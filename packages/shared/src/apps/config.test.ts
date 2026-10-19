import { describe, expect, it } from "vitest";
import { APP_UNAVAILABLE_REASONS, appsConfigSchema } from "./config.js";

const entry = {
  id: "pqp-eco",
  version: "1.0.0",
  category: "tool",
  icon: "sparkles",
  name: "name",
  description: "description",
  presence: { phrase: "presence.phrase", short: "presence.short" },
  channelTypes: ["text", "voice"],
  players: { min: 1, max: 8, spectators: true, maxSpectators: 50 },
  capabilities: {
    identity: "display",
    share: "none",
    localFiles: { allowed: false },
    peer: "none",
  },
  content: { userText: false, userImages: false },
  hostBound: false,
  i18n: { en: { name: "Eco" } },
  entry: { url: "https://apps.example.test/pqp-eco/1.0.0/index.html" },
  available: true,
  reason: null,
  shareAllowed: true,
};

describe("appsConfigSchema", () => {
  it("parses the disabled answer", () => {
    expect(appsConfigSchema.parse({ enabled: false, origin: null, apps: [] })).toEqual({
      enabled: false,
      origin: null,
      apps: [],
    });
  });

  it("parses an app, defaulting assets and stripping what a newer server adds", () => {
    const parsed = appsConfigSchema.parse({
      enabled: true,
      origin: "https://apps.example.test",
      apps: [{ ...entry, somethingNew: 1 }],
    });
    expect(parsed.apps[0]!.assets).toEqual([]);
    expect("somethingNew" in parsed.apps[0]!).toBe(false);
  });

  it("accepts every reason and null, and refuses an unknown one", () => {
    for (const reason of [...APP_UNAVAILABLE_REASONS, null]) {
      expect(
        appsConfigSchema.safeParse({
          enabled: true,
          origin: null,
          apps: [{ ...entry, available: reason === null, reason }],
        }).success,
        String(reason),
      ).toBe(true);
    }
    expect(
      appsConfigSchema.safeParse({
        enabled: true,
        origin: null,
        apps: [{ ...entry, available: false, reason: "because" }],
      }).success,
    ).toBe(false);
  });

  it("lets the entry URL be null while there is no apps origin", () => {
    expect(
      appsConfigSchema.safeParse({
        enabled: true,
        origin: null,
        apps: [{ ...entry, available: false, reason: "no-origin", entry: { url: null } }],
      }).success,
    ).toBe(true);
  });
});
