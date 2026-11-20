#!/usr/bin/env node
/**
 * Generate the **value-constraint** half of the wire-contract fixtures.
 *
 * `gen-proto-vectors.mjs` pins structure: which fields exist, which are null,
 * which are absent. Zod checks more than structure: `.guid()`, `.min(1)`,
 * `.max(64)`, `.url()`, `.int()`, `.positive()`, enum membership, array bounds,
 * and a `.refine`. A client that enforces only structure accepts frames the Node
 * server hangs up on, and two implementations disagreeing about what a frame is
 * is worse than one slow one. So the value rules are fixtures too, as **data read
 * off the shipped schemas** rather than a list somebody maintains.
 *
 *   pnpm --filter @pqp/shared fixtures:wire          write both fixtures
 *   pnpm --filter @pqp/shared fixtures:wire:check    compare, write nothing
 *
 * Nothing here is hand-copied, and four things make that stick:
 *
 * - **Nothing is skipped.** The schema walk (`zod4-walk.mjs`) throws on a node
 *   type or a check it has no rule for. A new `.regex`, `.email`, `.transform`,
 *   `z.record` or `z.pipe` on the wire stops this generator instead of being
 *   quietly absent from the fixture. (The zod 3 version of this file read
 *   `_def.typeName`, matched nothing on zod 4, and wrote "0 value rules over 0
 *   arms" without failing. `gen-constraints.test` pins a floor so that cannot
 *   happen again.)
 * - **Every rule is proved by a frame zod refuses**, at the path being broken
 *   and for the kind of reason the rule names (`too_big` for a `max`, and so
 *   on). A rule misread here, or a mutation that is not actually illegal, fails
 *   the run instead of writing a green test. That is what caught `.max(64)` on
 *   `skipVotes` being an array count and not a string length, and it is why the
 *   reason is checked as well as the path: `"x".repeat(2049)` in a `.url().max()`
 *   field is refused for not being a URL whether or not `.max()` exists.
 * - **`.refine` is identified by behaviour.** Zod keeps the predicate as an
 *   anonymous closure, so it cannot be recognised by identity; the exported
 *   predicates of the shared package are run against a corpus and the one that
 *   agrees with the schema on every probe is the one it used. Zero or several
 *   agreeing is an error, never a guess, and the corpus ships in the fixture, so
 *   a client is pinned to what the schema accepts and not to a description of it.
 * - **Formats are pinned by behaviour too.** See the two lessons below.
 *
 * LESSONS THAT EARNED A RULE HERE (from #1561, the Rust core spike):
 *
 * - **`.max()` on an array counts items, not characters.** `skipVotes:
 *   z.array(z.string().min(1).max(128)).max(64)` has a `maxItems` 64 on the
 *   array and a `maxLen` 128 on each element. Reading the bound as a string
 *   length made a client refuse a perfectly good frame. Rows therefore address
 *   an array and its elements separately (`skipVotes` and `skipVotes[]`).
 * - **zod's `.url()` is `new URL()`, not "looks like http".** `data:`,
 *   `javascript:` and `blob:` all pass it, so a client that "obviously" requires
 *   https refuses frames the server accepts (and one that checks the scheme
 *   later must not assume the schema did). The `formatCases.url` rows record
 *   what zod really says about a probe list, through the real protocol schema.
 *   `.guid()` is the same kind of fact: any 8-4-4-4-12 hex group passes, version
 *   and variant nibbles are not looked at (`.uuid()` would).
 */
import {
  UnrecognisedZodNode,
  arrayElement,
  checksOf,
  defOf,
  discriminatedArms,
  enumValues,
  literalValues,
  nodeType,
  objectEntries,
  unionOptions,
  unwrap,
} from "./zod4-walk.mjs";
import { generateProtoVectors } from "./gen-proto-vectors.mjs";
import { CONSTRAINTS_URL, isMain, runCli } from "./wire-fixture-io.mjs";

/**
 * The probes `.refine` is identified and pinned with. Wide enough to tell the
 * exported predicates apart, and to pin both a refusing and an accepting
 * verdict for each.
 */
