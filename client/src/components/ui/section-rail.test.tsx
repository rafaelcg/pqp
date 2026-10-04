// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Bell, Mic, UserRound } from "lucide-react";
import {
  RAIL_ARROW_SELECT_DELAY_MS,
  SectionRail,
  type SectionRailItem,
} from "@/components/ui/section-rail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

type Id = "profile" | "voice" | "notifications";

let root: Root | null = null;
let host: HTMLElement | null = null;
let onSelect: ReturnType<typeof vi.fn<(id: Id) => void>>;

function items(dirty = false): SectionRailItem<Id>[] {
  return [
    { id: "profile", label: "Perfil", icon: UserRound, group: "account", dirty },
    { id: "voice", label: "Voz e vídeo", icon: Mic, group: "app" },
    { id: "notifications", label: "Notificações", icon: Bell, group: "app" },
  ];
}

function render(active: Id, dirty = false) {
  act(() =>
    root!.render(
      <SectionRail
        sections={items(dirty)}
        active={active}
        onSelect={onSelect}
        idFor={(id) => `tab-${id}`}
        panelId="panel"
        label="Seções"
        groupLabels={{ account: "Conta", app: "App" }}
      />,
    ),
  );
}

function tab(id: Id): HTMLButtonElement {
  return host!.querySelector<HTMLButtonElement>(`#tab-${id}`)!;
}

function description(element: HTMLElement): string {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(", ");
}

function press(key: string) {
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true }),
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  onSelect = vi.fn<(id: Id) => void>();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe("SectionRail", () => {
  it("is a vertical tablist when it is a column", () => {
    render("profile");
    expect(
      host!.querySelector('[role="tablist"]')!.getAttribute("aria-orientation"),
    ).toBe("vertical");
  });

  it("describes each tab with its group, and a dirty tab as unsaved", () => {
    render("voice", true);
    expect(tab("voice").getAttribute("aria-describedby")).toBeTruthy();
    expect(description(tab("voice"))).toBe("App");
    expect(description(tab("profile"))).toMatch(/^(alterações não salvas|unsaved changes), Conta$/);
    // The name stays the label alone, so lookups by name keep working.
    expect(tab("profile").textContent).toBe("Perfil");
  });

  it("pins a dirty tab that is not the selected one", () => {
    render("voice", true);
    expect(tab("profile").hasAttribute("data-rail-pinned")).toBe(true);
    render("profile", true);
    expect(tab("profile").hasAttribute("data-rail-pinned")).toBe(false);
  });

  it("moves focus on an arrow at once and opens the tab once the arrow rests", () => {
    render("profile");
    act(() => tab("profile").focus());
    press("ArrowDown");
    expect(document.activeElement).toBe(tab("voice"));
    expect(onSelect).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(RAIL_ARROW_SELECT_DELAY_MS));
    expect(onSelect).toHaveBeenCalledWith("voice");
  });

  it("walks past a tab without opening it", () => {
    render("profile");
    act(() => tab("profile").focus());
    press("ArrowDown");
    press("ArrowDown");
    expect(document.activeElement).toBe(tab("notifications"));
    act(() => vi.advanceTimersByTime(RAIL_ARROW_SELECT_DELAY_MS));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("notifications");
  });

  it("opens a clicked tab at once, and drops a waiting arrow", () => {
    render("profile");
    act(() => tab("profile").focus());
    press("ArrowDown");
    act(() => tab("notifications").click());
    expect(onSelect).toHaveBeenCalledWith("notifications");
    act(() => vi.advanceTimersByTime(RAIL_ARROW_SELECT_DELAY_MS));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("opens the focused tab when focus leaves the rail", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    render("profile");
    act(() => tab("profile").focus());
    press("End");
    act(() => outside.focus());
    expect(onSelect).toHaveBeenCalledWith("notifications");
    outside.remove();
  });
});
