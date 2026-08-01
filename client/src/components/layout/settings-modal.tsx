import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { User, UserPreferences } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useTheme } from "@/hooks/use-theme";
import {
  ensureMediaPermission,
  listAudioDevices,
  supportsAudioOutputSelection,
  type MediaDeviceOption,
} from "@/lib/audio-devices";
import type { ThemePreference } from "@/lib/theme";
import { updateMe } from "@/lib/api";
import { queuePreferenceSync } from "@/lib/preferences";

export interface LocalSettings {
  muteOnJoin: boolean;
  compactPeers: boolean;
  inputDeviceId: string;
  outputDeviceId: string;
  inputVolume: number;
  outputVolume: number;
}

const STORAGE_KEY = "pqp-local-settings";

const AVATAR_PRESETS = [
  "https://api.dicebear.com/9.x/shapes/svg?seed=signal",
  "https://api.dicebear.com/9.x/shapes/svg?seed=phosphor",
  "https://api.dicebear.com/9.x/shapes/svg?seed=desk",
  "https://api.dicebear.com/9.x/shapes/svg?seed=mesh",
  "https://api.dicebear.com/9.x/shapes/svg?seed=lobby",
  "https://api.dicebear.com/9.x/shapes/svg?seed=relay",
  "https://api.dicebear.com/9.x/bottts-neutral/svg?seed=pqp1",
  "https://api.dicebear.com/9.x/bottts-neutral/svg?seed=pqp2",
];

export const defaultLocalSettings: LocalSettings = {
  muteOnJoin: false,
  compactPeers: false,
  inputDeviceId: "",
  outputDeviceId: "",
  inputVolume: 1,
  outputVolume: 1,
};

export function loadLocalSettings(): LocalSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return defaultLocalSettings;
    }
    const parsed = JSON.parse(raw) as Partial<LocalSettings>;
    return {
      ...defaultLocalSettings,
      ...parsed,
      inputVolume:
        typeof parsed.inputVolume === "number"
          ? Math.min(2, Math.max(0, parsed.inputVolume))
          : defaultLocalSettings.inputVolume,
      outputVolume:
        typeof parsed.outputVolume === "number"
          ? Math.min(1, Math.max(0, parsed.outputVolume))
          : defaultLocalSettings.outputVolume,
      inputDeviceId:
        typeof parsed.inputDeviceId === "string"
          ? parsed.inputDeviceId
          : defaultLocalSettings.inputDeviceId,
      outputDeviceId:
        typeof parsed.outputDeviceId === "string"
          ? parsed.outputDeviceId
          : defaultLocalSettings.outputDeviceId,
    };
  } catch {
    return defaultLocalSettings;
  }
}

