/**
 * Structured log lines, one JSON object per line on `console.log`.
 *
 * This Worker has no counterpart to the API's `logEvent` -> Grafana Loki
 * pipeline (`tools/log-shipper/`): a Worker's stdout is Cloudflare's own, read
 * from the dashboard's Logs tab (Real-time Logs / Logpush) or `wrangler tail`,
 * not from this repo's Loki. So the event names below are this Worker's own
 * counters, not a continuation of `voice.hlsPlaylistRejected` (which stays on
 * the API, for origin-side rejections — see WATCH_PARTY.md "Playlists at the
 * edge" for how the two relate and what to watch).
 */

export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  // eslint-disable-next-line no-console -- this IS the observability channel here.
  console.log(JSON.stringify({ event, ts: Date.now(), ...fields }));
}
