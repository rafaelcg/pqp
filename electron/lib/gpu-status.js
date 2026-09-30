/**
 * What Chromium says about this machine's GPU features, reduced to the part a
 * screen share cares about: is video ENCODE done by the GPU.
 *
 * `app.getGPUFeatureStatus()` answers an object keyed by feature name, with
 * values such as `enabled`, `enabled_on`, `enabled_readback`,
 * `disabled_software`, `disabled_off`, `unavailable_software`,
 * `unavailable_off`. Anything that starts with `enabled` is the hardware path;
 * the rest is a software fallback or a feature that is off, and for
 * `video_encode` that means the share is encoded on the CPU (OpenH264), which
 * is the expensive case next to a game.
 *
 * Nothing here enables or disables a feature. `video_encode=enabled` says what
 * the GPU CAN do, not what a given codec profile gets: LiveKit negotiates H.264
 * `42e01f` (constrained baseline), which Chromium on Windows does not
 * hardware-encode by default, so a share can still be OpenH264 on the CPU with
 * this reading at `enabled`. What the share actually uses is in the sender's
 * stats (`pqpShareHealth()` reports it); this adds the machine's side, in one log
 * line at startup and in the same command.
 */

/** @param {unknown} value */
function isEnabledValue(value) {
  return typeof value === "string" && value.startsWith("enabled");
}

/**
 * @param {Record<string, unknown> | null | undefined} status
 */
function summariseGpuStatus(status) {
  if (!status || typeof status !== "object") {
    return {
      videoEncode: null,
      videoDecode: null,
      gpuCompositing: null,
      hardwareVideoEncode: null,
      status: null,
    };
  }
  /** @type {Record<string, string>} */
  const flat = {};
  for (const [key, value] of Object.entries(status)) {
    if (typeof value === "string") {
      flat[key] = value;
    }
  }
  const videoEncode = flat.video_encode ?? null;
  return {
    videoEncode,
    videoDecode: flat.video_decode ?? null,
    gpuCompositing: flat.gpu_compositing ?? null,
    hardwareVideoEncode: videoEncode === null ? null : isEnabledValue(videoEncode),
    status: flat,
  };
}

/**
 * One line, for the startup log.
 * @param {ReturnType<typeof summariseGpuStatus>} summary
 * @param {string} platform
 */
function formatGpuStatusLine(summary, platform) {
  const encode =
    summary.hardwareVideoEncode === null
      ? "unknown"
      : summary.hardwareVideoEncode
        ? "hardware"
        : "SOFTWARE";
  return `[pqp] gpu (${platform}): video_encode=${summary.videoEncode ?? "?"} (${encode}) video_decode=${summary.videoDecode ?? "?"} gpu_compositing=${summary.gpuCompositing ?? "?"}`;
}

module.exports = { summariseGpuStatus, formatGpuStatusLine, isEnabledValue };
