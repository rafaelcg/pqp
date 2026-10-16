// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportContext } from "@pqp/shared";

/**
 * The "Contexto" panel on a report card, driven through its real controls.
 *
 * What has to hold: nothing is fetched until the card is expanded; an account
 * report with no message reads as a timeline (account made, five strangers
 * contacted in a burst, blocked, reported); the actions offered are exactly the
 * ones the server said this viewer has; and a termination the server refuses
 * (409, owns a server with people in it) says which servers, instead of a
 * generic failure.
 */

const { fetchMock, timeoutMock, banMock, terminateMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  timeoutMock: vi.fn(),
  banMock: vi.fn(),
  terminateMock: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchReportContext: (...args: unknown[]) => fetchMock(...args),
    timeoutMember: (...args: unknown[]) => timeoutMock(...args),
    banMember: (...args: unknown[]) => banMock(...args),
    terminateAccount: (...args: unknown[]) => terminateMock(...args),
  };
});

const { ReportContextPanel } = await import("./report-context-panel");
const { ApiError } = await import("@/lib/api");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const CREATED = "2026-10-14T12:00:00.000Z";
const at = (minutes: number) =>
  new Date(new Date(CREATED).getTime() + minutes * 60_000).toISOString();

function makeContext(overrides: Partial<ReportContext> = {}): ReportContext {
  return {
    reportId: "36",
    lens: "instance",
    account: {
      id: "11111111-1111-4111-8111-111111111111",
      displayName: "Cold Caller",
      tag: "coldcaller#0042",
      avatarUrl: null,
      createdAt: CREATED,
      deletionStartedAt: null,
      lastCountry: "BR",
    },
    signals: {
      dmsStarted: {
        total: 5,
        firstHour: 5,
        times: [at(23), at(18), at(12), at(8), at(3)],
      },
      callsPlaced: {
        total: 5,
        firstHour: 5,
        times: [at(23), at(18), at(12), at(8), at(3)],
      },
      blockedByCount: 3,
      reporterBlockedAt: at(24),
    },
    otherReports: [],
    sanctions: { bans: [], timeouts: [] },
    conversation: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        authorId: "11111111-1111-4111-8111-111111111111",
        authorName: "Cold Caller",
        authorTag: "coldcaller#0042",
        party: "reported",
        body: "\u{1F4DE} Missed call",
        createdAt: at(23),
        isCall: true,
      },
    ],
    conversationCounts: { fromReporter: 11, fromReported: 0, capped: false },
    reporter: {
      displayName: "Niki",
      tag: "niki#0001",
      createdAt: at(-60 * 24 * 3),
      filed: 7,
      actioned: 1,
      dismissed: 5,
    },
    messageServer: null,
    serverMessages: [],
    ownedServers: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        name: "SLUR-NAMED-SERVER",
        memberCount: 2,
        createdAt: at(1),
      },
    ],
    surrounding: null,
    actions: { canTerminate: true, server: null },
    ...overrides,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(note = "") {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ReportContextPanel
        report={{
          id: "36",
          subjectType: "user",
          createdAt: at(25),
          reportedUserName: "Cold Caller",
        }}
        note={note}
      />,
    );
  });
}

// The panel prints ages ("created 3 days ago") against the real clock, and the
// fixtures are fixed dates, so an unpinned run goes stale as the days pass: it
// said "3 days" until 2026-10-15 00:00Z and "4 days" after. Pin Date only
// (timers stay real) to half an hour after CREATED.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(CREATED).getTime() + 30 * 60_000);
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  fetchMock.mockReset();
  timeoutMock.mockReset();
  banMock.mockReset();
  terminateMock.mockReset();
});

function button(label: string | RegExp): HTMLButtonElement {
  const el = Array.from(document.querySelectorAll("button")).find((node) =>
    typeof label === "string"
      ? node.textContent === label
      : label.test(node.textContent ?? ""),
  );
  if (!el) {
    throw new Error(`No button labelled ${String(label)}`);
  }
  return el as HTMLButtonElement;
}

async function expand() {
  await act(async () => {
    button("Context").click();
  });
}

