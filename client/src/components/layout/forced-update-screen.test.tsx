// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setInCall } from "@/lib/in-call-state";
import {
  resetUpdateState,
  setBuildStaleness,
} from "@/lib/update-prompt-state";
import { UPDATING_HARD_CAP_MS } from "@/hooks/use-apply-update";
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

describe("when taking the update FAILS (a blocking screen must never become a lock-out)", () => {
  const button = () => screen()!.querySelector("button") as HTMLButtonElement;
  const errorText = () =>
    document.querySelector('[data-testid="forced-update-error"]')?.textContent ?? null;

  async function press() {
    await act(async () => {
      button().click();
    });
  }

  it("gives the button back, says so, and tries again on the next press, when apply rejects", async () => {
    let calls = 0;
    await mount(
      <ForcedUpdateScreen
        apply={async () => {
          calls += 1;
          throw new Error("worker would not activate");
        }}
      />,
    );
    act(() => setBuildStaleness(FORCED));

    await press();
    expect(calls).toBe(1);
    expect(button().disabled).toBe(false);
    expect(button().textContent).toBe("Try again");
    expect(errorText()).toContain("Could not update");
    expect(document.querySelector('[role="alert"]')).not.toBeNull();

    await press();
    expect(calls).toBe(2);
  });

  it("does the same when apply throws before it returns a promise", async () => {
    await mount(
      <ForcedUpdateScreen
        apply={() => {
          throw new Error("sync");
        }}
      />,
    );
    act(() => setBuildStaleness(FORCED));
    await press();
    expect(button().disabled).toBe(false);
    expect(errorText()).toContain("Could not update");
  });

  it("says it is offline, in its own words, when the ladder reports that", async () => {
    await mount(
      <ForcedUpdateScreen apply={async () => ({ ok: false, reason: "offline" })} />,
    );
    act(() => setBuildStaleness(FORCED));
    await press();
    expect(errorText()).toContain("offline");
    expect(button().disabled).toBe(false);
  });

  it("says it failed when the ladder reports that after trying everything", async () => {
    await mount(
      <ForcedUpdateScreen apply={async () => ({ ok: false, reason: "failed" })} />,
    );
    act(() => setBuildStaleness(FORCED));
    await press();
    expect(errorText()).toContain("Could not update");
  });

  it("keeps saying 'Updating' while the page is leaving (a result that is not a failure)", async () => {
    await mount(<ForcedUpdateScreen apply={async () => ({ ok: true })} />);
    act(() => setBuildStaleness(FORCED));
    await press();
    expect(button().disabled).toBe(true);
    expect(button().textContent).toBe("Updating…");
    expect(errorText()).toBeNull();
  });

  it("gives the button back even if apply never settles", async () => {
    vi.useFakeTimers();
    try {
      await mount(<ForcedUpdateScreen apply={() => new Promise(() => {})} />);
      act(() => setBuildStaleness(FORCED));
      await press();
      expect(button().disabled).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(UPDATING_HARD_CAP_MS + 1);
      });
      expect(button().disabled).toBe(false);
      expect(errorText()).toContain("Could not update");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the error while the retry runs", async () => {
    let fail = true;
    await mount(
      <ForcedUpdateScreen
        apply={async () => {
          if (fail) {
            throw new Error("no");
          }
          return new Promise(() => {});
        }}
      />,
    );
    act(() => setBuildStaleness(FORCED));
    await press();
    expect(errorText()).not.toBeNull();
    fail = false;
    await press();
    expect(errorText()).toBeNull();
    expect(button().textContent).toBe("Updating…");
  });
});
