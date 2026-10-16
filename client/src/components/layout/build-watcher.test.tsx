// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setInCall, setWatchingParty } from "@/lib/in-call-state";
import {
  resetUpdateState,
  setBuildStaleness,
  type BuildStaleness,
} from "@/lib/update-prompt-state";
import { markActivity, resetActivityForTests } from "@/lib/user-activity";
import { autoReloadAllowed } from "@/lib/update-policy";
import { BuildWatcher } from "./build-watcher";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;
let applied = 0;
/** The last-moment check the most recent automatic reload carried. */
let lastMayReload: (() => boolean) | null = null;
/** What `apply` answers: a real one resolves "aborted" when that check says no. */
let applyAnswer: unknown = "activated";

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <BuildWatcher
        apply={async (_target, mayReload) => {
          applied += 1;
          lastMayReload = mayReload;
          return applyAnswer;
        }}
      />,
    );
  });
}

beforeEach(() => {
  applied = 0;
  lastMayReload = null;
  applyAnswer = "activated";
  window.sessionStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  setInCall(false);
  setWatchingParty(false);
  resetUpdateState();
  document.body.innerHTML = "";
});

function stale(over: Partial<BuildStaleness> = {}): BuildStaleness {
  return {
    stale: true,
    forced: false,
    latestBuild: "def456",
    // Out of date for a minute: well short of the twelve-hour rule, so these
    // tests are about IDLE and not about age.
    since: Date.now() - 60_000,
    ...over,
  };
}

/** The page has had nobody at it for an hour. */
function nobodyHere() {
  resetActivityForTests(Date.now() - 3_600_000);
}

