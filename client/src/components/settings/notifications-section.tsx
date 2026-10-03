import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { useNotificationSettings, useNotificationState } from "@/hooks/use-notifications";
import { desktopContext } from "@/lib/desktop";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { setArrivalToastEnabled, setPreviewInAppEnabled, type NotificationLevel } from "@/lib/notifications";
import { getIncomingRing, getSoundState, playCue, setIncomingRing, setSoundCueEnabled, setSoundEnabled, subscribeSounds, type IncomingRingId, type SoundCue } from "@/lib/sounds";
import { disablePush, enablePush, getCurrentPushSubscription, getPushAvailability, getPushConfig, setPushDmDetails, type PushAvailability } from "@/lib/push";
import { Field, SwitchRow, chipClass } from "@/components/settings/ui";

/* ----------------------------------------------------------- notifications */

const LEVEL_OPTIONS: { value: NotificationLevel; label: MessageKey }[] = [
  { value: "all", label: "settings.notifications.level.all" },
  { value: "mentions", label: "settings.notifications.level.mentions" },
  { value: "none", label: "settings.notifications.level.none" },
];

const SOUND_CUE_OPTIONS: { cue: SoundCue; label: MessageKey }[] = [
  // First: the one sound a DM makes, which until now had no switch at all —
  // the catalogue key already existed and was unreachable.
  { cue: "message", label: "settings.notifications.sounds.message" },
  { cue: "mention", label: "settings.notifications.sounds.mention" },
  { cue: "voiceJoin", label: "settings.notifications.sounds.voiceJoin" },
  { cue: "voiceLeave", label: "settings.notifications.sounds.voiceLeave" },
  { cue: "incomingCall", label: "settings.notifications.sounds.incomingCall" },
  { cue: "outgoingCall", label: "settings.notifications.sounds.outgoingCall" },
];

const INCOMING_RING_OPTIONS: { id: IncomingRingId; label: MessageKey }[] = [
  { id: "classic", label: "settings.notifications.sounds.ring.classic" },
  { id: "chime", label: "settings.notifications.sounds.ring.chime" },
  { id: "pulse", label: "settings.notifications.sounds.ring.pulse" },
  { id: "marimba", label: "settings.notifications.sounds.ring.marimba" },
  { id: "glass", label: "settings.notifications.sounds.ring.glass" },
];

/**
 * The account-wide notification default, plus the opt-in itself.
 *
 * Permission is requested from the button and nowhere else. Browsers penalise
 * pages that ask on load, a refusal cannot be taken back from script, and there
 * is no second prompt to fall back on — so the ask has to be worth spending.
 */
