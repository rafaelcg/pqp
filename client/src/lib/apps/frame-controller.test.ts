// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountAppFrame, type AppFrameController, type AppFrameStatus } from "./frame-controller";
import { FRAME_POLICY_ATTRIBUTE } from "./frame-policy";
import { FakeTheme, FakeTransport, baseApp, users } from "./bridge-host.fixture";
import { AppTransportError } from "./types";

const APPS = "http://localhost:5175";
const HELLO = { pqp: "app-hello", platformApi: 1 };

let container: HTMLElement;
const mounted: AppFrameController[] = [];

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => {
  for (const controller of mounted.splice(0)) controller.destroy();
  container.remove();
  document.head.querySelectorAll("meta").forEach((meta) => meta.remove());
  vi.useRealTimers();
});

function mount(overrides: Partial<Parameters<typeof mountAppFrame>[0]> = {}) {
  const transport = (overrides.transport as FakeTransport | undefined) ?? new FakeTransport();
  const statuses: AppFrameStatus[] = [];
  const controller = mountAppFrame({
    container,
    app: baseApp(),
    appsOrigin: APPS,
    title: "Eco",
    transport,
    users,
    locale: () => "pt-BR",
    host: { theme: new FakeTheme(), fetchImpl: (async () => new Response("no", { status: 404 })) as typeof fetch },
    onStatus: (status) => statuses.push(status),
    ...overrides,
  });
  mounted.push(controller);
  const iframe = container.querySelector("iframe");
  return { controller, transport, statuses, iframe };
}

/** A `message` event as the browser would deliver one from `source`. */
function post(source: unknown, data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data, source: source as MessageEventSource }));
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("the frame", () => {
  it("is a sandbox with allow-scripts and nothing else, no permissions, no referrer, and carries the entry URL", () => {
    const { iframe } = mount();
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe!.getAttribute("allow")).toBe("");
    expect(iframe!.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe!.getAttribute("title")).toBe("Eco");
    expect(iframe!.getAttribute("src")).toBe("http://localhost:5175/pqp-eco/1.0.0/index.html");
    expect(iframe!.getAttribute("sandbox")).not.toContain("allow-same-origin");
  });

  it("puts the frame-src policy in the head before the frame has a src, and only once", () => {
    const policyInHeadWhenSrcWasSet: boolean[] = [];
    const real = Element.prototype.setAttribute;
    vi.spyOn(Element.prototype, "setAttribute").mockImplementation(function (this: Element, name: string, value: string) {
      if (this instanceof HTMLIFrameElement && name === "src") {
        policyInHeadWhenSrcWasSet.push(document.head.querySelector(`meta[${FRAME_POLICY_ATTRIBUTE}]`) !== null);
      }
      return real.call(this, name, value);
    });
    mount();
    mount({ app: baseApp({ id: "pqp-other", entry: { url: "http://localhost:5175/pqp-other/1.0.0/index.html" } }) });
    vi.restoreAllMocks();
    expect(policyInHeadWhenSrcWasSet).toEqual([true, true]);
    expect(document.head.querySelectorAll(`meta[${FRAME_POLICY_ATTRIBUTE}]`)).toHaveLength(1);
    expect(document.head.querySelector(`meta[${FRAME_POLICY_ATTRIBUTE}]`)!.getAttribute("content")).toContain(
      "frame-src 'self' blob: http://localhost:5175",
    );
    expect(container.querySelectorAll("iframe")).toHaveLength(2);
  });

  it("frames nothing whose entry URL is not on the apps origin", () => {
    const { iframe, controller, transport, statuses } = mount({
      app: baseApp({ entry: { url: "https://evil.example/pqp-eco/1.0.0/index.html" } }),
    });
    expect(iframe).toBeNull();
    expect(controller.status).toEqual({ kind: "error", reason: "bad-entry" });
    expect(statuses).toEqual([{ kind: "error", reason: "bad-entry" }]);
    expect(transport.handlers).toBeNull(); // no seat was taken
    expect(document.head.querySelector(`meta[${FRAME_POLICY_ATTRIBUTE}]`)).toBeNull();
  });
});

