import {
  AtSign,
  Check,
  ChevronRight,
  LayoutList,
  Link2,
  Pencil,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { Invite, User } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AVATAR_PRESETS, avatarUploadEnabled } from "@/components/user/avatar-picker";
import { UserAvatar } from "@/components/user/user-avatar";
import { ServerIcon } from "@/components/layout/server-identity";
import { Confetti } from "@/components/onboarding/confetti";
import { ServerReadyPanel } from "@/components/onboarding/server-ready-panel";
import { StepDots } from "@/components/onboarding/step-dots";
import {
  createInvite,
  createServer,
  fetchMembers,
  joinInvite,
  updateMe,
  updatePreferences,
  type ServerMember,
} from "@/lib/api";
import { confettiSpent, sessionStore, spendConfetti } from "@/lib/arrival";
import { rememberInviteCode } from "@/lib/invite-paste-copy";
import { uploadAvatar } from "@/lib/avatar-upload";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import {
  handleErrorMessage,
  isValidUsername,
  joinFromRoomStep,
  normalizeInviteCode,
  normalizeUsername,
  onboardingCompletedPatch,
  screenPosition,
  tagWasReassigned,
  type OnboardingPath,
  type OnboardingStep,
} from "@/lib/onboarding";
import {
  markOnboarded,
  secondsSinceOnboardingStart,
  track,
  trackOnboardingStart,
} from "@/lib/track";
import { cn } from "@/lib/utils";

/**
 * First run, after the age gate. One panel, up to three steps.
 *
 * THE SHAPE (docs/ONBOARDING.md, the V2 spec). The age gate is screen one and
 * draws the same dots; this picks up at two.
 *
 *   2. você   name, photo, and the @ people type to find you. On an invite
 *             link it also shows the room that is waiting, and its button is
 *             "Entrar em {server}".
 *   3. sala   cold start only. Three doors: make a room, bring a Discord
 *             server, or paste an invite. One opens at a time.
 *   4. pronto after "Criar". The invite link and the pastes, so an organizer
 *             never leaves the wizard without the one thing that moves a group.
 *
 * WHY THE HANDLE IS A CHIP AND NOT A SCREEN. The V1 handle screen existed
 * because nobody was ever shown the tag `deriveHandle` allocated (an account
 * that gave nothing usable is `user_3f9a#0417` and has no way to learn it).
 * That is still the bug being fixed, and it is fixed by the tag being printed,
 * in the handle face, on the screen they already have to read. Editing it is
 * one tap away and optional.
 *
 * WHY NOTHING IS REQUIRED. The account works, the handle is allocated, and
 * somebody who wants to get into a channel should be able to. Every step's
 * primary button works with zero edits, and steps 2 and 3 close the wizard
 * from their own footer ("Depois eu arrumo"), which counts as an answer.
 *
 * WHY CONFETTI ON "PRONTO" AND NOT ON SIGN-UP. The goal is "in a room with my
 * people". The organizer's moment is the room existing with its invite in
 * hand; the invitee's is arriving, so theirs fires on the arrival banner in
 * the app (App.tsx). One burst per account per session either way
 * (`confettiSpent`).
 *
 * MOBILE FIRST. `Dialog` is a bottom sheet under `sm:`. Every step fits
 * 390x844 with the keyboard closed: step 3 opens one door at a time for
 * exactly that reason.
 */

export interface OnboardingArrival {
  serverId: string;
  name: string;
  iconUrl: string | null;
}

interface OnboardingFlowProps {
  user: User;
  path: OnboardingPath;
  /**
   * Invite path only: where the join behind the wizard stands. `pending` while
   * `acceptInviteFromLink` runs, then the server, or `failed` for a dead link
   * (the app's fallback panel takes over once the wizard closes).
   */
  arrival?: OnboardingArrival | "pending" | "failed" | null;
  /**
   * The age gate handed this panel over in the same spot. No second rise.
   */
  entrance?: boolean;
  /**
   * The Discord door (and the import path's primary). The flow finishes
   * first; the parent then opens the create dialog on the paste step.
   */
  onImportDiscord: () => void;
  /** Reflect a saved profile back into the app (sidebar, message authorship). */
  onUserUpdated: (user: User) => void;
  /**
   * A server was created here. The parent loads it behind the dialog and
   * remembers it as this session's own (the owner banner).
   */
  onServerCreated: (serverId: string) => Promise<void> | void;
  /** A typed invite on step 3 worked. The parent opens the server. */
  onServerJoined: (serverId: string) => Promise<void> | void;
  /** Finished or skipped. The parent stops rendering this. */
  onDone: () => void;
}

/** What one step hands the shared dialog. */
interface StepView {
  eyebrow: string;
  title: string;
  description: string;
  body: ReactNode;
  footer: ReactNode;
  dismissible: boolean;
  onClose: () => void;
}

