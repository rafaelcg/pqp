// @vitest-environment jsdom
import { Permission, type Channel, type DmSummary, type Server } from "@pqp/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { I18nProvider } from "@/lib/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  fetchForwardDestinations: vi.fn(),
  fetchChannels: vi.fn(),
  fetchMemberPermissions: vi.fn(),
  createForward: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, ...api };
});

const { ForwardPicker, resetForwardTargetCacheForTests } = await import("./forward-picker");

const SERVER_A = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", name: "Alfa", iconUrl: null } as Server;

const SEND = Permission.SEND_MESSAGES.toString();
const NOSEND = "0";

function channel(
  serverId: string,
  n: number,
  type: Channel["type"] = "text",
): Channel {
  return {
    id: `${serverId.slice(0, 2)}${String(n).padStart(6, "0")}-0000-4000-8000-000000000000`,
    serverId,
    name: `canal-${n}`,
    type,
    kind: "server",
    position: n,
    isPrivate: false,
  } as Channel;
}

let currentUser: string | null = "user-1";
let root: Root | null = null;
let host: HTMLElement | null = null;
const onClose = vi.fn();
const onForwarded = vi.fn();

function mount(source: Parameters<typeof ForwardPicker>[0]["source"], servers = [SERVER_A]) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const render = (open: boolean) =>
    act(() =>
      root!.render(
        <I18nProvider>
          <ForwardPicker
            open={open}
            source={source}
            servers={servers}
            conversations={[] as DmSummary[]}
            currentServerId={SERVER_A.id}
            userId={currentUser}
            onClose={onClose}
            onForwarded={onForwarded}
          />
        </I18nProvider>,
      ),
    );
  render(true);
  return render;
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const rows = () => [...document.querySelectorAll("[data-forward-target]")];
const sendButton = () => document.querySelector<HTMLButtonElement>("[data-forward-send]")!;
const click = (el: Element | null) => act(() => { (el as HTMLElement).click(); });

const SOURCE = {
  kind: "bau_post" as const,
  id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
  serverId: SERVER_A.id,
  title: "Sessão 11",
  restricted: false,
};

