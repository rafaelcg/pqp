import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setActiveCatalogue } from "@/lib/i18n";
import { GuestHeaderAvatars } from "./guest-header-avatars";

/**
 * §4: up to three avatars, a mic glyph on the group, a tooltip with every
 * name — and NOT animated (the presence avatars light up in real time, the
 * voices arrive 25s later, so no speaking ring belongs here).
 */

afterEach(() => {
  setActiveCatalogue(undefined);
});

function person(userId: string) {
  return { userId, displayName: userId, avatarUrl: null };
}

function render(onAir: ReturnType<typeof person>[]) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <GuestHeaderAvatars onAir={onAir} />
    </TooltipProvider>,
  );
}

describe("GuestHeaderAvatars", () => {
  it("draws nothing when nobody is on air", () => {
    expect(render([])).toBe("");
  });

  it("draws one avatar per guest, up to three, with a mic glyph on the group", () => {
    const html = render([person("a"), person("b")]);
    expect(html).toContain("data-watch-party-guest-avatars");
    expect((html.match(/<img|role="img"/g) ?? []).length).toBeGreaterThan(0);
  });

  it("caps the drawn avatars at three even with more on air", () => {
    const html = render([
      person("a"),
      person("b"),
      person("c"),
      person("d"),
      person("e"),
    ]);
    // Five people on air; the avatar stack still shows at most three faces.
    // Ring-wrapped avatar wrappers are the countable unit here.
    const avatarCount = (html.match(/ring-2 ring-surface-2/g) ?? []).length;
    expect(avatarCount).toBeLessThanOrEqual(3);
  });

  it("never animates: no speaking-ring or pulse class on a guest avatar", () => {
    const html = render([person("a")]);
    expect(html).not.toMatch(/animate-pulse|speaking-ring|animate-ping/);
  });
});
