// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "@pqp/shared";

/**
 * The moderation door in Settings is invisible to everyone until their own
 * account proves it, once, against the one route that answers differently for
 * an instance moderator: `GET /api/reports/all`. This pins the gate itself —
 * `settings-modal.tsx`'s `canModerateInstance` state and the `visibleSections`
 * filter it drives — rather than anything inside `AllReportsSection`, which
 * has its own reason to exist and its own tests would cover its list.
 *
 * `fetchAllReports` is mocked rather than hit for real: this project has no
 * server running in a unit test, and every other api.ts export used along the
 * way (`fetchUserBannerConfig`, `fetchAvatarConfig`) already tolerates a
 * failed fetch by design (`.catch()` to a safe default), so leaving them real
 * costs nothing here.
 */

const { fetchAllReportsMock } = vi.hoisted(() => ({
  fetchAllReportsMock: vi.fn(),
}));

// The footer's sign-out control renders nothing under the dev bypass rather
// than reaching for `useClerk()`, which throws outside a `<ClerkProvider>` —
// and this test has no reason to stand one up just to render a button that is
// not what is under test.
vi.stubEnv("VITE_DEV_AUTH_BYPASS", "true");

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>(
    "@/lib/api",
  );
  return {
    ...actual,
    fetchAllReports: (...args: unknown[]) => fetchAllReportsMock(...args),
  };
});

const { SettingsModal, defaultLocalSettings } = await import(
  "./settings-modal"
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

const testUser = {
  id: "00000000-0000-0000-0000-000000000001",
  clerkId: "clerk_1",
  displayName: "Rafa",
  username: "rafa",
  discriminator: "0001",
  tag: "rafa#0001",
  avatarUrl: null,
  handle: null,
  handleChangedAt: null,
  dmPrivacy: "server_members",
} as unknown as User;

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <SettingsModal
        open
        user={testUser}
        localSettings={defaultLocalSettings}
        blockedUsers={[]}
        onClose={() => {}}
        onLocalSave={() => {}}
        onUserUpdated={() => {}}
        onUnblockUser={() => {}}
      />,
    );
  });
  // Let the gate's fetch promise (and the state updates it schedules) settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  fetchAllReportsMock.mockReset();
});

function moderationTab(): Element | null {
  return document.getElementById("settings-tab-moderation");
}

describe("Settings' moderation section gate", () => {
  it("stays off the nav when GET /api/reports/all is not visible to this account", async () => {
    fetchAllReportsMock.mockRejectedValue(new Error("Not found"));

    await mount();

    expect(fetchAllReportsMock).toHaveBeenCalled();
    expect(moderationTab()).toBeNull();
  });

  it("joins the nav once GET /api/reports/all answers for this account", async () => {
    fetchAllReportsMock.mockResolvedValue({ reports: [], hasMore: false });

    await mount();

    const tab = moderationTab();
    expect(tab).not.toBeNull();
    expect(tab?.textContent).toMatch(/moderation|moderação/i);
  });
});
