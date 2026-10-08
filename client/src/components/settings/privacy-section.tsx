import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Check, CircleCheck, Loader2, UserX } from "lucide-react";
import {
  parseUserTag,
  type BlockedUser,
  type DmPrivacy,
  type PublicUser,
  type User,
} from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioGroup, type RadioOption } from "@/components/ui/radio-group";
import {
  SETTINGS_BUSY,
  SettingsEmpty,
  SettingsGroup,
  SettingsInlineStatus,
  SettingsRow,
  inlineErrorMessage,
  useInlineSave,
  useSettingsAnnounce,
  type InlineSaveState,
} from "@/components/settings/kit";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import {
  ApiError,
  blockUser as blockUserRequest,
  lookupUserByHandle,
  lookupUserByTag,
  unblockUser as unblockUserRequest,
  updateMe,
} from "@/lib/api";

/* ----------------------------------------------------------------- privacy */

/** How long the "desbloqueado" notice stays up. */
const UNBLOCK_NOTICE_MS = 4000;

const DM_PRIVACY_OPTIONS: {
  value: DmPrivacy;
  label: MessageKey;
  description: MessageKey;
}[] = [
  {
    value: "everyone",
    label: "settings.privacy.dm.everyone",
    description: "settings.privacy.dm.everyoneHint",
  },
  {
    value: "server_members",
    label: "settings.privacy.dm.serverMembers",
    description: "settings.privacy.dm.serverMembersHint",
  },
  {
    value: "nobody",
    label: "settings.privacy.dm.nobody",
    description: "settings.privacy.dm.nobodyHint",
  },
];

/**
 * Find the account a typed `nome#0000` or `@handle` names, or null when there
 * is none. Any other failure (network, rate limit) is thrown for the caller to
 * say in words: "no such person" and "could not look" are different answers.
 */
async function findPerson(raw: string): Promise<PublicUser | null> {
  const tag = parseUserTag(raw);
  const handle = raw.trim().replace(/^@/, "");
  if (!tag && !handle) {
    return null;
  }
  try {
    const response = tag
      ? await lookupUserByTag(`${tag.username}#${tag.discriminator}`)
      : await lookupUserByHandle(handle);
    return response.user;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) {
      return null;
    }
    throw error;
  }
}

/**
 * "Salvando…" / "Salvo" next to the group title. The live region is always
 * mounted, so a screen reader announces the text when it fills in, and the
 * title row keeps its height whether or not anything is showing: nothing below
 * it moves when the write starts or ends.
 */