describe("BuildWatcher", () => {
  it("renders nothing", async () => {
    await mount();
    expect(host?.innerHTML).toBe("");
  });

  it("stamps the running build on the page, for support", async () => {
    await mount();
    expect(document.documentElement.dataset.pqpBuild).toBeTruthy();
  });

  it("reloads an out-of-date page nobody has touched for a while", async () => {
    await mount();
    nobodyHere();
    act(() => setBuildStaleness(stale()));
    expect(applied).toBe(1);
  });

  it("leaves an out-of-date page somebody is using alone", async () => {
    await mount();
    markActivity();
    act(() => setBuildStaleness(stale()));
    expect(applied).toBe(0);
  });

  it("leaves a page alone while it is in a call, however idle", async () => {
    await mount();
    nobodyHere();
    act(() => setInCall(true));
    act(() => setBuildStaleness(stale({ since: 1 })));
    expect(applied).toBe(0);

    // And takes it once the call is over.
    act(() => setInCall(false));
    expect(applied).toBe(1);
  });

  it("leaves a page alone while somebody watches a live party", async () => {
    await mount();
    nobodyHere();
    act(() => setWatchingParty(true));
    act(() => setBuildStaleness(stale({ since: 1 })));
    expect(applied).toBe(0);
  });

  it("leaves a page alone while text sits in the field that has focus", async () => {
    await mount();
    const box = document.createElement("textarea");
    document.body.append(box);
    box.focus();
    box.value = "half a sentence";
    nobodyHere();
    act(() => setBuildStaleness(stale({ since: 1 })));
    expect(applied).toBe(0);
  });

  it("reloads a page that has been out of date for a long time, even while it is in use", async () => {
    await mount();
    markActivity();
    act(() => setBuildStaleness(stale({ since: Date.now() - 13 * 3_600_000 })));
    expect(applied).toBe(1);
  });

  it("does not reload the same build twice in a row", async () => {
    await mount();
    nobodyHere();
    act(() => setBuildStaleness(stale()));
    expect(applied).toBe(1);

    // A reload that did not land (a CDN still serving the old page): the next
    // look at the same target must not loop.
    act(() => setBuildStaleness(stale({ since: Date.now() - 30_000 })));
    expect(applied).toBe(1);
  });

  it("treats an update the operator pushed like any other: at a safe moment, never over somebody", async () => {
    // `client_force_update` used to block everybody. Now it only announces at
    // once, so what happens to the page is the ordinary rule.
    await mount();
    markActivity();
    act(() => setBuildStaleness(stale({ forced: true })));
    expect(applied).toBe(0);
    nobodyHere();
    act(() => setBuildStaleness(stale({ forced: true, since: Date.now() - 30_000 })));
    expect(applied).toBe(1);
  });

  it("does nothing, not even for an idle page, while the build is held for the daily announcement", async () => {
    await mount();
    nobodyHere();
    const opens = Date.now() + 3_600_000;
    act(() => setBuildStaleness(stale({ announceAt: opens })));
    expect(applied).toBe(0);
    // The same build, once its hour has come.
    act(() => setBuildStaleness(stale({ announceAt: Date.now() - 1 })));
    expect(applied).toBe(1);
  });

  it("asks once more at the last moment, and never takes a call or a watch party then", async () => {
    await mount();
    nobodyHere();
    act(() => setBuildStaleness(stale()));
    expect(applied).toBe(1);
    expect(lastMayReload?.()).toBe(true);
    // Bringing the worker up takes seconds; somebody joins a call in them.
    act(() => setInCall(true));
    expect(lastMayReload?.()).toBe(false);
    act(() => setInCall(false));
    act(() => setWatchingParty(true));
    expect(lastMayReload?.()).toBe(false);
  });

  it("asks again about typing at the last moment: a draft started while the worker was coming up is not lost", async () => {
    await mount();
    nobodyHere();
    act(() => setBuildStaleness(stale()));
    expect(applied).toBe(1);
    expect(lastMayReload?.()).toBe(true);
    const box = document.createElement("textarea");
    document.body.append(box);
    box.focus();
    box.value = "half a sentence";
    expect(lastMayReload?.()).toBe(false);
  });

  it("lets the critical update through the last-moment check: the operator chose that", async () => {
    await mount();
    act(() => setInCall(true));
    act(() => setBuildStaleness(stale({ forced: true, critical: true })));
    expect(lastMayReload?.()).toBe(true);
  });

  it("gives the reload back when it was refused at the last moment, so the hangup can still take it", async () => {
    applyAnswer = "aborted";
    await mount();
    nobodyHere();
    act(() => setBuildStaleness(stale()));
    expect(applied).toBe(1);
    await act(async () => {});
    // The one reload this build is allowed is not spent by one that never happened.
    expect(autoReloadAllowed("def456")).toBe(true);
  });

  it("reloads right after a call ends, even with somebody at the page", async () => {
    await mount();
    act(() => setInCall(true));
    markActivity();
    act(() => setBuildStaleness(stale()));
    expect(applied).toBe(0);
    act(() => setInCall(false));
    expect(applied).toBe(1);
  });

  it("does not reload after a call ends while somebody is typing", async () => {
    await mount();
    act(() => setInCall(true));
    act(() => setBuildStaleness(stale()));
    const box = document.createElement("textarea");
    document.body.append(box);
    box.focus();
    box.value = "half a sentence";
    markActivity(Date.now(), true);
    act(() => setInCall(false));
    expect(applied).toBe(0);
  });

  it("reloads a hidden tab even when it was used a moment ago", async () => {
    await mount();
    markActivity();
    const visibility = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      act(() => setBuildStaleness(stale()));
      expect(applied).toBe(1);
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
      if (visibility) Object.defineProperty(Document.prototype, "visibilityState", visibility);
    }
  });

  it("reloads in a call when the operator made the update critical", async () => {
    await mount();
    act(() => setInCall(true));
    markActivity();
    act(() => setBuildStaleness(stale({ forced: true, critical: true })));
    expect(applied).toBe(1);
  });

  it("does nothing while the page is current", async () => {
    await mount();
    nobodyHere();
    act(() =>
      setBuildStaleness({ stale: false, forced: false, latestBuild: null, since: null }),
    );
    expect(applied).toBe(0);
  });
});
