// @vitest-environment jsdom
import { act, forwardRef, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AppConfigEntry, AppSessionSummary } from "@pqp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The app's own sound in a share of its pane (`share.audio`). The share asks the frame for its sound, and the
 * track the page makes of it is what is published as the share's sound: never the tab's, which holds the call.
 */

const config = vi.hoisted(() => ({
  state: { enabled: true, loaded: true, origin: "http://localhost:5175" as string | null, apps: [] as unknown[] },
}));
const pane = vi.hoisted(() => ({
  props: null as null | { onShare?: (on: boolean) => Promise<boolean>; shareAudio?: unknown },
  element: null as HTMLElement | null,
}));
const capture = vi.hoisted(() => ({
  region: false,
  cropped: true,
  stream: { getTracks: () => [{ stop: () => {} }] } as unknown as MediaStream,
}));
const relay = vi.hoisted(() => ({
  track: { kind: "audio", id: "app-sound" } as unknown as MediaStreamTrack | null,
  begin: vi.fn(),
  end: vi.fn(),
  lost: null as null | (() => void),
}));

vi.mock("@/hooks/use-apps-config", () => ({ useAppsConfig: () => config.state }));
vi.mock("@/hooks/use-md-up", () => ({ useMdUp: () => true }));
vi.mock("@/lib/apps/api", () => ({ endAppSessionRequest: vi.fn(async () => true) }));
vi.mock("@/lib/desktop", () => ({ isDesktopApp: () => false }));
vi.mock("@/lib/apps/pane-share", () => ({
  supportsRegionCapture: () => capture.region,
  openPaneCapture: vi.fn(async () => ({ stream: capture.stream, cropped: capture.cropped })),
}));
vi.mock("@/lib/apps/share-audio", () => ({
  ShareAudioRelay: class {
    begin = relay.begin;
    end = relay.end;
    push = vi.fn();
    subscribe = vi.fn(() => () => {});
    onLost = vi.fn((listener: () => void) => {
      relay.lost = listener;
      return () => {};
    });
  },
}));
vi.mock("@/components/apps/app-pane", () => ({
  AppPane: forwardRef<{ focus(): void; element(): HTMLElement | null }, Record<string, unknown>>(
    function FakePane(props, ref) {
      useImperativeHandle(ref, () => ({ focus: () => {}, element: () => pane.element }), []);
      pane.props = props as never;
      return <div data-testid="pane" />;
    },
  ),
}));

import {
  applyChannelApp,
  resetAppSessionsForTests,
  setAppsOnline,
  setAppsViewer,
} from "@/lib/apps/app-sessions-store";
import { AppSessionLayout } from "./app-session-layout";
import { TooltipProvider } from "@/components/ui/tooltip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME = "00000000-0000-4000-8000-000000000001";
const CHANNEL = "22222222-2222-4222-8222-222222222222";
const SESSION = "11111111-1111-4111-8111-111111111111";

const locadora = {
  id: "pqp-locadora",
  version: "1.0.5",
  category: "game",
  icon: "gamepad",
  name: "name",
  description: "d",
  presence: { phrase: "p", short: "s" },
  channelTypes: ["text", "voice"],
  players: { min: 1, max: 1, spectators: true, maxSpectators: 50 },
  capabilities: { identity: "display", share: "pane", localFiles: { allowed: true }, peer: "none" },
  content: { userText: false, userImages: false },
  hostBound: false,
  i18n: { "pt-BR": { name: "Locadora" }, en: { name: "Locadora" } },
  entry: { url: "http://localhost:5175/pqp-locadora/1.0.5/index.html" },
  assets: [],
  available: true,
  reason: null,
  shareAllowed: true,
} as unknown as AppConfigEntry;

function summary(): AppSessionSummary {
  return {
    id: SESSION,
    appId: "pqp-locadora",
    appVersion: "1.0.5",
    startedBy: ME,
    hostUserId: ME,
    startedAt: "2026-10-19T19:50:00Z",
    participants: [{ userId: ME, role: "player", joinedAt: "2026-10-19T19:50:00Z", connection: "present" }],
    players: 1,
    spectators: 0,
    handoff: null,
  } as AppSessionSummary;
}

const voice = {
  inCall: true,
  sharing: false,
  others: 1,
  startShare: vi.fn(async (_stream?: MediaStream, _extras?: { appAudio?: MediaStreamTrack }) => true),
  stopShare: vi.fn(),
};

let root: Root | null = null;
let host: HTMLElement | null = null;

