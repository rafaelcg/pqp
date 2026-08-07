import { useState } from "react";
import type { User } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { AvatarPicker } from "@/components/user/avatar-picker";
import { Confetti } from "@/components/onboarding/confetti";
import { createServer, joinInvite, updateMe, updatePreferences } from "@/lib/api";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import {
  handleErrorMessage,
  isValidUsername,
  normalizeInviteCode,
  normalizeUsername,
  onboardingCompletedPatch,
  tagWasReassigned,
  type OnboardingStep,
} from "@/lib/onboarding";

/**
 * First run, as the user meets it. Three screens, and the first one is the
 * reason the other two exist.
 *
 * WHY IT IS NOT A WALL. The age gate blocks because the server refuses every
 * route behind it — carrying on would paint a screen of 403s. Nothing here is
 * like that: the account works, the handle is already allocated, and somebody
 * who wants to get straight into a channel should be able to. So steps 2 and 3
 * both close the flow from their own footer, and closing it counts as answering
 * it. Step 1 has no skip because it has nothing to skip: the field arrives
 * pre-filled with the handle they already have, and "Looks right" saves nothing
 * and moves on.
 *
 * WHY THE HANDLE IS FIRST AND ALONE ON ITS SCREEN. This is the entire bug being
 * fixed. `deriveHandle` slugifies whatever the identity provider called the
 * account and allocates a number; nobody was ever shown the result. An account
 * that gave nothing usable ends up as `user_3f9a#0417`, which is a handle its
 * owner has no way of learning short of opening settings and looking. The tag is
 * printed large, before the field, because reading it is the job; editing it is
 * optional.
 *
 * WHY THERE IS CONFETTI ON A FORM. It is the moment somebody actually arrives,
 * and the product has nowhere else to mark that. The words stay deadpan
 * ("You're in" / "Now the paperwork") precisely because the animation is doing
 * the celebrating — this is not a product that says "yay". See `confetti.tsx`
 * for the reduced-motion path, which is not optional.
 *
 * MOBILE FIRST. `Dialog` is a bottom sheet under `sm:` and a centred panel
 * above it, so this is a sheet on a phone with no work here. Everything below
 * stacks in one column and only splits on `sm:`; nothing depends on hover.
 */

interface OnboardingFlowProps {
  user: User;
  /** Reflect a saved profile back into the app (sidebar, message authorship). */
  onUserUpdated: (user: User) => void;
  /**
   * A server was created or joined. The parent re-reads its list and opens it —
   * the flow deliberately does not know how to navigate.
   */
  onServerReady: (serverId: string) => Promise<void> | void;
  /** Finished or skipped. The parent stops rendering this. */
  onDone: () => void;
}

export function OnboardingFlow({
  user,
  onUserUpdated,
  onServerReady,
  onDone,
}: OnboardingFlowProps) {
  const [step, setStep] = useState<OnboardingStep>("handle");

  /**
   * Record that the flow is answered, then get out of the way.
   *
   * The parent is told first and the request is not awaited. A failed write only
   * costs one repeat of the flow on the next cold start, whereas awaiting it
   * would make a slow network look like a frozen dialog on the last click of
   * signup — the worst possible moment to look broken.
   */
  function finish() {
    void updatePreferences(onboardingCompletedPatch()).catch(() => {
      // Nothing to recover: the flow is closed either way, and the next
      // bootstrap re-reads the truth from the server.
    });
    onDone();
  }

  if (step === "handle") {
    return (
      <HandleStep
        user={user}
        onUserUpdated={onUserUpdated}
        onNext={() => setStep("profile")}
      />
    );
  }

  if (step === "profile") {
    return (
      <ProfileStep
        user={user}
        onUserUpdated={onUserUpdated}
        onNext={() => setStep("landing")}
        onSkip={finish}
      />
    );
  }

  return (
    <LandingStep
      onServerReady={async (serverId) => {
        await onServerReady(serverId);
        finish();
      }}
      onSkip={finish}
    />
  );
}

// ------------------------------------------------------------- step 1: handle

