// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://pqp.gg/app" }
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The owner's one-time "Aparecer no diretório" card.
 *
 * What has to hold: it draws only when the queue hands it the corner, the
 * impression is reported exactly once, the button lists the room it names
 * (and nothing else), and every way out frees the corner.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const updateCommunitySettings = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, community: {} })),
);
vi.mock("@/lib/api", () => ({ updateCommunitySettings }));

const { ListingNudgeHint } = await import("./listing-nudge-hint");

const NUDGE = {
  serverId: "6f1c1d1e-0000-4000-8000-000000000001",
  name: "Clube do Bolinha",
  iconUrl: null,
};

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

async function rerender(node: React.ReactNode) {
  await act(async () => {
    root!.render(node);
  });
}

const card = () =>
  document.querySelector<HTMLElement>('[data-corner-card="listing-nudge"]');
const button = (label: string) =>
  [...card()!.querySelectorAll("button")].find((one) =>
    one.textContent?.includes(label),
  );

function props(overrides: Partial<Parameters<typeof ListingNudgeHint>[0]> = {}) {
  return {
    enabled: true,
    nudge: NUDGE,
    onSeen: vi.fn(),
    onDismiss: vi.fn(),
    onListed: vi.fn(),
    onFailed: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  updateCommunitySettings.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("ListingNudgeHint", () => {
  it("draws nothing, and spends nothing, while another card holds the corner", async () => {
    const p = props({ enabled: false });
    await mount(<ListingNudgeHint {...p} />);
    expect(card()).toBeNull();
    expect(p.onSeen).not.toHaveBeenCalled();
  });

  it("draws nothing with no room to ask about", async () => {
    const p = props({ nudge: null });
    await mount(<ListingNudgeHint {...p} />);
    expect(card()).toBeNull();
    expect(p.onSeen).not.toHaveBeenCalled();
  });

  it("names the room, says what listing means, and reports the impression once", async () => {
    const p = props();
    await mount(<ListingNudgeHint {...p} />);
    expect(card()).not.toBeNull();
    const text = card()!.textContent ?? "";
    expect(text).toContain("Clube do Bolinha");
    expect(text).toContain("without an invite");
    expect(text).toContain("people who run pqp");
    await rerender(<ListingNudgeHint {...p} />);
    expect(p.onSeen).toHaveBeenCalledTimes(1);
  });

  it("lists exactly the room it names, and nothing else, then closes", async () => {
    const p = props();
    await mount(<ListingNudgeHint {...p} />);
    await act(async () => {
      button("Show in the directory")!.click();
    });
    expect(updateCommunitySettings).toHaveBeenCalledWith(NUDGE.serverId, {
      isListed: true,
    });
    expect(p.onListed).toHaveBeenCalledWith(NUDGE.serverId, NUDGE.name);
    expect(p.onFailed).not.toHaveBeenCalled();
  });

  it("says so when the listing fails and stays up to try again", async () => {
    updateCommunitySettings.mockRejectedValueOnce(new Error("nope"));
    const p = props();
    await mount(<ListingNudgeHint {...p} />);
    await act(async () => {
      button("Show in the directory")!.click();
    });
    expect(p.onFailed).toHaveBeenCalledTimes(1);
    expect(p.onListed).not.toHaveBeenCalled();
    expect(button("Show in the directory")!.disabled).toBe(false);
  });

  it("Not now closes it without listing anything and frees the corner", async () => {
    const p = props();
    await mount(<ListingNudgeHint {...p} />);
    await act(async () => {
      button("Not now")!.click();
    });
    expect(updateCommunitySettings).not.toHaveBeenCalled();
    expect(p.onDismiss).toHaveBeenCalledTimes(1);
  });
});
