import { useState } from "react";
import { type BlockedUser, type DmPrivacy, type User } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { updateMe } from "@/lib/api";
import { Field, chipClass, messageOf } from "@/components/settings/ui";

/* ----------------------------------------------------------------- privacy */

const DM_PRIVACY_OPTIONS: { value: DmPrivacy; label: MessageKey }[] = [
  { value: "everyone", label: "settings.privacy.dm.everyone" },
  { value: "server_members", label: "settings.privacy.dm.serverMembers" },
  { value: "nobody", label: "settings.privacy.dm.nobody" },
];

/**
 * Who may open a conversation with this account, and who has been blocked.
 *
 * Both apply the moment they are clicked rather than on Save, unlike the
 * profile fields in their own section. A privacy control that silently did
 * nothing because the dialog was dismissed with Cancel is the one failure this
 * section cannot have: the user believes they are closed off and they are not.
 *
 * The rule is enforced on the server on every attempt to open a conversation.
 * Nothing here is the enforcement — this is the switch, not the lock.
 */
export function PrivacySection({
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
  const { t } = useTranslation();
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
      setError(messageOf(err, t("settings.privacy.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Field
        label={t("settings.privacy.dmLabel")}
        hint={t("settings.privacy.dmHint")}
      >
        <div
          role="radiogroup"
          aria-label={t("settings.privacy.dmLabel")}
          className="flex flex-wrap gap-1.5"
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
                className={chipClass(selected)}
              >
                {t(option.label)}
              </button>
            );
          })}
        </div>
        {error && (
          <p role="alert" className="mt-1.5 text-xs text-danger">
            {error}
          </p>
        )}
      </Field>

      <Field label={t("settings.privacy.blocked")}>
        {blockedUsers.length === 0 ? (
          <p className="text-xs text-paper-muted">
            {t("settings.privacy.blockedEmpty")}
          </p>
        ) : (
          <ul className="space-y-1">
            {blockedUsers.map((blocked) => (
              <li
                key={blocked.id}
                className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-surface-2/60"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-paper">
                    {blocked.displayName}
                  </p>
                  {blocked.tag && (
                    <p className="truncate font-mono text-[11px] text-paper-muted">
                      {blocked.tag}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onUnblockUser(blocked.id)}
                >
                  {t("settings.privacy.unblock")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Field>
    </div>
  );
}
