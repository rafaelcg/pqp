#!/usr/bin/env node
/**
 * Generate the **value-constraint** half of the protocol fixtures.
 *
 * `gen-proto-vectors.mjs` pins structure: which fields exist, which are null,
 * which are absent. Zod checks more than structure — `.uuid()`, `.min(1)`,
 * `.max(64)`, `.url()`, `.int()`, `.positive()`, enum membership, array bounds,
 * and one `.refine`. A Rust that enforces only structure accepts frames the Node
 * server hangs up on, and two machines disagreeing about who may stay in a room
 * is worse than one slow machine. So the value rules are ported too, as **data
 * derived from the schema** rather than a list somebody maintains: this file
 * reads them off the shipped Zod schemas and writes `fixtures/constraints.json`,
 * which `pqp-core` compiles in with `include_str!`.
 *
 * Nothing here is hand-copied, and two things make that stick:
 * - an unrecognised constraint or refinement makes the generator **throw**, so a
 *   new `.refine` or `.regex` cannot be quietly skipped by the port;
 * - every violation frame is run through the real schema and must be **refused**
 *   there, at the path being broken. A rule misread here, or a mutation that is
 *   not actually illegal, fails the run instead of writing a green test. That
 *   check is what caught `.max(64)` on `skipVotes` being an array count and not a
 *   string length.
 *
 * Run after gen-proto-vectors.mjs, which this reads for accepted frames:
 *   node --experimental-strip-types --no-warnings \
 *     --import ./rust/scripts/ts-register.mjs rust/scripts/gen-constraints.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const vectorsPath = resolve(here, "../fixtures/proto-vectors.json");
const out = resolve(here, "../fixtures/constraints.json");
const sig = await import(resolve(here, "../../packages/shared/src/signaling.ts"));
const soundboard = await import(resolve(here, "../../packages/shared/src/soundboard.ts"));

/**
 * Zod wraps `.refine(fn)` in its own closure, so the predicate cannot be
 * recognised by identity. It is recognised by **behaviour** instead: the
 * candidate predicates the shared package exports are run against a corpus, and
 * the one that agrees with the schema's refinement on every value is the one the
 * schema used. Ambiguous or unmatched is an error, never a guess — and the same
 * corpus ships in the fixture, so the Rust port is pinned to what the TypeScript
 * actually accepts rather than to a description of it.
 */
const REFINE_CORPUS = [
  ...soundboard.SOUNDBOARD_BUILTINS.map((sound) => sound.id),
  "builtin:does-not-exist", "builtin:", "BUILTIN:GASS",
  "11111111-1111-4111-8111-111111111111",
  "11111111-1111-4111-8111-11111111111A",
  "00000000-0000-0000-0000-000000000000",
  "11111111-1111-4111-8111-11111111111", "11111111111141118111111111111111",
  "zzzzzzzz-1111-4111-8111-111111111111",
  "", " ", "  ", "x", "ab cd", "\u{1f44d}", "\u{1f44d}\u{1f3fb}", "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}",
  "a".repeat(32), "a".repeat(33), "0", "-1", "null", "undefined",
];
const REFINE_CANDIDATES = Object.entries(soundboard)
  .filter(([name, value]) => /^is[A-Z]/.test(name) && typeof value === "function")
  .map(([name, fn]) => ({ name, fn }));
if (!REFINE_CANDIDATES.length) throw new Error("no candidate predicates exported from soundboard.ts");

/** refinement name → the `{value, ok}` pairs zod's own refinement produced. */
const refinementCases = new Map();

/** Ask zod's own refinement whether it accepts a value. */
function refinementAccepts(refine, value) {
  let issued = false;
  const ctx = { addIssue: () => { issued = true; }, path: [], data: value };
  try {
    const returned = refine(value, ctx);
    return returned === undefined ? !issued : Boolean(returned);
  } catch {
    return false;
  }
}

function identifyRefinement(refine, where) {
  const matched = REFINE_CANDIDATES.filter((cand) => REFINE_CORPUS
    .every((value) => refinementAccepts(refine, value) === Boolean(cand.fn(value))));
  let name;
  if (matched.length === 1) {
    name = matched[0].name;
  } else if (matched.length > 1) {
    throw new Error(`refinement on ${where} matches ${matched.map((m) => m.name).join(", ")} `
      + "on every probe — widen REFINE_CORPUS until the port can tell them apart");
  } else {
    throw new Error(`unrecognised .refine on ${where} — no exported predicate agrees with it `
      + "on the probe corpus; port it and add it, do not let the port skip it");
  }
  pinRefinement(name, refine, where);
  return name;
}

