import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Check, CircleX, ExternalLink, Loader2, Upload } from "lucide-react";
import {
  canRenameHandle,
  DISPLAY_NAME_MAX_LENGTH,
  formatUserTag,
  HANDLE_MAX_LENGTH,
  handleRenameAvailableAt,
  MAX_USER_BANNER_BYTES,
  normalizeHandle,
  publicProfileDisplayUrl,
  publicProfilePath,
  USER_BANNER_HEIGHT,
  USER_BANNER_MIME_ALLOWLIST,
  USER_BANNER_WIDTH,
  validateHandle,
  type User,
  type UserBannerConfig,
} from "@pqp/shared";
import { hasBidiControl } from "@/components/settings/profile-patch";
import {
  SETTINGS_BUSY,
  SettingsCopyButton,
  SettingsGroup,
  SettingsInlineStatus,
  SettingsNotice,
  SettingsPreview,
  SettingsRow,
  useInlineSave,
  useSettingsShell,
} from "@/components/settings/kit";
import { SignOutButton } from "@/components/layout/sign-out-button";
import { Button } from "@/components/ui/button";
import { FileDropZone } from "@/components/ui/file-drop-zone";
import { Input } from "@/components/ui/input";
import {
  AvatarPicker,
  avatarUploadEnabled,
  localizedUploadFailure,
} from "@/components/user/avatar-picker";
import { UserAvatar } from "@/components/user/user-avatar";
import {
  deleteUserBanner,
  fetchPublicProfile,
  fetchUserBannerConfig,
} from "@/lib/api";
import { resolveUploadedImageUrl } from "@/lib/avatar";
import { uploadUserBanner } from "@/lib/banner-upload";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";
import { firstDroppedFile, type DroppedItems } from "@/lib/file-drop";
import { useTranslation } from "@/lib/i18n";
import { intlLocale } from "@/lib/locale";
import { cn } from "@/lib/utils";

/**
 * What the drawing of each ready-made avatar looks like, in the order of
 * `AVATAR_PRESETS`. Literal keys, so the i18n scan sees every one.
 */
const PRESET_NAME_KEYS = [
  "settings.profile.avatar.presetName.1",
  "settings.profile.avatar.presetName.2",
  "settings.profile.avatar.presetName.3",
  "settings.profile.avatar.presetName.4",
  "settings.profile.avatar.presetName.5",
  "settings.profile.avatar.presetName.6",
  "settings.profile.avatar.presetName.7",
  "settings.profile.avatar.presetName.8",
] as const;

/**
 * Enter in a single-line field is the same as pressing Salvar alterações: the
 * shell's own button, so its checks and the 30-day link confirm run exactly as
 * they do for a click. Asked after the render, so a value the handler just
 * staged (the name with its spaces collapsed) is the one that is saved. A
 * save bar that is not up (nothing staged) is a click on nothing, and a busy
 * one (only `aria-disabled`, so it keeps focus) ignores the click itself.
 */
export function requestProfileSave(): void {
  window.setTimeout(() => {
    document.querySelector<HTMLButtonElement>("[data-unsaved-save]")?.click();
  }, 0);
}

/** Two or more spaces in a row become one. Leading and trailing ones are the save's to trim. */
function collapseSpaces(value: string): string {
  return value.replace(/ {2,}/g, " ");
}

/** Enter in a single-line field saves, unless it is confirming an IME word. */
function saveOnEnter(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
    requestProfileSave();
  }
}

/**
 * What the username field keeps of a keystroke or a paste: lowercase, accents
 * taken off the way the link field does it ("João" is "joao", not "joo"),
 * spaces as "_", and nothing else outside a to z, 0 to 9 and "_".
 */
