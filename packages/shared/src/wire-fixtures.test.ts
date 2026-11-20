import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as z3 from "zod/v3";
import * as signaling from "./signaling.js";
import * as soundboard from "./soundboard.js";

/**
 * The wire-contract fixtures (`fixtures/wire/`) and the generators that write
 * them (`scripts/gen-proto-vectors.mjs`, `scripts/gen-constraints.mjs`). Step A1
 * of docs/plans/RUST.md. The shipped zod schemas stay the only source of truth;
 * every client replays vectors generated from them.
 *
 * What these tests are for is the failure the zod 3 generators had on zod 4: a
 * green run that proved nothing. They matched no node, wrote "0 value rules over
 * 0 arms", and exited 0. Each block below pins one way a generator or a fixture
 * can go quietly empty, stale or machine-dependent.
 */

// This package has no Node types and its rootDir is `src` (see
// `channel-layout.test.ts`), so Node's modules are reached through variable
// specifiers and a minimal local type. The generators are plain `.mjs` run by
// `node` (they must not be compiled into `dist`), so they are loaded at run time
// too and typed loosely.
interface NodeApi {
  readFileSync(file: URL, encoding: "utf8"): string;
  execFileSync(file: string, args: string[], options: { encoding: "utf8"; timeout: number }): string;
  fileURLToPath(url: URL): string;
  execPath: string;
}
const nodeModule = async (name: string): Promise<Record<string, unknown>> =>
  (await import(/* @vite-ignore */ name)) as Record<string, unknown>;
const node = {
  ...(await nodeModule("node:fs")),
  ...(await nodeModule("node:child_process")),
  ...(await nodeModule("node:url")),
  execPath: ((await nodeModule("node:process")).execPath ?? "") as string,
} as unknown as NodeApi;
const here = import.meta as unknown as { url: string };

const load = (name: string): Promise<any> =>
  import(/* @vite-ignore */ new URL(`../scripts/${name}`, here.url).href);
const walk = await load("zod4-walk.mjs");
const protoGen = await load("gen-proto-vectors.mjs");
const constraintsGen = await load("gen-constraints.mjs");

const fixtureUrl = (name: string) => new URL(`../fixtures/wire/${name}`, here.url);
const readFixture = (name: string): any => JSON.parse(node.readFileSync(fixtureUrl(name), "utf8"));
const committedProto = readFixture("proto-vectors.json");
const committedConstraints = readFixture("constraints.json");

/** Round-trip through JSON: what is compared is what a file would hold. */
const asFile = (value: unknown): any => JSON.parse(JSON.stringify(value));

const unions = {
  client: signaling.voiceClientMessageSchema,
  server: signaling.voiceSignalingMessageSchema,
} as const;
const armTypes = (union: unknown): string[] =>
  walk.discriminatedArms(union, "union").map((arm: { type: string }) => arm.type);

/**
 * The committed floor. Counts can only go up while the protocol grows; a drop
 * means a generator read less than it used to (a walk that matches nothing is
 * the case this exists for) or a rule was removed from the schema on purpose,
 * in which case lowering the number here is the deliberate, reviewed act.
 */
const FLOOR = {
  clientArms: 19,
  serverArms: 30,
  clientVectors: 25,
  serverVectors: 47,
  valueRules: 295,
  armsWithRules: 32,
  provedViolations: 345,
  urlCases: 16,
  guidCases: 15,
  refinementCases: 29,
} as const;
/** Rules a generator could not prove with a violation. Zero today, and a rule
 *  that cannot be proved is a rule nobody has shown to bite. */
const UNPROVED_CEILING = 0;

