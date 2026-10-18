import { describe, expect, it, vi } from "vitest";
import { mapGuildTemplate, MAX_IMPORT_CHANNELS, NOT_IN_TEMPLATE_REASONS } from "@pqp/shared";
import { FRIENDS_FAMILY_TEMPLATE } from "../../../../packages/shared/src/discord-import.fixture";
import {
  BENCH_SLOTS,
  benchFromPlan,
  boundRows,
  checkPaste,
  comesAt,
  countRows,
  fetchTemplatePlan,
  initialsOf,
  prefetchTemplateMapper,
  sidebarRows,
  templateLink,
  TEMPLATE_MAX_BYTES,
  type BenchRow,
} from "./discord-template-preview";

type Template = {
  code: string;
  name: string;
  updated_at: string;
  is_dirty: null;
  serialized_source_guild: {
    name: string;
    icon_hash: string | null;
    roles: Record<string, unknown>[];
    channels: Record<string, unknown>[];
  };
};

/** A deep, mutable copy of the frozen Friends & Family snapshot. */
function friendsAndFamily(): Template {
  return JSON.parse(JSON.stringify(FRIENDS_FAMILY_TEMPLATE)) as Template;
}

function channel(id: number, type: number, name: string, parent: number | null, position: number, extra = {}) {
  return {
    id,
    type,
    name,
    position,
    topic: null,
    parent_id: parent,
    nsfw: false,
    rate_limit_per_user: 0,
    bitrate: 64000,
    permission_overwrites: [],
    available_tags: [],
    ...extra,
  };
}

/**
 * Friends & Family plus what the snapshot lacks: a loose channel, a private
 * one (@everyone denied VIEW_CHANNEL, 1 << 10), an announcement channel, a
 * thread, a slowmode, topics and two real roles.
 */
function richTemplate(): Template {
  const template = friendsAndFamily();
  const guild = template.serialized_source_guild;
  guild.name = "A Mesa";
  guild.roles.push(
    { id: 1, name: "Mestre", permissions: "0", color: 0xfcd34d, hoist: true, mentionable: false },
    { id: 2, name: "Jogadores", permissions: "0", color: 0, hoist: false, mentionable: true },
  );
  guild.channels.push(
    channel(8, 0, "boas-vindas", null, 0, { topic: "Leia antes de entrar" }),
    channel(9, 0, "bastidores", 1, 6, {
      permission_overwrites: [{ id: 0, type: 0, allow: "0", deny: "1024" }],
    }),
    channel(10, 5, "avisos", 1, 0, { topic: "Novidades", rate_limit_per_user: 30 }),
    channel(11, 11, "um-topico", 2, 0),
  );
  return template;
}

const kinds = (rows: BenchRow[]) => rows.map((r) => r.kind);
const names = (rows: BenchRow[]) => rows.map((r) => ("name" in r ? r.name : r.kind));

describe("checkPaste", () => {
  it("reads a code from the shapes the import accepts", () => {
    expect(checkPaste("https://discord.new/xTdwZ53KdBKz")).toEqual({ ok: true, code: "xTdwZ53KdBKz" });
    expect(checkPaste("discord.new/xTdwZ53KdBKz")).toEqual({ ok: true, code: "xTdwZ53KdBKz" });
    expect(checkPaste("  hgM48av5Q69A  ")).toEqual({ ok: true, code: "hgM48av5Q69A" });
    expect(checkPaste("https://discord.com/template/hgM48av5Q69A")).toEqual({ ok: true, code: "hgM48av5Q69A" });
  });

  it("names an invite apart from anything else", () => {
    expect(checkPaste("https://discord.gg/abc123")).toEqual({ ok: false, reason: "inviteLink" });
    expect(checkPaste("discord.com/invite/abc123")).toEqual({ ok: false, reason: "inviteLink" });
    expect(checkPaste("isso não é um link")).toEqual({ ok: false, reason: "notATemplate" });
    expect(checkPaste("")).toEqual({ ok: false, reason: "notATemplate" });
    // The sample's own placeholder can never be somebody's server.
    expect(checkPaste("discord.new/exemplo-da-mesa")).toEqual({ ok: false, reason: "notATemplate" });
  });

  it("builds the link the import dialog is pre-filled with", () => {
    expect(templateLink("xTdwZ53KdBKz")).toBe("https://discord.new/xTdwZ53KdBKz");
  });
});

