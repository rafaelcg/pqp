/**
 * Structured log lines, one JSON object per line on `console.log`. A Worker's
 * stdout is Cloudflare's own (dashboard Logs tab, `wrangler tail`, Logpush),
 * not this repo's Loki, so these event names are this Worker's own counters.
 */

export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  // eslint-disable-next-line no-console -- this IS the observability channel here.
  console.log(JSON.stringify({ event, ts: Date.now(), ...fields }));
}