describe("the generators read something, and no less than the committed floor", () => {
  it("proto vectors: every arm of both unions, at least the floor", () => {
    expect(committedProto.client.types).toHaveLength(FLOOR.clientArms);
    expect(committedProto.server.types.length).toBeGreaterThanOrEqual(FLOOR.serverArms);
    expect(committedProto.client.vectors.length).toBeGreaterThanOrEqual(FLOOR.clientVectors);
    expect(committedProto.server.vectors.length).toBeGreaterThanOrEqual(FLOOR.serverVectors);
    const fresh = protoGen.generateProtoVectors(signaling);
    expect(fresh.client.types.length).toBeGreaterThanOrEqual(FLOOR.clientArms);
    expect(fresh.server.types.length).toBeGreaterThanOrEqual(FLOOR.serverArms);
    expect(fresh.client.vectors.length).toBeGreaterThanOrEqual(FLOOR.clientVectors);
    expect(fresh.server.vectors.length).toBeGreaterThanOrEqual(FLOOR.serverVectors);
  });

  it("constraints: rules, arms with rules and proved violations, at least the floor", () => {
    const fresh = constraintsGen.generateConstraints({ sig: signaling, soundboard });
    const armsWithRules = (f: any) => Object.keys(f.rules.client).length + Object.keys(f.rules.server).length;
    for (const fixture of [committedConstraints, fresh]) {
      expect(fixture.counts.rules).toBeGreaterThan(0);
      expect(fixture.counts.rules).toBeGreaterThanOrEqual(FLOOR.valueRules);
      expect(armsWithRules(fixture)).toBeGreaterThanOrEqual(FLOOR.armsWithRules);
      expect(fixture.counts.violations).toBeGreaterThanOrEqual(FLOOR.provedViolations);
      expect(fixture.formatCases.url.length).toBeGreaterThanOrEqual(FLOOR.urlCases);
      expect(fixture.formatCases.guid.length).toBeGreaterThanOrEqual(FLOOR.guidCases);
      const pinned = Object.values<any[]>(fixture.refinements).reduce((n, cases) => n + cases.length, 0);
      expect(pinned).toBeGreaterThanOrEqual(FLOOR.refinementCases);
      expect(fixture.counts.skipped).toBeLessThanOrEqual(UNPROVED_CEILING);
    }
  });

  it("the stated counts are the real counts", () => {
    const rules = Object.values<any>(committedConstraints.rules).flatMap((byType: any) => Object.values<any>(byType))
      .flat().reduce((n: number, row: any) => n + row.rules.length, 0);
    expect(committedConstraints.counts).toEqual({
      rules,
      violations: committedConstraints.violations.length,
      skipped: committedConstraints.skipped.length,
    });
  });

  it("the constraints generator refuses to write an empty table", () => {
    // A schema with no value rule anywhere: what a walk that reads nothing sees.
    const bare = z.discriminatedUnion("type", [z.object({ type: z.literal("only") })]);
    const sig = { voiceClientMessageSchema: bare, voiceSignalingMessageSchema: bare };
    const examples = { client: { only: { type: "only" } }, server: { only: { type: "only" } } };
    const protoVectors = protoGen.generateProtoVectors(sig, examples);
    expect(() => constraintsGen.generateConstraints({ sig, soundboard, protoVectors })).toThrow(
      /no value rules/,
    );
  });
});

