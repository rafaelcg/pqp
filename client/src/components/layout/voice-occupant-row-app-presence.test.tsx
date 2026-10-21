// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AppConfigEntry, AppSessionSummary, AppsConfig, VoiceParticipant } from "@pqp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { loadAppsConfig, resetAppsConfigForTests } from "@/hooks/use-apps-config";
import { applyCatchUp, resetAppSessionsForTests } from "@/lib/apps/app-sessions-store";
import { VoiceOccupantRow } from "./voice-occupant-row";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ fetchAppsConfig: vi.fn() }));
vi.mock("@/lib/apps/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/apps/api")>();
  return { ...real, fetchAppsConfig: api.fetchAppsConfig };
});

const SERVER = "00000000-0000-4000-8000-0000000000a1";
const CHANNEL = "00000000-0000-4000-8000-0000000000c1";
const SESSION = "00000000-0000-4000-8000-0000000000d1";
const ANA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const app = {
  id: "pqp-eco",
  version: "1.0.0",
  category: "tool",
  icon: "sparkles",
  name: "name",
  description: "description",
  channelTypes: ["text", "voice"],
  players: { min: 1, max: 8, spectators: true, maxSpectators: 50 },
  capabilities: { identity: "display", share: "none", localFiles: { allowed: false }, peer: "none" },
  content: { userText: false, userImages: false },
  hostBound: false,
  i18n: {
    "pt-BR": { "presence.phrase": "{name} tá no Eco", "presence.short": "No Eco" },
    en: { "presence.phrase": "{name} is in Eco", "presence.short": "In Eco" },
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

function session(userIds: string[]): AppSessionSummary {
  return {
    id: SESSION,
    appId: "pqp-eco",
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

const ana = {
  userId: ANA,
  displayName: "Ana",
  avatarUrl: null,
  muted: false,
  deafened: false,
} as unknown as VoiceParticipant;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(async () => {
  resetAppSessionsForTests();
  resetAppsConfigForTests();
  api.fetchAppsConfig.mockReset();
  api.fetchAppsConfig.mockResolvedValue({
    enabled: true,
    origin: "http://localhost:5175",
    apps: [app],
  } satisfies AppsConfig);
  await loadAppsConfig(SERVER);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <TooltipProvider>
        <ul>
          <VoiceOccupantRow
            person={ana}
            channelId="c1"
            isSpeaking={false}
            canDrag={false}
            items={[]}
            onDragStart={() => {}}
            onDragEnd={() => {}}
          />
        </ul>
      </TooltipProvider>,
    );
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const row = () => host!.querySelector<HTMLElement>(`[data-voice-occupant="${ANA}"]`)!;
const appLine = () => host!.querySelector(`[data-voice-occupant-app="${ANA}"]`);

describe("the voice roster row while somebody is in an app", () => {
  it("is one line until the person opens an app, then a short second line, and one line again", () => {
    expect(appLine()).toBeNull();
    act(() => applyCatchUp(SERVER, [CHANNEL], [{ channelId: CHANNEL, session: session([ANA]) }], 0));
    expect(appLine()?.textContent).toBe("In Eco");
    // The row says it to a screen reader too.
    expect(row().getAttribute("aria-label")).toContain("In Eco");
    act(() => applyCatchUp(SERVER, [CHANNEL], [], 0));
    expect(appLine()).toBeNull();
    expect(row().getAttribute("aria-label")).not.toContain("In Eco");
  });

  it("does not move for somebody else's app", () => {
    act(() =>
      applyCatchUp(
        SERVER,
        [CHANNEL],
        [{ channelId: CHANNEL, session: session(["cccccccc-cccc-4ccc-8ccc-cccccccccccc"]) }],
        0,
      ),
    );
    expect(appLine()).toBeNull();
  });
});