export function refineCorpus(soundboard) {
  return [
    ...soundboard.SOUNDBOARD_BUILTINS.map((sound) => sound.id),
    "builtin:does-not-exist", "builtin:", "BUILTIN:GASS",
    "11111111-1111-4111-8111-111111111111",
    "11111111-1111-4111-8111-11111111111A",
    "00000000-0000-0000-0000-000000000000",
    "11111111-1111-4111-8111-11111111111", "11111111111141118111111111111111",
    "zzzzzzzz-1111-4111-8111-111111111111",
    "", " ", "  ", "x", "ab cd", "\u{1f44d}", "\u{1f44d}\u{1f3fb}", "\u{1f468}‍\u{1f469}‍\u{1f467}",
    "a".repeat(32), "a".repeat(33), "0", "-1", "null", "undefined",
  ];
}

const URL_PROBES = [
  "https://i.ytimg.com/vi/x/hq.jpg", "http://a.b", "not a url", "",
  "data:text/plain,hi", "javascript:alert(1)", "ftp://x.y/z", "://x",
  "https://", "HTTPS://EXAMPLE.COM", " https://x.y ", "mailto:a@b.c",
  "blob:https://a/b", "https://x.y/a b", "youtube:///x",
];

const GUID_PROBES = [
  "11111111-1111-4111-8111-111111111111",
  "11111111-1111-1111-1111-111111111111", // version 1, variant 0: `.uuid()` refuses, `.guid()` does not
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
  "11111111-1111-4111-8111-11111111111", // one short
  "11111111-1111-4111-8111-1111111111111", // one long
  "11111111111141118111111111111111", // no hyphens
  "{11111111-1111-4111-8111-111111111111}",
  "urn:uuid:11111111-1111-4111-8111-111111111111",
  " 11111111-1111-4111-8111-111111111111",
  "11111111-1111-4111-8111-11111111111g",
  "", "not-a-uuid",
];

/** What zod says when a violation is of this kind. Checked, not written out. */
const EXPECTED_ISSUE = {
  minLen: ["too_small"], minItems: ["too_small"], ge: ["too_small"], gt: ["too_small"],
  maxLen: ["too_big"], maxItems: ["too_big"], le: ["too_big"], lt: ["too_big"],
  len: ["too_big", "too_small"], lenItems: ["too_big", "too_small"],
  guid: ["invalid_format"], url: ["invalid_format"],
  enum: ["invalid_value"], literal: ["invalid_value"], refine: ["custom"],
  safeint: ["invalid_type", "too_big", "too_small", "invalid_format"],
};

/** Zod keeps `.refine(fn)` as a `custom` check; ask it whether it accepts a value. */
function refinementAccepts(fn, value) {
  try {
    const returned = fn(value);
    if (returned instanceof Promise) throw new UnrecognisedZodNode("an async .refine on the wire cannot be probed");
    return Boolean(returned);
  } catch (err) {
    if (err instanceof UnrecognisedZodNode) throw err;
    return false;
  }
}

/**
 * Everything the generator learns while it walks, so two generator runs share
 * nothing. `where` strings are for error messages only.
 */
function makeContext(soundboard) {
  const corpus = refineCorpus(soundboard);
  const candidates = Object.entries(soundboard)
    .filter(([name, value]) => /^is[A-Z]/.test(name) && typeof value === "function")
    .map(([name, fn]) => ({ name, fn }));
  if (!candidates.length) throw new Error("no candidate predicates exported from soundboard.ts");
  const refinementCases = new Map();

  function pinRefinement(name, fn, where) {
    const cases = corpus.map((value) => ({ value, ok: refinementAccepts(fn, value) }));
    if (!cases.some((row) => row.ok) || !cases.some((row) => !row.ok)) {
      throw new Error(`refine probes for ${name} on ${where} cover only one verdict; `
        + "widen the corpus until they pin both accepting and refusing");
    }
    const seen = refinementCases.get(name);
    if (seen && JSON.stringify(seen) !== JSON.stringify(cases)) {
      throw new Error(`${name} behaves differently on ${where} than on the first schema that `
        + "used it: two schemas sharing a name must not share a port");
    }
    refinementCases.set(name, cases);
  }

  function identifyRefinement(fn, where) {
    const matched = candidates.filter((cand) => corpus
      .every((value) => refinementAccepts(fn, value) === Boolean(cand.fn(value))));
    if (matched.length > 1) {
      throw new Error(`refinement on ${where} matches ${matched.map((m) => m.name).join(", ")} `
        + "on every probe: widen the corpus until a client can tell them apart");
    }
    if (!matched.length) {
      throw new Error(`unrecognised .refine on ${where}: no exported predicate agrees with it `
        + "on the probe corpus. Export and port it, do not let a client skip it");
    }
    pinRefinement(matched[0].name, fn, where);
    return matched[0].name;
  }

  return { refinementCases, identifyRefinement };
}

