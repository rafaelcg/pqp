// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsAnnouncer } from "@/components/settings/kit/announcer";
import { SettingsInlineStatus } from "@/components/settings/kit/inline-status";
import type { InlineSaveState } from "@/components/settings/kit/use-inline-save";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function render(state: InlineSaveState, inside = true) {
  const row = <SettingsInlineStatus state={state} />;
  await act(async () => {
    root!.render(inside ? <SettingsAnnouncer>{row}</SettingsAnnouncer> : row);
  });
  // The announcer clears, then speaks on the next tick.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const region = () => host!.querySelector("[data-settings-announcer]")!;

describe("SettingsAnnouncer", () => {
  it("says saving and saved through a region that was there before either", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await render({ kind: "idle" });
    const before = region();
    expect(before.getAttribute("role")).toBe("status");
    expect(before.textContent).toBe("");

    await render({ kind: "saving" });
    expect(region()).toBe(before);
    expect(region().textContent).toMatch(/Saving|Salvando/);
    await render({ kind: "saved" });
    expect(region().textContent).toMatch(/Saved|Salvo/);
    // The row's own line is plain text inside Settings: one voice, not two.
    expect(host!.querySelectorAll('[role="status"]').length).toBe(1);
  });

  it("leaves the row's line as its own region outside Settings", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await render({ kind: "saved" }, false);
    expect(host!.querySelector('[role="status"]')?.textContent).toMatch(/Saved|Salvo/);
  });
});
