import type { CSSProperties } from "react";
import { appearanceForcesDark, type AppearancePreference } from "@/lib/appearance";

/**
 * A look's own accent, as the stylesheet would paint it in a mode: the dark
 * swatch, or that swatch mixed toward black for light. For the places that
 * must show it while a custom accent is overriding `--color-accent`.
 */
export function lookAccent(look: AppearancePreference, mode: "light" | "dark"): string {
  const swatch = `var(--swatch-${look}-accent)`;
  return mode === "light" && !appearanceForcesDark(look)
    ? `color-mix(in oklch, ${swatch} 62%, black)`
    : swatch;
}

/**
 * Miniature app chrome in the look's own swatches. The drawing is the
 * `appearance-preview*` recipe in `index.css`; only the colours vary.
 *
 * The swatches are dark. A light miniature is the same swatch mixed toward
 * white (and its ink flipped to the near-black rail), so nothing here is a new
 * colour, only a mix of ones the stylesheet already defines. A custom accent
 * wears the live accent token, which already follows the mode.
 */
export function LookMiniature({
  look,
  mode,
  customAccent,
}: {
  look: AppearancePreference;
  mode: "light" | "dark";
  customAccent: boolean;
}) {
  const light = mode === "light" && !appearanceForcesDark(look);
  const swatch = (part: string) => `var(--swatch-${look}-${part})`;
  const toward = (part: string, share: number) =>
    `color-mix(in oklch, ${swatch(part)} ${share}%, white)`;
  // The live accent token follows the page's mode, so it only suits a card
  // drawn in that same mode (a dark-only look stays dark on a light page).
  const accent =
    customAccent && (light ? "light" : "dark") === mode
      ? "var(--color-accent)"
      : lookAccent(look, mode);
  const style = (
    light
      ? ({
          "--preview-rail": toward("rail", 18),
          "--preview-list": toward("list", 12),
          "--preview-surface": toward("surface", 5),
          "--preview-accent": accent,
          "--swatch-ink": "var(--swatch-signal-rail)",
        } as CSSProperties)
      : ({
          "--preview-rail": swatch("rail"),
          "--preview-list": swatch("list"),
          "--preview-surface": swatch("surface"),
          "--preview-accent": accent,
        } as CSSProperties)
  );
  return (
    <span className="appearance-preview" style={style}>
      <span className="appearance-preview-rail" />
      <span className="appearance-preview-list">
        <span className="appearance-preview-channel" />
        <span className="appearance-preview-channel" />
        <span className="appearance-preview-channel" />
      </span>
      <span className="appearance-preview-chat">
        <span className="appearance-preview-message" />
        <span className="appearance-preview-message" />
        <span className="appearance-preview-message" />
        <span className="appearance-preview-composer" />
      </span>
    </span>
  );
}
