import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setActiveCatalogue } from "@/lib/i18n";
import { GuestRequestButton } from "./guest-request-button";

/**
 * The audience's ONLY control (`docs/plans/WATCH_PARTY_GUESTS.md` §3.1), and
 * its states must never overlap: idle, pending, and declined-with-a-cooldown
 * are mutually exclusive, and withdraw must always be free while pending.
 */

afterEach(() => {
  setActiveCatalogue(undefined);
});

function render(props: Partial<Parameters<typeof GuestRequestButton>[0]> = {}) {
  return renderToStaticMarkup(
    <GuestRequestButton
      requested={false}
      position={null}
      cooldownMinutesLeft={null}
      onRequest={vi.fn()}
      onWithdraw={vi.fn()}
      {...props}
    />,
  );
}

describe("GuestRequestButton", () => {
  it("shows the idle ask button by default", () => {
    const html = render();
    expect(html).toContain('data-watch-party-guest-request="idle"');
    expect(html).not.toContain("data-watch-party-guest-withdraw");
  });

  it("shows pending with a free withdraw, and no request button", () => {
    const html = render({ requested: true });
    expect(html).toContain('data-watch-party-guest-request="pending"');
    expect(html).toContain("data-watch-party-guest-withdraw");
    expect(html).not.toContain('data-watch-party-guest-request="idle"');
  });

  it("prints the queue position only once it is known", () => {
    const withPosition = render({ requested: true, position: 3 });
    expect(withPosition).toContain("3");

    const withoutPosition = render({ requested: true, position: null });
    expect(withoutPosition).not.toMatch(/n[úu]mero/i);
  });

  it("disables the button and shows the cooldown when declined", () => {
    const html = render({ cooldownMinutesLeft: 4 });
    expect(html).toContain('data-watch-party-guest-request="declined"');
    expect(html).toContain("disabled");
    expect(html).toContain("4");
    // Neither of the other two states leaks through.
    expect(html).not.toContain('data-watch-party-guest-request="idle"');
    expect(html).not.toContain("data-watch-party-guest-withdraw");
  });

  it("the cooldown state wins even if `requested` is somehow also true", () => {
    // Defence in depth: a stale frame must not show both a cooldown notice
    // and an active pending pill at once.
    const html = render({ requested: true, cooldownMinutesLeft: 2 });
    expect(html).toContain('data-watch-party-guest-request="declined"');
    expect(html).not.toContain('data-watch-party-guest-request="pending"');
  });
});
