import { Info, Volume2 } from "lucide-react";
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
import { useNotificationSettings, useNotificationState } from "@/hooks/use-notifications";
import { desktopContext, isDesktopApp } from "@/lib/desktop";
import { DOWNLOAD_PAGE_PATH } from "@/lib/downloads";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { setArrivalToastEnabled, setPreviewInAppEnabled, type NotificationLevel, type NotificationPermissionState } from "@/lib/notifications";
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
/**
 * The device row and the DM group both read the push config as the tab
 * opens. One request serves both; the next open asks again.
 */
let pushConfigRequest: ReturnType<typeof getPushConfig> | null = null;
function sharedPushConfig(): ReturnType<typeof getPushConfig> {
  if (!pushConfigRequest) {
    pushConfigRequest = getPushConfig();
    const clear = () => {
      pushConfigRequest = null;
    };
    pushConfigRequest.then(clear, clear);
  }
  return pushConfigRequest;
}

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
              <SettingsNotice
                tone="warning"
                // The browser only re-reads a changed site permission on a
                // new load. The desktop app has no padlock to explain and
                // nothing to reload: its notice points at system settings.
                action={
                  isDesktopApp() ? undefined : (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => window.location.reload()}
                    >
                      {t("settings.notifications.reload")}
                    </Button>
                  )
                }
              >
                {t("settings.notifications.denied", desktopContext())}
              </SettingsNotice>
            ) : null
          }
        />
        <PushRow push={push} permission={permission} />
        {push.availability === "needs-install" ? (
          <SettingsLinkRow
            id="push-install"
            label={t("settings.push.howToInstall")}
            href={DOWNLOAD_PAGE_PATH}
            // A new tab: a same-tab link would drop the open dialog.
            external
          />
        ) : null}
      </SettingsGroup>

      <SettingsGroup title={t("settings.notifications.group.messages.title")}>
        <SettingsRow
          id="default-level"
          label={t("settings.notifications.levelLabel")}
          description={t("settings.notifications.levelHint")}
          // Under the label at every width: the hint is two sentences and
          // "Todas as mensagens" is the longest cell, so beside the label
          // the control would squeeze both. Cells are sized by their text,
          // not equal, so none is cut short.
          stacked
          control={
            <RadioGroup
              variant="segmented"
              fit="content"
              // One line on a phone: the three labels are 40px tall there
              // already, but at full size "Todas as mensagens" pushes the
              // last cell onto a second row.
              className="max-sm:[&>button]:px-2.5 max-sm:[&>button]:text-xs"
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

      <DirectMessagesGroup push={push} permission={permission} />

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
  /**
   * The browser and the server both answered and push can work here. A stale
   * subscription on a server that now says no does not count.
   */
  ready: boolean;
  /** Push is on for this device: `ready` and subscribed. The one value both rows read. */
  on: boolean;
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
  // A ref, not the state: two presses inside one render both read busy=false.
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // The desktop shell raises its own notifications and never uses Web Push
    // (electron/lib/web-cache.js), though Chromium still exposes PushManager
    // there: a switch would only ever fail, so the app says it has no push.
    const availability = isDesktopApp() ? "unsupported" : getPushAvailability();
    setAvailability(availability);
    if (availability !== "available") {
      return;
    }
    void (async () => {
      try {
        const [config, subscription] = await Promise.all([
          sharedPushConfig(),
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
    // A second press while one is in flight is dropped here rather than by
    // disabling the switch, which would drop keyboard focus to the page.
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
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
      busyRef.current = false;
      setBusy(false);
    }
  };

  const ready =
    availability === "available" && serverEnabled === true && !loadFailed;

  return {
    availability,
    serverEnabled,
    loadFailed,
    ready,
    on: ready && subscribed,
    busy,
    error,
    toggle,
  };
}

function PushRow({
  push,
  permission,
}: {
  push: PushDevice;
  permission: NotificationPermissionState;
}) {
  const { t } = useTranslation();
  const { availability, serverEnabled, loadFailed, ready, on, busy, error } = push;

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
      checked={on}
      // Blocked: the warning on the row above says why, and a switch that can
      // only fail would add a second message about the same block. Turning an
      // existing subscription off needs no permission, so that stays possible.
      disabled={!ready || (permission === "denied" && !on)}
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
 * subscription, so it is read whatever this device's push state is.
 *
 * It is locked while push is off here and could be turned on here, because
 * its effect is invisible until then and "Liga o push primeiro." is a step the
 * person can take. When push cannot be turned on from here (this server has no
 * push, it failed to load, the site is blocked) that order cannot be followed,
 * so the switch reads off and a line says push is unavailable. Where this
 * device can never have push (the desktop app, a browser without it, Safari
 * before install) it stays switchable: the preference is for their other
 * devices, and locking it here would leave no way to change it from this one.
 */
function DirectMessagesGroup({
  push,
  permission,
}: {
  push: PushDevice;
  permission: NotificationPermissionState;
}) {
  const { t } = useTranslation();
  // Off here while this browser can host push: locked, as the spec asks.
  const locked =
    !push.on &&
    (push.availability === null || push.availability === "available");
  // Locked for a reason "Liga o push primeiro." cannot fix: the row above
  // already says why, so this one keeps its ordinary hint.
  const pushBlockedHere =
    push.serverEnabled === false || push.loadFailed || permission === "denied";
  // Locked and nothing the person can do about it from here: show it off and
  // say why, instead of an ON switch greyed out beside an order they cannot
  // follow. The stored choice is untouched; a locked switch writes nothing.
  const unavailable = locked && pushBlockedHere;
  const state = useNotificationState();
  const [dmDetails, setDmDetails] = useState(false);
  // Set the moment a person touches the switch, so the initial config fetch
  // (which can resolve after that click) knows not to stomp a choice
  // already in flight with whatever the server answered a moment earlier.
  const touchedRef = useRef(false);
  const dmTicket = useRef(0);
  const dmChain = useRef<Promise<unknown>>(Promise.resolve());
  // The last value the server confirmed. A failed write goes back to this,
  // not to "the opposite of what was clicked", which is only right when the
  // click before it landed.
  const dmConfirmed = useRef(false);
  // Set by the first confirmed write: from then on a late answer to the
  // initial config read is older than what the server holds, and is ignored.
  const dmWriteConfirmed = useRef(false);
  // Whether the server's value is known yet (the config read or a write).
  const dmKnown = useRef(false);
  // A failed write rolled back before the server's value was known: the
  // ticket it happened on. The config read applies its value when it lands,
  // as long as nothing newer was clicked meanwhile.
  const dmRolledBackBlind = useRef<number | null>(null);
  const [dmFailed, setDmFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void sharedPushConfig()
      .then((config) => {
        if (!cancelled) {
          if (!dmWriteConfirmed.current) {
            dmConfirmed.current = config.dmDetails;
            dmKnown.current = true;
          }
          if (
            !touchedRef.current ||
            (!dmWriteConfirmed.current && dmRolledBackBlind.current === dmTicket.current)
          ) {
            setDmDetails(config.dmDetails);
          }
          dmRolledBackBlind.current = null;
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
    setDmFailed(false);
    // One write at a time, and only the newest choice reports back: two
    // requests in flight can land in either order, and an older answer (or
    // its rollback) must not overwrite a newer click.
    const ticket = ++dmTicket.current;
    const write = dmChain.current.then(() =>
      ticket === dmTicket.current ? setPushDmDetails(next) : null,
    );
    dmChain.current = write.catch(() => undefined);
    void write
      .then((saved) => {
        if (!saved) return;
        dmWriteConfirmed.current = true;
        dmKnown.current = true;
        dmConfirmed.current = saved.dmDetails;
        if (ticket === dmTicket.current) setDmDetails(saved.dmDetails);
      })
      .catch(() => {
        if (ticket === dmTicket.current) {
          setDmDetails(dmConfirmed.current);
          setDmFailed(true);
          if (!dmKnown.current) dmRolledBackBlind.current = ticket;
        }
      });
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
        // Not tied to the corner notice: the same setting hides message text
        // in the conversation list, so it stays usable with the notice off.
        onCheckedChange={setPreviewInAppEnabled}
      />
      <SettingsSwitchRow
        id="dm-push-details"
        label={t("settings.push.dmDetails")}
        description={
          locked && !pushBlockedHere
            ? t("settings.push.dmDetailsNeedsPush")
            : t("settings.push.dmDetailsHint")
        }
        checked={dmDetails && !unavailable}
        disabled={locked}
        onCheckedChange={toggleDmDetails}
        status={
          unavailable ? (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-text-secondary">
              <Info aria-hidden className="h-3.5 w-3.5 shrink-0" />
              {t("settings.push.dmDetailsUnavailable")}
            </p>
          ) : dmFailed ? (
            <SettingsInlineStatus
              state={{ kind: "error", message: t("settings.push.dmDetailsFailed") }}
            />
          ) : null
        }
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
        const row = (
          <SettingsSwitchRow
            key={option.cue}
            id={option.id}
            label={label}
            checked={sounds[option.cue]}
            disabled={!sounds.enabled}
            onCheckedChange={(next) => setSoundCueEnabled(option.cue, next)}
            trailing={
              // A visible word, not a hover tooltip: touch has no hover, and
              // an icon alone is a mnemonic only once someone has told you
              // what it is. The name says which sound, the text says what
              // the button does (the name starts with it, so a voice-control
              // user can say what they see).
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t("settings.notifications.sounds.previewCue", {
                  cue: label,
                })}
                // 40px on a phone, where it is a thumb target.
                className="h-10 sm:h-[var(--control-sm)]"
                disabled={!sounds.enabled || !sounds[option.cue]}
                onClick={() => playCue(option.cue)}
              >
                <Volume2 aria-hidden className="h-4 w-4" />
                {t("settings.notifications.sounds.preview")}
              </Button>
            }
          />
        );
        if (option.cue !== "incomingCall") {
          return row;
        }
        // The ringtones belong to this row and only this one, so they hang
        // under it, indented behind a rule. One wrapper keeps the group from
        // drawing a divider between the switch and its own chips.
        return (
          <div key={option.cue}>
            {row}
            <div className="mb-2 ml-4 border-l-2 border-border">
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
                    // Picking the chip that is already chosen plays it again:
                    // the hint says a click on a ringtone lets you hear it.
                    reselect
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
            </div>
          </div>
        );
      })}
    </SettingsGroup>
  );
}
