import { useRef, useState, type KeyboardEvent } from "react";
import { UserX } from "lucide-react";
import { type BlockedUser, type DmPrivacy, type User } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { RadioGroup, type RadioOption } from "@/components/ui/radio-group";
import {
  SettingsEmpty,
  SettingsGroup,
  SettingsInlineStatus,
  SettingsRow,
  useInlineSave,
} from "@/components/settings/kit";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { updateMe } from "@/lib/api";

/* ----------------------------------------------------------------- privacy */

const ROVING_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

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
  const save = useInlineSave();
  // One write at a time, as before. A ref rather than the save state, so a
  // second click in the same tick is refused too, and the radios stay enabled
  // (and focused) while the first one is in flight.
  const busy = useRef(false);
  // The option just picked, checked while its write is in flight so the save
  // status sits under the option the user chose. Cleared when the write ends:
  // on success the account carries the new value, on failure the radio goes
  // back to the value that is actually stored and the error sits under it.
  const [pending, setPending] = useState<DmPrivacy | null>(null);
  const current = user?.dmPrivacy ?? "server_members";

  const options: RadioOption<DmPrivacy>[] = DM_PRIVACY_OPTIONS.map((option) => ({
    value: option.value,
    label: t(option.label),
    description: t(option.description),
  }));

  // The radios take arrow keys that move focus AND select. While a write is
  // in flight `choose` drops the selection, so moving focus anyway would leave
  // it on an unchecked option while the checked one keeps the tab stop. The
  // keys wait for the write instead, like a second click does.
  function holdKeysWhileBusy(event: KeyboardEvent<HTMLDivElement>) {
    if (busy.current && ROVING_KEYS.has(event.key)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  async function choose(value: DmPrivacy) {
    if (!user || busy.current || value === current) {
      return;
    }
    busy.current = true;
    setPending(value);
    try {
      await save.run(async () => {
        onUserUpdated(await updateMe({ dmPrivacy: value }));
      }, t("settings.privacy.saveFailed"));
    } finally {
      busy.current = false;
      setPending(null);
    }
  }

  return (
    <div className="space-y-6">
      <SettingsGroup
        title={t("settings.privacy.group.dm.title")}
        description={t("settings.privacy.dmHint")}
      >
        <div onKeyDownCapture={holdKeysWhileBusy}>
          <RadioGroup
            variant="list"
            label={t("settings.privacy.dmLabel")}
            value={pending ?? current}
            options={options}
            disabled={!user}
            onValueChange={(value) => void choose(value)}
            status={
              save.state.kind === "idle" ? undefined : (
                <SettingsInlineStatus state={save.state} />
              )
            }
          />
        </div>
      </SettingsGroup>

      <SettingsGroup
        title={t("settings.privacy.blocked")}
        description={t("settings.privacy.blockedHint")}
      >
        {blockedUsers.length === 0 ? (
          <SettingsEmpty icon={UserX} title={t("settings.privacy.blockedEmpty")} />
        ) : (
          blockedUsers.map((blocked) => (
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
                  onClick={() => onUnblockUser(blocked.id)}
                >
                  {t("settings.privacy.unblock")}
                </Button>
              }
            />
          ))
        )}
      </SettingsGroup>
    </div>
  );
}
