import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registerSW = vi.fn(() => async () => {});
vi.mock("virtual:pwa-register", () => ({ registerSW }));

import {
  HOME_REGISTER_DELAY_MS,
  registerServiceWorker,
  watchInstallFailures,
} from "./register-sw";

type Listener = () => void;

function stubBrowser(opts: { path: string; existingRegistration: boolean }) {
  const listeners = new Map<string, Listener[]>();
  vi.stubGlobal("window", {
    location: { pathname: opts.path },
    addEventListener: (name: string, fn: Listener) =>
      listeners.set(name, [...(listeners.get(name) ?? []), fn]),
    removeEventListener: (name: string, fn: Listener) =>
      listeners.set(
        name,
        (listeners.get(name) ?? []).filter((l) => l !== fn),
      ),
    setTimeout,
    clearTimeout,
  });
  vi.stubGlobal("navigator", {
    serviceWorker: {
      getRegistration: async () =>
        opts.existingRegistration ? {} : undefined,
    },
  });
  return {
    fire: (name: string) => (listeners.get(name) ?? []).forEach((l) => l()),
  };
}

/** Let the promise chains inside `registerServiceWorker` run. */
async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
  await vi.advanceTimersByTimeAsync(0);
}

describe("registerServiceWorker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    registerSW.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("registers at once on every route but the marketing home page", async () => {
    stubBrowser({ path: "/app", existingRegistration: false });
    registerServiceWorker(() => {});
    await settle();
    expect(registerSW).toHaveBeenCalledTimes(1);
  });

  it("registers at once on the home page for somebody who already has a worker", async () => {
    stubBrowser({ path: "/", existingRegistration: true });
    registerServiceWorker(() => {});
    await settle();
    expect(registerSW).toHaveBeenCalledTimes(1);
  });

  it("holds a first-time home page visitor back, so a reader who leaves downloads nothing", async () => {
    stubBrowser({ path: "/", existingRegistration: false });
    registerServiceWorker(() => {});
    await settle();
    expect(registerSW).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HOME_REGISTER_DELAY_MS - 1000);
    expect(registerSW).not.toHaveBeenCalled();
  });

  it("registers on the first touch, click or key press", async () => {
    for (const name of ["pointerdown", "keydown", "touchstart"]) {
      registerSW.mockClear();
      const browser = stubBrowser({ path: "/", existingRegistration: false });
      registerServiceWorker(() => {});
      await settle();
      browser.fire(name);
      await settle();
      expect(registerSW, name).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    }
  });

  it("registers for somebody who stays", async () => {
    stubBrowser({ path: "/", existingRegistration: false });
    registerServiceWorker(() => {});
    await settle();
    await vi.advanceTimersByTimeAsync(HOME_REGISTER_DELAY_MS + 10);
    await settle();
    expect(registerSW).toHaveBeenCalledTimes(1);
  });

  it("treats a trailing slash on the home route as the home route", async () => {
    stubBrowser({ path: "//", existingRegistration: false });
    registerServiceWorker(() => {});
    await settle();
    expect(registerSW).not.toHaveBeenCalled();
  });

  it("registers nothing after it is disposed", async () => {
    const browser = stubBrowser({ path: "/", existingRegistration: false });
    const controls = registerServiceWorker(() => {});
    await settle();
    controls.dispose();
    browser.fire("pointerdown");
    await vi.advanceTimersByTimeAsync(HOME_REGISTER_DELAY_MS * 2);
    await settle();
    expect(registerSW).not.toHaveBeenCalled();
  });
});

describe("watchInstallFailures", () => {
  class FakeWorker extends EventTarget {
    state = "installing";
    go(state: string) {
      this.state = state;
      this.dispatchEvent(new Event("statechange"));
    }
  }
  class FakeRegistration extends EventTarget {
    installing: FakeWorker | null = null;
  }

  function setup(initial: FakeWorker | null) {
    const registration = new FakeRegistration();
    registration.installing = initial;
    const failed = vi.fn();
    watchInstallFailures(registration as unknown as ServiceWorkerRegistration, failed);
    return { registration, failed };
  }

  it("reports a worker that goes redundant while installing", () => {
    const worker = new FakeWorker();
    const { failed } = setup(worker);
    worker.go("redundant");
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("does not report a worker that installed and was later replaced", () => {
    const worker = new FakeWorker();
    const { failed } = setup(worker);
    worker.go("installed");
    worker.go("activating");
    worker.go("activated");
    worker.go("redundant");
    expect(failed).not.toHaveBeenCalled();
  });

  it("watches an update found after registration", () => {
    const { registration, failed } = setup(null);
    const update = new FakeWorker();
    registration.installing = update;
    registration.dispatchEvent(new Event("updatefound"));
    update.go("redundant");
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