describe("every arm has a vector", () => {
  for (const [name, union] of Object.entries(unions)) {
    it(`${name}: every arm of the schema has at least one committed vector`, () => {
      const seen = new Set(committedProto[name].vectors.map((v: any) => v.type));
      const missing = armTypes(union).filter((type) => !seen.has(type));
      expect(missing).toEqual([]);
      // and the fixture's own list of arms is the schema's, in order
      expect(committedProto[name].types).toEqual(armTypes(union));
      // no vector for an arm the schema no longer has
      expect([...seen].filter((type) => !armTypes(union).includes(type as string))).toEqual([]);
    });
  }

  it("the generator throws when an arm has no example, and when one is stale", () => {
    const { clientExamples, serverExamples, buildVectors } = protoGen;
    const withoutWatchLive = { ...clientExamples };
    delete withoutWatchLive["watch-live"];
    expect(() => buildVectors(unions.client, withoutWatchLive, "client")).toThrow(/no example for watch-live/);
    expect(() => buildVectors(unions.server, { ...serverExamples, "removed-arm": { type: "removed-arm" } }, "server"))
      .toThrow(/removed type removed-arm/);
    expect(() => buildVectors(unions.client, { ...clientExamples, "voice-still-here": [] }, "client"))
      .toThrow(/empty example list/);
  });

  it("an example zod refuses stops the generator", () => {
    const { clientExamples, buildVectors } = protoGen;
    const broken = { ...clientExamples, "call-ring": { type: "call-ring", conversationId: "not-a-guid" } };
    expect(() => buildVectors(unions.client, broken, "client")).toThrow(/rejected by zod/);
  });

  it("a nullable object is seen both filled and null, and one alone is refused", () => {
    for (const [name, union] of Object.entries(unions)) {
      for (const { type, schema } of walk.discriminatedArms(union, name)) {
        for (const key of protoGen.nullableObjectFields(schema)) {
          const mine = committedProto[name].vectors.filter((v: any) => v.type === type);
          expect(mine.some((v: any) => v.canonical[key] === null), `${name}/${type}.${key} has no null example`).toBe(true);
          expect(mine.some((v: any) => v.canonical[key] != null), `${name}/${type}.${key} has no filled example`).toBe(true);
        }
      }
    }
    const { clientExamples, buildVectors } = protoGen;
    const onlyFilled = { ...clientExamples, "set-watch-party": [clientExamples["set-watch-party"][0]] };
    expect(() => buildVectors(unions.client, onlyFilled, "client")).toThrow(/thin, needs both null and filled for set-watch-party\.state/);
  });

  it("canonical forms keep optional apart from nullable, and write state apart from read state", () => {
    const peerJoined = committedProto.server.vectors.find((v: any) => v.label === "peer-joined#1");
    // `cameraStreamId` is nullable().optional(): absent reads as null.
    expect(peerJoined.input.peer).not.toHaveProperty("cameraStreamId");
    expect(peerJoined.canonical.peer.cameraStreamId).toBeNull();
    // `canSpeak` is optional() alone: absent stays absent.
    expect(peerJoined.canonical.peer).not.toHaveProperty("canSpeak");
    // `set-music` (write) leaves `repeat` out when it was not sent; `music` (read) fills it.
    const write = committedProto.client.vectors.find((v: any) => v.label === "set-music#2");
    const read = committedProto.server.vectors.find((v: any) => v.label === "music#2");
    expect(write.canonical.state).not.toHaveProperty("repeat");
    expect(write.canonical.state).not.toHaveProperty("skipVotes");
    expect(read.canonical.state.repeat).toBeDefined();
    expect(read.canonical.state.skipVotes).toEqual([]);
  });

  it("every committed vector is accepted by zod and its canonical form is what zod makes of it", () => {
    for (const [name, union] of Object.entries(unions)) {
      const byType = new Map(walk.discriminatedArms(union, name).map((a: any) => [a.type, a.schema]));
      for (const vector of committedProto[name].vectors) {
        const parsed = (byType.get(vector.type) as z.ZodType).safeParse(vector.input);
        expect(parsed.success, `${name}/${vector.label} no longer parses`).toBe(true);
        expect(asFile(protoGen.canon(byType.get(vector.type), (parsed as any).data))).toEqual(vector.canonical);
      }
    }
  });
});

