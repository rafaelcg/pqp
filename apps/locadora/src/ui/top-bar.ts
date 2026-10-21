/**
 * The top bar of the Balcão (mock 1): the neon sign on the left; on the right the storage meter, one pill of icon
 * buttons ("Ver a recepção de novo", Controles, Exportar pra arquivo, Licenças) and the primary "Botar fita".
 * A button whose handler is not given is not drawn, so the bar can be wired piece by piece. Each icon button says
 * its name in a tooltip on hover and keyboard focus (`data-tip`, shelf.css) and to assistive tech in `aria-label`.
 *
 * The meter is a real `role="meter"`; over 90% of the cap it turns to a warning (SPEC 4.1). It shows the short
 * "18 MB de 512 MB" and says the whole line to assistive tech. With no usage (the host cannot say) it is not drawn.
 *
 * One row from about 760 px up; two rows on a phone (the sign and the meter, then the buttons), laid out by
 * shelf.css from the same three parts.
 */
import type { Strings } from "../i18n";
import { formatBytes, usageLevel } from "../library";
import type { StoreUsage } from "../store";
import { fill, h } from "./dom";
import { createNeonSign, type NeonSign } from "./neon-sign";

export type TopBarStrings = Pick<
  Strings,
  | "sign.sub"
  | "top.pick"
  | "top.usage"
  | "top.usageShort"
  | "top.usageEmpty"
  | "hud.controls"
  | "export.title"
  | "noticesTitle"
  | "onb.replay"
  | "sync.usage"
  | "sync.chipReadOnly"
  | "sync.chipError"
  | "sync.chipNoStore"
  | "sync.retry"
  | "sync.shelfChip"
>;

export type IconName = "controls" | "device" | "export" | "licenses" | "cartridge" | "play" | "plus" | "shield" | "screen" | "check" | "close" | "replay" | "cloud" | "help";

const ICONS: Record<IconName, { paths: string[]; fill?: boolean; width?: number }> = {
  controls: { paths: ["M6 11h4M8 9v4M15 12h.01M18 10h.01", "M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"] },
  device: { paths: ["M5 4h9a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z", "M16 9h4a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-4", "M8 17h1"] },
  // "Exportar pra arquivo": a sheet of paper with an arrow leaving it, so it reads as a FILE, not the cloud and not a device
  export: { paths: ["M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z", "M14 3v6h6", "M12 18v-6M9 14.5l3-3 3 3"] },
  licenses: { paths: ["M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z", "M14 3v6h6M8 13h8M8 17h5"] },
  // Saves na conta: the account's line in Regras da casa
  cloud: { paths: ["M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z"] },
  cartridge: { paths: ["M5 3h14v14l-2 4H7l-2-4z", "M8 7h8v6H8z"], width: 2.2 },
  play: { paths: ["M7 4v16l13-8z"], fill: true },
  plus: { paths: ["M12 5v14M5 12h14"] },
  shield: { paths: ["M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"] },
  screen: { paths: ["M6 5h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z", "M8 21h8M12 17v4"] },
  check: { paths: ["M20 6L9 17l-5-5"] },
  close: { paths: ["M6 6l12 12M18 6L6 18"] },
  replay: { paths: ["M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5"] },
  // "Ver a recepção de novo": the welcome is where the questions get answered
  help: { paths: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M9.2 9.2a2.9 2.9 0 0 1 5.6 1c0 1.9-2.8 2.6-2.8 2.6", "M12 17h.01"] },
};

const SVG_NS = "http://www.w3.org/2000/svg";

/** A decorative 24 unit icon, hidden from assistive tech: the button around it carries the name. */
export function icon(name: IconName, size = 20): SVGSVGElement {
  const spec = ICONS[name];
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("fill", spec.fill ? "currentColor" : "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", String(spec.width ?? 2));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of spec.paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** Under this much the device holds only the app's own small rows (the first-visit flag, settings), never a cartridge. */
export const EMPTY_USAGE_BYTES = 4096;

export function isEmptyUsage(usage: Pick<StoreUsage, "used">): boolean {
  return usage.used < EMPTY_USAGE_BYTES;
}

/** Is this keydown the "botar fita" shortcut: a bare N, not typed into a field? The Balcão's owner binds it. */
export function isPickShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "target">): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.key !== "n" && event.key !== "N") return false;
  const target = event.target as { tagName?: string; isContentEditable?: boolean } | null;
  const tag = target?.tagName?.toUpperCase();
  return !(tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable);
}

