// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://pqp.gg/app" }
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The browser's one-time "Ativar notificações" card.
 *
 * What has to hold: it draws only when the queue says so, the button is what
 * asks the browser (the click is the gesture the permission needs), it is
 * spent once, and closing it hands the corner back.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const enable = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/hooks/use-notifications", () => ({
  useNotificationSettings: () => ({ enable }),
}));

const { NotifyOfferHint } = await import("./notify-offer-hint");
const { NOTIFY_OFFER_HINT_STORAGE_KEY } = await import("@/lib/notify-offer-hint");

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

const card = () => document.querySelector<HTMLElement>('[data-corner-card="notify-offer"]');

beforeEach(() => {
  enable.mockClear();
  localStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  localStorage.clear();
});

describe("NotifyOfferHint", () => {
  it("draws nothing while the queue has not handed it the corner", async () => {
    await mount(<NotifyOfferHint enabled={false} />);
    expect(card()).toBeNull();
    expect(localStorage.getItem(NOTIFY_OFFER_HINT_STORAGE_KEY)).toBeNull();
  });

  it("draws with the copy and spends the impression once it is on screen", async () => {
    await mount(<NotifyOfferHint enabled />);
    expect(card()).not.toBeNull();
    expect(card()!.textContent).toContain("Want to hear when someone writes to you?");
    expect(localStorage.getItem(NOTIFY_OFFER_HINT_STORAGE_KEY)).toBe("1");
  });

  it("does not come back once it has been seen", async () => {
    localStorage.setItem(NOTIFY_OFFER_HINT_STORAGE_KEY, "1");
    await mount(<NotifyOfferHint enabled />);
    expect(card()).toBeNull();
  });

  it("the button asks for the permission, then closes and frees the corner", async () => {
    const onDismiss = vi.fn();
    await mount(<NotifyOfferHint enabled onDismiss={onDismiss} />);
    const cta = [...card()!.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Turn on notifications"),
    );
    expect(cta).toBeDefined();
    await act(async () => {
      cta!.click();
    });
    expect(enable).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("a rejected permission request keeps the card so the person can try again", async () => {
    enable.mockRejectedValueOnce(new Error("permission API failed"));
    const onDismiss = vi.fn();
    await mount(<NotifyOfferHint enabled onDismiss={onDismiss} />);
    const press = async () => {
      const cta = [...card()!.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Turn on notifications"),
      );
      await act(async () => {
        cta!.click();
      });
    };
    await press();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(card()).not.toBeNull();
    await press();
    expect(enable).toHaveBeenCalledTimes(2);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("'Not now' closes without asking the browser", async () => {
    const onDismiss = vi.fn();
    await mount(<NotifyOfferHint enabled onDismiss={onDismiss} />);
    const later = [...card()!.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Not now"),
    );
    await act(async () => {
      later!.click();
    });
    expect(enable).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