const STEP_OUT_MS = 120;

/** The room step 3 made, for step 4. */
interface CreatedRoom {
  serverId: string;
  invite: Invite | null;
  /** The parent opened it behind the dialog. False: "Entrar na sala" retries. */
  loaded: boolean;
}

/** A fine pointer: the one place autofocus does not summon a keyboard. */
function prefersAutofocus(): boolean {
  return window.matchMedia?.("(pointer: fine)").matches ?? true;
}

export function OnboardingFlow({
  user,
  path: pathProp,
  arrival = null,
  entrance = true,
  onImportDiscord,
  onUserUpdated,
  onServerCreated,
  onServerJoined,
  onDone,
}: OnboardingFlowProps) {
  const { locale } = useTranslation();
  // Frozen at mount: the intents that decide it are spent as the app acts on
  // them, and the dots must not change count under somebody mid-flow.
  const [path] = useState(pathProp);
  const [step, setStep] = useState<OnboardingStep>("you");
  /** The step sliding out, drawn under the incoming one for 120 ms. */
  const [leaving, setLeaving] = useState<OnboardingStep | null>(null);
  const leaveTimer = useRef<number | null>(null);
  /** The room made on step 3 and its invite, for step 4. */
  const [created, setCreated] = useState<CreatedRoom | null>(null);
  const finished = useRef(false);

  useEffect(() => {
    // The gate normally fired this; an account that arrives already past the
    // gate (answered in another tab) starts the funnel here instead.
    trackOnboardingStart({
      path,
      device: window.matchMedia?.("(max-width: 639px)").matches
        ? "phone"
        : "desktop",
      locale,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    track("onboarding_step_view", { step });
  }, [step]);

  useEffect(
    () => () => {
      if (leaveTimer.current !== null) {
        window.clearTimeout(leaveTimer.current);
      }
    },
    [],
  );

  function goTo(next: OnboardingStep) {
    setLeaving(step);
    setStep(next);
    if (leaveTimer.current !== null) {
      window.clearTimeout(leaveTimer.current);
    }
    leaveTimer.current = window.setTimeout(() => setLeaving(null), STEP_OUT_MS);
    // The control that was focused (a footer button, a door) just unmounted,
    // and focus on <body> can Tab out of the modal. Put it on the new step's
    // first control: the first door, or Copiar link.
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          `[data-onboarding-step="${next}"] button, [data-onboarding-step="${next}"] input`,
        )
        ?.focus();
    });
  }

  /**
   * Record that the flow is answered, then get out of the way.
   *
   * The parent is told first and the request is not awaited: a failed write
   * costs one repeat of the flow on the next cold start, whereas awaiting it
   * would make a slow network look like a frozen dialog on the last click of
   * signup. The local `user` is deliberately not patched to match (a save on
   * step 2 and this can race; see V1's note, unchanged).
   */
  function finish(skippedAt?: OnboardingStep) {
    if (finished.current) {
      return;
    }
    finished.current = true;
    void updatePreferences(onboardingCompletedPatch()).catch(() => {
      // Nothing to recover: the next bootstrap re-reads the truth.
    });
    const seconds = secondsSinceOnboardingStart();
    track("onboarding_done", {
      path,
      ...(seconds !== null ? { seconds } : {}),
      ...(skippedAt ? { skippedAt } : {}),
    });
    markOnboarded();
    onDone();
  }

  // ONE DIALOG, EVERY STEP. Each step is a hook that owns its fields and hands
  // back what to draw; all of them run every render (hooks must), and the
  // current one is picked below. The panel stays mounted from the first
  // screen to the last: only the content turns, the frame never blinks.
  const you = useYouStep({
    user,
    path,
    arrival,
    onUserUpdated,
    onNext: () => {
      if (path === "cold") {
        goTo("room");
      } else if (path === "import") {
        finish();
        onImportDiscord();
      } else {
        finish();
      }
    },
    onSkip: () => finish("you"),
  });
  const room = useRoomStep({
    loadCreated: (serverId) => Promise.resolve(onServerCreated(serverId)),
    onCreated: (room) => {
      if (room.invite) {
        rememberInviteCode(room.serverId, room.invite.code);
      }
      setCreated(room);
      goTo("ready");
    },
    openJoined: (serverId) => Promise.resolve(onServerJoined(serverId)),
    onJoined: () => finish(),
    onImportDiscord: () => {
      finish();
      onImportDiscord();
    },
    onSkip: () => finish("room"),
  });
  const ready = useReadyStep({
    user,
    created,
    onInvite: (invite) => {
      if (created && invite) {
        rememberInviteCode(created.serverId, invite.code);
      }
      setCreated((current) => (current ? { ...current, invite } : current));
    },
    // The room was made; if opening it behind the dialog failed, this is
    // the retry, and the wizard only closes onto a room that is open.
    openRoom: async () => {
      if (!created || created.loaded) {
        return;
      }
      await onServerCreated(created.serverId);
      setCreated((current) => (current ? { ...current, loaded: true } : current));
    },
    onEnter: () => finish(),
  });

  const views: Record<OnboardingStep, StepView> = { you, room, ready };
  const view = views[step];
  // The gate was screen one, so the wizard's first step is dot two.
  const position = screenPosition(path, step);

  return (
    <Dialog
      open
      entrance={entrance}
      headerKey={step}
      eyebrow={view.eyebrow}
      title={view.title}
      description={view.description}
      size="sm"
      dismissible={view.dismissible}
      onClose={view.onClose}
      footer={
        <>
          <StepDots index={position.index} total={position.total} />
          {view.footer}
        </>
      }
    >
      {/* The outgoing step and the incoming one share one grid cell, so the
          old content leaves (left, fading, 120 ms) while the new one arrives
          (from the right) in the same place. */}
      <div className="grid grid-cols-[minmax(0,1fr)]">
        {leaving && leaving !== step && (
          <div
            key={`out-${leaving}`}
            aria-hidden="true"
            inert
            className="animate-step-out pointer-events-none min-w-0 [grid-area:1/1] [&_*]:animate-none"
          >
            {views[leaving].body}
          </div>
        )}
        <div
          key={step}
          // No delay behind the outgoing step. The spec's 60 ms left a frame
          // with neither step visible (the exit curve front-loads its fade),
          // which read as the panel blinking empty; starting together makes
          // it a true crossfade.
          className="animate-step-in min-w-0 [grid-area:1/1]"
          data-onboarding-step={step}
        >
          {view.body}
        </div>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------- step 2: você

function useYouStep({
  user,
  path,
  arrival,
  onUserUpdated,
  onNext,
  onSkip,
}: {
  user: User;
  path: OnboardingPath;
  arrival: OnboardingFlowProps["arrival"];
  onUserUpdated: (user: User) => void;
  onNext: () => void;
  onSkip: () => void;
}): StepView {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [nameTouched, setNameTouched] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl ?? "");
  const [photoSource, setPhotoSource] = useState<"preset" | "upload" | "none">(
    "none",
  );
  const [editingHandle, setEditingHandle] = useState(false);
  const [username, setUsername] = useState(user.username ?? "");
  const [tag, setTag] = useState(user.tag);
  const [reassignedTag, setReassignedTag] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Pressed the invite CTA before the join behind the wizard resolved. */
  const [waitingForJoin, setWaitingForJoin] = useState(false);
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);
  const [handleErrorKey, setHandleErrorKey] = useState<MessageKey | null>(null);
  const [handleCopied, setHandleCopied] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const copyTimer = useRef<number | null>(null);

  const joined = arrival && typeof arrival === "object" ? arrival : null;
  const joinFailed = arrival === "failed";
  const members = useArrivalMembers(joined?.serverId ?? null);

  const handleChanged = editingHandle && username !== (user.username ?? "");
  const canSubmit =
    !saving && !waitingForJoin && (!handleChanged || isValidUsername(username));

  useEffect(() => {
    if (prefersAutofocus()) {
      nameRef.current?.focus();
    }
  }, []);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) {
        window.clearTimeout(copyTimer.current);
      }
    },
    [],
  );

  // The CTA was pressed while the join was still running: go the moment it
  // lands, or after ten seconds regardless (the app's fallback panel handles a
  // link that died), so a slow network never strands somebody on this screen.
  useEffect(() => {
    if (!waitingForJoin) {
      return;
    }
    if (arrival !== "pending") {
      onNext();
      return;
    }
    const timer = window.setTimeout(onNext, 10_000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingForJoin, arrival]);

  async function copyHandle() {
    const value = tag ?? username;
    if (!value) {
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Silent: a chip that says "Copiado" when nothing was copied is a lie.
      return;
    }
    setHandleCopied(true);
    if (copyTimer.current !== null) {
      window.clearTimeout(copyTimer.current);
    }
    copyTimer.current = window.setTimeout(() => setHandleCopied(false), 1600);
  }

  async function submit() {
    if (!canSubmit) {
      return;
    }
    const trimmed = displayName.trim();
    const nameChanged = trimmed !== "" && trimmed !== user.displayName;
    const avatarChanged = avatarUrl !== (user.avatarUrl ?? "");

    const advance = () => {
      track("onboarding_you_next", {
        editedName: nameChanged,
        editedHandle: handleChanged,
        photo: photoSource,
        path,
      });
      if (path === "invite" && arrival === "pending") {
        setWaitingForJoin(true);
        return;
      }
      onNext();
    };

    // Nothing to save: they read it and kept it, which is a complete answer.
    if (!nameChanged && !avatarChanged && !handleChanged) {
      advance();
      return;
    }

    setSaving(true);
    setErrorKey(null);
    setHandleErrorKey(null);
    try {
      const updated = await updateMe({
        ...(nameChanged ? { displayName: trimmed } : {}),
        ...(avatarChanged ? { avatarUrl: avatarUrl.trim() || null } : {}),
        ...(handleChanged ? { username } : {}),
      });
      onUserUpdated(updated);
      if (handleChanged && tagWasReassigned(username, tag, updated.tag)) {
        // Stay and say what happened. Advancing here is how somebody leaves
        // believing in a handle nobody can type.
        setReassignedTag(updated.tag);
        setTag(updated.tag);
        setUsername(updated.username ?? username);
        setEditingHandle(false);
        return;
      }
      setTag(updated.tag);
      advance();
    } catch (error) {
      if (handleChanged) {
        setHandleErrorKey(handleErrorMessage(error));
      } else {
        setErrorKey("onboarding.you.saveError");
      }
    } finally {
      setSaving(false);
    }
  }

  const eyebrow = joinFailed
    ? t("onboarding.you.eyebrowInviteFailed")
    : joined
      ? t("onboarding.you.eyebrowInvite", { server: joined.name })
      : t("onboarding.you.eyebrow");
  const description = joinFailed
    ? t("onboarding.you.descriptionInviteFailed")
    : t("onboarding.you.description");

  const primaryLabel = saving
    ? t("onboarding.saving")
    : waitingForJoin
      ? t("onboarding.you.entering")
      : path === "import"
        ? t("onboarding.you.import")
        : path === "invite" && joined
          ? t("onboarding.you.enter", { server: joined.name })
          : t("onboarding.you.next");

  const nameHintVisible =
    !nameTouched && displayName === user.displayName && displayName !== "";

  return {
    eyebrow,
    title: t("onboarding.you.title"),
    description,
    // An invitee closing this would land in the room anyway, and an X next to
    // "Entrar em {server}" reads as "don't go in". Cold and import can leave.
    dismissible: path !== "invite",
    onClose: onSkip,
    footer: (
      <>
        {path !== "invite" && (
          <Button variant="ghost" disabled={saving} onClick={onSkip}>
            {t("onboarding.you.later")}
          </Button>
        )}
        <Button
          data-onboarding-primary=""
          disabled={!canSubmit}
          className="max-w-[16rem]"
          onClick={() => void submit()}
        >
          <span className="truncate">{primaryLabel}</span>
        </Button>
      </>
    ),
    body: (
      <form
        className="space-y-5 px-5 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {path === "invite" && !joinFailed && (
          <ArrivalCard arrival={joined} members={members} selfId={user.id} />
        )}

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-text-secondary">
            {t("onboarding.you.name")}
          </span>
          <Input
            ref={nameRef}
            value={displayName}
            disabled={saving}
            maxLength={32}
            autoComplete="nickname"
            placeholder={t("onboarding.you.namePlaceholder")}
            onChange={(event) => {
              setDisplayName(event.target.value);
              setNameTouched(true);
            }}
          />
          {/* The field arrives pre-filled from the identity provider, and for
              anyone who used "continue with Google" that is their legal name,
              over every message they send. Said once, only while untouched. */}
          {nameHintVisible && (
            <span className="mt-1.5 block text-pretty text-[11px] leading-snug text-text-tertiary">
              {t("onboarding.you.nameHint")}
            </span>
          )}
        </label>

        <PhotoRow
          name={displayName || user.displayName}
          value={avatarUrl}
          disabled={saving}
          onPick={(url, source) => {
            setAvatarUrl(url);
            setPhotoSource(url ? source : "none");
          }}
          onUploaded={(updated) => {
            setAvatarUrl(updated.avatarUrl ?? "");
            setPhotoSource("upload");
            onUserUpdated(updated);
          }}
        />

        <div>
          <span className="mb-1.5 block text-xs font-medium text-text-secondary">
            {t("onboarding.you.handle")}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-onboarding-handle=""
              aria-label={`${t("onboarding.you.handleCopy")}: ${tag ?? username}`}
              onClick={() => void copyHandle()}
              className="group flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-card)] border border-border bg-surface-0 px-3 text-left transition-[border-color,transform] duration-[var(--duration-fast)] ease-[var(--ease-standard)] hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring active:scale-[0.98]"
            >
              <AtSign
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-accent"
              />
              <HandleText value={tag ?? username} />
              <span
                aria-live="polite"
                className="shrink-0 text-xs text-text-tertiary"
              >
                {handleCopied ? (
                  <span className="animate-door-reveal flex items-center gap-1 text-success">
                    <Check aria-hidden="true" className="h-3.5 w-3.5" />
                    {t("onboarding.you.handleCopied")}
                  </span>
                ) : null}
              </span>
            </button>
            <Button
              type="button"
              variant="secondary"
              aria-expanded={editingHandle}
              data-onboarding-handle-toggle=""
              disabled={saving}
              onClick={() => {
                if (editingHandle) {
                  // Keep: back to the handle they had, error and all cleared.
                  setUsername(user.username ?? "");
                  setHandleErrorKey(null);
                  setEditingHandle(false);
                  return;
                }
                setEditingHandle(true);
                setReassignedTag(null);
                window.setTimeout(() => usernameRef.current?.focus(), 0);
              }}
            >
              {editingHandle ? (
                t("onboarding.you.handleKeep")
              ) : (
                <>
                  <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
                  {t("onboarding.you.handleChange")}
                </>
              )}
            </Button>
          </div>

          {editingHandle && (
            <label className="animate-door-reveal mt-3 block">
              <span className="sr-only">{t("onboarding.you.username")}</span>
              <Input
                ref={usernameRef}
                value={username}
                inputMode="text"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={saving}
                aria-label={t("onboarding.you.username")}
                aria-invalid={handleErrorKey ? true : undefined}
                onChange={(event) => {
                  setUsername(normalizeUsername(event.target.value));
                  setHandleErrorKey(null);
                }}
              />
              <span className="mt-1.5 block text-[11px] leading-snug text-text-tertiary">
                {t("onboarding.you.usernameHint")}
              </span>
            </label>
          )}

          {reassignedTag && (
            <p
              role="status"
              className="animate-door-reveal mt-2 rounded-[var(--radius-card)] bg-surface-1 px-3 py-2 text-sm text-text-secondary"
            >
              {t("onboarding.you.reassigned", { tag: reassignedTag })}
            </p>
          )}
          {handleErrorKey && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {t(handleErrorKey)}
            </p>
          )}
        </div>

        {errorKey && (
          <p role="alert" className="text-sm text-danger">
            {t(errorKey)}
          </p>
        )}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    ),
  };
}

