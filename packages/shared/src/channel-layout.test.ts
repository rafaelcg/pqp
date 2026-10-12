import { describe, expect, it } from "vitest";
import {
  applyLayoutToChannels,
  buildSidebarLayout,
  defaultCategoryName,
  layoutToPayload,
  moveInLayout,
  navigableIds,
  stepInLayout,
  type LayoutChannel,
  type LayoutTarget,
  type SidebarLayout,
} from "./channel-layout.js";
import {
  categoryNameSchema,
  channelLayoutSchema,
  channelNameIssue,
  createChannelSchema,
  updateChannelSchema,
} from "./api.js";

/**
 * The same JSON the iOS and Android ports run. A case that fails here and
 * passes on a phone (or the reverse) is the drift this file exists to catch.
 */
// A variable specifier on purpose: this package has no Node types and its
// rootDir is `src`, so the JSON is loaded at run time rather than typed in.
const FIXTURE = "../fixtures/channel-layout-cases.json";

interface ExpectedLayout {
  loose: string[];
  categories: Array<{ id: string; children: string[] }>;
}

interface Fixture {
  servers: Record<string, LayoutChannel[]>;
  build: Array<{
    name: string;
    server: string;
    mixed: boolean;
    hideWatchParty: boolean;
    expect: ExpectedLayout;
  }>;
  move: Array<{
    name: string;
    server: string;
    id: string;
    to: LayoutTarget;
    expect: ExpectedLayout | null;
  }>;
  step: Array<{
    name: string;
    server: string;
    id: string;
    direction: -1 | 1;
    target: LayoutTarget | null;
    expect: ExpectedLayout | null;
  }>;
  payload: Array<{
    name: string;
    server: string;
    mixed: boolean;
    hideWatchParty: boolean;
    baseVersion: number;
    expect: unknown;
  }>;
}

const fixture = (
  (await import(/* @vite-ignore */ FIXTURE, { with: { type: "json" } })) as { default: Fixture }
).default;

function ids(layout: SidebarLayout): ExpectedLayout {
  return {
    loose: layout.loose.map((channel) => channel.id),
    categories: layout.categories.map((entry) => ({
      id: entry.category.id,
      children: entry.children.map((channel) => channel.id),
    })),
  };
}

function base(server: string): SidebarLayout {
  return buildSidebarLayout(fixture.servers[server]!, { mixed: true, hideWatchParty: false });
}

describe("channel-layout fixture: build", () => {
  it.each(fixture.build)("$name", (testCase) => {
    const layout = buildSidebarLayout(fixture.servers[testCase.server]!, {
      mixed: testCase.mixed,
      hideWatchParty: testCase.hideWatchParty,
    });
    expect(ids(layout)).toEqual(testCase.expect);
  });
});

describe("channel-layout fixture: move", () => {
  it.each(fixture.move)("$name", (testCase) => {
    const before = base(testCase.server);
    const snapshot = JSON.stringify(ids(before));
    const next = moveInLayout(before, testCase.id, testCase.to);
    expect(next ? ids(next) : null).toEqual(testCase.expect);
    // Pure: the input layout is never mutated.
    expect(JSON.stringify(ids(before))).toBe(snapshot);
  });
});

describe("channel-layout fixture: step", () => {
  it.each(fixture.step)("$name", (testCase) => {
    const result = stepInLayout(base(testCase.server), testCase.id, testCase.direction);
    expect(result ? result.target : null).toEqual(testCase.target);
    expect(result ? ids(result.layout) : null).toEqual(testCase.expect);
  });
});

describe("channel-layout fixture: payload", () => {
  it.each(fixture.payload)("$name", (testCase) => {
    const layout = buildSidebarLayout(fixture.servers[testCase.server]!, {
      mixed: testCase.mixed,
      hideWatchParty: testCase.hideWatchParty,
    });
    expect(layoutToPayload(layout, testCase.baseVersion)).toEqual(testCase.expect);
  });
});

