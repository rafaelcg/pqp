import type { AppConfigEntry, AppSessionSummary, AppsConfig } from "@pqp/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileStatusLine } from "@/components/apps/app-presence-line";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProfilePopoverProvider } from "@/components/user/user-profile-popover";
import { loadAppsConfig, resetAppsConfigForTests } from "@/hooks/use-apps-config";
import type { ServerMember } from "@/lib/api";
import {
  applyCatchUp,
  resetAppSessionsForTests,
} from "@/lib/apps/app-sessions-store";
import { MemberSidebar } from "./member-sidebar";

/**
 * The app line under a name replaces the recado while the person is in an app
 * (decision 6), and the recado is back the moment they leave. Static markup,
 * like the recado's own suite beside this one: it is all first paint.
 */

const api = vi.hoisted(() => ({ fetchAppsConfig: vi.fn() }));
vi.mock("@/lib/apps/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/apps/api")>();
  return { ...real, fetchAppsConfig: api.fetchAppsConfig };
});

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SERVER_ID = "22222222-2222-4222-8222-222222222222";
const CHANNEL = "33333333-3333-4333-8333-333333333333";
const OTHER_CHANNEL = "44444444-4444-4444-8444-444444444444";
const ANA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BRUNO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION = "55555555-5555-4555-8555-555555555555";

const LOCADORA = {
  id: "pqp-locadora",
  version: "1.0.0",
  category: "emulator",
  icon: "gamepad",
  name: "name",
  description: "description",
  channelTypes: ["text", "voice"],
  players: { min: 1, max: 4, spectators: false, maxSpectators: 0 },
  capabilities: { identity: "display", share: "none", localFiles: { allowed: false }, peer: "none" },
  content: { userText: false, userImages: false },
  hostBound: false,
  i18n: {
    "pt-BR": { "presence.phrase": "{name} tá na Locadora", "presence.short": "Na Locadora" },
    en: { "presence.phrase": "{name} is in Locadora", "presence.short": "In Locadora" },
    es: {},
  },
  entry: { url: null },
  assets: [],
  sandbox: {},
  presence: { phrase: "presence.phrase", short: "presence.short" },
  available: true,
  reason: null,
  shareAllowed: true,
} as unknown as AppConfigEntry;

function sessionWith(userIds: string[]): AppSessionSummary {
  return {
    id: SESSION,
    appId: "pqp-locadora",
    appVersion: "1.0.0",
    startedBy: userIds[0] ?? null,
    hostUserId: userIds[0] ?? null,
    startedAt: "2026-10-19T09:59:00.000Z",
    participants: userIds.map((userId) => ({
      userId,
      role: "player" as const,
      joinedAt: "2026-10-19T10:00:00.000Z",
      connection: "present" as const,
    })),
    players: userIds.length,
    spectators: 0,
    handoff: null,
  };
}

function member(overrides: Partial<ServerMember> & { id: string }): ServerMember {
  return {
    displayName: "Ana",
    username: "ana",
    tag: "ana#0001",
    role: "member",
    avatarUrl: null,
    status: "online",
    customStatus: null,
    ...overrides,
  };
}

function render(members: ServerMember[], serverId = SERVER_ID): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>
        <ProfilePopoverProvider
          currentUserId={BRUNO}
          blockedUserIds={new Set<string>()}
          moderation={null}
          onOpenConversation={() => {}}
          onBlockUser={() => {}}
          onUnblockUser={() => {}}
          onReportUser={() => {}}
        >
          <MemberSidebar
            open
            wide
            onClose={() => {}}
            serverId={serverId}
            participants={null}
            self={null}
            currentUserId={BRUNO}
            role="member"
            blockedUserIds={new Set<string>()}
            members={members}
            onBlockUser={() => {}}
            onUnblockUser={() => {}}
          />
        </ProfilePopoverProvider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  resetAppSessionsForTests();
  resetAppsConfigForTests();
  api.fetchAppsConfig.mockReset();
  api.fetchAppsConfig.mockResolvedValue({
    enabled: true,
    origin: "http://localhost:5175",
    apps: [LOCADORA],
  } satisfies AppsConfig);
  await loadAppsConfig(SERVER_ID);
});