function HandleStep({
  user,
  onUserUpdated,
  onNext,
}: {
  user: User;
  onUserUpdated: (user: User) => void;
  onNext: () => void;
}) {
  const { t } = useTranslation();
  const [username, setUsername] = useState(user.username ?? "");
  const [tag, setTag] = useState(user.tag);
  const [saving, setSaving] = useState(false);
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);
  /** Set when the server kept the name but handed back a different number. */
  const [reassignedTag, setReassignedTag] = useState<string | null>(null);

  const unchanged = username === (user.username ?? "");
  const canSubmit = !saving && (unchanged || isValidUsername(username));

  async function submit() {
    if (!canSubmit) {
      return;
    }
    // Nothing to save: they read it and kept it, which is a complete answer.
    if (unchanged) {
      onNext();
      return;
    }

    setSaving(true);
    setErrorKey(null);
    try {
      const updated = await updateMe({ username });
      onUserUpdated(updated);
      if (tagWasReassigned(username, tag, updated.tag)) {
        // Stay on this screen and say what happened. Advancing here is how
        // somebody leaves onboarding believing in a handle nobody can type.
        setReassignedTag(updated.tag);
        setTag(updated.tag);
        setUsername(updated.username ?? username);
        return;
      }
      onNext();
    } catch (error) {
      setErrorKey(handleErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      eyebrow={t("onboarding.handle.eyebrow")}
      title={t("onboarding.handle.title")}
      description={t("onboarding.handle.description")}
      size="sm"
      // No X and no Escape on this one screen. There is nothing behind it yet
      // — the app opens the moment it closes — and a close affordance on the
      // step whose whole purpose is "read this" is a way to not read it.
      dismissible={false}
      onClose={() => {}}
      footer={
        <Button disabled={!canSubmit} onClick={() => void submit()}>
          {saving
            ? t("onboarding.saving")
            : reassignedTag
              ? t("onboarding.continue")
              : t("onboarding.handle.confirm")}
        </Button>
      }
    >
      <div className="space-y-4 px-5 py-4">
        {/* Fires once, on arrival. `HandleStep` stays mounted for the whole of
            step one, so typing, an error and a reassigned tag all re-render
            around this without re-triggering it. */}
        <Confetti />

        <p
          // The point of the screen. Big, monospaced and selectable so it can be
          // copied straight into a message to a friend.
          className="select-all break-all rounded-md border border-ink-4 bg-ink-3/40 px-3 py-3 text-center font-mono text-xl font-bold text-signal"
        >
          {tag ?? username}
        </p>

        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-paper-muted">
            {t("onboarding.handle.label")}
          </span>
          <Input
            value={username}
            inputMode="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={saving}
            onChange={(event) => {
              setUsername(normalizeUsername(event.target.value));
              setErrorKey(null);
              setReassignedTag(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void submit();
              }
            }}
          />
          <span className="mt-1 block text-xs text-paper-muted">
            {t("onboarding.handle.hint")}
          </span>
        </label>

        {reassignedTag && (
          <p
            role="status"
            className="rounded-md border border-ink-4 bg-ink-3/40 px-3 py-2 text-sm text-paper-muted"
          >
            {t("onboarding.handle.reassigned", { tag: reassignedTag })}
          </p>
        )}

        {errorKey && (
          <p role="alert" className="text-sm text-danger">
            {t(errorKey)}
          </p>
        )}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------ step 2: display name, avatar

function ProfileStep({
  user,
  onUserUpdated,
  onNext,
  onSkip,
}: {
  user: User;
  onUserUpdated: (user: User) => void;
  onNext: () => void;
  onSkip: () => void;
}) {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);

  async function submit() {
    const trimmed = displayName.trim();
    const changed =
      trimmed !== user.displayName || avatarUrl !== (user.avatarUrl ?? "");
    if (!changed) {
      onNext();
      return;
    }

    setSaving(true);
    setErrorKey(null);
    try {
      const updated = await updateMe({
        displayName: trimmed || undefined,
        avatarUrl: avatarUrl.trim() || null,
      });
      onUserUpdated(updated);
      onNext();
    } catch {
      // Deliberately not `handleErrorMessage`: that one explains handles, and
      // "that name is full" is nonsense advice about an avatar URL.
      setErrorKey("onboarding.profile.error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      eyebrow={t("onboarding.profile.eyebrow")}
      title={t("onboarding.profile.title")}
      description={t("onboarding.profile.description")}
      size="sm"
      // Dismissible from here on: closing is a valid answer, and it means the
      // same thing the skip button does.
      onClose={onSkip}
      footer={
        <>
          <Button variant="ghost" onClick={onSkip}>
            {t("onboarding.skip")}
          </Button>
          <Button disabled={saving} onClick={() => void submit()}>
            {saving
              ? t("onboarding.saving")
              : t("onboarding.continue")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 px-5 py-4">
        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-paper-muted">
            {t("onboarding.profile.displayName")}
          </span>
          <Input
            value={displayName}
            disabled={saving}
            placeholder={t("onboarding.profile.displayNamePlaceholder")}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>

        <div>
          <span className="mb-2 block text-xs uppercase tracking-wide text-paper-muted">
            {t("onboarding.profile.avatar")}
          </span>
          <AvatarPicker
            value={avatarUrl}
            onChange={setAvatarUrl}
            fallbackName={displayName}
            labels={{
              urlPlaceholder: t("onboarding.profile.avatarUrlPlaceholder"),
              urlLabel: t("onboarding.profile.avatarUrl"),
              presetLabel: t("onboarding.profile.avatarPreset"),
              clear: t("onboarding.profile.avatarClear"),
            }}
          />
        </div>

        {errorKey && (
          <p role="alert" className="text-sm text-danger">
            {t(errorKey)}
          </p>
        )}
      </div>
    </Dialog>
  );
}

// ----------------------------------------------- step 3: somewhere to land in

function LandingStep({
  onServerReady,
  onSkip,
}: {
  onServerReady: (serverId: string) => Promise<void> | void;
  onSkip: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  /** Which of the two is in flight — they must not both run at once. */
  const [busy, setBusy] = useState<"create" | "join" | null>(null);
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || busy) {
      return;
    }
    setBusy("create");
    setErrorKey(null);
    try {
      const { server } = await createServer(trimmed);
      await onServerReady(server.id);
    } catch {
      setErrorKey("onboarding.landing.createError");
      setBusy(null);
    }
  }

  async function join() {
    const trimmed = normalizeInviteCode(code);
    if (!trimmed || busy) {
      return;
    }
    setBusy("join");
    setErrorKey(null);
    try {
      const result = await joinInvite(trimmed);
      await onServerReady(result.serverId);
    } catch {
      // Expired, revoked, used up, or mistyped. One sentence covers all four
      // because the recovery is identical and the user cannot tell them apart.
      setErrorKey("onboarding.landing.joinError");
      setBusy(null);
    }
  }

  return (
    <Dialog
      open
      eyebrow={t("onboarding.landing.eyebrow")}
      title={t("onboarding.landing.title")}
      description={t("onboarding.landing.description")}
      size="sm"
      onClose={onSkip}
      footer={
        <Button variant="ghost" onClick={onSkip}>
          {t("onboarding.skip")}
        </Button>
      }
    >
      <div className="space-y-5 px-5 py-4">
        <div>
          <span className="mb-1 block text-xs uppercase tracking-wide text-paper-muted">
            {t("onboarding.landing.createLabel")}
          </span>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={name}
              disabled={busy !== null}
              placeholder={t("onboarding.landing.createPlaceholder")}
              aria-label={t("onboarding.landing.createLabel")}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void create();
                }
              }}
            />
            <Button
              className="sm:w-auto"
              disabled={!name.trim() || busy !== null}
              onClick={() => void create()}
            >
              {t("onboarding.landing.createAction")}
            </Button>
          </div>
          <span className="mt-1 block text-xs text-paper-muted">
            {t("onboarding.landing.createHint")}
          </span>
        </div>

        <div className="border-t border-ink-4 pt-4">
          <span className="mb-1 block text-xs uppercase tracking-wide text-paper-muted">
            {t("onboarding.landing.joinLabel")}
          </span>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={code}
              disabled={busy !== null}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder={t("onboarding.landing.joinPlaceholder")}
              aria-label={t("onboarding.landing.joinLabel")}
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void join();
                }
              }}
            />
            <Button
              variant="secondary"
              className="sm:w-auto"
              disabled={!code.trim() || busy !== null}
              onClick={() => void join()}
            >
              {t("onboarding.landing.joinAction")}
            </Button>
          </div>
        </div>

        {errorKey && (
          <p role="alert" className="text-sm text-danger">
            {t(errorKey)}
          </p>
        )}
      </div>
    </Dialog>
  );
}
