import { useEffect, useRef, useState } from "react";
import type { User } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ensureMediaPermission,
  listAudioDevices,
  supportsAudioOutputSelection,
  type MediaDeviceOption,
} from "@/lib/audio-devices";
import { updateMe } from "@/lib/api";

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

interface SettingsModalProps {
  open: boolean;
  user: User | null;
  token: string | null;
  localSettings: LocalSettings;
  /** Live analyser from active voice session, if connected */
  voiceAnalyser?: AnalyserNode | null;
  onClose: () => void;
  onLocalSave: (settings: LocalSettings) => void;
  onUserUpdated: (user: User) => void;
  onAudioSettingsLive?: (settings: LocalSettings) => void;
}

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
  const previewRef = useRef<{
    stream: MediaStream;
    ctx: AudioContext;
    analyser: AnalyserNode;
  } | null>(null);

  useEffect(() => {
    if (!active) {
      setLevel(0);
      return;
    }

    let cancelled = false;
    let raf = 0;

    async function startPreview() {
      if (liveAnalyser) {
        const data = new Uint8Array(liveAnalyser.frequencyBinCount);
        const tick = () => {
          if (cancelled) {
            return;
          }
          liveAnalyser.getByteFrequencyData(data);
          let sum = 0;
          for (const v of data) {
            sum += v;
          }
          const avg = sum / data.length / 255;
          setLevel(Math.min(1, avg * 1.8 * Math.max(0.15, inputVolume)));
          raf = requestAnimationFrame(tick);
        };
        tick();
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId
            ? { deviceId: { exact: deviceId } }
            : true,
          video: false,
        });
        if (cancelled) {
          for (const track of stream.getTracks()) {
            track.stop();
          }
          return;
        }
        const ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        previewRef.current = { stream, ctx, analyser };

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
          setLevel(Math.min(1, avg * 1.8 * Math.max(0.15, inputVolume)));
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        setLevel(0);
      }
    }

    void startPreview();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (previewRef.current) {
        for (const track of previewRef.current.stream.getTracks()) {
          track.stop();
        }
        void previewRef.current.ctx.close();
        previewRef.current = null;
      }
    };
  }, [active, deviceId, inputVolume, liveAnalyser]);

  return (
    <div className="space-y-1.5">
      <span className="block text-xs uppercase tracking-wide text-paper-muted">
        Input level
      </span>
      <div className="h-2 overflow-hidden rounded-full bg-ink">
        <div
          className="h-full rounded-full bg-signal transition-[width] duration-75"
          style={{ width: `${Math.round(level * 100)}%` }}
        />
      </div>
    </div>
  );
}

export function SettingsModal({
  open,
  user,
  token,
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

  useEffect(() => {
    if (open && user) {
      setDisplayName(user.displayName);
      setUsername(user.username ?? "");
      setAvatarUrl(user.avatarUrl ?? "");
      setDraftLocal(localSettings);
      setError(null);
    }
  }, [open, user, localSettings]);

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
  }

  if (!open) {
    return null;
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      onLocalSave(draftLocal);
      saveLocalSettings(draftLocal);
      if (token && user) {
        const updated = await updateMe(token, {
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
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/80 p-0 sm:items-center sm:p-4">
      <div className="animate-rise max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-ink-4 bg-ink-2 p-5 shadow-2xl sm:max-w-md sm:rounded-2xl">
        <div className="mb-5 flex items-end justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-signal">
              Account
            </p>
            <h2 className="font-display text-2xl font-bold">Settings</h2>
          </div>
          <button
            type="button"
            className="text-sm text-paper-muted hover:text-paper"
            onClick={onClose}
          >
            Close
          </button>
        </div>

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
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {AVATAR_PRESETS.map((url) => (
              <button
                key={url}
                type="button"
                title="Use preset"
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

        <div className="mb-5 space-y-4 border-t border-ink-4 pt-4">
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
            <p className="text-xs text-warning">{devicesError}</p>
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
                onChange={(e) =>
                  patchLocal({ outputDeviceId: e.target.value })
                }
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
              onChange={(e) =>
                patchLocal({ compactPeers: e.target.checked })
              }
              className="h-4 w-4 accent-[var(--color-signal)]"
            />
            <span className="text-sm">Compact peer list</span>
          </label>
        </div>

        {error && <p className="mb-3 text-sm text-danger">{error}</p>}

        <div className="flex justify-end gap-2 safe-pb">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
