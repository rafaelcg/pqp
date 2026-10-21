/** The few DOM helpers every module of the frame uses. No framework: the frame is plain TypeScript. */

export function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

export function setText(id: string, text: string): void {
  el(id).textContent = text;
}

type Attrs = Record<string, string | number | boolean | undefined>;

/**
 * `h("button", { class: "loc-button", type: "button" }, "Jogar")`. Text goes in as text, never as markup,
 * so a title read from a person's file cannot become an element.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    node.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child);
  }
  return node;
}

/** `{name}` slots in a string of copy, filled from `slots`. */
export function fill(template: string, slots: Record<string, string | number>): string {
  return Object.entries(slots).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), template);
}
