import { describe, expect, it, vi } from "vitest";
import type { Translator } from "@/lib/i18n";
import type { NotificationState } from "@/lib/notifications";
import {
  leaveCommunityMenuItems,
  serverNotificationMenuItems,
} from "./server-menu-items";

const t = ((key: string) => key) as Translator["t"];

const state = {
  desktop: false,
  desktopChosen: false,
  default: "all",
  dmDefault: null,
  serverDefault: null,
  servers: {},
  channels: {},
  arrivalToast: true,
  previewInApp: true,
  streamAlerts: {},
} as NotificationState;

describe("leaveCommunityMenuItems", () => {
  it("ends the menu with a danger leave item for a member", () => {
    const onLeave = vi.fn();
    const items = leaveCommunityMenuItems(false, onLeave, t);
    const leave = items[items.length - 1];
    expect(leave).toMatchObject({
      id: "leave",
      label: "chrome.leaveCommunity",
      danger: true,
    });
    leave.onSelect?.();
    expect(onLeave).toHaveBeenCalledOnce();
  });

  it("offers nothing to the owner, or without a handler", () => {
    expect(leaveCommunityMenuItems(true, vi.fn(), t)).toEqual([]);
    expect(leaveCommunityMenuItems(false, undefined, t)).toEqual([]);
  });
});

describe("serverNotificationMenuItems", () => {
  it("lists the three levels with the current one checked", () => {
    const items = serverNotificationMenuItems("s1", state, undefined, t);
    const levels = items.filter((i) => i.id.startsWith("notify-") && i.checked !== undefined);
    expect(levels.map((i) => i.id)).toEqual([
      "notify-all",
      "notify-mentions",
      "notify-none",
    ]);
    expect(levels.find((i) => i.checked)?.id).toBe("notify-all");
  });

  it("adds the stream alerts tick only where the flag is on", () => {
    expect(
      serverNotificationMenuItems("s1", state, { flag: false, default: true }, t)
        .some((i) => i.id === "stream-alerts"),
    ).toBe(false);
    const on = serverNotificationMenuItems("s1", state, { flag: true, default: true }, t);
    expect(on.find((i) => i.id === "stream-alerts")?.checked).toBe(true);
  });
});
