import {
  discordTemplateUrl,
  isDiscordInviteLink,
  legacyTypeRank,
  parseDiscordTemplateCode,
  type DiscordImportPlan,
  type MappedAwayItem,
  type NotInTemplateReason,
} from "@pqp/shared";

/**
 * The homepage's "paste your own template" demo, without React and without
 * copy: read a Discord Guild Template straight from Discord in the visitor's
 * browser, and turn the import plan into the rows the bench in `mudanca.tsx`
 * draws.
 *
 * Why the browser reads Discord itself and never `POST /api/import/discord/preview`:
 * that route needs an account (CLAUDE.md pitfall 8), and its Discord fetch
 * budget is one per process, shared by every real import
 * (`discordFetchLimiter` in `server/src/api/index.ts`). Homepage traffic must
 * not spend it. Discord's template endpoint answers cross-origin reads today
 * (checked by hand on October 17, 2026, with `Origin: https://pqp.gg`). That is
 * undocumented, so every failure of the request itself falls back to "you
 * will see it inside pqp after sign-up" (`offline`), never to an error that
 * blames the link.
 *
 * The parser and mapper are the import's own (`@pqp/shared`), with default
 * options, so the preview drops forums and the rest exactly as production
 * does by default. `discordTemplateUrl` is the only way a URL is built: it
 * refuses anything that is not a template code. The small code parser is part
 * of the page; the mapper is loaded on demand (see "The mapper, on demand").
 */

/** How long one read may take before the fallback shows. */
export const TEMPLATE_TIMEOUT_MS = 8_000;

/** The server's own ceiling for a template body (`MAX_BODY_BYTES`, `server/src/lib/safe-fetch.ts`). */
export const TEMPLATE_MAX_BYTES = 512 * 1024;

/**
 * List rows under the server row in each sidebar. The sample server has
 * exactly this many, and a real template is padded or cut to it, so the
 * bench keeps one height whatever is pasted.
 */
export const BENCH_SLOTS = 14;

/* ------------------------------------------------------------ The paste */

export type PasteFailure = "inviteLink" | "notATemplate";

/** What a paste holds, decided before any request. */
export type PasteCheck = { ok: true; code: string } | { ok: false; reason: PasteFailure };

/** A bare code, `discord.new/CODE` or `discord.com/template/CODE`; an invite gets its own answer. */
export function checkPaste(text: string): PasteCheck {
  const code = parseDiscordTemplateCode(text);
  if (code) return { ok: true, code };
  return { ok: false, reason: isDiscordInviteLink(text) ? "inviteLink" : "notATemplate" };
}

/** The link the import dialog is pre-filled with after sign-up. */
export function templateLink(code: string): string {
  return `https://discord.new/${code}`;
}

/* ------------------------------------------------- The mapper, on demand */

/**
 * The mapper (`mapGuildTemplate`, its zod schemas and the two errors it
 * throws) costs about 3.5 KB gzip, and only a visitor who pastes a template
 * needs it. It loads on the first read, not with the page. Measured on
 * October 18, 2026: the entry chunk shrinks by 3.45 KB gzip, and the mapper
 * moves to a lazy chunk of about 8 KB gzip that holds a second copy of
 * `permissions` and `forums`.
 *
 * It is imported from the shared package's SOURCE on purpose. `@pqp/shared`
 * resolves to `dist/discord-import.js`, and the entry chunk already holds
 * that one module, because `lib/handle-intent.ts` uses
 * `parseDiscordTemplateCode` from it. A module lives in exactly one chunk,
 * and a statement that any chunk uses stays in it, so a dynamic import of
 * the same module moves nothing. The source file is a separate module for
 * the bundler: the entry keeps its small code parser, and this chunk holds
 * the mapper and its own copy of that parser. The errors must come from the
 * same copy as the mapper for `instanceof` to hold, so they are read off
 * this module too. Once `@pqp/shared` has a subpath export for the mapper,
 * the two paths below are the only lines to change.
 */
type TemplateMapper = typeof import("../../../../packages/shared/src/discord-import");