export function saveLocalSettings(settings: LocalSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/**
 * The half of `LocalSettings` that describes the person rather than the
 * machine, ready to send to the server.
 *
 * Takes a partial so a single control change queues only the key it touched.
 * The device ids are what the filtering is for: they name hardware in this
 * browser profile and nowhere else, so they never leave the device.
 */
export function preferencesFromLocal(
  settings: Partial<LocalSettings>,
): UserPreferences {
  const preferences: UserPreferences = {};
  if (settings.muteOnJoin !== undefined) {
    preferences.muteOnJoin = settings.muteOnJoin;
  }
  if (settings.compactPeers !== undefined) {
    preferences.compactPeers = settings.compactPeers;
  }
  if (settings.inputVolume !== undefined) {
    preferences.inputVolume = settings.inputVolume;
  }
  if (settings.outputVolume !== undefined) {
    preferences.outputVolume = settings.outputVolume;
  }
  return preferences;
}

/**
 * Overlay the account's settings onto this device's. The server wins on read —
 * it is the only copy that saw the change made on another device — while the
 * device keeps the parts the account does not carry.
 *
 * `theme` is absent on purpose: it lives in its own store under its own key,
 * because the boot script has to resolve it before this module exists.
 */
export function applyRemotePreferences(
  local: LocalSettings,
  preferences: UserPreferences | undefined,
): LocalSettings {
  if (!preferences) {
    return local;
  }
  return {
    ...local,
    muteOnJoin: preferences.muteOnJoin ?? local.muteOnJoin,
    compactPeers: preferences.compactPeers ?? local.compactPeers,
    inputVolume: preferences.inputVolume ?? local.inputVolume,
    outputVolume: preferences.outputVolume ?? local.outputVolume,
  };
}

interface SettingsModalProps {
  open: boolean;
  user: User | null;
  localSettings: LocalSettings;
  /** Live analyser from active voice session, if connected */
  voiceAnalyser?: AnalyserNode | null;
  onClose: () => void;
  onLocalSave: (settings: LocalSettings) => void;
  onUserUpdated: (user: User) => void;
  onAudioSettingsLive?: (settings: LocalSettings) => void;
}

/**
 * Volume only scales how the level reads, so it is held in a ref: putting it in
 * the effect deps would tear down the preview stream and re-prompt
 * `getUserMedia` on every slider tick.
 */
function MicLevelMeter({
  deviceId,
  inputVolume,
  liveAnalyser,
  active,
}: {
  deviceId: string;
  inputVolume: number;
  liveAnalyser: AnalyserNode | null;
  active: boolean;
}) {
  const [level, setLevel] = useState(0);
  const volumeRef = useRef(inputVolume);

  useEffect(() => {
    volumeRef.current = inputVolume;
  }, [inputVolume]);

  useEffect(() => {
    if (!active) {
      setLevel(0);
      return;
    }

    let cancelled = false;
    let raf = 0;
    let preview: { stream: MediaStream; ctx: AudioContext } | null = null;

    function meter(analyser: AnalyserNode) {
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (cancelled) {
          return;
        }
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (const v of data) {
          sum += v;
        }
        const avg = sum / data.length / 255;
        setLevel(Math.min(1, avg * 1.8 * Math.max(0.15, volumeRef.current)));
        raf = requestAnimationFrame(tick);
      };
      tick();
    }

    async function start() {
      if (liveAnalyser) {
        meter(liveAnalyser);
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId } } : true,
          video: false,
        });
        if (cancelled) {
          for (const track of stream.getTracks()) {
            track.stop();
          }
          return;
        }
        const ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        ctx.createMediaStreamSource(stream).connect(analyser);
        preview = { stream, ctx };
        meter(analyser);
      } catch {
        setLevel(0);
      }
    }

    void start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (preview) {
        for (const track of preview.stream.getTracks()) {
          track.stop();
        }
        void preview.ctx.close();
      }
    };
  }, [active, deviceId, liveAnalyser]);

  return (
    <div className="space-y-1.5">
      <span className="block text-xs uppercase tracking-wide text-paper-muted">
        Input level
      </span>
      <div
        className="h-2 overflow-hidden rounded-full bg-ink"
        role="progressbar"
        aria-label="Input level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(level * 100)}
      >
        <div
          className="h-full rounded-full bg-signal transition-[width] duration-75"
          style={{ width: `${Math.round(level * 100)}%` }}
        />
      </div>
    </div>
  );
}

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

/**
 * Theme is not part of `LocalSettings`: it applies on click rather than on
 * Save, and it persists under its own key so the boot script can read it
 * without parsing the audio blob.
 */
