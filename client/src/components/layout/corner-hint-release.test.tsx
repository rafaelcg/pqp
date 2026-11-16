// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://pqp.gg/app" }
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-notifications", () => ({
  useNotificationSettings: () => ({ enable: vi.fn(async () => {}) }),
}));
vi.mock("@/lib/notifications", () => ({ dismissNotifyOffer: vi.fn() }));
vi.mock("@/lib/api", () => ({
  updateCommunitySettings: vi.fn(async () => ({ ok: true, community: {} })),
}));

import { ListingNudgeHint } from "../communities/listing-nudge-hint";
import { NotifyOfferHint } from "./notify-offer-hint";

/**
 * DISMISSING A CORNER CARD HAS TO GIVE THE CORNER BACK.
 *
 * `lib/corner-hints.ts` hands the corner to the first card that wants it,
 * and `App` yields the one attached-hint slot for as long as anybody holds
 * it (`liveAttachedHint`). A card that closed itself with local state and told
 * `App` nothing left `App` offering the corner to a card nobody could see,
 * and buried every attached tip behind it for the rest of the page load.
 *
 * Localhost used to replay every card on every reload. It now keeps them
 * off unless `pqp:hints-persist` is set. The URL above is not localhost
 * on purpose: this was not a localhost bug.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  localStorage.clear();
});

function card(name: string): HTMLElement | null {
  return document.querySelector(`[data-corner-card="${name}"]`);
}

/** The X in the card's own header, which is the plain dismissal. */
async function dismiss(name: string) {
  const button = card(name)?.querySelector<HTMLButtonElement>(
    "button[aria-label]",
  );
  expect(button).not.toBeNull();
  await act(async () => {
    button!.click();
  });
}

describe("a dismissed corner card releases the corner", () => {
  it("the notification offer", async () => {
    const onDismiss = vi.fn();
    await mount(<NotifyOfferHint enabled onDismiss={onDismiss} />);

    expect(card("notify-offer")).not.toBeNull();
    await dismiss("notify-offer");

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("the directory listing nudge", async () => {
    const onDismiss = vi.fn();
    await mount(
      <ListingNudgeHint
        enabled
        nudge={{ serverId: "6f1c1d1e-0000-4000-8000-000000000001", name: "Clube", iconUrl: null }}
        onSeen={() => {}}
        onDismiss={onDismiss}
        onListed={() => {}}
        onFailed={() => {}}
      />,
    );

    expect(card("listing-nudge")).not.toBeNull();
    await dismiss("listing-nudge");

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("taking the card's own action also releases it", () => {
  it("the notification offer's later button gives the corner back", async () => {
    const onDismiss = vi.fn();
    await mount(<NotifyOfferHint enabled onDismiss={onDismiss} />);

    // The footer holds the CTA, then "later"; the X carries an aria-label.
    const footer = [...document.querySelectorAll("button")].filter(
      (one) => one.getAttribute("aria-label") === null,
    );
    const later = footer[1];
    expect(later).toBeDefined();
    await act(async () => {
      later!.click();
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