/**
 * Saves na conta, as the shelf says it (the line under the storage meter). `on` and `read-only` carry what the account
 * holds; `unreachable` (the account did not answer: a button, "Tentar de novo") and `no-store` (this browser keeps
 * nothing) are the two reasons a feature the server has on is not working here. Null: the feature is off, nothing drawn.
 */
export type CloudChip = { state: "on" | "read-only"; used: number; cap: number } | { state: "unreachable" | "no-store" };

export interface TopBarOptions {
  t: TopBarStrings;
  usage?: Pick<StoreUsage, "used" | "cap">;
  cloud?: CloudChip | null;
  onCloudRetry?: () => void;
  /** First view of the session: the sign powers on. See `consumePowerOn`. */
  powerOn?: boolean;
  onPick: () => void;
  onControls?: () => void;
  /** "Ver a recepção de novo": always there, never conditional on what was seen. */
  onWelcome?: () => void;
  onExport?: () => void;
  onLicenses?: () => void;
}

export interface TopBar {
  readonly element: HTMLElement;
  readonly sign: NeonSign;
  update(patch: { usage?: Pick<StoreUsage, "used" | "cap"> | null; cloud?: CloudChip | null }): void;
  /** The primary button, for a caller that wants to focus it (the empty and unavailable states do). */
  readonly pickButton: HTMLButtonElement;
  /** Gives the keyboard back to Controles (its dialog was just closed), or to the primary button when the bar has no such button. */
  focusControls(): void;
  /** Gives the keyboard back to "Ver a recepção de novo" (its walkthrough was just closed), or to the primary button without one. */
  focusWelcome(): void;
}

