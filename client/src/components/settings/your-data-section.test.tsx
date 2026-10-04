// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@pqp/shared";
import {
  DeleteAccountDialog,
  EXPORT_DONE_MS,
  exportFileName,
  formatWait,
  YourDataSection,
} from "@/components/settings/your-data-section";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * What Seus dados says when the server fails. The requests go through the real
 * `exportMyData` and `deleteMyAccount`, with `fetch` stubbed, so the error is
 * the `ApiError` production builds and not one written for the test. A 5xx
 * must never reach the screen as a code ("database_unavailable") or as the
 * English default `api.ts` puts on a body that is not JSON.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const USER = {
  id: "00000000-0000-0000-0000-000000000001",
  clerkId: "clerk_1",
  displayName: "Rafa",
  username: "rafa",
  discriminator: "0001",
  tag: "rafa#0001",
} as unknown as User;

const EXPORT_FAILED = "Could not build your copy. Try again.";
const DELETE_FAILED = "Could not delete your account. Try again.";

let root: Root | null = null;
let host: HTMLElement | null = null;
let fetchMock: ReturnType<typeof vi.fn>;

function respond(status: number, body: string, contentType = "application/json") {
  fetchMock.mockResolvedValue(
    new Response(body, { status, headers: { "Content-Type": contentType } }),
  );
}

function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<TooltipProvider>{node}</TooltipProvider>));
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function exportButton(): HTMLButtonElement {
  return host!.querySelector('[data-settings-row="export"] button')!;
}

function exportRowText(): string {
  return host!.querySelector('[data-settings-row="export"]')!.textContent ?? "";
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("YourDataSection export", () => {
  it("says Preparando while the copy is built, and no Salvo after", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (finish = resolve)));
    const createObjectURL = vi.fn(() => "blob:x");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    mount(<YourDataSection user={USER} onRequestDelete={() => {}} />);

    await act(async () => exportButton().click());
    expect(exportRowText()).toContain("Preparing…");
    expect(exportButton().disabled).toBe(true);

    await act(async () => finish(new Response("{}", { status: 200 })));
    await settle();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(exportRowText()).not.toContain("Preparing…");
    expect(exportRowText()).not.toContain("Saved");
    expect(exportButton().disabled).toBe(false);
  });

  it("names the object as well as the verb on each button", () => {
    mount(<YourDataSection user={USER} onRequestDelete={() => {}} />);
    expect(exportButton().getAttribute("aria-label")).toBe(
      "Download everything we hold about you",
    );
    expect(
      host!
        .querySelector('[data-settings-row="delete-account"] button')!
        .getAttribute("aria-label"),
    ).toBe("Delete account permanently");
  });

  it("shows the localized line for the breaker's 503, never its code", async () => {
    respond(503, JSON.stringify({ error: "database_unavailable" }));
    mount(<YourDataSection user={USER} onRequestDelete={() => {}} />);
    await act(async () => exportButton().click());
    await settle();
    const alert = host!.querySelector('[data-settings-row="export"] [role="alert"]');
    expect(alert?.textContent).toBe(EXPORT_FAILED);
    expect(exportRowText()).not.toContain("database_unavailable");
  });

  it("shows the localized line for a 502 whose body is not JSON", async () => {
    respond(502, "<html><body>Bad gateway</body></html>", "text/html");
    mount(<YourDataSection user={USER} onRequestDelete={() => {}} />);
    await act(async () => exportButton().click());
    await settle();
    expect(exportRowText()).toContain(EXPORT_FAILED);
    expect(exportRowText()).not.toContain("Export failed");
  });

  it("shows the localized line for a 429 whose body is not JSON", async () => {
    respond(429, "Too Many Requests", "text/plain");
    mount(<YourDataSection user={USER} onRequestDelete={() => {}} />);
    await act(async () => exportButton().click());
    await settle();
    expect(exportRowText()).toContain(EXPORT_FAILED);
    expect(exportRowText()).not.toContain("Export failed");
  });

  it("shows the localized line when the network drops", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    mount(<YourDataSection user={USER} onRequestDelete={() => {}} />);
    await act(async () => exportButton().click());
    await settle();
    expect(exportRowText()).toContain(EXPORT_FAILED);
  });
});

/** The download tests run on fake timers: the wait counts seconds. */
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function stubDownload() {
  const createObjectURL = vi.fn(() => "blob:x");
  const revokeObjectURL = vi.fn();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  return { createObjectURL };
}

describe("exportFileName and formatWait", () => {
  it("dates the file by the local calendar day, not UTC", () => {
    // 23:30 local on 4 October: UTC is already the 5th in Brazil (UTC-3).
    expect(exportFileName(new Date(2026, 9, 4, 23, 30))).toBe(
      "pqp-my-data-2026-10-04.json",
    );
    expect(exportFileName(new Date(2026, 0, 9, 0, 5))).toBe(
      "pqp-my-data-2026-01-09.json",
    );
  });

  it("says seconds under a minute and rounds minutes up", () => {
    expect(formatWait(54)).toBe("54 s");
    expect(formatWait(59)).toBe("59 s");
    expect(formatWait(60)).toBe("1 min");
    expect(formatWait(61)).toBe("2 min");
  });
});

