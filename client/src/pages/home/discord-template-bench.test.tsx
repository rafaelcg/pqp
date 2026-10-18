// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRIENDS_FAMILY_TEMPLATE } from "../../../../packages/shared/src/discord-import.fixture";
import { TEMPLATE_MAX_BYTES } from "./discord-template-preview";
import { Mudanca } from "./mudanca";

/*
 * The paste bar in Vindo do Discord, rendered whole, with `fetch` mocked.
 *
 * `t` echoes the key and its values, so these assertions survive copy edits
 * and do not need the home.move.* keys in the catalogue (a missing key throws
 * under vitest). The auth gate is swapped for a controllable one, so the CTA
 * can be read as a link (signed in, or the dev bypass) or clicked as the
 * signed-out sign-up button.
 */

vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  const t = (key: string, vars?: Record<string, unknown>) =>
    vars
      ? `${key}(${Object.entries(vars)
          .map(([name, value]) => `${name}=${String(value)}`)
          .join(",")})`
      : key;
  const translator = { locale: "pt-BR", t };
  return { ...actual, useTranslation: () => translator };
});

const auth = vi.hoisted(() => ({
  signedIn: false,
  bypass: true,
  join: vi.fn(),
  signIn: vi.fn(),
}));
vi.mock("@/components/marketing/marketing-auth-ctas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/marketing/marketing-auth-ctas")>()),
  MarketingAuthGate: ({ children }: { children: (value: typeof auth) => ReactNode }) => <>{children(auth)}</>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = "xTdwZ53KdBKz";
const OTHER = "hgM48av5Q69A";
const LINK = `https://discord.new/${CODE}`;
const API = `https://discord.com/api/v10/guilds/templates/${CODE}`;
const STASH_KEY = "pqp:pending-create-community";

let reducedMotion = true;
let root: Root | null = null;
let host: HTMLElement | null = null;
const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>();

beforeEach(() => {
  reducedMotion = true;
  Object.assign(auth, { signedIn: false, bypass: true });
  auth.join.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" ? reducedMotion : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  );
  window.localStorage.clear();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter>
        <Mudanca />
      </MemoryRouter>,
    ),
  );
}

/* ------------------------------------------------------------ Lookups */

const $ = <T extends Element = HTMLElement>(selector: string) => host!.querySelector<T>(selector);
const $$ = (selector: string) => [...host!.querySelectorAll<HTMLElement>(selector)];
const field = () => $<HTMLInputElement>('input[name="discord-template"]')!;
const bench = () => $("[data-bench-source]")!;
const message = () => $("[data-bench-message]")!;
const statusOn = () => $("[data-bench-status][data-on]")?.dataset.benchStatus;
const sectionCta = () => $("#mudanca-cta a, #mudanca-cta button")!;
const sampleButton = () =>
  $$("button").find((button) => /home\.move\.paste\.(useSample|replaySample)$/.test(button.textContent ?? ""))!;
const panelRows = (panel: "discord" | "pqp") =>
  $$(`[data-bench-panel="${panel}"] [data-bench-row]`).map((row) => ({
    kind: row.dataset.benchRow,
    text: row.textContent ?? "",
  }));
const countOf = (item: string) => $(`[data-bench-count="${item}"]`)?.textContent?.trim();
const live = () => $$('[aria-live="polite"]').map((region) => region.textContent ?? "");

/* ------------------------------------------------------------ Actions */