/**
 * Record what zod's refinement accepts, value by value. The Rust port is pinned
 * to *this* rather than to the exported helper it happens to agree with, and
 * `pqp-core` refuses to load a table whose enforced refinement has no pins, so
 * a port cannot drift away from the predicate without CI noticing.
 */
function pinRefinement(name, refine, where) {
  const cases = REFINE_CORPUS.map((value) => {
    if (typeof value !== "string") {
      throw new Error(`refine probe ${String(value)} is not a string; the port pins strings`);
    }
    return { value, ok: refinementAccepts(refine, value) };
  });
  if (!cases.some((row) => row.ok) || !cases.some((row) => !row.ok)) {
    throw new Error(`refine probes for ${name} on ${where} cover only one verdict `
      + "— widen REFINE_CORPUS until they pin both accepting and refusing");
  }
  const seen = refinementCases.get(name);
  if (seen && JSON.stringify(seen) !== JSON.stringify(cases)) {
    throw new Error(`${name} behaves differently on ${where} than on the first schema that `
      + "used it — two schemas sharing a name must not share a port");
  }
  refinementCases.set(name, cases);
}

/** Peel the wrappers off a Zod node, remembering refinements on the way. */
function unwrap(node, where = "the wire protocol") {
  let optional = false;
  let nullable = false;
  const refinements = [];
  let cur = node;
  for (;;) {
    const type = cur?._def?.typeName;
    if (type === "ZodOptional") { optional = true; cur = cur._def.innerType; continue; }
    if (type === "ZodDefault") { optional = true; cur = cur._def.innerType; continue; }
    if (type === "ZodNullable") { nullable = true; cur = cur._def.innerType; continue; }
    if (type === "ZodEffects") {
      const refine = cur._def.effect?.refinement;
      if (refine) {
        refinements.push(identifyRefinement(refine, where));
      }
      cur = cur._def.schema;
      continue;
    }
    if (type === "ZodPipeline") { cur = cur._def.schema; continue; }
    break;
  }
  return { inner: cur, optional, nullable, refinements };
}

const familyOf = (type) => {
  if (type === "ZodNumber") return "num";
  if (type === "ZodArray") return "arr";
  if (type === "ZodString") return "str";
  return "other";
};

/** Zod's checks for one leaf, as the small closed set Rust implements. */
function rulesForLeaf(node, refinements, where) {
  const { inner } = unwrap(node, where);
  const type = inner?._def?.typeName;
  const family = familyOf(type);
  const checks = inner?._def?.checks ?? [];
  const rules = [];
  for (const check of checks) {
    const inclusive = check.inclusive !== false;
    switch (check.kind) {
      case "min":
        if (family === "num") rules.push({ k: inclusive ? "ge" : "gt", v: check.value });
        else if (family === "arr") rules.push({ k: inclusive ? "minItems" : "moreThanItems", v: check.value });
        else rules.push({ k: "minLen", v: check.value });
        break;
      case "max":
        if (family === "num") rules.push({ k: inclusive ? "le" : "lt", v: check.value });
        else if (family === "arr") rules.push({ k: inclusive ? "maxItems" : "fewerThanItems", v: check.value });
        else rules.push({ k: "maxLen", v: check.value });
        break;
      case "length":
        rules.push({ k: family === "arr" ? "lenItems" : "len", v: check.value });
        break;
      case "int": rules.push({ k: "int" }); break;
      case "uuid": rules.push({ k: "uuid" }); break;
      case "url": rules.push({ k: "url" }); break;
      case "type":
        if (check.type !== "number") throw new Error(`unexpected type check: ${check.type}`);
        break;
      case "regex":
        throw new Error(`regex check not ported (${check.regex}) — decide before the port skips it`);
      case "startsWith": case "endsWith": case "includes":
      case "multipleOf": case "notMultipleOf": case "cuid": case "email":
      case "nan_type": case "finite":
        throw new Error(`check not ported: ${check.kind} — decide before the port skips it`);
      default:
        throw new Error(`unhandled zod check: ${check.kind}`);
    }
  }
  if (type === "ZodEnum") rules.push({ k: "enum", v: inner._def.values });
  if (type === "ZodLiteral") rules.push({ k: "literal", v: inner._def.value });
  for (const name of refinements) rules.push({ k: "refine", name });
  const leaf = family !== "other" || type === "ZodEnum" || type === "ZodLiteral";
  if (rules.length && !leaf) {
    throw new Error(`value rules on unexpected node type ${type}`);
  }
  return rules;
}

