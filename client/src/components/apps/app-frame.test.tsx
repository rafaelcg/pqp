// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeTransport, baseApp, users } from "@/lib/apps/bridge-host.fixture";
import { AppFrame, type AppFrameHandle, type AppFrameStatus } from "./app-frame";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.head.querySelectorAll("meta").forEach((meta) => meta.remove());
});

function render(props: Partial<React.ComponentProps<typeof AppFrame>> = {}, ref?: React.Ref<AppFrameHandle>) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const transport = (props.transport as FakeTransport | undefined) ?? new FakeTransport();
  act(() => {
    root!.render(
      <AppFrame
        ref={ref}
        app={baseApp()}
        appsOrigin="http://localhost:5175"
        transport={transport}
        users={users}
        title="Eco"
        locale="pt-BR"
        {...props}
      />,
    );
  });
  return { transport };
}

async function tick() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("AppFrame", () => {
  it("renders a wrapper that holds one sandboxed frame, loading at first", () => {
    render();
    const wrapper = host!.querySelector("[data-app-frame-host]") as HTMLElement;
    expect(wrapper.dataset.status).toBe("loading");
    const frames = wrapper.querySelectorAll("iframe");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frames[0]!.getAttribute("title")).toBe("Eco");
  });

  it("takes the seat on mount and releases it on unmount", async () => {
    const { transport } = render();
    await tick();
    expect(transport.handlers).not.toBeNull();
    expect(transport.left).toBe(0);
    act(() => root!.unmount());
    root = null;
    expect(transport.left).toBe(1);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("reports an error status through the callback and the wrapper, with the join code", async () => {
    const transport = new FakeTransport();
    const { AppTransportError } = await import("@/lib/apps/types");
    transport.joinError = new AppTransportError("not-allowed");
    const statuses: AppFrameStatus[] = [];
    render({ transport, onStatus: (status) => statuses.push(status) });
    await tick();
    expect(statuses.at(-1)).toEqual({ kind: "error", reason: "join-failed", code: "not-allowed" });
    expect((host!.querySelector("[data-app-frame-host]") as HTMLElement).dataset.status).toBe("error");
    expect(host!.querySelector("iframe")).toBeNull();
  });

  it("reports a bad entry URL at once", () => {
    const statuses: AppFrameStatus[] = [];
    render({ app: baseApp({ entry: { url: "https://evil.example/x/index.html" } }), onStatus: (s) => statuses.push(s) });
    expect(statuses).toEqual([{ kind: "error", reason: "bad-entry" }]);
    expect((host!.querySelector("[data-app-frame-host]") as HTMLElement).dataset.status).toBe("error");
  });

  it("reports ended", async () => {
    const statuses: AppFrameStatus[] = [];
    const { transport } = render({ onStatus: (status) => statuses.push(status) });
    await tick();
    act(() => transport.handlers!.onEnded("host"));
    expect(statuses.at(-1)).toEqual({ kind: "ended", reason: "host" });
    expect((host!.querySelector("[data-app-frame-host]") as HTMLElement).dataset.status).toBe("ended");
  });

  it("hands focus to the frame through its ref", () => {
    const ref = createRef<AppFrameHandle>();
    render({}, ref);
    const focus = vi.spyOn(host!.querySelector("iframe")!, "focus");
    ref.current!.focus();
    expect(focus).toHaveBeenCalled();
  });

  it("does not remount the frame when only a callback or the locale changes", async () => {
    const { transport } = render();
    const first = host!.querySelector("iframe");
    act(() => {
      root!.render(
        <AppFrame
          app={baseApp()}
          appsOrigin="http://localhost:5175"
          transport={transport}
          users={users}
          title="Eco"
          locale="en"
          onStatus={() => {}}
        />,
      );
    });
    await tick();
    expect(host!.querySelector("iframe")).toBe(first);
    expect(transport.left).toBe(0);
  });
});
