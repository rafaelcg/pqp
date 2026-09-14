import { describe, expect, it } from "vitest";
import en from "@/locales/en/translation.json";
import ptBR from "@/locales/pt-BR/translation.json";

/**
 * Regression pin for a CI flake in `e2e/camera-stage.spec.ts`:
 * `page.getByLabel("Your camera")` failed with "resolved to 2 elements".
 *
 * Playwright's `getByLabel` does a case-insensitive SUBSTRING match by
 * default. `call-stage.tsx` renders our own camera in two shapes that can be
 * on screen together: the ordinary stage tile (`cameraLabel`, aria-label
 * `voice.tile.yourCamera`) and, whenever exactly one other picture is on the
 * stage, a floating self-preview PiP — a wrapping `<div role="group"
 * aria-label={t("call.stage.selfPreview")}>` around that SAME labelled
 * `<video>`. The wrapper's copy used to be "Your camera preview" (pt-BR
 * "Prévia da sua câmera"), which literally CONTAINS "Your camera" ("Sua
 * câmera") as a substring — so any time the self-preview PiP renders (a
 * perfectly ordinary 1:1 call, not a bug), two elements answer to "Your
 * camera": the wrapper div and the video inside it. A stray roster entry
 * from an adjacent, sloppily-torn-down e2e spec (the same shared dev-bypass
 * identity, a screen-share flag not yet cleared within the 90s orphan
 * window) was enough to trip `others.length === 1` for a nominally
 * single-user test too, which is what made this look like a timing race
 * rather than a deterministic label collision.
 *
 * The fix is copy, not layout: the PiP's own label must never contain the
 * video's label as a substring. This test pins that relationship directly
 * against the translation files rather than against a specific wording, so
 * it fails again the moment somebody "restores" the old copy.
 */
describe("call stage camera labels never overlap as a substring", () => {
  const locales: Array<{ name: string; dict: Record<string, string> }> = [
    { name: "en", dict: en as Record<string, string> },
    { name: "pt-BR", dict: ptBR as Record<string, string> },
  ];

  for (const { name, dict } of locales) {
    it(`${name}: self-preview label does not contain the camera video's label`, () => {
      const videoLabel = dict["voice.tile.yourCamera"];
      const pipLabel = dict["call.stage.selfPreview"];
      expect(videoLabel, "voice.tile.yourCamera is missing").toBeTruthy();
      expect(pipLabel, "call.stage.selfPreview is missing").toBeTruthy();

      // Only one element may ever carry the camera video's own label. If the
      // PiP wrapper's label contains it (or vice versa), `getByLabel` — and
      // any assistive tech doing the same case-insensitive substring lookup
      // — cannot tell the two apart.
      expect(pipLabel.toLowerCase()).not.toContain(videoLabel.toLowerCase());
      expect(videoLabel.toLowerCase()).not.toContain(pipLabel.toLowerCase());
    });
  }
});
