// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { NotificationPermissionState } from "@/lib/notifications";
import type { PushAvailability } from "@/lib/push";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const env = vi.hoisted(() => ({
  availability: "available" as PushAvailability,
  serverEnabled: true,
  configFails: false,
  subscribed: false,
  permission: "default" as NotificationPermissionState,
  desktop: false,
  dmDetails: false,
  /** `desktop_notify_default_on`: the two account defaults replace the one. */
  split: false,
  /** What the browser answers when the system switch asks for permission. */
  requestResult: "granted" as NotificationPermissionState,
  /** Holds the push config back until called, to look at the loading state. */
  holdConfig: null as null | { release: () => void },
}));

const sounds = vi.hoisted(() => ({ playCue: vi.fn() }));

vi.mock("@/lib/sounds", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sounds")>()),
  playCue: sounds.playCue,
}));

vi.mock("@/lib/push", () => ({
  getPushAvailability: () => env.availability,
  getPushConfig: async () => {
    if (env.holdConfig) {
      await new Promise<void>((resolve) => (env.holdConfig!.release = resolve));
    }
    if (env.configFails) {
      throw new Error("Request failed");
    }
    return { enabled: env.serverEnabled, publicKey: "k", dmDetails: env.dmDetails };
  },
  getCurrentPushSubscription: async () =>
    env.subscribed ? { endpoint: "https://push.example/x" } : null,
  enablePush: vi.fn(async () => "enabled"),
  disablePush: vi.fn(async () => undefined),
  setPushDmDetails: vi.fn(async (dmDetails: boolean) => ({ dmDetails })),
}));

vi.mock("@/lib/desktop", () => ({
  desktopContext: () => (env.desktop ? { context: "desktop" } : undefined),
  isDesktopApp: () => env.desktop,
}));

vi.mock("@/hooks/use-notifications", async () => {
  const { useState } = await import("react");
  const state = {
    desktop: false,
    desktopChosen: false,
    default: "mentions",
    dmDefault: null,
    serverDefault: null,
    arrivalToast: true,
    previewInApp: true,
  };
  return {
    useNotificationState: () => state,
    useDesktopNotifyDefaultOn: () => env.split,
    // Holds its own permission the way the real hook does: it only changes
    // when the switch asks, or when something tells it to read again.
    useNotificationSettings: () => {
      const [permission, setPermission] = useState(env.permission);
      return {
        state,
        permission,
        enable: async () => {
          env.permission = env.requestResult;
          setPermission(env.permission);
        },
        disable: vi.fn(),
        refreshPermission: () => setPermission(env.permission),
        setDefaultLevel: vi.fn(),
        setDmDefaultLevel: vi.fn(),
        setServerDefaultLevel: vi.fn(),
      };
    },
  };
});

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  updatePreferences: vi.fn(async () => ({ preferences: {} })),
}));

const { NotificationsSection } = await import(
  "@/components/settings/notifications-section"
);

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <TooltipProvider>
        <NotificationsSection />
      </TooltipProvider>,
    );
  });
  // The push config and the subscription resolve on the next ticks.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function switchIn(rowId: string): HTMLButtonElement {
  return host!.querySelector(
    `[data-settings-row="${rowId}"] [role="switch"]`,
  ) as HTMLButtonElement;
}

