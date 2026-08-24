import type { AuditLogEntry, Server } from "@pqp/shared";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  Image as ImageIcon,
  KeyRound,
  ScrollText,
  ShieldCheck,
  TriangleAlert,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ReportsSection } from "@/components/layout/reports-section";
import { ServerIdentitySection } from "@/components/layout/server-identity-section";
import { CommunitySettingsSection } from "@/components/communities/community-settings-section";
import { RolesSettingsSection } from "@/components/layout/roles-settings-section";
import { useCommunitiesEnabled } from "@/components/communities/use-communities-enabled";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  ApiError,
  deleteServer,
  exportServerData,
  fetchAuditLog,
  fetchMembers,
  updateServer,
  type ServerMember,
} from "@/lib/api";

const TRANSFER_PHRASE = "TRANSFER";

/**
 * Every action the log can carry, as a catalogue key.
 *
 * A `Record` rather than a template string built at the call site, so a new
 * `AuditAction` that nobody wrote copy for is a compile error here rather than
 * a raw `member.voice_mute` rendered to an owner. The fallback below still
 * exists for a server newer than the client during a rolling deploy.
 */
const AUDIT_ACTION_KEYS: Record<string, MessageKey> = {
  "member.kick": "serverSettings.audit.action.member.kick",
  "member.ban": "serverSettings.audit.action.member.ban",
  "member.unban": "serverSettings.audit.action.member.unban",
  "member.role_update": "serverSettings.audit.action.member.role_update",
  "channel.create": "serverSettings.audit.action.channel.create",
  "channel.update": "serverSettings.audit.action.channel.update",
  "channel.delete": "serverSettings.audit.action.channel.delete",
  "channel.move": "serverSettings.audit.action.channel.move",
  "message.delete": "serverSettings.audit.action.message.delete",
  "server.update": "serverSettings.audit.action.server.update",
  "server.retention_update":
    "serverSettings.audit.action.server.retention_update",
  "server.icon_update": "serverSettings.audit.action.server.icon_update",
  "server.banner_update": "serverSettings.audit.action.server.banner_update",
  "server.ownership_transfer":
    "serverSettings.audit.action.server.ownership_transfer",
  "server.data_export": "serverSettings.audit.action.server.data_export",
  "invite.create": "serverSettings.audit.action.invite.create",
  "invite.delete": "serverSettings.audit.action.invite.delete",
  "server.sso_domain_update":
    "serverSettings.audit.action.server.sso_domain_update",
  "member.sso_join": "serverSettings.audit.action.member.sso_join",
  "server.community_update":
    "serverSettings.audit.action.server.community_update",
  "member.community_join":
    "serverSettings.audit.action.member.community_join",
  "webhook.create": "serverSettings.audit.action.webhook.create",
  "webhook.delete": "serverSettings.audit.action.webhook.delete",
  "report.resolve": "serverSettings.audit.action.report.resolve",
  "role.create": "serverSettings.audit.action.role.create",
  "role.update": "serverSettings.audit.action.role.update",
  "role.delete": "serverSettings.audit.action.role.delete",
  "member.nickname_update":
    "serverSettings.audit.action.member.nickname_update",
  "member.roles_update": "serverSettings.audit.action.member.roles_update",
  "channel.overwrite_update":
    "serverSettings.audit.action.channel.overwrite_update",
};

/* ------------------------------------------------------------------ layout */

/**
 * The sections, in rail order.
 *
 * WHY THESE FIVE. The dialog was one column that ran a rename, a retention
 * policy, an SSO domain, a public-listing switch, a moderation queue, an audit
 * log and the button that destroys the server all past each other. The grouping
 * below is by the question an owner arrived with, not by which API each control
 * happens to call:
 *
 *  - **Overview** — what the server is: its name and its two pictures, plus the
 *    community listing, because "is this room public" is part of what it *is*.
 *  - **Access** — who can walk in without an invite. Today that is the SSO
 *    domain alone; invites and bans have their own surfaces already.
 *  - **Moderation** — the reports queue and message retention. Both are "what
 *    happens to things members said".
 *  - **Audit log** — its own door because it is a *record*, not a setting, and
 *    it is the one thing here an admin can see without being able to change
 *    anything.
 *  - **Danger zone** — export, transfer, delete. Export sits with the other two
 *    because all three are things you do to the server as a whole rather than
 *    settings you change on it, and because an export taken on the way out is
 *    the common reason to want one.
 *
 * There is no Channels section: channel management lives in the sidebar, where
 * the channels are. There is no Members or Webhooks section either — both are
 * their own dialogs already, reached from the rail and the channel row. Adding
 * a door here that opens another dialog would be a worse version of both.
 */
