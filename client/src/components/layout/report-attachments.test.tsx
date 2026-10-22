// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AllReport, Report, ReportAttachment } from "@pqp/shared";

/**
 * The card's attachment block. What is pinned:
 *
 *   * the metadata (kind, content type, scanner verdict) is drawn whatever the
 *     preview state, because it is the part that is useful with the flag off;
 *   * a picture the server calls `available` is a PLACEHOLDER: no `<img>`, so no
 *     request for the bytes, and no call to the reveal route, until a click;
 *   * a blocked file never offers the button and says why, pointing at the
 *     runbook; a video or a file says there is no preview;
 *   * a refusal on the click is shown as a refusal, and the picture goes back
 *     to the placeholder on Hide, on a hidden tab and on unmount.
 */

const { revealMock, fetchAllReportsMock, fetchServerReportsMock } = vi.hoisted(
  () => ({
    revealMock: vi.fn(),
    fetchAllReportsMock: vi.fn(),
    fetchServerReportsMock: vi.fn(),
  }),
);

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    revealReportAttachment: (...args: unknown[]) => revealMock(...args),
    fetchAllReports: (...args: unknown[]) => fetchAllReportsMock(...args),
    fetchServerReports: (...args: unknown[]) => fetchServerReportsMock(...args),
  };
});

const { ReportAttachments } = await import("./report-attachments");
const { AllReportsSection } = await import("./all-reports-section");
const { ReportsSection } = await import("./reports-section");
const { ApiError } = await import("@/lib/api");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const ID = "6b1f3a52-5c0e-4a53-9d0b-3e0f6a1d9a11";