describe("initialsOf", () => {
  it("takes two words, or two letters of one", () => {
    expect(initialsOf("A Mesa")).toBe("AM");
    expect(initialsOf("Friends & Family")).toBe("FF");
    expect(initialsOf("pqp")).toBe("PQ");
    expect(initialsOf("  única  ")).toBe("ÚN");
  });

  it("keeps an emoji whole and skips it as a word", () => {
    expect(initialsOf("🎮 Gamers")).toBe("GA");
    expect(initialsOf("🎮")).toBe("🎮");
  });
});

describe("sidebarRows", () => {
  it("puts Friends & Family in sidebar order", () => {
    const plan = mapGuildTemplate(friendsAndFamily());
    expect(names(sidebarRows(plan))).toEqual([
      "Text Channels",
      "general",
      "games",
      "music",
      "Voice Channels",
      "Lounge",
      "Stream Room",
    ]);
  });

  it("draws loose channels first, each category with its own, then the roles", () => {
    const rows = sidebarRows(mapGuildTemplate(richTemplate()));
    expect(names(rows)).toEqual([
      "boas-vindas",
      "Text Channels",
      "avisos",
      "general",
      "games",
      "music",
      "bastidores",
      "Voice Channels",
      "Lounge",
      "Stream Room",
      "label",
      "Mestre",
      "Jogadores",
    ]);
    const bastidores = rows.find((r) => "name" in r && r.name === "bastidores");
    expect(bastidores).toMatchObject({ kind: "text", private: true });
    const avisos = rows.find((r) => "name" in r && r.name === "avisos");
    expect(avisos).toMatchObject({ kind: "text", private: false, topic: true });
    expect(rows.find((r) => r.kind === "role" && r.name === "Mestre")).toMatchObject({ color: "#FCD34D" });
    expect(rows.find((r) => r.kind === "role" && r.name === "Jogadores")).toMatchObject({ color: null });
  });
});

describe("benchFromPlan", () => {
  it("turns Friends & Family into the bench rows and counts", () => {
    const bench = benchFromPlan(mapGuildTemplate(friendsAndFamily()));
    expect(bench.rows[0]).toEqual({ kind: "server", name: "Friends & Family", initials: "FF" });
    expect(kinds(bench.rows)).toEqual(["server", "category", "text", "text", "text", "category", "voice", "voice"]);
    expect(bench.counts).toEqual({ categories: 2, channels: 5, privateChannels: 0, roles: 0, topics: 0 });
    expect(bench.hasIcon).toBe(false);
    expect(bench.notInTemplate).toEqual([...NOT_IN_TEMPLATE_REASONS]);
    expect(bench.mappedAway).toEqual([{ reason: "bitrate" }]);
  });

  it("counts private channels, topics and roles, and keeps what the import drops", () => {
    const bench = benchFromPlan(mapGuildTemplate(richTemplate()));
    expect(bench.counts).toEqual({ categories: 2, channels: 8, privateChannels: 1, roles: 2, topics: 2 });
    expect(bench.rows).toHaveLength(14);
    expect(bench.mappedAway).toEqual(
      expect.arrayContaining([
        { reason: "threads", name: "um-topico" },
        { reason: "flattenAnnouncement", name: "avisos" },
        { reason: "slowmode", name: "avisos" },
        { reason: "bitrate" },
      ]),
    );
  });

  it("says icon only when the template has one", () => {
    const template = friendsAndFamily();
    template.serialized_source_guild.icon_hash = "a".repeat(32);
    (template as Record<string, unknown>).source_guild_id = "123456789012345678";
    expect(benchFromPlan(mapGuildTemplate(template)).hasIcon).toBe(true);
  });

  it("bounds a large server to the bench and names what the +N line hides", () => {
    const template = friendsAndFamily();
    const guild = template.serialized_source_guild;
    for (let i = 0; i < 30; i++) guild.channels.push(channel(100 + i, 0, `canal-${i}`, 1, 10 + i));
    for (let i = 0; i < 5; i++) {
      guild.roles.push({ id: 200 + i, name: `cargo-${i}`, permissions: "0", color: 0, hoist: false, mentionable: false });
    }
    const plan = mapGuildTemplate(template);
    const all = sidebarRows(plan);
    const bench = benchFromPlan(plan);

    expect(bench.rows).toHaveLength(1 + BENCH_SLOTS);
    const more = bench.rows[bench.rows.length - 1];
    expect(more.kind).toBe("more");
    if (more.kind !== "more") throw new Error("unreachable");
    // 1 server row + 13 shown, the rest behind "+N".
    const shown = bench.rows.slice(1, -1);
    expect(shown).toEqual(all.slice(0, shown.length));
    expect(more.hidden).toEqual({ categories: 1, channels: 35 - 12, roles: 5 });
    expect(bench.counts).toEqual({ categories: 2, channels: 35, privateChannels: 0, roles: 5, topics: 0 });
  });
});