/**
 * Walk one arm into `{path, rules}` rows. A trailing `[]` means "every element
 * of", and bounds ON the array hang off the array path without it, because
 * `.max(64)` on `skipVotes` counts votes and not characters.
 */
function collect(node, path, rows, depth = 0) {
  if (depth > 16) throw new Error(`schema nested past ${depth} levels at ${path}`);
  const { inner, refinements } = unwrap(node, path);
  const type = inner?._def?.typeName;
  if (!type) return;
  if (type === "ZodObject") {
    const shape = typeof inner._def.shape === "function" ? inner._def.shape() : inner._def.shape;
    for (const [key, child] of Object.entries(shape ?? {})) {
      collect(child, path ? `${path}.${key}` : key, rows, depth + 1);
    }
    return;
  }
  if (type === "ZodArray") {
    const own = rulesForLeaf(node, refinements, path);
    if (own.length) rows.push({ path, rules: own });
    collect(inner._def.type, `${path}[]`, rows, depth + 1);
    return;
  }
  if (type === "ZodUnion" || type === "ZodDiscriminatedUnion") {
    const options = inner._def.options instanceof Map
      ? [...inner._def.options.values()] : inner._def.options;
    for (const option of options) collect(option, path, rows, depth + 1);
    return;
  }
  const rules = rulesForLeaf(node, refinements, path);
  if (rules.length) rows.push({ path, rules });
}

const describe = (rule) => (rule.k === "enum" ? `enum(${rule.v.join("|")})`
  : rule.k === "literal" ? `literal(${JSON.stringify(rule.v)})`
    : rule.k === "refine" ? `refine(${rule.name})` : rule.k);

/** Split `state.queue[].title` into path segments. */
const segments = (path) => path.split(".").flatMap((part) => (
  part.endsWith("[]") ? [{ key: part.slice(0, -2) }, { each: true }] : [{ key: part }]
));

/** Concrete nodes a path selects, with real indices for `[]`. */
function select(frame, path) {
  let found = [{ node: frame, path: "" }];
  for (const seg of segments(path)) {
    const next = [];
    for (const hit of found) {
      if (seg.each) {
        if (Array.isArray(hit.node)) {
          hit.node.forEach((node, i) => next.push({ node, path: `${hit.path}[${i}]` }));
        }
      } else if (hit.node && typeof hit.node === "object" && !Array.isArray(hit.node)
        && Object.hasOwn(hit.node, seg.key)) {
        next.push({ node: hit.node[seg.key], path: hit.path ? `${hit.path}.${seg.key}` : seg.key });
      }
    }
    found = next;
    if (!found.length) return [];
  }
  return found;
}

/**
 * Zod spells an array element `queue.0.id`; the port and this file both spell it
 * `queue[0].id`. One spelling, applied to zod's issues as they are recorded, so
 * the Rust test compares paths instead of transliterating them.
 */
const zodPath = (issuePath) => issuePath.reduce(
  (acc, seg) => (/^\d+$/.test(String(seg)) ? `${acc}[${seg}]` : acc ? `${acc}.${seg}` : String(seg)),
  "",
);

/** Replace the value at a path on a copy; null when the path is absent. */
function mutate(frame, path, value) {
  const copy = structuredClone(frame);
  const parts = segments(path);
  let queue = [{ node: copy }];
  for (let i = 0; i < parts.length; i += 1) {
    const seg = parts[i];
    const last = i === parts.length - 1;
    const next = [];
    for (const hit of queue) {
      if (seg.each) {
        // One candidate frame is not the only way to reach a path: skip the
        // ones that do not hold it and keep looking. A row counts as proved
        // only when zod still refuses at exactly the mutated path, so a
        // longer search cannot make a weak proof look like a strong one.
        if (!Array.isArray(hit.node) || hit.node.length === 0) continue;
        // A path ending in [] names the elements themselves, so the value goes
        // into the first slot. Breaking one element is enough: zod blames the
        // index it fails on, and the port has to blame the same one.
        if (last) { hit.node[0] = value; return copy; }
        hit.node.forEach((node) => next.push({ node }));
        continue;
      }
      if (!hit.node || typeof hit.node !== "object" || !(seg.key in hit.node)) continue;
      if (last) { hit.node[seg.key] = value; return copy; }
      next.push({ node: hit.node[seg.key] });
    }
    queue = next;
    if (!queue.length) return null;
  }
  return null;
}