/**
 * `name#1234`, where only the name may shorten. The number is the part people
 * cannot guess and the reason this chip exists, so it never truncates.
 */
function HandleText({ value }: { value: string }) {
  const hash = value.lastIndexOf("#");
  const name = hash > 0 ? value.slice(0, hash) : value;
  const number = hash > 0 ? value.slice(hash) : "";
  return (
    <span className="flex min-w-0 flex-1 items-baseline font-handle text-base text-text">
      <span className="min-w-0 truncate">{name}</span>
      {number && (
        <span className="shrink-0 tabular-nums text-accent">{number}</span>
      )}
    </span>
  );
}

/**
 * Who is in the room, as soon as the join lands. Reads the member list the
 * account can now see (it is a member), so no public endpoint is needed.
 * Failure is quiet: the card shows the name alone.
 */
function useArrivalMembers(serverId: string | null): ServerMember[] | null {
  const [members, setMembers] = useState<ServerMember[] | null>(null);
  useEffect(() => {
    if (!serverId) {
      return;
    }
    let cancelled = false;
    fetchMembers(serverId)
      .then(({ members: list }) => {
        if (!cancelled) {
          setMembers(list);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [serverId]);
  return members;
}

const FACE_LIMIT = 5;

/**
 * "{server} tá te esperando", made visible: the room's icon, its name, and
 * the faces already inside. Warm on purpose: this is the screen an invitee
 * would otherwise read as "signing up for nothing".
 */
function ArrivalCard({
  arrival,
  members,
  selfId,
}: {
  arrival: OnboardingArrival | null;
  members: ServerMember[] | null;
  selfId: string;
}) {
  const { t } = useTranslation();

  if (!arrival) {
    // The join is still running. Hold the card's exact shape so nothing jumps
    // when it lands.
    return (
      <div
        className="flex items-center gap-3 rounded-[calc(var(--radius-card)+6px)] bg-surface-1 p-3"
        aria-busy="true"
      >
        <Skeleton className="h-12 w-12 rounded-[var(--radius-card)]" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-4 w-2/5" />
          <p className="text-xs text-text-tertiary">{t("onboarding.you.joining")}</p>
        </div>
      </div>
    );
  }

  // The join already put the person in the list. The card is about who is
  // waiting for them, so it counts and shows everybody else; faces with a
  // picture go first, because five initials in a row read as nobody.
  const others = (members ?? []).filter((member) => member.id !== selfId);
  const faces = [...others]
    .sort((a, b) => Number(Boolean(b.avatarUrl)) - Number(Boolean(a.avatarUrl)))
    .slice(0, FACE_LIMIT);
  const count = members ? others.length : null;

  return (
    <div
      data-onboarding-arrival=""
      className="animate-pop-in flex items-center gap-3 rounded-[calc(var(--radius-card)+6px)] bg-accent-soft p-3 [animation-delay:120ms]"
    >
      <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-card)] bg-surface-2 font-display text-sm font-bold text-text outline outline-1 -outline-offset-1 outline-text/10">
        <ServerIcon name={arrival.name} iconUrl={arrival.iconUrl} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-display text-base font-bold leading-tight text-on-accent-soft">
          {arrival.name}
        </p>
        <div className="mt-1 flex min-h-6 items-center gap-2">
          {faces.length > 0 && (
            <span className="flex -space-x-1.5" aria-hidden="true">
              {faces.map((member, index) => (
                <span
                  key={member.id}
                  className="animate-pop-in rounded-full bg-surface-2 ring-2 ring-accent-soft"
                  style={{ animationDelay: `${180 + index * 50}ms` }}
                >
                  <UserAvatar
                    name={member.displayName}
                    avatarUrl={member.avatarUrl}
                    rounded="full"
                    className="h-6 w-6"
                    fallbackClassName="bg-surface-2 text-[10px] text-text"
                  />
                </span>
              ))}
            </span>
          )}
          {count !== null && count > 0 && (
            <span className="text-xs tabular-nums text-on-accent-soft/80">
              {t("onboarding.you.members", { count })}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The photo row: the face you have now, eight presets, and an upload when the
 * deployment has storage. No URL field: nobody arriving from a WhatsApp group
 * has an image URL, and Configurações keeps one for whoever does.
 */
function PhotoRow({
  name,
  value,
  disabled,
  onPick,
  onUploaded,
}: {
  name: string;
  value: string;
  disabled: boolean;
  onPick: (url: string, source: "preset" | "upload") => void;
  onUploaded: (user: User) => void;
}) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [canUpload, setCanUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void avatarUploadEnabled().then((config) => {
      if (!cancelled) {
        setCanUpload(config.enabled);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleFile(file: File) {
    setUploading(true);
    setError(null);
    try {
      onUploaded(await uploadAvatar(file));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("onboarding.you.saveError"));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <span className="mb-1.5 flex items-center justify-between text-xs font-medium text-text-secondary">
        {t("onboarding.you.photo")}
        {value && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onPick("", "preset")}
            className="rounded-[var(--radius-control)] px-1.5 py-0.5 text-xs text-text-tertiary transition-colors hover:text-text"
          >
            {t("onboarding.you.photoClear")}
          </button>
        )}
      </span>
      <div className="flex items-center gap-3">
        <UserAvatar
          name={name}
          avatarUrl={value || null}
          rounded="full"
          className="h-12 w-12 outline outline-1 -outline-offset-1 outline-text/10"
          fallbackClassName="bg-accent text-lg text-on-accent"
        />
        <div className="grid min-w-0 flex-1 grid-cols-8 gap-1.5">
          {AVATAR_PRESETS.map((url) => (
            <button
              key={url}
              type="button"
              disabled={disabled}
              aria-label={t("onboarding.you.photoPreset")}
              aria-pressed={value === url}
              onClick={() => onPick(url, "preset")}
              className={cn(
                "aspect-square overflow-hidden rounded-full outline outline-1 -outline-offset-1 outline-text/10 transition-[transform,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-standard)] hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring active:scale-[0.96]",
                value === url &&
                  "ring-2 ring-accent ring-offset-2 ring-offset-surface-2",
              )}
            >
              <img src={url} alt="" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      </div>
      {canUpload && (
        <>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="mt-2.5"
            disabled={disabled || uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? t("onboarding.you.photoUploading") : t("onboarding.you.photoUpload")}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) {
                void handleFile(file);
              }
            }}
          />
        </>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------- step 3: sala

type Door = "create" | "import" | "invite";

function useRoomStep({
  loadCreated,
  onCreated,
  openJoined,
  onJoined,
  onImportDiscord,
  onSkip,
}: {
  /** Open the new room behind the dialog. Rejects when that failed. */
  loadCreated: (serverId: string) => Promise<void>;
  onCreated: (room: CreatedRoom) => void;
  /** Open a joined room behind the dialog. Rejects when that failed. */
  openJoined: (serverId: string) => Promise<void>;
  onJoined: () => void;
  onImportDiscord: () => void;
  onSkip: () => void;
}): StepView {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Door | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"create" | "invite" | null>(null);
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);
  /**
   * The invite worked but the room would not open. Remembered so the retry
   * only opens it again: re-joining is harmless, but it is not what failed.
   */
  const [joinedId, setJoinedId] = useState<string | null>(null);
  const fieldRef = useRef<HTMLInputElement>(null);

  function openDoor(door: Door) {
    if (busy) {
      return;
    }
    track("onboarding_room_door", { door });
    if (door === "import") {
      onImportDiscord();
      return;
    }
    setErrorKey(null);
    setOpen(door);
    // The field appears on the same frame; focus it (a door is a tap, so the
    // keyboard coming up here is what the person asked for).
    window.setTimeout(() => fieldRef.current?.focus(), 0);
  }

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || busy) {
      return;
    }
    setBusy("create");
    setErrorKey(null);
    let serverId: string;
    try {
      ({
        server: { id: serverId },
      } = await createServer(trimmed));
    } catch {
      setErrorKey("onboarding.room.create.error");
      setBusy(null);
      return;
    }
    track("onboarding_server_created");
    // From here the room exists, so nothing below may send the person back
    // to a Criar that would make a second one. The invite and the parent
    // opening the room are independent: run them together, and let the
    // ready step retry the opening if it failed.
    const [invite, loaded] = await Promise.all([
      createInvite(serverId, { expiresInHours: 168 })
        .then((result) => result.invite)
        .catch(() => null),
      loadCreated(serverId).then(
        () => true,
        () => false,
      ),
    ]);
    onCreated({ serverId, invite, loaded });
  }

  async function join() {
    if (busy || (!joinedId && !normalizeInviteCode(code))) {
      return;
    }
    setBusy("invite");
    setErrorKey(null);
    const result = await joinFromRoomStep({
      input: code,
      joinedId,
      joinInvite,
      openJoined,
    });
    if (result.kind === "opened") {
      onJoined();
      return;
    }
    if (result.kind === "notOpened") {
      // Joined, but the room did not open: stay, say so, and make the
      // button retry only the opening.
      setJoinedId(result.serverId);
      setErrorKey("onboarding.room.invite.openError");
    } else {
      // Expired, revoked, used up, or mistyped: one sentence, same recovery.
      setErrorKey("onboarding.room.invite.error");
    }
    setBusy(null);
  }

  const doors: { id: Door; icon: LucideIcon; title: MessageKey; body: MessageKey }[] = [
    { id: "create", icon: Sparkles, title: "onboarding.room.create.title", body: "onboarding.room.create.body" },
    { id: "import", icon: LayoutList, title: "onboarding.room.import.title", body: "onboarding.room.import.body" },
    { id: "invite", icon: Link2, title: "onboarding.room.invite.title", body: "onboarding.room.invite.body" },
  ];

  return {
    eyebrow: t("onboarding.room.eyebrow"),
    title: t("onboarding.room.title"),
    description: t("onboarding.room.description"),
    dismissible: busy === null,
    onClose: onSkip,
    footer: (
      <Button variant="ghost" disabled={busy !== null} onClick={onSkip}>
        {t("onboarding.room.later")}
      </Button>
    ),
    body: (
      <div className="space-y-2 px-5 py-4" role="list">
        {doors.map((door, index) => {
          const isOpen = open === door.id;
          const collapsed = open !== null && !isOpen;
          const Icon = door.icon;
          return (
            <div
              key={door.id}
              role="listitem"
              data-onboarding-door={door.id}
              data-open={isOpen ? "true" : "false"}
              style={{ "--stagger": index } as CSSProperties}
              className={cn(
                "animate-rise overflow-hidden rounded-[calc(var(--radius-card)+4px)] border bg-surface-1 transition-[border-color,background-color] duration-[var(--duration-base)] ease-[var(--ease-emphasized)]",
                isOpen ? "border-accent bg-accent-soft/40" : "border-border",
              )}
            >
              <button
                type="button"
                aria-expanded={door.id === "import" ? undefined : isOpen}
                disabled={busy !== null}
                onClick={() => openDoor(door.id)}
                className={cn(
                  "group flex w-full items-center gap-3 px-3.5 text-left transition-[transform] duration-[var(--duration-fast)] ease-[var(--ease-standard)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring active:scale-[0.99] disabled:opacity-60",
                  collapsed ? "py-2.5" : "py-3.5",
                  !isOpen && "hover:bg-surface-2",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex shrink-0 items-center justify-center rounded-[var(--radius-card)] transition-colors duration-[var(--duration-base)]",
                    collapsed ? "h-7 w-7" : "h-9 w-9",
                    isOpen ? "bg-accent text-on-accent" : "bg-surface-2 text-accent",
                  )}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-text">
                    {t(door.title)}
                  </span>
                  {!collapsed && (
                    <span className="mt-0.5 block text-pretty text-xs leading-snug text-text-tertiary">
                      {t(door.body)}
                    </span>
                  )}
                </span>
                {!isOpen && (
                  <ChevronRight
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 text-text-tertiary transition-transform duration-[var(--duration-fast)] group-hover:translate-x-0.5"
                  />
                )}
              </button>

              {isOpen && door.id === "create" && (
                <form
                  className="animate-door-reveal flex gap-2 px-3.5 pb-3.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void create();
                  }}
                >
                  <Input
                    ref={fieldRef}
                    value={name}
                    maxLength={100}
                    disabled={busy !== null}
                    aria-label={t("onboarding.room.create.label")}
                    placeholder={t("onboarding.room.create.placeholder")}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <Button
                    type="submit"
                    data-onboarding-create=""
                    className="h-10 shrink-0"
                    disabled={!name.trim() || busy !== null}
                  >
                    {busy === "create"
                      ? t("onboarding.room.create.busy")
                      : t("onboarding.room.create.action")}
                  </Button>
                </form>
              )}

              {isOpen && door.id === "invite" && (
                <form
                  className="animate-door-reveal flex gap-2 px-3.5 pb-3.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void join();
                  }}
                >
                  <Input
                    ref={fieldRef}
                    value={code}
                    disabled={busy !== null}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-label={t("onboarding.room.invite.placeholder")}
                    placeholder={t("onboarding.room.invite.placeholder")}
                    onChange={(event) => setCode(event.target.value)}
                  />
                  <Button
                    type="submit"
                    className="h-10 shrink-0"
                    disabled={(!code.trim() && !joinedId) || busy !== null}
                  >
                    {busy === "invite"
                      ? t("onboarding.room.invite.busy")
                      : t("onboarding.room.invite.action")}
                  </Button>
                </form>
              )}
            </div>
          );
        })}

        {errorKey && (
          <p role="alert" className="pt-1 text-sm text-danger">
            {t(errorKey)}
          </p>
        )}
      </div>
    ),
  };
}

// ------------------------------------------------------------ step 4: pronto

function useReadyStep({
  user,
  created,
  onInvite,
  openRoom,
  onEnter,
}: {
  user: User;
  created: CreatedRoom | null;
  onInvite: (invite: Invite | null) => void;
  openRoom: () => Promise<void>;
  onEnter: () => void;
}): StepView {
  const { t } = useTranslation();
  const [retrying, setRetrying] = useState(false);
  const [copiedOnce, setCopiedOnce] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [entering, setEntering] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);

  async function enter() {
    if (entering) {
      return;
    }
    setEntering(true);
    setOpenFailed(false);
    try {
      await openRoom();
    } catch {
      setOpenFailed(true);
      setEntering(false);
      return;
    }
    onEnter();
  }

  async function retry() {
    if (!created || retrying) {
      return;
    }
    setRetrying(true);
    try {
      const { invite } = await createInvite(created.serverId, {
        expiresInHours: 168,
      });
      onInvite(invite);
    } catch {
      onInvite(null);
    } finally {
      setRetrying(false);
    }
  }

  return {
    eyebrow: t("onboarding.ready.eyebrow"),
    title: t("onboarding.ready.title"),
    description: t("onboarding.ready.description"),
    // The room exists and is loaded behind this; the only way on is in.
    dismissible: false,
    onClose: () => {},
    footer: (
      <Button
        data-onboarding-enter=""
        // Copying is the point of this screen, so until something is copied
        // the copy button is the loud one and this steps back. After, the
        // next thing to do is go in, and the emphasis moves here.
        variant={copiedOnce ? "default" : "secondary"}
        disabled={entering}
        onClick={() => void enter()}
      >
        {entering ? t("onboarding.you.entering") : t("onboarding.ready.enter")}
      </Button>
    ),
    body: (
      <div className="px-5 py-4">
        {created && <OrganizerConfetti userId={user.id} />}
        {created && (
          <ServerReadyPanel
            invite={created.invite}
            inviteRef="onboarding"
            retrying={retrying}
            onRetry={() => void retry()}
            onCopied={(kind) => {
              setCopiedOnce(true);
              setCopyFailed(false);
              track("onboarding_invite_copied", { kind });
            }}
            onCopyFailed={() => setCopyFailed(true)}
          />
        )}
        {copyFailed && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {t("importDiscord.error.copyFailed")}
          </p>
        )}
        {openFailed && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {t("onboarding.ready.openError")}
          </p>
        )}
      </div>
    ),
  };
}

/** The organizer's one burst, on the screen where the room exists. */
function OrganizerConfetti({ userId }: { userId: string }) {
  const [fire] = useState(() => !confettiSpent(sessionStore(), userId));
  useEffect(() => {
    if (fire) {
      spendConfetti(sessionStore(), userId);
    }
  }, [fire, userId]);
  return fire ? <Confetti /> : null;
}
