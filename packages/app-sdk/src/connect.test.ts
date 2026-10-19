import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, PqpAppError } from "./index.js";
import { FakeHost, HELLO } from "./fake-host.fixture.js";

let host: FakeHost;

beforeEach(() => {
  host = new FakeHost();
});
afterEach(() => {
  host.close();
  vi.useRealTimers();
});

async function rejection(promise: Promise<unknown>): Promise<PqpAppError> {
  try {
    await promise;
  } catch (error) {
    return error as PqpAppError;
  }
  throw new Error("expected a rejection");
}

describe("connect", () => {
  it("posts app-hello to the parent with target *, then resolves with the hello payload", async () => {
    const pending = connect({ window: host.window });
    expect(host.posted).toEqual([
      { message: { pqp: "app-hello", platformApi: 1 }, targetOrigin: "*" },
    ]);
    host.accept();
    const app = await pending;
    expect(app.hello).toEqual(HELLO);
    expect(app.connection).toBe("online");
  });

  it("accepts the port only from window.parent", async () => {
    const pending = connect({ window: host.window, timeoutMs: 200 });
    const sibling = { postMessage() {} };
    const stray = new MessageChannel();
    host.deliver({ pqp: "app-port", platformApi: 1 }, { source: sibling, ports: [stray.port2] });
    host.deliver({ pqp: "app-port", platformApi: 1 }, { source: null, ports: [stray.port2] });
    stray.port1.postMessage(HELLO);
    // nothing was accepted, so the call is still waiting
    let settled = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    await host.settle();
    expect(settled).toBe(false);
    host.accept();
    const app = await pending;
    expect(app.hello.app.id).toBe("eco");
    stray.port1.close();
    stray.port2.close();
  });

  it("ignores a port message that is malformed, for another platform api, or without a port", async () => {
    const pending = connect({ window: host.window });
    host.deliver({ pqp: "app-port", platformApi: 2 }, { ports: [new MessageChannel().port2] });
    host.deliver({ pqp: "app-port", platformApi: 1 });
    host.deliver({ pqp: "other", platformApi: 1 }, { ports: [new MessageChannel().port2] });
    host.deliver("app-port");
    host.deliver(null);
    host.accept();
    expect((await pending).hello.self.isHost).toBe(true);
  });

  it("uses only the first port and stops listening afterwards", async () => {
    const pending = connect({ window: host.window });
    host.accept();
    await pending;
    expect(host.listeners.size).toBe(0);
  });

  it("sends the hello again until the host answers, and not after", async () => {
    vi.useFakeTimers();
    const pending = connect({ window: host.window });
    vi.advanceTimersByTime(2500);
    expect(host.posted.length).toBe(3);
    host.accept();
    await pending;
    const count = host.posted.length;
    vi.advanceTimersByTime(5000);
    expect(host.posted.length).toBe(count);
  });

  it("rejects with unavailable when the host never answers", async () => {
    vi.useFakeTimers();
    const pending = connect({ window: host.window, timeoutMs: 5000 });
    const failure = rejection(pending);
    vi.advanceTimersByTime(5000);
    const error = await failure;
    expect(error).toBeInstanceOf(PqpAppError);
    expect(error.code).toBe("unavailable");
    expect(host.listeners.size).toBe(0);
  });

  it("rejects with unavailable when the port arrives but the hello does not", async () => {
    vi.useFakeTimers();
    const pending = connect({ window: host.window, timeoutMs: 5000 });
    const failure = rejection(pending);
    host.deliver({ pqp: "app-port", platformApi: 1 }, { ports: [new MessageChannel().port2] });
    vi.advanceTimersByTime(5000);
    expect((await failure).code).toBe("unavailable");
  });

  it("rejects an unusable hello", async () => {
    const pending = connect({ window: host.window });
    const failure = rejection(pending);
    host.accept({ ...HELLO, platformApi: 2 } as never);
    expect((await failure).code).toBe("unavailable");
  });

  it("rejects at once when the page is not inside a frame", async () => {
    const self: Record<string, unknown> = {
      addEventListener() {},
      removeEventListener() {},
    };
    self.parent = self;
    const error = await rejection(connect({ window: self as never }));
    expect(error.code).toBe("unavailable");
  });

  it("returns the same promise for a second call from the same window, and retries after a failure", async () => {
    const first = connect({ window: host.window, timeoutMs: 100 });
    expect(connect({ window: host.window })).toBe(first);
    host.accept();
    await first;

    vi.useFakeTimers();
    const other = new FakeHost();
    const failing = rejection(connect({ window: other.window, timeoutMs: 100 }));
    vi.advanceTimersByTime(100);
    await failing;
    vi.useRealTimers();
    const again = connect({ window: other.window });
    other.accept();
    expect((await again).hello.app.version).toBe("1.0.0");
    other.close();
  });
});
