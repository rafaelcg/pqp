import { describe, expect, it } from "vitest";
import {
  APP_EVENT_MAX_BYTES,
  APP_EVENT_MAX_PER_SECOND,
  APP_ICON_IDS,
  APP_MANIFEST_VERSION,
  APP_PLATFORM_API,
  APP_REQUIRED_LOCALES,
  APP_STATE_MAX_BYTES,
  APP_STATE_MAX_WRITES_PER_SECOND,
  validateAppManifest,
} from "./manifest.js";
import { fixtureNames, readFixture, readManifestJsonSchema } from "./manifest-fixtures.fixture.js";

interface Expected {
  code: string;
  path: string;
}

/** What each invalid fixture must be rejected for. Every one is one issue. */
const EXPECTED: Record<string, Expected> = {
  "invalid-schema-unknown-property": { code: "schema-unknown-key", path: "extra" },
  "invalid-schema-bad-semver": { code: "schema-format", path: "version" },
  "invalid-schema-uppercase-id": { code: "schema-format", path: "id" },
  "invalid-schema-semver-prerelease-leading-zero": { code: "schema-format", path: "version" },
  "invalid-schema-semver-build-metadata": { code: "schema-format", path: "version" },
  "invalid-schema-bundle-path-dotdot": { code: "schema-format", path: "entry.path" },
  "invalid-schema-state-max-bytes": { code: "schema-range", path: "state.maxBytes" },
  "invalid-schema-events-max-bytes": { code: "schema-range", path: "events.maxBytes" },
  "invalid-schema-missing-locale-es": { code: "schema-required", path: "i18n.es" },
  "invalid-schema-icon-not-in-set": { code: "schema-enum", path: "icon" },
  "invalid-rule-presence-no-name": {
    code: "presence-placeholder",
    path: "i18n.pt-BR.presence.phrase",
  },
  "invalid-rule-presence-two-names": { code: "presence-placeholder", path: "i18n.en.presence.phrase" },
  "invalid-rule-em-dash-es": { code: "em-dash", path: "i18n.es.description" },
  "invalid-rule-voce-pt-br": { code: "pt-br-voce", path: "i18n.pt-BR.description" },
  "invalid-rule-missing-key-en": { code: "i18n-missing-key", path: "i18n.en.presence.short" },
  "invalid-rule-emulator-publisher": { code: "publisher-emulator", path: "publisher" },
  "invalid-rule-pqp-id-publisher": { code: "publisher-reserved-id", path: "publisher" },
  "invalid-rule-peer-datachannel": { code: "peer-unsupported", path: "capabilities.peer" },
  "invalid-rule-share-pane-no-voice": { code: "share-needs-voice", path: "capabilities.share" },
  "invalid-rule-local-files-no-accept": {
    code: "local-files-accept-required",
    path: "capabilities.localFiles.accept",
  },
  "invalid-rule-players-max-lt-min": { code: "players-range", path: "players.max" },
};

const names = fixtureNames();
const valid = names.filter((name) => name.startsWith("valid-"));
const invalid = names.filter((name) => name.startsWith("invalid-"));

/** Deep copy with the packager's hashes removed: the shape an author writes. */
function toSource(built: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(built)) as {
    entry?: { sha256?: string };
    assets?: Array<{ sha256?: string; bytes?: number }>;
    store?: { screenshots?: Array<{ sha256?: string }> };
  };
  delete copy.entry?.sha256;
  for (const asset of copy.assets ?? []) {
    delete asset.sha256;
    delete asset.bytes;
  }
  for (const shot of copy.store?.screenshots ?? []) delete shot.sha256;
  return copy;
}

describe("fixtures", () => {
  it("has fixtures of every kind", () => {
    expect(valid.length).toBeGreaterThanOrEqual(3);
    expect(invalid.length).toBeGreaterThan(0);
    expect(names).toEqual([...valid, ...invalid].sort());
  });

  it("states an expectation for every invalid fixture, and none for a missing one", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...invalid].sort());
  });
});