describe("every value rule is proved by a frame zod refuses", () => {
  const ruleId = constraintsGen.describeRule;

  it("each rule row has a violation, and each violation is still refused at the blamed path", () => {
    const proved = new Set(
      committedConstraints.violations.map((v: any) => `${v.union}|${v.type}|${v.path}|${v.rule}`),
    );
    const unproved: string[] = [];
    for (const [unionName, byType] of Object.entries<any>(committedConstraints.rules)) {
      for (const [type, rows] of Object.entries<any[]>(byType)) {
        for (const row of rows) {
          for (const rule of row.rules) {
            if (!proved.has(`${unionName}|${type}|${row.path}|${ruleId(rule)}`)) {
              unproved.push(`${unionName}/${type} ${row.path} ${ruleId(rule)}`);
            }
          }
        }
      }
    }
    expect(unproved).toEqual([]);

    for (const violation of committedConstraints.violations) {
      const union = (unions as any)[violation.union] as z.ZodType;
      const parsed = union.safeParse(violation.frame);
      expect(parsed.success, `${violation.union}/${violation.type} ${violation.path} ${violation.rule}: accepted`).toBe(false);
      const blamed = (parsed as any).error.issues.map((issue: any) =>
        issue.path.reduce((acc: string, seg: string | number) =>
          typeof seg === "number" ? `${acc}[${seg}]` : acc ? `${acc}.${seg}` : seg, ""));
      for (const path of violation.zodPaths) expect(blamed).toContain(path);
    }
  });

  it("an array bound is a count and an element bound a length: skipVotes", () => {
    const rows = committedConstraints.rules.client["set-music"];
    const at = (path: string) => rows.find((row: any) => row.path === path)?.rules.map(ruleId);
    expect(at("state.skipVotes")).toEqual(["maxItems"]);
    expect(at("state.skipVotes[]")).toEqual(["minLen", "maxLen"]);
  });

  it(".url() is new URL(), which accepts data: and javascript:", () => {
    const verdict = (value: string) => committedConstraints.formatCases.url.find((c: any) => c.value === value)?.ok;
    expect(verdict("https://i.ytimg.com/vi/x/hq.jpg")).toBe(true);
    expect(verdict("javascript:alert(1)")).toBe(true);
    expect(verdict("data:text/plain,hi")).toBe(true);
    expect(verdict("not a url")).toBe(false);
  });

  it(".guid() ignores version and variant nibbles", () => {
    const verdict = (value: string) => committedConstraints.formatCases.guid.find((c: any) => c.value === value)?.ok;
    expect(verdict("11111111-1111-1111-1111-111111111111")).toBe(true);
    expect(verdict("00000000-0000-0000-0000-000000000000")).toBe(true);
    expect(verdict("11111111111141118111111111111111")).toBe(false);
  });

  it(".refine is identified by behaviour, and pinned both ways", () => {
    const pinned = committedConstraints.refinements.isSoundboardSoundId;
    expect(pinned.some((c: any) => c.ok)).toBe(true);
    expect(pinned.some((c: any) => !c.ok)).toBe(true);
    const names = Object.values<any>(committedConstraints.rules).flatMap((byType: any) => Object.values<any[]>(byType))
      .flat().flatMap((row: any) => row.rules).filter((rule: any) => rule.k === "refine").map((rule: any) => rule.name);
    expect(new Set(names)).toEqual(new Set(["isSoundboardSoundId"]));
  });
});