function attachment(overrides: Partial<ReportAttachment> = {}): ReportAttachment {
  return {
    id: ID,
    kind: "gif",
    contentType: "image/gif",
    scan: { status: "pass", provider: "openai", score: 0.02, labels: [] },
    preview: "available",
    blockReason: null,
    ...overrides,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(element: React.ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(element);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  revealMock.mockReset();
  fetchAllReportsMock.mockReset();
  fetchServerReportsMock.mockReset();
  vi.useRealTimers();
});

function button(label: string): HTMLButtonElement | null {
  return (
    (Array.from(document.querySelectorAll("button")).find(
      (node) => node.textContent === label,
    ) as HTMLButtonElement | undefined) ?? null
  );
}

async function click(label: string) {
  const el = button(label);
  if (!el) {
    throw new Error(`No button labelled "${label}"`);
  }
  await act(async () => {
    el.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ReportAttachments", () => {
  it("renders nothing for a message with no files", async () => {
    await mount(<ReportAttachments reportId="42" attachments={[]} />);
    expect(host!.textContent).toBe("");
  });

  it("draws the kind, the content type and the scanner verdict in words", async () => {
    await mount(
      <ReportAttachments
        reportId="42"
        attachments={[
          attachment({
            preview: "off",
            scan: {
              status: "pass",
              provider: "sightengine",
              score: 0.12,
              labels: ["gore", "nudity"],
            },
          }),
        ]}
      />,
    );
    const text = host!.textContent!;
    expect(text).toContain("GIF");
    expect(text).toContain("image/gif");
    expect(text).toContain("passed");
    expect(text).toContain("by sightengine");
    expect(text).toContain("score 0.12");
    expect(text).toContain("labels: gore, nudity");
  });

  it("says what an unscanned and an errored file are, never a bare status code", async () => {
    await mount(
      <ReportAttachments
        reportId="42"
        attachments={[
          attachment({
            id: "a",
            preview: "off",
            scan: { status: "unscanned", provider: null, score: null, labels: [] },
          }),
          attachment({
            id: "b",
            preview: "blocked",
            blockReason: "scan_status",
            scan: { status: "error", provider: "openai", score: null, labels: [] },
          }),
        ]}
      />,
    );
    const text = host!.textContent!;
    expect(text).toContain("not scanned");
    expect(text).toContain("the scanner could not answer");
  });

  it("with the preview off, draws the list and no button, no placeholder, no image", async () => {
    await mount(
      <ReportAttachments reportId="42" attachments={[attachment({ preview: "off" })]} />,
    );
    expect(button("Show")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector('[data-testid="report-attachment-placeholder"]')).toBeNull();
  });

  it("is a placeholder until the click: no image element and no reveal call", async () => {
    await mount(<ReportAttachments reportId="42" attachments={[attachment()]} />);
    expect(
      document.querySelector('[data-testid="report-attachment-placeholder"]'),
    ).not.toBeNull();
    expect(host!.textContent).toContain("may show sensitive content");
    expect(document.querySelector("img")).toBeNull();
    expect(revealMock).not.toHaveBeenCalled();
    expect(button("Show")).not.toBeNull();
  });

  it("asks for the URL on the click, shows the image, and hides it again", async () => {
    revealMock.mockResolvedValueOnce({
      url: "https://storage.test/obj?sig=abc",
      expiresInSeconds: 60,
    });
    await mount(<ReportAttachments reportId="42" attachments={[attachment()]} />);
    await click("Show");
    expect(revealMock).toHaveBeenCalledWith("42", ID);
    const img = document.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://storage.test/obj?sig=abc");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");

    await click("Hide");
    expect(document.querySelector("img")).toBeNull();
    expect(
      document.querySelector('[data-testid="report-attachment-placeholder"]'),
    ).not.toBeNull();
  });

  it("puts the picture away by itself when its minute is nearly up", async () => {
    vi.useFakeTimers();
    revealMock.mockResolvedValueOnce({
      url: "https://storage.test/obj?sig=abc",
      expiresInSeconds: 60,
    });
    await mount(<ReportAttachments reportId="42" attachments={[attachment()]} />);
    await click("Show");
    expect(document.querySelector("img")).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(56_000);
    });
    expect(document.querySelector("img")).toBeNull();
  });

  it("puts the picture away when the tab is hidden", async () => {
    revealMock.mockResolvedValueOnce({
      url: "https://storage.test/obj?sig=abc",
      expiresInSeconds: 60,
    });
    await mount(<ReportAttachments reportId="42" attachments={[attachment()]} />);
    await click("Show");
    expect(document.querySelector("img")).not.toBeNull();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(document.querySelector("img")).toBeNull();
    visibility.mockRestore();
  });

  it("shows a refusal on the click as a refusal, with no picture", async () => {
    revealMock.mockRejectedValueOnce(new ApiError(403, "Preview refused: nope"));
    await mount(<ReportAttachments reportId="42" attachments={[attachment()]} />);
    await click("Show");
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "refused the preview",
    );
    expect(button("Show")).not.toBeNull();
  });

  it("never offers the button for a blocked file, and points at the runbook", async () => {
    await mount(
      <ReportAttachments
        reportId="42"
        attachments={[
          attachment({
            preview: "blocked",
            blockReason: "illegal_label",
            scan: { status: "flagged", provider: "x", score: 0.97, labels: ["illegal"] },
          }),
        ]}
      />,
    );
    expect(button("Show")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(host!.textContent).toContain("possibly illegal");
    expect(host!.textContent).toContain("runbook");
    expect(revealMock).not.toHaveBeenCalled();
  });

  it("says there is no preview for a video or a file", async () => {
    await mount(
      <ReportAttachments
        reportId="42"
        attachments={[
          attachment({
            kind: "video",
            contentType: "video/mp4",
            preview: "unsupported",
          }),
        ]}
      />,
    );
    expect(host!.textContent).toContain("Video");
    expect(host!.textContent).toContain("No preview for videos");
    expect(button("Show")).toBeNull();
  });
});

function baseReport(): Report {
  return {
    id: "42",
    subjectType: "message",
    contextKind: "server",
    reason: "spam",
    details: null,
    status: "open",
    createdAt: "2026-10-22T12:00:00.000Z",
    reporterId: "r1",
    reporterName: "Reporter",
    reportedUserId: "u1",
    reportedUserName: "Poster",
    messageId: ID,
    messageDeleted: false,
    contentSnapshot: "",
    attachments: [attachment({ preview: "off" })],
    channelId: null,
    channelName: "general",
    storyId: null,
    resolvedAt: null,
    resolvedByName: null,
    resolutionNote: null,
  };
}

describe("on the report cards", () => {
  it("the instance lens lists an image-only report's file instead of an empty bar", async () => {
    const report: AllReport = {
      ...baseReport(),
      serverId: null,
      serverName: null,
      scan: null,
    };
    fetchAllReportsMock.mockResolvedValueOnce({ reports: [report], hasMore: false });
    await mount(<AllReportsSection />);
    expect(host!.textContent).toContain("image/gif");
    expect(host!.textContent).toContain("passed");
  });

  it("a server's own queue lists it too", async () => {
    fetchServerReportsMock.mockResolvedValueOnce({
      reports: [baseReport()],
      hasMore: false,
    });
    await mount(<ReportsSection serverId="s1" />);
    expect(host!.textContent).toContain("image/gif");
    expect(host!.textContent).toContain("passed");
  });
});