/** The closed set of leaf rules, read off a node's `def.checks`, enum and literal. */
function rulesForNode(inner, where, identifyRefinement) {
  const def = defOf(inner, where);
  const type = nodeType(inner, where);
  const family = type === "number" ? "num" : type === "array" ? "arr" : type === "string" ? "str" : "other";
  const rules = [];
  // A format built as its own node (`z.guid()`, `z.url()`, `z.int()`) carries
  // its rule on the node's own def rather than in `checks`, so it is read as one
  // more check. Left out, it would be a plain string with no rule and no error.
  const own = typeof def.check === "string" ? [def] : [];
  for (const check of [...own, ...checksOf(inner)]) {
    switch (check.check) {
      case "min_length":
        if (family === "arr") rules.push({ k: "minItems", v: check.minimum });
        else if (family === "str") rules.push({ k: "minLen", v: check.minimum });
        else throw new UnrecognisedZodNode(`min_length on a ${type} at ${where}`);
        break;
      case "max_length":
        if (family === "arr") rules.push({ k: "maxItems", v: check.maximum });
        else if (family === "str") rules.push({ k: "maxLen", v: check.maximum });
        else throw new UnrecognisedZodNode(`max_length on a ${type} at ${where}`);
        break;
      case "length_equals":
        if (family === "arr") rules.push({ k: "lenItems", v: check.length });
        else if (family === "str") rules.push({ k: "len", v: check.length });
        else throw new UnrecognisedZodNode(`length_equals on a ${type} at ${where}`);
        break;
      case "greater_than":
        if (family !== "num" || typeof check.value !== "number") {
          throw new UnrecognisedZodNode(`greater_than on a ${type} at ${where}`);
        }
        rules.push({ k: check.inclusive ? "ge" : "gt", v: check.value });
        break;
      case "less_than":
        if (family !== "num" || typeof check.value !== "number") {
          throw new UnrecognisedZodNode(`less_than on a ${type} at ${where}`);
        }
        rules.push({ k: check.inclusive ? "le" : "lt", v: check.value });
        break;
      case "number_format":
        // zod 4's `.int()` is `safeint`: a whole number AND within +-(2^53 - 1).
        if (check.format !== "safeint") {
          throw new UnrecognisedZodNode(`number format "${check.format}" at ${where}`);
        }
        rules.push({ k: "safeint" });
        break;
      case "string_format":
        if (check.format === "guid" && check.pattern) { rules.push({ k: "guid" }); break; }
        if (check.format === "url") {
          // `hostname`, `protocol` and `normalize` change what `.url()` accepts
          // or rewrites the value; none is modelled, so none may appear.
          if (check.hostname || check.protocol || check.normalize) {
            throw new UnrecognisedZodNode(`.url() with hostname/protocol/normalize options at ${where}`);
          }
          rules.push({ k: "url" });
          break;
        }
        throw new UnrecognisedZodNode(`string format "${check.format}" at ${where}: port it deliberately`);
      case "custom":
        // `.refine(fn)`. A `.superRefine()` / `.check()` has no `fn` here and is
        // refused rather than guessed at.
        if (typeof check.fn !== "function") {
          throw new UnrecognisedZodNode(`a custom check without a predicate at ${where} (superRefine or check)`);
        }
        rules.push({ k: "refine", name: identifyRefinement(check.fn, where) });
        break;
      default:
        throw new UnrecognisedZodNode(`zod check "${check.check}" at ${where}: decide what a client does with it`);
    }
  }
  if (type === "enum") rules.push({ k: "enum", v: enumValues(inner, where) });
  if (type === "literal") {
    const values = literalValues(inner, where);
    rules.push(values.length === 1 ? { k: "literal", v: values[0] } : { k: "enum", v: values });
  }
  if (rules.length && family === "other" && type !== "enum" && type !== "literal") {
    throw new UnrecognisedZodNode(`value rules on unexpected node type ${def.type} at ${where}`);
  }
  return rules;
}