function tree() {
  return (
    <TooltipProvider>
      <AppSessionLayout
        serverId="srv"
        channelId={CHANNEL}
        channelType="voice"
        viewerId={ME}
        canModerate={false}
        people={new Map([[ME, { displayName: "rafa" }]])}
        voice={{ ...voice }}
      >
        <div data-testid="chat" />
      </AppSessionLayout>
    </TooltipProvider>
  );
}

function render() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(tree()));
}

function rerender() {
  act(() => root!.render(tree()));
}


beforeEach(() => {
  resetAppSessionsForTests();
  setAppsViewer(ME);
  setAppsOnline(true);
  config.state = { enabled: true, loaded: true, origin: "http://localhost:5175", apps: [locadora] };
  voice.sharing = false;
  voice.startShare.mockReset();
  voice.startShare.mockResolvedValue(true);
  voice.stopShare.mockReset();
  relay.begin.mockReset();
  relay.begin.mockImplementation(() => relay.track);
  relay.end.mockReset();
  capture.region = false;
  capture.cropped = true;
  pane.element = document.createElement("div");
  applyChannelApp(CHANNEL, summary());
  render();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function share(on: boolean): Promise<boolean> {
  let result = false;
  await act(async () => {
    result = await pane.props!.onShare!(on);
  });
  return result;
}

describe("a share of the app pane carries the app's own sound", () => {
  it("gives the pane the relay the frame hands its sound to", () => {
    expect(pane.props?.shareAudio).toBeDefined();
  });

  it("whole tab path: the share starts with the app's sound track, asked for before the picker", async () => {
    expect(await share(true)).toBe(true);
    expect(relay.begin).toHaveBeenCalledTimes(1);
    expect(voice.startShare).toHaveBeenCalledWith(undefined, { appAudio: relay.track });
  });

  it("region path: the cropped picture goes with the app's sound track", async () => {
    capture.region = true;
    expect(await share(true)).toBe(true);
    expect(voice.startShare).toHaveBeenCalledWith(capture.stream, { appAudio: relay.track });
  });

  it("region path: a picture that is not the pane (another surface was picked) does not get the app's sound", async () => {
    capture.region = true;
    capture.cropped = false;
    expect(await share(true)).toBe(true);
    expect(voice.startShare).toHaveBeenCalledWith(capture.stream, undefined);
    expect(relay.end).toHaveBeenCalled();
  });

  it("where no sound can be made the share goes out as a picture, as it always could", async () => {
    relay.begin.mockImplementation(() => null);
    expect(await share(true)).toBe(true);
    expect(voice.startShare).toHaveBeenCalledWith(undefined, undefined);
  });

  it("stops asking the app for sound when the share does not start", async () => {
    voice.startShare.mockResolvedValue(false);
    expect(await share(true)).toBe(false);
    expect(relay.end).toHaveBeenCalled();
  });

  it("stops asking the app for sound when the picker is cancelled", async () => {
    voice.startShare.mockRejectedValue(new Error("cancelled"));
    expect(await share(true)).toBe(false);
    expect(relay.end).toHaveBeenCalled();
  });

  describe("when the game's sound cannot go with the share, the sharer is told", () => {
    const NOTICE = /without the game's sound/;

    it("says nothing while the sound goes", async () => {
      await share(true);
      expect(document.body.textContent).not.toMatch(NOTICE);
    });

    it("says so when no sound can be made, and takes the line down with that share", async () => {
      relay.begin.mockImplementation(() => null);
      await share(true);
      expect(document.body.textContent).toMatch(NOTICE);
      // the share is up and then goes: the line was about that share
      voice.sharing = true;
      rerender();
      expect(document.body.textContent).toMatch(NOTICE);
      voice.sharing = false;
      rerender();
      expect(document.body.textContent).not.toMatch(NOTICE);
    });

    it("says so when the person picked some other surface than the pane", async () => {
      capture.region = true;
      capture.cropped = false;
      await share(true);
      expect(document.body.textContent).toMatch(NOTICE);
    });

    it("says so when the audio of the running share stops and the browser will not start it again", async () => {
      await share(true);
      expect(document.body.textContent).not.toMatch(NOTICE);
      act(() => relay.lost!());
      expect(document.body.textContent).toMatch(NOTICE);
    });

    it("does not say it for a share that did not start", async () => {
      relay.begin.mockImplementation(() => null);
      voice.startShare.mockResolvedValue(false);
      await share(true);
      expect(document.body.textContent).not.toMatch(NOTICE);
    });
  });

  it("stops asking when the pane's own share is stopped", async () => {
    await share(true);
    relay.end.mockClear();
    await share(false);
    expect(voice.stopShare).toHaveBeenCalledTimes(1);
    expect(relay.end).toHaveBeenCalled();
  });
});
