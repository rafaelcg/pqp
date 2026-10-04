import { Volume2 } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  SettingsGroup,
  SettingsInlineStatus,
  SettingsLinkRow,
  SettingsNotice,
  SettingsRow,
  SettingsSwitchRow,
  type InlineSaveState,
} from "@/components/settings/kit";
import { Button } from "@/components/ui/button";
import { RadioGroup } from "@/components/ui/radio-group";
import { Tooltip } from "@/components/ui/tooltip";
import { useNotificationSettings, useNotificationState } from "@/hooks/use-notifications";
import { desktopContext } from "@/lib/desktop";
import { DOWNLOAD_PAGE_PATH } from "@/lib/downloads";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { setArrivalToastEnabled, setPreviewInAppEnabled, type NotificationLevel } from "@/lib/notifications";
import { getIncomingRing, getSoundState, playCue, setIncomingRing, setSoundCueEnabled, setSoundEnabled, subscribeSounds, type IncomingRingId, type SoundCue } from "@/lib/sounds";
import { disablePush, enablePush, getCurrentPushSubscription, getPushAvailability, getPushConfig, setPushDmDetails, type PushAvailability } from "@/lib/push";

/* ----------------------------------------------------------- notifications */

const LEVEL_OPTIONS: { value: NotificationLevel; label: MessageKey }[] = [
  { value: "all", label: "settings.notifications.level.all" },
  { value: "mentions", label: "settings.notifications.level.mentions" },
  { value: "none", label: "settings.notifications.level.none" },
];

const SOUND_CUE_OPTIONS: { cue: SoundCue; id: string; label: MessageKey }[] = [
  // First: the one sound a DM makes, which until now had no switch at all:
  // the catalogue key already existed and was unreachable.
  { cue: "message", id: "sound-message", label: "settings.notifications.sounds.message" },
  { cue: "mention", id: "sound-mention", label: "settings.notifications.sounds.mention" },
  { cue: "voiceJoin", id: "sound-voice-join", label: "settings.notifications.sounds.voiceJoin" },
  { cue: "voiceLeave", id: "sound-voice-leave", label: "settings.notifications.sounds.voiceLeave" },
  { cue: "incomingCall", id: "sound-incoming-call", label: "settings.notifications.sounds.incomingCall" },
  { cue: "outgoingCall", id: "sound-outgoing-call", label: "settings.notifications.sounds.outgoingCall" },
];

const INCOMING_RING_OPTIONS: { id: IncomingRingId; label: MessageKey }[] = [
  { id: "classic", label: "settings.notifications.sounds.ring.classic" },
  { id: "chime", label: "settings.notifications.sounds.ring.chime" },
  { id: "pulse", label: "settings.notifications.sounds.ring.pulse" },
  { id: "marimba", label: "settings.notifications.sounds.ring.marimba" },
  { id: "glass", label: "settings.notifications.sounds.ring.glass" },
];

/**
 * What reaches you, where, and with which sound.
 *
 * Permission is requested from the system switch and nowhere else. Browsers
 * penalise pages that ask on load, a refusal cannot be taken back from script,
 * and there is no second prompt to fall back on, so the ask has to be worth
 * spending. Push subscribes from its own switch for the same reason.
 */
export function NotificationsSection() {
  const { t } = useTranslation();
  const { state, permission, enable, disable, setDefaultLevel } =
    useNotificationSettings();
  const push = usePushDevice();
  const active = state.desktop && permission === "granted";

  return (
    <div className="space-y-6">
      <SettingsGroup title={t("settings.notifications.group.device.title")}>
        <SettingsSwitchRow
          id="system-notifications"
          label={t("settings.notifications.system.label")}
          description={t("settings.notifications.system.where", desktopContext())}
          checked={active}
          disabled={permission === "unsupported" || permission === "denied"}
          onCheckedChange={(next) => (next ? void enable() : disable())}
          status={
            permission === "unsupported" ? (
              <SettingsNotice tone="info">
                {t("settings.notifications.unsupported", desktopContext())}
              </SettingsNotice>
            ) : permission === "denied" ? (
              <SettingsNotice tone="warning">
                {t("settings.notifications.denied", desktopContext())}
              </SettingsNotice>
            ) : null
          }
        />
        <PushRow push={push} />
        {push.availability === "needs-install" ? (
          <SettingsLinkRow
            id="push-install"
            label={t("settings.push.howToInstall")}
            href={DOWNLOAD_PAGE_PATH}
            external
          />
        ) : null}
      </SettingsGroup>

      <SettingsGroup title={t("settings.notifications.group.communities.title")}>
        <SettingsRow
          id="default-level"
          label={t("settings.notifications.levelLabel")}
          description={t("settings.notifications.levelHint")}
          control={
            <RadioGroup
              variant="segmented"
              // Cells sized by their text, not equal: three equal cells cut
              // "Só @menções" short beside the label and on a phone.
              className="auto-cols-auto"
              label={t("settings.notifications.levelLabel")}
              value={state.default}
              onValueChange={setDefaultLevel}
              options={LEVEL_OPTIONS.map((option) => ({
                value: option.value,
                label: t(option.label),
              }))}
            />
          }
        />
      </SettingsGroup>

      <DirectMessagesGroup pushOn={push.subscribed} />

      <SoundsGroup />
    </div>
  );
}

