import {
  AUTOMOD_ALLOW_LIST_MAX,
  AUTOMOD_CUSTOM_MESSAGE_MAX,
  AUTOMOD_KEYWORD_LENGTH_MAX,
  AUTOMOD_KEYWORDS_MAX,
  AUTOMOD_MENTION_LIMIT_DEFAULT,
  AUTOMOD_MENTION_LIMIT_MAX,
  AUTOMOD_MENTION_LIMIT_MIN,
  AUTOMOD_RULE_KINDS,
  AUTOMOD_TIMEOUT_PRESET_MINUTES,
  evaluateAutomod,
  type AutomodRule,
  type AutomodRuleKind,
  type Channel,
} from "@pqp/shared";
import {
  AtSign,
  ChevronLeft,
  ChevronRight,
  Link2,
  ShieldBan,
  ShieldCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  ApiError,
  createAutomodRule,
  deleteAutomodRule,
  fetchAutomodRules,
  fetchChannels,
  fetchRoles,
  updateAutomodRule,
  type ServerRole,
} from "@/lib/api";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { displayRoleName } from "@/lib/role-labels";
import { cn } from "@/lib/utils";

/**
 * AutoMod, its own section in Community settings.
 *
 * Two screens, the way Discord lays it out and the way a settings page reads
 * best: a **list** of the three rules, each a row with its state in one line
 * and its switch, and an **editor** for one rule at a time, reached by
 * tapping the row. Editing one rule fills the panel; nothing else competes.
 * A save bar appears only once something changed. The test box sits under
 * the list and runs the *saved* rules through the same `evaluateAutomod`
 * the server enforces, so what it says is what a member would get.
 *
 * Words are chips, not a textarea: one entry is one object you can see and
 * remove, and a wildcard is visible as part of the chip rather than as a
 * stray character on a line.
 */

const KIND_META: Record<
  AutomodRuleKind,
  { icon: LucideIcon; title: MessageKey; description: MessageKey }
> = {
  keywords: {
    icon: ShieldBan,
    title: "automod.keywords.title",
    description: "automod.keywords.description",
  },
  invite_links: {
    icon: Link2,
    title: "automod.inviteLinks.title",
    description: "automod.inviteLinks.description",
  },
  mention_spam: {
    icon: AtSign,
    title: "automod.mentionSpam.title",
    description: "automod.mentionSpam.description",
  },
};

interface RuleForm {
  enabled: boolean;
  keywords: string[];
  allowList: string[];
  mentionLimit: number;
  exemptRoleIds: string[];
  exemptChannelIds: string[];
  customMessage: string;
  alertChannelId: string | null;
  timeoutMinutes: number;
}

function formFromRule(rule: AutomodRule | undefined): RuleForm {
  return {
    enabled: rule?.enabled ?? true,
    keywords: rule?.keywords ?? [],
    allowList: rule?.allowList ?? [],
    mentionLimit: rule?.mentionLimit ?? AUTOMOD_MENTION_LIMIT_DEFAULT,
    exemptRoleIds: rule?.exemptRoleIds ?? [],
    exemptChannelIds: rule?.exemptChannelIds ?? [],
    customMessage: rule?.customMessage ?? "",
    alertChannelId: rule?.alertChannelId ?? null,
    timeoutMinutes: rule?.timeoutMinutes ?? 0,
  };
}

function formToInput(form: RuleForm) {
  return {
    enabled: form.enabled,
    keywords: form.keywords.slice(0, AUTOMOD_KEYWORDS_MAX),
    allowList: form.allowList.slice(0, AUTOMOD_ALLOW_LIST_MAX),
    mentionLimit: form.mentionLimit,
    exemptRoleIds: form.exemptRoleIds,
    exemptChannelIds: form.exemptChannelIds,
    customMessage: form.customMessage.trim().slice(0, AUTOMOD_CUSTOM_MESSAGE_MAX),
    alertChannelId: form.alertChannelId,
    timeoutMinutes: form.timeoutMinutes,
  };
}

