import type { BridgeErrorCode } from "@pqp/shared";

/** Every code the host may answer with. Exhaustive on purpose: a new code in the contract fails the typecheck here. */
const ERROR_CODES: Record<BridgeErrorCode, true> = {
  "not-allowed": true,
  "not-host": true,
  "too-large": true,
  "rate-limited": true,
  "stale-rev": true,
  cancelled: true,
  unavailable: true,
  ended: true,
  invalid: true,
};

export function isErrorCode(value: unknown): value is BridgeErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_CODES, value);
}

/**
 * What a rejected call throws. `code` is one of the bridge's error codes:
 * `not-allowed`, `not-host`, `too-large`, `rate-limited`, `stale-rev`,
 * `cancelled`, `unavailable`, `ended` or `invalid`. A call the host never
 * answered within the request timeout rejects with `unavailable`.
 */
export class PqpAppError extends Error {
  readonly code: BridgeErrorCode;

  constructor(code: BridgeErrorCode, message?: string) {
    super(message ?? `pqp app call failed: ${code}`);
    this.name = "PqpAppError";
    this.code = code;
  }
}