describe("boundRows", () => {
  const text = (name: string): BenchRow => ({ kind: "text", name });

  it("leaves a list that fits alone", () => {
    const rows = Array.from({ length: BENCH_SLOTS }, (_, i) => text(`c${i}`));
    expect(boundRows(rows)).toBe(rows);
  });

  it("never ends on a roles heading with nothing under it", () => {
    const rows: BenchRow[] = [
      ...Array.from({ length: 12 }, (_, i) => text(`c${i}`)),
      { kind: "label" },
      { kind: "role", name: "a" },
      { kind: "role", name: "b" },
    ];
    const bounded = boundRows(rows);
    expect(kinds(bounded)).toEqual([...Array(12).fill("text"), "more"]);
    expect(bounded[12]).toEqual({ kind: "more", hidden: { categories: 0, channels: 0, roles: 2 } });
  });
});

describe("comesAt", () => {
  it("lights each item on its first row, or on +N, or never", () => {
    const rows: BenchRow[] = [
      { kind: "server", name: "S", initials: "S" },
      { kind: "category", name: "A" },
      { kind: "text", name: "a", topic: true },
      { kind: "voice", name: "v" },
      { kind: "more", hidden: { categories: 0, channels: 1, roles: 3 } },
    ];
    const counts = { ...countRows(rows), roles: 3, privateChannels: 0 };
    expect(comesAt(rows, counts)).toEqual({ server: 0, categories: 1, channels: 3, topics: 2, roles: 4, private: -1 });
  });
});

/* ---------------------------------------------------------- The request */

const okJson = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

describe("fetchTemplatePlan", () => {
  it("asks Discord directly, with no cookie and no referrer, and maps the answer", async () => {
    const fetchImpl = vi.fn(async () => okJson(FRIENDS_FAMILY_TEMPLATE));
    const outcome = await fetchTemplatePlan("hgM48av5Q69A", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://discord.com/api/v10/guilds/templates/hgM48av5Q69A");
    expect(init).toMatchObject({ method: "GET", credentials: "omit", referrerPolicy: "no-referrer" });
    expect(init.headers).toEqual({ Accept: "application/json" });
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") expect(outcome.plan.serverName).toBe("Friends & Family");
  });

  it("never builds a URL from something that is not a code", async () => {
    const fetchImpl = vi.fn();
    expect(await fetchTemplatePlan("../../users/@me", { fetchImpl })).toEqual({ status: "failed", reason: "unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [404, "notFound"],
    [429, "rateLimited"],
    [500, "unavailable"],
    [403, "unavailable"],
  ] as const)("maps status %i to %s", async (status, reason) => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status }));
    expect(await fetchTemplatePlan("hgM48av5Q69A", { fetchImpl })).toEqual({ status: "failed", reason });
  });

  it("refuses a body over the server's cap, by header or by bytes read", async () => {
    const big = "x".repeat(TEMPLATE_MAX_BYTES + 1);
    const declared = vi.fn(
      async () => new Response("{}", { status: 200, headers: { "content-length": String(TEMPLATE_MAX_BYTES + 1) } }),
    );
    expect(await fetchTemplatePlan("hgM48av5Q69A", { fetchImpl: declared })).toEqual({ status: "failed", reason: "tooLarge" });
    const streamed = vi.fn(async () => new Response(big, { status: 200 }));
    expect(await fetchTemplatePlan("hgM48av5Q69A", { fetchImpl: streamed })).toEqual({ status: "failed", reason: "tooLarge" });
  });

  it("reads garbage or a wrong shape as unavailable", async () => {
    const garbage = vi.fn(async () => new Response("<html>nope</html>", { status: 200 }));
    expect(await fetchTemplatePlan("hgM48av5Q69A", { fetchImpl: garbage })).toEqual({ status: "failed", reason: "unavailable" });
    const shape = vi.fn(async () => okJson({ hello: "world" }));
    expect(await fetchTemplatePlan("hgM48av5Q69A", { fetchImpl: shape })).toEqual({ status: "failed", reason: "unavailable" });
  });

  it("reads a server over the import's caps as too many", async () => {
    const template = friendsAndFamily();
    for (let i = 0; i <= MAX_IMPORT_CHANNELS; i++) {
      template.serialized_source_guild.channels.push(channel(1000 + i, 0, `c${i}`, null, i));
    }
    const fetchImpl = vi.fn(async () => okJson(template));
    expect(await fetchTemplatePlan("hgM48av5Q69A", { fetchImpl })).toEqual({ status: "failed", reason: "tooMany" });
  });

  it("reads a failed request (network, CORS) as offline, never as a bad link", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await fetchTemplatePlan("hgM48av5Q69A", { fetchImpl })).toEqual({ status: "offline" });
  });

  /** A fetch that only ends when its signal aborts, like a request Discord never answers. */
  const hanging = vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  );

  it("reads the timeout as offline", async () => {
    expect(await fetchTemplatePlan("hgM48av5Q69A", { fetchImpl: hanging, timeoutMs: 5 })).toEqual({ status: "offline" });
  });

  it("reads the caller's cancel as aborted", async () => {
    const controller = new AbortController();
    const pending = fetchTemplatePlan("hgM48av5Q69A", { fetchImpl: hanging, signal: controller.signal, timeoutMs: 60_000 });
    controller.abort();
    expect(await pending).toEqual({ status: "aborted" });
    const already = new AbortController();
    already.abort();
    expect(await fetchTemplatePlan("hgM48av5Q69A", { fetchImpl: hanging, signal: already.signal })).toEqual({
      status: "aborted",
    });
  });
});

