// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("says an error through the region inside Settings, and keeps the alert outside", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await render({ kind: "idle" });
    const before = region();
    await render({ kind: "error", message: "Não deu pra salvar." });
    expect(region()).toBe(before);
    expect(before.textContent).toBe("Não deu pra salvar.");
    // Created with its text, an alert is often not read; the region speaks.
    expect(host!.querySelector('[role="alert"]')).toBeNull();
    expect(host!.textContent).toContain("Não deu pra salvar.");

    await render({ kind: "error", message: "Não deu pra salvar." }, false);
    expect(host!.querySelector('[role="alert"]')?.textContent).toBe("Não deu pra salvar.");
  });

  it("leaves the row's line as its own region outside Settings", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await render({ kind: "saved" }, false);
    expect(host!.querySelector('[role="status"]')?.textContent).toMatch(/Saved|Salvo/);
  });
});

describe("SettingsInlineStatus quiet", () => {
  it("draws the error without speaking it or making it an alert", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <SettingsAnnouncer>
          <SettingsInlineStatus quiet state={{ kind: "error", message: "Esse link já tem dono." }} />
        </SettingsAnnouncer>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain("Esse link já tem dono.");
    expect(region().textContent).toBe("");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("SettingsNotice inside Settings", () => {
  it("says a notice that appears after the tab opened, and not one that was there", async () => {
    const { SettingsNotice } = await import("@/components/settings/kit/notice");
    const { markSettingsPaneShown } = await import("@/components/settings/kit/announcer");
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    markSettingsPaneShown();
    const render = async (late: boolean) => {
      await act(async () => {
        root!.render(
          <SettingsAnnouncer>
            <SettingsNotice tone="info">Já estava aqui.</SettingsNotice>
            {late ? <SettingsNotice tone="warning">Shift sozinho abre o mic.</SettingsNotice> : null}
          </SettingsAnnouncer>,
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    await render(false);
    expect(region().textContent).toBe("");
    now.mockReturnValue(1_000_000 + 5_000);
    await render(true);
    expect(region().textContent).toBe("Shift sozinho abre o mic.");
    // Neither notice is a live region of its own inside Settings.
    expect(host.querySelectorAll('[role="status"]').length).toBe(1);
    now.mockRestore();
  });
});