export function createTopBar(opts: TopBarOptions): TopBar {
  const { t } = opts;
  const sign = createNeonSign({ size: "sm", powerOn: opts.powerOn ?? false, sub: t["sign.sub"] });

  const meterText = h("span", { class: "loc-meter-text" });
  const meterFill = h("i");
  const meter = h(
    "div",
    { class: "loc-meter", role: "meter", "aria-valuemin": 0 },
    meterText,
    h("div", { class: "loc-meter-bar", "aria-hidden": "true" }, meterFill),
  );
  meter.hidden = true;

  function iconButton(name: IconName, label: string, run: () => void, extra = ""): HTMLButtonElement {
    const button = h("button", { type: "button", class: `loc-iconbtn${extra}`, "aria-label": label, "data-tip": label }, icon(name));
    button.addEventListener("click", run);
    return button;
  }

  const pickButton = h(
    "button",
    { type: "button", class: "loc-button loc-top-pick", "aria-keyshortcuts": "N" },
    icon("cartridge", 18),
    h("span", {}, t["top.pick"]),
    h("kbd", { class: "loc-kbd", "aria-hidden": "true" }, "N"),
  );
  pickButton.addEventListener("click", opts.onPick);

  const tools = h("div", { class: "loc-top-tools" });
  let controlsButton: HTMLButtonElement | null = null;
  let welcomeButton: HTMLButtonElement | null = null;
  if (opts.onWelcome) {
    // the first of the icons, and always there: the welcome is what a person looks for when they want it again
    welcomeButton = iconButton("help", t["onb.replay"], opts.onWelcome, " loc-top-welcome");
    tools.append(welcomeButton);
  }
  if (opts.onControls) {
    controlsButton = iconButton("controls", t["hud.controls"], opts.onControls);
    tools.append(controlsButton);
  }
  if (opts.onExport) tools.append(iconButton("export", t["export.title"], opts.onExport));
  if (opts.onLicenses) tools.append(iconButton("licenses", t.noticesTitle, opts.onLicenses));
  tools.hidden = tools.childElementCount === 0;

  // the account's line sits under the meter, in its column: where a person already looks to see what is kept
  const cloudHost = h("div", { class: "loc-cloud-host" });
  cloudHost.hidden = true;
  const meters = h("div", { class: "loc-top-meters" }, meter, cloudHost);
  meters.hidden = true;
  const actions = h("div", { class: "loc-top-actions" }, meters, tools, pickButton);
  const element = h("header", { class: "loc-top" }, sign.element, actions);

  function paint(usage: Pick<StoreUsage, "used" | "cap"> | undefined) {
    if (!usage || usage.cap <= 0) {
      meter.hidden = true;
      return;
    }
    // a few bytes of flags and settings are not "1 B of 512 MB": until something is kept, say so
    const empty = isEmptyUsage(usage);
    const slots = { used: formatBytes(usage.used), cap: formatBytes(usage.cap) };
    const text = empty ? t["top.usageEmpty"] : fill(t["top.usage"], slots);
    const pct = Math.min(100, Math.max(0, (usage.used / usage.cap) * 100));
    // on the bar, the short line; the whole one ("Neste aparelho: ...") is what the meter says it is
    meterText.textContent = empty ? text : fill(t["top.usageShort"], slots);
    meter.setAttribute("aria-label", text);
    meter.title = text;
    meter.setAttribute("aria-valuemax", String(usage.cap));
    meter.setAttribute("aria-valuenow", String(Math.min(usage.used, usage.cap)));
    meter.setAttribute("aria-valuetext", text);
    meter.dataset.level = usageLevel(usage);
    // CSSOM, not a style attribute: the frame's CSP forbids inline styles
    meterFill.style.width = `${pct}%`;
    meter.hidden = false;
  }
  paint(opts.usage);

  let currentCloud: CloudChip | null = opts.cloud ?? null;
  function paintCloud(cloud: CloudChip | null) {
    cloudHost.replaceChildren();
    cloudHost.hidden = !cloud;
    if (cloud) {
      const text =
        cloud.state === "on"
          ? fill(t["sync.usage"], { used: formatBytes(cloud.used), cap: formatBytes(cloud.cap) })
          : cloud.state === "read-only"
            ? t["sync.chipReadOnly"]
            : cloud.state === "no-store"
              ? t["sync.chipNoStore"]
              : `${t["sync.chipError"]} · ${t["sync.retry"]}`;
      const parts = [icon("cloud", 13), h("span", { class: "loc-cloud-text" }, text)];
      if (cloud.state === "unreachable") {
        // the one state with something to do: a button, a whole target tall
        const retry = h("button", { type: "button", class: "loc-cloud loc-cloud-retry", "data-state": cloud.state, title: t["sync.shelfChip"] }, ...parts);
        retry.addEventListener("click", () => opts.onCloudRetry?.());
        cloudHost.append(retry);
      } else {
        cloudHost.append(h("div", { class: "loc-cloud", "data-state": cloud.state, title: t["sync.shelfChip"], "aria-label": `${t["sync.shelfChip"]}. ${text}` }, ...parts));
      }
    }
    meters.hidden = meter.hidden && cloudHost.hidden;
  }
  paintCloud(currentCloud);

  return {
    element,
    sign,
    pickButton,
    focusControls() {
      (controlsButton ?? pickButton).focus({ preventScroll: true });
    },
    focusWelcome() {
      (welcomeButton ?? pickButton).focus({ preventScroll: true });
    },
    update(patch) {
      if ("usage" in patch) paint(patch.usage ?? undefined);
      if ("cloud" in patch) currentCloud = patch.cloud ?? null;
      if ("usage" in patch || "cloud" in patch) paintCloud(currentCloud);
    },
  };
}