describe("the mapper, on demand", () => {
  const loadSource = () => import("../../../../packages/shared/src/discord-import");
  const never = () => new Promise<Awaited<ReturnType<typeof loadSource>>>(() => {});
  const answers = () => vi.fn(async () => okJson(FRIENDS_FAMILY_TEMPLATE));

  it("starts loading with the request, before Discord has answered", async () => {
    const order: string[] = [];
    const fetchImpl = vi.fn(async () => {
      order.push("fetch");
      return okJson(FRIENDS_FAMILY_TEMPLATE);
    });
    const loadMapper = vi.fn(() => {
      order.push("mapper");
      return loadSource();
    });
    const outcome = await fetchTemplatePlan("hgM48av5Q69A", { fetchImpl, loadMapper });
    expect(order).toEqual(["mapper", "fetch"]);
    expect(loadMapper).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("ok");
  });

  it("does not load it for something that is not a code", async () => {
    const loadMapper = vi.fn(loadSource);
    await fetchTemplatePlan("../../users/@me", { fetchImpl: vi.fn(), loadMapper });
    expect(loadMapper).not.toHaveBeenCalled();
  });

  it("does not load it for a read that was cancelled before it began", async () => {
    const loadMapper = vi.fn(loadSource);
    const already = new AbortController();
    already.abort();
    await fetchTemplatePlan("hgM48av5Q69A", { fetchImpl: answers(), signal: already.signal, loadMapper });
    expect(loadMapper).not.toHaveBeenCalled();
  });

  it("reads a mapper that cannot load as offline, never as a bad link", async () => {
    const loadMapper = () => Promise.reject(new TypeError("Failed to fetch dynamically imported module"));
    expect(await fetchTemplatePlan("hgM48av5Q69A", { fetchImpl: answers(), loadMapper })).toEqual({ status: "offline" });
  });

  it("reads an empty module as offline (Vite's preload helper resolves to nothing after a reload)", async () => {
    const loadMapper = () => Promise.resolve(undefined as unknown as Awaited<ReturnType<typeof loadSource>>);
    expect(await fetchTemplatePlan("hgM48av5Q69A", { fetchImpl: answers(), loadMapper })).toEqual({ status: "offline" });
  });

  it("raises nothing unhandled when the request and the mapper both fail", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const loadMapper = () => Promise.reject(new TypeError("Failed to fetch dynamically imported module"));
    expect(await fetchTemplatePlan("hgM48av5Q69A", { fetchImpl, loadMapper })).toEqual({ status: "offline" });
    // Let a stray rejection reach the runtime, which fails the run on one.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("reads a mapper that never arrives as the timeout", async () => {
    expect(await fetchTemplatePlan("hgM48av5Q69A", { fetchImpl: answers(), loadMapper: never, timeoutMs: 20 })).toEqual({
      status: "offline",
    });
  });

  it("reads the caller's cancel during the load as aborted", async () => {
    const controller = new AbortController();
    const fetchImpl = answers();
    const pending = fetchTemplatePlan("hgM48av5Q69A", {
      fetchImpl,
      loadMapper: never,
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    // The answer is in and has had time to be read, so the read is waiting on the mapper.
    await fetchImpl.mock.results[0]?.value;
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    expect(await pending).toEqual({ status: "aborted" });
  });

  it("warms the chunk on focus without ever throwing", () => {
    expect(() => {
      prefetchTemplateMapper();
      prefetchTemplateMapper();
    }).not.toThrow();
  });
});
