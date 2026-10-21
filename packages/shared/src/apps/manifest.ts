import { z } from "zod";
import { APP_STORE_CAP_CEILING_BYTES } from "./limits.js";

/**
 * The pqp app manifest, version 1.
 *
 * Two shapes share one definition:
 *
 * - `appManifestSchema` is the BUILT manifest the packager writes after it has
 *   hashed the bundle. The server stores it verbatim and never trusts a client
 *   to supply any of it.
 * - `appManifestSourceSchema` is what an author edits: the same object without
 *   `entry.sha256`, `assets[].sha256`, `assets[].bytes` and
 *   `store.screenshots[].sha256`, which the packager fills.
 *
 * `validateAppManifest` is the one door: it runs the schema and then every
 * rule a JSON Schema cannot say (placeholders, translations, copy rules,
 * publisher rules). `schemas/app-manifest-1.schema.json` is the same format for
 * third parties, and a parity test over `fixtures/app-manifests/` keeps the two
 * from drifting apart. Contract notes: `docs/APPS.md`.
 */

export const APP_MANIFEST_VERSION = 1;
/** The version of the sandbox message API (bridge) a manifest may target. */
export const APP_PLATFORM_API = 1;
/** Hard ceiling of the serialized session state the server keeps. */
export const APP_STATE_MAX_BYTES = 16384;
/** Hard ceiling of one ephemeral app event. */
export const APP_EVENT_MAX_BYTES = 1024;
/** Hard ceiling of app events per participant per second. */
export const APP_EVENT_MAX_PER_SECOND = 20;
/** Hard ceiling of state writes per second across a session. */
export const APP_STATE_MAX_WRITES_PER_SECOND = 10;

export const APP_REQUIRED_LOCALES = ["pt-BR", "en", "es"] as const;
export type AppLocale = (typeof APP_REQUIRED_LOCALES)[number];

/** Icons from the pqp icon set. Never uploaded, never a URL. */
export const APP_ICON_IDS = [
  "gamepad",
  "poll",
  "pencil",
  "music",
  "dice",
  "cards",
  "puzzle",
  "trophy",
  "sparkles",
  "flask",
] as const;

export const APP_CATEGORIES = ["game", "tool", "emulator"] as const;
export type AppCategory = (typeof APP_CATEGORIES)[number];

const SLUG = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
// SemVer 2.0.0 without build metadata: two builds that differ only in `+meta`
// would be one version to SemVer but two strings to the (id, version) pin.
// Numeric prerelease identifiers may not have leading zeroes.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const I18N_KEY = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){0,3}$/;
const BUNDLE_PATH = /^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+$/;
const ASSET_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FILE_EXTENSION = /^\.[a-z0-9]{1,8}$/;
const SPDX = /^[A-Za-z0-9.+ ()-]{2,200}$/;
const HTTPS = /^https:\/\//;

const slug = z.string().regex(SLUG);
const semver = z.string().max(64).regex(SEMVER);
const sha256 = z.string().regex(SHA256);
const i18nKey = z.string().regex(I18N_KEY);
const bundlePath = z.string().max(200).regex(BUNDLE_PATH);
const httpsUrl = z.string().regex(HTTPS).url();

function unique<T extends z.ZodTypeAny>(schema: z.ZodArray<T>) {
  return schema.refine((items) => new Set(items).size === items.length, {
    message: "Items must be unique",
    params: { pqp: "schema-unique" },
  });
}

const strings = z
  .record(i18nKey, z.string().min(1).max(240))
  .refine((record) => Object.keys(record).length <= 200, {
    message: "At most 200 strings per locale",
    params: { pqp: "schema-range" },
  });

const assetName = z.string().regex(ASSET_NAME);
const assetBytes = z.number().int().min(1).max(33554432);

const entrySource = z.object({ path: bundlePath }).strict();
const assetsSource = z
  .array(z.object({ name: assetName, path: bundlePath }).strict())
  .max(64)
  .optional();
const storeSource = z
  .object({
    summary: i18nKey.optional(),
    screenshots: z
      .array(z.object({ path: bundlePath, alt: i18nKey }).strict())
      .max(6)
      .optional(),
    homepage: httpsUrl.optional(),
    support: httpsUrl.optional(),
  })
  .strict()
  .optional();

