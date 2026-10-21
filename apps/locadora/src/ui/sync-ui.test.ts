// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STRINGS } from "../i18n";
import { createLoadFlow } from "../load-flow";
import { createConflictSheet, sideLine } from "./conflict-sheet";
import { continueLine } from "./continue-card";
import { createHouseRules } from "./house-rules";
import { createSlotDrawer } from "./slot-drawer";
import { createTopBar } from "./top-bar";

/**
 * SAVES NA CONTA on screen: the drawer's chip, the line that says what goes,
 * the account's usage and the two-step "Apagar tudo da conta"; the conflict
 * sheet's choices; the "Tu parou no computador" prompt; and the house rule
 * that is added only where sync answers. With no sync, nothing of it is drawn.
 */

const t = STRINGS["pt-BR"];

beforeEach(() => {
  document.body.innerHTML = "";
});

function drawer(extra: Partial<Parameters<typeof createSlotDrawer>[0]> = {}) {
  const value = createSlotDrawer({
    t,
    locale: "pt-BR",
    slots: [],
    current: 1,
    autosave: true,
    onLoad: vi.fn(),
    onSave: vi.fn(),
    onSelect: vi.fn(),
    onDelete: vi.fn(),
    onToggleAutosave: vi.fn(),
    ...extra,
  });
  document.body.append(value.element);
  value.open();
  return value;
}

describe("the drawer with Saves na conta", () => {
  it("draws nothing of the account without sync", () => {
    const value = drawer();
    expect(value.element.querySelector(".loc-slots-chip")).toBeNull();
    expect(value.element.querySelector(".loc-slots-sync-note")).toBeNull();
    expect(value.element.textContent).not.toContain("conta");
  });

  it("says what goes, how much the account holds, and the chip follows the state", () => {
    const value = drawer({ sync: { state: "idle", readOnly: false, used: 1536, cap: 8 * 1024 * 1024 } });
    const chip = () => value.element.querySelector<HTMLElement>(".loc-slots-chip")!;
    expect(chip().textContent).toBe(t["sync.chip"]);
    expect(value.element.querySelector(".loc-slots-sync-note")!.textContent).toBe(t["sync.note"]);
    expect(value.element.querySelector(".loc-slots-sync-note")!.textContent).toContain("O jogo nunca sai daqui");
    expect(value.element.querySelector(".loc-slots-sync-usage")!.textContent).toBe("Na conta: 1,5 KB de 8 MB");
    value.update({ sync: { state: "busy", readOnly: false, used: 0, cap: 1 } });
    expect(chip().dataset.state).toBe("busy");
    expect(chip().textContent).toBe(t["sync.chipBusy"]);
    value.update({ sync: { state: "error", readOnly: false, used: 0, cap: 1 } });
    expect(chip().textContent).toBe(t["sync.chipError"]);
    value.update({ sync: { state: "idle", readOnly: true, used: 0, cap: 1 } });
    expect(chip().textContent).toBe(t["sync.chipReadOnly"]);
    expect(value.element.querySelector(".loc-slots-sync-note")!.textContent).toBe(t["sync.noteReadOnly"]);
  });

  it("asks before deleting everything from the account, and Cancelar takes nothing", async () => {
    const onClearAccount = vi.fn(async () => true);
    const value = drawer({ sync: { state: "idle", readOnly: false, used: 10, cap: 100 }, onClearAccount });
    const button = (focus: string) => value.element.querySelector<HTMLButtonElement>(`[data-focus="${focus}"]`)!;
    button("sync-clear").click();
    expect(value.element.querySelector(".loc-slots-confirm")!.textContent).toContain(t["sync.clearAsk"]);
    button("sync-clear-no").click();
    expect(onClearAccount).not.toHaveBeenCalled();
    expect(value.element.querySelector(".loc-slots-confirm")).toBeNull();
    button("sync-clear").click();
    button("sync-clear-yes").click();
    expect(onClearAccount).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(value.element.querySelector(".loc-slots-confirm")).toBeNull();
  });

  it("names where a slot copied from the account was saved", () => {
    const slot = (origin: "computer" | "tablet" | "phone" | "device") => ({
      slot: 1 as const,
      empty: false,
      savedAt: Date.now(),
      size: 10,
      origin,
      core: "mgba",
      coreVersion: "4.2.3",
      sameConsole: true,
      thumb: null,
    });
    for (const [origin, text] of [
      ["computer", t["sync.from.computer"]],
      ["tablet", t["sync.from.tablet"]],
      ["phone", t["saves.originPhone"]],
      ["device", t["saves.originLocal"]],
    ] as const) {
      const value = drawer({ slots: [slot(origin)] });
      expect(value.element.querySelector(".loc-slot-detail")!.textContent, origin).toContain(text);
      value.destroy();
    }
  });
});

