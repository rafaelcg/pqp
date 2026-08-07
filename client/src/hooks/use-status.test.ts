import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOwnStatus } from "@/hooks/use-status";
import {
  notifyChannelActivity,
  setDoNotDisturb,
  setDefaultNotificationLevel,
  setDesktopNotificationsEnabled,
} from "@/lib/notifications";

describe("resolveOwnStatus", () => {
  /**
   * The client draws the pip next to your own name from its own copy of the
   * rule, because it knows about an idle transition before any server does.
   * Two copies of a rule drift, so this table is the same one
   * `externalStatus` in server/src/ws/status.ts implements — keep them equal.
   */
  const cases: Array<[Parameters<typeof resolveOwnStatus>[0], boolean, string]> =
    [
      ["online", false, "online"],
      ["online", true, "idle"],
      // A manual choice beats the inactivity timer, in both directions: "do not
      // interrupt me" is a statement, idle is a measurement, and a timer must
      // not overwrite a statement.
      ["dnd", false, "dnd"],
      ["dnd", true, "dnd"],
      // The whole feature in one row. Invisible never renders as itself to
      // anyone but its owner, and the owner's label is swapped at the call site,
      // not here.
      ["invisible", false, "offline"],
      ["invisible", true, "offline"],
    ];

  for (const [manual, idle, expected] of cases) {
    it(`renders ${manual}${idle ? " + idle" : ""} as ${expected}`, () => {
      expect(resolveOwnStatus(manual, idle)).toBe(expected);
    });
  }
});

describe("do not disturb", () => {
  beforeEach(() => {
    setDoNotDisturb(false);
    setDesktopNotificationsEnabled(true);
    setDefaultNotificationLevel("all");
    vi.unstubAllGlobals();
  });

  function activity() {
    return {
      channelId: "11111111-1111-4111-8111-111111111111",
      serverId: "22222222-2222-4222-8222-222222222222",
      channelName: "general",
      serverName: "pqp",
      count: 1,
      mentions: 1,
    };
  }

  it("stops a notification that would otherwise fire", () => {
    const notify = vi.fn();
    class FakeNotification {
      static permission = "granted";
      constructor(title: string, options?: unknown) {
        notify(title, options);
      }
      close() {}
      addEventListener() {}
    }
    vi.stubGlobal("Notification", FakeNotification);
    vi.stubGlobal("window", { Notification: FakeNotification });

    notifyChannelActivity(activity(), {
      selectedChannelId: null,
      documentVisible: false,
    });
    expect(notify).toHaveBeenCalledTimes(1);

    // This is what makes DND a behaviour rather than a red dot: everything
    // about status is what other people see, except this.
    notify.mockClear();
    setDoNotDisturb(true);
    notifyChannelActivity(
      { ...activity(), channelId: "33333333-3333-4333-8333-333333333333" },
      { selectedChannelId: null, documentVisible: false },
    );
    expect(notify).not.toHaveBeenCalled();
  });
});
