// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flashSettingsRow,
  ROW_FLASH_CLASSES,
  ROW_FLASH_MS,
} from "@/components/settings/kit/flash-row";

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("flashSettingsRow", () => {
  it("scrolls the row to the middle and flashes it for a second", () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<div id="pane"><div data-settings-row="input-device"></div><div data-settings-row="ptt"></div></div>';
    const row = document.querySelector<HTMLElement>('[data-settings-row="ptt"]')!;
    const scroll = vi.fn();
    row.scrollIntoView = scroll;

    expect(flashSettingsRow(document.getElementById("pane"), "ptt")).not.toBeNull();
    expect(scroll).toHaveBeenCalledWith({ block: "center" });
    expect(row.classList.contains(ROW_FLASH_CLASSES[0])).toBe(true);

    vi.advanceTimersByTime(ROW_FLASH_MS);
    expect(row.classList.contains(ROW_FLASH_CLASSES[0])).toBe(false);
  });

  it("answers null for a row that is not there", () => {
    document.body.innerHTML = '<div id="pane"></div>';
    expect(flashSettingsRow(document.getElementById("pane"), "ptt")).toBeNull();
    expect(flashSettingsRow(null, "ptt")).toBeNull();
  });

  it("can be cut short", () => {
    document.body.innerHTML = '<div id="pane"><div data-settings-row="ptt"></div></div>';
    const stop = flashSettingsRow(document.getElementById("pane"), "ptt")!;
    stop();
    expect(
      document.querySelector('[data-settings-row="ptt"]')!.classList.length,
    ).toBe(0);
  });
});
