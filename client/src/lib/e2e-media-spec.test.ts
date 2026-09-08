import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config from "../../playwright.config";
import { MEDIA_SPEC } from "../../e2e/media-spec";

const e2eDir = join(dirname(fileURLToPath(import.meta.url)), "../../e2e");

/** Adding a spec makes this list fail so CI asks which bucket it belongs in. */
const MEDIA_FILES = [
  "call-split-layout.spec.ts",
  "call-stage-strip.spec.ts",
  "camera-stage.spec.ts",
  "dm-call-screen-share.spec.ts",
  "dm-call-video-stage.spec.ts",
  "dm-call.spec.ts",
  "outbound-readout.spec.ts",
  "profile-popover-call.spec.ts",
  "push-to-talk.spec.ts",
  "screen-quality-received.spec.ts",
  "screen-reshare.spec.ts",
  "screen-share-fullscreen.spec.ts",
  "screen-share-system-audio.spec.ts",
  "share-cursor.spec.ts",
  "video-quality.spec.ts",
  "viewer-video-quality.spec.ts",
  "voice-channel-slow-mode.spec.ts",
  "voice-lobby.spec.ts",
  "voice-state-badges.spec.ts",
] as const;

function project(name: string) {
  const found = config.projects?.find((entry) => entry.name === name);
  expect(found, name).toBeTruthy();
  return found!;
}

function regexes(value: unknown): RegExp[] {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  return list.filter((entry): entry is RegExp => entry instanceof RegExp);
}

describe("e2e media project split", () => {
  const specs = readdirSync(e2eDir).filter((name) => name.endsWith(".spec.ts"));

  it("pins media membership so a new spec forces a bucket decision", () => {
    const media = specs
      .filter((name) => MEDIA_SPEC.test(join(e2eDir, name)))
      .sort();
    expect(media).toEqual([...MEDIA_FILES].sort());
    expect(specs).toContain("mobile-immersive-stage.spec.ts");
    expect(MEDIA_FILES).not.toContain("mobile-immersive-stage.spec.ts");
  });

  it("does not treat a parent directory named screen-share as media", () => {
    expect(MEDIA_SPEC.test("/tmp/screen-share-fix/client/e2e/theme-tokens.spec.ts")).toBe(
      false,
    );
    expect(MEDIA_SPEC.test("/tmp/pqp/client/e2e/voice-lobby.spec.ts")).toBe(true);
    expect(MEDIA_SPEC.test(join(e2eDir, "mobile-immersive-stage.spec.ts"))).toBe(
      false,
    );
  });

  it("wires MEDIA_SPEC into chromium and chromium-media so media never runs twice", () => {
    const chromium = project("chromium");
    const media = project("chromium-media");
    expect(
      regexes(chromium.testIgnore).some((re) => re.source === MEDIA_SPEC.source),
    ).toBe(true);
    expect(
      regexes(media.testMatch).some((re) => re.source === MEDIA_SPEC.source),
    ).toBe(true);
  });
});
