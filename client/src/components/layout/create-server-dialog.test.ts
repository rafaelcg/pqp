import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { discordImportErrorKey } from "./create-server-dialog";

const FALLBACK = "importDiscord.error.previewFailed" as const;

describe("discordImportErrorKey", () => {
  it("picks the key from the server's code, never its English sentence", () => {
    const error = new ApiError(400, "That is a Discord invite link.", null, {
      error: "That is a Discord invite link.",
      code: "inviteLink",
    });
    expect(discordImportErrorKey(error, FALLBACK)).toBe(
      "importDiscord.error.inviteLink",
    );
  });

  it("falls back on the status when the server sent no code", () => {
    expect(discordImportErrorKey(new ApiError(404, "No template"), FALLBACK)).toBe(
      "importDiscord.error.notFound",
    );
    expect(discordImportErrorKey(new ApiError(429, "Slow down"), FALLBACK)).toBe(
      "importDiscord.error.rateLimited",
    );
  });

  it("uses the fallback for anything else", () => {
    expect(discordImportErrorKey(new ApiError(0, "Network"), FALLBACK)).toBe(
      FALLBACK,
    );
    expect(discordImportErrorKey(new Error("boom"), FALLBACK)).toBe(FALLBACK);
    expect(
      discordImportErrorKey(
        new ApiError(400, "x", null, { code: "somethingNew" }),
        FALLBACK,
      ),
    ).toBe("importDiscord.error.notATemplate");
  });
});