export function usernameFromInput(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

/**
 * What the link field keeps of a paste. A whole address ("https://pqp.gg/@rafa",
 * "pqp.gg/@rafa/", with a query or not) is cut down to its last path segment
 * first, so it gives "rafa" rather than "httpspqp.ggrafa". Only when there is
 * a "/": a handle may hold a dot, so "pqp.gg" on its own is a handle.
 */
export function handleFromInput(raw: string): string {
  let value = raw;
  if (value.includes("/")) {
    const path = value.split(/[?#]/)[0]!.replace(/\/+\s*$/, "");
    value = path.slice(path.lastIndexOf("/") + 1);
  }
  // The length cap lives here, not on the input: a `maxLength` there cuts a
  // pasted address to 20 characters before this sees it, and
  // "https://pqp.gg/@" alone is 16 of them.
  return normalizeHandle(value).slice(0, HANDLE_MAX_LENGTH);
}

/** The counter shows from this many characters short of the limit. */
const NAME_COUNTER_FROM = 8;

/* ------------------------------------------------------------ availability */

/** Long enough that typing a name is one request, short enough to feel live. */
const HANDLE_CHECK_DEBOUNCE_MS = 350;

export type HandleAvailability =
  | "idle"
  | "checking"
  | "free"
  | "taken"
  | "reserved"
  | "blocked";

/**
 * Whether the link being typed is free, asked of the same public profile read
 * the claim page uses (a 404 is "free"). Debounced and aborted, so the answer
 * on screen is always for what is in the box.
 *
 * Silent where it cannot tell: the link you already own, a link that is too
 * short or malformed (the rule line under the field says so), a rename that
 * is locked, and any failure of the read itself (a 429 from typing fast, the
 * API being down). None of those is "free", and none of them is worth a red
 * line either: the save still checks.
 */
export function useHandleAvailability(
  handle: string,
  ownedHandle: string | null,
  enabled: boolean,
): HandleAvailability {
  // Kept with the link it answers, so the render after an edit never shows
  // (or hands the save) the previous link's answer for the new one.
  const [answer, setAnswer] = useState<{ handle: string; value: HandleAvailability }>({
    handle: "",
    value: "idle",
  });
  useEffect(() => {
    const candidate = handle.trim();
    const setAvailability = (value: HandleAvailability) =>
      setAnswer({ handle: candidate, value });
    if (!enabled || !candidate || candidate === (ownedHandle ?? "")) {
      setAvailability("idle");
      return;
    }
    const rejection = validateHandle(candidate);
    if (rejection === "reserved" || rejection === "blocked") {
      // The public read 404s these too, which would say "free".
      setAvailability(rejection);
      return;
    }
    if (rejection) {
      setAvailability("idle");
      return;
    }
    setAvailability("checking");
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetchPublicProfile(candidate, { signal: controller.signal })
        .then((profile) => setAvailability(profile ? "taken" : "free"))
        .catch(() => {
          if (!controller.signal.aborted) {
            setAvailability("idle");
          }
        });
    }, HANDLE_CHECK_DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [handle, ownedHandle, enabled]);
  if (answer.handle === handle.trim()) {
    return answer.value;
  }
  // The render between a keystroke and its effect. While a check is already
  // running, the next one is checking too: dropping to idle there emptied the
  // live region on every key, so "Verificando…" was said once per letter.
  return answer.value === "checking" ? "checking" : "idle";
}

/**
 * One line under the link field, in one live region that stays mounted, so a
 * screen reader hears each new answer instead of a region that appears with it.
 */
function HandleAvailabilityLine({ availability }: { availability: HandleAvailability }) {
  const { t } = useTranslation();
  let text: string | null = null;
  let icon: ReactNode = null;
  let tone = "text-text-tertiary";
  switch (availability) {
    case "checking":
      text = t("settings.profile.publicHandle.checking");
      icon = <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin" />;
      break;
    case "free":
      text = t("settings.profile.publicHandle.free");
      icon = <Check aria-hidden className="h-3.5 w-3.5 shrink-0" />;
      tone = "text-success";
      break;
    case "taken":
      text = t("settings.profile.publicHandle.taken");
      icon = <CircleX aria-hidden className="h-3.5 w-3.5 shrink-0" />;
      tone = "text-danger";
      break;
    case "reserved":
      text = t("claim.reserved");
      icon = <CircleX aria-hidden className="h-3.5 w-3.5 shrink-0" />;
      tone = "text-danger";
      break;
    case "blocked":
      text = t("claim.blocked");
      icon = <CircleX aria-hidden className="h-3.5 w-3.5 shrink-0" />;
      tone = "text-danger";
      break;
    default:
      break;
  }
  return (
    <span
      role="status"
      aria-live="polite"
      data-handle-availability={availability}
      className={cn("flex items-center gap-1.5 text-xs", tone)}
    >
      {text ? (
        <>
          {icon}
          {text}
        </>
      ) : null}
    </span>
  );
}

/* ----------------------------------------------------------------- profile */

/**
 * Perfil: how you appear and how people find you.
 *
 * Name, username, public link and avatar are the only staged values in
 * Settings. Their drafts live in the shell, which owns the unsaved bar, the
 * handle confirm and the close guard; this tab only edits them. Uploads (avatar
 * and banner) apply the moment they finish and report in their own row.
 *
 * The avatar control is `AvatarPicker` rather than anything local, because the
 * preset list it draws is the one onboarding imports.
 */
export function ProfileSection({
  user,
  displayName,
  onDisplayName,
  displayNameError = null,
  username,
  onUsername,
  handle,
  onHandle,
  avatarUrl,
  onAvatarUrl,
  onUserUpdated,
  onHandleAvailability,
}: {
  user: User | null;
  displayName: string;
  onDisplayName: (next: string) => void;
  /** A save was refused because the name is blank. The bar says it too. */
  displayNameError?: string | null;
  username: string;
  onUsername: (next: string) => void;
  handle: string;
  onHandle: (next: string) => void;
  avatarUrl: string;
  onAvatarUrl: (next: string) => void;
  onUserUpdated: (user: User) => void;
  /**
   * The live answer for the link being typed, with the link it is for. The
   * shell refuses a save the field already showed as taken, before the
   * 30-day confirm.
   */
  onHandleAvailability?: (handle: string, availability: HandleAvailability) => void;
}) {
  const { t, locale } = useTranslation();
  const nameId = useId();
  const nameErrorId = useId();
  const nameCountId = useId();
  const handleId = useId();
  const handleDescriptionId = useId();
  const handleErrorId = useId();
  const handleRuleId = useId();
  const usernameId = useId();
  const usernameKeptId = useId();
  const handleKeptId = useId();
  const storage = useStorageConfig();
  // The name as it was when the field got focus, and whether it was left
  // empty. The save says the same later; this says it as you leave the field.
  const nameAtFocus = useRef("");
  const [nameLeftEmpty, setNameLeftEmpty] = useState(false);
  // The last save lost the link to somebody else. The shell recognised the
  // 409, said it in the reader's language and clears it when the link changes.
  const { profileHandleError: handleError } = useSettingsShell();

  // Null while the account has never claimed one, or once the window is over.
  const renameAvailableAt = canRenameHandle(user?.handleChangedAt, user?.handle)
    ? null
    : handleRenameAvailableAt(user?.handleChangedAt, user?.handle);

  const ownedHandle = user?.handle ?? null;
  const availability = useHandleAvailability(
    handle,
    ownedHandle,
    renameAvailableAt === null,
  );
  const reportAvailability = useRef(onHandleAvailability);
  reportAvailability.current = onHandleAvailability;
  useEffect(() => {
    reportAvailability.current?.(handle.trim(), availability);
  }, [handle, availability]);
  // Neither the link nor the username can be given up, so an emptied field
  // saves nothing. Said under it, with what stays.
  const savedUsername = user?.username ?? "";
  const usernameKept = username.trim() === "" && savedUsername !== "";
  const handleKept = handle.trim() === "" && ownedHandle !== null;
  const tag = user?.tag ?? null;
  // The preview follows the drafts, so it changes while somebody types. The
  // number after the # is the saved one: a renamed username keeps it unless
  // the name is taken, and only the save can say.
  const previewName = displayName.trim() || user?.displayName || "";
  // One line for the empty name, wherever it came from: the save's refusal
  // wins, and the blur says it first.
  const nameError =
    displayNameError ??
    (displayName !== (user?.displayName ?? "") && hasBidiControl(displayName)
      ? t("settings.profile.displayNameControls")
      : null) ??
    (nameLeftEmpty && !displayName.trim()
      ? t("settings.profile.displayNameRequired")
      : null);
  const nameCounting = displayName.length >= DISPLAY_NAME_MAX_LENGTH - NAME_COUNTER_FROM;
  const previewId = handle.trim()
    ? `@${handle.trim()}`
    : formatUserTag(username.trim() || user?.username, user?.discriminator) ??
      tag ??
      "";
  // The group title already names the drawing, so the summary says what is in
  // it: the name and the link or tag, as the public page would show them.
  const previewSummary = previewName
    ? previewId
      ? t("settings.profile.preview.summary", { name: previewName, identifier: previewId })
      : t("settings.profile.preview.summaryName", { name: previewName })
    : undefined;

  return (
    <div className="space-y-6">
      <SettingsGroup title={t("settings.profile.preview")} surface="plain">
        <SettingsPreview summary={previewSummary}>
          <ProfilePreviewCard
            bannerUrl={resolveUploadedImageUrl(user?.bannerUrl ?? null)}
            name={previewName}
            avatarUrl={avatarUrl}
            identifier={previewId}
            isHandle={handle.trim() !== ""}
          />
        </SettingsPreview>
      </SettingsGroup>

      <SettingsGroup title={t("settings.profile.group.identity")}>
        <SettingsRow
          id="display-name"
          label={t("settings.profile.displayName")}
          htmlFor={nameId}
          stacked
          control={
            <>
              <Input
                id={nameId}
                value={displayName}
                maxLength={DISPLAY_NAME_MAX_LENGTH}
                aria-invalid={nameError ? true : undefined}
                aria-describedby={
                  [nameError ? nameErrorId : null, nameCounting ? nameCountId : null]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
                className={cn("max-sm:h-11", nameError && "border-danger")}
                onChange={(event) => {
                  setNameLeftEmpty(false);
                  onDisplayName(event.target.value);
                }}
                onFocus={() => {
                  nameAtFocus.current = displayName;
                }}
                onBlur={() => {
                  // Repeated spaces are collapsed only in a name that was
                  // edited: an untouched "Ana  QA" must not turn dirty just
                  // because somebody clicked through the field.
                  const collapsed = collapseSpaces(displayName);
                  if (displayName !== nameAtFocus.current && collapsed !== displayName) {
                    onDisplayName(collapsed);
                  }
                  setNameLeftEmpty(!displayName.trim());
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    const collapsed = collapseSpaces(displayName);
                    if (displayName !== nameAtFocus.current && collapsed !== displayName) {
                      onDisplayName(collapsed);
                    }
                    requestProfileSave();
                  }
                }}
              />
              {nameError || nameCounting ? (
                <div className="flex items-start justify-between gap-3">
                  <div id={nameErrorId} className="min-w-0">
                    {nameError ? (
                      <SettingsInlineStatus
                        state={{ kind: "error", message: nameError }}
                      />
                    ) : null}
                  </div>
                  {nameCounting ? (
                    <span
                      id={nameCountId}
                      className="mt-1.5 shrink-0 text-xs tabular-nums text-text-tertiary"
                    >
                      {displayName.length}/{DISPLAY_NAME_MAX_LENGTH}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </>
          }
        />

        <SettingsRow
          id="avatar"
          label={t("settings.profile.avatar")}
          stacked
          control={
            <AvatarPicker
              value={avatarUrl}
              onChange={onAvatarUrl}
              fallbackName={previewName}
              labels={{
                urlPlaceholder: t("settings.profile.avatar.urlPlaceholder"),
                urlLabel: t("settings.profile.avatar.urlLabel"),
                presets: t("settings.profile.avatar.presets"),
                preset: (name) => t("settings.profile.avatar.presetItem", { name }),
                presetName: (number) => t(PRESET_NAME_KEYS[number - 1]),
                presetSelected: (name) =>
                  t("settings.profile.avatar.presetSelected", { name }),
                remove: t("settings.profile.avatar.clear"),
                useLink: t("settings.profile.avatar.useLink"),
                upload: t("settings.profile.avatar.upload"),
                uploading: t("settings.profile.uploading"),
                uploadFailed: t("settings.profile.avatar.failed"),
              }}
              // The claim already wrote it, so the app's copy of the account
              // is updated here rather than waiting for a save, or the sidebar
              // keeps the old picture. The draft follows too: left behind, it
              // would read as an unsaved edit, and a later save would put the
              // old picture back.
              onSubmit={requestProfileSave}
              onUploaded={(updated) => {
                onAvatarUrl(updated.avatarUrl ?? "");
                onUserUpdated(updated);
              }}
            />
          }
        />

        <BannerRow
          user={user}
          storage={storage}
          onUserUpdated={onUserUpdated}
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.profile.group.discovery")}>
        <SettingsRow
          id="public-link"
          label={t("settings.profile.publicHandle")}
          htmlFor={handleId}
          description={
            // Its id describes the field too, so the cooldown date is read
            // with it rather than only with the row.
            <span id={handleDescriptionId}>
              {renameAvailableAt
                ? t("settings.profile.publicHandle.cooldown", {
                    date: renameAvailableAt.toLocaleDateString(intlLocale(locale), {
                      day: "numeric",
                      month: "long",
                      year: "numeric",
                    }),
                  })
                : t("settings.profile.publicHandle.hint")}
            </span>
          }
          stacked
          control={
            <div className="space-y-3">
              {/* One field with the address in front, so what you type reads
                  as the link it becomes. The prefix is text, never part of the
                  value. */}
              <div>
                <Input
                  id={handleId}
                  prefix="pqp.gg/@"
                  value={handle}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={renameAvailableAt !== null}
                  placeholder={t("settings.profile.publicHandle.placeholder")}
                  aria-invalid={
                    handleError || availability === "taken" ? true : undefined
                  }
                  aria-describedby={[
                    handleDescriptionId,
                    renameAvailableAt === null ? handleRuleId : null,
                    handleError ? handleErrorId : null,
                    handleKept ? handleKeptId : null,
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onChange={(event) => onHandle(handleFromInput(event.target.value))}
                  onKeyDown={saveOnEnter}
                  className="font-mono max-sm:h-11"
                />
                {renameAvailableAt === null ? (
                  // The rule is always there; the answer sits beside it. The
                  // answer steps aside for the save's own refusal, which says
                  // the same thing about the same link.
                  <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span id={handleRuleId} className="text-xs text-text-tertiary">
                      {t("settings.profile.publicHandle.rule")}
                    </span>
                    <HandleAvailabilityLine
                      availability={handleError ? "idle" : availability}
                    />
                  </div>
                ) : null}
                {handleError ? (
                  <div id={handleErrorId}>
                    {/* The unsaved bar says this sentence; here it is
                        plain text the field describes itself with. */}
                    <SettingsInlineStatus
                      quiet
                      state={{ kind: "error", message: handleError }}
                    />
                  </div>
                ) : null}
                {handleKept ? (
                  <p id={handleKeptId} className="mt-1.5 text-xs text-pretty text-text-tertiary">
                    {t("settings.profile.publicHandle.kept", { handle: ownedHandle })}
                  </p>
                ) : null}
              </div>

              {/* What you own, as opposed to what you are typing: the actions
                  act on the saved link, never on a draft. */}
              {ownedHandle ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    data-owned-public-link
                    className="min-w-0 break-all font-mono text-xs text-text-secondary"
                  >
                    {publicProfileDisplayUrl(ownedHandle)}
                  </span>
                  <SettingsCopyButton
                    showLabel
                    text={`https://${publicProfileDisplayUrl(ownedHandle)}`}
                    label={t("settings.profile.publicHandle.copy")}
                    copiedLabel={t("settings.profile.publicHandle.copied")}
                    className="max-sm:h-11"
                  />
                  <Button asChild variant="ghost" size="sm" className="max-sm:h-11">
                    <a
                      href={publicProfilePath(ownedHandle)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink aria-hidden className="h-3.5 w-3.5" />
                      {t("settings.profile.publicHandle.view")}
                    </a>
                  </Button>
                </div>
              ) : null}
            </div>
          }
        />

        <SettingsRow
          id="username"
          label={t("settings.profile.username")}
          htmlFor={usernameId}
          description={t("settings.profile.usernameHint")}
          stacked
          control={
            <div className="space-y-2">
              <Input
                id={usernameId}
                value={username}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-describedby={usernameKept ? usernameKeptId : undefined}
                onChange={(event) => onUsername(usernameFromInput(event.target.value))}
                onKeyDown={saveOnEnter}
                placeholder={t("settings.profile.usernamePlaceholder")}
                className="max-sm:h-11"
              />
              {usernameKept ? (
                <p id={usernameKeptId} className="text-xs text-pretty text-text-tertiary">
                  {t("settings.profile.usernameKept", { username: savedUsername })}
                </p>
              ) : null}
              {/* The tag is how somebody adds you inside the app. It is the
                  saved one, not the draft: the number is the server's. */}
              {tag ? (
                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-text-tertiary">
                  <span>{t("settings.profile.handle")}</span>
                  <span className="min-w-0 break-all font-mono text-text">{tag}</span>
                  {/* 44px on a phone, where it is a thumb target beside small
                      text; the kit's 32px from `sm` up. */}
                  <SettingsCopyButton
                    text={tag}
                    label={t("settings.profile.tag.copy")}
                    copiedLabel={t("settings.profile.tag.copied")}
                    className="max-sm:h-11 max-sm:w-11"
                  />
                </div>
              ) : null}
            </div>
          }
        />
      </SettingsGroup>

      {/* Sign out sits in the rail footer from `sm` up. On a phone the rail is
          a tab strip with no footer, so it closes this tab instead. Under the
          dev bypass there is no session to end and the button renders
          nothing, so neither does the group. */}
      {isDevAuthBypassEnabled() ? null : (
        <SettingsGroup
          title={t("settings.profile.group.session")}
          className="sm:hidden"
        >
          <SettingsRow
            id="sign-out"
            label={t("settings.profile.session.row")}
            control={<SignOutButton />}
          />
        </SettingsGroup>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- preview */

/**
 * The top of `pqp.gg/@you`, drawn from the drafts: banner, avatar overlapping
 * it, name and the link or tag. On a narrow pane the info line sits under the
 * avatar; from `@lg` it sits beside it, the way the public page lays it out.
 */
function ProfilePreviewCard({
  bannerUrl,
  name,
  avatarUrl,
  identifier,
  isHandle,
}: {
  bannerUrl: string | null;
  name: string;
  avatarUrl: string;
  identifier: string;
  isHandle: boolean;
}) {
  return (
    <div>
      <div className="h-24 w-full overflow-hidden">
        {bannerUrl ? (
          <img
            src={bannerUrl}
            alt=""
            className="h-full w-full object-cover"
            decoding="async"
          />
        ) : (
          // Only the empty state. A real banner always wins.
          <div className="h-full w-full bg-gradient-to-br from-accent-soft to-surface-2" />
        )}
      </div>
      <div className="flex flex-col gap-2 px-4 pb-4 @lg:flex-row @lg:items-end @lg:gap-3.5 @lg:px-5">
        <div className="-mt-8 w-fit shrink-0 rounded-full border-4 border-surface-0 @lg:-mt-9">
          <UserAvatar
            name={name}
            avatarUrl={avatarUrl || null}
            rounded="full"
            className="h-16 w-16 @lg:h-[4.5rem] @lg:w-[4.5rem]"
            fallbackClassName="bg-accent text-2xl text-on-accent"
          />
        </div>
        <div className="min-w-0 @lg:pb-1">
          <p className="truncate font-display text-xl font-bold text-text">{name}</p>
          {identifier ? (
            <p
              className={cn(
                "break-all font-mono",
                isHandle
                  ? "text-sm font-semibold text-accent"
                  : "text-xs text-text-tertiary",
              )}
            >
              {identifier}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- storage */

/**
 * Whether this deployment can take an avatar and a banner upload. Both are
 * memoised for the life of the tab: storage is either configured or it is not,
 * and re-asking every time the dialog opens is a round trip spent looking at a
 * blank slot. Null until both have answered.
 */
let bannerConfigPromise: Promise<UserBannerConfig> | null = null;

function bannerUploadConfig(): Promise<UserBannerConfig> {
  bannerConfigPromise ??= fetchUserBannerConfig().catch(() => {
    // A failed read is not the server's answer: forget it, so the next open
    // of Settings asks again instead of hiding uploads for the whole tab.
    bannerConfigPromise = null;
    return {
      enabled: false,
      maxBytes: MAX_USER_BANNER_BYTES,
      width: USER_BANNER_WIDTH,
      height: USER_BANNER_HEIGHT,
    };
  });
  return bannerConfigPromise;
}

interface StorageConfig {
  avatar: boolean;
  banner: boolean;
}

function useStorageConfig(): StorageConfig | null {
  const [config, setConfig] = useState<StorageConfig | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([avatarUploadEnabled(), bannerUploadConfig()]).then(
      ([avatar, banner]) => {
        if (!cancelled) {
          setConfig({ avatar: avatar.enabled, banner: banner.enabled });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return config;
}

/* ------------------------------------------------------------------ banner */

/**
 * The profile banner, uploaded and claimed the moment it is picked.
 *
 * NOT A DRAFT, unlike the name, link and avatar: the bytes are already in the
 * bucket and the row already points at them, so there is nothing a later save
 * could apply and nothing Descartar could take back. The row reports what
 * happened, and hands the updated account upward so the preview changes while
 * the dialog is still open.
 */
function BannerRow({
  user,
  storage,
  onUserUpdated,
}: {
  user: User | null;
  storage: StorageConfig | null;
  onUserUpdated: (user: User) => void;
}) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLButtonElement>(null);
  const write = useInlineSave();
  // One status line for both writes: "Enviando…" for an upload, the kit's
  // "Salvando…" for a removal.
  const [action, setAction] = useState<"upload" | "remove">("upload");
  const busy = write.state.kind === "saving";
  const hasBanner = Boolean(user?.bannerUrl);
  const enabled = storage?.banner ?? false;

  function handleFile(file: File) {
    if (busy) return;
    const failed = t("settings.profile.banner.failed");
    setAction("upload");
    void write.run(async () => {
      try {
        onUserUpdated(await uploadUserBanner(file));
      } catch (error) {
        throw localizedUploadFailure(error, failed);
      }
    }, failed);
  }

  /** A drop goes through the same `handleFile` as the picker: same crop, same checks. */
  function handleDrop(items: DroppedItems) {
    const { file, folder } = firstDroppedFile(items);
    if (file) {
      handleFile(file);
    } else if (folder) {
      const message = t("composer.dropFolder_one", { name: folder });
      setAction("upload");
      void write.run(async () => {
        throw new Error(message);
      }, message);
    }
  }

  function handleRemove() {
    if (busy) return;
    setAction("remove");
    void write.run(async () => {
      const res = await deleteUserBanner();
      onUserUpdated(res.user);
    }, t("settings.profile.banner.removeFailed"));
  }

  // A removal takes Remover away with it: focus moves to the upload button
  // beside it rather than to the page.
  const hadBanner = useRef(hasBanner);
  useEffect(() => {
    const removed = hadBanner.current && !hasBanner;
    hadBanner.current = hasBanner;
    if (!removed) return;
    const focused = document.activeElement;
    if (!focused || focused === document.body || !focused.isConnected) {
      uploadRef.current?.focus();
    }
  }, [hasBanner]);

  // This server takes no images at all (or no banner). There is nothing to
  // do in a row, so there is no row: one quiet line says what does work. It
  // is just there when the tab opens, so it is a note and not a live region.
  if (storage && !storage.banner) {
    return (
      <SettingsNotice tone="info" inGroup role="note">
        {storage.avatar
          ? t("settings.profile.banner.unconfigured")
          : t("settings.profile.media.unconfigured")}
      </SettingsNotice>
    );
  }

  return (
    <FileDropZone
      mode={enabled && !busy ? "accept" : "off"}
      onDrop={handleDrop}
      acceptLabel={t("chrome.dropImage")}
      size="field"
    >
    <SettingsRow
      id="banner"
      data-profile-banner=""
      label={t("settings.profile.banner")}
      description={
        enabled
          ? t("settings.profile.banner.hint", {
              width: USER_BANNER_WIDTH,
              height: USER_BANNER_HEIGHT,
            })
          : t("settings.profile.banner.description")
      }
      status={
        <SettingsInlineStatus
          state={write.state}
          savingLabel={action === "upload" ? t("settings.profile.uploading") : undefined}
        />
      }
      control={
        enabled ? (
          <div className="flex flex-wrap items-center gap-2">
            {/* Busy, not disabled, while a write runs: a disabled button drops
                keyboard focus on the page. */}
            <Button
              ref={uploadRef}
              type="button"
              variant="secondary"
              size="sm"
              aria-disabled={busy || undefined}
              className={cn("max-sm:h-11", busy && SETTINGS_BUSY)}
              onClick={() => {
                if (!busy) fileRef.current?.click();
              }}
            >
              <Upload aria-hidden className="h-3.5 w-3.5" />
              {hasBanner
                ? t("settings.profile.banner.replace")
                : t("settings.profile.banner.upload")}
            </Button>
            {hasBanner ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-disabled={busy || undefined}
                className={cn("max-sm:h-11", busy && SETTINGS_BUSY)}
                onClick={handleRemove}
              >
                {t("settings.profile.banner.remove")}
              </Button>
            ) : null}
            <input
              ref={fileRef}
              type="file"
              tabIndex={-1}
              aria-label={t("settings.profile.banner")}
              // A hint to the picker, never a check: the real gate is that
              // `createImageBitmap` refuses to decode anything that is not an
              // image, and what is uploaded is a JPEG this browser produced
              // rather than the bytes that were chosen.
              accept={USER_BANNER_MIME_ALLOWLIST.join(",")}
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Cleared before the upload, so picking the same file twice
                // after a failure still fires a change event.
                event.target.value = "";
                if (file) {
                  handleFile(file);
                }
              }}
            />
          </div>
        ) : undefined
      }
    >
    </SettingsRow>
    </FileDropZone>
  );
}