type SectionId =
  | "overview"
  | "access"
  | "roles"
  | "moderation"
  | "audit"
  | "danger";

interface SectionDef {
  id: SectionId;
  label: MessageKey;
  description: MessageKey;
  icon: LucideIcon;
  /** False for a section an admin may see too. */
  ownerOnly: boolean;
}

const SECTIONS: SectionDef[] = [
  {
    id: "overview",
    label: "serverSettings.section.overview",
    description: "serverSettings.overview.description",
    icon: ImageIcon,
    ownerOnly: true,
  },
  {
    id: "access",
    label: "serverSettings.section.access",
    description: "serverSettings.access.description",
    icon: KeyRound,
    ownerOnly: true,
  },
  {
    id: "roles",
    label: "serverSettings.section.roles",
    description: "serverSettings.roles.description",
    icon: Users,
    ownerOnly: false,
  },
  {
    id: "moderation",
    label: "serverSettings.section.moderation",
    description: "serverSettings.moderation.description",
    icon: ShieldCheck,
    ownerOnly: false,
  },
  {
    id: "audit",
    label: "serverSettings.section.audit",
    description: "serverSettings.audit.description",
    icon: ScrollText,
    ownerOnly: false,
  },
  {
    id: "danger",
    label: "serverSettings.section.danger",
    description: "serverSettings.danger.description",
    icon: TriangleAlert,
    ownerOnly: true,
  },
];

/**
 * The section rail. Structurally the one in `settings-modal.tsx`, deliberately
 * — two rails that behaved differently at the same width would be worse than
 * either. See that file for why it is a real tablist rather than a list of
 * buttons: arrow keys move between sections and only the selected tab is in the
 * tab order, so a keyboard user crosses five sections with two keystrokes.
 *
 * The one difference is that the list is passed in rather than module-level: an
 * admin sees two of these five, and a rail whose arrow keys walked onto a
 * section that is not rendered would be a trap.
 */
