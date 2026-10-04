// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RadioGroup, type RadioOption } from "@/components/ui/radio-group";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const OPTIONS: RadioOption<string>[] = [
  { value: "light", label: "Claro" },
  { value: "dark", label: "Escuro" },
  { value: "system", label: "Sistema" },
];

function Harness({
  initial,
  options,
  onChange,
}: {
  initial: string;
  options: RadioOption<string>[];
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <RadioGroup
      label="Claridade"
      value={value}
      options={options}
      onValueChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
    />
  );
}

function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

function radios(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
}

function press(key: string) {
  const target = document.activeElement ?? radios()[0]!;
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

function checkedLabel(): string | undefined {
  return radios().find((radio) => radio.getAttribute("aria-checked") === "true")
    ?.textContent ?? undefined;
}

describe("useRovingRadio through RadioGroup", () => {
  it("names the group and puts only the checked radio in the tab order", () => {
    mount(<Harness initial="dark" options={OPTIONS} />);
    const group = document.querySelector('[role="radiogroup"]');
    expect(group?.getAttribute("aria-label")).toBe("Claridade");
    expect(radios().map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("moves and selects with the arrows, wrapping at both ends", () => {
    mount(<Harness initial="light" options={OPTIONS} />);
    radios()[0]!.focus();

    press("ArrowRight");
    expect(checkedLabel()).toBe("Escuro");
    expect(document.activeElement).toBe(radios()[1]);

    press("ArrowDown");
    press("ArrowDown");
    expect(checkedLabel()).toBe("Claro");

    press("ArrowLeft");
    expect(checkedLabel()).toBe("Sistema");
    expect(document.activeElement).toBe(radios()[2]);
  });

  it("jumps to the first and last enabled option with Home and End", () => {
    mount(<Harness initial="dark" options={OPTIONS} />);
    radios()[1]!.focus();
    press("End");
    expect(checkedLabel()).toBe("Sistema");
    press("Home");
    expect(checkedLabel()).toBe("Claro");
  });

  it("skips disabled options", () => {
    const onChange = vi.fn();
    mount(
      <Harness
        initial="light"
        onChange={onChange}
        options={[OPTIONS[0]!, { ...OPTIONS[1]!, disabled: true }, OPTIONS[2]!]}
      />,
    );
    radios()[0]!.focus();
    press("ArrowRight");
    expect(onChange).toHaveBeenCalledWith("system");
    expect(checkedLabel()).toBe("Sistema");
    expect(radios()[1]!.disabled).toBe(true);
  });

  it("gives the tab stop to the first enabled option when the checked one is disabled", () => {
    mount(
      <Harness
        initial="light"
        options={[{ ...OPTIONS[0]!, disabled: true }, OPTIONS[1]!, OPTIONS[2]!]}
      />,
    );
    expect(radios().map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("ignores keys that are not navigation", () => {
    const onChange = vi.fn();
    mount(<Harness initial="light" options={OPTIONS} onChange={onChange} />);
    radios()[0]!.focus();
    press("a");
    press("Tab");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("draws a list variant with each option's description", () => {
    mount(
      <RadioGroup
        label="Quem pode te mandar DM"
        variant="list"
        value="all"
        onValueChange={() => undefined}
        options={[
          { value: "all", label: "Todo mundo", description: "Qualquer conta." },
          { value: "none", label: "Ninguém", description: "Só amigos." },
        ]}
      />,
    );
    expect(radios()[0]!.textContent).toContain("Qualquer conta.");
    expect(radios()[0]!.getAttribute("aria-checked")).toBe("true");
  });
});

describe("manual activation", () => {
  function ManualHarness({ onChange }: { onChange: (value: string) => void }) {
    const [value, setValue] = useState("light");
    return (
      <RadioGroup
        label="Idioma"
        activation="manual"
        value={value}
        options={OPTIONS}
        onValueChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
    );
  }

  it("moves focus with the arrows without selecting", () => {
    const onChange = vi.fn();
    mount(<ManualHarness onChange={onChange} />);
    radios()[0]!.focus();

    press("ArrowRight");
    expect(document.activeElement).toBe(radios()[1]);
    press("ArrowRight");
    expect(document.activeElement).toBe(radios()[2]);
    press("Home");
    expect(document.activeElement).toBe(radios()[0]);
    press("End");
    expect(document.activeElement).toBe(radios()[2]);

    expect(onChange).not.toHaveBeenCalled();
    expect(checkedLabel()).toBe("Claro");
  });

  it("selects the focused option with Enter or Space, once", () => {
    const onChange = vi.fn();
    mount(<ManualHarness onChange={onChange} />);
    radios()[0]!.focus();

    press("ArrowRight");
    press("Enter");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("dark");
    expect(checkedLabel()).toBe("Escuro");

    press("ArrowRight");
    press(" ");
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(checkedLabel()).toBe("Sistema");

    // Enter on the option that is already checked changes nothing.
    press("Enter");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("keeps selecting on the arrows in the default mode", () => {
    const onChange = vi.fn();
    mount(<Harness initial="light" options={OPTIONS} onChange={onChange} />);
    radios()[0]!.focus();
    press("ArrowRight");
    expect(onChange).toHaveBeenCalledWith("dark");
    // Enter is the button's own business in auto mode, not the group's: on an
    // option that is not checked, the group must not select it.
    radios()[2]!.focus();
    press("Enter");
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("list status", () => {
  const LIST: RadioOption<string>[] = [
    { value: "all", label: "Todo mundo", description: "Qualquer conta." },
    { value: "none", label: "Ninguém", description: "Só amigos." },
  ];

  function StatusHarness() {
    const [value, setValue] = useState("all");
    const [saving, setSaving] = useState(false);
    return (
      <RadioGroup
        label="Quem pode te mandar DM"
        variant="list"
        value={value}
        options={LIST}
        status={saving ? <p data-testid="status">Salvando…</p> : null}
        onValueChange={(next) => {
          setValue(next);
          setSaving(true);
        }}
      />
    );
  }

  it("draws the status under the checked option only", () => {
    mount(<StatusHarness />);
    expect(document.querySelector('[data-testid="status"]')).toBeNull();

    act(() => radios()[1]!.click());
    const status = document.querySelector('[data-testid="status"]');
    expect(status).not.toBeNull();
    // A sibling of the radio, never inside it: the radio's name stays its label.
    expect(radios()[1]!.contains(status)).toBe(false);
    expect(radios()[1]!.parentElement!.contains(status)).toBe(true);
    expect(radios()[0]!.parentElement!.contains(status)).toBe(false);
  });

  it("keeps focus on the radio when the status appears", () => {
    mount(<StatusHarness />);
    const before = radios()[0]!;
    before.focus();
    press("ArrowDown");
    const target = radios()[1]!;
    expect(document.activeElement).toBe(target);
    expect(document.querySelector('[data-testid="status"]')).not.toBeNull();
    // Same node, not a remounted copy.
    expect(radios()[1]).toBe(target);
    expect(document.activeElement).toBe(target);
  });
});

describe("segmented fit", () => {
  it("truncates equal cells by default and never in content mode", () => {
    mount(
      <RadioGroup
        label="Nível"
        value="all"
        onValueChange={() => undefined}
        options={[
          { value: "all", label: "Tudo" },
          { value: "mentions", label: "Só @menções" },
        ]}
      />,
    );
    const group = document.querySelector('[role="radiogroup"]')!;
    expect(group.className).toContain("auto-cols-fr");
    expect(radios()[1]!.querySelector(".truncate")).not.toBeNull();
    act(() => root?.unmount());
    host?.remove();

    mount(
      <RadioGroup
        label="Nível"
        fit="content"
        value="all"
        onValueChange={() => undefined}
        options={[
          { value: "all", label: "Tudo" },
          { value: "mentions", label: "Só @menções" },
        ]}
      />,
    );
    const contentGroup = document.querySelector('[role="radiogroup"]')!;
    expect(contentGroup.className).not.toContain("auto-cols-fr");
    expect(contentGroup.className).toContain("flex-wrap");
    expect(radios()[1]!.querySelector(".truncate")).toBeNull();
  });
});
