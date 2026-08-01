/**
 * Minimal structured logger: one greppable line per event, `key=value` fields.
 * Example: `[pqp] ws.close connId=42 userId=… code=1006 wasInVoice=true`
 */
export function logEvent(
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const suffix = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return `${key}=${text}`;
    })
    .join(" ");
  console.log(`[pqp] ${event}${suffix ? ` ${suffix}` : ""}`);
}

let connectionCounter = 0;

/** Short, monotonic id to correlate a socket's lifecycle across log lines. */
export function nextConnectionId(): number {
  connectionCounter += 1;
  return connectionCounter;
}
