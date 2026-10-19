import { createHash } from "node:crypto";
import { validateAppManifest, type AppManifest } from "@pqp/shared";

/**
 * Test support for the apps tests. Not part of the build (`tsconfig.build.json`
 * excludes it): a fixture manifest and the helpers that put an app into a
 * scratch database the way the catalog loader would.
 */

export const TEST_SHA = "a".repeat(64);

export interface TestManifestOptions {
  id?: string;
  version?: string;
  category?: AppManifest["category"];
  channelTypes?: AppManifest["channelTypes"];
  players?: Partial<AppManifest["players"]>;
  hostBound?: boolean;
  requires?: Partial<AppManifest["requires"]>;
  state?: Partial<AppManifest["state"]>;
  events?: Partial<AppManifest["events"]>;
  notice?: string;
  publisher?: string;
  assets?: AppManifest["assets"];
  capabilities?: Partial<AppManifest["capabilities"]>;
}

/** A valid built manifest, with the knobs the session tests turn. */
export function testManifest(options: TestManifestOptions = {}): AppManifest {
  const id = options.id ?? "pqp-eco";
  const manifest = {
    manifestVersion: 1,
    id,
    version: options.version ?? "1.0.0",
    publisher: options.publisher ?? "pqp",
    platformApi: 1,
    name: "name",
    description: "description",
    icon: "sparkles",
    category: options.category ?? "tool",
    channelTypes: options.channelTypes ?? ["text", "voice"],
    players: { min: 1, max: 8, spectators: true, maxSpectators: 50, ...options.players },
    requires: { start: "USE_APPS", join: "VIEW_CHANNEL", ...options.requires },
    capabilities: {
      identity: "display",
      share: "none",
      localFiles: { allowed: false },
      peer: "none",
      ...options.capabilities,
    },
    hostBound: options.hostBound ?? false,
    state: { maxBytes: 4096, maxWritesPerSecond: 10, writers: "participants", ...options.state },
    events: { maxPerSecond: 10, maxBytes: 256, ...options.events },
    presence: { phrase: "presence.phrase", short: "presence.short" },
    content: { userText: false, userImages: false },
    ...(options.notice !== undefined ? { notice: "notice" } : {}),
    entry: { path: "index.html", sha256: TEST_SHA },
    ...(options.assets ? { assets: options.assets } : {}),
    license: { spdx: "AGPL-3.0-only", source: "https://github.com/rafaelcg/pqp" },
    i18n: {
      "pt-BR": {
        name: "Eco",
        description: "Um app de teste que repete o que tu manda.",
        "presence.phrase": "{name} tá no Eco",
        "presence.short": "No Eco",
        ...(options.notice !== undefined ? { notice: options.notice } : {}),
      },
      en: {
        name: "Eco",
        description: "A test app that echoes what you send.",
        "presence.phrase": "{name} is in Eco",
        "presence.short": "In Eco",
        ...(options.notice !== undefined ? { notice: options.notice } : {}),
      },
      es: {
        name: "Eco",
        description: "Una app de prueba que repite lo que mandas.",
        "presence.phrase": "{name} está en Eco",
        "presence.short": "En Eco",
        ...(options.notice !== undefined ? { notice: options.notice } : {}),
      },
    },
  };
  const checked = validateAppManifest(manifest);
  if (!checked.ok) {
    throw new Error(`test manifest invalid: ${JSON.stringify(checked.issues)}`);
  }
  return checked.manifest;
}

/** A catalog entry for a manifest, with a real sha256 of its JSON. */
export function testCatalogEntry(manifest: AppManifest): {
  manifest: AppManifest;
  manifestSha256: string;
} {
  return {
    manifest,
    manifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
  };
}
