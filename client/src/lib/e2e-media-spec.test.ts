import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MEDIA_SPEC } from "../../e2e/media-spec";

const e2eDir = join(dirname(fileURLToPath(import.meta.url)), "../../e2e");

describe("e2e media project split", () => {
  const specs = readdirSync(e2eDir).filter((name) => name.endsWith(".spec.ts"));

  it("classifies every spec as media, phone, or core — no leftovers", () => {
    expect(specs.length).toBeGreaterThan(20);

    const phone = specs.filter((name) => name.includes("mobile-immersive-stage"));
    const media = specs.filter((name) => MEDIA_SPEC.test(name) && !phone.includes(name));
    const core = specs.filter((name) => !MEDIA_SPEC.test(name) && !phone.includes(name));

    expect(phone).toEqual(["mobile-immersive-stage.spec.ts"]);
    expect(media.length).toBeGreaterThanOrEqual(15);
    expect(core.length).toBeGreaterThanOrEqual(20);
    expect(media.length + core.length + phone.length).toBe(specs.length);
  });

  it("does not put the phone spec in the media project", () => {
    expect(MEDIA_SPEC.test("mobile-immersive-stage.spec.ts")).toBe(false);
  });
});