describe("YourDataSection export feedback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 4, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the format in the row text", () => {
    mount(<YourDataSection user={USER} onRequestDelete={() => {}} />);
    expect(exportRowText()).toContain("A JSON file with your profile");
  });

  it("says which file was downloaded, then goes quiet", async () => {
    stubDownload();
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    mount(<YourDataSection user={USER} onRequestDelete={() => {}} />);
    await act(async () => exportButton().click());
    await tick(0);
    expect(exportRowText()).toContain(
      "Done. The file pqp-my-data-2026-10-04.json was downloaded.",
    );
    expect(exportButton().disabled).toBe(false);

    await tick(EXPORT_DONE_MS + 10);
    expect(exportRowText()).not.toContain("Done.");
  });

  it("drops the done line when a new download starts", async () => {
    stubDownload();
    let finish!: (response: Response) => void;
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockReturnValueOnce(new Promise<Response>((resolve) => (finish = resolve)));
    mount(<YourDataSection user={USER} onRequestDelete={() => {}} />);
    await act(async () => exportButton().click());
    await tick(0);
    expect(exportRowText()).toContain("Done.");
    await act(async () => exportButton().click());
    expect(exportRowText()).not.toContain("Done.");
    expect(exportRowText()).toContain("Preparing…");
    await act(async () => finish(new Response("{}", { status: 200 })));
    await tick(0);
  });

  it("turns a 429 into a counting button and a line, and gives the button back", async () => {
    stubDownload();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Too many exports" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "54" },
      }),
    );
    mount(<YourDataSection user={USER} onRequestDelete={() => {}} />);
    await act(async () => exportButton().click());
    await tick(0);
    expect(exportButton().disabled).toBe(true);
    expect(exportButton().textContent).toBe("Download in 54 s");
    expect(exportButton().getAttribute("aria-label")).toBe(
      "Download everything we hold about you, available in 54 s",
    );
    const alert = host!.querySelector('[data-settings-row="export"] [role="alert"]');
    expect(alert?.textContent).toBe("Too many downloads in a row. Try again in 54 s.");

    await tick(10_000);
    expect(exportButton().textContent).toBe("Download in 44 s");
    expect(alert?.isConnected).toBe(true);

    await tick(44_000);
    expect(exportButton().disabled).toBe(false);
    expect(exportButton().textContent).toBe("Download");
    expect(
      host!.querySelector('[data-settings-row="export"] [role="alert"]'),
    ).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the generic line for a 429 that says nothing about how long", async () => {
    respond(429, JSON.stringify({ error: "Too many exports" }));
    mount(<YourDataSection user={USER} onRequestDelete={() => {}} />);
    await act(async () => exportButton().click());
    await tick(0);
    expect(exportRowText()).toContain("Too many tries in a row");
    expect(exportButton().disabled).toBe(false);
  });
});

describe("YourDataSection layout", () => {
  it("keeps each row's control at the top and gives touch screens 44px buttons", () => {
    mount(<YourDataSection user={USER} onRequestDelete={() => {}} />);
    expect(host!.firstElementChild!.className).toContain(
      "@lg:[&_[data-settings-row]]:items-start",
    );
    const delButton = host!.querySelector<HTMLButtonElement>(
      '[data-settings-row="delete-account"] button',
    )!;
    for (const button of [exportButton(), delButton]) {
      expect(button.className).toContain("max-sm:h-11");
      expect(button.className).toContain("pointer-coarse:h-11");
    }
  });

  it("says what the delete button does: Delete account…", () => {
    mount(<YourDataSection user={USER} onRequestDelete={() => {}} />);
    const del = host!.querySelector(
      '[data-settings-row="delete-account"] button',
    )!;
    expect(del.textContent).toBe("Delete account…");
    // The accessible name contains the visible label.
    expect(del.getAttribute("aria-label")!.toLowerCase()).toContain("delete account");
  });
});

