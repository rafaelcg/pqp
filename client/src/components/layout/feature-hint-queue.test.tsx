// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FeatureHint,
  FeatureHintProvider,
  resetFeatureHintsForTests,
  useFeatureHintEnabled,
} from "@/components/layout/feature-hint";
import {
  useFeatureHintsSpent,
  winningFeatureHint,
  type AttachedFeatureHintId,
} from "@/lib/feature-hints";

/*
 * THE QUEUE HAS TO MOVE THE MOMENT A CARD IS SPENT.
 *
 * Dismissing an attached hint writes to a set in `lib/feature-hints.ts`,
 * and the queue reads that set while it renders. Nothing subscribed to it,
 * so the winner was recomputed only when something ELSE happened to
 * re-render App: pressing Entendi on the call dock card left an empty slot
 * until the next unrelated state change, and the music card that was next
 * in line arrived minutes later or not at all.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", FakeResizeObserver);

let host: HTMLDivElement;
let root: Root;

function Card({ id }: { id: AttachedFeatureHintId }) {
  const enabled = useFeatureHintEnabled(id);
  return <FeatureHint id={id} enabled={enabled} body={id} />;
}

/** App's queue in miniature: both gates standing, one slot between them. */
function Queue() {
  useFeatureHintsSpent();
  const winner = winningFeatureHint({ callDock: true, music: true });
  return (
    <FeatureHintProvider winner={winner}>
      <Card id="callDock" />
      <Card id="music" />
    </FeatureHintProvider>
  );
}

function card(id: string): Element | null {
  return document.querySelector(`[data-corner-card="${id}"]`);
}

function gotIt(id: string) {
  const buttons = [...(card(id)?.querySelectorAll("button") ?? [])];
  const cta = buttons.find((one) => one.getAttribute("aria-label") === null);
  expect(cta).toBeDefined();
  act(() => {
    cta!.click();
  });
}

describe("the attached hint queue", () => {
  beforeEach(() => {
    resetFeatureHintsForTests();
    window.localStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<Queue />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("hands the slot to the next card as soon as one is dismissed", () => {
    expect(card("callDock")).not.toBeNull();
    expect(card("music")).toBeNull();

    // Nothing else changes: no gate moves, no other state is touched.
    gotIt("callDock");

    expect(card("music")).not.toBeNull();
  });
});
