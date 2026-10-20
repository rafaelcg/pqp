// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://pqp.gg/app" }
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FeatureHint,
  FeatureHintProvider,
  resetFeatureHintsForTests,
  useFeatureHintEnabled,
} from "@/components/layout/feature-hint";
import { WhatsNewPrompt } from "@/components/layout/whats-new-prompt";
import type { AppSessionsSnapshot } from "@/lib/apps/app-sessions-store";
import { winningCornerHint } from "@/lib/corner-hints";
import {
  FEATURE_HINT_STORAGE_KEYS,
  isFeatureHintSpentForLoad,
  useFeatureHintsSpent,
  winningFeatureHint,
  type AttachedFeatureHintId,
} from "@/lib/feature-hints";
import {
  hintQuietReasons,
  hintsAreQuiet,
  isComposerBusy,
  isModalDialogOpen,
  registerComposerActivity,
  resetHintQuietForTests,
  useComposerBusy,
  useModalDialogOpen,
  viewerSeatedInAnApp,
  type HintQuietFacts,
} from "@/lib/hint-quiet";

/*
 * QUIET CONTEXTS (`hint_budget`).
 *
 * Three properties, each pinned here with real components where a component
 * is what proves it: a context holds an unsolicited hint; a held hint stamps
 * nothing and so SHOWS WHEN THE CONTEXT ENDS; and an event is never held.
 * The URL above is not localhost on purpose: storage persists there.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", FakeResizeObserver);

const NONE: HintQuietFacts = {
  inCall: false,
  appRunning: false,
  sharing: false,
  partyLive: false,
  composerBusy: false,
  dialogOpen: false,
};

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
}

async function rerender(node: React.ReactNode) {
  await act(async () => {
    root!.render(node);
  });
}

beforeEach(() => {
  resetFeatureHintsForTests();
  resetHintQuietForTests();
  localStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
  localStorage.clear();
});

/** Past the card's exit animation (180 ms), so "gone" means gone. */
const afterExit = () => act(async () => void (await new Promise((r) => setTimeout(r, 260))));

function card(id: string): Element | null {
  return document.querySelector(`[data-corner-card="${id}"]`);
}

describe("each context holds", () => {
  const cases: Array<[string, Partial<HintQuietFacts>, string]> = [
    ["voice connected", { inCall: true }, "call"],
    ["an app or game session running", { appRunning: true }, "app"],
    ["a screen share", { sharing: true }, "share"],
    ["a live watch party", { partyLive: true }, "party"],
    ["the composer focused or holding a draft", { composerBusy: true }, "composer"],
    ["a modal dialog open", { dialogOpen: true }, "dialog"],
  ];

  for (const [name, facts, reason] of cases) {
    it(`${name} is quiet, and only with the flag on`, () => {
      const on = hintsAreQuiet({
        settled: true,
        budgetOn: true,
        facts: { ...NONE, ...facts },
      });
      expect(on.quiet).toBe(true);
      expect(on.reasons).toEqual([reason]);
      // The flag off never consults a context.
      expect(
        hintsAreQuiet({ settled: true, budgetOn: false, facts: { ...NONE, ...facts } }),
      ).toEqual({ quiet: false, reasons: [] });
    });
  }

  it("nothing going on is not quiet", () => {
    expect(hintQuietReasons(NONE)).toEqual([]);
    expect(hintsAreQuiet({ settled: true, budgetOn: true, facts: NONE }).quiet).toBe(false);
  });

  it("several contexts report every reason", () => {
    expect(hintQuietReasons({ ...NONE, inCall: true, sharing: true, dialogOpen: true })).toEqual([
      "call",
      "share",
      "dialog",
    ]);
  });

  it("until the two switches have been read, everything is held, flag or not", () => {
    expect(hintsAreQuiet({ settled: false, budgetOn: false, facts: NONE }).quiet).toBe(true);
  });
});

describe("the corner queue under a quiet context", () => {
  it("skips the campaigns but lets an event through", () => {
    const everything = {
      communityHomePost: true,
      notifyOffer: true,
      qg: true,
      listingNudge: true,
      voiceClean: true,
      seasonalLook: true,
      mobileBeta: true,
      whatsNew: true,
      cargos: true,
      shortcuts: true,
    };
    expect(winningCornerHint(everything, { quiet: true })).toBe("communityHomePost");
    expect(winningCornerHint({ ...everything, communityHomePost: false }, { quiet: true })).toBe(
      "notifyOffer",
    );
    const campaigns = { ...everything, communityHomePost: false, notifyOffer: false };
    expect(winningCornerHint(campaigns, { quiet: true })).toBeNull();
    // The same wanting, the context over: the QG is first again.
    expect(winningCornerHint(campaigns, { quiet: false })).toBe("qg");
    expect(winningCornerHint(campaigns)).toBe("qg");
  });
});

describe("a held corner card shows when the context ends", () => {
  it("stamps nothing while held, then paints and stamps once", async () => {
    await mount(<WhatsNewPrompt enabled={false} onOpen={() => {}} />);
    expect(card("whats-new")).toBeNull();
    expect(localStorage.length).toBe(0);

    await rerender(<WhatsNewPrompt enabled onOpen={() => {}} />);
    expect(card("whats-new")).not.toBeNull();
    expect(localStorage.getItem("pqp:whats-new")).not.toBeNull();
  });

  it("a card already up goes away for a quiet moment and comes back", async () => {
    await mount(<WhatsNewPrompt enabled onOpen={() => {}} />);
    expect(card("whats-new")).not.toBeNull();
    await rerender(<WhatsNewPrompt enabled={false} onOpen={() => {}} />);
    await afterExit();
    expect(card("whats-new")).toBeNull();
    await rerender(<WhatsNewPrompt enabled onOpen={() => {}} />);
    expect(card("whats-new")).not.toBeNull();
  });
});

