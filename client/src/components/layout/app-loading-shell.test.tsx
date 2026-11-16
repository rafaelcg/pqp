// @vitest-environment jsdom
import { act, lazy, Suspense, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { resetRedesignForTests, setRedesignFlag } from "@/lib/redesign";
import {
  AppBootstrapError,
  AppLoadingShell,
  BootShellHold,
  BootShellHost,
} from "./app-loading-shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let frame: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  frame?.remove();
  root = null;
  frame = null;
  resetRedesignForTests();
});

async function mountError(): Promise<HTMLElement> {
  frame = document.createElement("div");
  document.body.append(frame);
  root = createRoot(frame);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <AppBootstrapError message="Não deu pra falar com o servidor (502)." onRetry={() => {}} />
      </MemoryRouter>,
    );
  });
  return frame;
}

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

describe("AppBootstrapError", () => {
  it("under the redesign, puts a big Breu and his bubble beside the text on a wide screen", async () => {
    setRedesignFlag(true);
    const page = await mountError();
    const side = page.querySelector("[data-bootstrap-breu]");
    expect(side).not.toBeNull();
    expect(side!.getAttribute("aria-hidden")).toBe("true");
    expect(side!.className).toContain("hidden");
    expect(side!.className).toContain("sm:block");

    const breu = side!.querySelector('[data-breu-motion="oops"]');
    expect(breu).not.toBeNull();
    expect(breu!.className).toContain("h-60");
    expect(breu!.querySelector('[data-face="triste"]')).not.toBeNull();

    const bubble = side!.querySelector("[data-breu-bubble]");
    expect(bubble?.textContent).toBe("pqp!");
    expect(bubble!.getAttribute("aria-hidden")).toBe("true");

    // Reduced motion: no drop, no sway, the bubble shown at once.
    const moving = [breu!, breu!.firstElementChild!, bubble!];
    for (const node of moving) {
      expect(node.className).toMatch(/animate-\[breu-(oops-drop|oops-sway|bubble-pop)_/);
      expect(node.className).toContain("motion-reduce:animate-none");
    }

    // The small Breu stays for a narrow screen only, and the alert is the message.
    const small = page.querySelector('[role="alert"] [data-face="triste"]');
    expect(small?.getAttribute("class")).toContain("sm:hidden");
    expect(page.querySelector('[role="alert"]')?.textContent).toContain("(502)");
    expect(page.querySelector('[role="alert"]')?.textContent).not.toContain("pqp!");
  });

  it("keeps the old look as it was", async () => {
    const page = await mountError();
    expect(page.querySelector("[data-bootstrap-breu]")).toBeNull();
    expect(page.querySelector("[data-breu-bubble]")).toBeNull();
    expect(page.querySelector('[data-face="triste"]')?.getAttribute("class")).not.toContain(
      "sm:hidden",
    );
  });
});
