// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@pqp/shared";
import {
  DeleteAccountDialog,
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
    ).toBe("Delete your account");
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

  it("shows the localized line when the network drops", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    mount(<YourDataSection user={USER} onRequestDelete={() => {}} />);
    await act(async () => exportButton().click());
    await settle();
    expect(exportRowText()).toContain(EXPORT_FAILED);
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

  it("shows a server refusal with a sentence as is", async () => {
    respond(400, JSON.stringify({ error: "Type your own tag to confirm" }));
    mountDialog();
    await act(async () => confirmButton().click());
    await settle();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      "Type your own tag to confirm",
    );
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
});
