import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { swBuildScript } from "./sw-build-script";

/**
 * Runs the generated worker script in a sandbox with a fake worker scope, so the
 * navigation rules can be tested without a browser. (The real worker is covered
 * by `e2e/stale-bundle/`.)
 */

type Listener = (event: unknown) => void;

class FakeResponse {
  constructor(
    readonly body: string,
    readonly init: { status?: number; type?: string } = {},
  ) {}
  get ok() {
    const status = this.init.status ?? 200;
    return status >= 200 && status < 300;
  }
  get type() {
    return this.init.type ?? "basic";
  }
  static error() {
    return new FakeResponse("error", { status: 0, type: "error" });
  }
}

function makeScope(options: {
  fetchImpl?: (request: unknown) => Promise<unknown>;
  shell?: unknown;
  timeoutMs?: number;
  clients?: { postMessage: (message: unknown) => void }[];
}) {
  const listeners: Record<string, Listener[]> = {};
  const fetched: unknown[] = [];
  const scope: Record<string, unknown> = {
    location: { origin: "https://pqp.gg" },
    caches: {
      match: async (url: string, opts: { ignoreSearch?: boolean }) => {
        expect(url).toBe("/index.html");
        expect(opts.ignoreSearch).toBe(true);
        return options.shell;
      },
    },
    fetch: (request: unknown) => {
      fetched.push(request);
      return (options.fetchImpl ?? (async () => new FakeResponse("network")))(request);
    },
    Response: FakeResponse,
    URL,
    RegExp,
    Promise,
    setTimeout,
    clearTimeout,
    addEventListener: (type: string, listener: Listener) => {
      (listeners[type] ??= []).push(listener);
    },
    clients: {
      matchAll: async (opts: { type?: string; includeUncontrolled?: boolean }) => {
        expect(opts).toEqual({ type: "window", includeUncontrolled: true });
        return options.clients ?? [];
      },
    },
  };
  scope.self = scope;
  vm.runInNewContext(swBuildScript("abc123", { timeoutMs: options.timeoutMs ?? 30 }), scope);

  async function navigate(
    url: string,
    init: { mode?: string; method?: string } = {},
  ): Promise<any> {
    let responded: Promise<unknown> | null = null;
    const event = {
      request: { url, mode: init.mode ?? "navigate", method: init.method ?? "GET" },
      respondWith: (p: Promise<unknown>) => {
        responded = p;
      },
    };
    for (const listener of listeners.fetch ?? []) {
      listener(event);
    }
    return responded ? await responded : undefined;
  }
  return { scope, listeners, navigate, fetched };
}

describe("the worker's build stamp", () => {
  it("answers PQP_BUILD on the port it was given", () => {
    const { listeners } = makeScope({});
    const posted: unknown[] = [];
    listeners.message![0]!({
      data: { type: "PQP_BUILD" },
      ports: [{ postMessage: (m: unknown) => posted.push(m) }],
    });
    expect(posted).toEqual([{ build: "abc123" }]);
  });

  it("ignores other messages (Workbox's SKIP_WAITING is not ours)", () => {
    const { listeners } = makeScope({});
    const posted: unknown[] = [];
    listeners.message![0]!({
      data: { type: "SKIP_WAITING" },
      ports: [{ postMessage: (m: unknown) => posted.push(m) }],
    });
    expect(posted).toEqual([]);
  });
});

describe("the legacy fixture (no navigation handler)", () => {
  it("keeps the stamp and registers no fetch listener", () => {
    const listeners: Record<string, unknown[]> = {};
    const scope: Record<string, unknown> = {
      addEventListener: (type: string, l: unknown) => {
        (listeners[type] ??= []).push(l);
      },
    };
    scope.self = scope;
    vm.runInNewContext(swBuildScript("old", { navigation: false }), scope);
    expect(scope.__PQP_BUILD__).toBe("old");
    expect(listeners.message).toHaveLength(1);
    expect(listeners.fetch).toBeUndefined();
  });
});

describe("navigations are answered network-first", () => {
  it("serves the network's page, not the precached shell, when the network answers", async () => {
    const t = makeScope({ shell: { body: "OLD SHELL" } });
    const response = await t.navigate("https://pqp.gg/app");
    expect(response.body).toBe("network");
    expect(t.fetched).toHaveLength(1);
  });

  it("serves the precached shell when the network fails", async () => {
    const shell = { body: "SHELL" };
    const t = makeScope({
      shell,
      fetchImpl: async () => {
        throw new TypeError("offline");
      },
    });
    expect(await t.navigate("https://pqp.gg/app")).toBe(shell);
  });

  it("serves the precached shell when the network does not answer in time", async () => {
    const shell = { body: "SHELL" };
    const t = makeScope({ shell, timeoutMs: 10, fetchImpl: () => new Promise(() => {}) });
    expect(await t.navigate("https://pqp.gg/app")).toBe(shell);
  });

  it("prefers the shell to a server error", async () => {
    const shell = { body: "SHELL" };
    const t = makeScope({
      shell,
      fetchImpl: async () => new FakeResponse("boom", { status: 503 }),
    });
    expect(await t.navigate("https://pqp.gg/app")).toBe(shell);
  });

  it("returns the server's error when there is no shell to fall back to", async () => {
    const t = makeScope({
      shell: undefined,
      fetchImpl: async () => new FakeResponse("boom", { status: 503 }),
    });
    expect((await t.navigate("https://pqp.gg/app")).body).toBe("boom");
  });

  it("returns a redirect as the answer (a navigation fetch reports one as opaque)", async () => {
    const t = makeScope({
      shell: { body: "SHELL" },
      fetchImpl: async () => new FakeResponse("", { status: 0, type: "opaqueredirect" }),
    });
    expect((await t.navigate("https://pqp.gg/index.html")).type).toBe(
      "opaqueredirect",
    );
  });

  it("waits for a slow network when there is no shell at all", async () => {
    const t = makeScope({
      shell: undefined,
      timeoutMs: 5,
      fetchImpl: () =>
        new Promise((resolve) => setTimeout(() => resolve(new FakeResponse("late")), 40)),
    });
    expect((await t.navigate("https://pqp.gg/app")).body).toBe("late");
  });
});

