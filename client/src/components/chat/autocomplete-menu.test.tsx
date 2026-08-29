import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AUTOCOMPLETE_GRID_COLUMNS,
  AutocompleteMenu,
  type AutocompleteOption,
} from "./autocomplete-menu";

/**
 * The dice menu shipped as eight full-width rows — a 28px die, a sentence, and
 * a notation each — inside a 256px cap, at the bottom of an `overflow-hidden`
 * shell. Roughly 410px of options in 256px of box in a pane that clips: the
 * bottom row was on screen and nothing said the other seven existed. So the
 * two things worth pinning are that a grid menu is a grid (the rows are what
 * made it tall) and that the sentence survives as an accessible name rather
 * than being deleted along with the height.
 */

const NOTATIONS = ["1d20", "1d4", "1d6", "2d6", "1d8", "1d10", "1d12", "1d100"];

const DICE: AutocompleteOption[] = NOTATIONS.map((notation) => ({
  id: notation,
  primary: notation,
  label: `${notation} · a die`,
  leading: <span data-die={notation} />,
}));

const COMMANDS: AutocompleteOption[] = [
  { id: "help", primary: "/help", secondary: "List the commands" },
  { id: "roll", primary: "/roll", secondary: "Roll a die" },
];

function render(options: AutocompleteOption[], layout?: "list" | "grid") {
  return renderToStaticMarkup(
    <AutocompleteMenu
      label="Dice"
      heading="Dice"
      emptyLabel="No matching commands"
      options={options}
      selectedIndex={0}
      layout={layout}
      onSelect={() => {}}
      onHover={() => {}}
    />,
  );
}

function count(html: string, pattern: RegExp): number {
  return html.match(pattern)?.length ?? 0;
}

describe("AutocompleteMenu", () => {
  it("lays the dice out in rows of four rather than one per line", () => {
    const html = render(DICE, "grid");
    expect(html).toContain("grid-cols-4");
    expect(AUTOCOMPLETE_GRID_COLUMNS).toBe(4);
    // Eight into four is two rows, which is the whole reason this fits.
    expect(DICE.length % AUTOCOMPLETE_GRID_COLUMNS).toBe(0);
  });

  it("draws every preset, not just the ones a cap left room for", () => {
    const html = render(DICE, "grid");
    expect(count(html, /role="option"/g)).toBe(DICE.length);
    for (const notation of NOTATIONS) {
      expect(html).toContain(`>${notation}</span>`);
      expect(html).toContain(`aria-label="${notation} · a die"`);
    }
  });

  it("caps its height against measured room instead of a fixed guess", () => {
    // `max-h-64` could not know how short the pane was; a style set from the
    // clipping ancestor's rect can.
    const html = render(DICE, "grid");
    expect(html).not.toContain("max-h-64");
    expect(html).toMatch(/style="max-height:\d+px"/);
  });

  it("does not animate the menu through a translate it can be measured during", () => {
    // `animate-rise` slides 14px over 650ms, so a clip check — or a person —
    // sees the menu somewhere it is about to stop being.
    expect(render(DICE, "grid")).not.toContain("animate-rise");
    expect(render(COMMANDS)).toContain("animate-fade-in");
    expect(render([])).toContain("animate-fade-in");
  });

  it("still renders commands as described rows", () => {
    const html = render(COMMANDS);
    expect(html).not.toContain("grid-cols-4");
    expect(html).toContain("/help");
    expect(html).toContain("List the commands");
    expect(count(html, /role="option"/g)).toBe(COMMANDS.length);
  });

  it("says nothing matched instead of drawing an empty listbox", () => {
    const html = render([]);
    expect(html).toContain("No matching commands");
    expect(html).not.toContain('role="listbox"');
  });
});
