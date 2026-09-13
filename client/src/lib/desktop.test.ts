import { afterEach, describe, expect, it } from "vitest";
import {
  desktopPredatesScreenShare,
  desktopShareCapabilities,
  isDesktopApp,
  type DesktopShareCapabilities,
} from "./desktop";

/**
 * The rule under test is "absence means old", which is exactly the kind of
 * inversion that reads fine and ships backwards. It is worth pinning because
 * getting it the wrong way round is silent: the shell that CAN share is told
 * to update, and the one that cannot is told the feature does not exist.
 */

type Shell = {
  isElectron: true;
  canShareScreen?: true;
  capabilities?: DesktopShareCapabilities;
};

/** What a 0.1.6 build on Windows publishes. */
const windowsCapabilities: DesktopShareCapabilities = {
  displayMedia: true,
  systemAudio: "loopback",
  restrictOwnAudio: true,
  pickerOffersAudio: true,
  version: "0.1.6",
};

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

  it("is false for a shell that only publishes the capability object", () => {
    // The successor signal. A build that says `capabilities.displayMedia` and
    // nothing else must not be told to update itself, and the two signals have
    // to be read as alternatives rather than as a pair: this is a hosted client
    // meeting binaries from several releases at once.
    setShell({ isElectron: true, capabilities: windowsCapabilities });
    expect(desktopPredatesScreenShare()).toBe(false);
  });

  it("is true for a shell whose capabilities say it cannot capture", () => {
    setShell({
      isElectron: true,
      capabilities: { ...windowsCapabilities, displayMedia: false },
    });
    expect(desktopPredatesScreenShare()).toBe(true);
  });
});

describe("desktopShareCapabilities", () => {
  it("hands back what the shell published", () => {
    setShell({ isElectron: true, capabilities: windowsCapabilities });
    expect(desktopShareCapabilities()).toEqual(windowsCapabilities);
  });

  it("is null in a browser and in a shell that does not say", () => {
    // Null is "does not say", never "cannot": callers keep the answer they had
    // before the object existed, which for the installed 0.1.5 builds is the
    // platform test they always used.
    setShell(undefined);
    expect(desktopShareCapabilities()).toBeNull();
    setShell({ isElectron: true, canShareScreen: true });
    expect(desktopShareCapabilities()).toBeNull();
  });
});
