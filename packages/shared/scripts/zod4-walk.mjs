/**
 * The one place that knows how to read a zod 4 schema, shared by the two wire
 * fixture generators (`gen-proto-vectors.mjs`, `gen-constraints.mjs`).
 *
 * WHY THIS FILE EXISTS AS ITS OWN MODULE. The generators began life on zod 3
 * (PR #1561), where a node says what it is in `_def.typeName` ("ZodObject") and
 * keeps its rules in `_def.checks`. On zod 4 neither exists: a node says
 * `_zod.def.type` ("object"), its rules are `_zod.def.checks[i]._zod.def` with a
 * `check` discriminator, `.refine()` is a `custom` check on the node it refines
 * (there is no wrapper node any more), and a discriminated union is `type:
 * "union"` with a `discriminator` field. Run on this package, the zod 3 walk
 * matched nothing and wrote "0 value rules over 0 arms" without failing, which
 * is the worst way a contract generator can break: a green run that proves
 * nothing.
 *
 * So the rule here is the inverse of that failure. Every node and every check
 * the walk meets is looked up in a closed table; anything not in the table
 * THROWS, naming the node and the path. Nothing is ever skipped. A new `z.pipe`,
 * `z.record`, `.regex()` or `.transform()` on the wire protocol stops the
 * generator and forces a decision about what the clients must do with it,
 * instead of being quietly absent from the fixtures.
 *
 * What was read from the installed zod (4.6.x), not from memory:
 * - `node._zod.def.type` is one of "string" | "number" | "boolean" | "literal" |
 *   "enum" | "object" | "array" | "union" | "optional" | "nullable" | "default"
 *   | ... and wrappers hold `innerType`;
 * - object: `def.shape` (a plain record) and `def.catchall` (unset unless
 *   `.strict()` / `.passthrough()` / `.catchall()` was used);
 * - array: `def.element`; enum: `def.entries` (a record); literal: `def.values`
 *   (an array, because zod 4 literals may carry several);
 * - union: `def.options`, plus `def.discriminator` for a discriminated one;
 * - `def.checks[i]._zod.def.check` is one of "min_length" | "max_length" |
 *   "length_equals" | "greater_than" | "less_than" | "number_format" |
 *   "string_format" | "custom" | "overwrite" | ...
 */

/** A schema node or check this walk has no rule for. Always a hard stop. */
export class UnrecognisedZodNode extends Error {
  constructor(message) {
    super(message);
    this.name = "UnrecognisedZodNode";
  }
}

/** Nodes that add `optional`, `nullable` or a default around another node. */
const WRAPPERS = new Set(["optional", "nullable", "default"]);
/** Nodes with no children; rules on them come from `def.checks`. */
const LEAVES = new Set(["string", "number", "boolean", "literal", "enum"]);
/** Nodes with children the walk descends into. */
const CONTAINERS = new Set(["object", "array", "union"]);

const label = (where) => (where ? where : "(root)");

/** The `_zod.def` of a node, or a throw when it is not a zod 4 schema at all. */
export function defOf(node, where) {
  const def = node?._zod?.def;
  if (!def || typeof def.type !== "string") {
    throw new UnrecognisedZodNode(
      `not a zod 4 schema at ${label(where)} (no _zod.def.type): is a zod 3 schema being passed in?`,
    );
  }
  return def;
}

/**
 * The node's type, after proving the walk has a rule for it. Every other
 * function here goes through this, so there is no path that reads a node it
 * does not recognise.
 */
export function nodeType(node, where) {
  const def = defOf(node, where);
  const { type } = def;
  if (!WRAPPERS.has(type) && !LEAVES.has(type) && !CONTAINERS.has(type)) {
    throw new UnrecognisedZodNode(
      `zod node type "${type}" at ${label(where)} is not handled by the wire fixture generators `
      + "(packages/shared/scripts/zod4-walk.mjs). Decide what a client must do with it, "
      + "teach the walk, and add a test; it is never skipped.",
    );
  }
  if (def.coerce) {
    throw new UnrecognisedZodNode(
      `${type} at ${label(where)} is coerced (z.coerce.*): it accepts values of another type, `
      + "which is part of the wire contract and is not modelled",
    );
  }
  if (type === "object" && def.catchall !== undefined) {
    throw new UnrecognisedZodNode(
      `object at ${label(where)} has a catchall (strict, passthrough or catchall): `
      + "what it does with unknown keys is part of the wire contract and is not modelled",
    );
  }
  return type;
}

/** Peel optional / nullable / default off a node. A default makes a key optional on input. */
export function unwrap(node, where) {
  let optional = false;
  let nullable = false;
  let hasDefault = false;
  let cur = node;
  for (;;) {
    const type = nodeType(cur, where);
    if (type === "optional") { optional = true; cur = cur._zod.def.innerType; continue; }
    if (type === "default") { optional = true; hasDefault = true; cur = cur._zod.def.innerType; continue; }
    if (type === "nullable") { nullable = true; cur = cur._zod.def.innerType; continue; }
    break;
  }
  return { inner: cur, optional, nullable, hasDefault };
}

/** `[key, node]` pairs of an object node. */
export function objectEntries(node, where) {
  if (nodeType(node, where) !== "object") {
    throw new UnrecognisedZodNode(`expected an object at ${label(where)}`);
  }
  return Object.entries(node._zod.def.shape ?? {});
}

/** The element schema of an array node. */
export function arrayElement(node, where) {
  if (nodeType(node, where) !== "array") {
    throw new UnrecognisedZodNode(`expected an array at ${label(where)}`);
  }
  return node._zod.def.element;
}

/** The options of a union node. */
export function unionOptions(node, where) {
  if (nodeType(node, where) !== "union") {
    throw new UnrecognisedZodNode(`expected a union at ${label(where)}`);
  }
  return node._zod.def.options;
}

/** Every value a literal node accepts. */
export function literalValues(node, where) {
  if (nodeType(node, where) !== "literal") {
    throw new UnrecognisedZodNode(`expected a literal at ${label(where)}`);
  }
  return [...node._zod.def.values];
}

/** Every value an enum node accepts, in declaration order. */
export function enumValues(node, where) {
  if (nodeType(node, where) !== "enum") {
    throw new UnrecognisedZodNode(`expected an enum at ${label(where)}`);
  }
  return Object.values(node._zod.def.entries);
}

/** The checks on a node, each as its own `_zod.def`. */
export function checksOf(node) {
  return (node?._zod?.def?.checks ?? []).map((check) => check._zod.def);
}

/**
 * The arms of a discriminated union as `{ type, schema }`, read off the union
 * itself. Coverage everywhere else is derived from this list, never from a list
 * somebody maintains, which is how a new arm without a vector fails loudly.
 */
export function discriminatedArms(union, where) {
  const def = defOf(union, where);
  if (nodeType(union, where) !== "union" || typeof def.discriminator !== "string") {
    throw new UnrecognisedZodNode(`${label(where)} is not a discriminated union`);
  }
  const key = def.discriminator;
  return def.options.map((arm) => {
    const entries = objectEntries(arm, where);
    const field = entries.find(([name]) => name === key)?.[1];
    if (!field) throw new UnrecognisedZodNode(`an arm of ${label(where)} has no "${key}" field`);
    const values = literalValues(field, `${label(where)}.${key}`);
    if (values.length !== 1) {
      throw new UnrecognisedZodNode(`an arm of ${label(where)} declares ${values.length} "${key}" values`);
    }
    return { type: values[0], schema: arm };
  });
}
