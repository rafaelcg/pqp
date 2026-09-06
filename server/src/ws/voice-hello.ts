import {
  INSTANCE_ID,
  isBusEnabled,
  observeBusFrames,
  publishToCluster,
  subscribeToCluster,
} from "../lib/bus.js";
import { logEvent } from "../lib/log.js";
import { voiceConfigHash } from "../voice/registry.js";

/**
 * `voice.hello`: the one voice frame on the bus in M1, and it carries no
 * room state at all. It does two jobs, both about catching a misconfigured
 * cluster at boot instead of at the first split call:
 *
 * 1. THE SELF-ECHO CHECK. Postgres delivers a NOTIFY back to the session that
 *    sent it, so after the transport reports connected we publish a hello and
 *    expect to see our own frame within `SELF_ECHO_TIMEOUT_MS`. A `DATABASE_URL`
 *    pointing at a transaction-mode pooler (Supabase :6543, the `pgbouncer.`
 *    MPG host) accepts LISTEN and never delivers anything, and nothing else in
 *    the transport can tell. Today this logs loudly (`bus.selfEchoMissing`);
 *    failing `/health` on it is M5 of the plan, once there is a sibling
 *    machine to fail over to.
 *
 * 2. CONFIG DRIFT. The frame carries `voiceConfigHash()`. Another instance
 *    whose hash differs is reading different `LIVEKIT_*` secrets, which can
 *    only happen mid-rollout and is harmless thanks to the atomic pin (the
 *    room follows whoever pinned first), but must be *visible*, hence
 *    `voice.configDrift`. Both sides log it: the newcomer announces, every
 *    incumbent compares, and each incumbent answers with its own hello so the
 *    newcomer compares too. Answers are never answered, so two instances
 *    cannot ping-pong.
 */

export const VOICE_HELLO_TOPIC = "voice.hello";

/** Generous: LISTEN is already active when `whenConnected` resolves; the echo is one round trip. */
export const SELF_ECHO_TIMEOUT_MS = 5_000;

interface VoiceHello {
  instance: string;
  configHash: string;
  /** True when this hello answers somebody else's. */
  reply?: boolean;
}

function isHello(data: unknown): data is VoiceHello {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as VoiceHello).instance === "string" &&
    typeof (data as VoiceHello).configHash === "string"
  );
}

subscribeToCluster(VOICE_HELLO_TOPIC, (data, origin) => {
  if (!isHello(data)) {
    return;
  }
  const ours = voiceConfigHash();
  if (data.configHash !== ours) {
    logEvent("voice.configDrift", {
      instance: INSTANCE_ID,
      ours,
      theirs: data.configHash,
      from: origin,
    });
  }
  if (!data.reply) {
    publishToCluster(VOICE_HELLO_TOPIC, {
      instance: INSTANCE_ID,
      configHash: ours,
      reply: true,
    } satisfies VoiceHello);
  }
});

/**
 * Publish this instance's hello once the transport is up and require the echo.
 * Returns a stop function (cancels the pending check; used at shutdown and in
 * tests). A no-op with the bus off, which is the flag-off guarantee: a
 * single-instance deployment gets no timer, no frame and no log line.
 */
export function startVoiceHello(ready: Promise<void>): () => void {
  if (!isBusEnabled()) {
    return () => {};
  }
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unobserve: (() => void) | null = null;

  const finish = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    unobserve?.();
    unobserve = null;
  };

  void ready.then(() => {
    if (stopped) {
      return;
    }
    const configHash = voiceConfigHash();
    unobserve = observeBusFrames((frame) => {
      if (frame.origin !== INSTANCE_ID || frame.topic !== VOICE_HELLO_TOPIC) {
        return;
      }
      logEvent("bus.selfEcho", { instance: INSTANCE_ID, configHash });
      finish();
    });
    timer = setTimeout(() => {
      timer = null;
      finish();
      // Loud on purpose. A bus that cannot hear itself cannot hear anybody,
      // and every instance on it is silently single-instance.
      logEvent("bus.selfEchoMissing", {
        instance: INSTANCE_ID,
        timeoutMs: SELF_ECHO_TIMEOUT_MS,
      });
      console.error(
        "[bus] our own voice.hello never came back within " +
          `${SELF_ECHO_TIMEOUT_MS}ms. LISTEN is not delivering on this ` +
          "connection. If DATABASE_URL points at a transaction-mode pooler, " +
          "switch it to a direct or session-mode endpoint: until then this " +
          "instance cannot see the rest of the cluster.",
      );
    }, SELF_ECHO_TIMEOUT_MS);
    timer.unref?.();
    publishToCluster(VOICE_HELLO_TOPIC, {
      instance: INSTANCE_ID,
      configHash,
    } satisfies VoiceHello);
  });

  return () => {
    stopped = true;
    finish();
  };
}
