// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => api);

import { resetAppConsentsForTests } from "@/lib/apps/consents";
import { AppsSection } from "./apps-section";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
let list: unknown[] = [];

const row = (over: Record<string, unknown> = {}) => ({
  appId: "pqp-eco",
  acceptedVersion: "1.0.0",
  identityGranted: false,
  consentedAt: "2026-10-19T19:00:00Z",
  identity: "display",
  names: { "pt-BR": "Sala de jogos", en: "Game room" },
  notices: {},
  stale: false,
  ...over,
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<AppsSection />));
  await flush();
}

beforeEach(() => {
  resetAppConsentsForTests();
  api.apiFetch.mockReset();
  list = [];
  api.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path === "/api/me/app-consents") return { consents: list };
    if (init?.method === "DELETE") {
      list = [];
      return { revoked: true };
    }
    return {};
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("AppsSection", () => {
  it("says there is nothing yet, and what makes something show up", async () => {
    await mount();
    expect(host!.textContent).toMatch(/Nenhum app ainda|No apps yet/);
    expect(host!.querySelector("button")).toBeNull();
  });

  it("lists each accepted app with what it sees, and one button to take it back", async () => {
    list = [row()];
    await mount();
    const text = host!.textContent ?? "";
    expect(text).toMatch(/Game room|Sala de jogos/);
    expect(text).toMatch(/nome de exibição|display name/);
    expect(text).toMatch(/não vê|[Dd]oes not see/);
    expect(host!.querySelectorAll("button")).toHaveLength(1);
  });

  it("an app that was let see its own id says so", async () => {
    list = [row({ identity: "user-id", identityGranted: true })];
    await mount();
    expect(host!.textContent).toMatch(/id só dele|id of its own/);
  });

  it("an app that changed since says it will ask again", async () => {
    list = [row({ stale: true })];
    await mount();
    expect(host!.textContent).toMatch(/perguntar de novo|ask again/);
  });

  it("taking it back asks the server and empties the list", async () => {
    list = [row()];
    await mount();
    await act(async () => {
      host!.querySelector("button")!.click();
    });
    await flush();
    expect(api.apiFetch).toHaveBeenCalledWith("/api/apps/pqp-eco/consent", { method: "DELETE" });
    expect(host!.textContent).toMatch(/Nenhum app ainda|No apps yet/);
  });

  it("a failed revoke is said in the row and the app stays", async () => {
    list = [row()];
    api.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === "/api/me/app-consents") return { consents: list };
      if (init?.method === "DELETE") throw new Error("offline");
      return {};
    });
    await mount();
    await act(async () => {
      host!.querySelector("button")!.click();
    });
    await flush();
    expect(host!.textContent).toMatch(/Não deu pra tirar|Could not take it back/);
    expect(host!.textContent).toMatch(/Game room|Sala de jogos/);
  });
});