/**
 * Resize helpers for breaking a count bound. Elements are taken from the
 * example itself, so the array still holds valid items and only the count can
 * be the reason zod refuses.
 */
const grow = (arr, n) => {
  if (!arr.length) return null;
  const out = arr.slice();
  while (out.length < n) out.push(arr[out.length % arr.length]);
  return out;
};

/**
 * A value that breaks exactly one leaf rule. `undefined` means no value can on
 * its own (`.min(0)` has nothing below it), which is reported instead of being
 * left silently untested.
 */
function violate(rule, example) {
  switch (rule.k) {
    case "uuid": return "not-a-uuid";
    case "url": return "not a url";
    case "minLen": return rule.v > 0 ? "x".repeat(rule.v - 1) : undefined;
    case "maxLen": return "x".repeat(rule.v + 1);
    case "len": return "x".repeat(rule.v + 1);
    case "int": return 0.5;
    case "ge": return rule.v - 1;
    case "gt": return rule.v;
    case "le": return rule.v + 1;
    case "lt": return rule.v;
    case "enum": return "__not_an_option__";
    case "literal": return typeof rule.v === "string" ? "__not_the_literal__" : undefined;
    case "refine": return "__not_a_valid_value__";
    case "minItems": return rule.v > 0 && Array.isArray(example) && example.length >= rule.v
      ? example.slice(0, rule.v - 1) : undefined;
    case "moreThanItems": return Array.isArray(example) && example.length > rule.v
      ? example.slice(0, rule.v) : undefined;
    case "maxItems": return Array.isArray(example) ? grow(example, rule.v + 1) ?? undefined : undefined;
    case "fewerThanItems": return Array.isArray(example) ? grow(example, rule.v) ?? undefined : undefined;
    case "lenItems": return Array.isArray(example) ? grow(example, rule.v + 1) ?? undefined : undefined;
    default: throw new Error(`no violation for rule ${rule.k}`);
  }
}

const vectors = JSON.parse(readFileSync(vectorsPath, "utf8"));
const unions = {
  client: { schema: sig.voiceClientMessageSchema, vectors: vectors.client.vectors },
  server: { schema: sig.voiceSignalingMessageSchema, vectors: vectors.server.vectors },
};

const rules = { client: {}, server: {} };
const violations = [];
const skipped = [];
const armsWithoutRules = { client: [], server: [] };

for (const [unionName, union] of Object.entries(unions)) {
  for (const arm of union.schema.options) {
    const type = arm.shape.type.value;
    const rows = [];
    collect(arm, "", rows);
    const scoped = rows.filter((row) => row.path !== "type");
    if (!scoped.length) { armsWithoutRules[unionName].push(type); continue; }
    rules[unionName][type] = scoped;

    // Prove each rule bites: take a frame zod accepts for this arm, break one
    // rule at a time, and require zod to refuse it, naming that path.
    const frames = union.vectors.filter((v) => v.type === type).map((v) => v.input);
    for (const row of scoped) {
      for (const rule of row.rules) {
        for (const frame of frames) {
          const hits = select(frame, row.path);
          if (!hits.length) continue;
          const bad = violate(rule, hits[0].node);
          if (bad === undefined) {
            skipped.push({ union: unionName, type, path: row.path, rule: describe(rule),
              why: "no single value breaks it" });
            break;
          }
          const mutated = mutate(frame, row.path, bad);
          if (mutated === null) continue;
          const parsed = arm.safeParse(mutated);
          if (parsed.success) {
            throw new Error(`${unionName}/${type} ${row.path} ${describe(rule)}: zod ACCEPTED the `
              + "violation — the rule was misread or the mutation broke nothing");
          }
          const zodPaths = [...new Set(parsed.error.issues.map((issue) => zodPath(issue.path)))];
          const targets = select(mutated, row.path).map((hit) => hit.path);
          const reported = zodPaths.filter((path) => targets.includes(path));
          if (!reported.length) {
            throw new Error(`${unionName}/${type} ${row.path} ${describe(rule)}: zod refused, but at `
              + `${zodPaths.join(", ") || "(no path)"} — not at the rule being broken`);
          }
          violations.push({ union: unionName, type, path: row.path, rule: describe(rule),
            frame: mutated, zodPaths });
          break;
        }
        const proved = violations.some((v) => v.union === unionName && v.type === type
          && v.path === row.path && v.rule === describe(rule));
        const noted = skipped.some((v) => v.union === unionName && v.type === type
          && v.path === row.path && v.rule === describe(rule));
        if (!proved && !noted) {
          skipped.push({ union: unionName, type, path: row.path, rule: describe(rule),
            why: "no example frame reaches that path" });
        }
      }
    }
  }
}

