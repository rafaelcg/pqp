// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnConnection } from "@pqp/shared";
import { ApiError } from "@/lib/api";

const api = vi.hoisted(() => ({
  fetchConnectionConfig: vi.fn(),
  fetchMyConnections: vi.fn(),
  startConnection: vi.fn(),
  updateConnectionVisibility: vi.fn(),
  disconnectConnection: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, ...api };
});

const { ConnectionsSection } = await import("./connections-section");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const STEAM: OwnConnection = {
  provider: "steam",
  providerUserId: "76561198000000000",
  displayName: "andre_gg",
  avatarUrl: null,
  profileUrl: null,
  visibility: "shared",
  connectedAt: "2026-10-01T00:00:00.000Z",
} as OwnConnection;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllMocks();
});

async function render() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<ConnectionsSection />);
  });
  return host;
}

function never<T>() {
  return new Promise<T>(() => {});
}

describe("ConnectionsSection", () => {
  it("announces loading in a status and holds Em breve until the config is known", async () => {
    api.fetchConnectionConfig.mockReturnValue(never());
    api.fetchMyConnections.mockReturnValue(never());
    const el = await render();
    const status = el.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-busy")).toBe("true");
    expect(status?.textContent).toContain("Loading connections");
    expect(el.textContent).not.toContain("Coming soon");
  });

  it("shows the localized fallback, not the network line, when the load fails", async () => {
    api.fetchConnectionConfig.mockRejectedValue(
      new ApiError(0, "Network error reaching API."),
    );
    api.fetchMyConnections.mockResolvedValue({ connections: [] });
    const el = await render();
    expect(el.textContent).toContain("Could not load connections.");
    expect(el.textContent).not.toContain("Network error");
  });

  it("names each row's select and buttons by its provider", async () => {
    api.fetchConnectionConfig.mockResolvedValue({ steam: true, twitch: true });
    api.fetchMyConnections.mockResolvedValue({ connections: [STEAM] });
    const el = await render();
    const select = el.querySelector("select")!;
    const described = document.getElementById(select.getAttribute("aria-describedby")!);
    expect(described?.textContent).toBe("Steam");
    const twitch = el.querySelector('[data-settings-row="twitch"]')!;
    const connect = twitch.querySelector("button")!;
    expect(
      document.getElementById(connect.getAttribute("aria-describedby")!)?.textContent,
    ).toBe("Twitch");
  });

  it("keeps a busy Conectar focusable and ignores a second click", async () => {
    api.fetchConnectionConfig.mockResolvedValue({ twitch: true });
    api.fetchMyConnections.mockResolvedValue({ connections: [] });
    api.startConnection.mockReturnValue(never());
    const el = await render();
    const connect = el.querySelector<HTMLButtonElement>(
      '[data-settings-row="twitch"] button',
    )!;
    connect.focus();
    await act(async () => connect.click());
    expect(connect.disabled).toBe(false);
    expect(connect.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(connect);
    await act(async () => connect.click());
    expect(api.startConnection).toHaveBeenCalledTimes(1);
  });

  it("shows the picked option while the save runs and the fallback when it fails offline", async () => {
    api.fetchConnectionConfig.mockResolvedValue({ steam: true });
    api.fetchMyConnections.mockResolvedValue({ connections: [STEAM] });
    let fail!: (error: unknown) => void;
    api.updateConnectionVisibility.mockReturnValue(
      new Promise((_, reject) => {
        fail = reject;
      }),
    );
    const el = await render();
    const select = el.querySelector("select")!;
    await act(async () => {
      select.value = "public";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(select.value).toBe("public");
    expect(select.disabled).toBe(false);
    await act(async () => fail(new ApiError(0, "Network error reaching API.")));
    expect(select.value).toBe("shared");
    expect(el.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not save that setting.",
    );
  });

  it("sets the linked name in mono", async () => {
    api.fetchConnectionConfig.mockResolvedValue({ steam: true });
    api.fetchMyConnections.mockResolvedValue({ connections: [STEAM] });
    const el = await render();
    const name = [...el.querySelectorAll("span.font-mono")].find(
      (node) => node.textContent === "andre_gg",
    );
    expect(name?.parentElement?.textContent).toBe("Connected as andre_gg");
  });
});