function sameForm(a: RuleForm, b: RuleForm): boolean {
  return JSON.stringify(formToInput(a)) === JSON.stringify(formToInput(b));
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

const CHIP_REMOVE =
  "grid h-5 w-5 place-items-center rounded-full text-text-tertiary hover:bg-surface-3 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/** A titled group inside the editor: label, optional hint, then the control. */
function Field({
  label,
  hint,
  children,
  trailing,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-text">{label}</p>
          {hint && <p className="mt-0.5 text-xs text-text-tertiary">{hint}</p>}
        </div>
        {trailing}
      </div>
      {children}
    </div>
  );
}

/** A Discord-style group heading: TRIGGER, RESPONSE, EXEMPTIONS. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h5 className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
        {title}
      </h5>
      {children}
    </section>
  );
}

const SELECT =
  "h-[var(--control-md)] w-full rounded-[var(--radius-control)] border border-border bg-surface-0 px-3 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring disabled:opacity-50 sm:w-auto sm:min-w-[14rem]";

function describeMinutes(
  minutes: number,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (minutes < 60) return t("timeout.minutes", { count: minutes });
  if (minutes < 60 * 24) return t("timeout.hours", { count: minutes / 60 });
  return t("timeout.days", { count: minutes / (60 * 24) });
}

/**
 * Words as chips. Enter, comma or a paste adds; Backspace on an empty field
 * removes the last chip; every chip has its own remove. Entries are trimmed,
 * capped at the keyword length, and deduplicated case-insensitively so the
 * list an owner sees is the list the server stores.
 */
function ChipInput({
  values,
  onChange,
  placeholder,
  max,
  ariaLabel,
  tone = "block",
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  max: number;
  ariaLabel: string;
  tone?: "block" | "allow";
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function add(raw: string) {
    const parts = raw
      .split(/[\n,]/)
      .map((part) => part.trim().slice(0, AUTOMOD_KEYWORD_LENGTH_MAX))
      .filter(Boolean);
    if (parts.length === 0) {
      setDraft("");
      return;
    }
    const seen = new Set(values.map((value) => value.toLowerCase()));
    const next = [...values];
    for (const part of parts) {
      const key = part.toLowerCase();
      if (seen.has(key) || next.length >= max) continue;
      seen.add(key);
      next.push(part);
    }
    onChange(next);
    setDraft("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      add(draft);
    } else if (event.key === "Backspace" && draft === "" && values.length > 0) {
      event.preventDefault();
      onChange(values.slice(0, -1));
    }
  }

  return (
    <div
      className="flex min-h-[var(--control-lg)] cursor-text flex-wrap items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface-0 px-2 py-1.5 focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-offset-ring-offset focus-within:ring-focus-ring"
      onClick={() => inputRef.current?.focus()}
    >
      {values.map((value) => (
        <span
          key={value}
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-full pl-2.5 pr-1 text-xs font-medium",
            tone === "allow"
              ? "bg-success-soft text-on-success-soft"
              : "bg-surface-2 text-text",
          )}
        >
          <span className="max-w-[14rem] truncate">{value}</span>
          <button
            type="button"
            aria-label={t("automod.chip.remove", { value })}
            className={CHIP_REMOVE}
            onClick={(event) => {
              event.stopPropagation();
              onChange(values.filter((entry) => entry !== value));
            }}
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={draft}
        aria-label={ariaLabel}
        placeholder={values.length === 0 ? placeholder : ""}
        maxLength={AUTOMOD_KEYWORD_LENGTH_MAX}
        className="min-w-[8rem] flex-1 bg-transparent px-1 text-sm text-text placeholder:text-text-tertiary/70 focus:outline-none"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => add(draft)}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text");
          if (/[\n,]/.test(text)) {
            event.preventDefault();
            add(text);
          }
        }}
      />
    </div>
  );
}

/**
 * Exemptions as chips plus one native select to add. A select is the right
 * control for "pick one of these names": it is searchable by typing on
 * desktop and a wheel on a phone, and it needs no popover of our own.
 */
