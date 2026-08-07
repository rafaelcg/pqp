import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  deleteConfirmationMatches,
  expectedDeleteConfirmation,
  type BlockedUser,
  type DmPrivacy,
  type User,
  type UserPreferences,
} from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useNotificationSettings } from "@/hooks/use-notifications";
import { useTheme } from "@/hooks/use-theme";
import {
  ensureMediaPermission,
  listAudioDevices,
  supportsAudioOutputSelection,
  type MediaDeviceOption,
} from "@/lib/audio-devices";
import {
  adoptNotificationPreferences,
  type NotificationLevel,
} from "@/lib/notifications";
import type { ThemePreference } from "@/lib/theme";
import {
  deleteMyAccount,
  exportMyData,
  updateMe,
  OwnedServersError,
  type BlockingOwnedServer,
} from "@/lib/api";
import { queuePreferenceSync } from "@/lib/preferences";

export interface LocalSettings {
  muteOnJoin: boolean;
  compactPeers: boolean;
  inputDeviceId: string;
  outputDeviceId: string;
  inputVolume: number;
  outputVolume: number;
  showLinkEmbeds: boolean;
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
  showLinkEmbeds: true,
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
  if (settings.showLinkEmbeds !== undefined) {
    preferences.showLinkEmbeds = settings.showLinkEmbeds;
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
 *
 * Notification levels are the same shape of thing — their own store, read by
 * the rail and the channel list rather than by any settings state — so this is
 * where the account's copy is handed over rather than returned.
 */
export function applyRemotePreferences(
  local: LocalSettings,
  preferences: UserPreferences | undefined,
): LocalSettings {
  if (!preferences) {
    return local;
  }
  adoptNotificationPreferences(preferences.notifications);
  return {
    ...local,
    muteOnJoin: preferences.muteOnJoin ?? local.muteOnJoin,
    compactPeers: preferences.compactPeers ?? local.compactPeers,
    inputVolume: preferences.inputVolume ?? local.inputVolume,
    outputVolume: preferences.outputVolume ?? local.outputVolume,
    showLinkEmbeds: preferences.showLinkEmbeds ?? local.showLinkEmbeds,
  };
}

interface SettingsModalProps {
  open: boolean;
  user: User | null;
  localSettings: LocalSettings;
  /** Live analyser from active voice session, if connected */
  voiceAnalyser?: AnalyserNode | null;
  blockedUsers: BlockedUser[];
  onClose: () => void;
  onLocalSave: (settings: LocalSettings) => void;
  onUserUpdated: (user: User) => void;
  onUnblockUser: (userId: string) => void;
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

const LEVEL_OPTIONS: { value: NotificationLevel; label: string }[] = [
  { value: "all", label: "All messages" },
  { value: "mentions", label: "Only @mentions" },
  { value: "none", label: "Nothing" },
];

/**
 * The account-wide notification default, plus the opt-in itself.
 *
 * Permission is requested from the button and nowhere else. Browsers penalise
 * pages that ask on load, a refusal cannot be taken back from script, and there
 * is no second prompt to fall back on — so the ask has to be worth spending.
 */
function NotificationsSection() {
  const { state, permission, enable, disable, setDefaultLevel } =
    useNotificationSettings();
  const active = state.desktop && permission === "granted";

  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-text-muted">
        Notifications
      </p>

      {permission === "unsupported" ? (
        <p className="mt-2 text-xs text-text-muted">
          This browser cannot show desktop notifications.
        </p>
      ) : permission === "denied" ? (
        <p className="mt-2 text-xs text-warning" role="status">
          Blocked for this site. Allow notifications in your browser&apos;s site
          settings to turn them back on — the page cannot ask again.
        </p>
      ) : (
        <div className="mt-2 flex items-center gap-3">
          <Button
            variant={active ? "secondary" : "default"}
            size="sm"
            onClick={() => (active ? disable() : void enable())}
          >
            {active ? "Turn off" : "Enable desktop notifications"}
          </Button>
          <span className="text-xs text-text-muted">
            {active
              ? "On for this account."
              : "Your browser will ask for permission."}
          </span>
        </div>
      )}

      <div
        role="radiogroup"
        aria-label="Default notification level"
        className="mt-3 flex flex-wrap gap-1.5"
      >
        {LEVEL_OPTIONS.map((option) => {
          const selected = option.value === state.default;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setDefaultLevel(option.value)}
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
        Applies where a server or channel has no setting of its own. Right-click
        a server or channel to change just that one.
      </p>
    </div>
  );
}

const DM_PRIVACY_OPTIONS: { value: DmPrivacy; label: string }[] = [
  { value: "everyone", label: "Anyone" },
  { value: "server_members", label: "People I share a server with" },
  { value: "nobody", label: "No one" },
];

/**
 * Who may open a conversation with this account, and who has been blocked.
 *
 * Both apply the moment they are clicked rather than on Save, unlike the
 * profile fields above them. A privacy control that silently did nothing
 * because the dialog was dismissed with Cancel is the one failure this section
 * cannot have: the user believes they are closed off and they are not.
 *
 * The rule is enforced on the server on every attempt to open a conversation.
 * Nothing here is the enforcement — this is the switch, not the lock.
 */
function PrivacySection({
  user,
  blockedUsers,
  onUserUpdated,
  onUnblockUser,
}: {
  user: User | null;
  blockedUsers: BlockedUser[];
  onUserUpdated: (user: User) => void;
  onUnblockUser: (userId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = user?.dmPrivacy ?? "server_members";

  async function choose(value: DmPrivacy) {
    if (!user || busy || value === current) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onUserUpdated(await updateMe({ dmPrivacy: value }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-text-muted">Privacy</p>

      <p className="mt-2 text-xs text-text-muted">
        Who can start a direct message with you.
      </p>
      <div
        role="radiogroup"
        aria-label="Who can direct message me"
        className="mt-2 flex flex-wrap gap-1.5"
      >
        {DM_PRIVACY_OPTIONS.map((option) => {
          const selected = option.value === current;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={busy || !user}
              onClick={() => void choose(option.value)}
              className={`rounded-md border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-60 ${
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
        Applies to new conversations. Anyone you are already talking to can still
        reach you — tightening this is not a way to disappear on someone
        mid-sentence.
      </p>
      {error && (
        <p role="alert" className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      )}

      <p className="mt-4 text-xs uppercase tracking-wide text-text-muted">
        Blocked
      </p>
      {blockedUsers.length === 0 ? (
        <p className="mt-2 text-xs text-text-muted">
          Nobody. Blocking someone stops their messages reaching you and hides
          what they say in shared channels behind a tap.
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {blockedUsers.map((blocked) => (
            <li
              key={blocked.id}
              className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-surface-2/60"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-text">
                  {blocked.displayName}
                </p>
                {blocked.tag && (
                  <p className="truncate font-mono text-[11px] text-text-muted">
                    {blocked.tag}
                  </p>
                )}
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onUnblockUser(blocked.id)}
              >
                Unblock
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * The two rights the privacy policy promises, as buttons.
 *
 * Until these existed the only route was emailing an address and waiting for
 * somebody to run SQL by hand inside a 15-day statutory deadline. The point of
 * putting them here, rather than on a settings page of their own, is that this
 * is where a user already goes to change their name and their privacy — the
 * right to leave belongs next to the rest of the account, not hidden.
 */
function YourDataSection({
  user,
  onRequestDelete,
}: {
  user: User | null;
  onRequestDelete: () => void;
}) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  async function download() {
    setExporting(true);
    setExportError(null);
    try {
      const blob = await exportMyData();
      // A Blob has no URL of its own, so one is minted just long enough for the
      // click to fire — the same mechanism the server export uses.
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `pqp-my-data-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(messageOf(err, "Could not build your export"));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-paper-muted">
        Your data
      </p>

      <div className="mt-2 flex items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void download()}
          disabled={exporting || !user}
        >
          {exporting ? "Preparing…" : "Download my data"}
        </Button>
        <span className="text-xs text-text-muted">
          A JSON file of everything we hold about you.
        </span>
      </div>
      <p className="mt-1.5 text-xs text-text-muted">
        It includes your profile, your settings, every message you wrote, the
        servers you are in, and who you have blocked. It does not include
        messages other people wrote — including their side of your direct
        messages. Those are their words, not your data, and you can still read
        them here in the app.
      </p>
      {exportError && (
        <p role="alert" className="mt-1.5 text-xs text-danger">
          {exportError}
        </p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="border border-danger/40 text-danger hover:bg-danger/10"
          onClick={onRequestDelete}
          disabled={!user}
        >
          Delete my account
        </Button>
        <span className="text-xs text-text-muted">
          Permanent. There is no undo and no backup to restore from.
        </span>
      </div>
    </div>
  );
}

/**
 * The confirmation itself.
 *
 * Deliberately not a browser `confirm()` and deliberately not a single button.
 * The user has to read what goes and what stays, and then type their own handle
 * — the same value `deleteConfirmationMatches` checks on the server, so the
 * button being enabled and the request being accepted can never disagree.
 *
 * It states what survives as plainly as what is destroyed. A deletion screen
 * that only lists what disappears is quietly misleading: audit entries, bans
 * this account issued, and reports filed about it all remain, and somebody
 * deleting their account specifically to erase a moderation record deserves to
 * learn that here rather than afterwards.
 */
function DeleteAccountDialog({
  open,
  user,
  onCancel,
  onDeleted,
}: {
  open: boolean;
  user: User | null;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockingServers, setBlockingServers] = useState<
    BlockingOwnedServer[] | null
  >(null);

  useEffect(() => {
    if (open) {
      setTyped("");
      setError(null);
      setBlockingServers(null);
    }
  }, [open]);

  const expected = expectedDeleteConfirmation(user?.tag);
  const confirmed = deleteConfirmationMatches(typed, user?.tag);

  async function submit() {
    if (!confirmed || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    setBlockingServers(null);
    try {
      await deleteMyAccount(typed);
      onDeleted();
    } catch (err) {
      if (err instanceof OwnedServersError) {
        setBlockingServers(err.servers);
        setError(null);
      } else {
        setError(messageOf(err, "Could not delete your account"));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      eyebrow="Account"
      title="Delete your account"
      size="sm"
      onClose={onCancel}
      // A stray click on the backdrop must not be able to dismiss the one
      // screen in the app whose next action cannot be undone.
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Keep my account
          </Button>
          <Button
            className="bg-danger text-white hover:bg-danger/90"
            onClick={() => void submit()}
            disabled={!confirmed || busy}
          >
            {busy ? "Deleting…" : "Delete for ever"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 px-5 py-4 text-sm">
        <p className="text-text">
          This cannot be undone. We keep no backup you can be restored from, and
          nobody at pqp can bring your account back.
        </p>

        <div>
          <p className="text-xs uppercase tracking-wide text-paper-muted">
            What is deleted
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-text-muted">
            <li>Your profile, handle, avatar and settings.</li>
            <li>
              Every message you have written, everywhere — including in direct
              messages. Other people will see gaps where your messages were.
            </li>
            <li>Your files and images, and the reactions you left.</li>
            <li>
              Your memberships, your conversations, and the list of people you
              blocked.
            </li>
            <li>Your sign-in. You will not be able to log back in.</li>
            <li>
              Any server you own <strong>on your own</strong>, with nobody else
              in it.
            </li>
          </ul>
        </div>

        <div>
          <p className="text-xs uppercase tracking-wide text-paper-muted">
            What is kept, and why
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-text-muted">
            <li>
              Moderation records of actions you took in other people&apos;s
              servers, with your name removed. Deleting an account must not
              erase the record of how it was used to moderate somebody else.
            </li>
            <li>
              Bans you issued. Removing them would let everybody you banned back
              into servers you no longer have anything to do with.
            </li>
            <li>
              Reports other people filed about you, with your name removed. We
              are not able to let an account be deleted as a way of clearing its
              own record.
            </li>
          </ul>
          <p className="mt-2 text-xs text-text-muted">
            All of these are pruned on their own schedule. The privacy policy
            explains them in full.
          </p>
        </div>

        {blockingServers && blockingServers.length > 0 && (
          <div
            role="alert"
            className="rounded-md border border-warning/40 bg-warning/10 p-3"
          >
            <p className="font-medium text-text">
              Do one of these first, for each server you own
            </p>
            <p className="mt-1 text-xs text-text-muted">
              Other people are still in these servers, so we will not delete
              them out from under them. In each server&apos;s settings, either
              hand it to another member or delete the server yourself.
            </p>
            <ul className="mt-2 space-y-1">
              {blockingServers.map((server) => (
                <li key={server.id} className="text-sm text-text">
                  {server.name}{" "}
                  <span className="text-xs text-text-muted">
                    — {server.otherMemberCount} other{" "}
                    {server.otherMemberCount === 1 ? "member" : "members"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-paper-muted">
            Type <span className="font-mono text-signal">{expected}</span> to
            confirm
          </span>
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-label={`Type ${expected} to confirm deletion`}
          />
        </label>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

export function SettingsModal({
  open,
  user,
  localSettings,
  voiceAnalyser = null,
  blockedUsers,
  onClose,
  onLocalSave,
  onUserUpdated,
  onUnblockUser,
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
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const canSelectOutput = supportsAudioOutputSelection();
  const settingsRef = useRef(localSettings);

  // One dialog at a time rather than two stacked ones: `Dialog` installs a
  // focus trap and an Escape handler per instance, and two live traps fight
  // over which one Tab belongs to. Settings steps aside while the confirmation
  // is up and comes back if it is cancelled.
  const settingsOpen = open && !confirmingDelete;

  useEffect(() => {
    if (!open) {
      setConfirmingDelete(false);
    }
  }, [open]);

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
    <>
      <Dialog
        open={settingsOpen}
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

          <div className="mt-4 border-t border-ink-4 pt-4">
            <NotificationsSection />
          </div>

          <div className="mt-4 border-t border-ink-4 pt-4">
            <PrivacySection
              user={user}
              blockedUsers={blockedUsers}
              onUserUpdated={onUserUpdated}
              onUnblockUser={onUnblockUser}
            />
          </div>

          <div className="mt-4 border-t border-ink-4 pt-4">
            <p className="text-xs uppercase tracking-wide text-paper-muted">
              Chat
            </p>
            <label className="mt-2 flex cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                checked={draftLocal.showLinkEmbeds}
                onChange={(e) => patchLocal({ showLinkEmbeds: e.target.checked })}
                className="h-4 w-4 accent-[var(--color-signal)]"
              />
              <span className="text-sm">Show link previews</span>
            </label>
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

          <div className="mt-4 border-t border-ink-4 pt-4">
            <YourDataSection
              user={user}
              onRequestDelete={() => setConfirmingDelete(true)}
            />
          </div>

          {error && (
            <p className="mt-4 text-sm text-danger" role="alert">
              {error}
            </p>
          )}
        </div>
      </Dialog>

      <DeleteAccountDialog
        open={open && confirmingDelete}
        user={user}
        onCancel={() => setConfirmingDelete(false)}
        // A full reload rather than a Clerk `signOut()` call: `ClerkProvider`
        // is not mounted at all under the dev auth bypass, so a Clerk hook here
        // would throw in local development. Reloading works in both modes — the
        // identity is gone at Clerk, so the session cannot be re-established and
        // the app boots signed out.
        onDeleted={() => window.location.replace("/")}
      />
    </>
  );
}
