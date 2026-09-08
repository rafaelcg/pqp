import {
  AUTOMOD_ALLOW_LIST_MAX,
  AUTOMOD_CUSTOM_MESSAGE_MAX,
  AUTOMOD_KEYWORDS_MAX,
  AUTOMOD_MENTION_LIMIT_DEFAULT,
  AUTOMOD_MENTION_LIMIT_MAX,
  AUTOMOD_MENTION_LIMIT_MIN,
  AUTOMOD_RULE_KINDS,
  evaluateAutomod,
  type AutomodRule,
  type AutomodRuleKind,
  type AutomodVerdict,
} from "@pqp/shared";
import { AtSign, Link2, ShieldBan, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckRow } from "@/components/ui/check-row";
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
import type { Channel } from "@pqp/shared";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { displayRoleName } from "@/lib/role-labels";
import { cn } from "@/lib/utils";

/**
 * AutoMod, in Manage Server → Moderation.
 *
 * One card per rule kind, Discord's three first-wave rules: blocked words,
 * Discord invite links, mention spam. Each card is a form over one saved
 * rule (or none yet); Save creates or patches it, the switch on the card is
 * the rule's `enabled`. At the bottom, a test box runs the *unsaved* form
 * through the same `evaluateAutomod` the server enforces, so an owner sees
 * what a wildcard catches before members do. Every guide on Discord's AutoMod
 * says the same thing: nobody misses words, everybody over-blocks with `*`.
 *
 * The server allows many rules per kind; this page keeps to one per kind,
 * which is what a small hall needs and what keeps the page readable.
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
  /** One entry per line in the textarea. */
  keywordsText: string;
  allowListText: string;
  mentionLimit: number;
  exemptRoleIds: string[];
  exemptChannelIds: string[];
  customMessage: string;
  reportHits: boolean;
}