/* --------------------------------------------------------------------- push */

interface PushDevice {
  availability: PushAvailability | null;
  /** Null while the server's push config is loading. */
  serverEnabled: boolean | null;
  loadFailed: boolean;
  subscribed: boolean;
  busy: boolean;
  error: string | null;
  toggle: () => Promise<void>;
}

/**
 * Web Push on this device: notifications that arrive with the app fully
 * closed.
 *
 * Subscribing happens behind the switch and nowhere else: it needs the
 * browser's notification permission, and both Chrome's heuristics and iOS
 * outright require the request to originate from a user gesture. Nothing here
 * subscribes on mount; mount only reads the server config and whether this
 * browser already holds a subscription.
 *
 * On iOS the API only exists inside an installed home-screen app, so a plain
 * Safari tab gets the install pointer instead of a switch that cannot work.
 */
function usePushDevice(): PushDevice {
  const { t } = useTranslation();
  const [availability, setAvailability] = useState<PushAvailability | null>(null);
  const [serverEnabled, setServerEnabled] = useState<boolean | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const availability = getPushAvailability();
    setAvailability(availability);
    if (availability !== "available") {
      return;
    }
    void (async () => {
      try {
        const [config, subscription] = await Promise.all([
          getPushConfig(),
          getCurrentPushSubscription(),
        ]);
        if (cancelled) {
          return;
        }
        setServerEnabled(config.enabled);
        setSubscribed(subscription !== null);
      } catch {
        // A disabled switch and a line saying so, rather than a toggle that
        // cannot know what it would be turning on.
        if (!cancelled) {
          setLoadFailed(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      if (subscribed) {
        await disablePush();
        setSubscribed(false);
      } else {
        const result = await enablePush();
        if (result === "enabled") {
          setSubscribed(true);
        } else if (result === "denied") {
          setError(t("settings.push.denied", desktopContext()));
        } else {
          setError(t("settings.push.failed"));
        }
      }
    } catch {
      setError(t("settings.push.unreachable"));
    } finally {
      setBusy(false);
    }
  };

  return { availability, serverEnabled, loadFailed, subscribed, busy, error, toggle };
}

function PushRow({ push }: { push: PushDevice }) {
  const { t } = useTranslation();
  const { availability, serverEnabled, loadFailed, subscribed, busy, error } = push;

  const ready =
    availability === "available" && serverEnabled === true && !loadFailed;

  let notice = null;
  if (availability === "unsupported") {
    notice = (
      <SettingsNotice tone="info">
        {t("settings.push.unsupported", desktopContext())}
      </SettingsNotice>
    );
  } else if (availability === "available" && serverEnabled === false) {
    notice = (
      <SettingsNotice tone="info">{t("settings.push.notConfigured")}</SettingsNotice>
    );
  }

  const status: InlineSaveState | null = busy
    ? { kind: "saving" }
    : error
      ? { kind: "error", message: error }
      : loadFailed
        ? { kind: "error", message: t("settings.push.loadFailed") }
        : null;

  return (
    <SettingsSwitchRow
      id="push"
      label={t("settings.push.title")}
      description={
        availability === "needs-install"
          ? t("settings.push.needsInstall")
          : t("settings.push.description")
      }
      checked={ready && subscribed}
      disabled={!ready || busy}
      onCheckedChange={() => void push.toggle()}
      status={
        notice ?? (status ? <SettingsInlineStatus state={status} /> : null)
      }
    />
  );
}

/* ---------------------------------------------------------- direct messages */

/**
 * The three DM privacy choices, adjacent: the corner toast, its message
 * preview, and whether a phone notification may name the sender. `dmDetails`
 * is a stored account preference, not a fact about this browser's
 * subscription, so it is read whatever this device's push state is; it is
 * only switchable once push is on here, because its effect is invisible
 * until then.
 */
function DirectMessagesGroup({ pushOn }: { pushOn: boolean }) {
  const { t } = useTranslation();
  const state = useNotificationState();
  const [dmDetails, setDmDetails] = useState(false);
  // Set the moment a person touches the switch, so the initial config fetch
  // (which can resolve after that click) knows not to stomp a choice
  // already in flight with whatever the server answered a moment earlier.
  const touchedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void getPushConfig()
      .then((config) => {
        if (!cancelled && !touchedRef.current) {
          setDmDetails(config.dmDetails);
        }
      })
      .catch(() => {
        // No push configured on this server: the switch still renders (it
        // is a preference independent of push), just starts at its default.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleDmDetails = () => {
    touchedRef.current = true;
    const next = !dmDetails;
    setDmDetails(next);
    void setPushDmDetails(next)
      .then((saved) => setDmDetails(saved.dmDetails))
      .catch(() => setDmDetails(!next));
  };

  return (
    <SettingsGroup title={t("settings.notifications.dm.label")}>
      <SettingsSwitchRow
        id="dm-arrival-toast"
        label={t("settings.notifications.dm.arrivalToast")}
        description={t("settings.notifications.dm.arrivalToastHint")}
        checked={state.arrivalToast}
        onCheckedChange={setArrivalToastEnabled}
      />
      <SettingsSwitchRow
        id="dm-preview"
        label={t("settings.notifications.dm.previewInApp")}
        description={t("settings.notifications.dm.previewInAppHint")}
        checked={state.previewInApp}
        disabled={!state.arrivalToast}
        onCheckedChange={setPreviewInAppEnabled}
      />
      <SettingsSwitchRow
        id="dm-push-details"
        label={t("settings.push.dmDetails")}
        description={
          pushOn
            ? t("settings.push.dmDetailsHint")
            : t("settings.push.dmDetailsNeedsPush")
        }
        checked={dmDetails}
        disabled={!pushOn}
        onCheckedChange={toggleDmDetails}
      />
    </SettingsGroup>
  );
}

/* ------------------------------------------------------------------- sounds */

function SoundsGroup() {
  const { t } = useTranslation();
  const sounds = useSyncExternalStore(
    subscribeSounds,
    getSoundState,
    getSoundState,
  );
  const incomingRing = useSyncExternalStore(
    subscribeSounds,
    getIncomingRing,
    getIncomingRing,
  );
  const ringDisabled = !sounds.enabled || !sounds.incomingCall;

  return (
    <SettingsGroup
      title={t("settings.notifications.soundsLabel")}
      description={t("settings.notifications.soundsHint")}
    >
      <SettingsSwitchRow
        id="sounds"
        label={t("settings.notifications.sounds.enabled")}
        checked={sounds.enabled}
        onCheckedChange={setSoundEnabled}
      />
      {SOUND_CUE_OPTIONS.map((option) => {
        const label = t(option.label);
        return (
          <SettingsSwitchRow
            key={option.cue}
            id={option.id}
            label={label}
            checked={sounds[option.cue]}
            disabled={!sounds.enabled}
            onCheckedChange={(next) => setSoundCueEnabled(option.cue, next)}
            trailing={
              <Tooltip
                label={t("settings.notifications.sounds.preview")}
                name={t("settings.notifications.sounds.previewCue", { cue: label })}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  disabled={!sounds.enabled || !sounds[option.cue]}
                  onClick={() => playCue(option.cue)}
                >
                  <Volume2 aria-hidden className="h-4 w-4" />
                </Button>
              </Tooltip>
            }
          />
        );
      })}
      <SettingsRow
        id="incoming-ring"
        label={t("settings.notifications.sounds.ringLabel")}
        description={t("settings.notifications.sounds.ringHint")}
        disabled={ringDisabled}
        stacked
        control={
          <RadioGroup
            variant="chips"
            label={t("settings.notifications.sounds.ringLabel")}
            value={incomingRing}
            disabled={ringDisabled}
            onValueChange={(next) => {
              setIncomingRing(next);
              playCue("incomingCall");
            }}
            options={INCOMING_RING_OPTIONS.map((ring) => ({
              value: ring.id,
              label: t(ring.label),
            }))}
          />
        }
      />
    </SettingsGroup>
  );
}
