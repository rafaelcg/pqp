import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registerSW = vi.fn(() => async () => {});
vi.mock("virtual:pwa-register", () => ({ registerSW }));

import {
  HOME_REGISTER_DELAY_MS,
  installCauseAttributes,
  installFailureReporter,
  onceAcrossTabs,
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

describe("installFailureReporter", () => {
  const cause = {
    type: "PQP_SW_INSTALL_FAILED",
    build: "b1",
    reason: "bad-precaching-response",
    path: "/robots.txt",
    status: 404,
  };
  const withCause = { reason: "bad-precaching-response", path: "/robots.txt", status: "404", build: "b1" };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the cause once when it arrives before the outcome", () => {
    const report = vi.fn();
    const r = installFailureReporter(report, 3000);
    r.cause(cause);
    vi.advanceTimersByTime(10);
    r.failed();
    vi.advanceTimersByTime(5000);
    expect(report.mock.calls).toEqual([[withCause]]);
  });

  it("reports the cause once when it arrives after the outcome", () => {
    const report = vi.fn();
    const r = installFailureReporter(report, 3000);
    r.failed();
    vi.advanceTimersByTime(500);
    r.cause(cause);
    vi.advanceTimersByTime(5000);
    expect(report.mock.calls).toEqual([[withCause]]);
  });

  it("reports the outcome alone when no cause comes (a worker from before the message)", () => {
    const report = vi.fn();
    const r = installFailureReporter(report, 3000);
    r.failed();
    vi.advanceTimersByTime(2999);
    expect(report).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(report.mock.calls).toEqual([[{ reason: "unknown", path: "", status: "0", build: "" }]]);
  });

  it("ignores messages that are not ours", () => {
    const report = vi.fn();
    const r = installFailureReporter(report);
    r.cause({ type: "PQP_BUILD" });
    r.cause("hello");
    r.cause(null);
    expect(report).not.toHaveBeenCalled();
  });

  it("bounds what a message can put in an event", () => {
    expect(
      installCauseAttributes({ type: "PQP_SW_INSTALL_FAILED", path: "x".repeat(500), status: "404" }),
    ).toEqual({ reason: "unknown", path: "x".repeat(200), status: "0", build: "" });
  });
});

describe("onceAcrossTabs", () => {
  function stubStorage() {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    });
    return data;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs once for two tabs reporting the same failure, through the lock", async () => {
    stubStorage();
    let chain = Promise.resolve();
    const names: string[] = [];
    vi.stubGlobal("navigator", {
      locks: {
        // One queue for every caller, like a real exclusive lock.
        request: (name: string, cb: () => Promise<void>) => {
          names.push(name);
          chain = chain.then(cb);
          return chain;
        },
      },
    });
    const fn = vi.fn();
    await Promise.all([onceAcrossTabs("b1|/robots.txt|404", fn), onceAcrossTabs("b1|/robots.txt|404", fn)]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(names[0]).toBe("pqp:sw-install-reported:b1|/robots.txt|404");
  });

  it("dedupes on storage alone without Web Locks, and runs again after the window", async () => {
    stubStorage();
    vi.stubGlobal("navigator", {});
    const fn = vi.fn();
    await onceAcrossTabs("k", fn, 1000);
    await onceAcrossTabs("k", fn, 1000);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 1001);
    await onceAcrossTabs("k", fn, 1000);
    vi.useRealTimers();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("still reports when storage throws", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    vi.stubGlobal("navigator", {});
    const fn = vi.fn();
    await onceAcrossTabs("k", fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