function splitLines(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n|,/)) {
    const entry = raw.trim();
    const key = entry.toLowerCase();
    if (!entry || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function formFromRule(rule: AutomodRule | undefined): RuleForm {
  return {
    // A card with no saved rule starts off; saving it turns it on.
    enabled: rule?.enabled ?? false,
    keywordsText: rule?.keywords.join("\n") ?? "",
    allowListText: rule?.allowList.join("\n") ?? "",
    mentionLimit: rule?.mentionLimit ?? AUTOMOD_MENTION_LIMIT_DEFAULT,
    exemptRoleIds: rule?.exemptRoleIds ?? [],
    exemptChannelIds: rule?.exemptChannelIds ?? [],
    customMessage: rule?.customMessage ?? "",
    reportHits: rule?.reportHits ?? false,
  };
}

function formToInput(form: RuleForm) {
  return {
    enabled: form.enabled,
    keywords: splitLines(form.keywordsText).slice(0, AUTOMOD_KEYWORDS_MAX),
    allowList: splitLines(form.allowListText).slice(0, AUTOMOD_ALLOW_LIST_MAX),
    mentionLimit: form.mentionLimit,
    exemptRoleIds: form.exemptRoleIds,
    exemptChannelIds: form.exemptChannelIds,
    customMessage: form.customMessage.trim().slice(0, AUTOMOD_CUSTOM_MESSAGE_MAX),
    reportHits: form.reportHits,
  };
}

function sameForm(a: RuleForm, b: RuleForm): boolean {
  return JSON.stringify(formToInput(a)) === JSON.stringify(formToInput(b));
}

const TEXTAREA =
  "min-h-[5.5rem] w-full rounded-[var(--radius-control)] border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50";

export function AutomodSettingsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const [rules, setRules] = useState<AutomodRule[] | null>(null);
  const [roles, setRoles] = useState<ServerRole[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [forms, setForms] = useState<Record<AutomodRuleKind, RuleForm> | null>(null);
  const [saving, setSaving] = useState<AutomodRuleKind | null>(null);
  const [savedKind, setSavedKind] = useState<AutomodRuleKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sample, setSample] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchAutomodRules(serverId), fetchRoles(serverId), fetchChannels(serverId)])
      .then(([ruleRes, roleRes, channelRes]) => {
        if (cancelled) {
          return;
        }
        setRules(ruleRes.rules);
        setRoles(roleRes.roles.filter((role) => !role.isEveryone));
        setChannels(
          channelRes.channels.filter(
            (channel) => channel.type !== "category" && channel.kind === "server",
          ),
        );
        setForms(
          Object.fromEntries(
            AUTOMOD_RULE_KINDS.map((kind) => [
              kind,
              formFromRule(ruleRes.rules.find((rule) => rule.kind === kind)),
            ]),
          ) as Record<AutomodRuleKind, RuleForm>,
        );
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : t("automod.loadFailed"));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, t]);

  const ruleFor = (kind: AutomodRuleKind) => rules?.find((rule) => rule.kind === kind);

  /** The unsaved forms as the matcher sees them, for the test box. */
  const preview = useMemo(() => {
    if (!forms || !sample.trim()) {
      return null;
    }
    const inputs = AUTOMOD_RULE_KINDS.filter((kind) => forms[kind].enabled).map((kind) => ({
      kind,
      ...formToInput(forms[kind]),
      customMessage: forms[kind].customMessage,
    }));
    if (inputs.length === 0) {
      return { verdict: null as AutomodVerdict | null, noRules: true };
    }
    return { verdict: evaluateAutomod(sample, inputs), noRules: false };
  }, [forms, sample]);

  if (error && !forms) {
    return <p className="text-sm text-danger">{error}</p>;
  }
  if (!forms) {
    return <p className="text-sm text-text-tertiary">{t("automod.loading")}</p>;
  }

  function patchForm(kind: AutomodRuleKind, patch: Partial<RuleForm>) {
    setForms((prev) => (prev ? { ...prev, [kind]: { ...prev[kind], ...patch } } : prev));
    setSavedKind(null);
  }

  async function save(kind: AutomodRuleKind) {
    if (!forms) {
      return;
    }
    const form = forms[kind];
    const existing = ruleFor(kind);
    // "Turn on" on a card with nothing saved creates the rule armed.
    const input = { ...formToInput(form), enabled: existing ? form.enabled : true };
    setSaving(kind);
    setError(null);
    try {
      let rule: AutomodRule;
      if (existing) {
        rule = (await updateAutomodRule(serverId, existing.id, input)).rule;
      } else {
        rule = (await createAutomodRule(serverId, { kind, ...input })).rule;
      }
      setRules((prev) => [...(prev ?? []).filter((r) => r.kind !== kind), rule]);
      setForms((prev) => (prev ? { ...prev, [kind]: formFromRule(rule) } : prev));
      setSavedKind(kind);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("automod.saveFailed"));
    } finally {
      setSaving(null);
    }
  }

  async function toggle(kind: AutomodRuleKind, enabled: boolean) {
    const existing = ruleFor(kind);
    patchForm(kind, { enabled });
    if (!existing) {
      // Nothing saved yet: the switch only arms the form; Save creates it.
      return;
    }
    setError(null);
    try {
      const { rule } = await updateAutomodRule(serverId, existing.id, { enabled });
      setRules((prev) => [...(prev ?? []).filter((r) => r.kind !== kind), rule]);
    } catch (err) {
      patchForm(kind, { enabled: !enabled });
      setError(err instanceof ApiError ? err.message : t("automod.saveFailed"));
    }
  }

  async function remove(kind: AutomodRuleKind) {
    const existing = ruleFor(kind);
    if (!existing) {
      return;
    }
    setError(null);
    try {
      await deleteAutomodRule(serverId, existing.id);
      setRules((prev) => (prev ?? []).filter((r) => r.kind !== kind));
      setForms((prev) => (prev ? { ...prev, [kind]: formFromRule(undefined) } : prev));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("automod.saveFailed"));
    }
  }

  return (
    <section className="space-y-4" aria-labelledby="automod-heading">
      <div className="space-y-1">
        <h4
          id="automod-heading"
          className="font-display text-sm font-bold uppercase tracking-wider text-paper-muted"
        >
          {t("automod.title")}
        </h4>
        <p className="text-sm text-paper-muted">{t("automod.description")}</p>
      </div>

      {AUTOMOD_RULE_KINDS.map((kind) => {
        const meta = KIND_META[kind];
        const form = forms[kind];
        const existing = ruleFor(kind);
        const dirty = !sameForm(form, formFromRule(existing));
        const Icon = meta.icon;
        return (
          <div
            key={kind}
            className="space-y-3 rounded-lg border border-border bg-surface p-4"
            data-testid={`automod-card-${kind}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <Icon className="mt-0.5 h-5 w-5 shrink-0 text-text-tertiary" aria-hidden />
                <div>
                  <h5 className="text-sm font-semibold text-text">{t(meta.title)}</h5>
                  <p className="text-xs text-text-tertiary">{t(meta.description)}</p>
                </div>
              </div>
              <Switch
                checked={form.enabled}
                onCheckedChange={(checked) => void toggle(kind, checked)}
                label={t("automod.enabled")}
                className="w-auto shrink-0"
              />
            </div>

            {kind === "keywords" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs text-text-tertiary">
                  <span>{t("automod.keywords.list")}</span>
                  <textarea
                    className={TEXTAREA}
                    value={form.keywordsText}
                    placeholder={t("automod.keywords.placeholder")}
                    onChange={(e) => patchForm(kind, { keywordsText: e.target.value })}
                  />
                  <span className="block">{t("automod.keywords.hint")}</span>
                </label>
                <label className="space-y-1 text-xs text-text-tertiary">
                  <span>{t("automod.allowList")}</span>
                  <textarea
                    className={TEXTAREA}
                    value={form.allowListText}
                    placeholder={t("automod.allowList.placeholder")}
                    onChange={(e) => patchForm(kind, { allowListText: e.target.value })}
                  />
                  <span className="block">{t("automod.allowList.hint")}</span>
                </label>
              </div>
            )}

            {kind === "mention_spam" && (
              <label className="flex items-center gap-3 text-sm text-text">
                <span>{t("automod.mentionSpam.limit")}</span>
                <Input
                  type="number"
                  min={AUTOMOD_MENTION_LIMIT_MIN}
                  max={AUTOMOD_MENTION_LIMIT_MAX}
                  value={form.mentionLimit}
                  className="w-20"
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    if (Number.isInteger(next)) {
                      patchForm(kind, {
                        mentionLimit: Math.min(
                          AUTOMOD_MENTION_LIMIT_MAX,
                          Math.max(AUTOMOD_MENTION_LIMIT_MIN, next),
                        ),
                      });
                    }
                  }}
                />
              </label>
            )}

            <label className="block space-y-1 text-xs text-text-tertiary">
              <span>{t("automod.customMessage")}</span>
              <Input
                value={form.customMessage}
                maxLength={AUTOMOD_CUSTOM_MESSAGE_MAX}
                placeholder={t("chat.reject.automod")}
                onChange={(e) => patchForm(kind, { customMessage: e.target.value })}
              />
            </label>

            <details className="text-sm">
              <summary className="cursor-pointer text-xs text-text-tertiary">
                {t("automod.exemptions", {
                  count: form.exemptRoleIds.length + form.exemptChannelIds.length,
                })}
              </summary>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs text-text-tertiary">{t("automod.exemptRoles")}</p>
                  {roles.length === 0 ? (
                    <p className="text-xs text-text-tertiary">{t("automod.noRoles")}</p>
                  ) : (
                    roles.map((role) => (
                      <CheckRow
                        key={role.id}
                        checked={form.exemptRoleIds.includes(role.id)}
                        swatch={role.color}
                        label={displayRoleName(role, t, roles)}
                        onCheckedChange={(checked) =>
                          patchForm(kind, {
                            exemptRoleIds: checked
                              ? [...form.exemptRoleIds, role.id]
                              : form.exemptRoleIds.filter((id) => id !== role.id),
                          })
                        }
                      />
                    ))
                  )}
                </div>
                <div>
                  <p className="mb-1 text-xs text-text-tertiary">
                    {t("automod.exemptChannels")}
                  </p>
                  {channels.map((channel) => (
                    <CheckRow
                      key={channel.id}
                      checked={form.exemptChannelIds.includes(channel.id)}
                      label={`#${channel.name}`}
                      onCheckedChange={(checked) =>
                        patchForm(kind, {
                          exemptChannelIds: checked
                            ? [...form.exemptChannelIds, channel.id]
                            : form.exemptChannelIds.filter((id) => id !== channel.id),
                        })
                      }
                    />
                  ))}
                </div>
              </div>
            </details>

            <Switch
              checked={form.reportHits}
              onCheckedChange={(checked) => patchForm(kind, { reportHits: checked })}
              label={t("automod.reportHits")}
              description={t("automod.reportHits.hint")}
            />

            <div className="flex items-center justify-between gap-2">
              <p role="status" aria-live="polite" className="text-xs text-text-tertiary">
                {savedKind === kind ? t("automod.saved") : ""}
              </p>
              <div className="flex gap-2">
                {existing && (
                  <Button variant="ghost" size="sm" onClick={() => void remove(kind)}>
                    {t("automod.remove")}
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={saving === kind || (!dirty && Boolean(existing))}
                  onClick={() => void save(kind)}
                >
                  {existing ? t("automod.save") : t("automod.create")}
                </Button>
              </div>
            </div>
          </div>
        );
      })}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <div className="space-y-2 rounded-lg border border-dashed border-border p-4">
        <label className="block space-y-1 text-xs text-text-tertiary">
          <span>{t("automod.test.label")}</span>
          <Input
            value={sample}
            placeholder={t("automod.test.placeholder")}
            onChange={(e) => setSample(e.target.value)}
          />
        </label>
        <p
          role="status"
          aria-live="polite"
          className={cn(
            "text-sm",
            preview?.verdict ? "text-danger" : "text-text-tertiary",
          )}
          data-testid="automod-test-result"
        >
          {!preview
            ? t("automod.test.hint")
            : preview.noRules
              ? t("automod.test.noRules")
              : preview.verdict
                ? t("automod.test.blocked", {
                    rule: t(KIND_META[preview.verdict.kind].title),
                    matched: preview.verdict.matched,
                  })
                : t("automod.test.allowed")}
        </p>
      </div>
    </section>
  );
}
