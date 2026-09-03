import { fetchIceServers } from "@/lib/api";
import type { RealtimeTransport } from "@/lib/realtime";
import { getApiBaseUrl } from "@/lib/utils";

/**
 * The connection check: five yes/no questions a stuck client can answer for
 * itself, in the order a person would debug them, each with the fix in
 * plain words.
 *
 * WHY. "Fica conectando" (2 Sep 2026) on somebody's PC app and phone app,
 * on two networks. The API was healthy for everybody else. From the client
 * that could have been a refused session, a token fetch that never returns
 * (Clerk blocked by a DNS filter), a firewall that lets HTTPS through but
 * not WebSockets, or a network with no path to a TURN relay. All four look
 * identical on screen: a spinner. This tells them apart.
 *
 * Each check is bounded; the whole run is a few seconds, never a hang. Pure
 * functions decide the verdicts so the mapping is testable without a
 * browser.
 */

export type CheckId = "api" | "token" | "socket" | "stun" | "turn";
export type CheckVerdict = "ok" | "fail" | "skip";

export interface CheckResult {
  id: CheckId;
  verdict: CheckVerdict;
  /** Short machine detail for the copyable report (never localized). */
  detail: string;
  ms: number;
}

export interface DoctorReport {
  results: CheckResult[];
  /** The one thing to do first, derived from the results. */
  advice: Advice;
  at: string;
}

export type Advice =
  | "none"
  | "signInAgain"
  | "apiUnreachable"
  | "tokenStuck"
  | "socketBlocked"
  | "relayBlocked"
  | "noUdp";

const STEP_TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Pure: what to tell the person, given the five answers. */
export function adviseFrom(
  results: readonly CheckResult[],
  unauthorizedStreak: number,
): Advice {
  const by = new Map(results.map((r) => [r.id, r] as const));
  const api = by.get("api");
  const token = by.get("token");
  const socket = by.get("socket");
  const stun = by.get("stun");
  const turn = by.get("turn");
  if (api?.verdict === "fail") {
    return "apiUnreachable";
  }
  if (token?.verdict === "fail") {
    return token.detail === "timeout" ? "tokenStuck" : "signInAgain";
  }
  if (socket?.verdict === "fail") {
    return unauthorizedStreak >= 2 ? "signInAgain" : "socketBlocked";
  }
  if (turn?.verdict === "fail" && stun?.verdict === "fail") {
    return "noUdp";
  }
  if (turn?.verdict === "fail") {
    return "relayBlocked";
  }
  return "none";
}

interface DoctorInput {
  transport: Pick<RealtimeTransport, "getStatus" | "getLastClose" | "getUnauthorizedStreak">;
  getToken: () => Promise<string | null>;
  /** Injected for tests; defaults to the real ones. */
  fetchImpl?: typeof fetch;
  peerConnection?: typeof RTCPeerConnection;
  iceServers?: () => Promise<RTCIceServer[]>;
}

async function timed<T>(
  run: () => Promise<T>,
): Promise<{ value: T | null; error: unknown; ms: number }> {
  const started = Date.now();
  try {
    const value = await run();
    return { value, error: null, ms: Date.now() - started };
  } catch (error) {
    return { value: null, error, ms: Date.now() - started };
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message === "timeout" ? "timeout" : error.name || error.message;
  }
  return String(error);
}

/**
 * Gather ICE candidates against the given servers and say whether a
 * server-reflexive (STUN) and a relay (TURN) candidate showed up. A relay
 * candidate is the proof that a call could work from behind this network;
 * no candidates at all usually means UDP is blocked outright.
 */
async function probeIce(
  Peer: typeof RTCPeerConnection,
  servers: RTCIceServer[],
  policy: RTCIceTransportPolicy,
  ms: number,
): Promise<{ srflx: boolean; relay: boolean; host: boolean }> {
  const pc = new Peer({ iceServers: servers, iceTransportPolicy: policy });
  const seen = { srflx: false, relay: false, host: false };
  try {
    pc.createDataChannel("probe");
    const done = new Promise<void>((resolve) => {
      pc.onicecandidate = (event) => {
        const candidate = event.candidate?.candidate ?? "";
        if (!event.candidate) {
          resolve();
          return;
        }
        if (candidate.includes(" typ relay")) {
          seen.relay = true;
        } else if (candidate.includes(" typ srflx")) {
          seen.srflx = true;
        } else if (candidate.includes(" typ host")) {
          seen.host = true;
        }
        // Relay is the answer we came for; stop as soon as we have it.
        if (policy === "relay" && seen.relay) {
          resolve();
        }
        if (policy === "all" && seen.srflx) {
          resolve();
        }
      };
    });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await withTimeout(done, ms).catch(() => {});
    return seen;
  } finally {
    pc.close();
  }
}

