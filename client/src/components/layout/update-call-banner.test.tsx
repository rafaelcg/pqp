// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { setInCall } from "@/lib/in-call-state";
import {
  resetUpdateState,
  setBuildStaleness,
  setUpdatePromptShowing,
  setUpdateWaiting,
} from "@/lib/update-prompt-state";
import { UpdateCallBanner } from "./update-call-banner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;
const applied: (string | null)[] = [];

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <UpdateCallBanner
        apply={async (target) => {
          applied.push(target);
          return { ok: true };
        }}
      />,
    );
  });
}

function banner() {
  return document.querySelector("[data-update-call-banner]");
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  applied.length = 0;
  setInCall(false);
  resetUpdateState();
});

function newBuild(critical = false) {
  setBuildStaleness({
    stale: true,
    forced: critical,
    critical,
    latestBuild: "def456",
    since: Date.now(),
  });
  setUpdateWaiting(true);
}

describe("UpdateCallBanner", () => {
  it("shows in a call while a newer build is waiting", async () => {
    await mount();
    act(() => {
      setInCall(true);
      newBuild();
    });
    expect(banner()).not.toBeNull();
  });

  it("stays away outside a call: the card and the safe-moment reload handle that", async () => {
    await mount();
    act(() => newBuild());
    expect(banner()).toBeNull();
  });

  it("stays away when nothing is waiting", async () => {
    await mount();
    act(() => setInCall(true));
    expect(banner()).toBeNull();
  });

  it("stays away for a critical update, which reloads by itself", async () => {
    await mount();
    act(() => {
      setInCall(true);
      newBuild(true);
    });
    expect(banner()).toBeNull();
  });

  it("gives way to the card when somebody asked for it from the rail", async () => {
    await mount();
    act(() => {
      setInCall(true);
      newBuild();
      setUpdatePromptShowing(true);
    });
    expect(banner()).toBeNull();
  });

  it("reloads now, toward the deployed build, when asked", async () => {
    await mount();
    act(() => {
      setInCall(true);
      newBuild();
    });
    const button = banner()?.querySelector("button");
    await act(async () => {
      button?.click();
    });
    expect(applied).toEqual(["def456"]);
  });
});