function SectionRail({
  sections,
  active,
  onSelect,
  idFor,
  panelId,
}: {
  sections: SectionDef[];
  active: SectionId;
  onSelect: (id: SectionId) => void;
  idFor: (id: SectionId) => string;
  panelId: string;
}) {
  const { t } = useTranslation();
  const railRef = useRef<HTMLDivElement>(null);

  function move(to: number) {
    const index = (to + sections.length) % sections.length;
    const next = sections[index]!;
    onSelect(next.id);
    const tabs =
      railRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs?.[index]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = sections.findIndex((section) => section.id === active);
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        move(current + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        move(current - 1);
        break;
      case "Home":
        event.preventDefault();
        move(0);
        break;
      case "End":
        event.preventDefault();
        move(sections.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    <div
      ref={railRef}
      role="tablist"
      aria-label={t("serverSettings.nav.label")}
      onKeyDown={handleKeyDown}
      className={cn(
        // The phone strip scrolls sideways *inside the panel*. That is the only
        // place sideways scrolling is allowed to exist here — the page itself
        // must never move, which is what the 390px layout test measures.
        "flex shrink-0 gap-1 overflow-x-auto border-b border-ink-4 px-3 py-2",
        "sm:w-56 sm:flex-col sm:overflow-x-hidden sm:overflow-y-auto sm:border-b-0 sm:border-r sm:px-3 sm:py-4",
      )}
    >
      {sections.map((section) => {
        const selected = section.id === active;
        const Icon = section.icon;
        return (
          <button
            key={section.id}
            id={idFor(section.id)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(section.id)}
            className={cn(
              "flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60 sm:w-full",
              selected
                ? "bg-signal/12 font-medium text-paper"
                : "text-paper-muted hover:bg-ink-3 hover:text-paper",
              section.id === "danger" && !selected && "text-danger/80",
            )}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            {t(section.label)}
          </button>
        );
      })}
    </div>
  );
}

/** Heading for the pane, so a section always says what it is. */
function SectionHeader({ section }: { section: SectionDef }) {
  const { t } = useTranslation();
  return (
    <div className="mb-5">
      <h3 className="font-display text-lg font-bold text-paper">
        {t(section.label)}
      </h3>
      <p className="mt-1 text-xs text-paper-muted">{t(section.description)}</p>
    </div>
  );
}

/** A titled group inside a section. */
function Block({
  title,
  children,
  tone = "normal",
}: {
  title: string;
  children: ReactNode;
  tone?: "normal" | "danger";
}) {
  return (
    <section
      className={cn(
        "space-y-2",
        tone === "danger" && "rounded-lg border border-danger/40 bg-danger/5 p-4",
      )}
    >
      <h4
        className={cn(
          "font-display text-sm font-bold uppercase tracking-wider",
          tone === "danger" ? "text-danger" : "text-paper-muted",
        )}
      >
        {title}
      </h4>
      {children}
    </section>
  );
}

/* --------------------------------------------------------------- audit log */

/**
 * Visible to owners and admins alike — the whole point is that a moderator
 * with the power to kick, ban, or delete is accountable to the rest of the
 * community for having used it, not just to the owner.
 */
function AuditLogSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchAuditLog(serverId)
      .then((res) => {
        if (!cancelled) {
          setEntries(res.entries);
          setHasMore(res.hasMore);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(messageOf(err, t("serverSettings.audit.failed")));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, t]);

  async function loadMore() {
    const last = entries.at(-1);
    if (!last) {
      return;
    }
    setLoadingMore(true);
    try {
      const res = await fetchAuditLog(serverId, { before: last.id });
      setEntries((prev) => [...prev, ...res.entries]);
      setHasMore(res.hasMore);
    } catch (err) {
      setError(messageOf(err, t("serverSettings.audit.failedMore")));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="space-y-2">
      {loading && (
        <p role="status" aria-live="polite" className="text-sm text-paper-muted">
          {t("serverSettings.audit.loading")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {!loading && entries.length === 0 && !error && (
        <p className="text-sm text-paper-muted">
          {t("serverSettings.audit.empty")}
        </p>
      )}
      {entries.length > 0 && (
        <ul className="space-y-1.5">
          {entries.map((entry) => {
            const key = AUDIT_ACTION_KEYS[entry.action];
            return (
              <li
                key={entry.id}
                className="rounded-md border border-ink-4 bg-ink-3/40 p-2 text-sm"
              >
                <p className="text-paper">
                  <span className="font-semibold">
                    {entry.actorName ??
                      t("serverSettings.audit.departedActor")}
                  </span>{" "}
                  {/* The raw action id is the fallback for a server newer than
                      this client — legible enough to file a bug about, which a
                      blank would not be. */}
                  {key ? t(key) : entry.action}
                  {entry.reason && (
                    <span className="text-paper-muted"> — {entry.reason}</span>
                  )}
                </p>
                <p className="text-xs text-paper-muted">
                  {new Date(entry.createdAt).toLocaleString()}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {hasMore && (
        <Button
          variant="secondary"
          size="sm"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore
            ? t("serverSettings.audit.loadingMore")
            : t("serverSettings.audit.loadMore")}
        </Button>
      )}
    </div>
  );
}

interface ServerSettingsDialogProps {
  open: boolean;
  server: Server | null;
  currentUserId: string | null;
  onClose: () => void;
  onRenamed: (server: Server) => void;
  onOwnershipTransferred: () => void;
  onDeleted: (serverId: string) => void;
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

export function ServerSettingsDialog({
  open,
  server,
  currentUserId,
  onClose,
  onRenamed,
  onOwnershipTransferred,
  onDeleted,
}: ServerSettingsDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaved, setNameSaved] = useState(false);
  const [savingName, setSavingName] = useState(false);

  const [candidates, setCandidates] = useState<ServerMember[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [transferArmed, setTransferArmed] = useState(false);
  const [transferPhrase, setTransferPhrase] = useState("");
  const [transferError, setTransferError] = useState<string | null>(null);
  const [transferring, setTransferring] = useState(false);

  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deletePhrase, setDeletePhrase] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [retentionError, setRetentionError] = useState<string | null>(null);
  const [retentionSaved, setRetentionSaved] = useState(false);
  const [ssoDomain, setSsoDomain] = useState("");
  const [savingSso, setSavingSso] = useState(false);
  const [ssoError, setSsoError] = useState<string | null>(null);
  const [ssoSaved, setSsoSaved] = useState(false);
  const [savingRetention, setSavingRetention] = useState(false);

  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  // False on every deployment that has not turned the directory on, which is
  // all of them today — the opt-in block is then never rendered at all.
  const communitiesEnabled = useCommunitiesEnabled();

  const [section, setSection] = useState<SectionId>("overview");
  const tabIdPrefix = useId();
  const panelId = useId();

  const serverId = server?.id ?? null;
  const isOwner = server?.role === "owner";
  const isManager = isOwner || server?.role === "admin";

  // Seeded from a ref so a rename landing in the parent does not overwrite what
  // is being typed here; the form only resets when the dialog opens.
  const serverNameRef = useRef(server?.name ?? "");
  serverNameRef.current = server?.name ?? "";
  const retentionRef = useRef(server?.messageRetentionDays ?? null);
  retentionRef.current = server?.messageRetentionDays ?? null;
  const ssoRef = useRef(server?.ssoEmailDomain ?? null);
  ssoRef.current = server?.ssoEmailDomain ?? null;

  useEffect(() => {
    if (!open) {
      return;
    }
    setName(serverNameRef.current);
    setNameError(null);
    setNameSaved(false);
    setTargetId("");
    setTransferArmed(false);
    setTransferPhrase("");
    setTransferError(null);
    setDeleteArmed(false);
    setDeletePhrase("");
    setDeleteError(null);
    setRetentionDays(retentionRef.current);
    setRetentionError(null);
    setRetentionSaved(false);
    setSsoDomain(ssoRef.current ?? "");
    setSsoError(null);
    setSsoSaved(false);
    setExportError(null);
  }, [open, serverId]);

  // Reopening lands on the first section the *current* role can see. An admin
  // reopening after an ownership change must not be left staring at a pane that
  // no longer exists for them.
  const firstSection: SectionId = isOwner ? "overview" : "moderation";
  useEffect(() => {
    if (open) {
      setSection(firstSection);
    }
  }, [open, serverId, firstSection]);

  useEffect(() => {
    if (!open || !isOwner || !serverId) {
      return;
    }
    let cancelled = false;
    setCandidatesLoading(true);
    void fetchMembers(serverId)
      .then((res) => {
        if (!cancelled) {
          setCandidates(res.members.filter((m) => m.id !== currentUserId));
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setTransferError(
            messageOf(err, t("serverSettings.transfer.membersFailed")),
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setCandidatesLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, isOwner, serverId, currentUserId, t]);

  if (!open || !server) {
    return null;
  }

  const busy = savingName || transferring || deleting;
  const trimmedName = name.trim();
  const target = candidates.find((m) => m.id === targetId) ?? null;

  async function saveRetention(days: number | null) {
    if (!serverId) {
      return;
    }
    setSavingRetention(true);
    setRetentionError(null);
    setRetentionSaved(false);
    try {
      const res = await updateServer(serverId, { messageRetentionDays: days });
      if (res.server) {
        onRenamed(res.server);
        setRetentionDays(days);
        setRetentionSaved(true);
      } else {
        setRetentionError(t("serverSettings.retention.failed"));
      }
    } catch (err) {
      setRetentionError(messageOf(err, t("serverSettings.retention.failed")));
    } finally {
      setSavingRetention(false);
    }
  }

  async function saveSso() {
    if (!serverId) {
      return;
    }
    setSavingSso(true);
    setSsoError(null);
    setSsoSaved(false);
    try {
      // An empty box means "turn it off", which the API spells as explicit null
      // — sending "" would fail validation rather than clear the setting.
      const trimmed = ssoDomain.trim();
      const res = await updateServer(serverId, {
        ssoEmailDomain: trimmed === "" ? null : trimmed,
      });
      if (res.server) {
        onRenamed(res.server);
        setSsoDomain(res.server.ssoEmailDomain ?? "");
        setSsoSaved(true);
      } else {
        setSsoError(t("serverSettings.sso.failed"));
      }
    } catch (err) {
      setSsoError(messageOf(err, t("serverSettings.sso.failed")));
    } finally {
      setSavingSso(false);
    }
  }

  async function exportData() {
    if (!serverId) {
      return;
    }
    setExporting(true);
    setExportError(null);
    try {
      const blob = await exportServerData(serverId);
      // Same download mechanism a real file link uses — a Blob has no URL of
      // its own, so one is minted just long enough for the click to fire.
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${server?.name ?? "server"}-export-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(messageOf(err, t("serverSettings.export.failed")));
    } finally {
      setExporting(false);
    }
  }

  async function saveName() {
    if (!serverId || !trimmedName || trimmedName === server?.name) {
      return;
    }
    setSavingName(true);
    setNameError(null);
    setNameSaved(false);
    try {
      const res = await updateServer(serverId, { name: trimmedName });
      if (res.server) {
        onRenamed(res.server);
        setNameSaved(true);
      } else {
        setNameError(t("serverSettings.name.failed"));
      }
    } catch (err) {
      setNameError(messageOf(err, t("serverSettings.name.failed")));
    } finally {
      setSavingName(false);
    }
  }

  async function transferOwnership() {
    if (!serverId || !target) {
      return;
    }
    setTransferring(true);
    setTransferError(null);
    try {
      await updateServer(serverId, { ownerId: target.id });
      setTransferArmed(false);
      setTransferPhrase("");
      onOwnershipTransferred();
      onClose();
    } catch (err) {
      setTransferError(messageOf(err, t("serverSettings.transfer.failed")));
    } finally {
      setTransferring(false);
    }
  }

  async function destroyServer() {
    if (!serverId) {
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteServer(serverId);
      onDeleted(serverId);
    } catch (err) {
      setDeleteError(messageOf(err, t("serverSettings.delete.failed")));
    } finally {
      setDeleting(false);
    }
  }

  const sections = SECTIONS.filter((s) => isOwner || !s.ownerOnly);
  const active = sections.find((s) => s.id === section) ?? sections[0]!;

  /**
   * A plain member — neither owner nor admin — gets no rail at all.
   *
   * There is exactly one thing to say to them and no section that would contain
   * it, so a five-door surface behind which four doors are locked and the fifth
   * holds a sentence would be theatre. The `size="md"` dialog stays what it was.
   */
  if (!isManager) {
    return (
      <Dialog
        open
        title={server.name}
        eyebrow={t("serverSettings.eyebrow")}
        size="md"
        onClose={onClose}
        footer={
          <Button variant="secondary" onClick={onClose}>
            {t("serverSettings.close")}
          </Button>
        }
      >
        <div className="space-y-2 px-5 py-5">
          <p className="text-sm text-paper-muted">
            {t("serverSettings.readOnly.member")}
          </p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      title={server.name}
      eyebrow={t("serverSettings.eyebrow")}
      size="xl"
      fill
      closeOnBackdrop={!transferArmed && !deleteArmed}
      onClose={onClose}
      footer={
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          {t("serverSettings.close")}
        </Button>
      }
    >
      <div className="flex h-full min-h-0 flex-col sm:flex-row">
        <SectionRail
          sections={sections}
          active={active.id}
          onSelect={setSection}
          idFor={(id) => `${tabIdPrefix}-${id}`}
          panelId={panelId}
        />

        <div
          id={panelId}
          role="tabpanel"
          aria-labelledby={`${tabIdPrefix}-${active.id}`}
          tabIndex={0}
          className="min-w-0 flex-1 space-y-6 overflow-y-auto overscroll-contain px-5 py-5 focus-visible:outline-none"
        >
          <SectionHeader section={active} />

          {active.id === "overview" && (
            <>
              <Block title={t("serverSettings.name.title")}>
                <div className="flex gap-2">
                  <Input
                    value={name}
                    maxLength={64}
                    aria-label={t("serverSettings.name.label")}
                    disabled={savingName}
                    onChange={(e) => {
                      setName(e.target.value);
                      setNameSaved(false);
                    }}
                  />
                  <Button
                    disabled={
                      savingName || !trimmedName || trimmedName === server.name
                    }
                    onClick={() => void saveName()}
                  >
                    {savingName
                      ? t("serverSettings.name.saving")
                      : t("serverSettings.name.save")}
                  </Button>
                </div>
                <p
                  role="status"
                  aria-live="polite"
                  className="text-xs text-paper-muted"
                >
                  {nameSaved ? t("serverSettings.name.saved") : ""}
                </p>
                {nameError && (
                  <p role="alert" className="text-sm text-danger">
                    {nameError}
                  </p>
                )}
              </Block>

              {serverId && (
                <ServerIdentitySection server={server} onUpdated={onRenamed} />
              )}

              {serverId && communitiesEnabled && (
                <CommunitySettingsSection serverId={serverId} />
              )}
            </>
          )}

          {active.id === "access" && (
            <Block title={t("serverSettings.sso.title")}>
              <p className="text-sm text-paper-muted">
                {t("serverSettings.sso.description", { server: server.name })}
              </p>
              <div className="flex gap-2">
                <Input
                  value={ssoDomain}
                  placeholder="acme.com"
                  aria-label={t("serverSettings.sso.label")}
                  disabled={savingSso}
                  onChange={(e) => {
                    setSsoDomain(e.target.value);
                    setSsoSaved(false);
                    setSsoError(null);
                  }}
                />
                <Button
                  variant="secondary"
                  disabled={savingSso}
                  onClick={() => void saveSso()}
                >
                  {savingSso
                    ? t("serverSettings.sso.saving")
                    : t("serverSettings.sso.save")}
                </Button>
              </div>
              <p
                role="status"
                aria-live="polite"
                className="text-xs text-paper-muted"
              >
                {ssoSaved ? t("serverSettings.sso.saved") : ""}
              </p>
              {ssoError && (
                <p role="alert" className="text-sm text-danger">
                  {ssoError}
                </p>
              )}
            </Block>
          )}

          {active.id === "roles" && serverId && (
            <RolesSettingsSection serverId={serverId} />
          )}

          {active.id === "moderation" && (
            <>
              {serverId && <ReportsSection serverId={serverId} />}

              {isOwner && (
                <Block title={t("serverSettings.retention.title")}>
                  <p className="text-sm text-paper-muted">
                    {t("serverSettings.retention.description", {
                      server: server.name,
                    })}
                  </p>
                  <select
                    value={retentionDays === null ? "" : String(retentionDays)}
                    aria-label={t("serverSettings.retention.label")}
                    disabled={savingRetention}
                    className="h-10 w-full rounded-md border border-ink-4 bg-ink px-3 text-sm text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/50 disabled:opacity-50"
                    onChange={(e) =>
                      void saveRetention(
                        e.target.value === "" ? null : Number(e.target.value),
                      )
                    }
                  >
                    <option value="">
                      {t("serverSettings.retention.forever")}
                    </option>
                    <option value="30">
                      {t("serverSettings.retention.days30")}
                    </option>
                    <option value="90">
                      {t("serverSettings.retention.days90")}
                    </option>
                    <option value="365">
                      {t("serverSettings.retention.year")}
                    </option>
                  </select>
                  <p
                    role="status"
                    aria-live="polite"
                    className="text-xs text-paper-muted"
                  >
                    {retentionSaved ? t("serverSettings.retention.saved") : ""}
                  </p>
                  {retentionError && (
                    <p role="alert" className="text-sm text-danger">
                      {retentionError}
                    </p>
                  )}
                </Block>
              )}

              {!isOwner && (
                <p className="text-sm text-paper-muted">
                  {t("serverSettings.readOnly.admin")}
                </p>
              )}
            </>
          )}

          {active.id === "audit" && serverId && (
            <AuditLogSection serverId={serverId} />
          )}

          {active.id === "danger" && (
            <>
              <Block title={t("serverSettings.export.title")}>
                <p className="text-sm text-paper-muted">
                  {t("serverSettings.export.description", {
                    server: server.name,
                  })}
                </p>
                <Button
                  variant="secondary"
                  disabled={exporting}
                  onClick={() => void exportData()}
                >
                  {exporting
                    ? t("serverSettings.export.preparing")
                    : t("serverSettings.export.action")}
                </Button>
                {exportError && (
                  <p role="alert" className="text-sm text-danger">
                    {exportError}
                  </p>
                )}
              </Block>

              <Block title={t("serverSettings.transfer.title")}>
                <p className="text-sm text-paper-muted">
                  {t("serverSettings.transfer.description", {
                    server: server.name,
                  })}
                </p>

                {candidatesLoading ? (
                  <p
                    role="status"
                    aria-live="polite"
                    className="text-sm text-paper-muted"
                  >
                    {t("serverSettings.transfer.loading")}
                  </p>
                ) : candidates.length === 0 ? (
                  <p className="text-sm text-paper-muted">
                    {t("serverSettings.transfer.nobody")}
                  </p>
                ) : (
                  <div className="space-y-2">
                    <select
                      value={targetId}
                      aria-label={t("serverSettings.transfer.label")}
                      disabled={transferArmed || transferring}
                      className="h-10 w-full rounded-md border border-ink-4 bg-ink px-3 text-sm text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/50 disabled:opacity-50"
                      onChange={(e) => setTargetId(e.target.value)}
                    >
                      <option value="">
                        {t("serverSettings.transfer.placeholder")}
                      </option>
                      {candidates.map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.displayName}
                          {member.tag ? ` ${member.tag}` : ""}
                        </option>
                      ))}
                    </select>

                    {!transferArmed ? (
                      <Button
                        variant="secondary"
                        disabled={!targetId || busy}
                        onClick={() => setTransferArmed(true)}
                      >
                        {t("serverSettings.transfer.action")}
                      </Button>
                    ) : (
                      <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
                        <p className="text-sm text-paper">
                          {t("serverSettings.transfer.confirmLead", {
                            server: server.name,
                            member: target?.displayName ?? "",
                            phrase: TRANSFER_PHRASE,
                          })}
                        </p>
                        <Input
                          value={transferPhrase}
                          aria-label={t("serverSettings.transfer.confirmAria", {
                            phrase: TRANSFER_PHRASE,
                          })}
                          autoFocus
                          disabled={transferring}
                          onChange={(e) => setTransferPhrase(e.target.value)}
                        />
                        <div className="flex gap-2">
                          <Button
                            variant="danger"
                            disabled={
                              transferring ||
                              !target ||
                              transferPhrase.trim().toUpperCase() !==
                                TRANSFER_PHRASE
                            }
                            onClick={() => void transferOwnership()}
                          >
                            {transferring
                              ? t("serverSettings.transfer.transferring")
                              : t("serverSettings.transfer.confirm")}
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={transferring}
                            onClick={() => {
                              setTransferArmed(false);
                              setTransferPhrase("");
                            }}
                          >
                            {t("serverSettings.transfer.cancel")}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {transferError && (
                  <p role="alert" className="text-sm text-danger">
                    {transferError}
                  </p>
                )}
              </Block>

              <Block title={t("serverSettings.delete.title")} tone="danger">
                <p className="text-sm text-paper-muted">
                  {t("serverSettings.delete.description", {
                    server: server.name,
                  })}
                </p>

                {!deleteArmed ? (
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() => setDeleteArmed(true)}
                  >
                    {t("serverSettings.delete.action")}
                  </Button>
                ) : (
                  <div className="space-y-2">
                    <label className="block text-sm text-paper">
                      {t("serverSettings.delete.typeLabel", {
                        server: server.name,
                      })}
                      <Input
                        className="mt-2"
                        value={deletePhrase}
                        aria-label={t("serverSettings.delete.typeAria", {
                          server: server.name,
                        })}
                        autoFocus
                        disabled={deleting}
                        onChange={(e) => setDeletePhrase(e.target.value)}
                      />
                    </label>
                    <div className="flex gap-2">
                      <Button
                        variant="danger"
                        disabled={deleting || deletePhrase !== server.name}
                        onClick={() => void destroyServer()}
                      >
                        {deleting
                          ? t("serverSettings.delete.deleting")
                          : t("serverSettings.delete.confirm")}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={deleting}
                        onClick={() => {
                          setDeleteArmed(false);
                          setDeletePhrase("");
                        }}
                      >
                        {t("serverSettings.delete.cancel")}
                      </Button>
                    </div>
                  </div>
                )}

                {deleteError && (
                  <p role="alert" className="text-sm text-danger">
                    {deleteError}
                  </p>
                )}
              </Block>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
