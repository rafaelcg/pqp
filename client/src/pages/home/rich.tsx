import { Fragment, type ReactNode } from "react";

/**
 * Inline markup inside one translated string, by named slots.
 *
 * A headline with a highlighted phrase is one catalogue value with a slot,
 * not three values glued together in English word order:
 *
 *   "home.hero.title": "Sua galera numa sala que é {accent}."
 *   rich(t("home.hero.title"), { accent: <Hi>{t("home.hero.titleAccent")}</Hi> })
 *
 * Each language puts the slot where its own grammar wants it, and
 * `check-i18n` holds the slot names equal across the three catalogues.
 *
 * `t(key)` with no values returns the `{slot}` text untouched (i18next keeps
 * a placeholder it has no value for; `rich.test.tsx` pins that), so the
 * string goes straight in here. Slots use single braces, like every other
 * value (`lib/i18n/instance.ts`).
 *
 * A slot the template names but `slots` does not fill stays as its literal
 * `{name}`, so a render test that looks for leftover braces catches it. A
 * value in `slots` the template does not name is ignored.
 */
const SLOT = /\{(\w+)\}/g;

const has = (slots: Readonly<Record<string, ReactNode>>, name: string) =>
  Object.prototype.hasOwnProperty.call(slots, name);

export function rich(template: string, slots: Readonly<Record<string, ReactNode>>): ReactNode {
  const parts: ReactNode[] = [];
  const pattern = new RegExp(SLOT);
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(template)) !== null) {
    const [whole, name] = match;
    if (match.index > last) parts.push(template.slice(last, match.index));
    parts.push(has(slots, name) ? <Fragment key={`${name}@${match.index}`}>{slots[name]}</Fragment> : whole);
    last = match.index + whole.length;
  }
  if (parts.length === 0) return template;
  if (last < template.length) parts.push(template.slice(last));
  return <>{parts}</>;
}

/** The slot names in a template, sorted, the way `check-i18n` compares them. */
export function slotNames(template: string): string[] {
  return (template.match(SLOT) ?? []).map((slot) => slot.slice(1, -1)).sort();
}
