// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AllReport } from "@pqp/shared";

/**
 * Two races Farol caught in review, both about a moderator switching tabs
 * while a request from the OLD tab is still in flight:
 *
 * 1. `loadMore` fired on one tab, then the tab changes before the page
 *    arrives — the late page must not be appended onto whatever the new tab
 *    just fetched (it would silently mix two statuses into one list).
 * 2. `resolve` fired on one tab, then the tab changes before the PATCH
 *    completes and the new tab's own fetch has already shown the (now
 *    resolved) report — the completion handler must not read the STALE
 *    "which tab is this for" value and filter the report out of a tab it is
 *    supposed to remain visible on.
 *
 * Both are pinned with deferred promises so the test controls exactly which
 * request settles first, rather than hoping real timers land in the right
 * order.
 */

const { fetchAllReportsMock, resolveReportMock } = vi.hoisted(() => ({
  fetchAllReportsMock: vi.fn(),
  resolveReportMock: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>(
    "@/lib/api",
  );
  return {
    ...actual,
    fetchAllReports: (...args: unknown[]) => fetchAllReportsMock(...args),
    resolveReport: (...args: unknown[]) => resolveReportMock(...args),
  };
});

const { AllReportsSection } = await import("./all-reports-section");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeReport(overrides: Partial<AllReport>): AllReport {
  return {
    id: "1",
    subjectType: "message",
    contextKind: "server",
    reason: "spam",
    details: null,
    status: "open",
    createdAt: "2026-09-14T00:00:00.000Z",
    reporterId: "reporter-1",
    reporterName: "Reporter",
    reportedUserId: "reported-1",
    reportedUserName: "Someone",
    messageId: null,
    messageDeleted: false,
    contentSnapshot: null,
    channelId: null,
    channelName: null,
    resolvedAt: null,
    resolvedByName: null,
    resolutionNote: null,
    serverId: null,
    serverName: null,
    scan: null,
    ...overrides,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<AllReportsSection />);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  fetchAllReportsMock.mockReset();
  resolveReportMock.mockReset();
});

function tab(label: string): HTMLElement {
  const el = Array.from(
    document.querySelectorAll<HTMLElement>('[role="tab"]'),
  ).find((node) => node.textContent === label);
  if (!el) {
    throw new Error(`No tab labelled "${label}"`);
  }
  return el;
}

function buttonWithText(label: string): HTMLButtonElement {
  const el = Array.from(document.querySelectorAll("button")).find(
    (node) => node.textContent === label,
  );
  if (!el) {
    throw new Error(`No button labelled "${label}"`);
  }
  return el as HTMLButtonElement;
}

describe("AllReportsSection tab-switch races", () => {
  it("discards a load-more page that lands after the tab has changed", async () => {
    const alice = makeReport({ id: "a", reportedUserName: "Alice" });
    const bob = makeReport({ id: "b", reportedUserName: "Bob", status: "actioned" });
    const carol = makeReport({ id: "c", reportedUserName: "Carol" });

    fetchAllReportsMock.mockResolvedValueOnce({
      reports: [alice],
      hasMore: true,
    });

    await mount();
    expect(host!.textContent).toContain("Alice");

    // Click "Load more" on the open tab, but keep its response pending.
    const loadMoreDeferred = deferred<{
      reports: AllReport[];
      hasMore: boolean;
    }>();
    fetchAllReportsMock.mockReturnValueOnce(loadMoreDeferred.promise);
    await act(async () => {
      buttonWithText("Load more").click();
    });

    // Switch tabs before that page arrives. The tab's own fetch resolves
    // immediately with a different report entirely.
    fetchAllReportsMock.mockResolvedValueOnce({
      reports: [bob],
      hasMore: false,
    });
    await act(async () => {
      tab("Actioned").click();
      await Promise.resolve();
    });
    expect(host!.textContent).toContain("Bob");
    expect(host!.textContent).not.toContain("Alice");

    // Now let the stale load-more page land.
    await act(async () => {
      loadMoreDeferred.resolve({ reports: [carol], hasMore: false });
      await Promise.resolve();
      await Promise.resolve();
    });

    // Carol (from the abandoned open-tab page) must never appear, and Bob
    // (the actioned tab's own row) must still be the only thing shown.
    expect(host!.textContent).not.toContain("Carol");
    expect(host!.textContent).toContain("Bob");
    expect(host!.textContent).not.toContain("Alice");
  });

  it("does not drop a report from the tab the moderator has since switched to", async () => {
    const dana = makeReport({ id: "d", reportedUserName: "Dana", status: "open" });

    fetchAllReportsMock.mockResolvedValueOnce({
      reports: [dana],
      hasMore: false,
    });

    await mount();
    expect(host!.textContent).toContain("Dana");

    // Resolve Dana's report, but keep the PATCH pending.
    const resolveDeferred = deferred<{ report: AllReport }>();
    resolveReportMock.mockReturnValueOnce(resolveDeferred.promise);
    await act(async () => {
      buttonWithText("Mark actioned").click();
    });

    // Switch to the Actioned tab before the PATCH completes. Its own fetch
    // already shows Dana's report as actioned — the DB write landed first.
    const danaActioned = makeReport({
      id: "d",
      reportedUserName: "Dana",
      status: "actioned",
    });
    fetchAllReportsMock.mockResolvedValueOnce({
      reports: [danaActioned],
      hasMore: false,
    });
    await act(async () => {
      tab("Actioned").click();
      await Promise.resolve();
    });
    expect(host!.textContent).toContain("Dana");

    // Now the original PATCH finally completes.
    await act(async () => {
      resolveDeferred.resolve({ report: danaActioned });
      await Promise.resolve();
      await Promise.resolve();
    });

    // Dana must still be on screen — the completion handler must read which
    // tab is CURRENT, not the "open" tab the click happened on.
    expect(host!.textContent).toContain("Dana");
  });
});
