import * as AjvModule from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { fixtureNames, readFixture, readManifestJsonSchema } from "./manifest-fixtures.fixture.js";

/**
 * The JSON Schema file and the zod schema are two statements of one format.
 * Run both over every fixture so they cannot drift apart silently: the JSON
 * Schema must accept what the rules reject (its rules live in `$comment`, not
 * in keywords) and reject exactly what the zod schema rejects.
 */

// ajv ships CommonJS: under NodeNext the class is `default.default` or `default`
// depending on the loader, so take whichever is constructible.
type AjvInstance = { compile(schema: object): ((data: unknown) => boolean) & { errors?: unknown } };
type AjvConstructor = new (opts: object) => AjvInstance;
const mod = AjvModule as unknown as { default?: unknown; Ajv2020?: unknown };
const inner = (mod.default as { default?: unknown } | undefined)?.default;
const Ajv2020 = (
  typeof mod.default === "function" ? mod.default : typeof inner === "function" ? inner : mod.Ajv2020
) as AjvConstructor;

const validate = new Ajv2020({ strict: false, validateFormats: false, allErrors: true }).compile(
  readManifestJsonSchema(),
);

const names = fixtureNames();

describe("JSON Schema parity", () => {
  it("accepts every valid fixture", () => {
    for (const name of names.filter((n) => n.startsWith("valid-"))) {
      expect(validate(readFixture(name)), name).toBe(true);
    }
  });

  it("accepts every invalid-rule fixture, because its rules are validator-only", () => {
    const rule = names.filter((n) => n.startsWith("invalid-rule-"));
    expect(rule.length).toBeGreaterThan(0);
    for (const name of rule) {
      expect(validate(readFixture(name)), name).toBe(true);
    }
  });

  it("rejects every invalid-schema fixture", () => {
    const schema = names.filter((n) => n.startsWith("invalid-schema-"));
    expect(schema.length).toBeGreaterThan(0);
    for (const name of schema) {
      expect(validate(readFixture(name)), name).toBe(false);
    }
  });
});