/**
 * `.url()` is Zod's `new URL(value)` acceptance, which is not "looks like
 * http": data:, javascript: and blob: all pass it, so a port that "obviously"
 * requires https would reject frames the Node server accepts. Rust uses a
 * WHATWG parser, so agreement is pinned rather than assumed — pinned through the
 * real protocol schema, by dropping each candidate into a valid `set-music`
 * frame where the url field is the only thing that can fail.
 */
const URL_CASES = [
  "https://i.ytimg.com/vi/x/hq.jpg", "http://a.b", "not a url", "",
  "data:text/plain,hi", "javascript:alert(1)", "ftp://x.y/z", "://x",
  "https://", "HTTPS://EXAMPLE.COM", " https://x.y ", "mailto:a@b.c",
  "blob:https://a/b", "https://x.y/a b", "youtube:///x",
];
const musicFrame = unions.client.vectors.find((v) => v.type === "set-music")?.input;
if (!musicFrame) throw new Error("no set-music example to probe .url() with");
const urlCases = [...new Set([...URL_CASES,
  ...select(musicFrame, "state.current.sourceUrl").map((hit) => hit.node)])]
  .filter((value) => typeof value === "string")
  .map((value) => {
    const probe = mutate(musicFrame, "state.current.sourceUrl", value);
    if (probe === null) throw new Error("set-music example has no state.current.sourceUrl");
    const parsed = sig.voiceClientMessageSchema.safeParse(probe);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((issue) => zodPath(issue.path));
      if (paths.some((path) => path !== "state.current.sourceUrl")) {
        throw new Error(`url probe ${JSON.stringify(value)} failed elsewhere: ${paths.join(",")}`);
      }
    }
    return { value, ok: parsed.success };
  });

const countRules = (byType) => Object.values(byType)
  .reduce((n, rows) => n + rows.reduce((m, row) => m + row.rules.length, 0), 0);
const total = countRules(rules.client) + countRules(rules.server);

// Every refinement the table enforces must arrive pinned, or the Rust port is
// free to invent its own meaning for it.
const enforced = new Set();
for (const byType of Object.values(rules)) {
  for (const rows of Object.values(byType)) {
    for (const row of rows) {
      for (const rule of row.rules) if (rule.k === "refine") enforced.add(rule.name);
    }
  }
}
for (const name of enforced) {
  if (!refinementCases.has(name)) {
    throw new Error(`${name} is enforced on the wire with no pinned cases`);
  }
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({
  _generatedBy: "rust/scripts/gen-constraints.mjs",
  note: "Value rules read off the shipped Zod schemas, and violation frames each one was "
    + "proved illegal with. Do not edit by hand: pqp-core compiles this file in, so a "
    + "constraint added to the schema is enforced by Rust on the next regeneration or CI fails.",
  soundboardBuiltinIds: soundboard.SOUNDBOARD_BUILTINS.map((sound) => sound.id),
  counts: { rules: total, violations: violations.length, skipped: skipped.length },
  rules,
  armsWithoutRules,
  violations,
  skipped,
  urlCases,
  refinements: Object.fromEntries(refinementCases),
}, null, 2) + "\n");
console.log(`wrote ${total} value rules over `
  + `${Object.keys(rules.client).length + Object.keys(rules.server).length} arms, `
  + `${violations.length} proved violations, ${skipped.length} skipped, `
  + `${urlCases.length} url cases and `
  + `${[...refinementCases.values()].reduce((n, cases) => n + cases.length, 0)} `
  + `refinement cases over ${refinementCases.size} refinements to ${out}`);
if (skipped.length) {
  console.log("untested rules (reported, not silent):");
  for (const row of skipped) {
    console.log(`  ${row.union}/${row.type} ${row.path} ${row.rule}: ${row.why}`);
  }
}
