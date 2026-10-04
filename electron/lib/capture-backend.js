const { windowsNtBuild } = require("./display-sources");

/**
 * Which capturer Chromium uses for a SCREEN source on this machine, for
 * `pqpShareHealth()` and the docs' test matrix. Read from Chromium 152's
 * source (Electron 44), not measured:
 *
 * - Windows 11 24H2 (NT build 26100) and later: Windows Graphics Capture.
 *   `IsWgcEnabledForScreenCapture()` is
 *   `base::win::GetVersion() >= base::win::Version::WIN11_24H2`
 *   (content/browser/media/capture/desktop_capture_device.cc), and WebRTC
 *   then creates the WGC screen capturer with no DXGI fallback.
 * - Older Windows: DXGI desktop duplication, with GDI behind it
 *   (`kDirectXCapturer` is enabled by default; WebRTC wraps
 *   `ScreenCapturerWinDirectx` in a fallback to `ScreenCapturerWinGdi`).
 * - A WINDOW source is Windows Graphics Capture on every supported Windows
 *   (`set_allow_wgc_window_capturer(true)` unconditionally).
 *
 * No switch changes this in Electron 44: the old `AllowWgcScreenCapturer` /
 * `AllowWgcWindowCapturer` features no longer exist in Chromium 152, and the
 * one left that does something (`DirectXCapturer` off) only forces GDI.
 *
 * @param {string} platform
 * @param {string} release `os.release()`
 */
function screenCapturerFor(platform, release) {
  if (platform !== "win32") {
    return { build: null, screen: null, window: null };
  }
  const build = windowsNtBuild(release);
  return {
    build: build || null,
    screen: build >= 26100 ? "wgc" : build > 0 ? "dxgi-gdi" : null,
    window: "wgc",
  };
}

module.exports = { screenCapturerFor };