describe("an unrecognised zod node or check throws, it is never skipped", () => {
  const arm = (shape: Record<string, z.ZodType>) => z.object({ type: z.literal("t"), ...shape });
  const collect = (schema: z.ZodType) => {
    constraintsGen.collect(schema, "", [], () => "isSoundboardSoundId");
  };

  const nodes: [string, z.ZodType][] = [
    ["record", z.record(z.string(), z.string())],
    ["tuple", z.tuple([z.string(), z.number()])],
    ["pipe", z.string().pipe(z.string())],
    ["transform", z.string().transform((s) => s.length)],
    ["lazy", z.lazy(() => z.string())],
    ["any", z.any()],
    ["unknown", z.unknown()],
    ["null", z.null()],
    ["date", z.date()],
    ["bigint", z.bigint()],
    ["map", z.map(z.string(), z.string())],
    ["set", z.set(z.string())],
    ["intersection", z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() }))],
    ["readonly", z.string().readonly()],
    ["catch", z.string().catch("x")],
    ["nonoptional", z.string().optional().nonoptional()],
  ];
  for (const [name, node] of nodes) {
    it(`node type: ${name}`, () => {
      expect(() => collect(arm({ field: node }))).toThrow(walk.UnrecognisedZodNode);
      expect(() => collect(arm({ field: node.optional() }))).toThrow(walk.UnrecognisedZodNode);
      expect(() => collect(arm({ inner: z.array(node) }))).toThrow(walk.UnrecognisedZodNode);
    });
  }

  it("the message names the node and where it is", () => {
    expect(() => collect(arm({ state: z.object({ bag: z.record(z.string(), z.string()) }) })))
      .toThrow(/"record" at state\.bag/);
  });

  it("an object with a catchall (strict, passthrough) throws", () => {
    expect(() => collect(arm({ nested: z.object({ a: z.string() }).strict() }))).toThrow(walk.UnrecognisedZodNode);
    expect(() => collect(arm({ nested: z.looseObject({ a: z.string() }) }))).toThrow(walk.UnrecognisedZodNode);
  });

  const checks: [string, z.ZodType][] = [
    ["regex", z.string().regex(/^a+$/)],
    ["email", z.string().email()],
    ["uuid", z.string().uuid()],
    ["startsWith", z.string().startsWith("a")],
    ["trim (overwrite)", z.string().trim()],
    ["multipleOf", z.number().multipleOf(5)],
    ["int32", z.int32()],
    ["superRefine", z.string().superRefine(() => {})],
    ["url with a protocol", z.string().url({ protocol: /^https$/ })],
    ["email as its own node", z.email()],
    ["uuid as its own node", z.uuid()],
    ["coerced number", z.coerce.number()],
  ];
  for (const [name, node] of checks) {
    it(`check: ${name}`, () => {
      expect(() => collect(arm({ field: node }))).toThrow(walk.UnrecognisedZodNode);
    });
  }

  it("a format built as its own node is a rule, not a plain string", () => {
    // zod 4 keeps `z.guid()` / `z.url()` / `z.int()` on the node's own def, not
    // in `checks`; reading only `checks` would see an unconstrained string.
    const rowsFor = (node: z.ZodType) => {
      const rows: { path: string }[] = [];
      constraintsGen.collect(arm({ field: node }), "", rows, () => "isSoundboardSoundId");
      return rows.filter((row) => row.path !== "type");
    };
    expect(rowsFor(z.guid())).toEqual([{ path: "field", rules: [{ k: "guid" }] }]);
    expect(rowsFor(z.url())).toEqual([{ path: "field", rules: [{ k: "url" }] }]);
    expect(rowsFor(z.int())).toEqual([{ path: "field", rules: [{ k: "safeint" }] }]);
    expect(rowsFor(z.string().guid())).toEqual(rowsFor(z.guid()));
    expect(rowsFor(z.number().int())).toEqual(rowsFor(z.int()));
  });

  it("a .refine no exported predicate agrees with is an error, not a guess", () => {
    const sig = {
      voiceClientMessageSchema: z.discriminatedUnion("type", [
        z.object({ type: z.literal("t"), field: z.string().refine((s) => s.length === 7) }),
      ]),
      voiceSignalingMessageSchema: unions.server,
    };
    const protoVectors = protoGen.generateProtoVectors(sig, {
      client: { t: { type: "t", field: "1234567" } },
      server: protoGen.serverExamples,
    });
    expect(() => constraintsGen.generateConstraints({ sig, soundboard, protoVectors }))
      .toThrow(/unrecognised \.refine/);
  });

  it("a zod 3 schema is refused loudly instead of reading as empty", () => {
    const old = z3.object({ type: z3.literal("t"), n: z3.number().max(3) });
    expect(() => collect(old as unknown as z.ZodType)).toThrow(/not a zod 4 schema/);
    const sig = { voiceClientMessageSchema: z3.discriminatedUnion("type", [old]), voiceSignalingMessageSchema: unions.server };
    expect(() => protoGen.generateProtoVectors(sig)).toThrow(walk.UnrecognisedZodNode);
  });

  it("a canonical form for a union nested in a frame is not guessed", () => {
    const nested = arm({ pick: z.union([z.string(), z.number()]) });
    expect(() => protoGen.canon(nested, { type: "t", pick: 1 })).toThrow(walk.UnrecognisedZodNode);
  });
});

