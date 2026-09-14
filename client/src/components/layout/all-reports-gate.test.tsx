// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "@pqp/shared";

/**
 * The moderation door in Settings is invisible to everyone until the
 * account's own `/api/me` response says otherwise: `user.isInstanceModerator`,
 * computed server-side from `INSTANCE_MODERATOR_CLERK_IDS` (`toOwnUser` in
 * `server/src/api/index.ts`) and nothing the client can influence. This pins
 * the gate itself — `settings-modal.tsx`'s `canModerateInstance` derivation
 * and the `visibleSections` filter it drives — rather than anything inside
 * `AllReportsSection`, which has its own reason to exist and its own tests
 * would cover its list.
 *
 * Deliberately NOT gated by probing `GET /api/reports/all` and reading its
 * 404: firing that request on every Settings open, for every account, would
 * put a "Failed to load resource: 404" in the browser console of the
 * near-totality of people who are not moderators — a real regression this
 * suite caught once (a fetch-based version of this gate broke
 * `theme-switching.spec.ts`'s "no console errors" check in CI). The flag is a
 * plain, synchronous prop; there is nothing async to await here.
 */

// The footer's sign-out control renders nothing under the dev bypass rather
// than reaching for `useClerk()`, which throws outside a `<ClerkProvider>` —
// and this test has no reason to stand one up just to render a button that is
// not what is under test.
vi.stubEnv("VITE_DEV_AUTH_BYPASS", "true");

const { SettingsModal, defaultLocalSettings } = await import(
  "./settings-modal"
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function makeUser(isInstanceModerator: boolean): User {
  return {
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
    bannerUrl: null,
    customStatus: null,
    isInstanceModerator,
  } as unknown as User;
}

async function mount(user: User) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <SettingsModal
        open
        user={user}
        localSettings={defaultLocalSettings}
        blockedUsers={[]}
        onClose={() => {}}
        onLocalSave={() => {}}
        onUserUpdated={() => {}}
        onUnblockUser={() => {}}
      />,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function moderationTab(): Element | null {
  return document.getElementById("settings-tab-moderation");
}

describe("Settings' moderation section gate", () => {
  it("stays off the nav for an account isInstanceModerator says no to", async () => {
    await mount(makeUser(false));

    expect(moderationTab()).toBeNull();
  });

  it("joins the nav once user.isInstanceModerator is true", async () => {
    await mount(makeUser(true));

    const tab = moderationTab();
    expect(tab).not.toBeNull();
    expect(tab?.textContent).toMatch(/moderation|moderação/i);
  });
});
