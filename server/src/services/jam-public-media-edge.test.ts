import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jamPublicMediaSecret, jamPublicMediaUrl, openJamPublicMediaUrl } from "./jam-public-media.js";

/**
 * The edge Worker (tools/jam-media-edge) opens the URLs this file's subject
 * mints. Two codebases, two crypto backends (node:crypto here, Web Crypto
 * there), one contract. `tools/jam-media-edge/test/golden.json` is a URL set
 * minted by `jamPublicMediaUrl` itself; the Worker's test opens every one of
 * them, and this test fails the moment the mint stops producing exactly them.
 * Change the scheme here and one of the two fails, so neither side can drift
 * alone. To regenerate after a deliberate change, mint the three keys below at
 * `mintedAtMs` with the clerk key named in the file and paste the result.
 */
type Golden = {
  clerkSecretKey: string;
  mintedAtMs: number;
  urls: Record<string, { key: string; url: string }>;
};

const golden = JSON.parse(
  readFileSync(new URL("../../../tools/jam-media-edge/test/golden.json", import.meta.url), "utf8"),
) as Golden;

describe("jam public media URLs match the edge Worker's golden vector", () => {
  const saved = {
    clerk: process.env.CLERK_SECRET_KEY,
    bypass: process.env.DEV_AUTH_BYPASS,
    base: process.env.JAM_PUBLIC_MEDIA_BASE_URL,
  };

  beforeEach(() => {
    process.env.CLERK_SECRET_KEY = golden.clerkSecretKey;
    delete process.env.DEV_AUTH_BYPASS;
    process.env.JAM_PUBLIC_MEDIA_BASE_URL = "https://jam-media.example.test";
  });

  afterEach(() => {
    for (const [name, value] of [
      ["CLERK_SECRET_KEY", saved.clerk],
      ["DEV_AUTH_BYPASS", saved.bypass],
      ["JAM_PUBLIC_MEDIA_BASE_URL", saved.base],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it("derives the secret the Worker is given: HMAC-SHA256(clerk key, label), base64url", () => {
    expect(jamPublicMediaSecret()).toBe(
      createHmac("sha256", golden.clerkSecretKey).update("pqp-jam-public-media").digest("base64url"),
    );
  });

  it("mints exactly the golden URLs, and opens them back to the same keys", () => {
    for (const { key, url } of Object.values(golden.urls)) {
      expect(jamPublicMediaUrl(key, golden.mintedAtMs)).toBe(url);
      const parsed = new URL(url);
      expect(parsed.pathname.startsWith("/jam-media/")).toBe(true);
      expect(
        openJamPublicMediaUrl(
          parsed.pathname.slice("/jam-media/".length),
          parsed.searchParams.get("e"),
          parsed.searchParams.get("s"),
          golden.mintedAtMs,
        ),
      ).toEqual({ key });
    }
  });
});