describe("a committed fixture is what the schemas say today", () => {
  it("proto-vectors.json equals a fresh in-memory regeneration", () => {
    expect(committedProto, "run `pnpm fixtures:wire` and commit the result").toEqual(
      asFile(protoGen.generateProtoVectors(signaling)),
    );
  });

  it("constraints.json equals a fresh in-memory regeneration", () => {
    expect(committedConstraints, "run `pnpm fixtures:wire` and commit the result").toEqual(
      asFile(constraintsGen.generateConstraints({ sig: signaling, soundboard })),
    );
  });

  it("the bytes on disk are the generator's serialisation (no hand edits, no stray whitespace)", () => {
    for (const [name, value] of [
      ["proto-vectors.json", committedProto],
      ["constraints.json", committedConstraints],
    ] as const) {
      const text = node.readFileSync(fixtureUrl(name), "utf8");
      expect(text).toBe(`${JSON.stringify(value, null, 2)}\n`);
    }
  });

  it("the regenerate scripts run under plain node and agree (`--check`)", () => {
    const script = (name: string) => node.fileURLToPath(new URL(`../scripts/${name}`, here.url));
    for (const name of ["gen-proto-vectors.mjs", "gen-constraints.mjs"]) {
      const out = node.execFileSync(
        node.execPath,
        ["--import", script("ts-register.mjs"), script(name), "--check"],
        { encoding: "utf8", timeout: 120_000 },
      );
      expect(out).toMatch(/the committed fixture matches/);
    }
  }, 240_000);
});