/** App's attached-hint wiring in miniature: the winner, the quiet flag, `yielding`. */
function AttachedQueue({ quiet }: { quiet: boolean }) {
  useFeatureHintsSpent();
  const attached = winningFeatureHint({ watchNow: true, forum: true });
  const live = quiet ? null : attached;
  return (
    <FeatureHintProvider winner={attached} yielding={live === null && attached !== null}>
      <Card id="watchNow" />
      <Card id="forum" />
    </FeatureHintProvider>
  );
}

function Card({ id }: { id: AttachedFeatureHintId }) {
  const enabled = useFeatureHintEnabled(id);
  return <FeatureHint id={id} enabled={enabled} body={id} />;
}

describe("a held attached coach mark", () => {
  it("is not spent and not stamped while held, and shows when the context ends", async () => {
    await mount(<AttachedQueue quiet />);
    expect(card("watchNow")).toBeNull();
    expect(isFeatureHintSpentForLoad("watchNow")).toBe(false);
    expect(localStorage.getItem(FEATURE_HINT_STORAGE_KEYS.watchNow)).toBeNull();

    await rerender(<AttachedQueue quiet={false} />);
    expect(card("watchNow")).not.toBeNull();
    expect(localStorage.getItem(FEATURE_HINT_STORAGE_KEYS.watchNow)).toBe("1");
  });

  it("one that is up when a context starts is held, not spent, and returns", async () => {
    await mount(<AttachedQueue quiet={false} />);
    expect(card("watchNow")).not.toBeNull();

    await rerender(<AttachedQueue quiet />);
    await afterExit();
    expect(card("watchNow")).toBeNull();
    expect(isFeatureHintSpentForLoad("watchNow")).toBe(false);

    await rerender(<AttachedQueue quiet={false} />);
    expect(card("watchNow")).not.toBeNull();
    // And the next card in line was never promoted past it.
    expect(card("forum")).toBeNull();
  });
});

describe("the composer", () => {
  function Probe() {
    return <span data-busy={String(useComposerBusy())} />;
  }
  const busy = () => document.querySelector("[data-busy]")?.getAttribute("data-busy");

  it("is busy while focused or holding a draft, from any composer, and not otherwise", async () => {
    await mount(<Probe />);
    expect(busy()).toBe("false");

    const channel = registerComposerActivity();
    const thread = registerComposerActivity();
    await act(async () => channel.report({ focused: true }));
    expect(busy()).toBe("true");
    await act(async () => channel.report({ focused: false }));
    expect(busy()).toBe("false");

    await act(async () => thread.report({ draft: true }));
    expect(busy()).toBe("true");
    // One composer going away does not clear the other's draft.
    await act(async () => channel.release());
    expect(busy()).toBe("true");
    await act(async () => thread.report({ draft: false }));
    expect(busy()).toBe("false");

    await act(async () => thread.report({ focused: true }));
    await act(async () => thread.release());
    expect(isComposerBusy()).toBe(false);
  });
});

describe("a modal dialog", () => {
  function Probe({ enabled }: { enabled: boolean }) {
    return <span data-open={String(useModalDialogOpen(enabled))} />;
  }
  const open = () => document.querySelector("[data-open]")?.getAttribute("data-open");
  const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 60))));

  it("is found by aria-modal and not by a plain dialog or a popover", () => {
    expect(isModalDialogOpen()).toBe(false);
    const popover = document.createElement("div");
    popover.setAttribute("role", "dialog");
    document.body.append(popover);
    expect(isModalDialogOpen()).toBe(false);
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    expect(isModalDialogOpen()).toBe(true);
  });

  it("follows one opening and closing, and watches nothing while the flag is off", async () => {
    await mount(<Probe enabled />);
    await settle();
    expect(open()).toBe("false");

    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    await settle();
    expect(open()).toBe("true");

    modal.remove();
    await settle();
    expect(open()).toBe("false");

    // Flag off: no observer, and an open dialog reads as no context at all.
    document.body.append(modal);
    await rerender(<Probe enabled={false} />);
    await settle();
    expect(open()).toBe("false");
  });
});

describe("an app session", () => {
  const session = (userIds: string[]) =>
    ({ participants: userIds.map((userId) => ({ userId })) }) as never;
  const snapshot = (viewerId: string | null, live: Array<[string, string[]]>) =>
    ({
      viewerId,
      live: new Map(live.map(([channel, ids]) => [channel, session(ids)])),
    }) as unknown as AppSessionsSnapshot;

  it("counts only when this person is seated in a live one", () => {
    expect(viewerSeatedInAnApp(snapshot("me", []))).toBe(false);
    expect(viewerSeatedInAnApp(snapshot("me", [["c1", ["somebody"]]]))).toBe(false);
    expect(viewerSeatedInAnApp(snapshot("me", [["c1", ["somebody", "me"]]]))).toBe(true);
    expect(viewerSeatedInAnApp(snapshot(null, [["c1", ["me"]]]))).toBe(false);
  });
});