function ThemePicker() {
  const { preference, resolved, setPreference } = useTheme();

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const current = THEME_OPTIONS.findIndex(
      (option) => option.value === preference,
    );
    const nextIndex =
      (current + step + THEME_OPTIONS.length) % THEME_OPTIONS.length;
    setPreference(THEME_OPTIONS[nextIndex].value);
    const radios =
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    radios[nextIndex]?.focus();
  }

  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-text-muted">
        Appearance
      </p>
      <div
        role="radiogroup"
        aria-label="Theme"
        className="mt-2 flex gap-1.5"
        onKeyDown={handleKeyDown}
      >
        {THEME_OPTIONS.map((option) => {
          const selected = option.value === preference;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => setPreference(option.value)}
              className={`rounded-md border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                selected
                  ? "border-accent bg-accent/10 text-text"
                  : "border-border text-text-muted hover:border-accent/50"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-xs text-text-muted">
        {preference === "system"
          ? `Following your system — currently ${resolved}.`
          : "Applies immediately, and follows your account to other devices."}
      </p>
    </div>
  );
}

export function SettingsModal({
  open,
  user,
  localSettings,
  voiceAnalyser = null,
  onClose,
  onLocalSave,
  onUserUpdated,
  onAudioSettingsLive,
}: SettingsModalProps) {
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [draftLocal, setDraftLocal] = useState(localSettings);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [inputs, setInputs] = useState<MediaDeviceOption[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceOption[]>([]);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const canSelectOutput = supportsAudioOutputSelection();
  const settingsRef = useRef(localSettings);

  useEffect(() => {
    settingsRef.current = localSettings;
  }, [localSettings]);

  useEffect(() => {
    if (open && user) {
      setDisplayName(user.displayName);
      setUsername(user.username ?? "");
      setAvatarUrl(user.avatarUrl ?? "");
    }
  }, [open, user]);

  // Seeded from a ref so live audio edits, which flow back in as a new
  // `localSettings` prop, do not restart the draft mid-session.
  useEffect(() => {
    if (open) {
      setDraftLocal(settingsRef.current);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;

    async function loadDevices() {
      setDevicesError(null);
      const granted = await ensureMediaPermission();
      if (!granted) {
        if (!cancelled) {
          setDevicesError(
            "Microphone permission needed to list devices and show input level.",
          );
        }
        return;
      }
      const { inputs: nextInputs, outputs: nextOutputs } =
        await listAudioDevices();
      if (cancelled) {
        return;
      }
      setInputs(nextInputs);
      setOutputs(nextOutputs);
    }

    void loadDevices();

    function onDeviceChange() {
      void loadDevices();
    }
    navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);

    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener?.(
        "devicechange",
        onDeviceChange,
      );
    };
  }, [open]);

  function patchLocal(partial: Partial<LocalSettings>) {
    setDraftLocal((prev) => {
      const next = { ...prev, ...partial };
      onAudioSettingsLive?.(next);
      return next;
    });
    // These already apply and persist locally as they are edited rather than on
    // Save, so the account copy follows the same moment. Device-only changes
    // queue nothing, and a slider drag coalesces into one request.
    queuePreferenceSync(preferencesFromLocal(partial));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      onLocalSave(draftLocal);
      saveLocalSettings(draftLocal);
      if (user) {
        const updated = await updateMe({
          displayName: displayName.trim() || undefined,
          username: username.trim() || undefined,
          avatarUrl: avatarUrl.trim() || null,
        });
        onUserUpdated(updated);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      eyebrow="Account"
      title="Settings"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="px-5 py-4">
        {user?.tag && (
          <p className="mb-4 rounded-md border border-ink-4 bg-ink px-3 py-2 font-mono text-sm text-signal">
            {user.tag}
          </p>
        )}

        <div className="mb-4">
          <span className="mb-2 block text-xs uppercase tracking-wide text-paper-muted">
            Avatar
          </span>
          <div className="mb-2 flex items-center gap-3">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt=""
                className="h-12 w-12 rounded-md object-cover ring-1 ring-ink-4"
              />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-md bg-signal font-display text-lg font-bold text-ink">
                {(displayName || "?").slice(0, 1).toUpperCase()}
              </div>
            )}
            <Input
              value={avatarUrl}
              onChange={(e) => setAvatarUrl(e.target.value)}
              placeholder="https://… image URL"
              aria-label="Avatar image URL"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {AVATAR_PRESETS.map((url) => (
              <button
                key={url}
                type="button"
                aria-label="Use preset avatar"
                aria-pressed={avatarUrl === url}
                className={`h-9 w-9 overflow-hidden rounded-md border ${
                  avatarUrl === url
                    ? "border-signal ring-1 ring-signal"
                    : "border-ink-4 hover:border-signal/50"
                }`}
                onClick={() => setAvatarUrl(url)}
              >
                <img src={url} alt="" className="h-full w-full object-cover" />
              </button>
            ))}
            <button
              type="button"
              className="rounded-md border border-ink-4 px-2 text-xs text-paper-muted hover:border-signal/50"
              onClick={() => setAvatarUrl("")}
            >
              Clear
            </button>
          </div>
        </div>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-paper-muted">
            Display name
          </span>
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>

        <label className="mb-4 block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-paper-muted">
            Username
          </span>
          <Input
            value={username}
            onChange={(e) =>
              setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))
            }
            placeholder="cool_name"
          />
          <span className="mt-1 block text-xs text-paper-muted">
            Becomes username#1234 — discriminator auto-assigned if taken.
          </span>
        </label>

        <div className="border-t border-ink-4 pt-4">
          <ThemePicker />
        </div>

        <div className="mt-4 space-y-4 border-t border-ink-4 pt-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-paper-muted">
              Voice &amp; Video
            </p>
            <p className="mt-1 text-xs text-paper-muted">
              Devices and levels apply when joining voice. Changes while
              connected update live when possible.
            </p>
          </div>

          {devicesError && (
            <p className="text-xs text-warning" role="status">
              {devicesError}
            </p>
          )}

          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wide text-paper-muted">
              Input device
            </span>
            <select
              value={draftLocal.inputDeviceId}
              onChange={(e) => patchLocal({ inputDeviceId: e.target.value })}
              className="h-10 w-full rounded-md border border-ink-4 bg-ink px-3 text-sm text-paper outline-none focus:border-signal"
            >
              <option value="">System default</option>
              {inputs.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wide text-paper-muted">
              Input volume
            </span>
            <input
              type="range"
              min={0}
              max={200}
              value={Math.round(draftLocal.inputVolume * 100)}
              onChange={(e) =>
                patchLocal({ inputVolume: Number(e.target.value) / 100 })
              }
              className="w-full accent-[var(--color-signal)]"
            />
            <span className="mt-0.5 block text-xs text-paper-muted">
              {Math.round(draftLocal.inputVolume * 100)}%
            </span>
          </label>

          <MicLevelMeter
            deviceId={draftLocal.inputDeviceId}
            inputVolume={draftLocal.inputVolume}
            liveAnalyser={voiceAnalyser}
            active={open}
          />

          {canSelectOutput ? (
            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-wide text-paper-muted">
                Output device
              </span>
              <select
                value={draftLocal.outputDeviceId}
                onChange={(e) => patchLocal({ outputDeviceId: e.target.value })}
                className="h-10 w-full rounded-md border border-ink-4 bg-ink px-3 text-sm text-paper outline-none focus:border-signal"
              >
                <option value="">System default</option>
                {outputs.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="text-xs text-paper-muted">
              Output device selection is not supported in this browser.
            </p>
          )}

          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wide text-paper-muted">
              Output volume
            </span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(draftLocal.outputVolume * 100)}
              onChange={(e) =>
                patchLocal({ outputVolume: Number(e.target.value) / 100 })
              }
              className="w-full accent-[var(--color-signal)]"
            />
            <span className="mt-0.5 block text-xs text-paper-muted">
              {Math.round(draftLocal.outputVolume * 100)}%
            </span>
          </label>

          <label className="flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={draftLocal.muteOnJoin}
              onChange={(e) => patchLocal({ muteOnJoin: e.target.checked })}
              className="h-4 w-4 accent-[var(--color-signal)]"
            />
            <span className="text-sm">Mute mic when joining voice</span>
          </label>
          <label className="flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={draftLocal.compactPeers}
              onChange={(e) => patchLocal({ compactPeers: e.target.checked })}
              className="h-4 w-4 accent-[var(--color-signal)]"
            />
            <span className="text-sm">Compact peer list</span>
          </label>
        </div>

        {error && (
          <p className="mt-4 text-sm text-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
