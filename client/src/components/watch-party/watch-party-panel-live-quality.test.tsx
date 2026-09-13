// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WatchParty } from "@pqp/shared";
import { WatchPartyPanel } from "./watch-party-panel";
import { writeWatchPartyStreamQuality } from "@/lib/watch-party-stream-quality";

/**
 * The live surface's go-live checklist keeps its OWN `quality` state
 * (`liveQuality` in `LiveSurface`) rather than reading `localStorage`
 * straight into the render, because `StreamQualityControl` — a sibling
 * component — is the only thing that ever changes the choice, and a plain
 * `useMemo` read at mount would go stale the moment it did (already fixed
 * and pinned by the static suite's own "quality" assertions, plus the
 * `onStreamQualityChange` wiring in `watch-party-transmission.test.tsx`).
 *
 * THIS FILE is the other way that state can go stale: the account it was
 * read FOR changes while the panel never unmounts (a dev-bypass suffix
 * swap, or a real sign-out/sign-in on a shared machine), which a lazy
 * `useState` initializer cannot see on its own (Farol, 2026-09-13). It
 * needs a real DOM and a real rerender to reach, which is why it is not in
 * `watch-party-panel.test.tsx`'s `renderToStaticMarkup` suite.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const PARTY: WatchParty = {
  id: "11111111-1111-4111-8111-111111111111",
  channelId: "22222222-2222-4222-8222-222222222222",
  serverId: "33333333-3333-4333-8333-333333333333",
  name: "Cinemoon",
  description: null,
  state: "live",
  startsAt: null,
  wentLiveAt: "2026-09-08T12:00:00.000Z",
  endedAt: null,
  hostUserId: "44444444-4444-4444-8444-444444444444",
  hostDisplayName: "Alice",
  hostAvatarUrl: null,
  hostDisconnectedAt: null,
  cohosts: [],
  options: {
    voiceEnabled: false,
    stageMode: "hosts_only",
    raiseHand: true,
    slowModeSeconds: 0,
    reactionsEnabled: true,
  },
  viewerRole: "host",
  reminding: false,
  stage: { invited: [], hands: [], handRaised: false },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  window.localStorage.clear();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function renderLive(currentUserId: string) {
  act(() => {
    root.render(
      <WatchPartyPanel
        party={PARTY}
        channelId={PARTY.channelId}
        channelName="cinemoon"
        canStart
        inCall={false}
        hasStream={false}
        someoneIsSharing={false}
        isPresenting={false}
        audienceCount={0}
        onCreate={() => {}}
        onGoLive={async () => {}}
        onEnd={async () => {}}
        onDiscard={async () => {}}
        onOptionsChange={async () => {}}
        onRename={async () => {}}
        onClaimHost={async () => {}}
        onJoinCall={() => {}}
        onShareScreen={async () => {}}
        currentUserId={currentUserId}
        slot="surface"
      />,
    );
  });
}

function qualityRowText(): string | null {
  return container.querySelector('[data-watch-party-checklist-item="quality"]')
    ?.textContent ?? null;
}

describe("the live go-live checklist's quality row, per account", () => {
  it("re-reads the stored quality when the signed-in account changes", () => {
    writeWatchPartyStreamQuality("1080p", "alice");
    writeWatchPartyStreamQuality("720p", "bob");

    renderLive("alice");
    expect(qualityRowText()).toContain("1080p");

    // Same mounted panel, a different account — the exact scenario a lazy
    // `useState` initializer cannot see on its own.
    renderLive("bob");
    expect(qualityRowText()).toContain("720p: the safe default");
    expect(qualityRowText()).not.toContain("1080p");
  });
});