let mapperLoad: Promise<TemplateMapper> | null = null;

/**
 * Start the load, or reuse it. A failed load is forgotten, so the next read
 * tries again.
 *
 * In a production build Vite wraps this `import()` in its preload helper. When
 * the chunk is gone (a tab left open across a deploy), the helper fires
 * `vite:preloadError` first. `main.tsx` answers by reloading the page once, and
 * then the helper resolves to `undefined` instead of rethrowing. That counts
 * as a failed load here, so a read falls back to `offline` and never touches
 * an empty module.
 */
function loadTemplateMapper(): Promise<TemplateMapper> {
  mapperLoad ??= import("../../../../packages/shared/src/discord-import")
    .then((module) => {
      if (!module) throw new Error("The template mapper did not load");
      return module;
    })
    .catch((error: unknown) => {
      mapperLoad = null;
      throw error;
    });
  return mapperLoad;
}

/** Warm the mapper's chunk before a read (the field takes focus). Never throws. */
export function prefetchTemplateMapper(): void {
  loadTemplateMapper().catch(() => {});
}

/** Reject when `signal` aborts first, so a stuck chunk cannot hold a read past its timeout. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/* ---------------------------------------------------------- The request */

export type TemplateFailure = "notFound" | "rateLimited" | "unavailable" | "tooLarge" | "tooMany";

/**
 * - `ok`: the plan the import would apply.
 * - `failed`: Discord answered, and the answer names a reason.
 * - `offline`: the request itself failed (network, CORS, the timeout).
 * - `aborted`: the caller cancelled it (a newer paste, an unmount). Drop it.
 */
export type TemplateOutcome =
  | { status: "ok"; plan: DiscordImportPlan }
  | { status: "failed"; reason: TemplateFailure }
  | { status: "offline" }
  | { status: "aborted" };

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Read the body as text, or null when it is larger than `max` bytes. */
async function readCapped(response: Response, max: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    void response.body?.cancel().catch(() => {});
    return null;
  }
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text();
    return new TextEncoder().encode(text).byteLength > max ? null : text;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      void reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Fetch one template from Discord and map it. Never throws.
 *
 * The request carries no cookie and no referrer. `signal` is the caller's
 * cancel; the timeout is separate, so a cancel reads as `aborted` and a slow
 * Discord reads as `offline`.
 */