describe("what it leaves alone", () => {
  it("does not answer a subresource or a non-GET", async () => {
    const t = makeScope({});
    expect(await t.navigate("https://pqp.gg/assets/a.js", { mode: "no-cors" })).toBeUndefined();
    expect(await t.navigate("https://pqp.gg/app", { method: "POST" })).toBeUndefined();
    expect(t.fetched).toHaveLength(0);
  });

  it("does not answer another origin", async () => {
    const t = makeScope({});
    expect(await t.navigate("https://example.com/app")).toBeUndefined();
  });

  it("does not answer the paths the shell must never stand in for", async () => {
    const t = makeScope({});
    for (const path of [
      "/api/status",
      "/status.json",
      "/ws",
      "/r/abc",
      "/.well-known/security.txt",
      "/llms.txt",
      "/llms-full.txt",
      "/index.md",
      "/robots.txt",
      "/sitemap.xml",
    ]) {
      expect(await t.navigate(`https://pqp.gg${path}`)).toBeUndefined();
    }
    expect(t.fetched).toHaveLength(0);
  });

  it("does answer ordinary app routes, including ones that merely start like a denied word", async () => {
    const t = makeScope({});
    for (const path of ["/", "/app", "/app/dm", "/@rafa", "/c/valorant", "/tela", "/robots"]) {
      expect(await t.navigate(`https://pqp.gg${path}`)).toBeDefined();
    }
  });
});

describe("a failed install says why", () => {
  /** Dispatch `install`, then pass `work` to waitUntil the way Workbox does. */
  function install(t: ReturnType<typeof makeScope>, ...work: Promise<unknown>[]) {
    const extended: Promise<unknown>[] = [];
    const event = {
      waitUntil(promise: Promise<unknown>) {
        extended.push(promise);
      },
    };
    for (const listener of t.listeners.install ?? []) {
      listener(event);
    }
    for (const promise of work) {
      event.waitUntil(promise);
    }
    return extended;
  }

  function precacheError(url: string, status: number) {
    return Object.assign(new Error("bad-precaching-response"), {
      name: "bad-precaching-response",
      details: { url, status },
    });
  }

  it("posts the failing path, status and reason to every page, then still fails", async () => {
    const posted: unknown[] = [];
    const page = { postMessage: (message: unknown) => posted.push(message) };
    const t = makeScope({ clients: [page, page] });
    const error = precacheError("https://pqp.gg/robots.txt?__WB_REVISION__=abc", 404);

    const [extended] = install(t, Promise.reject(error));

    await expect(extended).rejects.toBe(error);
    expect(posted).toHaveLength(2);
    expect(posted[0]).toEqual({
      type: "PQP_SW_INSTALL_FAILED",
      build: "abc123",
      reason: "bad-precaching-response",
      path: "/robots.txt",
      status: 404,
      report: true,
    });
  });

  it("asks exactly one page to report: the focused one, else a visible one", async () => {
    const posted: { name: string; report: boolean }[] = [];
    const page = (name: string, extra: Record<string, unknown>) => ({
      ...extra,
      postMessage: (m: unknown) => {
        posted.push({ name, report: (m as { report: boolean }).report });
      },
    });
    const t = makeScope({
      clients: [
        page("hidden", { visibilityState: "hidden" }),
        page("visible", { visibilityState: "visible" }),
        page("focused", { focused: true, visibilityState: "visible" }),
      ],
    });
    await Promise.allSettled(install(t, Promise.reject(precacheError("https://pqp.gg/a.js", 404))));
    expect(posted).toEqual([
      { name: "hidden", report: false },
      { name: "visible", report: false },
      { name: "focused", report: true },
    ]);
  });

  it("reports once when several promises of the same install reject", async () => {
    const posted: unknown[] = [];
    const t = makeScope({ clients: [{ postMessage: (m: unknown) => posted.push(m) }] });
    const extended = install(
      t,
      Promise.reject(precacheError("https://pqp.gg/a.js", 404)),
      Promise.reject(precacheError("https://pqp.gg/b.js", 500)),
    );
    await Promise.allSettled(extended);
    expect(posted).toHaveLength(1);
  });

  it("posts nothing for an install that succeeds", async () => {
    const posted: unknown[] = [];
    const t = makeScope({ clients: [{ postMessage: (m: unknown) => posted.push(m) }] });
    const [extended] = install(t, Promise.resolve("done"));
    await expect(extended).resolves.toBe("done");
    expect(posted).toEqual([]);
  });

  it("an error with no details still reports its name", async () => {
    const posted: unknown[] = [];
    const t = makeScope({ clients: [{ postMessage: (m: unknown) => posted.push(m) }] });
    const [extended] = install(t, Promise.reject(new TypeError("Failed to fetch")));
    await expect(extended).rejects.toThrow("Failed to fetch");
    expect(posted).toEqual([
      { type: "PQP_SW_INSTALL_FAILED", build: "abc123", reason: "TypeError", path: "", status: 0, report: true },
    ]);
  });

  it("is not in the legacy fixture", () => {
    expect(swBuildScript("x", { navigation: false })).not.toContain("PQP_SW_INSTALL_FAILED");
  });
});
