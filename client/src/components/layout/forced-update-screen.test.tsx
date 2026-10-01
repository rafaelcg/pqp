// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { setInCall } from "@/lib/in-call-state";
import {
  resetUpdateState,
  setBuildStaleness,
} from "@/lib/update-prompt-state";
import { ForcedUpdateScreen } from "./forced-update-screen";

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
  setInCall(false);
  resetUpdateState();
});

const FORCED = { stale: true, forced: true, latestBuild: "def456", since: 1 };
const SOFT = { stale: true, forced: false, latestBuild: "def456", since: 1 };

function screen() {
  return document.querySelector('[role="dialog"]');
}

function pressEscape() {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
}

describe("the forced update screen", () => {
  it("is absent until the operator forces an update", async () => {
    await mount(<ForcedUpdateScreen apply={async () => {}} />);
    expect(screen()).toBeNull();

    act(() => setBuildStaleness(SOFT));
    expect(screen()).toBeNull();
  });

  it("blocks with one button once an update is forced", async () => {
    await mount(<ForcedUpdateScreen apply={async () => {}} />);
    act(() => setBuildStaleness(FORCED));

    const dialog = screen();
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.textContent).toContain("Update required");
    // One button, and no way to close it: the X is gone, not merely disabled.
    const buttons = dialog!.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe("Update now");
    expect(document.querySelector('[aria-label]:not([role="dialog"]) svg.lucide-x')).toBeNull();
  });

  it("is not dismissed by Escape or by a click on the backdrop", async () => {
    await mount(<ForcedUpdateScreen apply={async () => {}} />);
    act(() => setBuildStaleness(FORCED));

    pressEscape();
    const layer = document.querySelector("[data-dialog-layer]") as HTMLElement;
    act(() => {
      layer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(screen()).not.toBeNull();
  });

  it("applies the update when the button is pressed", async () => {
    let applied = 0;
    await mount(
      <ForcedUpdateScreen
        apply={async () => {
          applied += 1;
        }}
      />,
    );
    act(() => setBuildStaleness(FORCED));

    act(() => screen()!.querySelector("button")!.click());

    expect(applied).toBe(1);
    expect(screen()?.querySelector("button")?.textContent).toBe("Updating…");
  });

  it("waits out a call and appears when it ends", async () => {
    await mount(<ForcedUpdateScreen apply={async () => {}} />);
    act(() => setInCall(true));
    act(() => setBuildStaleness(FORCED));
    expect(screen()).toBeNull();

    act(() => setInCall(false));
    expect(screen()).not.toBeNull();
  });

  it("goes when the page is current again", async () => {
    await mount(<ForcedUpdateScreen apply={async () => {}} />);
    act(() => setBuildStaleness(FORCED));
    expect(screen()).not.toBeNull();

    act(() =>
      setBuildStaleness({ stale: false, forced: false, latestBuild: null, since: null }),
    );
    expect(screen()).toBeNull();
  });
});
