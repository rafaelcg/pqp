import { describe, expect, it } from "vitest";
import {
  APP_END_REASONS,
  bridgeErrorCodeSchema,
  type AppEndReason as SharedAppEndReason,
  type AppRole as SharedAppRole,
  type BridgeConnectionStatus as SharedConnectionStatus,
  type BridgeErrorCode as SharedErrorCode,
  type BridgeHello as SharedHello,
  type BridgeParticipant as SharedParticipant,
  type BridgeTheme as SharedTheme,
  type JsonValue as SharedJson,
} from "@pqp/shared";
import { isErrorCode } from "./errors.js";
import type {
  AppEndReason,
  AppRole,
  BridgeConnectionStatus,
  BridgeErrorCode,
  BridgeHello,
  BridgeParticipant,
  BridgeTheme,
  JsonValue,
} from "./types.js";

/**
 * The SDK writes the wire types out itself so its published `.d.ts` needs no
 * unpublished package. This file is what keeps that copy honest: every pair is
 * checked for assignability in both directions at typecheck time, so a field
 * added on either side turns `pnpm typecheck` red.
 */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same = <_T extends true>() => true;

describe("the SDK's copy of the wire types matches @pqp/shared", () => {
  it("is assignable both ways for every type", () => {
    expect(same<Mutual<JsonValue, SharedJson>>()).toBe(true);
    expect(same<Mutual<BridgeErrorCode, SharedErrorCode>>()).toBe(true);
    expect(same<Mutual<BridgeConnectionStatus, SharedConnectionStatus>>()).toBe(true);
    expect(same<Mutual<BridgeTheme, SharedTheme>>()).toBe(true);
    expect(same<Mutual<AppRole, SharedAppRole>>()).toBe(true);
    expect(same<Mutual<AppEndReason, SharedAppEndReason>>()).toBe(true);
    expect(same<Mutual<BridgeParticipant, SharedParticipant>>()).toBe(true);
    expect(same<Mutual<BridgeHello, SharedHello>>()).toBe(true);
  });

  it("knows every error code the contract has, and no other", () => {
    for (const code of bridgeErrorCodeSchema.options) expect(isErrorCode(code), code).toBe(true);
    expect(isErrorCode("not-a-code")).toBe(false);
  });

  it("lists the same end reasons", () => {
    const reasons: readonly AppEndReason[] = APP_END_REASONS;
    expect(reasons).toHaveLength(10);
  });
});
