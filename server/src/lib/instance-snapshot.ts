/**
 * WHAT THIS PROCESS IS HOLDING, so the other one can be asked the same thing.
 *
 * Every live counter on `GET /api/admin/metrics` — open sockets, seated voice
 * peers, live HLS sessions, pool pressure — is a property of ONE process. That
 * was the whole truth while one machine answered every request. With two
 * behind `api.pqp.gg` the dashboard shows whichever machine the request landed
 * on, and refreshing flips between two halves of the answer with nothing on
 * the page to say so.
 *
 * The fix is small on purpose. The voice registry already writes one row per
 * instance every 15 seconds (`voice_instances`, the liveness lease); this adds
 * a `snapshot` column to that same statement, so the cost of a cluster-wide
 * reading is zero extra round trips on the write side and one small SELECT on
 * the read side. The endpoint keeps its local block verbatim as `runtime` and
 * adds the SUM as `cluster`, because the two answer different questions: "is
 * THIS machine in trouble" and "how big is the service right now".
 *
 * Registration rather than an import because the numbers live in `ws/voice.ts`
 * and `voice/hls-egress.ts`, both of which already import the registry. This
 * module is the seam that keeps the arrow pointing one way.
 */

export interface InstanceSnapshot {
  /** Open WebSockets on this process. */
  sockets: number;
  /** Of those, the ones that negotiated permessage-deflate. */
  compressedSockets: number;
  /** Voice peers this process holds in its own map (not the registry's rows). */
  voiceParticipants: number;
  /** Live HLS sessions this process is transcoding. */
  hlsSessions: number;
  /** Pool connections checked out right now, and the configured ceiling. */
  poolBusy: number;
  poolMax: number;
  /** `WORKER_MODE` as resolved, so a worker row is not mistaken for a machine
   * that is serving nobody. */
  role: string;
  /** `APP_VERSION`, so a half-deployed cluster is visible rather than averaged. */
  version: string | null;
}

let provider: (() => InstanceSnapshot) | null = null;

/** Called once by `index.ts` after the sockets and the pool exist. */
export function registerInstanceSnapshot(read: () => InstanceSnapshot): void {
  provider = read;
}

/**
 * The snapshot, or null when nothing registered one (the worker process, a
 * test, anything that boots the registry without sockets). Defended, because
 * this runs inside the heartbeat and a heartbeat that throws is a machine
 * that looks dead.
 */
export function currentInstanceSnapshot(): InstanceSnapshot | null {
  try {
    return provider?.() ?? null;
  } catch {
    return null;
  }
}

/** Test hook. */
export function resetInstanceSnapshot(): void {
  provider = null;
}