describe("the conflict sheet", () => {
  const base = {
    t,
    local: { savedAt: 1_000_000, device: "phone" as const },
    remote: { savedAt: 1_000_000 - 20 * 60_000, device: "computer" as const },
    now: () => 1_000_000 + 2 * 60_000,
  };

  it("is a labelled dialog with both sides and the three choices", () => {
    const onChoose = vi.fn();
    const sheet = createConflictSheet({ ...base, slotLabel: "Slot 2", both: "offer", onChoose });
    document.body.append(sheet.element);
    sheet.focus();
    const dialog = sheet.element;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)!.textContent).toBe(t["sync.conflict"]);
    const captions = [...dialog.querySelectorAll("figcaption")].map((node) => node.textContent);
    expect(captions).toEqual(["Do computador · salvo há 22 min", "Deste celular · salvo há 2 min"]);
    const labels = [...dialog.querySelectorAll("button")].map((node) => node.textContent);
    expect(labels).toEqual(["Usar o do computador", "Usar o deste celular", t["sync.both"], t["sync.later"]]);
    expect(document.activeElement?.textContent).toBe("Usar o do computador");
    dialog.querySelector<HTMLButtonElement>('[data-choice="both"]')!.click();
    expect(onChoose).toHaveBeenCalledWith("both");
    // one answer: the buttons lock
    dialog.querySelector<HTMLButtonElement>('[data-choice="local"]')!.click();
    expect(onChoose).toHaveBeenCalledTimes(1);
  });

  it("asks about the battery save without 'Guardar os dois', and Escape is 'Decidir depois'", () => {
    const onChoose = vi.fn();
    const sheet = createConflictSheet({ ...base, slotLabel: null, both: "none", onChoose });
    document.body.append(sheet.element);
    expect(sheet.element.querySelector(".loc-conflict-title")!.textContent).toBe(t["sync.conflictSram"]);
    expect(sheet.element.querySelector('[data-choice="both"]')).toBeNull();
    sheet.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onChoose).toHaveBeenCalledWith("later");
  });

  it("says when there is no empty slot to keep both", () => {
    const sheet = createConflictSheet({ ...base, slotLabel: "Slot 1", both: "full", onChoose: vi.fn() });
    expect(sheet.element.querySelector('[data-choice="both"]')).toBeNull();
    expect(sheet.element.textContent).toContain(t["sync.bothFull"]);
  });

  it("words both sides in every language", () => {
    for (const locale of ["pt-BR", "en", "es"] as const) {
      const strings = STRINGS[locale];
      const line = sideLine(strings, strings["sync.from.computer"], 0, 3 * 3600_000);
      expect(line, locale).toMatch(/3 h/);
      expect(line.charAt(0), locale).toBe(line.charAt(0).toUpperCase());
    }
  });
});

describe("the 'Tu parou no computador' prompt", () => {
  it("draws the account's picture and this device's, and each button says which", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const flow = createLoadFlow({ host, t, art: document.createElement("span"), title: "Fita", console: "Game Boy Advance" });
    const chosen: string[] = [];
    flow.showStart(
      { remote: { line: "Tu parou no computador há 20 min. Bora continuar daqui?", thumbUrl: "blob:a", localThumbUrl: "blob:b", hasLocal: true } },
      (choice) => chosen.push(choice),
    );
    expect(host.querySelector(".loc-load-ask")!.textContent).toBe("Tu parou no computador há 20 min. Bora continuar daqui?");
    expect(host.querySelectorAll(".loc-load-remote-pics img").length).toBe(2);
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".loc-load-remote button")];
    expect(buttons.map((button) => button.textContent)).toEqual([t["sync.go"], t["sync.keepLocal"], t["continue.fresh"]]);
    expect(document.activeElement).toBe(buttons[0]);
    for (const button of buttons) button.click();
    expect(chosen).toEqual(["remote", "continue", "fresh"]);
  });

  it("offers no 'deste aparelho' when this device has no autosave", () => {
    const host = document.createElement("div");
    const flow = createLoadFlow({ host, t, art: document.createElement("span"), title: "Fita", console: "NES" });
    flow.showStart({ remote: { line: "x", hasLocal: false } }, () => {});
    expect(host.querySelector('[data-choice="continue"]')).toBeNull();
  });
});