describe("validateAppManifest", () => {
  it.each(valid)("accepts %s", (name) => {
    const result = validateAppManifest(readFixture(name));
    expect(result).toMatchObject({ ok: true });
  });

  it.each(invalid)("rejects %s with the expected code and path", (name) => {
    const result = validateAppManifest(readFixture(name));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const expected = EXPECTED[name];
    expect(expected).toBeDefined();
    expect(result.issues.map(({ code, path }) => ({ code, path }))).toEqual([expected]);
  });

  it.each(valid)("accepts %s as an author source with the hashes stripped", (name) => {
    const result = validateAppManifest(toSource(readFixture(name)), { source: true });
    expect(result).toMatchObject({ ok: true });
  });

  it.each(valid)("rejects %s as a source when it still carries hashes", (name) => {
    const result = validateAppManifest(readFixture(name), { source: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.every((issue) => issue.code === "schema-unknown-key")).toBe(true);
  });

  it("rejects a stripped manifest as a BUILT one", () => {
    const result = validateAppManifest(toSource(readFixture("valid-locadora")));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toContain("entry.sha256");
  });

  it("fills the documented defaults", () => {
    const eco = readFixture("valid-eco") as Record<string, unknown>;
    const stripped = JSON.parse(JSON.stringify(eco)) as {
      players: Record<string, unknown>;
      state: Record<string, unknown>;
    };
    delete stripped.players.maxSpectators;
    delete stripped.state.maxWritesPerSecond;
    delete stripped.state.writers;
    const result = validateAppManifest(stripped);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.players.maxSpectators).toBe(50);
    expect(result.manifest.state.maxWritesPerSecond).toBe(10);
    expect(result.manifest.state.writers).toBe("participants");
    expect(result.manifest.platforms).toEqual(["web", "desktop"]);
  });

  it("rejects non-objects without throwing", () => {
    for (const input of [null, undefined, 3, "x", []]) {
      expect(validateAppManifest(input).ok).toBe(false);
    }
  });

  it("reports several rule failures together", () => {
    const eco = JSON.parse(JSON.stringify(readFixture("valid-eco"))) as {
      players: { min: number; max: number };
      capabilities: { peer: string };
    };
    eco.players.min = 4;
    eco.players.max = 2;
    eco.capabilities.peer = "datachannel";
    const result = validateAppManifest(eco);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code).sort()).toEqual(["peer-unsupported", "players-range"]);
  });

  it("rejects short presence with a placeholder, and a host-only writer with no state", () => {
    const eco = JSON.parse(JSON.stringify(readFixture("valid-eco"))) as {
      i18n: { es: Record<string, string> };
      state: { maxBytes: number; writers: string };
    };
    eco.i18n.es["presence.short"] = "En {name}";
    eco.state.maxBytes = 0;
    eco.state.writers = "host";
    const result = validateAppManifest(eco);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code).sort()).toEqual([
      "presence-short-placeholder",
      "state-writers-no-state",
    ]);
  });

  it("rejects localFiles fields when files are not allowed", () => {
    const eco = JSON.parse(JSON.stringify(readFixture("valid-eco"))) as {
      capabilities: { localFiles: Record<string, unknown> };
    };
    eco.capabilities.localFiles = { allowed: false, accept: [".txt"], maxBytes: 10 };
    const result = validateAppManifest(eco);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(["local-files-unexpected", "local-files-unexpected"]);
  });

  it("accepts SemVer prereleases that are valid and refuses leading zeroes", () => {
    const eco = JSON.parse(JSON.stringify(readFixture("valid-eco"))) as { version: string };
    for (const version of ["0.0.1", "1.0.0-0", "1.0.0-alpha.1", "1.0.0-0a", "1.0.0-x-y.7", "10.20.30-rc.10"]) {
      eco.version = version;
      expect(validateAppManifest(eco).ok, version).toBe(true);
    }
    for (const version of ["01.0.0", "1.0.0-01", "1.0.0-alpha.01", "1.0.0-", "1.0", "v1.0.0", "1.0.0+b"]) {
      eco.version = version;
      expect(validateAppManifest(eco).ok, version).toBe(false);
    }
  });

  it("does not throw on an i18n key that is also an Object.prototype property", () => {
    const eco = JSON.parse(JSON.stringify(readFixture("valid-eco"))) as {
      presence: { phrase: string; short: string };
      name: string;
    };
    eco.presence.phrase = "constructor";
    eco.presence.short = "toString";
    eco.name = "hasOwnProperty";
    const result = validateAppManifest(eco);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(new Set(result.issues.map((issue) => issue.code))).toEqual(new Set(["i18n-missing-key"]));
    expect(result.issues).toHaveLength(9);
  });

  it("matches the pt-BR voce rule as a word, not inside another word", () => {
    const eco = JSON.parse(JSON.stringify(readFixture("valid-eco"))) as {
      i18n: { "pt-BR": Record<string, string> };
    };
    eco.i18n["pt-BR"].description = "Um app que avoca o voceiro";
    expect(validateAppManifest(eco).ok).toBe(true);
    eco.i18n["pt-BR"].description = "Quando VOCE quiser";
    expect(validateAppManifest(eco).ok).toBe(false);
  });
});

describe("constants", () => {
  it("states the contract limits", () => {
    expect(APP_MANIFEST_VERSION).toBe(1);
    expect(APP_PLATFORM_API).toBe(1);
    expect(APP_STATE_MAX_BYTES).toBe(16384);
    expect(APP_EVENT_MAX_BYTES).toBe(1024);
    expect(APP_EVENT_MAX_PER_SECOND).toBe(20);
    expect(APP_STATE_MAX_WRITES_PER_SECOND).toBe(10);
    expect([...APP_REQUIRED_LOCALES]).toEqual(["pt-BR", "en", "es"]);
  });

  it("keeps the icon set in step with the JSON Schema", () => {
    const schema = readManifestJsonSchema() as {
      properties: { icon: { enum: string[] } };
    };
    expect([...APP_ICON_IDS]).toEqual(schema.properties.icon.enum);
  });
});