function TitleStatus({ state }: { state: InlineSaveState }) {
  const { t } = useTranslation();
  return (
    <span role="status" aria-live="polite" className="flex items-center gap-1 text-xs">
      {state.kind === "saving" ? (
        <span className="flex items-center gap-1 text-text-tertiary">
          <span aria-hidden>·</span>
          <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin" />
          {state.label ?? t("settings.saving")}
        </span>
      ) : null}
      {state.kind === "saved" ? (
        <span className="flex animate-fade-in items-center gap-1 text-text-secondary">
          <span aria-hidden>·</span>
          <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-success" />
          {t("settings.status.saved")}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A group whose title line also carries the save status. The kit's
 * `SettingsGroup` has no slot for that, so this repeats its header and box
 * (same classes) and adds one.
 */
function StatusGroup({
  title,
  description,
  status,
  children,
}: {
  title: string;
  description: string;
  status: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId}>
      <div className="min-w-0">
        <div className="flex min-h-5 items-center gap-2">
          <h4 id={titleId} className="text-sm font-semibold text-text">
            {title}
          </h4>
          {status}
        </div>
        <p className="mt-1 text-xs text-pretty text-text-tertiary">{description}</p>
      </div>
      <div className="elevation-1 mt-2 divide-y divide-border overflow-hidden rounded-[var(--radius-card)] bg-surface-card">
        {children}
      </div>
    </section>
  );
}

/**
 * Who may open a conversation with this account, and who has been blocked.
 *
 * Both apply the moment they are clicked rather than on Save, unlike the
 * profile fields in their own section. A privacy control that silently did
 * nothing because the dialog was dismissed is the one failure this section
 * cannot have: the user believes they are closed off and they are not.
 *
 * The rule is enforced on the server on every attempt to open a conversation.
 * Nothing here is the enforcement: this is the switch, not the lock. The
 * option descriptions follow `assertReachable` in `server/src/services/dms.ts`,
 * where an accepted friendship also passes `server_members` and `nobody` holds
 * against friends too.
 *
 * The DM options use manual activation: the arrow keys move focus and Space or
 * Enter picks. With the usual "arrows select" a keyboard user going from the
 * first option to the last would save the middle one on the way, two writes
 * and a wrong rule for a moment, on the one setting that must not be wrong.
 */
export function PrivacySection({
  user,
  blockedUsers,
  onUserUpdated,
  onUnblockUser,
  onBlockUser,
}: {
  user: User | null;
  blockedUsers: BlockedUser[];
  onUserUpdated: (user: User) => void;
  onUnblockUser: (userId: string) => void | Promise<void>;
  /**
   * Blocks somebody and refreshes the app's block list; should throw when the
   * block fails. Without it the section sends the block itself and keeps the
   * new row in its own list, but the rest of the app (the conversation list,
   * the friends list) only learns of the block on its next refresh.
   */
  onBlockUser?: (userId: string) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const save = useInlineSave();
  // Per row: one row's request finishing must not free another row's button.
  const [unblocking, setUnblocking] = useState<ReadonlySet<string>>(() => new Set());
  const unblockingRef = useRef(new Set<string>());
  const [unblockError, setUnblockError] = useState<{ id: string; message: string } | null>(
    null,
  );

  // Blocks made from this tab that the app's list has not caught up with.
  const [added, setAdded] = useState<BlockedUser[]>([]);
  const listed = [
    ...added.filter((one) => !blockedUsers.some((known) => known.id === one.id)),
    ...blockedUsers,
  ];

  // People whose unblock was asked for and has not shown up as a row leaving
  // yet. The notice waits for the row to go, which is when the change is
  // real for the person looking at the list.
  const awaiting = useRef(new Map<string, string>());
  const [notice, setNotice] = useState<string | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [working, setWorking] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const fieldId = useId();
  const errorId = useId();
  const fieldRef = useRef<HTMLInputElement>(null);
  const announce = useSettingsAnnounce();
  const noticeTimer = useRef<number | null>(null);

  useEffect(() => {
    for (const [id, name] of awaiting.current) {
      if (listed.some((one) => one.id === id)) {
        continue;
      }
      awaiting.current.delete(id);
      setNotice(t("settings.privacy.unblocked", { name }));
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
      noticeTimer.current = window.setTimeout(() => {
        noticeTimer.current = null;
        setNotice(null);
      }, UNBLOCK_NOTICE_MS);
      // The button that was pressed is gone with its row: keep the keyboard
      // inside the group instead of dropping it on the page. With the block
      // form open the add button is not drawn; the form's field is the stop.
      const active = document.activeElement;
      if (!active || active === document.body) {
        (adding ? fieldRef.current : addButton.current)?.focus();
      }
    }
  });

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  async function unblock(person: BlockedUser) {
    // A ref, not the state: two presses in one tick both read the old state.
    if (unblockingRef.current.has(person.id)) {
      return;
    }
    unblockingRef.current.add(person.id);
    setUnblocking(new Set(unblockingRef.current));
    setUnblockError(null);
    awaiting.current.set(person.id, person.displayName);
    try {
      if (blockedUsers.some((known) => known.id === person.id)) {
        await onUnblockUser(person.id);
      } else {
        // A block made from this tab that the app has not heard of yet: send
        // the request here, where a failure can still reach the row.
        await unblockUserRequest(person.id);
      }
      setAdded((current) => current.filter((one) => one.id !== person.id));
    } catch (err) {
      awaiting.current.delete(person.id);
      setUnblockError({
        id: person.id,
        message: inlineErrorMessage(
          err,
          t("settings.privacy.unblockFailed"),
          t("settings.status.rateLimited"),
        ),
      });
    } finally {
      unblockingRef.current.delete(person.id);
      setUnblocking(new Set(unblockingRef.current));
    }
  }

  // Blocking somebody by name.
  // Spoken through the dialog's announcer, which exists before the sentence
  // does; a role="alert" created already holding its text is often not read.
  // Without an announcer (onboarding, tests) the line is its own alert.
  useEffect(() => {
    if (announce && addError) announce(addError);
  }, [announce, addError]);

  function closeForm() {
    setAdding(false);
    setQuery("");
    setAddError(null);
    // The form took the button's place; hand focus back once it is drawn.
    window.setTimeout(() => addButton.current?.focus(), 0);
  }

  async function submitBlock(event: FormEvent) {
    event.preventDefault();
    const raw = query.trim();
    if (!raw || working) {
      return;
    }
    setWorking(true);
    setAddError(null);
    try {
      const person = await findPerson(raw);
      if (!person) {
        setAddError(t("settings.privacy.block.notFound"));
        return;
      }
      if (person.id === user?.id) {
        setAddError(t("settings.privacy.block.self"));
        return;
      }
      if (listed.some((one) => one.id === person.id)) {
        setAddError(t("settings.privacy.block.already", { name: person.displayName }));
        return;
      }
      if (onBlockUser) {
        await onBlockUser(person.id);
      } else {
        await blockUserRequest(person.id);
      }
      setAdded((current) => [
        { ...person, blockedAt: new Date().toISOString() },
        ...current.filter((one) => one.id !== person.id),
      ]);
      closeForm();
    } catch (err) {
      setAddError(
        inlineErrorMessage(
          err,
          t("settings.privacy.block.failed"),
          t("settings.status.rateLimited"),
        ),
      );
    } finally {
      setWorking(false);
    }
  }

  // The newest choice, and how many writes are not finished. A choice made
  // while one is saving is queued behind it by `useInlineSave` (only the last
  // queued one is sent), so the last click always wins. Refs rather than the
  // save state, so a second click in the same tick sees the first. The radios
  // stay enabled (and focused) the whole time.
  const latest = useRef<DmPrivacy | null>(null);
  const unfinished = useRef(0);
  // The option just picked, checked while its write is in flight so the save
  // status sits under the option the user chose. Cleared when the last write
  // ends: on success the account carries the new value, on failure the radio
  // goes back to the value that is actually stored and the error sits under it.
  const [pending, setPending] = useState<DmPrivacy | null>(null);
  const current = user?.dmPrivacy ?? "server_members";

  const options: RadioOption<DmPrivacy>[] = DM_PRIVACY_OPTIONS.map((option) => ({
    value: option.value,
    label: t(option.label),
    description: t(option.description),
  }));

  async function choose(value: DmPrivacy) {
    if (!user || value === (latest.current ?? current)) {
      return;
    }
    latest.current = value;
    unfinished.current += 1;
    setPending(value);
    try {
      await save.run(async () => {
        onUserUpdated(await updateMe({ dmPrivacy: value }));
      }, t("settings.privacy.saveFailed"));
    } finally {
      unfinished.current -= 1;
      if (unfinished.current === 0) {
        latest.current = null;
        setPending(null);
      }
    }
  }

  return (
    <div className="space-y-6">
      <StatusGroup
        title={t("settings.privacy.group.dm.title")}
        description={t("settings.privacy.dmHint")}
        status={<TitleStatus state={save.state} />}
      >
        <RadioGroup
          variant="list"
          activation="manual"
          label={t("settings.privacy.dmLabel")}
          value={pending ?? current}
          options={options}
          disabled={!user}
          onValueChange={(value) => void choose(value)}
          status={
            // Saving and saved are said beside the title. Only a failure
            // stays under the option, where the radio went back to.
            save.state.kind === "error" ? (
              <SettingsInlineStatus state={save.state} />
            ) : undefined
          }
        />
      </StatusGroup>

      <SettingsGroup
        title={t("settings.privacy.blocked")}
        description={t("settings.privacy.blockedHint")}
        action={
          adding ? undefined : (
            <Button
              ref={addButton}
              size="sm"
              variant="secondary"
              onClick={() => setAdding(true)}
            >
              <UserX aria-hidden className="h-4 w-4" />
              {t("settings.privacy.block.add")}
            </Button>
          )
        }
      >
        {adding ? (
          <form onSubmit={(event) => void submitBlock(event)} className="space-y-2 px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <label htmlFor={fieldId} className="sr-only">
                  {t("settings.privacy.block.label")}
                </label>
                <Input
                  id={fieldId}
                  ref={fieldRef}
                  autoFocus
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={query}
                  // Read-only, not disabled, while the lookup runs: a disabled
                  // field drops keyboard focus on the page.
                  readOnly={working}
                  aria-busy={working || undefined}
                  placeholder={t("settings.privacy.block.placeholder")}
                  aria-invalid={addError ? true : undefined}
                  aria-describedby={addError ? errorId : undefined}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setAddError(null);
                  }}
                />
              </div>
              <Button
                type="submit"
                size="sm"
                variant="danger"
                disabled={query.trim() === ""}
                aria-disabled={working || undefined}
                className={working ? SETTINGS_BUSY : undefined}
              >
                {t("settings.privacy.block.confirm")}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={closeForm}>
                {t("common.cancel")}
              </Button>
            </div>
            {addError ? (
              <p
                id={errorId}
                role={announce ? undefined : "alert"}
                className="text-xs text-danger"
              >
                {addError}
              </p>
            ) : (
              <p className="text-xs text-pretty text-text-tertiary">
                {t("settings.privacy.block.notice")}
              </p>
            )}
          </form>
        ) : null}
        {listed.length === 0 && !adding ? (
          <SettingsEmpty
            icon={UserX}
            title={t("settings.privacy.blockedEmpty")}
            description={t("settings.privacy.blockedEmptyHint")}
          />
        ) : (
          listed.map((blocked) => (
            <SettingsRow
              key={blocked.id}
              id={`blocked-${blocked.id}`}
              searchable={false}
              keepInline
              leading={
                <UserAvatar
                  name={blocked.displayName}
                  avatarUrl={blocked.avatarUrl}
                  rounded="full"
                  className="h-8 w-8"
                />
              }
              label={blocked.displayName}
              description={
                blocked.tag ? (
                  <span className="font-mono [overflow-wrap:anywhere]">{blocked.tag}</span>
                ) : undefined
              }
              control={
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={t("settings.privacy.unblockNamed", {
                    name: blocked.displayName,
                  })}
                  // Busy but focusable: a disabled button drops keyboard
                  // focus on the page, and a failure keeps the row.
                  aria-disabled={unblocking.has(blocked.id) || undefined}
                  className={unblocking.has(blocked.id) ? SETTINGS_BUSY : undefined}
                  onClick={() => void unblock(blocked)}
                >
                  {t("settings.privacy.unblock")}
                </Button>
              }
              status={
                unblockError?.id === blocked.id ? (
                  <SettingsInlineStatus
                    state={{ kind: "error", message: unblockError.message }}
                  />
                ) : undefined
              }
            />
          ))
        )}
      </SettingsGroup>

      <div role="status" aria-live="polite">
        {notice ? (
          <div className="pointer-events-none fixed inset-x-4 bottom-6 z-[70] flex justify-center">
            <div className="elevation-2 flex animate-fade-in items-center gap-2.5 rounded-[var(--radius-control)] px-3.5 py-2.5 text-sm text-text">
              <CircleCheck aria-hidden className="h-4 w-4 shrink-0 text-success" />
              <span className="min-w-0 text-pretty">{notice}</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
