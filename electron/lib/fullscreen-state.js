/**
 * "Is a game holding the display in exclusive fullscreen right now?", asked of
 * Windows itself, for the page's dead-share card (`share_game_capture_hint`).
 *
 * WHY. A game in exclusive fullscreen takes the output away from the desktop
 * compositor, and every capture path Chromium has on Windows reads what the
 * compositor makes (DXGI duplication and GDI below Windows 11 24H2, Windows
 * Graphics Capture from 24H2 and for every window source). The page can see a
 * share go black or stop delivering frames, but a still slide stops
 * delivering frames too (Chromium captures in "zero hertz" mode), so the page
 * needs one fact it cannot get on its own before it tells anybody to change a
 * game setting. docs/DESKTOP.md §"Sharing a game: Fullscreen vs Fullscreen
 * Windowed".
 *
 * HOW. `SHQueryUserNotificationState` (shell32), a documented Win32 call that
 * says whether "a full-screen (exclusive mode) Direct3D application is
 * running" (`QUNS_RUNNING_D3D_FULL_SCREEN`, 3):
 * https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ne-shellapi-query_user_notification_state
 * Discord uses the same call to decide that Windows Graphics Capture will not
 * work for a game and to recommend "Borderless":
 * https://support.discord.com/hc/en-us/articles/9410427556375
 *
 * WHAT IT NEVER DOES. It does not open, inspect, hook or inject into any game
 * process. It asks the shell one question about the session, the same one
 * Windows asks itself before showing a notification. Anti-cheat has nothing
 * to see.
 *
 * It runs through PowerShell (`Add-Type` with one P/Invoke), because Node
 * cannot call a Win32 function and this does not justify a native add-on in
 * the build. That costs a process and about a second, so it is asked only
 * when the page already suspects a dead share, at most every few seconds, and
 * answers come from a short cache. Anything that goes wrong (no PowerShell,
 * Constrained Language Mode refusing `Add-Type`, a timeout) is `unknown`, and
 * `unknown` never shows the card.
 */

/** Names for QUERY_USER_NOTIFICATION_STATE, from shellapi.h. */
const QUNS_NAMES = Object.freeze({
  1: "not-present",
  2: "busy",
  3: "d3d-fullscreen",
  4: "presentation",
  5: "accepts-notifications",
  6: "quiet-time",
  7: "app",
});

const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$t = Add-Type -Namespace PqpShell -Name Quns -PassThru -MemberDefinition '[DllImport(\"shell32.dll\")] public static extern int SHQueryUserNotificationState(out int state);'",
  "$v = 0",
  "$hr = $t::SHQueryUserNotificationState([ref]$v)",
  "Write-Output \"$hr $v\"",
].join("; ");

/**
 * The script as `-EncodedCommand` wants it: base64 of UTF-16LE. Passing it
 * this way means no quote in it ever meets Windows command-line quoting.
 */
const ENCODED_SCRIPT = Buffer.from(SCRIPT, "utf16le").toString("base64");

const TIMEOUT_MS = 6_000;
const CACHE_MS = 3_000;

/**
 * `"<hresult> <state>"` from the script, into an answer.
 *
 * @param {string} stdout
 * @returns {{ state: string, raw: number | null, exclusiveFullscreen: boolean | null }}
 */
function parseQunsOutput(stdout) {
  const match = /(-?\d+)\s+(\d+)/.exec(String(stdout ?? "").trim());
  if (!match) {
    return { state: "unknown", raw: null, exclusiveFullscreen: null };
  }
  const hr = Number(match[1]);
  const raw = Number(match[2]);
  if (hr !== 0 || !QUNS_NAMES[raw]) {
    return { state: "unknown", raw: Number.isFinite(raw) ? raw : null, exclusiveFullscreen: null };
  }
  return { state: QUNS_NAMES[raw], raw, exclusiveFullscreen: raw === 3 };
}

/**
 * @param {{
 *   platform?: string,
 *   execFile: (file: string, args: string[], options: object, cb: (err: Error | null, stdout: string) => void) => void,
 *   now?: () => number,
 * }} deps
 */
function createFullscreenState({ platform = process.platform, execFile, now = () => Date.now() }) {
  /** @type {{ at: number, answer: ReturnType<typeof parseQunsOutput> } | null} */
  let cached = null;
  /** @type {Promise<ReturnType<typeof parseQunsOutput>> | null} */
  let inFlight = null;

  function run() {
    return new Promise((resolve) => {
      try {
        execFile(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED_SCRIPT],
          { timeout: TIMEOUT_MS, windowsHide: true },
          (err, stdout) => {
            resolve(err ? { state: "unknown", raw: null, exclusiveFullscreen: null } : parseQunsOutput(stdout));
          },
        );
      } catch {
        resolve({ state: "unknown", raw: null, exclusiveFullscreen: null });
      }
    });
  }

  return {
    /** @returns {Promise<{ state: string, raw: number | null, exclusiveFullscreen: boolean | null }>} */
    async query() {
      if (platform !== "win32") {
        return { state: "unsupported", raw: null, exclusiveFullscreen: null };
      }
      if (cached && now() - cached.at < CACHE_MS) {
        return cached.answer;
      }
      if (!inFlight) {
        inFlight = run().then((answer) => {
          cached = { at: now(), answer };
          inFlight = null;
          return answer;
        });
      }
      return inFlight;
    },
  };
}

module.exports = { createFullscreenState, parseQunsOutput, QUNS_NAMES, SCRIPT, ENCODED_SCRIPT };
