// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Outlet, RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScrollToHash } from "./use-scroll-to-hash";

/**
 * Which navigations land on the section a `#fragment` names.
 *
 * jsdom because the hook reads the router's location and the rendered
 * section; `scrollIntoView` is stubbed, since jsdom has no layout, and what
 * is pinned is whether it ran and how (an arrival jumps instantly, a hash
 * change on a page already on screen glides).
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** The hook in a layout, so it outlives the routes under it. */
function Layout() {
  useScrollToHash();
  return (
    <div>
      <section id="faq">FAQ</section>
      <Outlet />
    </div>
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let scrolls: ScrollIntoViewOptions[] = [];

beforeEach(() => {
  scrolls = [];
  Element.prototype.scrollIntoView = vi.fn(function (
    this: Element,
    options?: boolean | ScrollIntoViewOptions,
  ) {
    scrolls.push(typeof options === "object" ? options : {});
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(at: string) {
  const router = createMemoryRouter(
    [
      {
        element: <Layout />,
        children: [
          { path: "/one", element: <p>one</p> },
          { path: "/two", element: <p>two</p> },
        ],
      },
    ],
    { initialEntries: [at] },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<RouterProvider router={router} />);
  });
  return router;
}

describe("useScrollToHash", () => {
  it("jumps to the section when the page opens on its hash", async () => {
    await mount("/one#faq");
    expect(scrolls).toEqual([{ block: "start", behavior: "instant" }]);
  });

  it("lands on the section after a route change that keeps the same hash", async () => {
    const router = await mount("/one#faq");
    scrolls = [];
    await act(async () => {
      await router.navigate("/two#faq");
    });
    // An arrival on a new page, so the instant jump, not the glide.
    expect(scrolls).toEqual([{ block: "start", behavior: "instant" }]);
  });

  it("glides when only the hash changes on the page already on screen", async () => {
    const router = await mount("/one");
    await act(async () => {
      await router.navigate("/one#faq");
    });
    expect(scrolls).toEqual([{ block: "start" }]);
  });

  it("stays put when only the query changes", async () => {
    const router = await mount("/one#faq");
    scrolls = [];
    await act(async () => {
      await router.navigate("/one?ref=footer#faq");
    });
    expect(scrolls).toEqual([]);
  });
});