describe("the handshake", () => {
  it("answers app-hello only from this frame's window, with a transferred port, once the seat exists", async () => {
    const { iframe, statuses } = mount();
    const target = iframe!.contentWindow!;
    const spy = vi.spyOn(target, "postMessage").mockImplementation(() => {});

    post(window, HELLO); // the page itself
    post(null, HELLO);
    post({}, HELLO); // some other window
    await flush();
    expect(spy).not.toHaveBeenCalled();

    post(target, { pqp: "app-hello", platformApi: 1, extra: true }); // strict: unknown key
    post(target, { pqp: "app-hello" });
    post(target, "app-hello");
    post(target, null);
    await flush();
    expect(spy).not.toHaveBeenCalled();

    post(target, HELLO);
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    const [message, targetOrigin, transfer] = spy.mock.calls[0] as unknown as [unknown, string, unknown[]];
    expect(message).toEqual({ pqp: "app-port", platformApi: 1 });
    expect(targetOrigin).toBe("*");
    expect(transfer).toHaveLength(1);
    expect(transfer[0]).toBeInstanceOf(MessagePort);
    expect(statuses.at(-1)).toEqual({ kind: "ready" });

    post(target, HELLO); // a second hello gets no second port
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not answer a hello that arrived before the seat was taken until it is", async () => {
    const transport = new FakeTransport();
    let release!: () => void;
    transport.join = () =>
      new Promise((resolve) => {
        release = () => resolve(transport.snapshot);
      });
    const { iframe } = mount({ transport });
    const target = iframe!.contentWindow!;
    const spy = vi.spyOn(target, "postMessage").mockImplementation(() => {});
    post(target, HELLO);
    await flush();
    expect(spy).not.toHaveBeenCalled();
    release();
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("removes the frame and reports join-failed with the code when the seat is refused", async () => {
    const transport = new FakeTransport();
    transport.joinError = new AppTransportError("full");
    const { controller, statuses } = mount({ transport });
    await flush();
    expect(container.querySelector("iframe")).toBeNull();
    expect(controller.status).toEqual({ kind: "error", reason: "join-failed", code: "full" });
    expect(statuses.at(-1)).toEqual({ kind: "error", reason: "join-failed", code: "full" });
  });

  it("times out when the frame never says hello", async () => {
    vi.useFakeTimers();
    const { controller } = mount({ helloTimeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(container.querySelector("iframe")).toBeNull();
    expect(controller.status).toEqual({ kind: "error", reason: "timeout" });
  });
});

describe("a join that never settles", () => {
  it("still ends in a timeout after an early hello, and releases the seat if the join lands later", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    let release!: () => void;
    transport.join = () =>
      new Promise((resolve) => {
        release = () => resolve(transport.snapshot);
      });
    const { iframe, controller } = mount({ transport, helloTimeoutMs: 5000 });
    const target = iframe!.contentWindow!;
    const spy = vi.spyOn(target, "postMessage").mockImplementation(() => {});
    post(target, HELLO); // the frame is quick, the session is not
    await vi.advanceTimersByTimeAsync(5000);
    expect(controller.status).toEqual({ kind: "error", reason: "timeout" });
    expect(container.querySelector("iframe")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(transport.left).toBe(1);
  });
});

describe("a frame that navigates itself", () => {
  it("is removed on its second load event, and the seat is released", async () => {
    const { iframe, controller, transport, statuses } = mount();
    const target = iframe!.contentWindow!;
    vi.spyOn(target, "postMessage").mockImplementation(() => {});
    post(target, HELLO);
    await flush();
    expect(controller.status.kind).toBe("ready");

    iframe!.dispatchEvent(new Event("load")); // the document it was given
    expect(container.querySelector("iframe")).toBe(iframe);
    iframe!.dispatchEvent(new Event("load")); // it went somewhere else
    expect(container.querySelector("iframe")).toBeNull();
    expect(controller.status).toEqual({ kind: "error", reason: "frame-navigated" });
    expect(statuses.at(-1)).toEqual({ kind: "error", reason: "frame-navigated" });
    expect(transport.left).toBe(1);
    expect(transport.handlers).toBeNull();
  });
});

describe("the session ending and the page leaving", () => {
  it("reports ended with the reason", async () => {
    const { transport, statuses } = mount();
    await flush();
    transport.handlers!.onEnded("moderator");
    expect(statuses.at(-1)).toEqual({ kind: "ended", reason: "moderator" });
  });

  it("destroy removes the frame, releases the seat and goes quiet", async () => {
    const { controller, transport, statuses } = mount();
    await flush();
    controller.destroy();
    controller.destroy();
    expect(container.querySelector("iframe")).toBeNull();
    expect(transport.left).toBe(1);
    const count = statuses.length;
    post(window, HELLO);
    expect(statuses.length).toBe(count);
  });

  it("focus() puts focus on the frame", () => {
    const { controller, iframe } = mount();
    const focus = vi.spyOn(iframe!, "focus");
    controller.focus();
    expect(focus).toHaveBeenCalled();
  });
});
