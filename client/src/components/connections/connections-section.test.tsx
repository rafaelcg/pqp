// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnConnection } from "@pqp/shared";
import { ApiError } from "@/lib/api";

const api = vi.hoisted(() => ({
  fetchConnectionConfig: vi.fn(),
  fetchMe: vi.fn(),
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

beforeEach(() => {
  api.fetchMe.mockResolvedValue({ handle: "andre" });
  sessionStorage.clear();
});

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

  it("hands focus back to the row after the confirm closes and after a disconnect", async () => {
    api.fetchConnectionConfig.mockResolvedValue({ steam: true });
    api.fetchMyConnections.mockResolvedValue({ connections: [STEAM] });
    let finish!: () => void;
    api.disconnectConnection.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const el = await render();
    const row = () => el.querySelector('[data-settings-row="steam"]')!;
    const disconnect = [...row().querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Disconnect"),
    )!;
    await act(async () => disconnect.click());
    const cancel = [...document.querySelectorAll('[role="dialog"] button')].find(
      (b) => b.textContent === "Keep connection",
    ) as HTMLButtonElement;
    await act(async () => {
      cancel.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(disconnect);

    await act(async () => disconnect.click());
    const confirm = [...document.querySelectorAll('[role="dialog"] button')].find(
      (b) => b.textContent === "Disconnect",
    ) as HTMLButtonElement;
    await act(async () => {
      confirm.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(disconnect);
    expect(disconnect.getAttribute("aria-disabled")).toBe("true");
    await act(async () => finish());
    const connect = row().querySelector("button")!;
    expect(connect.textContent).toBe("Connect");
    expect(document.activeElement).toBe(connect);
  });
  it("shows the visibility question at every width, not only on a phone", async () => {
    api.fetchConnectionConfig.mockResolvedValue({ steam: true });
    api.fetchMyConnections.mockResolvedValue({ connections: [STEAM] });
    const el = await render();
    const select = el.querySelector("select")!;
    const label = el.querySelector(`label[for="${select.id}"]`)!;
    expect(label.textContent).toBe("Who can see this");
    expect(label.className).not.toContain("sr-only");
  });

  it("explains how to get a public page when the account has no @", async () => {
    api.fetchMe.mockResolvedValue({ handle: null });
    api.fetchConnectionConfig.mockResolvedValue({ steam: true });
    api.fetchMyConnections.mockResolvedValue({ connections: [STEAM] });
    const el = await render();
    const select = el.querySelector("select")!;
    const hint = [...el.querySelectorAll("p")].find((p) =>
      p.textContent?.includes("pick an @ in Profile"),
    )!;
    expect(hint.textContent).toContain("Also on my public page");
    expect(select.getAttribute("aria-describedby")).toContain(hint.id);
  });

  it("leaves the hint out when the account has an @ or the answer is not in", async () => {
    api.fetchConnectionConfig.mockResolvedValue({ steam: true });
    api.fetchMyConnections.mockResolvedValue({ connections: [STEAM] });
    let el = await render();
    expect(el.textContent).not.toContain("pick an @");
    act(() => root?.unmount());
    host?.remove();
    api.fetchMe.mockReturnValue(never());
    el = await render();
    expect(el.textContent).not.toContain("pick an @");
  });

  it("names the button Disconnect, bordered, with no ellipsis", async () => {
    api.fetchConnectionConfig.mockResolvedValue({ steam: true });
    api.fetchMyConnections.mockResolvedValue({ connections: [STEAM] });
    const el = await render();
    const button = el.querySelector<HTMLButtonElement>(
      '[data-settings-row="steam"] button',
    )!;
    expect(button.textContent).toBe("Disconnect");
    expect(button.className).toContain("border-border-strong");
    expect(button.className).toContain("text-danger");
    expect(button.className).toContain("pointer-coarse:h-11");
  });

  it("keeps a long name on one line and shows it whole in the tooltip", async () => {
    const long = "UmNomeDeUsuarioAbsurdamenteLongoQueNaoCabeNaLinha_DoBattleNet_2026#12345";
    api.fetchConnectionConfig.mockResolvedValue({ steam: true });
    api.fetchMyConnections.mockResolvedValue({
      connections: [{ ...STEAM, displayName: long }],
    });
    const el = await render();
    const line = [...el.querySelectorAll("span")].find(
      (node) => node.title === long,
    )!;
    expect(line.className).toContain("truncate");
    expect(line.textContent).toBe(`Connected as ${long}`);
  });

  it("holds two skeleton rows and no Em breve group while loading", async () => {
    api.fetchConnectionConfig.mockReturnValue(never());
    api.fetchMyConnections.mockReturnValue(never());
    const el = await render();
    expect(el.querySelector('[role="status"]')?.children.length).toBe(3);
  });

  it("says plainly that game connections are off and lists only what is coming", async () => {
    api.fetchConnectionConfig.mockResolvedValue({});
    api.fetchMyConnections.mockResolvedValue({ connections: [] });
    const el = await render();
    expect(el.textContent).toContain("Game connections are not turned on for this server.");
    const soon = [...el.querySelectorAll("li")].map((li) => li.textContent);
    expect(soon).toEqual(["YouTube", "Riot", "Roblox", "GitHub"]);
  });

  it("confirms a disconnect in words that fit any provider and warns about visibility", async () => {
    api.fetchConnectionConfig.mockResolvedValue({ steam: true });
    api.fetchMyConnections.mockResolvedValue({ connections: [STEAM] });
    const el = await render();
    const disconnect = el.querySelector<HTMLButtonElement>(
      '[data-settings-row="steam"] button',
    )!;
    await act(async () => disconnect.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(
      "Your Steam account leaves your profile and nobody else sees it.",
    );
    expect(dialog.textContent).toContain(
      "If you connect a different Steam account, “Who can see this” goes back to “Friends and people who share a server with me”.",
    );
  });

  it("says the connection was cancelled when the person comes back unlinked", async () => {
    sessionStorage.setItem(
      "pqp.connection.pending",
      JSON.stringify({ provider: "steam", at: Date.now() }),
    );
    api.fetchConnectionConfig.mockResolvedValue({ steam: true });
    api.fetchMyConnections.mockResolvedValue({ connections: [] });
    const el = await render();
    expect(el.querySelector('[role="status"]')?.textContent).toBe(
      "Connection cancelled",
    );
    expect(sessionStorage.getItem("pqp.connection.pending")).toBeNull();
  });

  it("stays quiet when the trip ended in a link, an error or a stale marker", async () => {
    api.fetchConnectionConfig.mockResolvedValue({ steam: true });
    api.fetchMyConnections.mockResolvedValue({ connections: [STEAM] });
    sessionStorage.setItem(
      "pqp.connection.pending",
      JSON.stringify({ provider: "steam", at: Date.now() }),
    );
    let el = await render();
    expect(el.textContent).not.toContain("Connection cancelled");
    act(() => root?.unmount());
    host?.remove();

    api.fetchMyConnections.mockResolvedValue({ connections: [] });
    sessionStorage.setItem(
      "pqp.connection.pending",
      JSON.stringify({ provider: "steam", at: Date.now() - 3 * 60 * 60 * 1000 }),
    );
    el = await render();
    expect(el.textContent).not.toContain("Connection cancelled");
    act(() => root?.unmount());
    host?.remove();

    sessionStorage.setItem(
      "pqp.connection.pending",
      JSON.stringify({ provider: "steam", at: Date.now() }),
    );
    sessionStorage.setItem("pqp.connection.error", "Already linked elsewhere.");
    el = await render();
    expect(el.textContent).toContain("Already linked elsewhere.");
    expect(el.textContent).not.toContain("Connection cancelled");
  });

  it("stops the spinner and says cancelled when the page comes back from the browser cache", async () => {
    api.fetchConnectionConfig.mockResolvedValue({ twitch: true });
    api.fetchMyConnections.mockResolvedValue({ connections: [] });
    api.startConnection.mockResolvedValue({ url: "about:blank#provider" });
    const el = await render();
    const connect = el.querySelector<HTMLButtonElement>(
      '[data-settings-row="twitch"] button',
    )!;
    await act(async () => connect.click());
    expect(connect.getAttribute("aria-busy")).toBe("true");
    expect(sessionStorage.getItem("pqp.connection.pending")).toContain("twitch");
    await act(async () => {
      const event = new Event("pageshow") as Event & { persisted: boolean };
      event.persisted = true;
      window.dispatchEvent(event);
    });
    expect(connect.getAttribute("aria-busy")).toBeNull();
    expect(el.querySelector('[role="status"]')?.textContent).toBe(
      "Connection cancelled",
    );
  });
});