// literal-ok:begin outcome tags (`status`), not copy
export async function fetchTemplatePlan(
  code: string,
  {
    signal,
    timeoutMs = TEMPLATE_TIMEOUT_MS,
    fetchImpl = (input, init) => fetch(input, init),
    loadMapper = loadTemplateMapper,
  }: {
    signal?: AbortSignal;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
    /** The mapper's loader; a test replaces it to fail or stall the load. */
    loadMapper?: () => Promise<TemplateMapper>;
  } = {},
): Promise<TemplateOutcome> {
  if (signal?.aborted) return { status: "aborted" };
  let url: string;
  try {
    url = discordTemplateUrl(code);
  } catch {
    // Only a code that passed `checkPaste` gets here; this is the SSRF guard.
    return { status: "failed", reason: "unavailable" };
  }

  // Start the mapper's chunk now, so it loads while Discord answers. Its
  // failure is read where it is needed; this catch only keeps it from
  // surfacing as an unhandled rejection when the request fails first.
  const mapperLoading = loadMapper();
  mapperLoading.catch(() => {});

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const gone = (): TemplateOutcome => (signal?.aborted && !timedOut ? { status: "aborted" } : { status: "offline" });

  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } catch {
      return gone();
    }

    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 404) return { status: "failed", reason: "notFound" };
      if (response.status === 429) return { status: "failed", reason: "rateLimited" };
      return { status: "failed", reason: "unavailable" };
    }

    let text: string | null;
    try {
      text = await readCapped(response, TEMPLATE_MAX_BYTES);
    } catch {
      return gone();
    }
    if (text === null) return { status: "failed", reason: "tooLarge" };

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { status: "failed", reason: "unavailable" };
    }

    // A mapper that cannot load is the same as a network that cannot answer.
    let mapper: TemplateMapper | undefined;
    try {
      mapper = await untilAborted(mapperLoading, controller.signal);
    } catch {
      return gone();
    }
    if (!mapper) return gone();

    try {
      return { status: "ok", plan: mapper.mapGuildTemplate(raw) };
    } catch (error) {
      if (error instanceof mapper.DiscordImportCapError) return { status: "failed", reason: "tooMany" };
      if (error instanceof mapper.DiscordImportParseError) return { status: "failed", reason: "unavailable" };
      return { status: "failed", reason: "unavailable" };
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
// literal-ok:end

/* ------------------------------------------------------------- The rows */

export type RoleTone = "amber" | "sky" | "emerald";

/** What the "+N" line stands for, by kind. */
export interface HiddenCounts {
  categories: number;
  channels: number;
  roles: number;
}

/**
 * One line of the bench's two sidebars. The same list draws both, so "same
 * order" is true by construction. Names are display text: the sample's come
 * from the catalogue, a real template's from Discord (untrusted, rendered as
 * React text only).
 */
export type BenchRow =
  | { kind: "server"; name: string; initials: string }
  | { kind: "category"; name: string }
  | { kind: "text"; name: string; private?: boolean; topic?: boolean }
  | { kind: "voice"; name: string; private?: boolean }
  /** The "Roles" heading over the role rows. */
  | { kind: "label" }
  | { kind: "role"; name: string; tone?: RoleTone; color?: string | null }
  | { kind: "more"; hidden: HiddenCounts };

/** What the plan brings, counted. `channels` is text and voice, not categories. */
export interface BenchCounts {
  categories: number;
  channels: number;
  privateChannels: number;
  roles: number;
  topics: number;
}

export interface TemplateBench {
  /** Index 0 is the server row; then at most `BENCH_SLOTS` list rows. */
  rows: BenchRow[];
  counts: BenchCounts;
  hasIcon: boolean;
  notInTemplate: NotInTemplateReason[];
  mappedAway: MappedAwayItem[];
}

const STARTS_WITH_LETTER = /^[\p{L}\p{N}]/u;

/**
 * Two letters for a server with no picture: the first letters of the first
 * two words ("A Mesa" is AM), or the first two of a one-word name. Words that
 * start with a symbol or an emoji are skipped, and `Array.from` keeps an
 * emoji or an accented letter whole.
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => STARTS_WITH_LETTER.test(word));
  if (words.length >= 2) return words.slice(0, 2).map((word) => Array.from(word)[0]).join("").toUpperCase();
  const source = words[0] ?? name.trim();
  return Array.from(source).slice(0, 2).join("").toUpperCase();
}

type PlanChannel = DiscordImportPlan["channels"][number];

const byPosition = (a: PlanChannel, b: PlanChannel) => a.position - b.position || a.templateId - b.templateId;

function channelRow(channel: PlanChannel): BenchRow {
  if (channel.type === "voice") return { kind: "voice", name: channel.name, private: channel.isPrivate };
  // A forum is flattened to text by default; drawn as text either way.
  return { kind: "text", name: channel.name, private: channel.isPrivate, topic: channel.topic != null };
}

/**
 * The plan in sidebar order, the way the import dialog draws it
 * (`components/layout/discord-import-preview.tsx`): channels in no category
 * first (text before voice, then Discord's position), then each category
 * followed by its own channels, then the roles. `plan.channels` itself is in
 * apply order (categories first), which is not what a sidebar shows.
 */
export function sidebarRows(plan: DiscordImportPlan): BenchRow[] {
  const categories = plan.channels.filter((c) => c.type === "category").sort(byPosition);
  const loose = plan.channels
    .filter((c) => c.type !== "category" && c.parentTemplateId == null)
    .sort((a, b) => legacyTypeRank(a.type) - legacyTypeRank(b.type) || byPosition(a, b));
  const rows: BenchRow[] = loose.map(channelRow);
  for (const category of categories) {
    rows.push({ kind: "category", name: category.name });
    rows.push(
      ...plan.channels
        .filter((c) => c.type !== "category" && c.parentTemplateId === category.templateId)
        .sort(byPosition)
        .map(channelRow),
    );
  }
  if (plan.roles.length > 0) {
    rows.push({ kind: "label" });
    rows.push(...plan.roles.map((role): BenchRow => ({ kind: "role", name: role.name, color: role.color })));
  }
  return rows;
}

function hiddenOf(rows: BenchRow[]): HiddenCounts {
  const hidden: HiddenCounts = { categories: 0, channels: 0, roles: 0 };
  for (const row of rows) {
    if (row.kind === "category") hidden.categories += 1;
    else if (row.kind === "text" || row.kind === "voice") hidden.channels += 1;
    else if (row.kind === "role") hidden.roles += 1;
  }
  return hidden;
}

/**
 * Cut a list to `slots` rows. Past the limit, the last slot becomes a "+N"
 * line that names what it hides, and a "Roles" heading never ends the list
 * with nothing under it.
 */
export function boundRows(rows: BenchRow[], slots = BENCH_SLOTS): BenchRow[] {
  if (rows.length <= slots) return rows;
  const visible = rows.slice(0, slots - 1);
  if (visible[visible.length - 1]?.kind === "label") visible.pop();
  return [...visible, { kind: "more", hidden: hiddenOf(rows.slice(visible.length)) }];
}

/** Counts from a row list (the sample, which has no plan). */
export function countRows(rows: BenchRow[]): BenchCounts {
  const counts: BenchCounts = { categories: 0, channels: 0, privateChannels: 0, roles: 0, topics: 0 };
  for (const row of rows) {
    if (row.kind === "category") counts.categories += 1;
    if (row.kind === "text" || row.kind === "voice") {
      counts.channels += 1;
      if (row.private) counts.privateChannels += 1;
    }
    if (row.kind === "text" && row.topic) counts.topics += 1;
    if (row.kind === "role") counts.roles += 1;
  }
  return counts;
}

/** The plan as the bench draws it: the server row, then the bounded sidebar. */
export function benchFromPlan(plan: DiscordImportPlan, slots = BENCH_SLOTS): TemplateBench {
  const channels = plan.channels.filter((c) => c.type !== "category");
  return {
    rows: [
      { kind: "server", name: plan.serverName, initials: initialsOf(plan.serverName) },
      ...boundRows(sidebarRows(plan), slots),
    ],
    counts: {
      categories: plan.channels.length - channels.length,
      channels: channels.length,
      privateChannels: channels.filter((c) => c.isPrivate).length,
      roles: plan.roles.length,
      topics: channels.filter((c) => c.topic != null).length,
    },
    hasIcon: plan.iconUrl != null,
    notInTemplate: [...plan.notInTemplate],
    mappedAway: [...plan.mappedAway],
  };
}

/** The "Comes along" items, in the order the list shows them. */
export type ComesItem = "server" | "categories" | "channels" | "topics" | "roles" | "private";

/**
 * The row whose arrival lights each "Comes along" item: the first row of its
 * kind, or the "+N" line when the kind is only past the cut, or -1 when the
 * template has none (the item never lights).
 */
export function comesAt(rows: BenchRow[], counts: BenchCounts): Record<ComesItem, number> {
  const more = rows.findIndex((r) => r.kind === "more");
  const first = (match: (row: BenchRow) => boolean, count: number) => {
    if (count === 0) return -1;
    const at = rows.findIndex(match);
    return at >= 0 ? at : more;
  };
  const voice = rows.findIndex((r) => r.kind === "voice");
  return {
    server: 0,
    categories: first((r) => r.kind === "category", counts.categories),
    // The item says "text and voice", so it lights when a voice row lands.
    channels:
      counts.channels === 0 ? -1 : voice >= 0 ? voice : first((r) => r.kind === "text", counts.channels),
    topics: first((r) => r.kind === "text" && Boolean(r.topic), counts.topics),
    roles: first((r) => r.kind === "role", counts.roles),
    private: first((r) => (r.kind === "text" || r.kind === "voice") && Boolean(r.private), counts.privateChannels),
  };
}