describe("the house rules", () => {
  it("add the account line only where Saves na conta answers, and keep the file's privacy line either way", () => {
    const off = createHouseRules({ t, compact: false }).element.textContent!;
    const on = createHouseRules({ t, compact: false, synced: true }).element.textContent!;
    expect(off).toContain(t.privacy);
    expect(off).not.toContain(t["rules.sync"]);
    expect(on).toContain(t.privacy);
    expect(on).toContain(t["rules.sync"]);
    expect(t["rules.sync"]).toContain("O jogo nunca vai");
  });
});

describe("Saves na conta that is on at the server and not working here: said, never missing", () => {
  it("the drawer's chip and note say the account did not answer, and offer no usage or 'Apagar tudo'", () => {
    const value = drawer({ sync: { state: "error", readOnly: false, used: 0, cap: 0, problem: "unreachable" } });
    const chip = value.element.querySelector<HTMLElement>(".loc-slots-chip")!;
    expect(chip.textContent).toBe(t["sync.chipError"]);
    expect(chip.dataset.state).toBe("error");
    expect(value.element.querySelector(".loc-slots-sync-note")!.textContent).toBe(t["sync.noteUnreachable"]);
    expect(value.element.querySelector(".loc-slots-sync-usage")).toBeNull();
    expect(value.element.querySelector('[data-focus="sync-clear"]')).toBeNull();
  });

  it("a browser that keeps nothing says so in the drawer", () => {
    const value = drawer({ sync: { state: "error", readOnly: false, used: 0, cap: 0, problem: "no-store" } });
    expect(value.element.querySelector(".loc-slots-chip")!.textContent).toBe(t["sync.chipNoStore"]);
    expect(value.element.querySelector(".loc-slots-sync-note")!.textContent).toBe(t["sync.noteNoStore"]);
  });
});

describe("the shelf says where the account is, before any game", () => {
  const bar = (cloud: Parameters<typeof createTopBar>[0]["cloud"], onCloudRetry = vi.fn()) =>
    createTopBar({ t, usage: { used: 27_000, cap: 512 * 1024 * 1024 }, cloud, onPick: () => undefined, onCloudRetry });

  it("draws nothing where the feature is off", () => {
    const top = bar(null);
    expect(top.element.querySelector(".loc-cloud")).toBeNull();
    expect(top.element.querySelector<HTMLElement>(".loc-cloud-host")!.hidden).toBe(true);
  });

  it("shows what the account holds, under the device's meter", () => {
    const top = bar({ state: "on", used: 1536, cap: 8 * 1024 * 1024 });
    const line = top.element.querySelector<HTMLElement>(".loc-cloud")!;
    expect(line.dataset.state).toBe("on");
    expect(line.textContent).toBe("Na conta: 2 KB de 8 MB");
    expect(line.getAttribute("aria-label")).toContain(t["sync.shelfChip"]);
    expect(top.element.querySelector(".loc-top-meters")!.contains(top.element.querySelector(".loc-meter"))).toBe(true);
    // it follows the usage as saves go up
    top.update({ cloud: { state: "on", used: 3 * 1024 * 1024, cap: 8 * 1024 * 1024 } });
    expect(top.element.querySelector(".loc-cloud")!.textContent).toBe("Na conta: 3 MB de 8 MB");
    top.update({ cloud: null });
    expect(top.element.querySelector(".loc-cloud")).toBeNull();
  });

  it("when the account did not answer it is a button that asks again", () => {
    const retry = vi.fn();
    const top = bar({ state: "unreachable" }, retry);
    const button = top.element.querySelector<HTMLButtonElement>("button.loc-cloud-retry")!;
    expect(button.textContent).toBe(`${t["sync.chipError"]} · ${t["sync.retry"]}`);
    button.click();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("no-store and read-only are plain lines", () => {
    expect(bar({ state: "no-store" }).element.querySelector(".loc-cloud")!.textContent).toBe(t["sync.chipNoStore"]);
    expect(bar({ state: "read-only", used: 1, cap: 2 }).element.querySelector(".loc-cloud")!.textContent).toBe(t["sync.chipReadOnly"]);
  });

  it("Continuar's line marks a game that is on the account", () => {
    const item = { platform: "nes", slots: [{ slot: "1", at: 1 }] } as unknown as Parameters<typeof continueLine>[0];
    expect(continueLine(item, undefined, 10, t, true)).toBe(`NES · ${t["box.saves.one"].replace("{n}", "1")} · na conta`);
    expect(continueLine(item, undefined, 10, t)).not.toContain("na conta");
  });
});
