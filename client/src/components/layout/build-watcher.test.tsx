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
import { BuildWatcher } from "./build-watcher";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;
let applied = 0;

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <BuildWatcher
        apply={async () => {
          applied += 1;
        }}
      />,
    );
  });
}

beforeEach(() => {
  applied = 0;
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

  it("never reloads on its own for a forced update: that is the screen's job", async () => {
    await mount();
    nobodyHere();
    act(() => setBuildStaleness(stale({ forced: true })));
    expect(applied).toBe(0);
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