export async function runConnectionChecks(input: DoctorInput): Promise<DoctorReport> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const Peer =
    input.peerConnection ??
    (typeof RTCPeerConnection === "undefined" ? undefined : RTCPeerConnection);
  const results: CheckResult[] = [];

  // 1. Is the API reachable at all over HTTPS? An `/api` route rather than
  // `/health`: only `/api/*` answers with CORS headers, and without them a
  // browser reports a perfectly healthy server as a TypeError. Any HTTP
  // status counts, 401 included; the question is reachability, not auth.
  const api = await timed(() =>
    withTimeout(
      fetchImpl(`${getApiBaseUrl()}/api/voice/backend`, { cache: "no-store" }),
      STEP_TIMEOUT_MS,
    ),
  );
  results.push({
    id: "api",
    verdict: api.value ? "ok" : "fail",
    detail: api.value ? `HTTP ${api.value.status}` : describeError(api.error),
    ms: api.ms,
  });

  // 2. Can we get a session token in reasonable time?
  const token = await timed(() =>
    withTimeout(input.getToken(), STEP_TIMEOUT_MS),
  );
  const hasToken = Boolean(token.value);
  results.push({
    id: "token",
    verdict: hasToken ? "ok" : "fail",
    detail: token.value
      ? "present"
      : token.error
        ? describeError(token.error)
        : "null",
    ms: token.ms,
  });

  // 3. The realtime socket, as the transport sees it right now.
  const status = input.transport.getStatus();
  const lastClose = input.transport.getLastClose();
  results.push({
    id: "socket",
    verdict: status === "online" ? "ok" : "fail",
    detail:
      status +
      (lastClose ? ` (last close ${lastClose.code}${lastClose.reason ? ` ${lastClose.reason}` : ""})` : ""),
    ms: 0,
  });

  // 4 + 5. Can this network reach a STUN server and a TURN relay?
  if (!Peer) {
    results.push({ id: "stun", verdict: "skip", detail: "no WebRTC", ms: 0 });
    results.push({ id: "turn", verdict: "skip", detail: "no WebRTC", ms: 0 });
  } else {
    let servers: RTCIceServer[] = [];
    if (hasToken) {
      const fetched = await timed(() =>
        withTimeout(
          input.iceServers
            ? input.iceServers()
            : fetchIceServers().then((r) => r.iceServers as RTCIceServer[]),
          STEP_TIMEOUT_MS,
        ),
      );
      servers = fetched.value ?? [];
    }
    const stunServers = servers.filter((s) =>
      (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => u.startsWith("stun:")),
    );
    const turnServers = servers.filter((s) =>
      (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => u.startsWith("turn")),
    );
    const stun = await timed(() =>
      probeIce(
        Peer,
        stunServers.length ? stunServers : [{ urls: "stun:stun.cloudflare.com:3478" }],
        "all",
        STEP_TIMEOUT_MS,
      ),
    );
    results.push({
      id: "stun",
      verdict: stun.value?.srflx ? "ok" : "fail",
      detail: stun.value
        ? `host=${stun.value.host} srflx=${stun.value.srflx}`
        : describeError(stun.error),
      ms: stun.ms,
    });
    if (turnServers.length === 0) {
      results.push({
        id: "turn",
        verdict: "skip",
        detail: hasToken ? "no relay configured" : "no token",
        ms: 0,
      });
    } else {
      const turn = await timed(() =>
        probeIce(Peer, turnServers, "relay", STEP_TIMEOUT_MS),
      );
      results.push({
        id: "turn",
        verdict: turn.value?.relay ? "ok" : "fail",
        detail: turn.value ? `relay=${turn.value.relay}` : describeError(turn.error),
        ms: turn.ms,
      });
    }
  }

  return {
    results,
    advice: adviseFrom(results, input.transport.getUnauthorizedStreak()),
    at: new Date().toISOString(),
  };
}

/** One line per check, for pasting into a support chat. */
export function formatReport(report: DoctorReport, appVersion: string): string {
  const lines = [
    `pqp connection check ${report.at} (${appVersion})`,
    ...report.results.map(
      (r) => `${r.verdict === "ok" ? "OK " : r.verdict === "fail" ? "FAIL" : "SKIP"} ${r.id.padEnd(6)} ${r.detail} ${r.ms ? `${r.ms}ms` : ""}`.trimEnd(),
    ),
    `advice: ${report.advice}`,
    typeof navigator === "undefined" ? "" : navigator.userAgent,
  ];
  return lines.filter(Boolean).join("\n");
}