describe("a fixture holds protocol facts only", () => {
  /** Every field name any frame of either union can carry, read off the schemas. */
  const protocolKeys = new Set<string>();
  const visit = (node: z.ZodType, where: string, depth = 0): void => {
    if (depth > 16) throw new Error(`nested past 16 levels at ${where}`);
    const { inner } = walk.unwrap(node, where);
    const type = walk.nodeType(inner, where);
    if (type === "object") {
      for (const [key, child] of walk.objectEntries(inner, where)) {
        protocolKeys.add(key);
        visit(child as z.ZodType, `${where}.${key}`, depth + 1);
      }
    } else if (type === "array") visit(walk.arrayElement(inner, where), `${where}[]`, depth + 1);
    else if (type === "union") for (const option of walk.unionOptions(inner, where)) visit(option, where, depth + 1);
  };
  for (const [name, union] of Object.entries(unions)) visit(union, name);

  /** The fixture's own structure, as exact key sets. */
  const keysOf = (value: object) => Object.keys(value).sort();
  const exactly = (value: object, expected: string[], where: string) =>
    expect(keysOf(value), where).toEqual([...expected].sort());

  /** Every object key in a frame must be a protocol field. */
  const frameKeys = (value: unknown, where: string, out: string[] = []): string[] => {
    if (Array.isArray(value)) value.forEach((v, i) => frameKeys(v, `${where}[${i}]`, out));
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (!protocolKeys.has(key)) out.push(`${where}.${key}`);
        frameKeys(child, `${where}.${key}`, out);
      }
    }
    return out;
  };

  it("proto-vectors.json: an exact envelope, and frames carry only protocol fields", () => {
    exactly(committedProto, ["_generatedBy", "note", "client", "server"], "proto-vectors top level");
    for (const name of ["client", "server"]) {
      exactly(committedProto[name], ["types", "vectors"], `${name} section`);
      for (const vector of committedProto[name].vectors) {
        exactly(vector, ["type", "label", "input", "canonical"], `${name}/${vector.label}`);
        expect(frameKeys(vector.input, `${vector.label}.input`)).toEqual([]);
        expect(frameKeys(vector.canonical, `${vector.label}.canonical`)).toEqual([]);
      }
    }
  });

  it("constraints.json: an exact envelope, and violation frames carry only protocol fields", () => {
    exactly(committedConstraints, [
      "_generatedBy", "note", "soundboardBuiltinIds", "counts", "rules", "armsWithoutRules",
      "violations", "skipped", "formatCases", "refinements",
    ], "constraints top level");
    exactly(committedConstraints.counts, ["rules", "violations", "skipped"], "counts");
    exactly(committedConstraints.armsWithoutRules, ["client", "server"], "armsWithoutRules");
    exactly(committedConstraints.formatCases, ["url", "guid"], "formatCases");
    for (const byType of Object.values<any>(committedConstraints.rules)) {
      for (const rows of Object.values<any[]>(byType)) {
        for (const row of rows) {
          exactly(row, ["path", "rules"], "rule row");
          for (const rule of row.rules) {
            expect(["k", "k,v", "k,name"]).toContain(keysOf(rule).join(","));
          }
        }
      }
    }
    for (const violation of committedConstraints.violations) {
      exactly(violation, ["union", "type", "path", "rule", "frame", "zodPaths"], "violation");
      expect(frameKeys(violation.frame, `${violation.type}.frame`)).toEqual([]);
    }
    for (const row of committedConstraints.skipped) exactly(row, ["union", "type", "path", "rule", "why"], "skipped");
    for (const cases of [...Object.values<any[]>(committedConstraints.formatCases), ...Object.values<any[]>(committedConstraints.refinements)]) {
      for (const row of cases) exactly(row, ["value", "ok"], "probe case");
    }
  });

  it("no key anywhere names a path, a version or how a module was found; no value is a filesystem path", () => {
    const forbiddenKey = /version|resolved|cwd|hostname|machine|platform|filename|filepath|dirname|abspath|fspath|located|installed|nodeVersion/i;
    const fsPath = /(^|[\s"'(])(\/(Users|home|private|tmp|var|opt|usr|Volumes|root|etc|mnt|workspace|runner)\/|[A-Za-z]:\\|file:\/\/)|node_modules|\.pnpm|\\\\/;
    const problems: string[] = [];
    const scan = (value: unknown, where: string, frame: boolean): void => {
      if (typeof value === "string") {
        if (fsPath.test(value)) problems.push(`${where}: a filesystem path value ${JSON.stringify(value)}`);
      } else if (Array.isArray(value)) value.forEach((v, i) => scan(v, `${where}[${i}]`, frame));
      else if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          // Protocol field names are checked against the schema above; a
          // protocol field is never what makes a fixture machine-dependent.
          if (!protocolKeys.has(key) && forbiddenKey.test(key)) problems.push(`${where}.${key}: a machine-dependent key`);
          scan(child, `${where}.${key}`, frame);
        }
      }
    };
    scan(committedProto, "proto-vectors", false);
    scan(committedConstraints, "constraints", false);
    expect(problems).toEqual([]);
  });

  it("the check itself bites: a path, a version and wsResolvedVia would be caught", () => {
    const forbiddenKey = /version|resolved|cwd|hostname|machine|platform|filename|filepath|dirname|abspath|fspath|located|installed|nodeVersion/i;
    for (const key of ["wsResolvedVia", "zodVersion", "resolvedPath", "cwd", "nodeVersion", "filePath"]) {
      expect(forbiddenKey.test(key), key).toBe(true);
      expect(protocolKeys.has(key), `${key} must not be a protocol field`).toBe(false);
    }
    const fsPath = /(^|[\s"'(])(\/(Users|home|private|tmp|var|opt|usr|Volumes|root|etc|mnt|workspace|runner)\/|[A-Za-z]:\\|file:\/\/)|node_modules|\.pnpm|\\\\/;
    for (const value of ["/Users/me/pqp/node_modules/ws", "C:\\work\\ws", "file:///tmp/x", "/home/runner/work/pqp"]) {
      expect(fsPath.test(value), value).toBe(true);
    }
    expect(fsPath.test("/api/voice/hls-playlist/a.m3u8")).toBe(false);
  });
});