/**
 * Walk one arm into `{path, rules}` rows. A trailing `[]` means "every element
 * of", and bounds ON the array hang off the array path without it, because
 * `.max(64)` on `skipVotes` counts votes and not characters.
 */
export function collect(node, path, rows, identifyRefinement, depth = 0) {
  if (depth > 16) throw new Error(`schema nested past ${depth} levels at ${path}`);
  const { inner } = unwrap(node, path);
  const type = nodeType(inner, path);
  // A check on an object or a union (`.refine()` across fields, say) is a rule
  // the server enforces on the whole frame, and it has no row in this table.
  // Descending into the children and returning would drop it without a word, so
  // it stops the generator until somebody decides how clients express it.
  if ((type === "object" || type === "union") && checksOf(inner).length) {
    throw new UnrecognisedZodNode(
      `a ${checksOf(inner)[0].check} check on the ${type} at ${path || "(root)"}: `
      + "whole-frame rules are not modelled; port it deliberately, it is not skipped",
    );
  }
  if (type === "object") {
    for (const [key, child] of objectEntries(inner, path)) {
      collect(child, path ? `${path}.${key}` : key, rows, identifyRefinement, depth + 1);
    }
    return;
  }
  if (type === "array") {
    const own = rulesForNode(inner, path, identifyRefinement);
    if (own.length) rows.push({ path, rules: own });
    collect(arrayElement(inner, path), `${path}[]`, rows, identifyRefinement, depth + 1);
    return;
  }
  if (type === "union") {
    for (const option of unionOptions(inner, path)) collect(option, path, rows, identifyRefinement, depth + 1);
    return;
  }
  const rules = rulesForNode(inner, path, identifyRefinement);
  if (rules.length) rows.push({ path, rules });
}

