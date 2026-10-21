import { describe, expect, it } from "vitest";
import { PqpAppError } from "@pqp/app-sdk";
import { createShareControl, probeShare, setShared, spectatorNames, WATCHER_NAMES_SHOWN } from "./share";

const host = (request: (on: boolean) => Promise<boolean>) => ({ share: { request } });

describe("the share probe: the control is drawn only when the platform answers", () => {
  it("is on when a stop request is answered, and asks only to STOP sharing", async () => {
    const asked: boolean[] = [];
    expect(await probeShare(host(async (on) => (asked.push(on), false)))).toBe(true);
    expect(asked).toEqual([false]);
  });

  it("is off with the flag off: the host answers not-allowed", async () => {
    expect(await probeShare(host(async () => { throw new PqpAppError("not-allowed"); }))).toBe(false);
  });

  it("is off when there is no share flow here (a text channel), or the host is unreachable", async () => {
    expect(await probeShare(host(async () => { throw new PqpAppError("unavailable"); }))).toBe(false);
    expect(await probeShare(host(async () => { throw new PqpAppError("ended"); }))).toBe(false);
    expect(await probeShare(host(async () => { throw new Error("boom"); }))).toBe(false);
  });
});

describe("starting and stopping the share", () => {
  it("reports what the host says it is now", async () => {
    expect(await setShared(host(async (on) => on), true)).toEqual({ kind: "shared", on: true });
    expect(await setShared(host(async () => false), true)).toEqual({ kind: "shared", on: false });
  });

  it("tells a refusal from a failure", async () => {
    expect(await setShared(host(async () => { throw new PqpAppError("not-allowed"); }), true)).toEqual({ kind: "refused" });
    expect(await setShared(host(async () => { throw new PqpAppError("unavailable"); }), true)).toEqual({ kind: "failed" });
    expect(await setShared(host(async () => { throw new PqpAppError("rate-limited"); }), true)).toEqual({ kind: "failed" });
  });
});

/**
 * The page in miniature: it owns whether the pane is shared, its own switch
 * (`page.toggle`) changes that, and it pushes every change, as the real bridge
 * host does (`BridgeHost.setShared`).
 */
function fakePage() {
  let shared = false;
  const listeners = new Set<(on: boolean) => void>();
  const set = (on: boolean) => {
    if (shared === on) return;
    shared = on;
    for (const listener of listeners) listener(on);
  };
  return {
    get shared() {
      return shared;
    },
    toggle: () => set(!shared),
    share: {
      request: async (on: boolean) => {
        set(on);
        return shared;
      },
    },
    on: (_event: "share", callback: (on: boolean) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
}

describe("the pill and the page's switch say the same thing", () => {
  it("the page's switch turns the pill on and off", () => {
    const page = fakePage();
    const control = createShareControl(page, () => {});
    control.setAvailable(true);
    page.toggle();
    expect(control.view()).toEqual({ on: true, busy: false });
    page.toggle();
    expect(control.view()).toEqual({ on: false, busy: false });
  });

  it("the pill turns the page's switch on and off", async () => {
    const page = fakePage();
    const control = createShareControl(page, () => {});
    control.setAvailable(true);
    expect(await control.toggle()).toBe("started");
    expect(page.shared).toBe(true);
    expect(control.view()).toEqual({ on: true, busy: false });
    expect(await control.toggle()).toBe(null);
    expect(page.shared).toBe(false);
    expect(control.view()?.on).toBe(false);
  });

  it("a share stopped elsewhere (the call's own stop) means the next press starts, not stops", async () => {
    const page = fakePage();
    const control = createShareControl(page, () => {});
    control.setAvailable(true);
    await control.toggle();
    page.toggle(); // stopped from the page
    expect(control.sharing).toBe(false);
    await control.toggle();
    expect(page.shared).toBe(true);
  });

  it("a page push that arrives while a request runs wins over that request's late answer", async () => {
    let answer: (on: boolean) => void = () => {};
    const listeners = new Set<(on: boolean) => void>();
    const page = {
      share: { request: () => new Promise<boolean>((resolve) => (answer = resolve)) },
      on: (_event: "share", callback: (on: boolean) => void) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    };
    const control = createShareControl(page, () => {});
    control.setAvailable(true);
    const pressed = control.toggle(); // asks to start
    for (const listener of listeners) listener(true); // the page started it
    for (const listener of listeners) listener(false); // and the call bar stopped it
    answer(true); // the late answer to the start
    await pressed;
    expect(control.sharing).toBe(false);
  });

  it("keeps a push that came before the probe, and draws nothing until sharing is offered", () => {
    const page = fakePage();
    const changes: number[] = [];
    const control = createShareControl(page, () => changes.push(1));
    page.toggle();
    expect(control.view()).toBeNull();
    control.setAvailable(true);
    expect(control.view()).toEqual({ on: true, busy: false });
    expect(changes.length).toBe(2);
  });
});

describe("what a watcher is told they are watching", () => {
  const seat = (displayName: string, role = "player") => ({ displayName, role });

  it("names the players, never the other watchers", () => {
    expect(spectatorNames([seat("Ana"), seat("Bia"), seat("Caio", "spectator")])).toEqual({ shown: ["Ana", "Bia"], more: 0 });
  });

  it("stops at three names and counts the rest", () => {
    const players = ["A", "B", "C", "D", "E"].map((name) => seat(name));
    expect(spectatorNames(players)).toEqual({ shown: ["A", "B", "C"], more: 2 });
    expect(WATCHER_NAMES_SHOWN).toBe(3);
  });

  it("has nobody to name in an empty room", () => {
    expect(spectatorNames([])).toEqual({ shown: [], more: 0 });
    expect(spectatorNames([seat("Caio", "spectator")])).toEqual({ shown: [], more: 0 });
  });

  it("keeps a name a stranger typed as plain text, untouched", () => {
    expect(spectatorNames([seat("<b>x</b> $& {name}")]).shown).toEqual(["<b>x</b> $& {name}"]);
  });
});
