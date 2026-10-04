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
}));

const sounds = vi.hoisted(() => ({ playCue: vi.fn() }));

vi.mock("@/lib/sounds", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sounds")>()),
  playCue: sounds.playCue,
}));

vi.mock("@/lib/push", () => ({
  getPushAvailability: () => env.availability,
  getPushConfig: async () => {
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

vi.mock("@/hooks/use-notifications", () => {
  const state = {
    desktop: false,
    default: "mentions",
    arrivalToast: true,
    previewInApp: true,
  };
  return {
    useNotificationState: () => state,
    useNotificationSettings: () => ({
      state,
      permission: env.permission,
      enable: vi.fn(),
      disable: vi.fn(),
      setDefaultLevel: vi.fn(),
    }),
  };
});

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
  });
  sounds.playCue.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
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

  it("locks the sender switch while push is off and could be turned on here", async () => {
    await mount();
    expect(switchIn("push").disabled).toBe(false);
    expect(switchIn("dm-push-details").disabled).toBe(true);
  });

  it("locks the push switch while notifications are blocked for the site", async () => {
    env.permission = "denied";
    await mount();
    expect(switchIn("push").disabled).toBe(true);
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
    expect(unavailableLine()).toMatch(/not available here/i);
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

describe("NotificationsSection sounds", () => {
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
