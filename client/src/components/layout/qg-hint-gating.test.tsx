// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://pqp.gg/app" }
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QG_HINT_STORAGE_KEY } from "@/lib/qg-hint";
import { QgHint } from "./qg-hint";

/**
 * The QG invite is a member of the corner queue, and this is what that means.
 *
 * It used to only REPORT that it wanted the corner and then render regardless,
 * so on 9 Sep 2026 it and the "new version is ready" card were mounted at the
 * same time, overlapping in the same corner, with an Escape listener each. The
 * doc's "one corner at a time" was true of every other card and not of this
 * one. Two things are pinned here: it does not paint when the queue gave the
 * corner to somebody else, and it does not spend its once-ever impression
 * either, because a card nobody saw has to come back.
 *
 * The URL above is not localhost on purpose: `lib/hints.ts` deliberately never
 * persists on localhost so a developer sees every card on every reload, and on
 * localhost this test could not observe the impression at all.
 */

vi.mock("@/lib/api", () => ({
  lookupCommunityBySlug: vi.fn(async () => ({
    community: { joined: false, id: "qg-1", bannerUrl: null },
  })),
  joinCommunity: vi.fn(),
}));

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
  // Let the community lookup resolve and the card settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  localStorage.clear();
});

function qgCard(): Element | null {
  return document.querySelector('[data-corner-card="qg"]');
}

describe("QgHint and the corner queue", () => {
  it("does not paint, and does not spend its impression, when the corner is taken", async () => {
    const wanted: boolean[] = [];
    await mount(
      <QgHint
        enabled={false}
        onJoined={() => {}}
        onFailed={() => {}}
        onWantedChange={(next) => wanted.push(next)}
      />,
    );

    expect(qgCard()).toBeNull();
    // It still tells the queue it wants the corner, which is how the queue
    // knows to give it back the moment the update notice is gone.
    expect(wanted.at(-1)).toBe(true);
    expect(localStorage.getItem(QG_HINT_STORAGE_KEY)).toBeNull();
  });

  it("paints and spends its impression when the corner is its own", async () => {
    await mount(
      <QgHint enabled onJoined={() => {}} onFailed={() => {}} />,
    );

    expect(qgCard()).not.toBeNull();
    expect(localStorage.getItem(QG_HINT_STORAGE_KEY)).toBe("1");
  });
});
