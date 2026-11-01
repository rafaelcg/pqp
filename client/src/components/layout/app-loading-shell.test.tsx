// @vitest-environment jsdom
import { act, lazy, Suspense, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { AppLoadingShell, BootShellHold, BootShellHost } from "./app-loading-shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let frame: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  frame?.remove();
  root = null;
  frame = null;
});

describe("AppLoadingShell", () => {
  it("shows Breu at work, with a reduced-motion variant", () => {
    const html = renderToStaticMarkup(<AppLoadingShell />);
    expect(html).toContain('data-breu-motion="working"');
    expect(html).toContain('data-face="focado"');
    expect(html).toContain("motion-reduce:animate-none");
  });

  it("draws one fixed-size card with the one loading label", () => {
    const html = renderToStaticMarkup(<AppLoadingShell />);
    const card = /<div data-boot-card="" class="([^"]*)"/.exec(html)?.[1] ?? "";
    // Width and height are set, so a longer or shorter word cannot resize it.
    expect(card.split(" ")).toEqual(expect.arrayContaining(["w-44", "redesign:h-32"]));
    expect(html).toContain('aria-label="Loading…"');
    expect(html.match(/data-boot-label=""/g)).toHaveLength(1);
  });
});

describe("BootShellHost", () => {
  it("keeps the same shell mounted from the chunk load through the bootstrap", async () => {
    type Stage = "clerk" | "bootstrap" | "ready";
    let resolveChunk: (value: { default: () => ReactElement }) => void = () => {};
    let advance: (stage: Stage) => void = () => {};

    // Each stage is its own component at its own place in the tree, like the
    // Suspense fallback, `ClerkAppGate` and `MainAppContent`.
    function ClerkStage() {
      return <BootShellHold />;
    }
    function BootstrapStage() {
      return <BootShellHold />;
    }
    function Chat() {
      const [stage, setStage] = useState<Stage>("clerk");
      advance = setStage;
      if (stage === "clerk") {
        return <ClerkStage />;
      }
      if (stage === "bootstrap") {
        return <BootstrapStage />;
      }
      return <p data-chat="">chat</p>;
    }
    const LazyChat = lazy(
      () =>
        new Promise<{ default: () => ReactElement }>((resolve) => {
          resolveChunk = resolve;
        }),
    );

    frame = document.createElement("div");
    document.body.append(frame);
    root = createRoot(frame);
    await act(async () => {
      root!.render(
        <BootShellHost>
          <Suspense fallback={<BootShellHold />}>
            <LazyChat />
          </Suspense>
        </BootShellHost>,
      );
    });

    const breu = frame.querySelector("[data-breu-motion]");
    const card = frame.querySelector("[data-boot-card]");
    const label = () => frame!.querySelector("[data-boot-label]")?.textContent;
    expect(breu).not.toBeNull();
    expect(label()).toBe("Loading…");

    // The chunk lands: the fallback's hold goes, Clerk's comes.
    await act(async () => {
      resolveChunk({ default: Chat });
    });
    expect(frame.querySelector("[data-breu-motion]")).toBe(breu);
    expect(frame.querySelector("[data-boot-card]")).toBe(card);
    expect(label()).toBe("Loading…");

    // Clerk is ready: the bootstrap's hold takes over.
    await act(async () => advance("bootstrap"));
    expect(frame.querySelector("[data-breu-motion]")).toBe(breu);
    expect(frame.querySelector("[data-boot-card]")).toBe(card);
    expect(label()).toBe("Loading…");
    expect(frame.querySelectorAll("[data-boot-card]")).toHaveLength(1);

    // The bootstrap is done: the shell goes and the app is what is left.
    await act(async () => advance("ready"));
    expect(frame.querySelector("[data-boot-card]")).toBeNull();
    expect(frame.querySelector("[data-chat]")).not.toBeNull();
  });

  it("draws the shell itself when no host is above it", () => {
    const html = renderToStaticMarkup(<BootShellHold />);
    expect(html).toContain("data-boot-card");
  });
});
