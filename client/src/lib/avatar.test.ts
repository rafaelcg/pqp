import { SERVER_BANNER_HEIGHT, SERVER_BANNER_WIDTH } from "@pqp/shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  getApiBaseUrl: () => "https://api.example.test",
}));

const { centerCropRect, centerCropRectForAspect, resolveAvatarUrl } =
  await import("./avatar");

/**
 * The two pieces of avatar handling that are logic rather than markup.
 *
 * `resolveAvatarUrl` is the only place a string an account holder typed
 * becomes an `<img src>`, and the only place the split-origin deploy — the SPA
 * on Pages, the API on Railway — is reconciled. `centerCropRect` is arithmetic
 * whose failures are silent: a transposed pair crops a portrait photo to
 * somebody's forehead and still renders a perfectly plausible square.
 */

describe("resolveAvatarUrl", () => {
  it("prefixes the API origin onto this server's own avatar path", () => {
    // The server cannot know its public origin, so it emits a root-relative
    // path; without this the SPA on Pages would ask Pages for the image.
    expect(resolveAvatarUrl("/api/avatars/abc?v=deadbeef")).toBe(
      "https://api.example.test/api/avatars/abc?v=deadbeef",
    );
  });

  it("passes an https URL through — presets and typed links", () => {
    expect(resolveAvatarUrl("https://cdn.example.com/a.png")).toBe(
      "https://cdn.example.com/a.png",
    );
  });

  it("refuses http, which is a blocked mixed-content request anyway", () => {
    expect(resolveAvatarUrl("http://cdn.example.com/a.png")).toBeNull();
  });

  it("refuses javascript: and data:, which is why the check is an allowlist", () => {
    expect(resolveAvatarUrl("javascript:alert(1)")).toBeNull();
    expect(resolveAvatarUrl("data:image/svg+xml,<svg onload=alert(1)>")).toBeNull();
  });

  it("refuses a protocol-relative URL, which inherits the page's scheme", () => {
    expect(resolveAvatarUrl("//evil.example.com/a.png")).toBe(
      // It starts with "/", so it is treated as root-relative and pinned to the
      // API origin — which is the safe reading. It is emphatically not handed
      // to the browser as a scheme-inheriting reference to another host.
      "https://api.example.test//evil.example.com/a.png",
    );
  });

  it("refuses a bare hostname or garbage", () => {
    expect(resolveAvatarUrl("cdn.example.com/a.png")).toBeNull();
    expect(resolveAvatarUrl("not a url")).toBeNull();
  });

  it("treats null, undefined and empty as no avatar", () => {
    expect(resolveAvatarUrl(null)).toBeNull();
    expect(resolveAvatarUrl(undefined)).toBeNull();
    expect(resolveAvatarUrl("")).toBeNull();
  });
});

describe("centerCropRect", () => {
  it("takes the whole image when it is already square", () => {
    expect(centerCropRect(512, 512)).toEqual({ x: 0, y: 0, size: 512 });
  });

  it("crops the sides of a landscape image", () => {
    expect(centerCropRect(1600, 900)).toEqual({ x: 350, y: 0, size: 900 });
  });

  it("crops the top and bottom of a portrait image", () => {
    // The common case: a phone photo. Getting the axes the wrong way round here
    // is what crops a face down to a forehead.
    expect(centerCropRect(1080, 1920)).toEqual({ x: 0, y: 420, size: 1080 });
  });

  it("rounds an odd offset rather than emitting a fractional pixel", () => {
    expect(centerCropRect(101, 100)).toEqual({ x: 1, y: 0, size: 100 });
  });

  it("never crops outside the source", () => {
    for (const [width, height] of [
      [1, 4000],
      [4000, 1],
      [3, 2],
      [2, 3],
    ]) {
      const crop = centerCropRect(width!, height!);
      expect(crop.x + crop.size).toBeLessThanOrEqual(width!);
      expect(crop.y + crop.size).toBeLessThanOrEqual(height!);
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.y).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("centerCropRectForAspect", () => {
  const BANNER = SERVER_BANNER_WIDTH / SERVER_BANNER_HEIGHT;

  it("takes the whole image when it is already the target shape", () => {
    expect(
      centerCropRectForAspect(
        SERVER_BANNER_WIDTH,
        SERVER_BANNER_HEIGHT,
        BANNER,
      ),
    ).toEqual({
      x: 0,
      y: 0,
      width: SERVER_BANNER_WIDTH,
      height: SERVER_BANNER_HEIGHT,
    });
  });

  it("crops the sides of an image wider than the target", () => {
    // 4000×480 is far wider than the channel-column band, so the height
    // survives untouched.
    const crop = centerCropRectForAspect(4000, SERVER_BANNER_HEIGHT, BANNER);
    expect(crop.height).toBe(SERVER_BANNER_HEIGHT);
    expect(crop.width).toBe(SERVER_BANNER_WIDTH);
    expect(crop.x).toBe(1488);
    expect(crop.y).toBe(0);
  });

  it("crops the top and bottom of a portrait photo", () => {
    // The common case, and the one that goes silently wrong: pick the branch
    // the wrong way round and a phone photo becomes a strip of forehead.
    const crop = centerCropRectForAspect(1080, 1920, BANNER);
    expect(crop.width).toBe(1080);
    expect(crop.height).toBe(506);
    expect(crop.x).toBe(0);
    expect(crop.y).toBe(707);
  });

  it("degenerates to centerCropRect at an aspect of 1", () => {
    // Not an accident worth losing: the square crop is this function with one
    // argument fixed, and the two must not drift apart.
    for (const [width, height] of [
      [1600, 900],
      [1080, 1920],
      [512, 512],
      [101, 100],
    ]) {
      const square = centerCropRect(width!, height!);
      const rect = centerCropRectForAspect(width!, height!, 1);
      expect({ x: rect.x, y: rect.y, size: rect.width }).toEqual(square);
      expect(rect.width).toBe(rect.height);
    }
  });

  it("never crops outside the source, at any shape", () => {
    for (const [width, height] of [
      [1, 4000],
      [4000, 1],
      [3, 2],
      [2, 3],
      [1024, 361],
    ]) {
      for (const aspect of [BANNER, 1, 16 / 9, 0.5]) {
        const crop = centerCropRectForAspect(width!, height!, aspect);
        expect(crop.x).toBeGreaterThanOrEqual(0);
        expect(crop.y).toBeGreaterThanOrEqual(0);
        expect(crop.x + crop.width).toBeLessThanOrEqual(width!);
        expect(crop.y + crop.height).toBeLessThanOrEqual(height!);
      }
    }
  });
});