function type(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(), value);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submit() {
  act(() => {
    field().form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function paste(text: string) {
  act(() => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
    field().dispatchEvent(event);
  });
}

/** Lets the read and its state updates land. */
async function until(check: () => boolean, budgetMs = 2000) {
  const end = Date.now() + budgetMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting for the bench");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

/* ------------------------------------------------------------ Responses */

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Friends & Family with 30 more text channels and five roles: more than the bench holds. */
function bigTemplate() {
  const template = copy(FRIENDS_FAMILY_TEMPLATE) as unknown as {
    serialized_source_guild: { channels: Record<string, unknown>[]; roles: Record<string, unknown>[] };
  };
  const guild = template.serialized_source_guild;
  for (let i = 0; i < 30; i++) {
    guild.channels.push({
      id: 100 + i,
      type: 0,
      name: `canal-${i}`,
      position: 10 + i,
      topic: null,
      parent_id: 1,
      nsfw: false,
      rate_limit_per_user: 0,
      permission_overwrites: [],
    });
  }
  for (let i = 0; i < 5; i++) {
    guild.roles.push({ id: 200 + i, name: `cargo-${i}`, permissions: "0", color: 0, hoist: false, mentionable: false });
  }
  return template;
}

/** A read that never answers by itself, and records the signal it was given. */
function hangingRead() {
  const signals: AbortSignal[] = [];
  const impl = (_input: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init.signal!;
      signals.push(signal);
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  return { signals, impl };
}

/* ------------------------------------------------------------ Tests */

describe("Vindo do Discord: the paste bar", () => {
  it("starts on the sample, with an empty real field and no request", () => {
    mount();
    const input = field();
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("home.move.paste.placeholder");
    expect(input.getAttribute("inputmode")).toBe("url");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
    // A visible label, tied to the field, and the message under it.
    const label = $<HTMLLabelElement>(`label[for="${input.id}"]`)!;
    expect(label.textContent).toBe("home.move.paste.label");
    expect(input.getAttribute("aria-describedby")).toBe(message().id);
    expect(message().dataset.benchMessage).toBe("hint");
    expect(bench().dataset.benchSource).toBe("sample");
    expect(sectionCta().getAttribute("href")).toBe("/app?import=discord");
    expect(sectionCta().textContent).toContain("home.cta.import");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads a submitted template and draws that server, in sidebar order", async () => {
    fetchMock.mockImplementation(async () => json(FRIENDS_FAMILY_TEMPLATE));
    mount();
    type(LINK);
    submit();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(API);
    expect(init).toMatchObject({
      method: "GET",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/json" },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(field().form!.getAttribute("aria-busy")).toBe("true");
    expect(statusOn()).toBe("building");

    await until(() => bench().dataset.benchSource === "template");
    expect(bench().dataset.benchPhase).toBe("preview");
    expect(field().form!.hasAttribute("aria-busy")).toBe(false);

    const expected = [
      { kind: "server", text: "Friends & Family" },
      { kind: "category", text: "Text Channels" },
      { kind: "text", text: "general" },
      { kind: "text", text: "games" },
      { kind: "text", text: "music" },
      { kind: "category", text: "Voice Channels" },
      { kind: "voice", text: "Lounge" },
      { kind: "voice", text: "Stream Room" },
    ];
    for (const panel of ["discord", "pqp"] as const) {
      const rows = panelRows(panel);
      expect(rows.map((row) => row.kind)).toEqual(expected.map((row) => row.kind));
      expected.forEach((row, i) => expect(rows[i].text).toContain(row.text));
    }

    // The lists count the template, and the tag no longer says sample.
    expect(countOf("categories")).toBe("2");
    expect(countOf("channels")).toBe("5");
    expect(countOf("roles")).toBe("0");
    expect(countOf("private")).toBe("0");
    expect(countOf("mapped")).toBe("1");
    expect(host!.textContent).toContain("home.move.paste.yourPreview");
    expect(host!.textContent).toContain("home.move.paste.nameOnly");

    // The status line and the live region, with plural-safe counts.
    expect(statusOn()).toBe("ready");
    const spoken = live().join(" ");
    expect(spoken).toContain("home.move.paste.announce.ready");
    expect(spoken).toContain("home.move.paste.count.categories(count=2)");
    expect(spoken).toContain("home.move.paste.count.channels(count=5)");
    expect(spoken).toContain("home.move.paste.count.roles(count=0)");

    // Only the code travels, in the CTA under the bench and the one in the status line.
    expect(sectionCta().getAttribute("href")).toBe(`/app?import=${CODE}`);
    expect(sectionCta().textContent).toContain("home.move.paste.bring");
    const ready = $('[data-bench-status="ready"] a')!;
    expect(ready.getAttribute("href")).toBe(`/app?import=${CODE}`);
  });

  it("reads a pasted link without a submit, and never per keystroke", async () => {
    fetchMock.mockImplementation(async () => json(FRIENDS_FAMILY_TEMPLATE));
    mount();
    type("discord.new/");
    type(`discord.new/${CODE}`);
    expect(fetchMock).not.toHaveBeenCalled();

    // A paste that is not a template does nothing until a submit.
    paste("só um pedaço");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(message().dataset.benchMessage).toBe("hint");

    paste(`  ${LINK}  `);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(API);
    await until(() => bench().dataset.benchSource === "template");
  });

  it.each([
    ["404", () => new Response("{}", { status: 404 }), "notFound"],
    ["429", () => new Response("{}", { status: 429 }), "rateLimited"],
    ["500", () => new Response("{}", { status: 500 }), "unavailable"],
    ["an oversize body", () => new Response("x".repeat(TEMPLATE_MAX_BYTES + 1), { status: 200 }), "tooLarge"],
    ["garbage JSON", () => new Response("<html>not json</html>", { status: 200 }), "unavailable"],
    ["a body that is not a template", () => json({ message: "hi" }), "unavailable"],
  ] as const)("names %s in the import dialog's words, and keeps the field", async (_name, respond, reason) => {
    fetchMock.mockImplementation(async () => respond());
    mount();
    type(LINK);
    submit();
    await until(() => message().dataset.benchMessage === reason);

    expect(message().textContent).toBe(`importDiscord.error.${reason}`);
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(field());
    expect(bench().dataset.benchSource).toBe("sample");
    expect(sectionCta().getAttribute("href")).toBe("/app?import=discord");

    // Typing again clears the complaint.
    type(`${LINK}x`);
    expect(message().dataset.benchMessage).toBe("hint");
    expect(field().hasAttribute("aria-invalid")).toBe(false);
  });

  it("says too many with the caps when the template is over them", async () => {
    const template = copy(FRIENDS_FAMILY_TEMPLATE) as unknown as {
      serialized_source_guild: { channels: Record<string, unknown>[] };
    };
    for (let i = 0; i < 260; i++) {
      template.serialized_source_guild.channels.push({
        id: 1000 + i,
        type: 0,
        name: `c-${i}`,
        position: i,
        parent_id: null,
        permission_overwrites: [],
      });
    }
    fetchMock.mockImplementation(async () => json(template));
    mount();
    type(LINK);
    submit();
    await until(() => message().dataset.benchMessage === "tooMany");
    expect(message().textContent).toMatch(/^importDiscord\.error\.tooMany\(channels=\d+,categories=\d+\)$/);
  });

  it("refuses an invite link and other text before any request", async () => {
    mount();
    // A pasted invite is named at once, and the paste's own input event does not clear it.
    paste("https://discord.gg/abc123");
    type("https://discord.gg/abc123");
    expect(message().dataset.benchMessage).toBe("inviteLink");
    expect(message().textContent).toBe("importDiscord.error.inviteLink");
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    type("");
    expect(message().dataset.benchMessage).toBe("hint");

    type("https://discord.gg/abc123");
    submit();
    expect(message().dataset.benchMessage).toBe("inviteLink");
    expect(message().textContent).toBe("importDiscord.error.inviteLink");
    expect(document.activeElement).toBe(field());

    type("isso não é um link");
    submit();
    expect(message().dataset.benchMessage).toBe("notATemplate");
    expect(message().textContent).toBe("importDiscord.error.notATemplate");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(bench().dataset.benchSource).toBe("sample");
  });

  it("keeps the code when Discord cannot be reached from the page", async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    mount();
    type(LINK);
    submit();
    await until(() => bench().dataset.benchSource === "offline");

    // Not the visitor's fault: no error on the field, a plain sentence instead.
    expect(message().dataset.benchMessage).toBe("hint");
    expect(field().hasAttribute("aria-invalid")).toBe(false);
    expect(statusOn()).toBe("offline");
    expect($('[data-bench-status="offline"]')!.textContent).toContain("home.move.paste.offline");
    expect(live().join(" ")).toContain("home.move.paste.offline");
    expect($('[data-bench-status="offline"] a')!.getAttribute("href")).toBe(`/app?import=${CODE}`);
    expect(sectionCta().getAttribute("href")).toBe(`/app?import=${CODE}`);
  });

  it("drops the first read when a second link is pasted", async () => {
    const first = hangingRead();
    fetchMock.mockImplementationOnce(first.impl);
    fetchMock.mockImplementationOnce(async () => json(FRIENDS_FAMILY_TEMPLATE));
    mount();

    paste(`https://discord.new/${OTHER}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.signals[0].aborted).toBe(false);

    paste(LINK);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.signals[0].aborted).toBe(true);
    expect(fetchMock.mock.calls[1][0]).toBe(API);

    await until(() => bench().dataset.benchSource === "template");
    expect(sectionCta().getAttribute("href")).toBe(`/app?import=${CODE}`);
    expect(message().dataset.benchMessage).toBe("hint");
  });

  it("aborts the read in flight on unmount", () => {
    const read = hangingRead();
    fetchMock.mockImplementationOnce(read.impl);
    mount();
    paste(LINK);
    expect(read.signals[0].aborted).toBe(false);
    act(() => root!.unmount());
    root = null;
    expect(read.signals[0].aborted).toBe(true);
  });

  it("bounds a large server with a +N line and the same height", async () => {
    fetchMock.mockImplementation(async () => json(bigTemplate()));
    mount();
    // The Discord side always draws every row; the pqp side draws them as they arrive.
    const sampleRows = panelRows("discord").length;
    paste(LINK);
    await until(() => bench().dataset.benchSource === "template");

    const rows = panelRows("pqp");
    expect(rows).toHaveLength(sampleRows);
    const more = rows[rows.length - 1];
    expect(more.kind).toBe("more");
    expect(more.text).toContain("+home.move.paste.count.channels(count=23)");
    expect(more.text).toContain("+home.move.paste.count.categories(count=1)");
    expect(more.text).toContain("+home.move.paste.count.roles(count=5)");
    expect(panelRows("discord").at(-1)?.kind).toBe("more");
    // The counts are the whole template's, not what fits.
    expect(countOf("channels")).toBe("35");
    expect(countOf("roles")).toBe("5");
  });

  it("goes back to the sample from a pasted server", async () => {
    fetchMock.mockImplementation(async () => json(FRIENDS_FAMILY_TEMPLATE));
    mount();
    type(LINK);
    submit();
    await until(() => bench().dataset.benchSource === "template");

    act(() => sampleButton().click());
    expect(bench().dataset.benchSource).toBe("sample");
    expect(field().value).toBe("");
    expect(sectionCta().getAttribute("href")).toBe("/app?import=discord");
    expect(panelRows("pqp")[0].text).toContain("home.move.sample.server");
    expect($("[data-bench-count]")).toBeNull();
  });

  it("assembles row by row when motion is allowed", async () => {
    reducedMotion = false;
    fetchMock.mockImplementation(async () => json(FRIENDS_FAMILY_TEMPLATE));
    mount();
    paste(LINK);
    await until(() => bench().dataset.benchPhase === "building");
    expect(bench().dataset.benchSource).toBe("template");
    expect($("[aria-busy]")).not.toBeNull();
    await until(() => bench().dataset.benchPhase === "preview", 4000);
    expect(statusOn()).toBe("ready");
  });

  it("stashes the code through sign-up for a signed-out visitor", async () => {
    Object.assign(auth, { signedIn: false, bypass: false });
    fetchMock.mockImplementation(async () => json(FRIENDS_FAMILY_TEMPLATE));
    mount();
    paste(LINK);
    await until(() => bench().dataset.benchSource === "template");

    const button = sectionCta();
    expect(button.tagName).toBe("BUTTON");
    act(() => button.click());
    expect(auth.join).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(window.localStorage.getItem(STASH_KEY) ?? "null") as { handle: string } | null;
    expect(stored?.handle).toBe(LINK);
  });

  it("takes a signed-in visitor straight to the import with the code", async () => {
    Object.assign(auth, { signedIn: true, bypass: false });
    fetchMock.mockImplementation(async () => json(FRIENDS_FAMILY_TEMPLATE));
    mount();
    paste(LINK);
    await until(() => bench().dataset.benchSource === "template");
    expect(sectionCta().getAttribute("href")).toBe(`/app?import=${CODE}`);
  });
});
