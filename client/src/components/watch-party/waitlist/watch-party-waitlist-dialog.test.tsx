// @vitest-environment jsdom
import type { WatchPartyWaitlistState } from "@pqp/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadWatchPartyWaitlist,
  peekWatchPartyWaitlist,
  resetWatchPartyWaitlistStore,
  setWatchPartyWaitlistOwner,
} from "@/lib/watch-party-waitlist";
import { WatchPartyWaitlistDialog, waitlistViewFor } from "./watch-party-waitlist-dialog";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
  apiFetch,
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const SERVER = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";

function state(overrides: Partial<WatchPartyWaitlistState> = {}): WatchPartyWaitlistState {
  return {
    campaign: true,
    canRequest: true,
    available: false,
    entry: null,
    ...overrides,
  };
}

let root: Root | null = null;
let host: HTMLElement;

/** GET answers per server, POST echoes a waiting row of the right kind. */
function serve(answers: Record<string, WatchPartyWaitlistState>) {
  apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        serverId: string | null;
        audienceBucket: string | null;
        note: string | null;
        streamChannel: string | null;
      };
      const answer = answers[body.serverId ?? ""];
      return {
        entry: {
          serverId: body.serverId,
          kind: answer?.canRequest ? "request" : "interest",
          status: "waiting",
          audienceBucket: body.audienceBucket,
          note: body.note,
          streamChannel: body.streamChannel,
          createdAt: "2026-09-25T12:00:00.000Z",
          decidedAt: null,
        },
      };
    }
    const id = new URL(path, "http://x").searchParams.get("serverId") ?? "";
    return answers[id];
  });
}

async function open(
  servers: { id: string; name: string }[],
  initialServerId: string | null,
) {
  await act(async () => {
    root = createRoot(host);
    root.render(
      <WatchPartyWaitlistDialog
        open
        onClose={() => {}}
        servers={servers}
        initialServerId={initialServerId}
        onReload={() => {}}
      />,
    );
  });
  // The store answers on a later tick.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function view(): string | null {
  return document.querySelector("[data-watch-party-waitlist-view]")?.getAttribute(
    "data-watch-party-waitlist-view",
  ) ?? null;
}

function submitButton(): HTMLButtonElement {
  return document.querySelector("[data-watch-party-waitlist-submit]") as HTMLButtonElement;
}