beforeEach(() => {
  Object.assign(env, {
    availability: "available",
    serverEnabled: true,
    configFails: false,
    subscribed: false,
    permission: "default",
    desktop: false,
    dmDetails: false,
    split: false,
    requestResult: "granted",
    holdConfig: null,
  });
  sounds.playCue.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("NotificationsSection account defaults", () => {
  const row = (id: string) => host!.querySelector(`[data-settings-row="${id}"]`);

  it("flag off: the one default row, as before", async () => {
    await mount();
    expect(row("default-level")).not.toBeNull();
    expect(row("dm-default-level")).toBeNull();
    expect(row("server-default-level")).toBeNull();
  });

  it("flag on: a row for DMs and one for servers, and not the old single row", async () => {
    env.split = true;
    await mount();
    expect(row("default-level")).toBeNull();
    expect(row("dm-default-level")).not.toBeNull();
    expect(row("server-default-level")).not.toBeNull();
  });

  it("flag on: the server row starts on mentions and the DM row follows the old default", async () => {
    env.split = true;
    await mount();
    const checked = (id: string) =>
      row(id)?.querySelector('[role="radio"][aria-checked="true"]')?.textContent;
    // The mocked account carries `default: "mentions"`, a choice, so both follow it.
    expect(checked("dm-default-level")).toBe("Only @mentions");
    expect(checked("server-default-level")).toBe("Only @mentions");
  });
});

describe("NotificationsSection push rows", () => {
  it("reads push as on, and unlocks the sender switch, only with a subscription the server accepts", async () => {
    env.subscribed = true;
    await mount();
    expect(switchIn("push").getAttribute("aria-checked")).toBe("true");
    expect(switchIn("dm-push-details").disabled).toBe(false);
  });

  it("treats a stale subscription on a server without push as off for both rows", async () => {
    env.subscribed = true;
    env.serverEnabled = false;
    await mount();
    expect(switchIn("push").getAttribute("aria-checked")).toBe("false");
    expect(switchIn("push").disabled).toBe(true);
    expect(switchIn("dm-push-details").disabled).toBe(true);
  });

  it("treats a stale subscription as off when the push config fails to load", async () => {
    env.subscribed = true;
    env.configFails = true;
    await mount();
    expect(switchIn("push").getAttribute("aria-checked")).toBe("false");
    expect(switchIn("dm-push-details").disabled).toBe(true);
  });

  it("goes back to what the server holds when two quick changes both fail, and says so", async () => {
    env.subscribed = true;
    const push = await import("@/lib/push");
    const write = vi.mocked(push.setPushDmDetails);
    let failFirst!: (error: unknown) => void;
    write
      .mockReturnValueOnce(new Promise((_, reject) => (failFirst = reject)))
      .mockRejectedValueOnce(new Error("offline"));
    await mount();
    const toggle = switchIn("dm-push-details");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle.click());
    await act(async () => toggle.click());
    await act(async () => {
      failFirst(new Error("offline"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(switchIn("dm-push-details").getAttribute("aria-checked")).toBe("false");
    expect(
      host!.querySelector('[data-settings-row="dm-push-details"] [role="alert"]')?.textContent,
    ).toBe("Could not save that setting.");
  });

  it("locks the sender switch while push is off and could be turned on here", async () => {
    await mount();
    expect(switchIn("push").disabled).toBe(false);
    expect(switchIn("dm-push-details").disabled).toBe(true);
  });

  it("locks the push switch while notifications are blocked for the site", async () => {
    env.permission = "denied";
    await mount();
    const push = await import("@/lib/push");
    vi.mocked(push.enablePush).mockClear();
    // Unavailable to the pointer and to assistive tech, but not `disabled`,
    // which would drop keyboard focus to the page when the block lands.
    expect(switchIn("push").getAttribute("aria-disabled")).toBe("true");
    await act(async () => switchIn("push").click());
    expect(push.enablePush).not.toHaveBeenCalled();
  });

  it("keeps focus on the system switch when the browser refuses the permission", async () => {
    env.requestResult = "denied";
    await mount();
    const toggle = switchIn("system-notifications");
    toggle.focus();
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(toggle.disabled).toBe(false);
    expect(document.activeElement).toBe(toggle);
  });

  it("keeps focus on the push switch when the push prompt is refused", async () => {
    const push = await import("@/lib/push");
    vi.mocked(push.enablePush).mockImplementationOnce(async () => {
      env.permission = "denied";
      return "denied";
    });
    await mount();
    const toggle = switchIn("push");
    toggle.focus();
    await act(async () => toggle.click());
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
  });

  it("updates the system and sender rows when the push prompt is refused", async () => {
    const push = await import("@/lib/push");
    vi.mocked(push.enablePush).mockImplementationOnce(async () => {
      env.permission = "denied";
      return "denied";
    });
    env.dmDetails = true;
    await mount();
    expect(
      host!.querySelector('[data-settings-row="system-notifications"] [role="status"]'),
    ).toBeNull();
    expect(host!.querySelector('[data-settings-row="dm-push-details"]')!.textContent)
      .toMatch(/turn on push first/i);

    await act(async () => switchIn("push").click());

    expect(
      host!.querySelector('[data-settings-row="system-notifications"] [role="status"]')
        ?.textContent,
    ).toMatch(/padlock/i);
    expect(switchIn("system-notifications").getAttribute("aria-disabled")).toBe("true");
    const dm = host!.querySelector('[data-settings-row="dm-push-details"]')!.textContent;
    expect(dm).toMatch(/blocked in this browser/i);
    expect(dm).not.toMatch(/turn on push first/i);
  });

  it("says push is loading, and does not tell the person to turn it on first", async () => {
    env.holdConfig = { release: () => {} };
    await mount();
    expect(host!.querySelector('[data-settings-row="push"]')!.textContent).toContain(
      "Loading push…",
    );
    const dm = host!.querySelector('[data-settings-row="dm-push-details"]')!.textContent;
    expect(dm).toContain("Loading push…");
    expect(dm).not.toMatch(/turn on push first/i);

    await act(async () => {
      env.holdConfig!.release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host!.querySelector('[data-settings-row="push"]')!.textContent).not.toContain(
      "Loading push…",
    );
    expect(host!.querySelector('[data-settings-row="dm-push-details"]')!.textContent)
      .toMatch(/turn on push first/i);
  });

  it("keeps the push switch focusable while it saves and drops a second press", async () => {
    const push = await import("@/lib/push");
    let finish: (value: "enabled") => void = () => {};
    vi.mocked(push.enablePush).mockClear();
    vi.mocked(push.enablePush).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    await mount();
    const toggle = switchIn("push");
    await act(async () => {
      toggle.click();
      toggle.click();
    });
    expect(toggle.disabled).toBe(false);
    expect(push.enablePush).toHaveBeenCalledTimes(1);
    await act(async () => finish("enabled"));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it.each([
    ["needs-install", false],
    ["unsupported", false],
    ["available", true],
  ] as const)(
    "keeps the sender switch changeable where this device can never have push (%s)",
    async (availability, desktop) => {
      env.availability = availability;
      env.desktop = desktop;
      await mount();
      expect(switchIn("dm-push-details").disabled).toBe(false);
    },
  );
});

describe("NotificationsSection blocked notice", () => {
  const reloadButton = () =>
    host!.querySelector<HTMLButtonElement>(
      '[data-settings-row="system-notifications"] [role="status"] button',
    );

  it("offers a Reload button that reloads the page", async () => {
    const original = window.location;
    const reload = vi.fn();
    vi.stubGlobal("location", { ...original, reload });
    try {
      env.permission = "denied";
      await mount();
      const button = reloadButton();
      expect(button).not.toBeNull();
      await act(async () => button!.click());
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("has nothing to reload in the desktop app", async () => {
    env.permission = "denied";
    env.desktop = true;
    await mount();
    expect(reloadButton()).toBeNull();
  });

  it("says how to unblock instead of only that it is blocked", async () => {
    env.permission = "denied";
    await mount();
    const notice = host!.querySelector(
      '[data-settings-row="system-notifications"] [role="status"]',
    );
    expect(notice?.textContent).toMatch(/padlock/i);
  });
});

describe("NotificationsSection direct message push switch", () => {
  const unavailableLine = () =>
    host!.querySelector('[data-settings-row="dm-push-details"]')?.textContent ??
    "";

  it("reads off and says why when push cannot be turned on from here", async () => {
    env.dmDetails = true;
    env.serverEnabled = false;
    await mount();
    expect(switchIn("dm-push-details").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(switchIn("dm-push-details").disabled).toBe(true);
    expect(unavailableLine()).toMatch(/not available here/i);
  });

  it("reads off and says why while the site is blocked", async () => {
    env.dmDetails = true;
    env.permission = "denied";
    await mount();
    expect(switchIn("dm-push-details").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(unavailableLine()).toMatch(/blocked in this browser/i);
  });

  it("keeps the order to turn push on, with the stored choice, when that is possible", async () => {
    env.dmDetails = true;
    await mount();
    expect(switchIn("dm-push-details").disabled).toBe(true);
    expect(switchIn("dm-push-details").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(unavailableLine()).toMatch(/turn on push first/i);
    expect(unavailableLine()).not.toMatch(/not available here/i);
  });
});

describe("NotificationsSection sender hint", () => {
  const hint = () =>
    host!.querySelector('[data-settings-row="dm-push-details"]')!.textContent ?? "";

  it("describes the state the switch shows, never the opposite", async () => {
    env.subscribed = true;
    await mount();
    const toggle = switchIn("dm-push-details");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(hint()).toContain("only says a new message arrived");
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(hint()).toContain("says who sent the message");
    expect(hint()).not.toMatch(/\bOff\b/);
  });
});

describe("NotificationsSection account sync", () => {
  it("says so when the sound or level choice did not reach the account, and clears on a retry", async () => {
    const api = await import("@/lib/api");
    const { queuePreferenceSync } = await import("@/lib/preferences");
    const update = vi.mocked(api.updatePreferences);
    update.mockRejectedValueOnce(new Error("offline"));
    await mount();
    expect(host!.textContent).not.toContain("Could not save to your account");

    await act(async () => {
      queuePreferenceSync({ sounds: { enabled: false } } as never, { immediate: true });
      await Promise.resolve();
    });
    expect(host!.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not save to your account",
    );

    // The next change sends the unsent key again and, once it lands, the line goes.
    await act(async () => {
      queuePreferenceSync({ notifications: { default: "all" } } as never, { immediate: true });
      await Promise.resolve();
    });
    expect(update).toHaveBeenLastCalledWith({
      sounds: { enabled: false },
      notifications: { default: "all" },
    });
    expect(host!.textContent).not.toContain("Could not save to your account");
  });

  it("stays quiet about a failure in a preference this tab does not own", async () => {
    const api = await import("@/lib/api");
    const { queuePreferenceSync } = await import("@/lib/preferences");
    vi.mocked(api.updatePreferences).mockRejectedValueOnce(new Error("offline"));
    await mount();
    await act(async () => {
      queuePreferenceSync({ theme: "dark" }, { immediate: true });
      await Promise.resolve();
    });
    expect(host!.textContent).not.toContain("Could not save to your account");
    // Leave the store clean for whatever runs next.
    await act(async () => {
      queuePreferenceSync({ theme: "dark" }, { immediate: true });
      await Promise.resolve();
    });
  });
});

describe("NotificationsSection sounds", () => {
  it("says which sounds Do Not Disturb silences, and only those", async () => {
    await mount();
    const hint = host!.textContent ?? "";
    expect(hint).toContain("Do Not Disturb only silences the message and mention sounds.");
  });

  it("puts the ringtones directly under Incoming call", async () => {
    await mount();
    const call = host!.querySelector('[data-settings-row="sound-incoming-call"]')!;
    const ring = host!.querySelector('[data-settings-row="incoming-ring"]')!;
    // Switch and ringtones share one wrapper, so the group draws no divider
    // between them; the next row in the group is the outgoing call.
    expect(call.nextElementSibling).toBe(ring.parentElement);
    expect(ring.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(
      call.parentElement!.nextElementSibling?.getAttribute("data-settings-row"),
    ).toBe("sound-outgoing-call");
  });

  it("plays the ringtone again when the chosen chip is clicked", async () => {
    await mount();
    const chosen = host!.querySelector<HTMLButtonElement>(
      '[data-settings-row="incoming-ring"] [role="radio"][aria-checked="true"]',
    )!;
    await act(async () => chosen.click());
    expect(sounds.playCue).toHaveBeenCalledWith("incomingCall");
  });

  it("labels every listen button with a visible word and the sound it plays", async () => {
    await mount();
    const buttons = [
      ...host!.querySelectorAll<HTMLButtonElement>(
        '[data-settings-row^="sound-"] button:not([role="switch"])',
      ),
    ];
    expect(buttons).toHaveLength(6);
    for (const button of buttons) {
      expect(button.textContent?.trim()).toBeTruthy();
      expect(button.getAttribute("aria-label")).toContain(
        button.textContent!.trim(),
      );
    }
  });
});