describe("DeleteAccountDialog", () => {
  function typeTag() {
    const input = document.body.querySelector("input")!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setter.call(input, "rafa#0001");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function confirmButton(): HTMLButtonElement {
    const buttons = [...document.body.querySelectorAll("button")];
    return buttons.find((button) => button.textContent === "Delete account")!;
  }

  function mountDialog() {
    mount(
      <DeleteAccountDialog open user={USER} onCancel={() => {}} onDeleted={() => {}} />,
    );
    typeTag();
  }

  it("shows the localized line for the breaker's 503, never its code", async () => {
    respond(503, JSON.stringify({ error: "database_unavailable" }));
    mountDialog();
    await act(async () => confirmButton().click());
    await settle();
    const alert = document.body.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(DELETE_FAILED);
    expect(document.body.textContent).not.toContain("database_unavailable");
  });

  it("shows the localized line for a 502 whose body is not JSON", async () => {
    respond(502, "<html>Bad gateway</html>", "text/html");
    mountDialog();
    await act(async () => confirmButton().click());
    await settle();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      DELETE_FAILED,
    );
    expect(document.body.textContent).not.toContain("Could not delete account");
  });

  it("shows the localized line when the network drops", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    mountDialog();
    await act(async () => confirmButton().click());
    await settle();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      DELETE_FAILED,
    );
  });

  it("shows the localized line for a 429 whose body is not JSON", async () => {
    respond(429, "Too Many Requests", "text/plain");
    mountDialog();
    await act(async () => confirmButton().click());
    await settle();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      DELETE_FAILED,
    );
  });

  it("says a server refusal in the reader's language, never the server's English", async () => {
    respond(400, JSON.stringify({ error: "Type your own tag to confirm" }));
    mountDialog();
    await act(async () => confirmButton().click());
    await settle();
    const alert = document.body.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alert).not.toContain("Type your own tag");
    expect(alert.length).toBeGreaterThan(0);
  });

  it("names the owned communities in an alert", async () => {
    respond(
      409,
      JSON.stringify({
        error: "Servers you own are in the way",
        code: "owned_servers",
        servers: [
          { id: "s1", name: "Sandbox", otherMemberCount: 15 },
          { id: "s2", name: "Clã", otherMemberCount: 1 },
        ],
      }),
    );
    mountDialog();
    await act(async () => confirmButton().click());
    await settle();
    const alert = document.body.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Sandbox");
    expect(alert?.textContent).toContain("· 15 other members");
    expect(alert?.textContent).toContain("· 1 other member");
  });

  it("pins the typed confirmation above the buttons, outside the scrolling text", () => {
    mountDialog();
    const input = document.body.querySelector("input")!;
    const panel = document.body.querySelector('[role="dialog"]')!;
    const footer = input.closest(".border-t")!;
    expect(footer).not.toBeNull();
    expect(panel.contains(footer)).toBe(true);
    expect(footer.textContent).toContain("To confirm, type");
    expect(footer.textContent).toContain("rafa#0001");
    expect(footer.textContent).toContain("Delete account");
    // The long text is not where the input lives.
    expect(
      [...panel.querySelectorAll("li")].some((li) => footer.contains(li)),
    ).toBe(false);
  });

  it("puts the failure in the pinned block too", async () => {
    respond(503, JSON.stringify({ error: "database_unavailable" }));
    mountDialog();
    await act(async () => confirmButton().click());
    await settle();
    const alert = document.body.querySelector('[role="alert"]')!;
    expect(alert.closest(".border-t")).not.toBeNull();
  });

  it("names the missing number when only the name part is typed", () => {
    mount(
      <DeleteAccountDialog open user={USER} onCancel={() => {}} onDeleted={() => {}} />,
    );
    const input = document.body.querySelector("input")!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    const type = (value: string) =>
      act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const hint = () => document.body.textContent ?? "";

    type("rafa");
    expect(hint()).toContain("Missing #0001");
    expect(input.getAttribute("aria-describedby")).toBeTruthy();
    type("  @RAFA ");
    expect(hint()).toContain("Missing #0001");
    type("raf");
    expect(hint()).not.toContain("Missing #0001");
    type("rafa#0001");
    expect(hint()).not.toContain("Missing #0001");
    expect(confirmButton().disabled).toBe(false);
  });

  it("offers a copy first, without closing the dialog", async () => {
    stubDownload();
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    const onCancel = vi.fn();
    mount(
      <DeleteAccountDialog open user={USER} onCancel={onCancel} onDeleted={() => {}} />,
    );
    expect(document.body.textContent).toContain("Want to keep a copy first?");
    const save = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Download your data",
    )!;
    await act(async () => save.click());
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/me/export");
    expect(onCancel).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("was downloaded.");
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("links the privacy policy in a new tab", () => {
    mountDialog();
    const link = document.body.querySelector<HTMLAnchorElement>('a[href="/privacy"]')!;
    expect(link.textContent).toBe("The privacy policy lists the periods");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
  });

  it("returns focus to the delete button after Keep account", () => {
    const onCancel = vi.fn();
    mount(
      <DeleteAccountDialog open user={USER} onCancel={onCancel} onDeleted={() => {}} />,
    );
    const keep = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Keep account",
    )!;
    act(() => keep.click());
    expect(onCancel).toHaveBeenCalledTimes(1);

    // Settings comes back: a new mount of the tab.
    act(() => root!.unmount());
    host!.remove();
    mount(<YourDataSection user={USER} onRequestDelete={() => {}} />);
    expect(document.activeElement).toBe(
      host!.querySelector('[data-settings-row="delete-account"] button'),
    );
  });

  it("does not steal focus when the tab opens normally", () => {
    mount(<YourDataSection user={USER} onRequestDelete={() => {}} />);
    expect(document.activeElement).toBe(document.body);
  });
});