/** The BUILT manifest: what the server stores and the host reads. */
export const appManifestSchema = z
  .object({
    manifestVersion: z.literal(APP_MANIFEST_VERSION),
    id: slug,
    version: semver,
    publisher: slug,
    platformApi: z.number().int().min(1).max(APP_PLATFORM_API),
    name: i18nKey,
    description: i18nKey,
    icon: z.enum(APP_ICON_IDS),
    category: z.enum(APP_CATEGORIES),
    channelTypes: unique(z.array(z.enum(["text", "voice"])).min(1)),
    players: z
      .object({
        min: z.number().int().min(1).max(64),
        max: z.number().int().min(1).max(64),
        spectators: z.boolean(),
        maxSpectators: z.number().int().min(0).max(200).default(50),
      })
      .strict(),
    requires: z
      .object({
        start: z.enum(["USE_APPS", "MANAGE_CHANNELS"]),
        join: z.enum(["VIEW_CHANNEL", "CONNECT"]),
      })
      .strict(),
    capabilities: z
      .object({
        identity: z.enum(["display", "user-id"]),
        share: z.enum(["none", "pane"]),
        localFiles: z
          .object({
            allowed: z.boolean(),
            accept: unique(z.array(z.string().regex(FILE_EXTENSION)).max(16)).optional(),
            maxBytes: z.number().int().min(1).max(67108864).optional(),
          })
          .strict(),
        peer: z.enum(["none", "datachannel"]),
        /**
         * Optional, so every manifest written before it still validates; absent
         * reads as `{ allowed: false }`. When allowed, the app may keep named
         * blobs on the person's device (the `store.*` bridge calls), at most
         * `maxBytes` in total.
         */
        deviceStore: z
          .object({
            allowed: z.boolean(),
            maxBytes: z.number().int().min(1).max(APP_STORE_CAP_CEILING_BYTES).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    hostBound: z.boolean(),
    state: z
      .object({
        maxBytes: z.number().int().min(0).max(APP_STATE_MAX_BYTES),
        maxWritesPerSecond: z
          .number()
          .int()
          .min(1)
          .max(APP_STATE_MAX_WRITES_PER_SECOND)
          .default(APP_STATE_MAX_WRITES_PER_SECOND),
        writers: z.enum(["host", "participants"]).default("participants"),
      })
      .strict(),
    events: z
      .object({
        maxPerSecond: z.number().int().min(0).max(APP_EVENT_MAX_PER_SECOND),
        maxBytes: z.number().int().min(0).max(APP_EVENT_MAX_BYTES),
      })
      .strict(),
    presence: z.object({ phrase: i18nKey, short: i18nKey }).strict(),
    content: z.object({ userText: z.boolean(), userImages: z.boolean() }).strict(),
    notice: i18nKey.optional(),
    entry: z.object({ path: bundlePath, sha256 }).strict(),
    assets: z
      .array(
        z.object({ name: assetName, path: bundlePath, sha256, bytes: assetBytes }).strict(),
      )
      .max(64)
      .optional(),
    sandbox: z
      .object({
        wasm: z.boolean().default(false),
        blobWorkers: z.boolean().default(false),
        localBlobs: z.boolean().default(false),
      })
      .strict()
      .optional(),
    platforms: unique(z.array(z.enum(["web", "desktop", "ios", "android"])).min(1)).default([
      "web",
      "desktop",
    ]),
    license: z
      .object({
        spdx: z.string().regex(SPDX),
        source: httpsUrl,
        notices: bundlePath.optional(),
      })
      .strict(),
    store: z
      .object({
        summary: i18nKey.optional(),
        screenshots: z
          .array(z.object({ path: bundlePath, sha256, alt: i18nKey }).strict())
          .max(6)
          .optional(),
        homepage: httpsUrl.optional(),
        support: httpsUrl.optional(),
      })
      .strict()
      .optional(),
    i18n: z.object({ "pt-BR": strings, en: strings, es: strings }).strict(),
  })
  .strict();

/** The manifest an author writes, before the packager hashes the bundle. */
export const appManifestSourceSchema = appManifestSchema.extend({
  entry: entrySource,
  assets: assetsSource,
  store: storeSource,
});

export type AppManifest = z.infer<typeof appManifestSchema>;
export type AppManifestSource = z.infer<typeof appManifestSourceSchema>;
export type AppCapabilities = AppManifest["capabilities"];

export interface AppManifestIssue {
  /** Dotted path into the manifest, for example `capabilities.peer` or `assets[0].path`. */
  path: string;
  /** Stable machine code, for example `presence-placeholder` or `schema-range`. */
  code: string;
  message: string;
}

export type ValidateAppManifestResult<M> =
  | { ok: true; manifest: M }
  | { ok: false; issues: AppManifestIssue[] };

function formatPath(path: ReadonlyArray<string | number>): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out === "" ? part : `.${part}`;
  }
  return out;
}

function schemaIssues(error: z.ZodError): AppManifestIssue[] {
  const issues: AppManifestIssue[] = [];
  for (const issue of error.issues) {
    const base = formatPath(issue.path);
    switch (issue.code) {
      case "unrecognized_keys":
        for (const key of issue.keys) {
          issues.push({
            path: formatPath([...issue.path, key]),
            code: "schema-unknown-key",
            message: `Unknown property "${key}"`,
          });
        }
        break;
      case "invalid_type":
        issues.push({
          path: base,
          code: issue.received === "undefined" ? "schema-required" : "schema-type",
          message: issue.message,
        });
        break;
      case "invalid_enum_value":
      case "invalid_literal":
        issues.push({ path: base, code: "schema-enum", message: issue.message });
        break;
      case "invalid_string":
        issues.push({ path: base, code: "schema-format", message: issue.message });
        break;
      case "too_small":
      case "too_big":
        issues.push({ path: base, code: "schema-range", message: issue.message });
        break;
      case "custom": {
        const code = (issue.params as { pqp?: string } | undefined)?.pqp ?? "schema-invalid";
        issues.push({ path: base, code, message: issue.message });
        break;
      }
      default:
        issues.push({ path: base, code: "schema-invalid", message: issue.message });
    }
  }
  return issues;
}

const EM_DASH = String.fromCharCode(0x2014);
const PT_BR_VOCE = /(?<![\p{L}\p{N}])voc[eê]s?(?![\p{L}\p{N}])/iu;

type ManifestLike = AppManifest | AppManifestSource;

/**
 * Read one string of a locale. Own properties only: a key such as
 * `constructor` is a legal i18n key and must not find `Object.prototype`.
 */
export function appString(strings: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(strings, key) ? strings[key] : undefined;
}

/** Every i18n key the manifest references, with the path it is referenced from. */
function referencedKeys(manifest: ManifestLike): Array<{ key: string; from: string }> {
  const refs: Array<{ key: string; from: string }> = [
    { key: manifest.name, from: "name" },
    { key: manifest.description, from: "description" },
    { key: manifest.presence.phrase, from: "presence.phrase" },
    { key: manifest.presence.short, from: "presence.short" },
  ];
  if (manifest.notice !== undefined) refs.push({ key: manifest.notice, from: "notice" });
  if (manifest.store?.summary !== undefined) {
    refs.push({ key: manifest.store.summary, from: "store.summary" });
  }
  manifest.store?.screenshots?.forEach((shot, index) => {
    refs.push({ key: shot.alt, from: `store.screenshots[${index}].alt` });
  });
  return refs;
}

function ruleIssues(manifest: ManifestLike): AppManifestIssue[] {
  const issues: AppManifestIssue[] = [];
  const add = (path: string, code: string, message: string) => issues.push({ path, code, message });

  if (manifest.players.max < manifest.players.min) {
    add("players.max", "players-range", "players.max must be greater than or equal to players.min");
  }

  // Translations: every referenced key in every required locale.
  for (const { key, from } of referencedKeys(manifest)) {
    for (const locale of APP_REQUIRED_LOCALES) {
      if (appString(manifest.i18n[locale], key) === undefined) {
        add(
          `i18n.${locale}.${key}`,
          "i18n-missing-key",
          `${from} references "${key}", which is missing in ${locale}`,
        );
      }
    }
  }

  // Presence placeholders.
  for (const locale of APP_REQUIRED_LOCALES) {
    const phrase = appString(manifest.i18n[locale], manifest.presence.phrase);
    if (phrase !== undefined) {
      const parts = phrase.split("{name}");
      const rest = parts.join("");
      if (parts.length !== 2 || rest.includes("{") || rest.includes("}")) {
        add(
          `i18n.${locale}.${manifest.presence.phrase}`,
          "presence-placeholder",
          `presence.phrase in ${locale} must contain exactly one {name} and no other braces`,
        );
      }
    }
    const short = appString(manifest.i18n[locale], manifest.presence.short);
    if (short !== undefined && short.includes("{")) {
      add(
        `i18n.${locale}.${manifest.presence.short}`,
        "presence-short-placeholder",
        `presence.short in ${locale} must not contain a placeholder`,
      );
    }
  }

  // Copy rules over every value.
  for (const locale of APP_REQUIRED_LOCALES) {
    for (const [key, value] of Object.entries(manifest.i18n[locale])) {
      const path = `i18n.${locale}.${key}`;
      if (value.includes(EM_DASH)) {
        add(path, "em-dash", "Strings must not contain an em dash");
      }
      if (locale === "pt-BR" && PT_BR_VOCE.test(value)) {
        add(path, "pt-br-voce", 'pt-BR strings use "tu", never "voc\u00ea"');
      }
    }
  }

  // Publisher rules.
  if (manifest.id.startsWith("pqp-") && manifest.publisher !== "pqp") {
    add("publisher", "publisher-reserved-id", 'Ids starting with "pqp-" require publisher "pqp"');
  }
  if (manifest.category === "emulator" && manifest.publisher !== "pqp") {
    add("publisher", "publisher-emulator", 'Category "emulator" requires publisher "pqp"');
  }

  // Capabilities.
  if (manifest.platformApi === APP_PLATFORM_API && manifest.capabilities.peer !== "none") {
    add("capabilities.peer", "peer-unsupported", 'capabilities.peer must be "none" on platformApi 1');
  }
  const files = manifest.capabilities.localFiles;
  if (files.allowed) {
    if (files.accept === undefined || files.accept.length === 0) {
      add(
        "capabilities.localFiles.accept",
        "local-files-accept-required",
        "localFiles.accept is required when files are allowed",
      );
    }
    if (files.maxBytes === undefined) {
      add(
        "capabilities.localFiles.maxBytes",
        "local-files-max-bytes-required",
        "localFiles.maxBytes is required when files are allowed",
      );
    }
  } else {
    if (files.accept !== undefined) {
      add(
        "capabilities.localFiles.accept",
        "local-files-unexpected",
        "localFiles.accept is only allowed when files are allowed",
      );
    }
    if (files.maxBytes !== undefined) {
      add(
        "capabilities.localFiles.maxBytes",
        "local-files-unexpected",
        "localFiles.maxBytes is only allowed when files are allowed",
      );
    }
  }
  const store = manifest.capabilities.deviceStore;
  if (store?.allowed && store.maxBytes === undefined) {
    add(
      "capabilities.deviceStore.maxBytes",
      "device-store-max-bytes-required",
      "deviceStore.maxBytes is required when the device store is allowed",
    );
  }
  if (store && !store.allowed && store.maxBytes !== undefined) {
    add(
      "capabilities.deviceStore.maxBytes",
      "device-store-unexpected",
      "deviceStore.maxBytes is only allowed when the device store is allowed",
    );
  }
  if (manifest.capabilities.share === "pane" && !manifest.channelTypes.includes("voice")) {
    add("capabilities.share", "share-needs-voice", 'share "pane" requires "voice" in channelTypes');
  }

  // State.
  if (manifest.state.writers === "host" && manifest.state.maxBytes === 0) {
    add("state.writers", "state-writers-no-state", "state.writers is host but state.maxBytes is 0");
  }

  return issues;
}

/**
 * Validate a manifest: the schema first, then every rule the schema cannot
 * express. With `{ source: true }` the author's pre-packaging shape is
 * accepted instead of the built one.
 */
export function validateAppManifest(
  input: unknown,
  opts: { source: true },
): ValidateAppManifestResult<AppManifestSource>;
export function validateAppManifest(
  input: unknown,
  opts?: { source?: false },
): ValidateAppManifestResult<AppManifest>;
export function validateAppManifest(
  input: unknown,
  opts?: { source?: boolean },
): ValidateAppManifestResult<AppManifest> | ValidateAppManifestResult<AppManifestSource> {
  const parsed = (opts?.source ? appManifestSourceSchema : appManifestSchema).safeParse(input);
  if (!parsed.success) return { ok: false, issues: schemaIssues(parsed.error) };
  const issues = ruleIssues(parsed.data);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, manifest: parsed.data } as ValidateAppManifestResult<AppManifest>;
}
