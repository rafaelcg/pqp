import { z } from "zod";
import {
  APP_EVENT_MAX_BYTES,
  APP_JSON_MAX_DEPTH,
  APP_STATE_MAX_BYTES,
} from "./limits.js";

/** A value that survives `JSON.stringify` and `JSON.parse` unchanged. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const textEncoder = new TextEncoder();

/** Serialized size in UTF-8 bytes. Only call it on a value `jsonProblem` accepted. */
export function jsonByteLength(value: JsonValue): number {
  return textEncoder.encode(JSON.stringify(value)).length;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Why a value is not plain JSON, or null when it is. Rejects undefined (also
 * inside arrays and holes), functions, symbols, bigints, NaN, Infinity,
 * class instances (Date, Map, typed arrays, ...) and nesting past
 * `APP_JSON_MAX_DEPTH`. A cycle is caught by the depth limit.
 */
export function jsonProblem(value: unknown, depth = 0): string | null {
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
    case "string":
      return null;
    case "number":
      return Number.isFinite(value) ? null : "numbers must be finite";
    case "object":
      break;
    default:
      return `${typeof value} is not a JSON value`;
  }
  if (depth >= APP_JSON_MAX_DEPTH) {
    return `nesting is deeper than ${APP_JSON_MAX_DEPTH}`;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (!(i in value)) return "arrays must not have holes";
      const problem = jsonProblem(value[i], depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  const object = value as object;
  if (!isPlainObject(object)) return "only plain objects are JSON values";
  for (const key of Object.keys(object)) {
    const problem = jsonProblem((object as Record<string, unknown>)[key], depth + 1);
    if (problem) return problem;
  }
  return null;
}

/**
 * A JSON value, optionally capped at `maxBytes` of serialized UTF-8. The size
 * check runs inside the schema, so every consumer gets it for free.
 */
export function jsonValueSchema(
  maxBytes?: number,
): z.ZodType<JsonValue, z.ZodTypeDef, JsonValue> {
  return z.unknown().superRefine((value, ctx) => {
    const problem = jsonProblem(value);
    if (problem) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
      return;
    }
    if (maxBytes !== undefined && jsonByteLength(value as JsonValue) > maxBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `serialized value is larger than ${maxBytes} bytes`,
      });
    }
  }) as unknown as z.ZodType<JsonValue, z.ZodTypeDef, JsonValue>;
}

/** Any JSON value, no size cap (use the bounded ones at the edges). */
export const jsonSchema = jsonValueSchema();

/** A JSON Merge Patch (RFC 7396) document: any JSON value, `null` deletes a key. */
export const statePatchSchema = jsonValueSchema(APP_STATE_MAX_BYTES);

/** The full session state value as the server keeps it. */
export const stateValueSchema = jsonValueSchema(APP_STATE_MAX_BYTES);

/** Payload of one ephemeral event. */
export const eventDataSchema = jsonValueSchema(APP_EVENT_MAX_BYTES);

/** Event names an app invents: lowercase, dots and dashes, 1 to 32 characters. */
export const eventNameSchema = z.string().regex(/^[a-z][a-z0-9.-]{0,31}$/);

/** Random per-session seat id. Never derived from a pqp user id. */
export const seatIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,32}$/);

/** Derived per-app identity, present only for people who consented. */
export const appUserIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);

export const appRoleSchema = z.enum(["player", "spectator"]);
export type AppRole = z.infer<typeof appRoleSchema>;

/** `app_sessions.end_reason` in data-model.sql. */
export const APP_END_REASONS = [
  "host",
  "moderator",
  "operator",
  "idle",
  "host-gone",
  "app-disabled",
  "empty",
  "max-duration",
  "channel-gone",
  "flag-off",
] as const;
export const appEndReasonSchema = z.enum(APP_END_REASONS);
export type AppEndReason = z.infer<typeof appEndReasonSchema>;

/** Revision counter of the session state. */
export const stateRevSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** State as it travels: the revision and the value it belongs to. */
export const stateSnapshotSchema = z
  .object({ rev: stateRevSchema, value: stateValueSchema })
  .strict();
export type AppStateSnapshot = z.infer<typeof stateSnapshotSchema>;
