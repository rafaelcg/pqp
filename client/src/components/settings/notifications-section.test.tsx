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
}));

vi.mock("@/lib/push", () => ({
  getPushAvailability: () => env.availability,
  getPushConfig: async () => {
    if (env.configFails) {
      throw new Error("Request failed");
    }
    return { enabled: env.serverEnabled, publicKey: "k", dmDetails: false };
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
  });
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
