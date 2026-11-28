// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { WatchPartyHistoryEntry } from "@/lib/watch-party-history-api";

/**
 * "Apagar gravação" from the history dialog: the quiet trash control on each
 * finished row, the confirmation in front of it, and what the dialog does with
 * the three outcomes (deleted, refused, already gone).
 *
 * The API module is replaced, so what is pinned is the dialog's own flow: the
 * request is only sent from the confirm button, cancel is where focus starts
 * and Escape backs out, the request shows as busy, a failure keeps the dialog
 * open with the reason, and a success takes the row out of the list. Reduced
 * motion is switched on so the row leaves in the same tick; the fold itself is
 * CSS.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const api = vi.hoisted(() => ({
  fetchWatchPartyHistory: vi.fn(),
  deleteWatchPartyHistoryBroadcast: vi.fn(),
  setWatchPartyHistoryKeepReplay: vi.fn(),
  fetchWatchPartyHistoryReplay: vi.fn(),
  fetchWatchPartyHistoryDownloads: vi.fn(),
}));

vi.mock("@/lib/watch-party-history-api", () => ({
  ...api,
  WATCH_PARTY_DOWNLOAD_KINDS: ["film", "camera", "voice"],
}));
vi.mock("@/components/voice/hls-watch-player", () => ({
  HlsWatchPlayer: () => null,
}));

const { WatchPartyHistoryDialog, WatchPartyHistoryList } = await import(
  "./watch-party-history-dialog"
);

function entry(
  sessionId: string,
  title: string,
  overrides: Partial<WatchPartyHistoryEntry> = {},
): WatchPartyHistoryEntry {
  return {
    sessionId,
    title,
    startedAt: "2026-09-12T21:00:00.000Z",
    endedAt: "2026-09-12T23:30:00.000Z",
    durationSeconds: 9_000,
    presenter: { userId: "u1", displayName: "Alice" },
    replayAvailable: true,
    keepReplay: true,
    ...overrides,
  };
}

const FRIDAY = entry("1700000000000", "Filme da sexta");
const SATURDAY = entry("1700000100000", "Sessão coruja", {
  startedAt: "2026-09-13T01:00:00.000Z",
});

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  // Reduced motion: a deleted row leaves in the same tick, no timers.
  window.matchMedia = ((query: string) => ({
    matches: query.includes("reduce"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  api.fetchWatchPartyHistory.mockResolvedValue({
    broadcasts: [FRIDAY, SATURDAY],
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
});

async function mountDialog() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <WatchPartyHistoryDialog open onClose={() => {}} channelId="chan-1" />,
    );
  });
}

function rows(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      "[data-testid='watch-party-history-row']",
    ),
  ];
}

function deleteButtons(): HTMLButtonElement[] {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(
      "[data-testid='watch-party-history-delete']",
    ),
  ];
}

function confirmDialog(): HTMLElement | null {
  return (
    (document
      .querySelector("[data-testid='watch-party-history-delete-name']")
      ?.closest("[role='dialog']") as HTMLElement | null | undefined) ?? null
  );
}

const byTestId = (id: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`[data-testid='${id}']`)!;

async function openConfirm(index = 0) {
  await act(async () => {
    deleteButtons()[index]!.click();
  });
}

function escape() {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
}

describe("the delete control on a row", () => {
  it("is on every finished row, labelled, and not on a live one", () => {
    const html = renderToStaticMarkup(
      <WatchPartyHistoryList
        broadcasts={[
          FRIDAY,
          entry("1700000200000", "Ao vivo agora", {
            endedAt: null,
            durationSeconds: null,
            replayAvailable: false,
          }),
        ]}
        loading={false}
        error={null}
        busySessionId={null}
        onToggleKeepReplay={() => {}}
        onWatch={() => {}}
        onRequestDelete={() => {}}
      />,
    );
    expect(html.match(/data-testid="watch-party-history-delete"/g)).toHaveLength(
      1,
    );
    expect(html).toContain('aria-label="Delete recording"');
  });

  it("is absent when the list is not given a way to delete", () => {
    const html = renderToStaticMarkup(
      <WatchPartyHistoryList
        broadcasts={[FRIDAY]}
        loading={false}
        error={null}
        busySessionId={null}
        onToggleKeepReplay={() => {}}
        onWatch={() => {}}
      />,
    );
    expect(html).not.toContain("watch-party-history-delete");
  });

  it("is quiet: a ghost icon button, not the danger colour at rest", () => {
    const html = renderToStaticMarkup(
      <WatchPartyHistoryList
        broadcasts={[FRIDAY]}
        loading={false}
        error={null}
        busySessionId={null}
        onToggleKeepReplay={() => {}}
        onWatch={() => {}}
        onRequestDelete={() => {}}
      />,
    );
    const button = html.match(
      /<button[^>]*data-testid="watch-party-history-delete"[^>]*>/,
    )![0];
    expect(button).toContain("text-text-tertiary");
    expect(button).not.toMatch(/(^|[ "])bg-danger/);
    expect(button).not.toMatch(/(^|[ "])text-danger/);
  });
});

describe("the confirmation", () => {
  it("names the broadcast, says it is final, and starts on Cancel", async () => {
    await mountDialog();
    expect(rows()).toHaveLength(2);
    await openConfirm(0);

    const dialog = confirmDialog()!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("Delete this recording?");
    expect(dialog.textContent).toContain("Filme da sexta");
    expect(dialog.textContent).toContain("2026");
    expect(dialog.textContent).toContain("for everyone");
    expect(dialog.textContent).toContain("cannot be undone");
    expect(dialog.textContent).toContain("already downloaded");
    expect(document.activeElement).toBe(
      byTestId("watch-party-history-delete-cancel"),
    );
    // Opening it sends nothing.
    expect(api.deleteWatchPartyHistoryBroadcast).not.toHaveBeenCalled();
  });

  it("Escape cancels: the dialog closes, the history dialog stays, nothing is deleted", async () => {
    await mountDialog();
    await openConfirm(0);
    escape();
    expect(confirmDialog()).toBeNull();
    expect(rows()).toHaveLength(2);
    expect(document.body.textContent).toContain("Past broadcasts");
    expect(api.deleteWatchPartyHistoryBroadcast).not.toHaveBeenCalled();
  });

  it("Cancel closes it and nothing is deleted", async () => {
    await mountDialog();
    await openConfirm(0);
    await act(async () => {
      byTestId("watch-party-history-delete-cancel").click();
    });
    expect(confirmDialog()).toBeNull();
    expect(rows()).toHaveLength(2);
    expect(api.deleteWatchPartyHistoryBroadcast).not.toHaveBeenCalled();
  });

  it("confirms for the row that was asked about, shows busy while it runs, then drops that row only", async () => {
    let finish!: (value: { broadcasts: WatchPartyHistoryEntry[] }) => void;
    api.deleteWatchPartyHistoryBroadcast.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await mountDialog();
    await openConfirm(1);
    expect(confirmDialog()!.textContent).toContain("Sessão coruja");

    await act(async () => {
      byTestId("watch-party-history-delete-confirm").click();
    });
    expect(api.deleteWatchPartyHistoryBroadcast).toHaveBeenCalledTimes(1);
    expect(api.deleteWatchPartyHistoryBroadcast).toHaveBeenCalledWith(
      "chan-1",
      SATURDAY.sessionId,
    );
    // In flight: both buttons are off, the label says so, Escape does not leave.
    const confirm = byTestId("watch-party-history-delete-confirm");
    expect(confirm.disabled).toBe(true);
    expect(confirm.getAttribute("aria-busy")).toBe("true");
    expect(confirm.textContent).toContain("Deleting");
    expect(byTestId("watch-party-history-delete-cancel").disabled).toBe(true);
    escape();
    expect(confirmDialog()).not.toBeNull();

    await act(async () => {
      finish({ broadcasts: [FRIDAY] });
    });
    expect(confirmDialog()).toBeNull();
    expect(rows().map((row) => row.textContent)).toHaveLength(1);
    expect(rows()[0]!.textContent).toContain("Filme da sexta");
    expect(document.body.textContent).not.toContain("Sessão coruja");
  });

  it("a second click while it runs sends one request", async () => {
    api.deleteWatchPartyHistoryBroadcast.mockReturnValue(
      new Promise(() => {}),
    );
    await mountDialog();
    await openConfirm(0);
    await act(async () => {
      byTestId("watch-party-history-delete-confirm").click();
    });
    await act(async () => {
      byTestId("watch-party-history-delete-confirm").click();
    });
    expect(api.deleteWatchPartyHistoryBroadcast).toHaveBeenCalledTimes(1);
  });

  it("a failure keeps the dialog open with the reason and the row in place, and can be retried", async () => {
    api.deleteWatchPartyHistoryBroadcast.mockRejectedValueOnce(
      new ApiError(500, "Internal server error"),
    );
    await mountDialog();
    await openConfirm(0);
    await act(async () => {
      byTestId("watch-party-history-delete-confirm").click();
    });

    expect(confirmDialog()).not.toBeNull();
    expect(
      byTestId("watch-party-history-delete-error").textContent,
    ).toBe("Could not delete it. Try again.");
    // Not the server's English sentence, and the buttons are back.
    expect(confirmDialog()!.textContent).not.toContain("Internal server error");
    expect(byTestId("watch-party-history-delete-confirm").disabled).toBe(false);
    expect(rows()).toHaveLength(2);

    api.deleteWatchPartyHistoryBroadcast.mockResolvedValueOnce({
      broadcasts: [SATURDAY],
    });
    await act(async () => {
      byTestId("watch-party-history-delete-confirm").click();
    });
    expect(confirmDialog()).toBeNull();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.textContent).toContain("Sessão coruja");
  });

  it("says so when the broadcast is still live (409), and keeps the row", async () => {
    api.deleteWatchPartyHistoryBroadcast.mockRejectedValueOnce(
      new ApiError(409, "This broadcast is still live"),
    );
    await mountDialog();
    await openConfirm(0);
    await act(async () => {
      byTestId("watch-party-history-delete-confirm").click();
    });
    expect(byTestId("watch-party-history-delete-error").textContent).toBe(
      "This broadcast is still live.",
    );
    expect(rows()).toHaveLength(2);
  });

  it("treats 404 as done: somebody else deleted it first", async () => {
    api.deleteWatchPartyHistoryBroadcast.mockRejectedValueOnce(
      new ApiError(404, "Broadcast not found"),
    );
    await mountDialog();
    await openConfirm(0);
    await act(async () => {
      byTestId("watch-party-history-delete-confirm").click();
    });
    expect(confirmDialog()).toBeNull();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.textContent).toContain("Sessão coruja");
  });
});

describe("a row folding away (motion allowed)", () => {
  it("marks the row as exiting, then removes it after the fold", async () => {
    vi.useFakeTimers();
    try {
      window.matchMedia = ((query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      })) as unknown as typeof window.matchMedia;
      api.deleteWatchPartyHistoryBroadcast.mockResolvedValue({
        broadcasts: [SATURDAY],
      });
      await mountDialog();
      await openConfirm(0);
      await act(async () => {
        byTestId("watch-party-history-delete-confirm").click();
      });
      // Still in the DOM, folding.
      expect(rows()).toHaveLength(2);
      expect(rows()[0]!.hasAttribute("data-exiting")).toBe(true);
      expect(rows()[0]!.className).toContain("grid-rows-[0fr]");
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(rows()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
