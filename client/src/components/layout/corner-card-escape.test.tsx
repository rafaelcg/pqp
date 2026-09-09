// @vitest-environment jsdom
import { useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { CornerCard } from "./corner-card";

/**
 * `dismissOnEscape`, in the shell rather than through the update notice.
 *
 * `update-prompt.test.tsx` proves the product behaviour this was added for.
 * This file proves the prop itself, so a refactor that keeps the update card
 * looking right while quietly dropping the option is caught here.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function Card({ dismissOnEscape }: { dismissOnEscape: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <CornerCard
      open={open}
      onClose={() => setOpen(false)}
      label="card"
      dismissLabel="dismiss"
      dataAttribute="card"
      dismissOnEscape={dismissOnEscape}
      title="Something"
    />
  );
}

async function escapeThenSettle() {
  act(() => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  // The exit animation unmounts the card 180ms after `open` goes false.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 260));
  });
}

function card(): Element | null {
  return document.querySelector('[data-corner-card="card"]');
}

describe("CornerCard and Escape", () => {
  it("closes by default", async () => {
    mount(<Card dismissOnEscape />);
    await escapeThenSettle();
    expect(card()).toBeNull();
  });

  it("stays when the card opted out", async () => {
    mount(<Card dismissOnEscape={false} />);
    await escapeThenSettle();
    expect(card()).not.toBeNull();
  });
});
