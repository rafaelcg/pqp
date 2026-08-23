import { afterEach, describe, expect, it } from "vitest";
import { desktopPredatesScreenShare, isDesktopApp } from "./desktop";

/**
 * The rule under test is "absence means old", which is exactly the kind of
 * inversion that reads fine and ships backwards. It is worth pinning because
 * getting it the wrong way round is silent: the shell that CAN share is told
 * to update, and the one that cannot is told the feature does not exist.
 */

type Shell = { isElectron: true; canShareScreen?: true };

function setShell(shell: Shell | undefined): void {
  if (shell) {
    (globalThis as { window?: unknown }).window = { pqpDesktop: shell };
  } else {
    (globalThis as { window?: unknown }).window = {};
  }
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("desktopPredatesScreenShare", () => {
  it("is true in a shell that does not advertise the capability", () => {
    // Every build tagged up to v0.1.0. `getDisplayMedia` exists, the main
    // process has no handler for it, and the share rejects.
    setShell({ isElectron: true });
    expect(isDesktopApp()).toBe(true);
    expect(desktopPredatesScreenShare()).toBe(true);
  });

  it("is false once the shell advertises it", () => {
    setShell({ isElectron: true, canShareScreen: true });
    expect(desktopPredatesScreenShare()).toBe(false);
  });

  it("is false in a browser, which needs the other wording entirely", () => {
    // A browser without getDisplayMedia is genuinely unsupported. Telling that
    // person to update a desktop app they never installed would be a worse
    // answer than the bug this replaces.
    setShell(undefined);
    expect(isDesktopApp()).toBe(false);
    expect(desktopPredatesScreenShare()).toBe(false);
  });

  it("is false when there is no window at all", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(desktopPredatesScreenShare()).toBe(false);
  });
});