beforeEach(() => {
  currentUser = "user-1";
  resetForwardTargetCacheForTests();
  vi.clearAllMocks();
  localStorage.clear();
  api.fetchMemberPermissions.mockResolvedValue({ version: 1, server: SEND, channels: {} });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("ForwardPicker destinations", () => {
  it("asks for each server's destinations in ONE request, in the order the server answers", async () => {
    const text = channel(SERVER_A.id, 1);
    const voice = channel(SERVER_A.id, 2, "voice");
    api.fetchForwardDestinations.mockResolvedValue({ channels: [text, voice] });
    mount(SOURCE);
    await flush();
    expect(rows().map((row) => row.getAttribute("data-forward-target"))).toEqual([text.id, voice.id]);
    expect(api.fetchForwardDestinations).toHaveBeenCalledTimes(1);
    expect(api.fetchChannels).not.toHaveBeenCalled();
    expect(api.fetchMemberPermissions).not.toHaveBeenCalled();
  });

  it("offers the threads the server lists after the channels, with their parent channel under the name, and sends one as a plain channel id", async () => {
    const text = channel(SERVER_A.id, 1);
    const threadId = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
    api.fetchForwardDestinations.mockResolvedValue({
      channels: [text],
      threads: [{ id: threadId, name: "ideias de clip", parentId: text.id, parentName: "canal-1" }],
    });
    api.createForward.mockResolvedValue({
      results: [
        { ok: true, target: { channelId: threadId }, channelId: threadId, serverId: SERVER_A.id, message: {} },
      ],
    });
    mount(SOURCE);
    await flush();
    expect(rows().map((row) => row.getAttribute("data-forward-target"))).toEqual([text.id, threadId]);
    const row = rows()[1]!;
    expect(row.textContent).toContain("ideias de clip");
    expect(row.textContent).toContain("#canal-1");
    // A thread answers to its parent's name too.
    const search = document.querySelector<HTMLInputElement>("[data-forward-search]")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(search, "canal-1");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(rows().map((r) => r.getAttribute("data-forward-target"))).toEqual([text.id, threadId]);
    click(rows()[1]!.querySelector("button"));
    await act(async () => { sendButton().click(); await Promise.resolve(); });
    await flush();
    expect(api.createForward.mock.calls[0]![0]).toMatchObject({ targets: [{ channelId: threadId }] });
    expect(onForwarded).toHaveBeenCalledWith(
      expect.objectContaining({ count: 1, first: expect.objectContaining({ id: threadId, threadOf: "canal-1" }) }),
    );
  });

  it("against an API without the route, the older two reads give the same list: text and a voice room's chat, never a category or a forum, nor one you cannot speak in", async () => {
    api.fetchForwardDestinations.mockRejectedValue(new ApiError(404, "Not found"));
    const text = channel(SERVER_A.id, 1);
    const voice = channel(SERVER_A.id, 2, "voice");
    const category = channel(SERVER_A.id, 3, "category");
    const forum = channel(SERVER_A.id, 4, "forum");
    const muted = channel(SERVER_A.id, 5);
    api.fetchChannels.mockResolvedValue({ channels: [text, voice, category, forum, muted] });
    api.fetchMemberPermissions.mockResolvedValue({
      version: 1,
      server: SEND,
      channels: { [muted.id]: NOSEND },
    });
    mount(SOURCE);
    await flush();
    const ids = rows().map((row) => row.getAttribute("data-forward-target"));
    expect(ids).toEqual([text.id, voice.id]);
  });

  it("keeps a minute of results: opening again does not fetch every server again", async () => {
    api.fetchForwardDestinations.mockResolvedValue({ channels: [channel(SERVER_A.id, 1)] });
    const render = mount(SOURCE);
    await flush();
    expect(api.fetchForwardDestinations).toHaveBeenCalledTimes(1);
    render(false);
    render(true);
    await flush();
    expect(api.fetchForwardDestinations).toHaveBeenCalledTimes(1);
  });

  it("never serves one account's destinations to another in the same page", async () => {
    api.fetchForwardDestinations.mockResolvedValue({ channels: [channel(SERVER_A.id, 1)] });
    let render = mount(SOURCE);
    await flush();
    expect(api.fetchForwardDestinations).toHaveBeenCalledTimes(1);
    act(() => root?.unmount());
    host?.remove();
    currentUser = "user-2";
    render = mount(SOURCE);
    await flush();
    void render;
    expect(api.fetchForwardDestinations).toHaveBeenCalledTimes(2);
  });

  it("a load that finishes after another account took over does not write into the cache", async () => {
    let release: (value: unknown) => void = () => {};
    api.fetchForwardDestinations.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    mount(SOURCE);
    await flush();
    // The page moves to another account (the cache is scoped and emptied), then the old load lands.
    act(() => root?.unmount());
    host?.remove();
    currentUser = "user-2";
    api.fetchForwardDestinations.mockResolvedValue({ channels: [channel(SERVER_A.id, 7)] });
    mount(SOURCE);
    await flush();
    await act(async () => { release({ channels: [channel(SERVER_A.id, 1)] }); await Promise.resolve(); });
    await flush();
    // User 2 opens again: served from ITS cache entry (channel 7), not user 1's late write (channel 1).
    act(() => root?.unmount());
    host?.remove();
    mount(SOURCE);
    await flush();
    expect(rows().map((row) => row.getAttribute("data-forward-target"))).toEqual([
      channel(SERVER_A.id, 7).id,
    ]);
  });

  it("a server that fails is a retryable error, not an empty list", async () => {
    api.fetchForwardDestinations.mockRejectedValueOnce(new Error("503"));
    mount(SOURCE);
    await flush();
    expect(document.querySelector("[data-forward-load-failed]")).not.toBeNull();
    expect(document.querySelector("[data-forward-empty]")).toBeNull();
    api.fetchForwardDestinations.mockResolvedValue({ channels: [channel(SERVER_A.id, 1)] });
    click(document.querySelector("[data-forward-retry-load]"));
    await flush();
    expect(document.querySelector("[data-forward-load-failed]")).toBeNull();
    expect(rows()).toHaveLength(1);
  });

  it("draws the first rows only, and Mostrar mais draws the next", async () => {
    api.fetchForwardDestinations.mockResolvedValue({
      channels: Array.from({ length: 200 }, (_, i) => channel(SERVER_A.id, i + 1)),
    });
    mount(SOURCE);
    await flush();
    expect(rows()).toHaveLength(80);
    click(document.querySelector("[data-forward-show-more]"));
    expect(rows()).toHaveLength(160);
  });
});

describe("ForwardPicker preview", () => {
  it("shows the source as plain text: no raw mention markup, even a malformed one", async () => {
    api.fetchForwardDestinations.mockResolvedValue({ channels: [channel(SERVER_A.id, 1)] });
    mount({
      ...SOURCE,
      title: "Aviso <@11111111-1111-4111-8111-111111111111> e <@123> @everyone",
    });
    await flush();
    const line = document.querySelector("[data-forward-source]")!.textContent;
    expect(line).toBe("Aviso e @everyone");
    expect(line).not.toContain("<");
  });
});

describe("ForwardPicker sending", () => {
  async function pickFirstAndSend() {
    click(rows()[0]!.querySelector("button"));
    await act(async () => {
      sendButton().click();
      await Promise.resolve();
    });
    await flush();
  }

  it("after a VALID partial answer the retry is a new attempt with a new nonce; after a lost connection it keeps the nonce", async () => {
    const a = channel(SERVER_A.id, 1);
    api.fetchForwardDestinations.mockResolvedValue({ channels: [a] });
    api.createForward
      // A lost connection: ambiguous, the same request may be retried as is.
      .mockRejectedValueOnce(new Error("network"))
      // A valid answer where the one target was refused.
      .mockResolvedValueOnce({
        results: [{ ok: false, target: { channelId: a.id }, reason: "slow_mode", retryAfterMs: 1000 }],
      })
      .mockResolvedValue({
        results: [{ ok: true, target: { channelId: a.id }, channelId: a.id, serverId: SERVER_A.id, message: {} }],
      });
    mount(SOURCE);
    await flush();
    await pickFirstAndSend();
    await act(async () => { sendButton().click(); await Promise.resolve(); });
    await flush();
    await act(async () => { sendButton().click(); await Promise.resolve(); });
    await flush();
    const nonces = api.createForward.mock.calls.map((call) => (call[0] as { nonce: string }).nonce);
    expect(nonces).toHaveLength(3);
    // Network failure then the same request again: same nonce.
    expect(nonces[1]).toBe(nonces[0]);
    // A valid (partial) answer: the next attempt is a new one.
    expect(nonces[2]).not.toBe(nonces[1]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a new opening starts idle even when the previous send never answered", async () => {
    const a = channel(SERVER_A.id, 1);
    api.fetchForwardDestinations.mockResolvedValue({ channels: [a] });
    api.createForward.mockReturnValue(new Promise(() => {}));
    const render = mount(SOURCE);
    await flush();
    click(rows()[0]!.querySelector("button"));
    await act(async () => { sendButton().click(); await Promise.resolve(); });
    expect(sendButton().disabled).toBe(true);
    render(false);
    render(true);
    await flush();
    click(rows()[0]!.querySelector("button"));
    expect(sendButton().disabled).toBe(false);
  });

  it("a send that never answers can be dismissed after a while, and its late answer does not touch a later picker", async () => {
    vi.useFakeTimers();
    try {
      const a = channel(SERVER_A.id, 1);
      api.fetchForwardDestinations.mockResolvedValue({ channels: [a] });
      let finish: (value: unknown) => void = () => {};
      api.createForward.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
      mount(SOURCE);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      click(rows()[0]!.querySelector("button"));
      await act(async () => { sendButton().click(); await Promise.resolve(); });
      act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      expect(onClose).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(21_000); });
      act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      expect(onClose).toHaveBeenCalledTimes(1);
      void finish;
    } finally {
      vi.useRealTimers();
    }
  });

  it("cannot be dismissed while a send is in flight", async () => {
    const a = channel(SERVER_A.id, 1);
    api.fetchForwardDestinations.mockResolvedValue({ channels: [a] });
    let finish: (value: unknown) => void = () => {};
    api.createForward.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    mount(SOURCE);
    await flush();
    click(rows()[0]!.querySelector("button"));
    await act(async () => { sendButton().click(); await Promise.resolve(); });
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      finish({
        results: [{ ok: true, target: { channelId: a.id }, channelId: a.id, serverId: SERVER_A.id, message: {} }],
      });
      await Promise.resolve();
    });
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
