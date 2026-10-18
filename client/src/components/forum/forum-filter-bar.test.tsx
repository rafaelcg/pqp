// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ForumFilterBar, ForumLayoutSwitch, ForumSortMenu } from "./forum-filter-bar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

const FILTERS = { status: null, mine: false, tagIds: [], q: "", sort: "activity" } as const;
const sortButton = (el: HTMLElement) => el.querySelector('button[aria-label^="Sort"]');

describe("ForumFilterBar", () => {
  // Beside an open post the pane passes the sort menu as `leading` and the
  // search row hides it. The wide row used to drop `leading`, so the order
  // could not be changed with a post open on desktop.
  it("draws the sort menu in the wide row when the pane passes it", () => {
    const el = mount(
      <ForumFilterBar
        filters={FILTERS}
        tags={[]}
        onChange={() => {}}
        inlineTags={0}
        leading={<ForumSortMenu sort="activity" onChange={() => {}} short />}
      />,
    );
    expect(sortButton(el)).not.toBeNull();
  });

  it("draws the sort menu in the phone strip too", () => {
    const el = mount(
      <ForumFilterBar
        filters={FILTERS}
        tags={[]}
        onChange={() => {}}
        inlineTags={0}
        strip
        leading={<ForumSortMenu sort="activity" onChange={() => {}} short />}
      />,
    );
    expect(sortButton(el)).not.toBeNull();
  });

  it("draws no sort menu when the pane keeps it on the search row", () => {
    const el = mount(
      <ForumFilterBar filters={FILTERS} tags={[]} onChange={() => {}} inlineTags={0} />,
    );
    expect(sortButton(el)).toBeNull();
  });
});

describe("ForumLayoutSwitch", () => {
  it("keeps one tab stop and moves with the arrow keys", () => {
    const onChange = vi.fn();
    const el = mount(
      <TooltipProvider>
        <ForumLayoutSwitch layout="card" onChange={onChange} />
      </TooltipProvider>,
    );
    const radios = [...el.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);
    act(() => radios[0]!.focus());
    act(() => {
      el.querySelector('[role="radiogroup"]')!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(onChange).toHaveBeenCalledWith("compact");
  });
});