describe("the member row while somebody is in an app", () => {
  it("shows the app, and not the recado, for the person in it", () => {
    applyCatchUp(SERVER_ID, [CHANNEL], [{ channelId: CHANNEL, session: sessionWith([ANA]) }], 0);
    const html = render([
      member({ id: ANA, displayName: "Ana", customStatus: "volto as 20h" }),
      member({ id: BRUNO, displayName: "Bruno", customStatus: "na faculdade" }),
    ]);
    expect(html).toContain("In Locadora");
    expect(html).toContain(`data-member-app-presence="${ANA}"`);
    // Ana's recado gives way; Bruno, who is in no app, keeps his.
    expect(html).not.toContain("volto as 20h");
    expect(html).toContain("na faculdade");
    expect(html).toContain(`data-member-custom-status="${BRUNO}"`);
  });

  it("brings the recado back once the person has left", () => {
    applyCatchUp(SERVER_ID, [CHANNEL], [{ channelId: CHANNEL, session: sessionWith([ANA]) }], 0);
    applyCatchUp(SERVER_ID, [CHANNEL], [], 0);
    const html = render([member({ id: ANA, customStatus: "volto as 20h" })]);
    expect(html).toContain("volto as 20h");
    expect(html).not.toContain("data-member-app-presence");
  });

  it("draws nothing extra for a person in an app and with no recado, except the app line", () => {
    applyCatchUp(SERVER_ID, [CHANNEL], [{ channelId: CHANNEL, session: sessionWith([ANA]) }], 0);
    const html = render([member({ id: ANA, customStatus: null })]);
    expect(html).toContain("In Locadora");
  });

  it("does not show another server's activity in this server's list", () => {
    applyCatchUp(OTHER_SERVER_ID, [OTHER_CHANNEL], [{ channelId: OTHER_CHANNEL, session: sessionWith([ANA]) }], 0);
    const html = render([member({ id: ANA, customStatus: "volto as 20h" })]);
    expect(html).not.toContain("In Locadora");
    expect(html).toContain("volto as 20h");
  });
});

describe("the profile card's line", () => {
  it("is a sentence with the name while they are in the app, the recado otherwise", () => {
    applyCatchUp(SERVER_ID, [CHANNEL], [{ channelId: CHANNEL, session: sessionWith([ANA]) }], 0);
    const inApp = renderToStaticMarkup(
      <ProfileStatusLine userId={ANA} displayName="Ana" customStatus="volto as 20h" />,
    );
    expect(inApp).toContain("Ana is in Locadora");
    expect(inApp).toContain("data-profile-app-presence");
    expect(inApp).not.toContain("volto as 20h");
    const out = renderToStaticMarkup(
      <ProfileStatusLine userId={BRUNO} displayName="Bruno" customStatus="na faculdade" />,
    );
    expect(out).toContain("na faculdade");
    expect(out).toContain("data-profile-custom-status");
    const none = renderToStaticMarkup(
      <ProfileStatusLine userId={BRUNO} displayName="Bruno" customStatus={null} />,
    );
    expect(none).toBe("");
  });

  it("writes a name with $& or {name} in it literally", () => {
    applyCatchUp(SERVER_ID, [CHANNEL], [{ channelId: CHANNEL, session: sessionWith([ANA]) }], 0);
    const html = renderToStaticMarkup(
      <ProfileStatusLine userId={ANA} displayName={"a$&{name}"} customStatus={null} />,
    );
    // The `&` is HTML-escaped by the renderer; the `$&` was not expanded and
    // the `{name}` was not filled in a second time.
    expect(html).toContain("a$&amp;{name} is in Locadora");
  });
});