async function click(element: Element) {
  await act(async () => {
    (element as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  resetWatchPartyWaitlistStore();
  apiFetch.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = "";
});

describe("waitlistViewFor", () => {
  it("is decided by the server's answer, never the client", () => {
    expect(waitlistViewFor(SERVER, null, false)).toBe("loading");
    expect(waitlistViewFor(SERVER, state(), false)).toBe("request");
    expect(waitlistViewFor(SERVER, state({ canRequest: false }), false)).toBe("member");
    expect(waitlistViewFor(null, state({ canRequest: false }), false)).toBe("serverless");
    expect(waitlistViewFor(SERVER, state({ available: true }), false)).toBe("approved");
    const waiting = state({
      entry: {
        serverId: SERVER,
        kind: "request",
        status: "waiting",
        audienceBucket: "20-50",
        note: null,
        streamChannel: null,
        createdAt: "2026-09-25T12:00:00.000Z",
        decidedAt: null,
      },
    });
    expect(waitlistViewFor(SERVER, waiting, false)).toBe("waiting");
    expect(waitlistViewFor(SERVER, waiting, true)).toBe("request");
    expect(
      waitlistViewFor(SERVER, { ...waiting, entry: { ...waiting.entry!, status: "declined" } }, false),
    ).toBe("declined");
  });
});

describe("WatchPartyWaitlistDialog", () => {
  it("lets somebody who manages the server ask, once they say how many would watch", async () => {
    serve({ [SERVER]: state() });
    await open([{ id: SERVER, name: "Sessão" }], SERVER);
    expect(view()).toBe("request");
    expect(document.querySelector("[data-watch-party-stage-art]")).not.toBeNull();
    expect(submitButton().disabled).toBe(true);

    await click(document.querySelector("[data-audience-bucket='50-150']")!);
    expect(submitButton().disabled).toBe(false);
    const [note, channel] = [...document.querySelectorAll("input")] as HTMLInputElement[];
    await type(note!, "Final do campeonato");
    await type(channel!, "twitch.tv/sodtz");
    await click(submitButton());

    const post = apiFetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post![1].body))).toEqual({
      serverId: SERVER,
      audienceBucket: "50-150",
      note: "Final do campeonato",
      streamChannel: "twitch.tv/sodtz",
    });
    expect(view()).toBe("waiting");
    expect(document.querySelector("[data-watch-party-waitlist-done]")?.textContent).toContain(
      "You are on the list",
    );
  });

  it("refuses a channel that is not Twitch or Kick before it is sent", async () => {
    serve({ [SERVER]: state() });
    await open([{ id: SERVER, name: "Sessão" }], SERVER);
    await click(document.querySelector("[data-audience-bucket='under-20']")!);
    const channel = [...document.querySelectorAll("input")][1] as HTMLInputElement;
    await type(channel, "youtube.com/foo");
    expect(channel.getAttribute("aria-invalid")).toBe("true");
    expect(submitButton().disabled).toBe(true);
  });

  it("tells a member to ask whoever runs the server, and counts their vote", async () => {
    serve({ [SERVER]: state({ canRequest: false }) });
    await open([{ id: SERVER, name: "Sessão" }], SERVER);
    expect(view()).toBe("member");
    expect(document.body.textContent).toContain("Ask whoever runs the server");
    // No audience question for a member: that is the requester's call.
    expect(document.querySelector("[data-audience-bucket]")).toBeNull();
    expect(submitButton().disabled).toBe(false);
    await click(submitButton());
    expect(view()).toBe("waiting");
    expect(document.body.textContent).toContain("Your vote counts toward the request for Sessão");
  });

  it("starts on the open server and follows the picker to another one", async () => {
    serve({ [SERVER]: state({ canRequest: false }), [OTHER]: state() });
    await open(
      [
        { id: OTHER, name: "Outro" },
        { id: SERVER, name: "Sessão" },
      ],
      SERVER,
    );
    const select = document.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe(SERVER);
    expect(view()).toBe("member");
    await act(async () => {
      select.value = OTHER;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(view()).toBe("request");
  });

  it("offers somebody with no server a way to be told", async () => {
    serve({ "": state({ canRequest: false }) });
    await open([], null);
    expect(view()).toBe("serverless");
    await click(submitButton());
    const post = apiFetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post![1].body))).toMatchObject({ serverId: null });
    expect(view()).toBe("waiting");
  });

  it("says a server is already on instead of offering a form", async () => {
    serve({ [SERVER]: state({ available: true }) });
    await open([{ id: SERVER, name: "Sessão" }], SERVER);
    expect(view()).toBe("approved");
    expect(document.querySelector("form")).toBeNull();
  });

  it("says a failed read failed, and tries again when asked", async () => {
    let fail = true;
    apiFetch.mockImplementation(async () => {
      if (fail) {
        throw new Error("network");
      }
      return state();
    });
    await open([{ id: SERVER, name: "Sessão" }], SERVER);
    expect(view()).toBe("loading");
    const retry = document.querySelector("[data-watch-party-waitlist-retry]");
    expect(retry).not.toBeNull();
    fail = false;
    await click(retry!);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(view()).toBe("request");
  });
});

describe("the waitlist store", () => {
  it("forgets one account's rows when another signs in, including a read still in flight", async () => {
    setWatchPartyWaitlistOwner("user-a");
    let release: (value: WatchPartyWaitlistState) => void = () => {};
    apiFetch.mockImplementationOnce(
      () => new Promise<WatchPartyWaitlistState>((resolve) => (release = resolve)),
    );
    const pending = loadWatchPartyWaitlist(SERVER);
    setWatchPartyWaitlistOwner("user-b");
    release(state({ entry: null, canRequest: true }));
    await pending;
    // Account A's answer landed after the switch and was dropped.
    expect(peekWatchPartyWaitlist(SERVER)).toBeNull();
  });
});
