// @vitest-environment jsdom
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "@pqp/shared";
import {
  COMMUNITY_HOME_SETTINGS_SEEN_KEY,
  isCommunityHomeSettingsNew,
} from "@/lib/community-home";
import { updateServerCommunityHomeConfig } from "@/lib/api";
import { CommunityHomeSettingsSection } from "./community-home-settings-section";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

vi.mock("@/lib/api", () => ({
  updateServerCommunityHomeConfig: vi.fn(
    async (_id: string, body: { enabled: boolean }) => ({
      enabled: body.enabled,
      version: 1,
      server: {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Mesa",
        ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        createdAt: "2026-07-01T00:00:00.000Z",
        messageRetentionDays: null,
        ssoEmailDomain: null,
        iconUrl: null,
        bannerUrl: null,
        role: "owner",
        isCommunity: false,
        communityHomeEnabled: body.enabled,
        communityHomeVersion: 1,
        showOnProfile: true,
        communityTagline: null,
        communityAbout: null,
        communityLinks: [],
        communitySlug: null,
      } satisfies Server,
    }),
  ),
}));

function mount(node: ReactElement): { root: Root; host: HTMLDivElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(node);
  });
  return { root, host };
}

describe("CommunityHomeSettingsSection discovery", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
  });

  it("shows NEW on the control while the bit is false and unseen", () => {
    expect(isCommunityHomeSettingsNew()).toBe(true);
    const { host, root } = mount(
      <CommunityHomeSettingsSection
        serverId="11111111-1111-4111-8111-111111111111"
        enabled={false}
        onUpdated={() => {}}
      />,
    );
    expect(
      host.querySelector("[data-community-home-settings-new]"),
    ).not.toBeNull();
    // Opening the panel alone must not clear discovery.
    expect(localStorage.getItem(COMMUNITY_HOME_SETTINGS_SEEN_KEY)).toBeNull();
    act(() => {
      root.unmount();
    });
  });

  it("hides NEW when the bit is already on", () => {
    const { host, root } = mount(
      <CommunityHomeSettingsSection
        serverId="11111111-1111-4111-8111-111111111111"
        enabled
        onUpdated={() => {}}
      />,
    );
    expect(host.querySelector("[data-community-home-settings-new]")).toBeNull();
    act(() => {
      root.unmount();
    });
  });

  it("clears NEW after the manager flips the toggle", async () => {
    const { host, root } = mount(
      <CommunityHomeSettingsSection
        serverId="11111111-1111-4111-8111-111111111111"
        enabled={false}
        onUpdated={() => {}}
      />,
    );
    const toggle = host.querySelector('[role="switch"]');
    expect(toggle).not.toBeNull();
    await act(async () => {
      (toggle as HTMLButtonElement).click();
    });
    expect(host.querySelector("[data-community-home-settings-new]")).toBeNull();
    expect(localStorage.getItem(COMMUNITY_HOME_SETTINGS_SEEN_KEY)).toBe("1");
    act(() => {
      root.unmount();
    });
  });

  it("keeps NEW when the request fails", async () => {
    vi.mocked(updateServerCommunityHomeConfig).mockRejectedValueOnce(
      new Error("boom"),
    );
    const { host, root } = mount(
      <CommunityHomeSettingsSection
        serverId="11111111-1111-4111-8111-111111111111"
        enabled={false}
        onUpdated={() => {}}
      />,
    );
    await act(async () => {
      (host.querySelector('[role="switch"]') as HTMLButtonElement).click();
    });
    expect(
      host.querySelector("[data-community-home-settings-new]"),
    ).not.toBeNull();
    expect(localStorage.getItem(COMMUNITY_HOME_SETTINGS_SEEN_KEY)).toBeNull();
    act(() => {
      root.unmount();
    });
  });
});