function ExemptPicker({
  options,
  selected,
  onChange,
  addLabel,
  emptyLabel,
}: {
  options: Array<{ id: string; label: string; swatch?: string | null }>;
  selected: string[];
  onChange: (next: string[]) => void;
  addLabel: string;
  emptyLabel: string;
}) {
  const { t } = useTranslation();
  const remaining = options.filter((option) => !selected.includes(option.id));
  const byId = new Map(options.map((option) => [option.id, option]));
  return (
    <div className="space-y-2">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((id) => {
            const option = byId.get(id);
            const label = option?.label ?? t("automod.exempt.unknown");
            return (
              <span
                key={id}
                className="inline-flex h-7 items-center gap-1.5 rounded-full bg-surface-2 pl-2.5 pr-1 text-xs font-medium text-text"
              >
                {option?.swatch && (
                  <span
                    aria-hidden
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: option.swatch }}
                  />
                )}
                <span className="max-w-[12rem] truncate">{label}</span>
                <button
                  type="button"
                  aria-label={t("automod.chip.remove", { value: label })}
                  className={CHIP_REMOVE}
                  onClick={() => onChange(selected.filter((entry) => entry !== id))}
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </span>
            );
          })}
        </div>
      )}
      {remaining.length === 0 ? (
        <p className="text-xs text-text-tertiary">{emptyLabel}</p>
      ) : (
        <select
          value=""
          aria-label={addLabel}
          className="h-[var(--control-md)] w-full rounded-[var(--radius-control)] border border-border bg-surface-0 px-3 text-sm text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring sm:w-auto sm:min-w-[14rem]"
          onChange={(event) => {
            if (event.target.value) {
              onChange([...selected, event.target.value]);
            }
          }}
        >
          <option value="">{addLabel}</option>
          {remaining.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export function AutomodSettingsSection({
  serverId,
  onDirtyChange,
}: {
  serverId: string;
  /** Lets the rail mark this section while an edit is unsaved. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const [rules, setRules] = useState<AutomodRule[] | null>(null);
  const [roles, setRoles] = useState<ServerRole[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [editing, setEditing] = useState<AutomodRuleKind | null>(null);
  const [form, setForm] = useState<RuleForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sample, setSample] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchAutomodRules(serverId),
      fetchRoles(serverId),
      fetchChannels(serverId),
    ])
      .then(([ruleRes, roleRes, channelRes]) => {
        if (cancelled) return;
        setRules(ruleRes.rules);
        setRoles(roleRes.roles.filter((role) => !role.isEveryone));
        setChannels(
          channelRes.channels.filter(
            (channel) => channel.type !== "category" && channel.kind === "server",
          ),
        );
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(messageOf(err, t("automod.loadFailed")));
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, t]);

  const ruleFor = (kind: AutomodRuleKind) => rules?.find((rule) => rule.kind === kind);
  const textChannels = channels.filter((channel) => channel.type === "text");
  const editingRule = editing ? ruleFor(editing) : undefined;
  const dirty =
    editing !== null && form !== null && !sameForm(form, formFromRule(editingRule));

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const preview = useMemo(() => {
    if (!rules || !sample.trim()) return null;
    const active = rules.filter((rule) => rule.enabled);
    if (active.length === 0) return { noRules: true as const, verdict: null };
    return { noRules: false as const, verdict: evaluateAutomod(sample, active) };
  }, [rules, sample]);

  function open(kind: AutomodRuleKind) {
    setForm(formFromRule(ruleFor(kind)));
    setEditing(kind);
    setError(null);
  }

  function close() {
    setEditing(null);
    setForm(null);
    setError(null);
  }

  function patch(next: Partial<RuleForm>) {
    setForm((prev) => (prev ? { ...prev, ...next } : prev));
  }

  function replaceRule(kind: AutomodRuleKind, rule: AutomodRule | null) {
    setRules((prev) => [
      ...(prev ?? []).filter((entry) => entry.kind !== kind),
      ...(rule ? [rule] : []),
    ]);
  }

  async function toggle(kind: AutomodRuleKind, enabled: boolean) {
    const existing = ruleFor(kind);
    if (!existing) {
      // Nothing saved for this rule yet: the switch opens the editor.
      open(kind);
      return;
    }
    setError(null);
    replaceRule(kind, { ...existing, enabled });
    if (editing === kind) patch({ enabled });
    try {
      const { rule } = await updateAutomodRule(serverId, existing.id, { enabled });
      replaceRule(kind, rule);
    } catch (err) {
      replaceRule(kind, existing);
      if (editing === kind) patch({ enabled: existing.enabled });
      setError(messageOf(err, t("automod.saveFailed")));
    }
  }

  async function save() {
    if (!editing || !form) return;
    const existing = ruleFor(editing);
    setBusy(true);
    setError(null);
    try {
      const input = formToInput(form);
      const { rule } = existing
        ? await updateAutomodRule(serverId, existing.id, input)
        : await createAutomodRule(serverId, { kind: editing, ...input });
      replaceRule(editing, rule);
      setForm(formFromRule(rule));
    } catch (err) {
      setError(messageOf(err, t("automod.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!editing) return;
    const existing = ruleFor(editing);
    if (!existing) {
      close();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteAutomodRule(serverId, existing.id);
      replaceRule(editing, null);
      close();
    } catch (err) {
      setError(messageOf(err, t("automod.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  if (error && !rules) {
    return (
      <p role="alert" className="text-sm text-danger">
        {error}
      </p>
    );
  }
  if (!rules) {
    return <p className="text-sm text-text-tertiary">{t("automod.loading")}</p>;
  }

  // -------------------------------------------------------------- editor

  if (editing && form) {
    const meta = KIND_META[editing];
    const Icon = meta.icon;
    const existing = editingRule;
    const canSave = existing
      ? dirty
      : editing !== "keywords" || form.keywords.length > 0;
    return (
      <div className="flex min-h-full flex-col" data-testid={`automod-editor-${editing}`}>
        <button
          type="button"
          className="mb-4 inline-flex w-fit items-center gap-1 rounded-[var(--radius-control)] text-xs font-medium text-text-tertiary hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          onClick={close}
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
          {t("automod.back")}
        </button>

        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-card)] bg-accent-soft text-on-accent-soft">
              <Icon className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h4 className="font-display text-base font-bold text-text">
                {t(meta.title)}
              </h4>
              <p className="mt-0.5 text-sm text-text-secondary">{t(meta.description)}</p>
            </div>
          </div>
          {existing && (
            <Switch
              checked={form.enabled}
              onCheckedChange={(checked) => void toggle(editing, checked)}
              label={form.enabled ? t("automod.state.on") : t("automod.state.off")}
              className="w-auto shrink-0"
            />
          )}
        </div>

        <div className="mt-6 space-y-8">
          <Group title={t("automod.group.trigger")}>
            {editing === "keywords" && (
              <>
                <Field
                  label={t("automod.keywords.list")}
                  hint={t("automod.keywords.hint")}
                  trailing={
                    <span className="text-xs tabular-nums text-text-tertiary">
                      {form.keywords.length}/{AUTOMOD_KEYWORDS_MAX}
                    </span>
                  }
                >
                  <ChipInput
                    values={form.keywords}
                    onChange={(keywords) => patch({ keywords })}
                    placeholder={t("automod.keywords.placeholder")}
                    max={AUTOMOD_KEYWORDS_MAX}
                    ariaLabel={t("automod.keywords.list")}
                  />
                </Field>
                <Field label={t("automod.allowList")} hint={t("automod.allowList.hint")}>
                  <ChipInput
                    values={form.allowList}
                    onChange={(allowList) => patch({ allowList })}
                    placeholder={t("automod.allowList.placeholder")}
                    max={AUTOMOD_ALLOW_LIST_MAX}
                    ariaLabel={t("automod.allowList")}
                    tone="allow"
                  />
                </Field>
              </>
            )}
            {editing === "invite_links" && (
              <p className="text-sm text-text-secondary">{t("automod.inviteLinks.trigger")}</p>
            )}
            {editing === "mention_spam" && (
              <Field
                label={t("automod.mentionSpam.limit")}
                hint={t("automod.mentionSpam.limitHint")}
              >
                <Input
                  type="number"
                  inputMode="numeric"
                  min={AUTOMOD_MENTION_LIMIT_MIN}
                  max={AUTOMOD_MENTION_LIMIT_MAX}
                  value={form.mentionLimit}
                  aria-label={t("automod.mentionSpam.limit")}
                  className="w-28 tabular-nums"
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isInteger(next)) {
                      patch({
                        mentionLimit: Math.min(
                          AUTOMOD_MENTION_LIMIT_MAX,
                          Math.max(AUTOMOD_MENTION_LIMIT_MIN, next),
                        ),
                      });
                    }
                  }}
                />
              </Field>
            )}
          </Group>

          <Group title={t("automod.group.response")}>
            <div className="divide-y divide-border rounded-[var(--radius-card)] border border-border">
              {/* Block is the one response every rule has; it is shown as a fact, not a switch. */}
              <div className="space-y-3 px-3 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm text-text">{t("automod.response.block")}</p>
                    <p className="mt-0.5 text-xs text-text-tertiary">
                      {t("automod.response.block.hint")}
                    </p>
                  </div>
                  <span className="mt-0.5 inline-flex h-5 items-center rounded-full bg-accent-soft px-2 text-[11px] font-semibold uppercase tracking-wider text-on-accent-soft">
                    {t("automod.response.always")}
                  </span>
                </div>
                <Field
                  label={t("automod.customMessage")}
                  trailing={
                    <span className="text-xs tabular-nums text-text-tertiary">
                      {form.customMessage.length}/{AUTOMOD_CUSTOM_MESSAGE_MAX}
                    </span>
                  }
                >
                  <Input
                    value={form.customMessage}
                    maxLength={AUTOMOD_CUSTOM_MESSAGE_MAX}
                    aria-label={t("automod.customMessage")}
                    placeholder={t("chat.reject.automod")}
                    onChange={(event) => patch({ customMessage: event.target.value })}
                  />
                </Field>
              </div>

              <div className="space-y-3 px-3 py-3">
                <Switch
                  checked={form.alertChannelId !== null}
                  onCheckedChange={(on) =>
                    patch({
                      alertChannelId: on ? (textChannels[0]?.id ?? null) : null,
                    })
                  }
                  disabled={textChannels.length === 0}
                  label={t("automod.response.alert")}
                  description={
                    textChannels.length === 0
                      ? t("automod.response.alert.noChannels")
                      : t("automod.response.alert.hint")
                  }
                  className="px-0"
                />
                {form.alertChannelId !== null && (
                  <select
                    value={form.alertChannelId}
                    aria-label={t("automod.response.alert.channel")}
                    className={SELECT}
                    onChange={(event) => patch({ alertChannelId: event.target.value })}
                  >
                    {textChannels.map((channel) => (
                      <option key={channel.id} value={channel.id}>
                        #{channel.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="space-y-3 px-3 py-3">
                <Switch
                  checked={form.timeoutMinutes > 0}
                  onCheckedChange={(on) => patch({ timeoutMinutes: on ? 5 : 0 })}
                  label={t("automod.response.timeout")}
                  description={t("automod.response.timeout.hint")}
                  className="px-0"
                />
                {form.timeoutMinutes > 0 && (
                  <select
                    value={form.timeoutMinutes}
                    aria-label={t("automod.response.timeout.duration")}
                    className={SELECT}
                    onChange={(event) => patch({ timeoutMinutes: Number(event.target.value) })}
                  >
                    {AUTOMOD_TIMEOUT_PRESET_MINUTES.filter((m) => m > 0).map((minutes) => (
                      <option key={minutes} value={minutes}>
                        {describeMinutes(minutes, t)}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          </Group>

          <Group title={t("automod.group.exemptions")}>
            <div className="grid gap-6 sm:grid-cols-2">
              <Field label={t("automod.exemptRoles")} hint={t("automod.exemptRoles.hint")}>
                <ExemptPicker
                  options={roles.map((role) => ({
                    id: role.id,
                    label: displayRoleName(role, t, roles),
                    swatch: role.color,
                  }))}
                  selected={form.exemptRoleIds}
                  onChange={(exemptRoleIds) => patch({ exemptRoleIds })}
                  addLabel={t("automod.exemptRoles.add")}
                  emptyLabel={t("automod.noRoles")}
                />
              </Field>
              <Field
                label={t("automod.exemptChannels")}
                hint={t("automod.exemptChannels.hint")}
              >
                <ExemptPicker
                  options={channels.map((channel) => ({
                    id: channel.id,
                    label: `#${channel.name}`,
                  }))}
                  selected={form.exemptChannelIds}
                  onChange={(exemptChannelIds) => patch({ exemptChannelIds })}
                  addLabel={t("automod.exemptChannels.add")}
                  emptyLabel={t("automod.noChannels")}
                />
              </Field>
            </div>
            <p className="text-xs text-text-tertiary">{t("automod.exemptions.always")}</p>
          </Group>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>

        <div className="mt-8 flex items-center justify-between gap-3 border-t border-border pt-4">
          {existing ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove()}>
              {t("automod.remove")}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-3">
            {dirty && existing && (
              <>
                <span className="text-xs text-text-tertiary">{t("automod.unsaved")}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => setForm(formFromRule(existing))}
                >
                  {t("automod.reset")}
                </Button>
              </>
            )}
            <Button size="sm" disabled={busy || !canSave} onClick={() => void save()}>
              {existing ? t("automod.save") : t("automod.create")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- list

  function summary(kind: AutomodRuleKind, rule: AutomodRule | undefined): string {
    if (!rule) return t("automod.state.notSetUp");
    if (!rule.enabled) return t("automod.state.off");
    const exempt = rule.exemptRoleIds.length + rule.exemptChannelIds.length;
    const parts: string[] = [];
    if (kind === "keywords") {
      parts.push(t("automod.summary.words", { count: rule.keywords.length }));
      if (rule.allowList.length > 0) {
        parts.push(t("automod.summary.allowed", { count: rule.allowList.length }));
      }
    } else if (kind === "mention_spam") {
      parts.push(t("automod.summary.mentions", { count: rule.mentionLimit }));
    } else {
      parts.push(t("automod.state.on"));
    }
    if (rule.alertChannelId) {
      const channel = channels.find((c) => c.id === rule.alertChannelId);
      parts.push(
        channel ? `#${channel.name}` : t("automod.summary.alert"),
      );
    }
    if (rule.timeoutMinutes > 0) {
      parts.push(t("automod.summary.timeout", { duration: describeMinutes(rule.timeoutMinutes, t) }));
    }
    if (exempt > 0) parts.push(t("automod.summary.exempt", { count: exempt }));
    return parts.join(" · ");
  }

  return (
    <div className="space-y-6">
      <ul className="divide-y divide-border overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface-1">
        {AUTOMOD_RULE_KINDS.map((kind) => {
          const meta = KIND_META[kind];
          const rule = ruleFor(kind);
          const on = Boolean(rule?.enabled);
          const Icon = meta.icon;
          return (
            <li
              key={kind}
              className="flex items-center gap-3 pr-3"
              data-testid={`automod-row-${kind}`}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring"
                onClick={() => open(kind)}
              >
                <span
                  className={cn(
                    "grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-card)]",
                    on
                      ? "bg-accent-soft text-on-accent-soft"
                      : "bg-surface-2 text-text-tertiary",
                  )}
                >
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-text">
                    {t(meta.title)}
                  </span>
                  <span
                    className={cn(
                      "block truncate text-xs",
                      on ? "text-text-secondary" : "text-text-tertiary",
                    )}
                  >
                    {summary(kind, rule)}
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-text-tertiary" aria-hidden />
              </button>
              <Switch
                checked={on}
                onCheckedChange={(checked) => void toggle(kind, checked)}
                label={t(meta.title)}
                hideLabel
                title={rule ? undefined : t("automod.state.notSetUp")}
                className="w-auto shrink-0"
              />
            </li>
          );
        })}
      </ul>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <section className="space-y-3 rounded-[var(--radius-card)] border border-border bg-surface-1 p-4">
        <div>
          <p className="text-sm font-medium text-text">{t("automod.test.label")}</p>
          <p className="mt-0.5 text-xs text-text-tertiary">{t("automod.test.hint")}</p>
        </div>
        <Input
          value={sample}
          aria-label={t("automod.test.label")}
          placeholder={t("automod.test.placeholder")}
          onChange={(event) => setSample(event.target.value)}
        />
        {preview && (
          <p
            role="status"
            aria-live="polite"
            data-testid="automod-test-result"
            className={cn(
              "flex items-center gap-2 text-sm",
              preview.verdict
                ? "text-danger"
                : preview.noRules
                  ? "text-text-tertiary"
                  : "text-success",
            )}
          >
            {preview.verdict ? (
              <ShieldBan className="h-4 w-4 shrink-0" aria-hidden />
            ) : (
              <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden />
            )}
            <span>
              {preview.noRules
                ? t("automod.test.noRules")
                : preview.verdict
                  ? t("automod.test.blocked", {
                      rule: t(KIND_META[preview.verdict.kind].title),
                      matched: preview.verdict.matched,
                    })
                  : t("automod.test.allowed")}
            </span>
          </p>
        )}
      </section>
    </div>
  );
}