export const describeRule = (rule) => (rule.k === "enum" ? `enum(${rule.v.join("|")})`
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
 * Zod spells an array element `queue.0.id`; the fixture (and every client's
 * test) spells it `queue[0].id`. One spelling, applied to zod's issues as they
 * are recorded, so a client compares paths instead of transliterating them.
 */
const zodPath = (issuePath) => issuePath.reduce(
  (acc, seg) => (typeof seg === "number" || /^\d+$/.test(String(seg))
    ? `${acc}[${seg}]` : acc ? `${acc}.${seg}` : String(seg)),
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
        // index it fails on, and a client has to blame the same one.
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
 * Resize helper for breaking a count bound. Elements are taken from the example
 * itself, so the array still holds valid items and only the count can be the
 * reason zod refuses.
 */
const grow = (arr, n) => {
  if (!arr.length) return null;
  const out = arr.slice();
  while (out.length < n) out.push(arr[out.length % arr.length]);
  return out;
};

/**
 * Values that each break exactly one leaf rule (a list because a rule can have
 * more than one edge: `safeint` is whole AND within 2^53). `undefined` means no
 * value can on its own (`.min(0)` has nothing below it), which is reported
 * instead of being left silently untested.
 */
function violations(rule, example) {
  switch (rule.k) {
    case "guid": return ["not-a-uuid"];
    case "url": return ["not a url"];
    case "minLen": return rule.v > 0 ? ["x".repeat(rule.v - 1)] : undefined;
    case "maxLen": return ["x".repeat(rule.v + 1)];
    case "len": return ["x".repeat(rule.v + 1)];
    case "safeint": return [0.5, 2 ** 53];
    case "ge": return [rule.v - 1];
    case "gt": return [rule.v];
    case "le": return [rule.v + 1];
    case "lt": return [rule.v];
    case "enum": return ["__not_an_option__"];
    case "literal": return typeof rule.v === "string" ? ["__not_the_literal__"] : undefined;
    case "refine": return ["__not_a_valid_value__"];
    case "minItems": return rule.v > 0 && Array.isArray(example) && example.length >= rule.v
      ? [example.slice(0, rule.v - 1)] : undefined;
    case "maxItems": {
      const grown = Array.isArray(example) ? grow(example, rule.v + 1) : null;
      return grown ? [grown] : undefined;
    }
    case "lenItems": {
      const grown = Array.isArray(example) ? grow(example, rule.v + 1) : null;
      return grown ? [grown] : undefined;
    }
    default: throw new Error(`no violation for rule ${rule.k}`);
  }
}

/**
 * Probe a format through the real protocol schema: drop each candidate into a
 * valid frame where that one field is the only thing that can fail. Pinned
 * rather than assumed, because the clients' own parsers (a WHATWG URL parser, a
 * hex regex) are different code from zod's.
 */
function probeFormat({ schema, vectors, type, path, probes, label }) {
  const frame = vectors.find((v) => v.type === type)?.input;
  if (!frame) throw new Error(`no ${type} example to probe ${label} with`);
  const present = select(frame, path).map((hit) => hit.node).filter((v) => typeof v === "string");
  return [...new Set([...probes, ...present])].map((value) => {
    const probe = mutate(frame, path, value);
    if (probe === null) throw new Error(`${type} example has no ${path}`);
    const parsed = schema.safeParse(probe);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((issue) => zodPath(issue.path));
      if (paths.some((p) => p !== path)) {
        throw new Error(`${label} probe ${JSON.stringify(value)} failed elsewhere: ${paths.join(",")}`);
      }
    }
    return { value, ok: parsed.success };
  });
}

/**
 * The whole fixture, built in memory.
 * @param {{ sig: object, soundboard: object, protoVectors?: object }} modules
 *   `sig` is `src/signaling`, `soundboard` is `src/soundboard`; `protoVectors` is
 *   the structure fixture (generated in memory when not given).
 */
export function generateConstraints({ sig, soundboard, protoVectors = generateProtoVectors(sig) }) {
  const { refinementCases, identifyRefinement } = makeContext(soundboard);
  const unions = {
    client: { schema: sig.voiceClientMessageSchema, vectors: protoVectors.client.vectors },
    server: { schema: sig.voiceSignalingMessageSchema, vectors: protoVectors.server.vectors },
  };
  const rules = { client: {}, server: {} };
  const proved = [];
  const skipped = [];
  const armsWithoutRules = { client: [], server: [] };

  for (const [unionName, union] of Object.entries(unions)) {
    for (const { type, schema: arm } of discriminatedArms(union.schema, unionName)) {
      const rows = [];
      collect(arm, "", rows, identifyRefinement);
      const scoped = rows.filter((row) => row.path !== "type");
      if (!scoped.length) { armsWithoutRules[unionName].push(type); continue; }
      rules[unionName][type] = scoped;

      // Prove each rule bites: take a frame zod accepts for this arm, break one
      // rule at a time, and require zod to refuse it, naming that path.
      const frames = union.vectors.filter((v) => v.type === type).map((v) => v.input);
      for (const row of scoped) {
        for (const rule of row.rules) {
          const rid = describeRule(rule);
          const have = () => proved.some((v) => v.union === unionName && v.type === type
            && v.path === row.path && v.rule === rid);
          let noSingleValue = false;
          for (const frame of frames) {
            const hits = select(frame, row.path).filter((hit) => hit.node !== null && hit.node !== undefined);
            if (!hits.length) continue;
            const bads = violations(rule, hits[0].node);
            if (bads === undefined) { noSingleValue = true; continue; }
            for (const bad of bads) {
              const mutated = mutate(frame, row.path, bad);
              if (mutated === null) continue;
              const parsed = arm.safeParse(mutated);
              if (parsed.success) {
                throw new Error(`${unionName}/${type} ${row.path} ${rid}: zod ACCEPTED the `
                  + "violation: the rule was misread or the mutation broke nothing");
              }
              const targets = select(mutated, row.path).map((hit) => hit.path);
              const atTarget = parsed.error.issues.filter((issue) => targets.includes(zodPath(issue.path)));
              if (!atTarget.length) {
                const elsewhere = [...new Set(parsed.error.issues.map((issue) => zodPath(issue.path)))];
                throw new Error(`${unionName}/${type} ${row.path} ${rid}: zod refused, but at `
                  + `${elsewhere.join(", ") || "(no path)"}, not at the rule being broken`);
              }
              const codes = atTarget.map((issue) => issue.code);
              if (!codes.some((code) => EXPECTED_ISSUE[rule.k]?.includes(code))) {
                throw new Error(`${unionName}/${type} ${row.path} ${rid}: zod refused with ${codes.join(", ")}, `
                  + `expected ${EXPECTED_ISSUE[rule.k]?.join(" or ")}: the rule is not what bites`);
              }
              proved.push({
                union: unionName, type, path: row.path, rule: rid, frame: mutated,
                zodPaths: [...new Set(atTarget.map((issue) => zodPath(issue.path)))],
              });
            }
            if (have()) break;
          }
          if (!have()) {
            skipped.push({
              union: unionName, type, path: row.path, rule: rid,
              why: noSingleValue ? "no single value breaks it" : "no example frame reaches that path",
            });
          }
        }
      }
    }
  }

  const count = (byType) => Object.values(byType)
    .reduce((n, rows) => n + rows.reduce((m, row) => m + row.rules.length, 0), 0);
  const total = count(rules.client) + count(rules.server);
  // The failure this guard exists for: the zod 3 version of this file matched
  // no node on zod 4 and wrote an empty table without complaint. A wire
  // protocol with no value rules at all is never true, so an empty table is
  // the walk reading nothing, not a clean schema.
  if (total === 0 || proved.length === 0) {
    throw new Error("the walk produced no value rules (or proved none): it is reading nothing, "
      + "not a schema without rules. Refusing to write an empty fixture");
  }

  const formatCases = {
    url: probeFormat({
      schema: sig.voiceClientMessageSchema, vectors: unions.client.vectors, type: "set-music",
      path: "state.current.sourceUrl", probes: URL_PROBES, label: "url",
    }),
    guid: probeFormat({
      schema: sig.voiceClientMessageSchema, vectors: unions.client.vectors, type: "call-ring",
      path: "conversationId", probes: GUID_PROBES, label: "guid",
    }),
  };

  // Every refinement the table enforces must arrive pinned, or a client is free
  // to invent its own meaning for it.
  for (const byType of Object.values(rules)) {
    for (const rows of Object.values(byType)) {
      for (const row of rows) {
        for (const rule of row.rules) {
          if (rule.k === "refine" && !refinementCases.has(rule.name)) {
            throw new Error(`${rule.name} is enforced on the wire with no pinned cases`);
          }
        }
      }
    }
  }

  return {
    _generatedBy: "packages/shared/scripts/gen-constraints.mjs",
    note: "Value rules read off the shipped zod schemas, and the violation frames each one was proved illegal with (zod refused them at the named path, for the named kind of reason). Do not edit by hand: pnpm --filter @pqp/shared fixtures:wire regenerates it, and the shared package's tests fail when it is stale.",
    soundboardBuiltinIds: soundboard.SOUNDBOARD_BUILTINS.map((sound) => sound.id),
    counts: { rules: total, violations: proved.length, skipped: skipped.length },
    rules,
    armsWithoutRules,
    violations: proved,
    skipped,
    formatCases,
    refinements: Object.fromEntries(refinementCases),
  };
}

if (isMain(import.meta.url)) {
  const sig = await import(new URL("../src/signaling.ts", import.meta.url).href);
  const soundboard = await import(new URL("../src/soundboard.ts", import.meta.url).href);
  const fixture = generateConstraints({ sig, soundboard });
  const armCount = Object.keys(fixture.rules.client).length + Object.keys(fixture.rules.server).length;
  const pins = Object.values(fixture.refinements).reduce((n, cases) => n + cases.length, 0);
  runCli({
    script: "gen-constraints",
    url: CONSTRAINTS_URL,
    fixture,
    summary: `${fixture.counts.rules} value rules over ${armCount} arms, `
      + `${fixture.counts.violations} proved violations, ${fixture.counts.skipped} unproved, `
      + `${fixture.formatCases.url.length} url and ${fixture.formatCases.guid.length} guid cases, `
      + `${pins} refinement cases over ${Object.keys(fixture.refinements).length} refinements`,
  });
  if (fixture.skipped.length) {
    console.log("rules with no proof (reported, not silent):");
    for (const row of fixture.skipped) console.log(`  ${row.union}/${row.type} ${row.path} ${row.rule}: ${row.why}`);
  }
}