describe("ReportContextPanel", () => {
  it("fetches nothing until the card is expanded, then once", async () => {
    fetchMock.mockResolvedValue(makeContext());
    await mount();
    expect(fetchMock).not.toHaveBeenCalled();
    await expand();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("36");
    // Collapsing and reopening does not ask again.
    await act(async () => {
      button("Context").click();
    });
    await expand();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lays an account report out as a timeline a moderator can read at a glance", async () => {
    fetchMock.mockResolvedValue(makeContext());
    await mount();
    await expand();
    const text = host!.textContent ?? "";

    expect(text).toContain("Cold Caller");
    expect(text).toContain("Last country: BR");
    // The five contacts in twenty minutes collapse into ONE burst row.
    expect(text).toContain("5 conversations started with non-friends");
    expect(text).toContain("5 unanswered calls");
    expect(text).toContain("The reporter blocked the account");
    expect(text).toContain("This report");
    expect(text).toContain("Created the server SLUR-NAMED-SERVER (2 members)");

    const rows = Array.from(
      host!.querySelectorAll('ol[aria-label="Timeline"] > li'),
    ).map((li) => li.textContent ?? "");
    const order = [
      "Account created",
      "Created the server",
      "conversations started",
      "blocked the account",
      "This report",
    ].map((needle) => rows.findIndex((row) => row.includes(needle)));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Calls are only counted when they were missed, and the panel says so.
    expect(text).toContain("Only unanswered calls leave a record");
  });

  it("shows the reported message in its place, and names every author with a neutral chip", async () => {
    const msg = (
      id: string,
      name: string,
      party: "reporter" | "reported" | "other",
      body: string,
    ) => ({
      id,
      authorId: "11111111-1111-4111-8111-111111111111",
      authorName: name,
      authorTag: `${name.toLowerCase()}#0001`,
      party,
      body,
      createdAt: at(1),
      isCall: false,
    });
    fetchMock.mockResolvedValue(
      makeContext({
        signals: null,
        conversation: null,
        conversationCounts: null,
        reporter: null,
        messageServer: { id: "44444444-4444-4444-8444-444444444444", name: "Pedro's room", channelName: "Lobby" },
        surrounding: {
          reported: msg("55555555-5555-4555-8555-555555555555", "Niki", "reported", "Citrus"),
          before: [msg("66666666-6666-4666-8666-666666666666", "Bia", "other", "before")],
          after: [msg("77777777-7777-4777-8777-777777777777", "Caio", "reporter", "after")],
          withheld: null,
        },
      }),
    );
    await mount();
    await expand();
    const rows = Array.from(
      host!.querySelectorAll("section ul > li"),
    ).filter((li) => ["before", "Citrus", "after"].some((b) => li.textContent?.includes(b)));
    // before, THE REPORTED MESSAGE, after: in that order, nothing missing.
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("before"),
      expect.stringContaining("Citrus"),
      expect.stringContaining("after"),
    ]);
    const marked = host!.querySelector('[aria-current="true"]');
    expect(marked?.textContent).toContain("Citrus");
    expect(marked?.textContent).toContain("Reported message");
    // The NAME is always shown; the role is a chip beside it, never instead.
    expect(marked?.textContent).toContain("Niki");
    expect(marked?.textContent).toContain("reported account");
    expect(host!.textContent).toContain("Caio");
    expect(host!.textContent).toContain("who reported");
    // Where the message lives, even if the report row has no server.
    expect(host!.textContent).toContain("Message in #Lobby, server Pedro's room.");
  });

  it("says plainly when the reported account never answered the reporter", async () => {
    fetchMock.mockResolvedValue(makeContext());
    await mount();
    await expand();
    const text = host!.textContent ?? "";
    expect(text).toContain("11 messages from the reporter, 0 from Cold Caller.");
    expect(text).toContain("Cold Caller never replied.");
    // And the reporter's own record, to spot a serial reporter.
    expect(text).toContain(
      "Reporter: Niki, account created 3 days ago. Reports filed: 7 (1 actioned, 5 dismissed).",
    );
  });

  it("renders what the server sent for a server lens and nothing it did not", async () => {
    fetchMock.mockResolvedValue(
      makeContext({
        lens: "server",
        signals: null,
        conversation: null,
        conversationCounts: null,
        reporter: null,
        ownedServers: [],
        account: { ...makeContext().account!, lastCountry: null },
        actions: { canTerminate: false, server: null },
      }),
    );
    await mount();
    await expand();
    const text = host!.textContent ?? "";
    expect(text).toContain("You only see what happened in this server.");
    expect(text).not.toContain("Last country");
    expect(text).not.toContain("Conversations started with non-friends");
    expect(text).not.toContain("Terminate account");
  });

  it("says the account is gone when the server has no account to show", async () => {
    fetchMock.mockResolvedValue(
      makeContext({
        account: null,
        signals: null,
        conversation: null,
        ownedServers: [],
        actions: { canTerminate: false, server: null },
      }),
    );
    await mount();
    await expand();
    expect(host!.textContent).toContain("The reported account no longer exists.");
  });

  it("offers a refusal as a message with a retry, not a blank panel", async () => {
    fetchMock.mockRejectedValueOnce(new ApiError(404, "Report not found"));
    await mount();
    await expand();
    expect(host!.querySelector('[role="alert"]')?.textContent).toBe(
      "Report not found",
    );
    fetchMock.mockResolvedValueOnce(makeContext());
    await act(async () => {
      button("Try again").click();
    });
    expect(host!.textContent).toContain("Cold Caller");
  });

  it("times out through a confirmation, with the moderator's note as the reason", async () => {
    fetchMock.mockResolvedValue(
      makeContext({
        actions: {
          canTerminate: false,
          server: {
            id: "44444444-4444-4444-8444-444444444444",
            name: "Alpha",
            canBan: true,
            canTimeout: true,
            alreadyBanned: false,
          },
        },
      }),
    );
    timeoutMock.mockResolvedValue({ timeout: { expiresAt: at(100) }, message: "" });
    await mount("cold calls");
    await expand();

    await act(async () => {
      button("Time out").click();
    });
    await act(async () => {
      button("1 hour").click();
    });
    // Nothing has happened yet: a confirmation stands in the way.
    expect(timeoutMock).not.toHaveBeenCalled();
    await act(async () => {
      button("Time out for 1 hour").click();
    });
    expect(timeoutMock).toHaveBeenCalledWith(
      "44444444-4444-4444-8444-444444444444",
      "11111111-1111-4111-8111-111111111111",
      60,
      "cold calls",
    );
    expect(host!.textContent).toContain("Timeout applied (1 hour).");
  });

  it("bans from the report's server only after confirming", async () => {
    fetchMock.mockResolvedValue(
      makeContext({
        actions: {
          canTerminate: false,
          server: {
            id: "44444444-4444-4444-8444-444444444444",
            name: "Alpha",
            canBan: true,
            canTimeout: false,
            alreadyBanned: false,
          },
        },
      }),
    );
    banMock.mockResolvedValue({ ok: true });
    await mount();
    await expand();
    await act(async () => {
      button("Ban from Alpha").click();
    });
    expect(banMock).not.toHaveBeenCalled();
    await act(async () => {
      button("Ban member").click();
    });
    expect(banMock).toHaveBeenCalledWith(
      "44444444-4444-4444-8444-444444444444",
      "11111111-1111-4111-8111-111111111111",
      null,
    );
  });

  it("hides the server actions the viewer does not have", async () => {
    fetchMock.mockResolvedValue(
      makeContext({
        actions: {
          canTerminate: true,
          server: {
            id: "44444444-4444-4444-8444-444444444444",
            name: "Alpha",
            canBan: false,
            canTimeout: false,
            alreadyBanned: false,
          },
        },
      }),
    );
    await mount();
    await expand();
    expect(() => button("Ban from Alpha")).toThrow();
    expect(() => button("Time out")).toThrow();
    expect(button("Terminate account")).toBeTruthy();
  });

  it("names the servers in the way when a termination is refused", async () => {
    fetchMock.mockResolvedValue(makeContext());
    terminateMock.mockRejectedValue(
      new ApiError(409, "Transfer or delete", null, {
        code: "owned_servers",
        servers: [{ id: "x", name: "SLUR-NAMED-SERVER", otherMemberCount: 1 }],
      }),
    );
    await mount();
    await expand();
    await act(async () => {
      button("Terminate account").click();
    });
    // The confirm dialog's own button has the same label; it is the last one.
    const confirms = Array.from(document.querySelectorAll("button")).filter(
      (node) => node.textContent === "Terminate account",
    );
    await act(async () => {
      confirms.at(-1)!.click();
    });
    expect(terminateMock).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
    const alert = host!.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alert).toContain("SLUR-NAMED-SERVER");
    expect(alert).toContain("Transfer or delete the server first");
  });
});
