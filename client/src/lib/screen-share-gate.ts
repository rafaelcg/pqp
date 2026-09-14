/**
 * The one door every screen-share start goes through.
 *
 * A server that may go out as live HLS shows the host a one-time
 * "you are responsible for what you stream" sheet before the first share.
 * `App.tsx` used to gate only the sidebar button; the call-stage button, the
 * "share without sound" retry and the DM stage called `startScreenShare`
 * directly, so the sheet could be skipped by picking a different button
 * (2026-09-07 QA). Every call site now hands its intent to this helper and
 * lets it decide: start now, or ask first and start on confirm with the
 * same intent.
 */
export interface ScreenShareStart<Intent> {
  audio: boolean;
  intent?: Intent;
}

export type ScreenShareGateDecision = "started" | "asked";

export async function gateScreenShareStart<Intent>(input: {
  request: ScreenShareStart<Intent>;
  /** The server the call belongs to; null for a DM, which has no HLS. */
  serverId: string | null;
  /** `LiveHlsConfig.enabled` for that server; null while unanswered. */
  hlsEnabled: boolean | null;
  checkNeedsAck: (serverId: string) => Promise<boolean>;
  /**
   * May return a promise. Callers that need to know whether the capture
   * itself succeeded (not merely that the gate let it through) await the
   * `gateScreenShareStart` call and read that outcome themselves — this
   * function only reports the GATE's decision (`"started"` vs. `"asked"`),
   * never the media result.
   */
  start: (request: ScreenShareStart<Intent>) => void | Promise<void>;
  ask: (serverId: string, request: ScreenShareStart<Intent>) => void;
}): Promise<ScreenShareGateDecision> {
  const { request, serverId } = input;
  if (!serverId) {
    await input.start(request);
    return "started";
  }
  // Null is "not answered yet": ask the old way rather than skip a
  // disclosure by accident. Only an explicit `false` bypasses the sheet.
  if (input.hlsEnabled === false) {
    await input.start(request);
    return "started";
  }
  const needsAck = await input.checkNeedsAck(serverId);
  if (needsAck) {
    input.ask(serverId, request);
    return "asked";
  }
  await input.start(request);
  return "started";
}
