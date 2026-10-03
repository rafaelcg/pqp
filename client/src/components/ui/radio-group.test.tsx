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
