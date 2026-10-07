// @vitest-environment jsdom
import { act } from "react";
import { SettingsAnnouncer } from "@/components/settings/kit";
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
    // Busy, not disabled: a disabled button drops keyboard focus on the page.
    expect(exportButton().getAttribute("aria-disabled")).toBe("true");
    expect(exportButton().disabled).toBe(false);

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

  it("says Done through the dialog's announcer inside Settings", async () => {
    stubDownload();
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    mount(
      <SettingsAnnouncer>
        <YourDataSection user={USER} onRequestDelete={() => {}} />
      </SettingsAnnouncer>,
    );
    await act(async () => exportButton().click());
    await tick(0);
    await tick(0);
    expect(host!.querySelector("[data-settings-announcer]")?.textContent).toBe(
      "Done. The file pqp-my-data-2026-10-04.json was downloaded.",
    );
    expect(
      host!.querySelector('[data-settings-row="export"] [role="status"]'),
    ).toBeNull();
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
    expect(exportButton().getAttribute("aria-disabled")).toBe("true");
    expect(exportButton().disabled).toBe(false);
    expect(exportButton().textContent).toBe("Download in 54 s");
    expect(exportButton().getAttribute("aria-label")).toBe(
      "Download everything we hold about you, available in 54 s",
    );
    const alert = host!.querySelector('[data-settings-row="export"] [role="alert"]');
    expect(alert?.textContent).toBe("Too many downloads in a row. Try again in 54 s.");

    await tick(10_000);
    expect(exportButton().textContent).toBe("Download in 44 s");
    // The name stays put while the label counts down.
    expect(exportButton().getAttribute("aria-label")).toBe(
      "Download everything we hold about you, available in 54 s",
    );
    expect(alert?.isConnected).toBe(true);
    // The alert is said once: the countdown a screen reader would hear every
    // second is hidden from it.
    expect(alert?.textContent).toBe("Too many downloads in a row. Try again in 54 s.");
    expect(alert?.parentElement?.textContent).toContain("Try again in 44 s.");

    await tick(44_000);
    expect(exportButton().getAttribute("aria-disabled")).toBeNull();
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

  it("cannot be dismissed while the delete is in flight", async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const onCancel = vi.fn();
    mount(
      <DeleteAccountDialog open user={USER} onCancel={onCancel} onDeleted={() => {}} />,
    );
    typeTag();
    await act(async () => confirmButton().click());
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onCancel).not.toHaveBeenCalled();
    // Manter conta stays focusable while busy, but pressing it does nothing:
    // the delete already went out and cannot be called back.
    const keep = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Keep account",
    )!;
    expect(keep.getAttribute("aria-disabled")).toBe("true");
    act(() => keep.click());
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("shows the localized line for the breaker's 503, never its code", async () => {
    respond(503, JSON.stringify({ error: "database_unavailable" }));
    mountDialog();
    await act(async () => confirmButton().click());
    await settle();
    const alert = document.body.querySelector('[aria-live="assertive"]');
    expect(alert?.textContent).toBe(DELETE_FAILED);
    expect(document.body.textContent).not.toContain("database_unavailable");
  });

  it("shows the localized line for a 502 whose body is not JSON", async () => {
    respond(502, "<html>Bad gateway</html>", "text/html");
    mountDialog();
    await act(async () => confirmButton().click());
    await settle();
    expect(document.body.querySelector('[aria-live="assertive"]')?.textContent).toBe(
      DELETE_FAILED,
    );
    expect(document.body.textContent).not.toContain("Could not delete account");
  });

  it("shows the localized line when the network drops", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    mountDialog();
    await act(async () => confirmButton().click());
    await settle();
    expect(document.body.querySelector('[aria-live="assertive"]')?.textContent).toBe(
      DELETE_FAILED,
    );
  });

  it("shows the localized line for a 429 whose body is not JSON", async () => {
    respond(429, "Too Many Requests", "text/plain");
    mountDialog();
    await act(async () => confirmButton().click());
    await settle();
    expect(document.body.querySelector('[aria-live="assertive"]')?.textContent).toBe(
      DELETE_FAILED,
    );
  });

  it("says a server refusal in the reader's language, never the server's English", async () => {
    respond(400, JSON.stringify({ error: "Type your own tag to confirm" }));
    mountDialog();
    await act(async () => confirmButton().click());
    await settle();
    const alert = document.body.querySelector('[aria-live="assertive"]')?.textContent ?? "";
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
    // Said through the dialog's own live region; the list is on screen.
    expect(
      document.body.querySelector('[aria-live="assertive"]')?.textContent,
    ).toMatch(/communities|comunidades/i);
    const footer = document.body.querySelector("input")!.closest(".border-t")!;
    expect(footer.textContent).toContain("Sandbox");
    expect(footer.textContent).toContain("· 15 other members");
    expect(footer.textContent).toContain("· 1 other member");
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
    const alert = document.body.querySelector('[aria-live="assertive"]')!;
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

describe("focus stays put while a request runs", () => {
  function typeInto(value: string) {
    const input = document.body.querySelector("input")!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  const buttonWithText = (text: string) =>
    [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === text,
    )!;

  it("keeps Baixar focusable while the copy is built, and refuses a second click", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (finish = resolve)));
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() });
    mount(<YourDataSection user={USER} onRequestDelete={() => {}} />);
    exportButton().focus();
    await act(async () => exportButton().click());
    expect(exportButton().disabled).toBe(false);
    expect(exportButton().getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(exportButton());
    await act(async () => exportButton().click());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => finish(new Response("{}", { status: 200 })));
    await settle();
    expect(document.activeElement).toBe(exportButton());
    expect(exportButton().getAttribute("aria-disabled")).toBeNull();
  });

  it("keeps Baixar focusable after a failure", async () => {
    respond(500, JSON.stringify({ error: "boom" }));
    mount(<YourDataSection user={USER} onRequestDelete={() => {}} />);
    exportButton().focus();
    await act(async () => exportButton().click());
    await settle();
    expect(exportRowText()).toContain(EXPORT_FAILED);
    expect(document.activeElement).toBe(exportButton());
  });

  it("keeps the dialog's Baixar seus dados focusable while it runs", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (finish = resolve)));
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() });
    mount(
      <DeleteAccountDialog open user={USER} onCancel={() => {}} onDeleted={() => {}} />,
    );
    const save = buttonWithText("Download your data");
    save.focus();
    await act(async () => save.click());
    expect(save.disabled).toBe(false);
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(save);
    await act(async () => save.click());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => finish(new Response("{}", { status: 200 })));
    await settle();
    expect(document.activeElement).toBe(save);
  });

  it("keeps Apagar conta focusable while it runs and after a failure", async () => {
    let fail!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (fail = resolve)));
    mount(
      <DeleteAccountDialog open user={USER} onCancel={() => {}} onDeleted={() => {}} />,
    );
    typeInto("rafa#0001");
    const confirm = buttonWithText("Delete account");
    confirm.focus();
    await act(async () => confirm.click());
    expect(confirm.disabled).toBe(false);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(buttonWithText("Keep account").getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(confirm);
    // A second click while it runs does not send a second delete.
    await act(async () => confirm.click());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () =>
      fail(new Response(JSON.stringify({ error: "boom" }), { status: 500 })),
    );
    await settle();
    expect(document.body.querySelector('[aria-live="assertive"]')?.textContent).toBe(DELETE_FAILED);
    expect(document.activeElement).toBe(confirm);
    expect(confirm.getAttribute("aria-disabled")).toBeNull();
  });

  it("keeps Apagar conta focusable after the owned-servers refusal", async () => {
    respond(
      409,
      JSON.stringify({
        error: "Servers you own are in the way",
        code: "owned_servers",
        servers: [{ id: "s1", name: "Sandbox", otherMemberCount: 15 }],
      }),
    );
    mount(
      <DeleteAccountDialog open user={USER} onCancel={() => {}} onDeleted={() => {}} />,
    );
    typeInto("rafa#0001");
    const confirm = buttonWithText("Delete account");
    confirm.focus();
    await act(async () => confirm.click());
    await settle();
    expect(document.body.textContent).toContain("Sandbox");
    expect(document.activeElement).toBe(confirm);
  });
});

describe("the typed confirmation", () => {
  function typeInto(value: string) {
    const input = document.body.querySelector("input")!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  const confirm = () =>
    [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Delete account",
    )!;

  it("accepts a leading @, and sends the server the form it accepts", async () => {
    respond(200, "{}");
    const onDeleted = vi.fn();
    mount(
      <DeleteAccountDialog open user={USER} onCancel={() => {}} onDeleted={onDeleted} />,
    );
    typeInto("@rafa#0001");
    expect(confirm().disabled).toBe(false);
    await act(async () => confirm().click());
    await settle();
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toEqual({
      confirm: "rafa#0001",
    });
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it("still refuses a near miss", () => {
    mount(
      <DeleteAccountDialog open user={USER} onCancel={() => {}} onDeleted={() => {}} />,
    );
    typeInto("@rafa#0002");
    expect(confirm().disabled).toBe(true);
    typeInto("@@rafa#0001");
    expect(confirm().disabled).toBe(true);
  });
});