describe("applyLayoutToChannels", () => {
  it("rebuilds to the layout it was given, so an optimistic update draws what was dropped", () => {
    const channels = fixture.servers.guris!;
    const moved = moveInLayout(base("guris"), "v-lobby", { parentId: "cat-jogos", index: 1 })!;
    const rewritten = applyLayoutToChannels(channels, moved);
    expect(ids(buildSidebarLayout(rewritten, { mixed: true }))).toEqual(ids(moved));
    // The thread row is not in the layout and comes back untouched.
    expect(rewritten.find((channel) => channel.id === "th-1")).toEqual(
      channels.find((channel) => channel.id === "th-1"),
    );
  });
});

describe("navigableIds", () => {
  it("reads loose, then each category, and keeps only the pinned rows of a collapsed one", () => {
    const layout = base("guris");
    expect(navigableIds(layout)).toEqual([
      "t-avisos",
      "v-afk",
      "w-filme",
      "t-regras",
      "t-general",
      "v-lobby",
      "f-duvidas",
      "t-clipes",
      "v-squad",
      "t-lfg",
    ]);
    expect(
      navigableIds(layout, {
        collapsedCategoryIds: new Set(["cat-jogos"]),
        keepVisible: new Set(["v-squad"]),
      }),
    ).toEqual(["t-avisos", "v-afk", "w-filme", "t-regras", "t-general", "v-lobby", "f-duvidas", "v-squad"]);
  });
});

describe("names", () => {
  it("names the default category from the creator's locale", () => {
    expect(defaultCategoryName("pt-BR")).toBe("Canais");
    expect(defaultCategoryName("en")).toBe("Channels");
    expect(defaultCategoryName("es")).toBe("Canales");
    expect(defaultCategoryName(undefined)).toBe("Canais");
  });

  it("lets a category have spaces and accents, and keeps the slug rule for channels", () => {
    expect(channelNameIssue("category", "Salas de voz")).toBeNull();
    expect(channelNameIssue("category", "Jogos & Música 🎮")).toBeNull();
    expect(channelNameIssue("category", "a".repeat(33))).not.toBeNull();
    expect(channelNameIssue("category", "linha\nquebrada")).not.toBeNull();
    expect(channelNameIssue("text", "Salas de voz")).not.toBeNull();
    expect(channelNameIssue("voice", "salas-de-voz")).toBeNull();
    expect(categoryNameSchema.parse("  Cinema  ")).toBe("Cinema");
  });

  it("create accepts a spaced category and trims it, and still refuses a spaced text channel", () => {
    const category = createChannelSchema.parse({ name: " Salas de voz ", type: "category" });
    expect(category.name).toBe("Salas de voz");
    expect(createChannelSchema.safeParse({ name: "Salas de voz", type: "text" }).success).toBe(false);
  });

  it("create keeps absent and null parentId apart (the legacy-create rule reads the difference)", () => {
    const absent = createChannelSchema.parse({ name: "a", type: "text" });
    const loose = createChannelSchema.parse({ name: "a", type: "text", parentId: null });
    expect("parentId" in absent && absent.parentId !== undefined).toBe(false);
    expect(loose.parentId).toBeNull();
    expect(
      createChannelSchema.safeParse({
        name: "c",
        type: "category",
        parentId: "00000000-0000-4000-8000-000000000001",
      }).success,
    ).toBe(false);
  });

  it("rename takes any name up to 100 and leaves the per-type rule to the route", () => {
    expect(updateChannelSchema.safeParse({ name: "Salas de voz" }).success).toBe(true);
    expect(updateChannelSchema.safeParse({ name: "a".repeat(101) }).success).toBe(false);
  });
});

describe("channelLayoutSchema", () => {
  it("parses the payload the layout functions build once ids are uuids", () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const body = {
      baseVersion: 3,
      categoryIds: [uuid(1)],
      groups: [
        { parentId: null, channelIds: [uuid(2)] },
        { parentId: uuid(1), channelIds: [uuid(3)] },
      ],
    };
    expect(channelLayoutSchema.parse(body)).toEqual(body);
    expect(channelLayoutSchema.safeParse({ ...body, baseVersion: -1 }).success).toBe(false);
  });
});