export function NotificationsSection() {
  const { t } = useTranslation();
  const { state, permission, enable, disable, setDefaultLevel } =
    useNotificationSettings();
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
  const active = state.desktop && permission === "granted";

  return (
    <div className="space-y-6">
      <div>
        {permission === "unsupported" ? (
          <p className="text-xs text-paper-muted">
            {t("settings.notifications.unsupported", desktopContext())}
          </p>
        ) : permission === "denied" ? (
          <p className="text-xs text-warning" role="status">
            {t("settings.notifications.denied", desktopContext())}
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant={active ? "secondary" : "default"}
              size="sm"
              onClick={() => (active ? disable() : void enable())}
            >
              {active
                ? t("settings.notifications.turnOff")
                : t("settings.notifications.enable")}
            </Button>
            <span className="text-xs text-paper-muted">
              {active
                ? t("settings.notifications.on")
                : t("settings.notifications.willAsk", desktopContext())}
            </span>
          </div>
        )}
      </div>

      <Field
        label={t("settings.notifications.levelLabel")}
        hint={t("settings.notifications.levelHint")}
      >
        <div
          role="radiogroup"
          aria-label={t("settings.notifications.levelLabel")}
          className="flex flex-wrap gap-1.5"
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
                className={chipClass(selected)}
              >
                {t(option.label)}
              </button>
            );
          })}
        </div>
      </Field>

      <DirectMessagesSection />

      <Field
        label={t("settings.notifications.soundsLabel")}
        hint={t("settings.notifications.soundsHint")}
      >
        <div className="space-y-2">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-[var(--color-signal)]"
              checked={sounds.enabled}
              onChange={(e) => setSoundEnabled(e.target.checked)}
            />
            <span className="text-sm">{t("settings.notifications.sounds.enabled")}</span>
          </label>
          {SOUND_CUE_OPTIONS.map((option) => (
            <div key={option.cue} className="space-y-1.5">
              <label className="flex cursor-pointer items-center gap-3 pl-7">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--color-signal)]"
                  checked={sounds[option.cue]}
                  disabled={!sounds.enabled}
                  onChange={(e) =>
                    setSoundCueEnabled(option.cue, e.target.checked)
                  }
                />
                <span className="min-w-0 flex-1 text-sm">{t(option.label)}</span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={!sounds.enabled || !sounds[option.cue]}
                  onClick={() => playCue(option.cue)}
                >
                  {t("settings.notifications.sounds.preview")}
                </Button>
              </label>
              {option.cue === "incomingCall" ? (
                <div className="space-y-1.5 pl-14">
                  <p className="text-xs text-paper-muted">
                    {t("settings.notifications.sounds.ringHint")}
                  </p>
                  <div
                    role="radiogroup"
                    aria-label={t("settings.notifications.sounds.ringHint")}
                    className="flex flex-wrap gap-1.5"
                  >
                    {INCOMING_RING_OPTIONS.map((ring) => {
                      const selected = ring.id === incomingRing;
                      return (
                        <button
                          key={ring.id}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          disabled={!sounds.enabled || !sounds.incomingCall}
                          onClick={() => {
                            setIncomingRing(ring.id);
                            playCue("incomingCall");
                          }}
                          className={chipClass(selected)}
                        >
                          {t(ring.label)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </Field>

      <PushNotificationsSection />
    </div>
  );
}

/**
 * Web Push — notifications that reach this device with the app fully closed.
 *
 * Subscribing happens behind the button and nowhere else: it needs the
 * browser's notification permission, and both Chrome's heuristics and iOS
 * outright require the request to originate from a user gesture. Nothing here
 * runs on app start.
 *
 * On iOS the API only exists inside an installed home-screen app, so a plain
 * Safari tab gets the install instruction instead of a button that cannot
 * work.
 */
function PushNotificationsSection() {
  const { t } = useTranslation();
  const [availability, setAvailability] = useState<PushAvailability | null>(null);
  const [serverEnabled, setServerEnabled] = useState<boolean | null>(null);
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
        // The section renders nothing rather than a broken toggle.
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

  if (availability === null) {
    return null;
  }

  return (
    <Field label={t("settings.push.title")}>
      {availability === "needs-install" ? (
        <p className="text-xs text-paper-muted">
          {t("settings.push.needsInstall")}
        </p>
      ) : availability === "unsupported" ? (
        <p className="text-xs text-paper-muted">
          {t("settings.push.unsupported", desktopContext())}
        </p>
      ) : serverEnabled === false ? (
        <p className="text-xs text-paper-muted">
          {t("settings.push.notConfigured")}
        </p>
      ) : serverEnabled === null ? null : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant={subscribed ? "secondary" : "default"}
              size="sm"
              disabled={busy}
              onClick={() => void toggle()}
            >
              {subscribed
                ? t("settings.push.turnOff")
                : t("settings.push.enable")}
            </Button>
            <span className="text-xs text-paper-muted">
              {subscribed ? t("settings.push.on") : t("settings.push.off")}
            </span>
          </div>
          {error ? (
            <p className="mt-1.5 text-xs text-warning" role="status">
              {error}
            </p>
          ) : null}
        </>
      )}
    </Field>
  );
}

/**
 * The three DM privacy choices, adjacent: the corner toast, its message
 * preview, and whether a phone notification may name the sender. Previously
 * `dmDetails` lived inside `PushNotificationsSection`, shown only once a
 * device had subscribed — but it is a stored account preference, not a fact
 * about this browser's subscription, so it belongs here with its siblings
 * and stays visible whether or not push is on for this device.
 */
function DirectMessagesSection() {
  const { t } = useTranslation();
  const state = useNotificationState();
  const [dmDetails, setDmDetails] = useState(false);
  // Set the moment a person touches the switch, so the initial config fetch
  // — which can resolve after that click — knows not to stomp a choice
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
        // No push configured on this server — the switch still renders (it
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
    <Field label={t("settings.notifications.dm.label")}>
      <div className="space-y-3">
        <SwitchRow
          label={t("settings.notifications.dm.arrivalToast")}
          hint={t("settings.notifications.dm.arrivalToastHint")}
          checked={state.arrivalToast}
          onChange={setArrivalToastEnabled}
        />
        <SwitchRow
          label={t("settings.notifications.dm.previewInApp")}
          hint={t("settings.notifications.dm.previewInAppHint")}
          checked={state.previewInApp}
          disabled={!state.arrivalToast}
          onChange={setPreviewInAppEnabled}
        />
        <SwitchRow
          label={t("settings.push.dmDetails")}
          hint={t("settings.push.dmDetailsHint")}
          checked={dmDetails}
          onChange={toggleDmDetails}
        />
      </div>
      <p className="mt-3 text-xs text-paper-muted">
        {t("settings.notifications.dndHint")}
      </p>
    </Field>
  );
}
